import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseProjectEnvironment } from "./project-environment.mjs";
import { createRuntimeConfig } from "./runtime-init.mjs";
import { resolveRuntimeProfile, describeRuntimeJudgeCapability } from "./runtime-profile.mjs";
import { resolveAuthoritySelections } from "./authority-profile.mjs";
import { createTerminalProgress } from "./terminal-progress.mjs";
import { promptSetup } from "./setup-prompts.mjs";
import { createSetupOutput, missingSuiteSetupGuidance } from "./setup-output.mjs";
import { ensureSetupCredentials } from "./setup-credentials.mjs";
import { regularFileContents, atomicWrite, saveCredentials } from "./setup-project-files.mjs";
import { normalizeE2BSettings } from "./execution-environments/e2b.mjs";
import { DEFAULT_PROJECT_RUNTIME, projectRuntimePath } from "./project-paths.mjs";
import { managedImageAgents, managedImageName, SETUP_AGENT_PACKAGES } from "./managed-images.mjs";
import {
  terminalUsesColor, terminalFact, terminalHeader,
  terminalNote, terminalNext, suiteCommand, runtimeSummaryRows,
} from "./terminal-output.mjs";

export { DEFAULT_PROJECT_RUNTIME, projectRuntimePath } from "./project-paths.mjs";
export { SETUP_AGENT_PACKAGES } from "./managed-images.mjs";
function setupError(code, message) { return Object.assign(new Error(message), { code }); }


export function createSetupTemplate(Template, agents) {
  const packages = [...new Set(agents)].sort().map(id => {
    if (!SETUP_AGENT_PACKAGES[id]) throw setupError("setup.agent", "This Suite selects an unsupported Agent.");
    return SETUP_AGENT_PACKAGES[id];
  });
  return Template().fromImage("node:22-bookworm")
    .runCmd("apt-get update && apt-get install -y python3 iproute2 curl jq git ca-certificates && rm -rf /var/lib/apt/lists/*", { user: "root" })
    .runCmd(`npm install --global ${packages.join(" ")}`, { user: "root" })
    .runCmd(["node --version", "/usr/bin/python3 --version", ...[...new Set(agents)].map(id => id === "codex" ? "codex --version" : "claude --version")].join(" && "), { user: "root" });
}

export async function inspectSetupTemplate(client, name) {
  const [base, requestedTag] = name.split(":");
  const get = (route, path) => client.api.GET(route, { params: { path }, signal: AbortSignal.timeout(20_000) });
  const alias = await get("/templates/aliases/{alias}", { alias: base });
  // The SDK's exists() treats 403 as existence, which does not prove that this
  // account can use the template. Require successful reads instead.
  if (![200, 404].includes(alias.response.status)) throw setupError("setup.template-access", "E2B denied access to the template. Check the selected name and account permissions.");
  const templateID = alias.data?.templateID ?? base;
  const details = await get("/templates/{templateID}", { templateID });
  if (details.response.status === 404) return false;
  if (details.response.status !== 200) throw setupError("setup.template-access", "E2B template details could not be read.");
  const tags = await get("/templates/{templateID}/tags", { templateID });
  if (tags.response.status !== 200 || !Array.isArray(tags.data)) throw setupError("setup.template-access", "E2B template tags could not be read.");
  const tagged = tags.data.find(item => item.tag === (requestedTag ?? "latest"));
  const builds = details.data?.builds ?? [];
  if (requestedTag && !tagged) return false;
  const selected = tagged ? builds.find(build => build.buildID === tagged.buildID)
    : [...builds].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (tagged && !selected) throw setupError("setup.template-details", "The tagged build's details were not returned by E2B. Check the template in your E2B dashboard; setup will not rebuild an existing tag.");
  if (!selected || selected.status === "error") return false;
  if (selected.status !== "ready") throw setupError("setup.template-building", "The E2B template is still building. Wait for it to finish, then rerun setup --sandbox e2b.");
  if (![selected.cpuCount, selected.memoryMB].every(value => Number.isSafeInteger(value) && value > 0)) throw setupError("setup.template-capacity", "E2B returned an unsupported template capacity.");
  return { cpuCount: selected.cpuCount, memoryMB: selected.memoryMB };
}

export async function loadSetupBackend() {
  const { Template, ApiClient, ConnectionConfig } = await import("e2b");
  return {
    exists: (name, apiKey) => inspectSetupTemplate(new ApiClient(new ConnectionConfig({ apiKey, requestTimeoutMs: 20_000 })), name),
    build: (name, agents, apiKey, capacity) => Template.build(createSetupTemplate(Template, agents), name, { apiKey, ...capacity }),
  };
}

