#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { createTogetherExecutionEnvironment, normalizeTogetherSettings } from "../lib/execution-environments/together.mjs";
import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { ANTHROPIC_JSON_JUDGE_ID, createAnthropicJsonJudge } from "../lib/judges/anthropic-json.mjs";
import { resolveAuthoritySelections } from "../lib/authority-profile.mjs";
import { ENVIRONMENT_STATUS_LABELS, normalizeExecutionProgressObserver, projectVerdictReasons, reportExecutionProgress } from "../lib/execution-progress.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import {
  closePostgresResultStore,
  openPostgresResultStore,
} from "../lib/postgres-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { DEFAULT_RUN_CONCURRENCY, normalizeRunConcurrency } from "../lib/run-concurrency.mjs";
import {
  RuntimeProfileError,
  judgeCredentialEnvironment,
  describeRuntimeJudgeCapability,
  resolveRuntimeProfile,
  resolveRuntimeSecrets,
  viewerStoreEnvironment,
} from "../lib/runtime-profile.mjs";
import { RunSelectionInputError, selectDefinitionIds } from "../lib/run-model.mjs";
import { createTerminalProgress } from "../lib/terminal-progress.mjs";
import {
  V1AuthoringError,
  resolveV1Suite,
} from "../lib/v1-authoring.mjs";
import { initializeSuite, STARTER_AGENT_MODELS } from "../lib/starter-suite.mjs";
import { isAgentEffort } from "../lib/agent-effort.mjs";
import { checkAgentReadiness } from "../lib/agent-readiness.mjs";
import { projectRuntimePath } from "../lib/project-paths.mjs";
import { setupTogetherSandbox } from "../lib/together-sandbox-setup.mjs";
import { setupPostgresStore } from "../lib/postgres-setup.mjs";
import { createSetupOutput } from "../lib/setup-output.mjs";
import { ignoreProjectFiles } from "../lib/setup-project-files.mjs";
import { createViewerOnboarding } from "../lib/viewer-onboarding.mjs";
import { defaultProjectSuite, discoverProjectSuites, resolveProjectSuite } from "../lib/project-suites.mjs";
import { selectSuiteAgents } from "../lib/suite-agent-selection.mjs";
import { discoverModels, selectCatalogModels, ModelDiscoveryError } from "../lib/model-discovery.mjs";
import {
  terminalUsesColor, paintTerminal as paintRunOutput, terminalFact as runFact,
  terminalHeader, terminalMark, terminalStatus, terminalNote, terminalNext, suiteCommand, quoteCommandArgument, cliExecutable,
  runtimeSummaryRows, suiteKeyRoutes, suiteKeyRows,
} from "../lib/terminal-output.mjs";

const FIRST_PARTY_AGENT_ADAPTERS = Object.freeze({
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
});

const AGENT_LABELS = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
});

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function runOutputUsesColor(io) {
  return terminalUsesColor(io.stdout);
}

function writeError(io, text) {
  io.stderr.write(terminalStatus("fail", text.trimEnd(), io.stderr));
}

function agentSelectionLabel(selection) {
  const agent = AGENT_LABELS[selection.adapterId] ?? selection.adapterId;
  const model = selection.requestedModel ? `${agent} · ${selection.requestedModel}` : agent;
  return selection.settings?.effort ? `${model} · ${selection.settings.effort} effort` : model;
}

function scoringLabel(authorities) {
  const labels = new Set(authorities.map((authority) => ({
    "deterministic-primary": "Code",
    "judge-primary": "Judge",
    hybrid: "Code + Judge",
  })[authority?.kind] ?? "Observation"));
  return labels.size === 1 ? [...labels][0] : "Mixed";
}

function displayResultsPath(runtimeProfile, cwd) {
  if (runtimeProfile.resultStore.kind === "postgres") {
    const artifactRoot = relative(cwd, runtimeProfile.resultStore.artifactRoot);
    const displayedRoot = artifactRoot && !artifactRoot.startsWith(`..${sep}`)
      ? artifactRoot
      : runtimeProfile.resultStore.artifactRoot;
    return displayedRoot;
  }
  const storeRoot = relative(cwd, runtimeProfile.resultStore.root);
  return storeRoot && !storeRoot.startsWith(`..${sep}`)
    ? storeRoot
    : runtimeProfile.resultStore.root;
}

const SOURCE_VIEWER_LAUNCHER_URL = new URL("../../viewer/launcher.mjs", import.meta.url);

async function launchFirstPartyViewer(options) {
  try {
    const { launchViewer } = await import(
      SOURCE_VIEWER_LAUNCHER_URL
    );
    return launchViewer(options);
  } catch {
    return Object.freeze({ kind: "failed", exitCode: 1 });
  }
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  env: process.env,
  environmentSource: "provided environment",
  checkAgentReadiness,
  discoverModels,
  processTarget: process,
  viewerCwd: fileURLToPath(new URL("../../", import.meta.url)),
  initializeSuite,
  openLocalResultStore,
  openPostgresResultStore,
  closePostgresResultStore,
  createRunEngine,
  createLocalExecutionEnvironment,
  createTogetherExecutionEnvironment,
  createAnthropicJsonJudge,
  resolveV1Suite,
  launchViewer: launchFirstPartyViewer,
  createAgentAdapter(adapterId, runtimeEnv) {
    const createAdapter = FIRST_PARTY_AGENT_ADAPTERS[adapterId];
    if (!createAdapter) {
      throw new TypeError(`Unsupported first-party Agent Adapter '${adapterId}'`);
    }
    return createAdapter({ runtimeEnv });
  },
});

function renderDiagnostic(diagnostic, cwd) {
  const relativeFile = isAbsolute(diagnostic.file)
    ? relative(cwd, diagnostic.file)
    : diagnostic.file;
  const file = relativeFile !== ".." && !relativeFile.startsWith(`..${sep}`)
    ? relativeFile
    : diagnostic.file;
  const pointer = diagnostic.pointer ? `:${diagnostic.pointer}` : "";
  return `${file}${pointer} [${diagnostic.code}] ${diagnostic.message}\n`;
}

function printDiagnostics(diagnostics, io) {
  for (const diagnostic of diagnostics) {
    writeError(io, renderDiagnostic(diagnostic, io.cwd));
  }
}

const HELP_TEXT = Object.freeze({
  main: [
    "Hurdle",
    "",
    "Usage:",
    "  hurdle <command> [options]",
    "",
    "Commands:",
    "  init [directory]   Create a starter evaluation",
    "  suites [suite]     List Suites or inspect one (alias: ls)",
    "  models             Discover model IDs for an Agent",
    "  setup [suite]      Configure the project Runtime",
    "  runtime            Show the project Runtime configuration",
    "  validate [suite]   Validate a Suite and check Agent readiness",
    "  run [suite]        Run a Suite",
    "  view               Start the Results Viewer",
    "  version            Show the installed version",
    "  help [command]     Show help for a command",
    "",
    "Run `hurdle help <command>` for command options.",
  ].join("\n"),
  init: [
    "Usage:",
    "  hurdle init [directory] [--agent claude-code|codex] [--example copy-message|together-api|concurrency-smoke|kitchen-sink] [--model MODEL] [--effort LEVEL]",
    "",
    "Create a starter evaluation. The default directory is `evals`.",
    "The destination must not already exist; its parent directory must exist.",
    "Starters pin Claude Opus 5.5 or GPT-6.1 Sol with medium reasoning effort.",
    "Init adds .env.local, .hurdle/ and .tae/ to .gitignore in the current directory.",
    "",
    "Credentials come from .env.local or exported environment variables.",
    "Interactive Agent logins are not inherited. Claude Code uses",
    "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; Codex uses CODEX_API_KEY or",
    "OPENAI_API_KEY (OpenAI API keys only). Together API and the Together sandbox",
    "need TOGETHER_API_KEY.",
    "",
    "Options:",
    "  --agent ID         Choose Claude Code (default) or Codex",
    "  --example NAME     Choose copy-message (default), together-api, concurrency-smoke or kitchen-sink",
    "  --model MODEL      Override the starter Agent model",
    "  --effort LEVEL     low, medium (default), high, xhigh, or max",
    "  -h, --help         Show this help",
  ].join("\n"),
  setup: [
    "Usage:",
    "  hurdle setup [suite] [options]",
    "",
    "Configure the project Runtime: sandbox execution or result storage.",
    "",
    "Options:",
    "  --sandbox together     Configure the Together sandbox (default)",
    "  --store postgres       Configure Postgres storage separately",
    "  --interactive          Prompt for credentials",
    "  --json                 Emit one JSON result",
    "  -h, --help             Show this help",
  ].join("\n"),
  suites: [
    "Usage:",
    "  hurdle suites [suite] [--runtime FILE] [--json]",
    "  hurdle ls [suite] [--runtime FILE] [--json]",
    "",
    "List .suite.mjs files, or inspect one by short name or path.",
    "Listing scans filenames only; inspection resolves Suite and Task definitions.",
    "Inspection shows Suite settings and the project Runtime used by default.",
    "The project Runtime applies to all Suites unless a run selects another.",
    "Unique filenames or folder names can be used by setup, validate and run.",
    "Duplicate names require an explicit Suite path.",
    "Hidden/generated directories and symlinks are excluded from discovery.",
    "",
    "Options:",
    "  --runtime FILE     Inspect a selected Suite with another Runtime Profile",
    "  --json             Emit the Suite list or selected Suite details",
    "  -h, --help         Show this help",
  ].join("\n"),
  runtime: [
    "Usage:",
    "  hurdle runtime [--runtime FILE] [--json]",
    "",
    "Show the project Runtime: execution, storage, Judge and Viewer settings.",
    "Execution is Local or Together sandbox.",
    "Uses the project Runtime saved by setup, or the built-in Local default.",
    "Reads configuration only; does not load credentials or contact services.",
    "Suite and command-line overrides apply when running an evaluation.",
    "",
    "Options:",
    "  --runtime FILE     Inspect a specific Runtime Profile",
    "  --json             Emit one JSON result",
    "  -h, --help         Show this help",
  ].join("\n"),
  validate: [
    "Usage:",
    "  hurdle validate [suite] [options]",
    "",
    "Validate a .suite.mjs Suite and check runtime/authentication readiness.",
    "Uses read-only provider requests; never runs an Agent or Judge.",
    "Select a Suite path or a unique short name from `hurdle suites`.",
    "With no selection, use evals/example.suite.mjs, example.suite.mjs,",
    "or the sole project Suite (bundled examples are not selected automatically).",
    "Uses the project Runtime saved by setup unless overridden.",
    "Without a saved Runtime, use Local execution and filesystem storage.",
    "",
    "Options:",
    "  --offline          Check Suite definitions only; no readiness checks",
    "  --runtime FILE     Check the Runtime Profile used by run",
    "  --agent ID         Check one Agent selected by the Suite",
    "  --model MODEL      Override the selected runner's model",
    "  -h, --help         Show this help",
  ].join("\n"),
  run: [
    "Usage:",
    "  hurdle run [suite] [options]",
    "",
    "Run a Suite by name or path. Omit it to use the project default.",
    "Uses your saved Runtime, or Local execution and filesystem storage.",
    "",
    "Selection:",
    "  --task ID                   Select a Task; repeat to select more",
    "  --condition ID              Select a Condition; repeat to select more",
    "  --agent claude-code|codex   Filter Suite Agents",
    "  --model MODEL               Override the selected runner's model",
    "                              Use --model -h for model guidance",
    "",
    "Execution:",
    `  --concurrency N             Run up to N cells at once (1–100; default: ${DEFAULT_RUN_CONCURRENCY})`,
    "                              Overrides Suite concurrency, including retries and judging",
    "",
    "Runtime:",
    "  --runtime FILE              Use a Runtime Profile",
    "  --environment local|together Override execution",
    "  --environment-settings JSON Configure execution with a JSON object",
    "  --store DIR                 Save results to a local directory",
    "",
    "Output:",
    "  --experiment-version LABEL  Label runs for comparison",
    "  --view                      Start the Results Viewer after the run",
    "  -h, --help                  Show this help",
    "",
    "`--runtime` cannot be combined with `--environment`,",
    "`--environment-settings`, or `--store`.",
  ].join("\n"),
  models: [
    "Usage:",
    "  hurdle models --agent claude-code|codex [--all] [--json]",
    "",
    "List up to 10 recent text/code models from upstream catalogs.",
    "Newest first by catalog date; undated entries retain upstream order.",
    "Claude uses the Anthropic Models API and requires ANTHROPIC_API_KEY.",
    "Codex uses its CLI catalog plus OpenAI's live catalog when an API key is set.",
    "Provider-only IDs have unverified runner compatibility.",
    "No evaluation runs. Catalog entries do not verify account access.",
    "",
    "Options:",
    "  --agent ID         Select claude-code or codex",
    "  --all              Show the full catalog, including older and other models",
    "  --json             Emit one JSON result",
    "  -h, --help         Show this help",
    "",
    "You can supply any supported ID with --model, including unlisted models.",
    "New models may require an updated Agent CLI or sandbox image.",
  ].join("\n"),
  version: [
    "Usage:",
    "  hurdle version",
    "",
    "Print the installed package version. No project or credentials required.",
    "Aliases: hurdle --version, hurdle -v",
  ].join("\n"),
  view: [
    "Usage:",
    "  hurdle view [--runtime FILE | --store DIR] [--port PORT]",
    "",
    "Start the Results Viewer for the default or selected Result Store.",
    "",
    "Options:",
    "  --runtime FILE      Read the Result Store from a Runtime Profile",
    "  --store DIR         Open a local Result Store directory",
    "  --port PORT         Serve on PORT instead of the Runtime's Viewer port (3000)",
    "  -h, --help          Show this help",
  ].join("\n"),
});

function help(topic, io, selection = null) {
  const body = topic === "main" ? HELP_TEXT[topic].slice("Hurdle\n\n".length) : HELP_TEXT[topic];
  io.stdout.write(terminalHeader(io.stdout).trimStart() + `${body}\n`);
  if (["setup", "run", "validate"].includes(topic)) {
    io.stdout.write(projectSuiteHelp(topic, io.cwd, selection));
  }
  return 0;
}

function projectExecutable(cwd) {
  return cliExecutable(cwd);
}

function suiteSelection(suite) {
  return suite.ambiguous || suite.name.startsWith("-") ? suite.path : suite.name;
}

function projectSuiteHelp(command, cwd, selectedSuite = null) {
  const executable = projectExecutable(cwd);
  let suites;
  try { suites = discoverProjectSuites(cwd); }
  catch { return `\nList Suites:\n  ${executable} suites\n\nOr select an explicit .suite.mjs path.\n`; }
  const defaultPath = defaultProjectSuite(cwd, suites);
  const selected = selectedSuite ? resolveProjectSuite(cwd, selectedSuite) : null;
  const example = suites.find(suite => suite.path === selected?.path)
    ?? suites.find(suite => suite.path === defaultPath) ?? suites.find(suite => !suite.bundled) ?? suites[0];
  const selection = example ? quoteCommandArgument(suiteSelection(example)) : "evals/example.suite.mjs";
  const suiteRows = suites.map(suite => `  ${suiteSelection(suite).padEnd(22)} ${suite.path}${suite.path === defaultPath ? "  (default)" : ""}`);
  const heading = example ? `Examples using ${suiteSelection(example)}:` : "Examples after creating a Suite with init:";
  if (command === "setup") {
    const examples = [
      [`${executable} setup ${selection}`, "Together sandbox"],
      [`${executable} setup --store postgres`, "Postgres storage (separate step)"],
      [`${executable} run ${selection} --view`, "Run the evaluation"],
    ];
    const width = Math.max(...examples.map(([command]) => command.length));
    return ["", heading, ...examples.map(([command, label]) => `  ${command.padEnd(width)}  # ${label}`),
      "", `List Suites: ${executable} suites`, ""].join("\n");
  }
  const examples = [`  ${executable} ${command} ${selection}${command === "run" ? " --view" : " --offline"}`];
  return ["", ...(suiteRows.length ? ["Available Suites (name / path):", ...suiteRows, ""] : []),
    heading, ...examples, "", `List Suites: ${executable} suites`, ""].join("\n");
}

function selectProjectSuite(selection, io, report = message => argumentError(message, io)) {
  let result;
  try { result = resolveProjectSuite(io.cwd, selection); }
  catch (error) { return report(error.message); }
  if (result.path) return { ok: true, suite: result.path };
  const message = result.matches.length > 1
    ? `Suite name '${selection}' is ambiguous. Use one of these paths:\n\n${result.matches.map(suite => `  ${quoteCommandArgument(suite.path)}`).join("\n")}`
    : `Unknown Suite name '${selection}'. Pass a .suite.mjs path or list the available names.`;
  return report(`${message}\n\n  ${projectExecutable(io.cwd)} suites`);
}

function suiteModelRows(agents) {
  return [...new Set(agents.map(agent => {
    const model = agent.requestedModel ?? "(runner default; omit --model)";
    const effort = agent.settings?.effort ? ` · ${agent.settings.effort} effort` : "";
    return `  ${model} · ${AGENT_LABELS[agent.adapterId] ?? agent.adapterId}${effort}`;
  }))];
}

function writeModelHelp(command, options, agents, io) {
  const executable = projectExecutable(io.cwd);
  const runners = [...new Set(agents.map(agent => agent.adapterId))];
  const sample = agents.find(agent => agent.requestedModel !== null) ?? agents[0];
  const runner = options.agent ?? (runners.length > 1 ? sample?.adapterId : null);
  const example = `${executable} ${command} ${quoteCommandArgument(options.suite ?? "SUITE")}${runner ? ` --agent ${runner}` : ""} --model ${quoteCommandArgument(sample?.requestedModel ?? "MODEL")}`;
  const choices = options.agent ? [options.agent] : runners.length ? runners : Object.keys(FIRST_PARTY_AGENT_ADAPTERS);
  io.stdout.write(terminalHeader(io.stdout)
    + `Usage:\n  hurdle ${command} [suite] --model MODEL\n\n`
    + "Use any model ID or alias supported by the selected runner.\n\n"
    + (agents.length ? `Suite defaults (${options.suite}):\n${suiteModelRows(agents).join("\n")}\n\n` : "")
    + `Example:\n  ${example}\n\n`
    + `Discover model IDs:\n${choices.map(agent => `  ${executable} models --agent ${agent}`).join("\n")}\n\n`
    + "With both runners in the Suite, select one with --agent claude-code or --agent codex.\n");
  return 0;
}

async function modelHelp(command, args, io, dependencies) {
  const index = args.indexOf("--model");
  if (args.lastIndexOf("--model") !== index) return argumentError("Option '--model' may only be supplied once.", io).exitCode;
  const parsed = parseRunArguments(args.filter((arg, position) => position !== index && !["-h", "--help"].includes(arg)), io, { validation: command === "validate" });
  if (!parsed.ok) return parsed.exitCode;
  const options = parsed.values;
  if (options.suite === null) {
    const defaultSuite = defaultSuiteArgument(io.cwd);
    if (!existsSync(resolve(io.cwd, defaultSuite))) return writeModelHelp(command, options, [], io);
    options.suite = defaultSuite;
  }
  const selected = selectProjectSuite(options.suite, io);
  if (!selected.ok) return selected.exitCode;
  let authored;
  try {
    try { authored = await dependencies.resolveV1Suite({ suitePath: resolve(io.cwd, selected.suite) }); }
    catch (error) {
      if (!(error instanceof V1AuthoringError)) throw error;
      printDiagnostics([error], io);
      return 1;
    }
    if (!authored.ok) {
      printDiagnostics(authored.diagnostics, io);
      return 1;
    }
    const agents = authored.defaults.agentSelections.filter(agent => options.agent === undefined || agent.adapterId === options.agent);
    if (!agents.length) return argumentError(`No Suite Agent matches '${options.agent}'.\n\nSuite models:\n${suiteModelRows(authored.defaults.agentSelections).join("\n")}`, io).exitCode;
    return writeModelHelp(command, options, agents, io);
  } finally { authored?.dispose?.(); }
}