export async function setupSandbox({ suite, template, yes = false, interactive = false, json = false }, io, dependencies) {
  const output = createSetupOutput(io, { json, target: "e2b" });
  io = output.io;
  const useColor = terminalUsesColor(io.stdout);
  const fact = (label, value) => terminalFact(label, value, { useColor });
  const line = (status, text, code = null) => output.check(status, text, code);
  const prompt = dependencies.promptSetup ?? promptSetup;
  io.stdout.write(terminalHeader(io.stdout) + fact("Execution", "E2B sandbox") + "\n");
  let authored;
  try {
    if (!existsSync(resolve(io.cwd, suite))) {
      const guidance = missingSuiteSetupGuidance(io.cwd, "e2b", suite);
      output.result.nextCommands = guidance.nextCommands;
      throw setupError("setup.suite-missing", guidance.message);
    }
    authored = await dependencies.resolveV1Suite({ suitePath: resolve(io.cwd, suite) });
    if (!authored.ok) throw setupError("setup.suite-invalid", `The Suite is invalid. Run ${suiteCommand("validate", suite, { cwd: io.cwd })} --offline to inspect its diagnostics.`);
    dependencies.assertRuntimeDependencies({ environment: { kind: "e2b" } });
    const ids = [...new Set(authored.defaults.agentSelections.map(agent => agent.adapterId))].sort();
    const selectedTasks = authored.defaults.taskIds;
    const taskCredentials = [...new Set(selectedTasks.flatMap(id => authored.value.definition.tasks[id].credentialRequirements))];
    const runtimePath = projectRuntimePath(io.cwd) ?? DEFAULT_PROJECT_RUNTIME;
    const runtimeFile = resolve(io.cwd, runtimePath);
    const previous = await regularFileContents(runtimeFile);
    if (previous !== null) resolveRuntimeProfile({ cwd: io.cwd, runtimePath });
    const old = previous === null ? null : JSON.parse(previous);
    const saved = old?.environment.kind === "e2b" ? old.environment.settings?.workloadTemplate : null;
    const managed = saved ? managedImageAgents(saved, "e2b") : null;
    // A Hurdle template must hold every Agent CLI the project runs; keep
    // caller-owned templates as configured.
    const agents = [...new Set([...(managed?.agents ?? []), ...ids])].sort();
    const name = template ?? (saved && !managed ? saved : managedImageName(agents, "e2b"));
    const config = old ?? structuredClone(createRuntimeConfig("e2b", { template: name }));
    if (!old) {
      delete config.judge;
      config.environment.settings.maxLifetimeMs = 300_000;
      const judges = [...new Set(authored.value.definition.authorityProfiles.filter(p => p.judge.availability === "required").map(p => p.judge.capability.model))];
      if (judges.length === 1) config.judge = { kind: "anthropic-json-v1", model: judges[0], credentialEnv: "ANTHROPIC_API_KEY" };
    } else if (old.environment.kind !== "e2b") {
      config.environment = structuredClone(createRuntimeConfig("e2b", { template: name })).environment;
      config.environment.settings.maxLifetimeMs = 300_000;
    }
    config.environment.settings ??= {};
    config.environment.settings.workloadTemplate = name;
    const profile = resolveRuntimeProfile({ runtimePath, cwd: io.cwd }, { readFile: () => JSON.stringify(config) });
    let settings;
    try { settings = normalizeE2BSettings(config.environment.settings); }
    catch { throw setupError("setup.runtime-settings", `E2B Runtime settings are invalid. Check the templates, cpuCount, memoryMiB, and maxLifetimeMs in ${runtimePath} before rerunning setup --sandbox e2b.`); }
    const authority = resolveAuthoritySelections({ definition: authored.value.definition, selectedTaskIds: selectedTasks, judgeCapability: describeRuntimeJudgeCapability(profile) });
    if (!authority.ok) throw setupError("setup.authority", authority.diagnostics.map(d => d.message).join(" "));
    const judgeRequired = Object.values(authority.value.byTaskId).some(a => a.judge?.availability === "required");
    const env = { ...dependencies.env };
    // A project-local blank assignment must not fall back to an exported key.
    const source = await regularFileContents(join(io.cwd, ".env.local"));
    if (source !== null) Object.assign(env, parseProjectEnvironment(source));
    await regularFileContents(join(io.cwd, ".gitignore"));
    const requirements = [
      { label: "E2B", anyOf: [profile.environment.apiKeyEnv] },
      ...ids.map(id => ({ label: id === "codex" ? "Codex" : "Claude Code", anyOf: id === "codex"
        ? ["CODEX_API_KEY", "OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] })),
      ...taskCredentials.map(name => ({ label: "Task", anyOf: [name] })),
      ...(judgeRequired ? [{ label: "Judge", anyOf: [profile.judge.credentialEnv] }] : []),
      ...(profile.resultStore.kind === "postgres" ? [{ label: "Postgres", anyOf: [profile.resultStore.databaseUrlEnv] }] : []),
    ];
    const entered = await ensureSetupCredentials({ requirements, environment: env, interactive, prompt, io, report: output.result });
    const readiness = await dependencies.checkAgentReadiness({ agentSelections: authored.defaults.agentSelections, runtimeProfile: profile, runtimeEnv: env, requiredCredentials: taskCredentials, judgeCredentialName: judgeRequired ? profile.judge.credentialEnv : null, allowResultStoreSetup: true, suite, cwd: io.cwd });
    for (const check of readiness.checks) line(check.status, check.message, check.code ?? null);
    if (!readiness.ok) throw setupError("setup.not-ready", "Resolve the setup errors above and rerun npx hurdle setup --sandbox e2b. No template build or evaluation started.");
    const backend = await (dependencies.loadSetupBackend ?? loadSetupBackend)();
    let available;
    try { available = await backend.exists(name, env[profile.environment.apiKeyEnv]); }
    catch (error) {
      if (error.code?.startsWith("setup.")) throw error;
      throw setupError("setup.template-unavailable", "Could not check the E2B template. Check account access and retry setup --sandbox e2b.");
    }
    if (!available && template) throw setupError("setup.template-missing", "The selected template is not available. Check --template NAME, or omit it to build the Hurdle template.");
    if (available && typeof available === "object") {
      if (!old) {
        config.environment.settings.cpuCount = available.cpuCount;
        config.environment.settings.memoryMiB = available.memoryMB;
      } else if (settings.cpuCount !== available.cpuCount || settings.memoryMiB !== available.memoryMB) {
        throw setupError("setup.template-capacity", `Template capacity does not match the saved Runtime. Update cpuCount and memoryMiB in ${runtimePath}, then rerun setup --sandbox e2b.`);
      }
      try { normalizeE2BSettings(config.environment.settings); }
      catch { throw setupError("setup.template-capacity", "Template capacity is not supported by the E2B Runtime. Choose a template with at least 512 MB of memory."); }
    }
    if (!available) {
      const capacity = { cpuCount: settings.cpuCount, memoryMB: settings.memoryMiB };
      io.stdout.write("\n" + fact("Template", name)
        + fact("Build", `${capacity.cpuCount} CPUs · ${capacity.memoryMB} MB · ${agents.join(" + ")}`)
        + fact("Usage", "Template build may be billed") + "\n");
      if (!yes) {
        if (!interactive) {
          output.result.nextCommands = [`${suiteCommand("setup", suite, { cwd: io.cwd })} --sandbox e2b --yes${json ? " --json" : ""}`];
          throw setupError("setup.build-required", "Template build required. Rerun setup --sandbox e2b --yes to accept E2B build usage, or add --interactive to review it. No template was built and Project Runtime was not changed.");
        }
        const answer = await prompt({ message: "  Build this template? [y/N]: " }, io);
        if (!answer || !["y", "yes"].includes(answer.trim().toLowerCase())) throw setupError("setup.build-required", "Template build not started. Rerun setup --sandbox e2b --interactive to confirm, or use --yes to accept build usage without a prompt.");
      }
      // Verify credential/ignore-file writes before starting a paid build.
      await saveCredentials(io.cwd, entered);
      const progress = io.stderr.isTTY ? createTerminalProgress({ stream: io.stderr }) : null;
      progress?.start("Building E2B template");
      if (!progress) io.stdout.write(terminalNote("Building E2B template…", io.stdout));
      try { await backend.build(name, agents, env[profile.environment.apiKeyEnv], capacity); }
      catch { throw setupError("setup.build-failed", "E2B template build failed. Inspect the build in your E2B dashboard, then rerun setup --sandbox e2b. Project Runtime was not changed."); }
      finally { progress?.stop(); }
      line("pass", "E2B template built.");
    } else line("pass", `E2B template available · ${name}`);
    // Keep existing stores, Judge settings, and user limits when reusing setup.
    if (available) await saveCredentials(io.cwd, entered);
    await atomicWrite(runtimeFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    const needsStorageSetup = readiness.checks.some(check => check.code === "runtime.postgres-setup-required");
    const nextCommands = [...(needsStorageSetup ? [`${suiteCommand("setup", suite, { cwd: io.cwd })} --store postgres`] : []), suiteCommand("run", suite, { view: true, cwd: io.cwd })];
    line("pass", needsStorageSetup ? "E2B sandbox configured." : "Setup complete · E2B sandbox configured.");
    io.stdout.write("\n" + runtimeSummaryRows(profile, io.cwd).map(([label, value]) => fact(label, value)).join("") + fact("Suite", suite)
      + "\n" + terminalNote("Model access, remote tools, and billing are checked during execution.", io.stdout)
      + terminalNext(nextCommands, io.stdout));
    Object.assign(output.result, { runtimePath, executionEnvironment: "e2b", resultStore: config.resultStore.kind,
      nextCommands });
    return output.finish(0);
  } catch (error) {
    const known = error.code?.startsWith("setup.") || error.code?.startsWith("runtime.") || error.code === "backend-not-installed";
    return output.finish(1, { code: known ? error.code : "setup.failed", message: known ? error.message : "Setup could not complete. Check your project files, credentials, and E2B account, then retry." });
  } finally { authored?.dispose(); }
}