function missingRunSuite(command, io, suite = null) {
  const executable = cliExecutable(io.cwd);
  let suites;
  try { suites = discoverProjectSuites(io.cwd); }
  catch { /* The suites command reports discovery limits; explicit paths still work. */ }
  if (suite) {
    printDiagnostics([{
      file: suite, code: "suite.file-invalid",
      message: "Could not read the Suite file. Check the path and file permissions.",
    }], io);
  } else {
    const empty = suites?.length === 0;
    writeError(io, `hurdle [${empty ? "suite.missing" : "suite.selection-required"}] ${empty
      ? "No Suites found in this project. Create an evaluation first."
      : "No default Suite found. Choose a Suite by name or path."}`);
  }
  if (suites?.length) {
    const example = suites.find(suite => !suite.bundled) ?? suites[0];
    io.stderr.write("\n" + runFact("Example", suiteCommand(command, suiteSelection(example), { view: command === "run", cwd: io.cwd }), { useColor: terminalUsesColor(io.stderr) }));
  }
  let next = `${executable} suites`;
  if (suites?.length === 0) {
    let destination = "evals";
    if (existsSync(resolve(io.cwd, destination))) {
      destination = "evals/my-eval";
      for (let suffix = 2; existsSync(resolve(io.cwd, destination)); suffix += 1) destination = `evals/my-eval-${suffix}`;
    }
    next = `${executable} init${destination === "evals" ? "" : ` ${quoteCommandArgument(destination)}`}`;
  }
  io.stderr.write(terminalNext([next], io.stderr));
  return 1;
}

async function inspectProjectSuite(selection, io, dependencies, { json, runtimePath, argumentError: reportArgumentError }) {
  const selected = selectProjectSuite(selection, io, message => ({ ok: false, exitCode: reportArgumentError(message) }));
  if (!selected.ok) return selected.exitCode;
  const invalid = diagnostics => {
    if (json) {
      const details = diagnostics.map(({ code, message, file, pointer }) => ({ code, message, file, ...(pointer ? { pointer } : {}) }));
      io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "suites", suite: null, runtime: null, error: { code: details[0]?.code ?? "suite.invalid", message: details[0]?.message ?? "Suite could not be inspected.", diagnostics: details } })}\n`);
    } else printDiagnostics(diagnostics, io);
    return 1;
  };
  let authored;
  try {
    try { authored = await dependencies.resolveV1Suite({ suitePath: resolve(io.cwd, selected.suite) }); }
    catch (error) {
      if (!(error instanceof V1AuthoringError)) throw error;
      return invalid([error]);
    }
    if (!authored.ok) return invalid(authored.diagnostics);
    const { defaults, value } = authored;
    const agents = defaults.agentSelections.map(agent => ({ runner: agent.adapterId, model: agent.requestedModel, effort: agent.settings?.effort ?? null }));
    const suite = {
      name: basename(selected.suite) === "example.suite.mjs" ? dirname(selected.suite) === "." ? "example" : basename(dirname(selected.suite)) : basename(selected.suite, ".suite.mjs"),
      path: selected.suite,
      tasks: [...defaults.taskIds], conditions: [...defaults.conditionIds], agents,
      repeats: defaults.repeat, concurrency: defaults.concurrency,
      plannedRuns: defaults.taskIds.length * defaults.conditionIds.length * agents.length * defaults.repeat,
      scoring: scoringLabel(value.definition.authorityProfiles),
      judge: value.definition.authorityProfiles.find(profile => profile.judge?.availability === "required")?.judge?.capability?.model ?? null,
    };
    let runtime;
    try { runtime = readRuntimeInfo(runtimePath, io.cwd); }
    catch (error) {
      if (!(error instanceof RuntimeProfileError)) throw error;
      return invalid([{ code: error.code, message: error.message, file: error.sourcePath ?? selected.suite, pointer: error.pointer }]);
    }
    if (json) {
      io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "suites", suite, runtime })}\n`);
      return 0;
    }
    const useColor = runOutputUsesColor(io);
    const fact = (label, text) => runFact(label, text, { useColor, labelWidth: 12 });
    io.stdout.write(terminalHeader(io.stdout)
      + fact("Suite", suite.name) + fact("Path", suite.path)
      + fact("Plan", `${suite.plannedRuns} ${plural(suite.plannedRuns, "run")} · ${suite.tasks.length} ${plural(suite.tasks.length, "task")} · ${suite.conditions.length} ${plural(suite.conditions.length, "condition")}`));
    for (const [index, agent] of agents.entries()) {
      io.stdout.write(fact(index ? "" : agents.length === 1 ? "Agent" : "Agents", `${AGENT_LABELS[agent.runner]} · ${agent.model ?? "agent default model"} · ${agent.effort ? `${agent.effort} effort` : "agent default effort"}`));
    }
    for (const [label, values] of [["Tasks", suite.tasks], ["Conditions", suite.conditions]]) {
      values.forEach((id, index) => io.stdout.write(fact(index ? "" : label, id)));
    }
    io.stdout.write(fact("Repeats", suite.repeats) + fact("Concurrency", suite.concurrency) + fact("Scoring", suite.scoring));
    if (suite.judge) io.stdout.write(fact("Judge", suite.judge));
    io.stdout.write("\n");
    for (const [label, text] of runtimeInfoRows(runtime, io.cwd)) io.stdout.write(fact(label, text));
    const next = suiteCommand("run", selection, { cwd: io.cwd }) + (runtimePath ? ` --runtime ${quoteCommandArgument(runtimePath)}` : "") + " --view";
    io.stdout.write(`\n${fact("Next", next)}\n`);
    return 0;
  } finally { authored?.dispose?.(); }
}

function hasHelpFlag(args) {
  return args.some((argument) => ["--help", "-h"].includes(argument));
}

function modelsError(io, json, code, message, exitCode = 1) {
  if (json) io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "models", models: [], error: { code, message } })}\n`);
  else writeError(io, `hurdle [${code}] ${message}\n`);
  return exitCode;
}

function parseModelsArguments(args, io) {
  const json = args.includes("--json");
  const invalid = message => ({ ok: false, exitCode: modelsError(io, json, "argument-error", message, 2) });
  const seen = new Set();
  let agent;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!["--agent", "--all", "--json"].includes(option)) return invalid("Use models --agent claude-code|codex [--all] [--json].");
    if (seen.has(option)) return invalid(`${option} may only be supplied once.`);
    seen.add(option);
    if (option === "--agent") agent = args[++index];
  }
  if (!Object.hasOwn(FIRST_PARTY_AGENT_ADAPTERS, agent)) return invalid("Select an Agent: models --agent claude-code|codex [--all] [--json].");
  return { ok: true, agent, json, all: seen.has("--all") };
}

async function showModels(args, io, dependencies) {
  const parsed = parseModelsArguments(args, io);
  if (!parsed.ok) return parsed.exitCode;
  const controller = new AbortController();
  let interrupted;
  const interrupt = signal => { interrupted = signal; controller.abort(); };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  dependencies.processTarget.once("SIGINT", onSigint);
  dependencies.processTarget.once("SIGTERM", onSigterm);
  try {
    const catalog = selectCatalogModels(await dependencies.discoverModels({ agent: parsed.agent, env: dependencies.env, signal: controller.signal }), { all: parsed.all });
    if (controller.signal.aborted) throw new ModelDiscoveryError("models.cancelled", "Model discovery was cancelled.");
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "models", ...catalog })}\n`);
      return 0;
    }
    io.stdout.write(terminalHeader(io.stdout)
      + runFact("Agent", AGENT_LABELS[parsed.agent], { useColor: runOutputUsesColor(io) })
      + runFact("Catalog", catalog.source, { useColor: runOutputUsesColor(io) })
      + runFact("Models", parsed.all ? "full catalog" : "recent text/code choices · up to 10", { useColor: runOutputUsesColor(io) }) + "\n");
    if (!catalog.models.length) io.stdout.write("No models returned. You can still supply --model MODEL directly.\n");
    else {
      const width = Math.max(8, ...catalog.models.map(model => model.id.length));
      io.stdout.write(`  ${"Model ID".padEnd(width)}  Name / reported effort\n`);
      for (const model of catalog.models) {
        const effort = model.reasoningEfforts?.length ? ` · effort: ${model.reasoningEfforts.join(", ")}` : "";
        io.stdout.write(`  ${model.id.padEnd(width)}  ${model.name}${model.isDefault ? " (runner default)" : ""}${effort}${model.lifecycle && model.lifecycle !== "active" ? ` · ${model.lifecycle}` : ""}\n`);
      }
    }
    if (!parsed.all) io.stdout.write(`\nFull catalog: ${projectExecutable(io.cwd)} models --agent ${parsed.agent} --all\n`);
    if (catalog.models.some(model => model.compatibility === "provider-catalog")) io.stdout.write("\nProvider-listed models may require a newer Agent CLI; runner compatibility is unverified.\n");
    io.stdout.write("\nAccount access is checked during execution. Sandbox runner versions can differ.\n");
    for (const warning of catalog.warnings) io.stdout.write(`${warning}\n`);
    io.stdout.write(`\nUse ${projectExecutable(io.cwd)} run SUITE --model MODEL\n\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ModelDiscoveryError ? error.code : "models.unavailable";
    const message = error instanceof ModelDiscoveryError ? error.message : "Model discovery failed. Retry or supply --model MODEL directly.";
    return modelsError(io, parsed.json, code, message, interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1);
  } finally {
    dependencies.processTarget.removeListener("SIGINT", onSigint);
    dependencies.processTarget.removeListener("SIGTERM", onSigterm);
  }
}

function usage(io) {
  writeError(io, `hurdle [argument-error] Unknown command or help topic. Run ${cliExecutable(io.cwd)} help.\n`);
  return 2;
}

function argumentError(message, io) {
  writeError(io, `hurdle [argument-error] ${message}\n`);
  return { ok: false, exitCode: 2 };
}

function readRuntimeInfo(runtimePath, cwd) {
  const runtime = resolveRuntimeProfile({ runtimePath: runtimePath ?? projectRuntimePath(cwd) ?? undefined, cwd });
  const { environment } = runtime;
  try {
    const settings = environment.kind === "together" ? normalizeTogetherSettings(environment.settings) : environment.settings;
    return { ...runtime, environment: { ...environment, settings } };
  } catch (error) {
    if (!(error instanceof RunSelectionInputError)) throw error;
    throw new RuntimeProfileError("runtime.profile-schema", error.message, { sourcePath: runtime.sourcePath, pointer: "/environment/settings" });
  }
}

function showRuntimeInfo(args, io) {
  const json = args.includes("--json");
  const fail = (code, message, sourcePath = null) => {
    if (json) {
      io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "runtime", runtime: null, error: { code, message, sourcePath } })}\n`);
    } else {
      writeError(io, `hurdle [${code}] ${message}${sourcePath ? `\n  Runtime: ${sourcePath}` : ""}`);
      if (code === "argument-error") io.stderr.write(terminalNext([`${cliExecutable(io.cwd)} help runtime`], io.stderr));
    }
    return 2;
  };
  let runtimePath;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!["--runtime", "--json"].includes(option)) return fail("argument-error", "Use runtime [--runtime FILE] [--json].");
    if (seen.has(option)) return fail("argument-error", `${option} may only be supplied once.`);
    seen.add(option);
    if (option === "--runtime") {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("-")) return fail("argument-error", "--runtime requires a file path.");
      runtimePath = value;
    }
  }
  let runtime;
  try {
    runtime = readRuntimeInfo(runtimePath, io.cwd);
  } catch (error) {
    if (!(error instanceof RuntimeProfileError)) throw error;
    return fail(error.code, error.message, error.sourcePath);
  }
  if (json) {
    io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "runtime", runtime })}\n`);
    return 0;
  }
  io.stdout.write(terminalHeader(io.stdout));
  for (const [label, value] of runtimeInfoRows(runtime, io.cwd)) io.stdout.write(runFact(label, value, { useColor: runOutputUsesColor(io) }));
  io.stdout.write("\n");
  return 0;
}

function runtimeInfoRows(runtime, cwd) {
  const displayPath = path => {
    const localPath = relative(cwd, path);
    return localPath === ".." || localPath.startsWith(`..${sep}`) ? path : localPath || ".";
  };
  const { environment, resultStore } = runtime;
  const { settings } = environment;
  const rows = runtimeSummaryRows(runtime, cwd);
  if (environment.kind === "together") {
    rows.push(["Image", "Together's Hurdle image"]);
    const lifetime = settings.maxLifetimeMs % 60_000 === 0 ? `${settings.maxLifetimeMs / 60_000}m` : `${settings.maxLifetimeMs / 1000}s`;
    // Together sizes its own image.
    rows.push(["Limits", `${lifetime} max`]);
  }
  if (resultStore.kind === "postgres") {
    rows.push(["Database", `${resultStore.databaseUrlEnv} (environment variable)`], ["Artifacts", displayPath(resultStore.artifactRoot)]);
  } else {
    rows.push(["Results", displayPath(resultStore.root)]);
  }
  if (runtime.judge) rows.push(["Judge", `${runtime.judge.kind} · ${runtime.judge.model}`]);
  rows.push(["Viewer", `Port ${runtime.viewer.port}`]);
  return rows;
}

function versionCommand(argv, io) {
  const [command, ...args] = argv;
  if (!["version", "--version", "-v"].includes(command)) return null;
  if (command === "version" && args.length === 1 && hasHelpFlag(args)) return help("version", io);
  if (args.length !== 0) return argumentError("Use version, --version, or -v without additional arguments.", io).exitCode;
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  io.stdout.write(`${version}\n`);
  return 0;
}

function defaultSuiteArgument(cwd) {
  // An explicit Suite path must remain usable even if broad discovery is limited.
  try { return defaultProjectSuite(cwd); }
  catch { return "example.suite.mjs"; }
}

function parseRunArguments(args, io, { validation = false } = {}) {
  const values = {
    suite: null,
    taskIds: [],
    conditionIds: [],
    agent: undefined,
    environment: "local",
    model: undefined,
    repeat: 1,
    retries: 0,
    concurrency: undefined,
    environmentSettings: "{}",
    experimentVersion: null,
    store: null,
    runtime: null,
    viewAfterRun: false,
    offline: false,
    explicitTopology: new Set(),
  };
  let suiteSeen = false;
  const seenScalarFields = new Set();
  const flags = new Map([
    ["--task", "taskIds"],
    ["--condition", "conditionIds"],
    ["--agent", "agent"],
    ["--environment", "environment"],
    ["--model", "model"],
    ["--environment-settings", "environmentSettings"],
    ["--experiment-version", "experimentVersion"],
    ["--store", "store"],
    ["--runtime", "runtime"],
  ]);
  if (!validation) flags.set("--concurrency", "concurrency");
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-")) {
      if (suiteSeen) return argumentError("Only one Suite may be selected.", io);
      values.suite = token;
      suiteSeen = true;
      continue;
    }
    if (validation && token === "--offline") {
      if (values.offline) return argumentError("Option '--offline' may only be supplied once.", io);
      values.offline = true;
      continue;
    }
    if (token === "--view" && !validation) {
      if (seenScalarFields.has("viewAfterRun")) {
        return argumentError("Option '--view' may only be supplied once.", io);
      }
      seenScalarFields.add("viewAfterRun");
      values.viewAfterRun = true;
      continue;
    }
    const field = flags.get(token);
    if (!field) return argumentError(`Unknown ${validation ? "validate" : "run"} option '${token}'.`, io);
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      return argumentError(`Option '${token}' requires a value.`, io);
    }
    if (Array.isArray(values[field])) {
      if (values[field].includes(value)) {
        return argumentError(`Option '${token}' selects '${value}' more than once.`, io);
      }
      values[field].push(value);
    } else {
      if (seenScalarFields.has(field)) {
        return argumentError(`Option '${token}' may only be supplied once.`, io);
      }
      seenScalarFields.add(field);
      values[field] = value;
      if (["environment", "environmentSettings", "store"].includes(field)) {
        values.explicitTopology.add(field);
      }
    }
    index += 1;
  }
  if (values.concurrency !== undefined) {
    try {
      if (!/^\d+$/.test(values.concurrency)) throw new TypeError();
      values.concurrency = normalizeRunConcurrency(Number(values.concurrency));
    } catch {
      return argumentError("--concurrency must be an integer between 1 and 100.", io);
    }
  }
  try {
    values.environmentSettings = JSON.parse(values.environmentSettings);
  } catch {
    return argumentError("--environment-settings must be a JSON object.", io);
  }
  if (
    !values.environmentSettings
    || typeof values.environmentSettings !== "object"
    || Array.isArray(values.environmentSettings)
  ) {
    return argumentError("--environment-settings must be a JSON object.", io);
  }
  if (values.agent !== undefined && !Object.hasOwn(FIRST_PARTY_AGENT_ADAPTERS, values.agent)) {
    return argumentError("Agent filter must use 'claude-code' or 'codex'.", io);
  }
  if (values.model !== undefined) {
    if (!values.model.trim()) return argumentError("--model requires a nonblank model ID.", io);
    values.model = values.model.trim();
  }
  if (!["local", "together"].includes(values.environment)) {
    return argumentError("Execution Environment must be 'local' or 'together'.", io);
  }
  if (
    values.runtime === null
    && values.environment === "local"
    && Object.keys(values.environmentSettings).length > 0
  ) {
    return argumentError("Local Execution Environment settings must be empty.", io);
  }
  if (values.runtime === null && values.environment === "together") {
    try {
      normalizeTogetherSettings(values.environmentSettings);
    } catch (error) {
      if (!(error instanceof RunSelectionInputError)) throw error;
      return argumentError(`--environment-settings: ${error.message.replace(/\.?$/, ".")}`, io);
    }
  }
  if (values.runtime !== null && values.explicitTopology.size > 0) {
    return argumentError(
      "--runtime cannot be combined with --environment, --environment-settings, or --store.",
      io,
    );
  }
  if (values.runtime === null && values.explicitTopology.size === 0) values.runtime = projectRuntimePath(io.cwd);
  return { ok: true, values };
}

function parseViewArguments(args, io) {
  const values = { runtime: null, store: null, port: null };
  for (let index = 0; index < args.length; index += 2) {
    const field = { "--runtime": "runtime", "--store": "store", "--port": "port" }[args[index]];
    const value = args[index + 1];
    if (!field || values[field] !== null || !value || value.startsWith("-")) {
      return argumentError("view accepts only an optional '--runtime FILE' or '--store DIR', and '--port PORT'.", io);
    }
    values[field] = value;
  }
  if (values.runtime !== null && values.store !== null) {
    return argumentError("view accepts only an optional '--runtime FILE' or '--store DIR', and '--port PORT'.", io);
  }
  if (values.port !== null) {
    if (!/^[1-9]\d{0,4}$/.test(values.port) || Number(values.port) > 65_535) {
      return argumentError("--port must be a whole number from 1 to 65535.", io);
    }
    values.port = Number(values.port);
  }
  return { ok: true, values };
}

function validateRunSelection(options, definition, io) {
  try {
    for (const [field, definitions, label] of [
      ["taskIds", definition.tasks, "Task"],
      ["conditionIds", definition.conditions, "Condition"],
    ]) {
      selectDefinitionIds(
        definitions,
        options[field].length > 0 ? options[field] : undefined,
        label,
      );
    }
  } catch (error) {
    return argumentError(`${error.message}.`, io);
  }
  return { ok: true };
}

async function serveResolvedViewer(runtimeProfile, io, dependencies, {
  showHeader = true, suite = defaultSuiteArgument(io.cwd), storeOverride = false, viewCommand = null,
} = {}) {
  let storeEnvironment;
  try {
    storeEnvironment = viewerStoreEnvironment(runtimeProfile, dependencies.env);
  } catch (error) {
    if (!(error instanceof RuntimeProfileError)) throw error;
    writeError(io, `hurdle [${error.code}] ${error.message}\n`);
    return 2;
  }
  let readyPrinted = false;
  const progress = io.stderr?.isTTY === true
    ? createTerminalProgress({ stream: io.stderr })
    : null;
  const useColor = runOutputUsesColor(io);
  if (showHeader) io.stdout.write(terminalHeader(io.stdout));
  const markReady = (url) => {
    if (readyPrinted) return;
    readyPrinted = true;
    progress?.stop();
    io.stdout.write(
      terminalStatus("pass", "Viewer ready", io.stdout) + "\n"
      + runFact("URL", url, { useColor })
      + runtimeSummaryRows(runtimeProfile, io.cwd, { inline: storeOverride }).map(([label, value]) => runFact(label, value, { useColor })).join("")
      + runFact(runtimeProfile.resultStore.kind === "postgres" ? "Artifacts" : "Results", displayResultsPath(runtimeProfile, io.cwd), { useColor })
      + `\n  ${paintRunOutput("Press Ctrl+C to stop.", "dim", useColor)}\n`,
    );
  };
  progress?.start("Starting Results Viewer");
  const outcome = await dependencies.launchViewer({
    storeEnvironment,
    onboarding: createViewerOnboarding({
      cwd: io.cwd,
      suite,
      runtimeProfile,
      storeOverride,
    }),
    port: runtimeProfile.viewer.port,
    cwd: dependencies.viewerCwd,
    env: dependencies.env,
    processTarget: dependencies.processTarget,
    onReady(url) {
      markReady(url);
    },
  });
  if (!readyPrinted && outcome.url) markReady(outcome.url);
  if (outcome.kind === "interrupted") {
    if (!readyPrinted) progress?.warn("Results Viewer stopped");
    return outcome.exitCode;
  }
  if (outcome.kind === "stopped") {
    if (!readyPrinted) progress?.succeed("Results Viewer stopped");
    return 0;
  }
  progress?.fail(readyPrinted ? "Results Viewer stopped unexpectedly" : "Results Viewer failed to start");
  if (outcome.reason === "disposal-unconfirmed") {
    writeError(io, "hurdle [viewer-disposal-unconfirmed] Viewer shutdown could not be confirmed. Check for a surviving Viewer process before restarting.\n");
    return 1;
  }
  if (outcome.reason === "port-in-use") {
    const { port } = runtimeProfile.viewer;
    writeError(io,
      `hurdle [viewer-port-in-use] Port ${port} is already in use.\n`
      + `Open http://127.0.0.1:${port} if the Viewer is already running, `
      + "or stop that process and run this command again.\n",
    );
    // Name the same Result Store on another port.
    if (viewCommand) io.stderr.write(terminalNext([`${viewCommand} --port ${port === 65_535 ? 3000 : port + 1}`], io.stderr));
  } else if (outcome.reason === "viewer-lock-held") {
    writeError(io,
      "hurdle [viewer-lock-held] Another Viewer development server appears to be running from this checkout.\n"
      + "Stop that Viewer and run this command again. If no Viewer is running, remove the stale viewer/.next/dev/lock file.\n",
    );
  } else {
    writeError(io,
      "hurdle [viewer-failed] The Results Viewer could not be started. "
      + "Run `npm --prefix viewer run dev` to inspect the startup error.\n",
    );
  }
  return 1;
}

async function runCliMain(argv, io, dependencies) {
  const versionResult = versionCommand(argv, io);
  if (versionResult !== null) return versionResult;
  const [requestedCommand, ...args] = argv;
  const command = requestedCommand === "ls" ? "suites" : requestedCommand;
  if (!command) return help("main", io);

  if (["--help", "-h"].includes(command) && args.length === 0) {
    return help("main", io);
  }
  if (command === "help") {
    if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
      return help("main", io);
    }
    const topic = args[0] === "ls" ? "suites" : args[0];
    if (args.length === 1 && Object.hasOwn(HELP_TEXT, topic) && topic !== "main") {
      return help(topic, io);
    }
    return usage(io);
  }
  if (["init", "suites", "models", "setup", "runtime", "validate", "run", "view"].includes(command) && hasHelpFlag(args)) {
    const modelIndex = args.indexOf("--model");
    if (["run", "validate"].includes(command) && modelIndex >= 0 && ["-h", "--help"].includes(args[modelIndex + 1])) {
      return modelHelp(command, args, io, dependencies);
    }
    return help(command, io, args[0]?.startsWith("-") ? null : args[0]);
  }

  if (command === "runtime") return showRuntimeInfo(args, io);
  if (command === "models") return showModels(args, io, dependencies);

  if (command === "suites") {
    let selection, runtimePath, json = false;
    const suitesArgumentError = message => {
      if (!args.includes("--json")) return argumentError(message, io).exitCode;
      io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "suites", ...(selection ? { suite: null } : { defaultSuite: null, suites: [] }), error: { code: "argument-error", message } })}\n`);
      return 2;
    };
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--json" && !json) json = true;
      else if (arg === "--runtime" && runtimePath === undefined) {
        runtimePath = args[++index];
        if (!runtimePath?.trim() || runtimePath.startsWith("-")) return suitesArgumentError("--runtime requires a file path.");
      }
      else if (!arg.startsWith("-") && arg.trim() && !selection) selection = arg;
      else return suitesArgumentError("Use suites [suite] [--runtime FILE] [--json] (alias: ls).");
    }
    if (runtimePath && !selection) return suitesArgumentError("Select a Suite when using --runtime.");
    if (selection) return inspectProjectSuite(selection, io, dependencies, { json, runtimePath, argumentError: suitesArgumentError });
    let suites;
    try { suites = discoverProjectSuites(io.cwd); }
    catch (error) { return suitesArgumentError(error.message); }
    const selectedDefault = defaultProjectSuite(io.cwd, suites);
    const defaultSuite = suites.find(suite => suite.path === selectedDefault)?.path ?? null;
    if (json) {
      io.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "suites", defaultSuite, suites })}\n`);
      return 0;
    }
    io.stdout.write(terminalHeader(io.stdout));
    if (suites.length === 0) {
      io.stdout.write(`No Suites found.\n\nCreate one:\n  ${projectExecutable(io.cwd)} init\n\n`);
      return 0;
    }
    const width = Math.max(8, ...suites.map(suite => suite.name.length));
    io.stdout.write(`  ${"Name".padEnd(width)}  Suite path\n\n`);
    for (const suite of suites) {
      io.stdout.write(`  ${suite.name.padEnd(width)}  ${suite.path}${suite.ambiguous ? "  (use path; name is ambiguous)" : suite.name.startsWith("-") ? "  (use path)" : ""}${suite.path === defaultSuite ? "  (default)" : ""}\n`);
    }
    const example = suites.find(suite => suite.path === defaultSuite) ?? suites.find(suite => !suite.bundled) ?? suites[0];
    io.stdout.write(`\nRun by name or path:\n  ${projectExecutable(io.cwd)} run ${quoteCommandArgument(suiteSelection(example))} --view\n\n`);
    return 0;
  }

  if (command === "init") {
    let directory = "evals", agent = "claude-code", example = "copy-message", model, effort = "medium", directorySeen = false, agentSeen = false, exampleSeen = false;
    const seenOptions = new Set();
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--agent" && !agentSeen) {
        agent = args[++index];
        agentSeen = true;
        if (!["claude-code", "codex"].includes(agent)) return argumentError("--agent must be claude-code or codex.", io).exitCode;
      } else if (args[index] === "--example" && !exampleSeen) {
        example = args[++index];
        exampleSeen = true;
        if (!["copy-message", "together-api", "concurrency-smoke", "kitchen-sink"].includes(example)) return argumentError("--example must be copy-message, together-api, concurrency-smoke or kitchen-sink.", io).exitCode;
      } else if (["--model", "--effort"].includes(args[index]) && !seenOptions.has(args[index])) {
        const option = args[index];
        const value = args[++index];
        if (!value || value.startsWith("-") || !value.trim()) return argumentError(`Option '${option}' requires a value.`, io).exitCode;
        seenOptions.add(option);
        if (option === "--model") model = value.trim();
        else {
          if (!isAgentEffort(value)) return argumentError("--effort must be low, medium, high, xhigh, or max.", io).exitCode;
          effort = value;
        }
      } else if (!args[index].startsWith("-") && !directorySeen) {
        directory = args[index];
        directorySeen = true;
      } else {
        return argumentError("Use init [directory] [--agent claude-code|codex] [--example copy-message|together-api|concurrency-smoke|kitchen-sink] [--model MODEL] [--effort LEVEL].", io).exitCode;
      }
    }
    const destination = resolve(io.cwd, directory);
    model ??= STARTER_AGENT_MODELS[agent];
    const result = await dependencies.initializeSuite({ destination, agent, example, model, effort });
    if (!result.ok) {
      printDiagnostics(result.diagnostics, io);
      return 1;
    }
    const suite = `${directory.replace(/\/$/, "")}/example.suite.mjs`;
    const useColor = runOutputUsesColor(io);
    // The Local quickstart never runs setup, so init keeps .env.local out of git too.
    let ignored;
    try {
      ignored = await ignoreProjectFiles(io.cwd) ? "Added .env.local and .hurdle/ to .gitignore" : null;
    } catch {
      ignored = "Could not update .gitignore; add /.env.local and /.hurdle/ to it yourself";
    }
    io.stdout.write(terminalHeader(io.stdout)
      + terminalStatus("pass", "Evaluation created", io.stdout) + "\n"
      + runFact("Suite", suite, { useColor })
      + runFact("Agent", AGENT_LABELS[agent], { useColor })
      + runFact("Model", model, { useColor })
      + runFact("Effort", effort, { useColor })
      + (example === "together-api" ? runFact("Needs", "Together sandbox + TOGETHER_API_KEY", { useColor }) : "")
      + runFact("Auth", `.env.local or shell · see ${cliExecutable(io.cwd)} help init`, { useColor })
      + (ignored ? runFact("Git", ignored, { useColor }) : "")
      + runFact("Usage", example === "together-api" ? "Agent, Together sandbox, and Together API may be billed" : "Agent may be billed", { useColor })
      + terminalNext([
        example === "together-api" ? suiteCommand("setup", suite, { cwd: io.cwd }) : suiteCommand("validate", suite, { cwd: io.cwd }),
        suiteCommand("run", suite, { view: true, cwd: io.cwd }),
      ], io.stdout));
    return 0;
  }

  if (command === "setup") {
    const options = { suite: defaultSuiteArgument(io.cwd), sandbox: "together", yes: false, interactive: false, json: args.includes("--json") };
    const setupArgumentError = message => {
      const executable = projectExecutable(io.cwd);
      let suites = [];
      try { suites = discoverProjectSuites(io.cwd); } catch { /* Explicit paths and help still work. */ }
      const example = suites.find(suite => suite.path === options.suite || suite.name === options.suite)
        ?? suites.find(suite => !suite.bundled) ?? suites[0];
      const selection = example ? quoteCommandArgument(suiteSelection(example)) : "evals/example.suite.mjs";
      const commands = [
        `${executable} setup ${selection}`,
        `${executable} setup --store postgres`,
      ];
      if (options.json) {
        const output = createSetupOutput(io, { json: true });
        output.result.nextCommands = commands;
        return output.finish(2, { code: "argument-error", message });
      }
      return argumentError(`${message}\n\nSeparate setup steps (sandbox, then storage):\n  ${commands.join("\n  ")}\n\nMore help:\n  ${executable} help setup\n  ${executable} suites\n`, io).exitCode;
    };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (["--yes", "--json", "--interactive", "--sandbox", "--store"].includes(arg)) {
        if (seen.has(arg)) return setupArgumentError(`Option '${arg}' may only be supplied once.`);
        seen.add(arg);
        if (["--yes", "--json", "--interactive"].includes(arg)) options[arg.slice(2)] = true;
        else {
          if (!args[index + 1] || args[index + 1].startsWith("-")) return setupArgumentError(`Option '${arg}' requires a value.`);
          options[arg.slice(2)] = args[++index];
        }
      } else if (!arg.startsWith("-")) {
        if (seen.has("suite")) return setupArgumentError("Only one Suite may be selected.");
        options.suite = arg; seen.add("suite");
      } else {
        const normalized = arg.replace(/^-+/, "--");
        const suggestion = ["--sandbox", "--store", "--yes", "--json", "--interactive"].includes(normalized)
          ? ` Use '${normalized}' with two dashes.` : " Run help setup to see supported options.";
        const combined = args.some(value => value.replace(/^-+/, "--") === "--store") && args.includes("--sandbox")
          ? " Sandbox and storage must be configured in separate commands." : "";
        return setupArgumentError(`Unknown setup option '${arg}'.${suggestion}${combined}`);
      }
    }
    if (options.json && options.interactive) return setupArgumentError("Use --json for noninteractive setup or --interactive for terminal prompts, not both.");
    if (options.interactive && (!(io.stdin ?? process.stdin).isTTY || !io.stdout.isTTY)) {
      return setupArgumentError("--interactive requires a terminal. Configure credentials in .env.local or the environment instead.");
    }
    if (options.sandbox !== "together") return setupArgumentError("Sandbox provider must be together.");
    if (options.store !== undefined) {
      if (options.store !== "postgres") return setupArgumentError("Use --store postgres to configure database storage.");
      if (seen.has("--sandbox")) {
        return setupArgumentError("--store postgres cannot be combined with sandbox options. Configure the sandbox first, then Postgres storage; both settings are saved in the same Runtime.");
      }
    }
    const selected = selectProjectSuite(options.suite, io, message => ({ ok: false, exitCode: setupArgumentError(message) }));
    if (!selected.ok) return selected.exitCode;
    options.suite = selected.suite;
    if (options.store) return setupPostgresStore(options, io, dependencies);
    return setupTogetherSandbox(options, io, dependencies);
  }

  if (command === "run" || command === "validate") {
    const validation = command === "validate";
    const parsed = parseRunArguments(args, io, { validation });
    if (!parsed.ok) return parsed.exitCode;
    const options = parsed.values;
    if (options.suite === null) {
      const defaultSuite = defaultSuiteArgument(io.cwd);
      if (!existsSync(resolve(io.cwd, defaultSuite))) return missingRunSuite(command, io);
      options.suite = defaultSuite;
    }
    const selected = selectProjectSuite(options.suite, io);
    if (!selected.ok) return selected.exitCode;
    options.suite = selected.suite;
    const suiteSelected = /\.suite\.mjs$/.test(options.suite);
    let authoredSuite = null;
    let authoredSuiteCleanupOnExit = null;
    let resolvedPlan;
    if (suiteSelected) {
      try {
        authoredSuite = await dependencies.resolveV1Suite({
          suitePath: resolve(io.cwd, options.suite),
        });
      } catch (error) {
        if (!(error instanceof V1AuthoringError)) throw error;
        if (error.code === "suite.file-invalid") return missingRunSuite(command, io, options.suite);
        printDiagnostics([error], io);
        return 1;
      }
      resolvedPlan = authoredSuite;
      if (!resolvedPlan.ok) {
        printDiagnostics(resolvedPlan.diagnostics, io);
        authoredSuite.dispose();
        return 1;
      }
      if (options.taskIds.length === 0) options.taskIds = [...authoredSuite.defaults.taskIds];
      if (options.conditionIds.length === 0) options.conditionIds = [...authoredSuite.defaults.conditionIds];
      try {
        options.agentSelections = selectSuiteAgents(authoredSuite.defaults.agentSelections, options);
      } catch (error) {
        if (!(error instanceof RunSelectionInputError)) throw error;
        const models = suiteModelRows(authoredSuite.defaults.agentSelections).join("\n");
        authoredSuite.dispose();
        return argumentError(`${error.message}\n\nSuite Agents:\n${models}`, io).exitCode;
      }
      options.repeat = authoredSuite.defaults.repeat;
      options.concurrency ??= authoredSuite.defaults.concurrency ?? DEFAULT_RUN_CONCURRENCY;
      authoredSuiteCleanupOnExit = () => authoredSuite?.dispose();
      dependencies.processTarget.once("exit", authoredSuiteCleanupOnExit);
    } else {
      return argumentError("Select a .suite.mjs Suite.", io).exitCode;
    }
    if (!resolvedPlan.ok) {
      printDiagnostics(resolvedPlan.diagnostics, io);
      return 1;
    }
    const disposeAuthoredSuite = () => {
      if (!authoredSuite) return;
      dependencies.processTarget.off("exit", authoredSuiteCleanupOnExit);
      authoredSuite.dispose();
      authoredSuite = null;
      authoredSuiteCleanupOnExit = null;
    };
    const selection = validateRunSelection(
      options,
      resolvedPlan.value.definition,
      io,
    );
    if (!selection.ok) {
      disposeAuthoredSuite();
      return selection.exitCode;
    }
    const selectedTaskIds = selectDefinitionIds(
      resolvedPlan.value.definition.tasks,
      options.taskIds.length > 0 ? options.taskIds : undefined,
      "Task",
    );
    io.stdout.write(terminalHeader(io.stdout));
    if (validation) {
      const useColor = runOutputUsesColor(io);
      const conditions = options.conditionIds.length || Object.keys(resolvedPlan.value.definition.conditions).length;
      io.stdout.write(terminalStatus("pass", "Suite valid", io.stdout) + "\n"
        + runFact("Suite", options.suite, { useColor })
        + runFact("Plan", `${selectedTaskIds.length} ${plural(selectedTaskIds.length, "task")} · ${conditions} ${plural(conditions, "condition")}`, { useColor })
        + runFact("Agent", options.agentSelections.map(agentSelectionLabel).join(", "), { useColor }));
      if (options.offline) {
        io.stdout.write("\n" + terminalStatus("warning", "Readiness not checked (--offline)", io.stdout)
          + terminalNext([suiteCommand("validate", options.suite, { cwd: io.cwd })], io.stdout));
        disposeAuthoredSuite();
        return 0;
      }
    }
    let runtimeProfile;
    try {
      if (options.runtime !== null) {
        runtimeProfile = resolveRuntimeProfile({
          runtimePath: options.runtime,
          cwd: io.cwd,
          defaultRoot: authoredSuite ? io.cwd : resolvedPlan.value.sourceRoot,
        });
      } else {
        const builtIn = resolveRuntimeProfile({
          cwd: io.cwd,
          defaultRoot: authoredSuite ? io.cwd : resolvedPlan.value.sourceRoot,
        });
        // Like setup, judge with the Suite's own Judge model when it names one.
        const judgeModels = [...new Set(resolvedPlan.value.definition.authorityProfiles
          .filter((profile) => profile.judge?.availability === "required")
          .map((profile) => profile.judge.capability.model))];
        runtimeProfile = Object.freeze({
          ...builtIn,
          ...(judgeModels.length === 1 ? {
            judge: Object.freeze({ kind: ANTHROPIC_JSON_JUDGE_ID, model: judgeModels[0], credentialEnv: judgeCredentialEnvironment(dependencies.env) }),
          } : {}),
          environment: Object.freeze({
            kind: options.environment,
            ...(options.environment === "together" ? { apiKeyEnv: "TOGETHER_API_KEY" } : {}),
            settings: structuredClone(options.environmentSettings),
          }),
          resultStore: Object.freeze({
            kind: "local",
            root: options.store
              ? resolve(io.cwd, options.store)
              : builtIn.resultStore.root,
          }),
        });
      }
    } catch (error) {
      if (!(error instanceof RuntimeProfileError)) throw error;
      writeError(io, `hurdle [${error.code}] ${error.message}\n`);
      disposeAuthoredSuite();
      return 2;
    }
    if (runtimeProfile.environment.kind === "local" && selectedTaskIds.some(taskId => (
      resolvedPlan.value.definition.tasks[taskId].executionRequirements?.some(requirement => [
        "environment.trusted-egress-capture", "environment.trusted-request-blocking",
      ].includes(requirement))
    ))) {
      writeError(io, `hurdle [runtime.capture-required] Selected Tasks require trusted API capture or request blocking. Run \`${suiteCommand("setup", options.suite, { cwd: io.cwd })}\` to configure the Together sandbox, or select a Together Runtime with --runtime. No evaluation started.\n`);
      disposeAuthoredSuite();
      return 1;
    }
    const judgeCapability = describeRuntimeJudgeCapability(runtimeProfile);
    const authoritySelection = resolveAuthoritySelections({
      definition: resolvedPlan.value.definition,
      selectedTaskIds,
      judgeCapability,
    });
    if (!authoritySelection.ok) {
      const selectedConditionCount = options.conditionIds.length > 0
        ? options.conditionIds.length
        : Object.keys(resolvedPlan.value.definition.conditions).length;
      const plannedCells = selectedTaskIds.length
        * selectedConditionCount
        * options.agentSelections.length;
      writeError(io,
        `hurdle [matrix-rejected] ${plannedCells} selected cells could not be executed.\n`,
      );
      for (const diagnostic of authoritySelection.diagnostics.slice(0, 10)) {
        writeError(io, `hurdle [${diagnostic.code}] ${diagnostic.message}\n`);
      }
      const exitCode = authoritySelection.diagnostics.every(
        ({ category }) => category === "selection",
      ) ? 2 : 1;
      disposeAuthoredSuite();
      return exitCode;
    }
    const authorityNeedsJudge = Object.values(authoritySelection.value.byTaskId).some(
      (authority) => authority?.judge?.availability === "required",
    );
    let runtimeSecrets;
    try {
      runtimeSecrets = resolveRuntimeSecrets(
        runtimeProfile,
        dependencies.env,
        { judge: authorityNeedsJudge },
      );
    } catch (error) {
      if (!(error instanceof RuntimeProfileError)) throw error;
      writeError(io, `hurdle [${error.code}] ${error.message}\n`);
      disposeAuthoredSuite();
      return 2;
    }
    const selectedCredentialNames = new Set(selectedTaskIds.flatMap((taskId) => (
      resolvedPlan.value.definition.tasks[taskId].credentialRequirements
    )));
    const keyRoutes = suiteKeyRoutes(resolvedPlan.value.definition, selectedTaskIds, runtimeProfile.environment);
    const agentVisibleCredentialNames = new Set(keyRoutes.filter(({ agentVisible }) => agentVisible).map(({ name }) => name));
    if (validation) {
      for (const [label, value] of [
        ...runtimeSummaryRows(runtimeProfile, io.cwd, { inline: options.explicitTopology.size > 0 }),
        ...suiteKeyRows(keyRoutes),
      ]) {
        io.stdout.write(runFact(label, value, { useColor: runOutputUsesColor(io) }));
      }
    }
    io.stdout.write("\n" + terminalNote(`Readiness (${dependencies.environmentSource})`, io.stdout));
    let readiness;
    try {
      readiness = await dependencies.checkAgentReadiness({
        agentSelections: options.agentSelections,
        runtimeProfile,
        runtimeEnv: dependencies.env,
        requiredCredentials: [...selectedCredentialNames],
        judgeCredentialName: authorityNeedsJudge ? runtimeProfile.judge.credentialEnv : null,
        suite: options.suite, cwd: io.cwd,
      });
    } catch {
      writeError(io, "hurdle [readiness-unavailable] Readiness checks could not complete. No evaluation started; check your setup and retry.\n");
      disposeAuthoredSuite();
      return 1;
    }
    for (const check of readiness.checks) {
      io.stdout.write(terminalStatus(check.status, check.message, io.stdout));
    }
    if (!readiness.ok) {
      const needsStorageSetup = readiness.checks.some(check => check.code === "runtime.postgres-setup-required" && check.status === "fail");
      if (needsStorageSetup) {
        writeError(io, "hurdle [runtime.postgres-setup-required] Postgres storage needs setup before running. No evaluation started.\n");
        io.stdout.write(terminalNext([`${suiteCommand("setup", options.suite, { cwd: io.cwd })} --store postgres`], io.stdout));
      } else writeError(io, `hurdle [not-ready] Resolve the setup errors above and run \`${suiteCommand("validate", options.suite, { cwd: io.cwd })}\` again. No evaluation started.\n`);
      disposeAuthoredSuite();
      return 1;
    }
    if (validation) {
      io.stdout.write("\n" + terminalStatus("pass", "Ready to run", io.stdout)
        + terminalNote("Model access, billing, and task success are checked during execution.", io.stdout)
        + terminalNext([suiteCommand("run", options.suite, { view: true, cwd: io.cwd })], io.stdout));
      disposeAuthoredSuite();
      return 0;
    }
    if (authoredSuite) {
      const selectedConditionCount = options.conditionIds.length > 0
        ? options.conditionIds.length
        : Object.keys(resolvedPlan.value.definition.conditions).length;
      const plannedCells = selectedTaskIds.length
        * selectedConditionCount
        * options.agentSelections.length;
      const plannedRuns = plannedCells * options.repeat;
      const services = [
        "Agent",
        ...(authorityNeedsJudge ? ["Judge"] : []),
        ...(runtimeProfile.environment.kind === "together" ? ["Together sandbox"] : []),
        ...(selectedCredentialNames.size > 0 ? ["external API"] : []),
      ];
      const serviceText = services.length === 1
        ? services[0]
        : services.length === 2
          ? `${services[0]} and ${services[1]}`
          : `${services.slice(0, -1).join(", ")}, and ${services.at(-1)}`;
      const useColor = runOutputUsesColor(io);
      const plan = `${plannedRuns} ${plural(plannedRuns, "run")} · `
        + `${selectedTaskIds.length} ${plural(selectedTaskIds.length, "task")} · `
        + `${selectedConditionCount} ${plural(selectedConditionCount, "condition")}`;
      const agents = options.agentSelections.map(agentSelectionLabel).join(", ");
      const authorities = selectedTaskIds.map(
        (taskId) => authoritySelection.value.byTaskId[taskId],
      );
      const planFact = (label, value) => runFact(label, value, { useColor, labelWidth: 12 });
      io.stdout.write(
        "\n" + planFact("Plan", plan)
        + planFact("Agent", agents)
        + runtimeSummaryRows(runtimeProfile, io.cwd, { inline: options.explicitTopology.size > 0 }).map(([label, value]) => planFact(label, value)).join("")
        + planFact("Concurrency", String(options.concurrency))
        + planFact("Scoring", scoringLabel(authorities))
        + planFact("Usage", `${serviceText} may be billed`)
        + suiteKeyRows(keyRoutes).map(([label, value]) => planFact(label, value)).join(""),
      );
      if (agentVisibleCredentialNames.size > 0) {
        io.stdout.write(
          planFact("Access", "Target API credentials available to Agent"),
        );
      }
      io.stdout.write("\n");
    }
    const progressStream = io.stderr?.isTTY === true ? io.stderr : io.stdout;
    const progress = createTerminalProgress({
      stream: progressStream,
      showElapsed: true,
    });
    progress.start("Opening result store");
    let resultStore;
    try {
      resultStore = runtimeProfile.resultStore.kind === "postgres"
        ? await dependencies.openPostgresResultStore({
            connectionString: runtimeSecrets.postgresDatabaseUrl,
            localArtifactRoot: runtimeProfile.resultStore.artifactRoot,
          })
        : await dependencies.openLocalResultStore({ root: runtimeProfile.resultStore.root });
    } catch (error) {
      progress.stop();
      if (runtimeProfile.resultStore.kind === "postgres" && error?.code === "store.schema-not-ready") {
        writeError(io, "hurdle [store.schema-not-ready] Postgres result schema needs setup. No evaluation started.\n");
        io.stdout.write(terminalNext([`${suiteCommand("setup", options.suite, { cwd: io.cwd })} --store postgres`], io.stdout));
      } else writeError(io, "hurdle [store-unavailable] The configured Result Store could not be opened.\n");
      disposeAuthoredSuite();
      return 1;
    }
    const activeCells = new Map();
    const executionCells = new Map();
    let completedCells = 0;
    let totalCells = 0;
    const reportedReasonRunIds = new Set();
    const checkCounts = { pass: 0, fail: 0, skip: 0 };
    const progressColor = terminalUsesColor(progressStream);
    const dim = (text) => paintRunOutput(text, "dim", progressColor);
    const cellLabel = (cell) => {
      const agent = { "claude-code": "Claude Code", codex: "Codex" }[cell.adapterId] ?? cell.adapterId;
      const repeat = cell.repeatTotal > 1 ? ` · repeat ${cell.repeatOrdinal}/${cell.repeatTotal}` : "";
      return `[${cell.ordinal}/${cell.total}] ${cell.taskId} · ${cell.conditionId} · ${agent}${repeat}`;
    };
    // Like a test list: name every check, and explain only the ones that did not pass.
    const checkLine = (check) => {
      if (check.outcome === "pass") return `${terminalMark("pass", progressColor)} ${check.id}`;
      const authority = check.effectiveAuthority === "required" ? "" : ` ${dim(`(${check.effectiveAuthority})`)}`;
      const summary = check.summary ? `  ${dim(check.summary)}` : "";
      return `${terminalMark(check.outcome, progressColor)} ${check.id}${authority}${summary}`;
    };
    const renderActiveProgress = ({ start = false } = {}) => {
      if (activeCells.size === 0) return;
      let label;
      if (activeCells.size === 1) {
        const { cell, phase } = activeCells.values().next().value;
        label = `${cellLabel(cell)} · ${phase}`;
      } else {
        const phases = new Map();
        for (const { phase } of activeCells.values()) phases.set(phase, (phases.get(phase) ?? 0) + 1);
        label = `${activeCells.size} active · ${completedCells}/${totalCells} done · `
          + [...phases].map(([phase, count]) => `${count} ${phase}`).join(" · ");
      }
      progress[start ? "start" : "update"](label);
    };
    const terminalObserver = { observe(event) {
      if (event.kind === "matrix-ready") {
        totalCells = event.total;
      } else if (event.kind === "cell-started") {
        const start = activeCells.size === 0;
        activeCells.set(event.cell.ordinal, { cell: event.cell, startedAt: Date.now(), phase: "Evaluating" });
        renderActiveProgress({ start });
      } else if (event.kind === "cell-attempt-started") {
        const active = activeCells.get(event.cell.ordinal);
        if (!active) return;
        if (active.executionId) executionCells.delete(active.executionId);
        active.executionId = event.executionId;
        executionCells.set(event.executionId, event.cell.ordinal);
      } else if (event.kind === "environment-status") {
        const ordinal = executionCells.get(event.executionId);
        const onlyActive = activeCells.size === 1 ? activeCells.values().next().value : null;
        const active = ordinal === undefined && onlyActive && !onlyActive.executionId
          ? onlyActive : activeCells.get(ordinal);
        if (!active) return;
        active.phase = ENVIRONMENT_STATUS_LABELS[event.status];
        renderActiveProgress();
      } else if (event.kind === "cell-finalizing") {
        const active = activeCells.get(event.cell.ordinal);
        if (!active) return;
        active.phase = "Finalizing results";
        renderActiveProgress();
      } else if (event.kind === "cell-completed") {
        const active = activeCells.get(event.cell.ordinal);
        const verdict = event.terminal.verdict;
        const method = verdict === "pass" ? "succeed" : verdict === "fail" ? "fail" : "warn";
        activeCells.delete(event.cell.ordinal);
        if (active?.executionId) executionCells.delete(active.executionId);
        completedCells += 1;
        progress[method](
          `${cellLabel(event.cell)} · ${verdict}`,
          `${Math.max(0, Math.floor((Date.now() - (active?.startedAt ?? Date.now())) / 1000))}s`,
        );
        const checks = event.terminal.checks ?? [];
        for (const check of checks) {
          checkCounts[check.outcome] += 1;
          progress.detail(checkLine(check));
        }
        const omittedChecks = event.terminal.omittedCheckCount ?? 0;
        if (omittedChecks > 0) progress.detail(dim(`… ${omittedChecks} more ${plural(omittedChecks, "check")}`));
        // Listed checks already explain themselves; keep only the other reasons.
        const listedChecks = new Set(checks.map(({ id }) => `check.${id}`));
        const reasons = projectVerdictReasons([
          ...(event.terminal.runTrustReasons ?? []),
          ...event.terminal.verdictReasons,
        ].filter(({ code }) => !listedChecks.has(code)));
        for (const reason of reasons) progress.detail(dim(`${reason.code}: ${reason.summary}`));
        if (reasons.length > 0 || checks.length > 0) reportedReasonRunIds.add(event.terminal.id);
        renderActiveProgress({ start: true });
      }
    } };
    const progressObserver = { observe(event) {
      reportExecutionProgress(terminalObserver, event);
      reportExecutionProgress(dependencies.executionProgressObserver, event);
    } };
    const abortController = new AbortController();
    let interruptedSignal = null;
    const interrupt = (signal) => {
      interruptedSignal ??= signal;
      abortController.abort();
    };
    const onSigint = () => interrupt("SIGINT");
    const onSigterm = () => interrupt("SIGTERM");
    // A closed terminal must still stop the Agent and sandboxes, not orphan them.
    const onSighup = () => interrupt("SIGHUP");
    dependencies.processTarget.on("SIGINT", onSigint);
    dependencies.processTarget.on("SIGTERM", onSigterm);
    dependencies.processTarget.on("SIGHUP", onSighup);
    let result;
    let storeCloseFailed = false;
    let executionFailed = false;
    // Short, fixed Judge failure reasons; run records keep only the code.
    const judgeFailureReasons = new Set();
    try {
      progress.start("Preparing evaluations");
      const credentials = Object.fromEntries(
        [...selectedCredentialNames]
          .filter((name) => dependencies.env[name] !== undefined)
          .map((name) => [name, dependencies.env[name]]),
      );
      const judge = authorityNeedsJudge
        ? dependencies.createAnthropicJsonJudge({
            model: runtimeProfile.judge.model,
            apiKey: runtimeSecrets.judgeCredential,
            onFailure: (reason) => judgeFailureReasons.add(reason),
          })
        : null;
      const engine = dependencies.createRunEngine({
        resultStore,
        agentAdapters: [...new Set(
          options.agentSelections.map(({ adapterId }) => adapterId),
        )].map((adapterId) => (
          dependencies.createAgentAdapter(adapterId, dependencies.env)
        )),
        executionEnvironment: runtimeProfile.environment.kind === "together"
          ? dependencies.createTogetherExecutionEnvironment({ apiKey: runtimeSecrets.togetherApiKey, progressObserver })
          : dependencies.createLocalExecutionEnvironment(),
        ...(judge === null ? {} : { judge }),
        progressObserver,
      });
      result = await engine.run({
        runPlan: resolvedPlan.value,
        taskIds: options.taskIds.length > 0 ? options.taskIds : undefined,
        conditionIds: options.conditionIds.length > 0 ? options.conditionIds : undefined,
        agentSelections: options.agentSelections,
        repeat: options.repeat,
        retries: options.retries,
        concurrency: options.concurrency,
        experimentVersion: options.experimentVersion,
        credentials,
        environmentSettings: runtimeProfile.environment.settings,
        signal: abortController.signal,
      });
    } catch {
      executionFailed = true;
    } finally {
      progress.stop();
      dependencies.processTarget.off("SIGINT", onSigint);
      dependencies.processTarget.off("SIGTERM", onSigterm);
      dependencies.processTarget.off("SIGHUP", onSighup);
      if (runtimeProfile.resultStore.kind === "postgres") {
        try {
          await dependencies.closePostgresResultStore(resultStore);
        } catch {
          storeCloseFailed = true;
        }
      }
      disposeAuthoredSuite();
    }
    if (storeCloseFailed) {
      writeError(io,
        "hurdle [store-close-failed] The configured Result Store could not be closed cleanly.\n",
      );
      return 1;
    }
    if (executionFailed) {
      writeError(io, "hurdle [run-failed] Evaluation setup or execution failed; resources were closed.\n");
      return 1;
    }
    if (result.status === "rejected") {
      writeError(io,
        `hurdle [matrix-rejected] ${result.summary.plannedCells} selected cells could not be executed.\n`,
      );
      for (const diagnostic of result.diagnostics.slice(0, 10)) {
        writeError(io, `hurdle [${diagnostic.code}] ${diagnostic.message}\n`);
      }
      return result.diagnostics.every(({ category }) => category === "selection") ? 2 : 1;
    }
    const { summary } = result;
    const counts = summary.terminalVerdicts;
    const authority = summary.authorityCoverage;
    const useColor = runOutputUsesColor(io);
    const issueCount = counts.fail + counts.incomplete + counts.unknown;
    const runCounts = [
      counts.pass > 0 ? `${counts.pass} passed` : null,
      counts.fail > 0 ? `${counts.fail} failed` : null,
      counts.incomplete > 0 ? `${counts.incomplete} incomplete` : null,
      counts.unknown > 0 ? `${counts.unknown} unknown` : null,
    ].filter(Boolean).join(" · ");
    io.stdout.write("\n");
    io.stdout.write(runFact(
      "Result",
      issueCount === 0 ? "Passed" : "Needs attention",
      { color: issueCount === 0 ? "green" : "yellow", useColor },
    ));
    io.stdout.write(runFact("Runs", runCounts, { useColor }));
    const checkTotals = [
      checkCounts.pass > 0 ? `${checkCounts.pass} passed` : null,
      checkCounts.fail > 0 ? `${checkCounts.fail} failed` : null,
      checkCounts.skip > 0 ? `${checkCounts.skip} skipped` : null,
    ].filter(Boolean).join(" · ");
    if (checkTotals) io.stdout.write(runFact("Checks", checkTotals, { useColor }));
    if (summary.retriesPerformed > 0) {
      io.stdout.write(runFact(
        "Retries",
        `${summary.retriesPerformed} ${plural(summary.retriesPerformed, "retry", "retries")}`,
        { useColor },
      ));
    }
    if (authority.judgeRequiredRuns > 0) {
      const judge = `${authority.judgeCompletedRuns}/${authority.judgeRequiredRuns} completed`
        + (authority.disagreements > 0
          ? ` · ${authority.disagreements} ${plural(authority.disagreements, "disagreement")}`
          : "");
      io.stdout.write(runFact("Judge", judge, { useColor }));
      for (const reason of [...judgeFailureReasons].slice(0, 3)) io.stdout.write(runFact("Judge issue", reason, { useColor }));
    }
    for (const run of summary.nonPasses) {
      if (!reportedReasonRunIds.has(run.id)) {
        for (const reason of projectVerdictReasons(run.verdictReasons)) {
          io.stdout.write(runFact("Reason", reason.summary, { useColor }));
        }
      }
    }
    if (summary.omittedNonPasses > 0) {
      io.stdout.write(runFact(
        "More",
        `${summary.omittedNonPasses} additional non-passing ${plural(summary.omittedNonPasses, "run")}`,
        { useColor },
      ));
    }
    io.stdout.write(`${runFact(runtimeProfile.resultStore.kind === "postgres" ? "Artifacts" : "Results", displayResultsPath(runtimeProfile, io.cwd), { useColor })}\n`);
    if (interruptedSignal === "SIGINT") return 130;
    if (interruptedSignal === "SIGTERM") return 143;
    if (interruptedSignal === "SIGHUP") return 129;
    const runExitCode = counts.fail + counts.incomplete + counts.unknown === 0 ? 0 : 1;
    if (!options.viewAfterRun) return runExitCode;
    const runtimeArgument = options.runtime && options.runtime !== projectRuntimePath(io.cwd) ? ` --runtime ${quoteCommandArgument(options.runtime)}` : "";
    const viewerExitCode = await serveResolvedViewer(runtimeProfile, io, dependencies, {
      showHeader: false, suite: options.suite,
      viewCommand: options.explicitTopology.size ? null : `${cliExecutable(io.cwd)} view${runtimeArgument}`,
    });
    return viewerExitCode === 0 ? runExitCode : viewerExitCode;
  }

  if (command === "view") {
    const parsed = parseViewArguments(args, io);
    if (!parsed.ok) return parsed.exitCode;
    let runtimeProfile;
    try {
      runtimeProfile = resolveRuntimeProfile({
        runtimePath: parsed.values.runtime ?? projectRuntimePath(io.cwd) ?? undefined,
        cwd: io.cwd,
      });
      if (parsed.values.store) {
        runtimeProfile = Object.freeze({
          ...runtimeProfile,
          resultStore: Object.freeze({
            kind: "local",
            root: resolve(io.cwd, parsed.values.store),
          }),
        });
      }
      if (parsed.values.port !== null) {
        runtimeProfile = Object.freeze({
          ...runtimeProfile,
          viewer: Object.freeze({ ...runtimeProfile.viewer, port: parsed.values.port }),
        });
      }
    } catch (error) {
      if (!(error instanceof RuntimeProfileError)) throw error;
      writeError(io, `hurdle [${error.code}] ${error.message}\n`);
      return 2;
    }
    const viewCommand = `${cliExecutable(io.cwd)} view`
      + (parsed.values.runtime ? ` --runtime ${quoteCommandArgument(parsed.values.runtime)}` : "")
      + (parsed.values.store ? ` --store ${quoteCommandArgument(parsed.values.store)}` : "");
    return serveResolvedViewer(runtimeProfile, io, dependencies, { storeOverride: Boolean(parsed.values.store), viewCommand });
  }

  return usage(io);
}

export function createFrameworkCli(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("CLI dependencies must be an object");
  }
  const dependencies = Object.freeze({
    ...PRODUCTION_DEPENDENCIES,
    ...overrides,
    executionProgressObserver: normalizeExecutionProgressObserver(
      overrides.executionProgressObserver,
    ),
  });
  return Object.freeze({
    main(argv, io = {
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    }) {
      return runCliMain(argv, io, dependencies);
    },
  });
}

export async function main(argv, io = {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  const versionResult = versionCommand(argv, io);
  if (versionResult !== null) return versionResult;
  // Starters, configuration, discovery and help need no credentials or readable project environment.
  if (!argv.length || ["init", "runtime", "suites", "ls", "help", "--help", "-h"].includes(argv[0]) || hasHelpFlag(argv.slice(1))) {
    return createFrameworkCli({ env: {} }).main(argv, io);
  }
  if (argv[0] === "models") {
    const parsed = parseModelsArguments(argv.slice(1), io);
    if (!parsed.ok) return parsed.exitCode;
  }
  let configured;
  try { configured = loadProjectEnvironment(io.cwd); }
  catch {
    if (argv[0] === "models") return modelsError(io, argv.includes("--json"), "models.environment-unavailable", "Could not read .env.local. Use a readable regular file, then retry.");
    if (argv[0] === "setup") {
      return createSetupOutput(io, { json: argv.includes("--json") }).finish(1, {
        code: "setup.environment-unavailable",
        message: "Could not read .env.local. Use a readable regular file, then rerun setup.",
      });
    }
    writeError(io, "hurdle [environment-unavailable] Could not read .env.local. Use a readable regular file, then retry.\n");
    return 1;
  }
  const { environment, source } = configured;
  return createFrameworkCli({ env: environment, environmentSource: source }).main(argv, io);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Output is best-effort once a terminal or pipe closes; a failed write must
  // not abort cancellation, sandbox cleanup or Result Store settlement.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    writeError({ stderr: process.stderr }, "hurdle [internal-error] An unexpected internal error occurred.\n");
    process.exitCode = 70;
  }
}
