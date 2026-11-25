import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseProjectEnvironment } from "./project-environment.mjs";
import { SETUP_AGENT_PACKAGES } from "./managed-images.mjs";
import { normalizeTogetherSettings } from "./execution-environments/together.mjs";
import { asset } from "./execution-environments/guardian.mjs";
import { ensureHostGuardianRuntime } from "./host-guardian-runtime.mjs";
import {
  resolveRuntimeProfile,
  describeRuntimeJudgeCapability,
  judgeCredentialEnvironment,
  RuntimeProfileError,
} from "./runtime-profile.mjs";
import { resolveAuthoritySelections } from "./authority-profile.mjs";
import {
  projectRuntimePath,
  DEFAULT_PROJECT_RUNTIME,
} from "./project-paths.mjs";
import { ensureSetupCredentials } from "./setup-credentials.mjs";
import {
  regularFileContents,
  atomicWrite,
  saveCredentials,
} from "./setup-project-files.mjs";
import { createSetupOutput, missingSuiteSetupGuidance } from "./setup-output.mjs";
import { promptSetup } from "./setup-prompts.mjs";
import {
  terminalHeader,
  terminalFact,
  terminalUsesColor,
  terminalNext,
  terminalNote,
  suiteCommand,
  runtimeSummaryRows,
} from "./terminal-output.mjs";

const setupError = (code, message) =>
  Object.assign(new Error(message), { code });
export function togetherSandboxDockerfile(agents) {
  const selected = [...new Set(agents)].sort();
  if (!selected.length || selected.some((id) => !SETUP_AGENT_PACKAGES[id]))
    throw setupError("setup.agent", "This Suite selects an unsupported Agent.");
  return [
    "FROM node:22-bookworm",
    "RUN apt-get update && apt-get install -y python3 iproute2 curl jq git ca-certificates util-linux passwd iptables && rm -rf /var/lib/apt/lists/*",
    `RUN npm install --global ${selected.map((id) => SETUP_AGENT_PACKAGES[id]).join(" ")}`,
    "RUN install -d -o root -g root -m 0755 /home/user",
    "WORKDIR /home/user",
    "",
  ].join("\n");
}

// Together's Hurdle API starts the server inside the sandbox itself, and the
// controller can only write inputs, run task steps and read results over its
// one socket. So the image carries the server and the harness code
// those steps run, laid out as in this repository so their relative imports and
// assets resolve, plus the Agent's pinned Node runtime (which the server's
// WebSocket also uses). Kept under /opt: /tmp may be a fresh tmpfs.
const IMAGE_ROOT = "/opt/hurdle";
export const TOGETHER_SERVER_COMMAND = `node ${IMAGE_ROOT}/harness/bin/hurdle-sandbox-server.mjs`;
export const IMAGE_CONTEXT_FILES = Object.freeze([
  "bin/hurdle-sandbox-server.mjs",
  "lib/authority-profile.mjs",
  "lib/controller-transcript.mjs",
  "lib/run-model.mjs",
  "lib/execution-environments/guardian.mjs",
  "lib/execution-environments/linux-sandbox-operations.mjs",
  "lib/execution-environments/local-workload.mjs",
  "lib/execution-environments/sandbox-server.mjs",
  "lib/execution-environments/sandbox-socket-protocol.mjs",
  "lib/execution-environments/sandbox-task.mjs",
  "lib/execution-environments/together-workload-egress.mjs",
  "lib/execution-environments/yamux.mjs",
  "verify/proxy/agent-node-runtime/package-lock.json",
  "verify/proxy/agent-node-runtime/package.json",
  "verify/proxy/generic_guardian.py",
  "verify/proxy/guardian-node-runtime/package-lock.json",
  "verify/proxy/guardian-node-runtime/package.json",
  "verify/proxy/guardian-requirements.lock",
  "verify/proxy/node_proxy_bootstrap.cjs",
  "verify/proxy/python_proxy_bootstrap.py",
  "verify/proxy/tcp_ws_bridge.cjs",
]);
const HARNESS_ROOT = resolve(import.meta.dirname, "..");

export function togetherImageDockerfile(agents) {
  return [
    togetherSandboxDockerfile(agents).trimEnd(),
    `COPY hurdle/ ${IMAGE_ROOT}/`,
    `RUN cd ${IMAGE_ROOT} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund`,
    "",
  ].join("\n");
}

export async function writeTogetherImageContext(directory, agents) {
  const root = join(directory, "hurdle");
  await mkdir(root, { recursive: true });
  await writeFile(join(directory, "Dockerfile"), togetherImageDockerfile(agents));
  for (const file of IMAGE_CONTEXT_FILES) {
    await mkdir(dirname(join(root, "harness", file)), { recursive: true });
    await copyFile(join(HARNESS_ROOT, file), join(root, "harness", file));
  }
  for (const file of ["package.json", "package-lock.json"])
    await copyFile(asset("agent-node-runtime", file), join(root, file));
}

export async function setupTogetherSandbox(
  { suite, interactive = false, json = false },
  io,
  dependencies,
) {
  const output = createSetupOutput(io, { json, target: "together" });
  io = output.io;
  const fact = (label, value) =>
    terminalFact(label, value, { useColor: terminalUsesColor(io.stdout) });
  let authored;
  io.stdout.write(
    terminalHeader(io.stdout) + fact("Execution", "Together sandbox") + "\n",
  );
  try {
    if (!existsSync(resolve(io.cwd, suite))) {
      const guidance = missingSuiteSetupGuidance(io.cwd, "together", suite);
      output.result.nextCommands = guidance.nextCommands;
      throw setupError("setup.suite-missing", guidance.message);
    }
    authored = await dependencies.resolveV1Suite({
      suitePath: resolve(io.cwd, suite),
    });
    if (!authored.ok)
      throw setupError(
        "setup.suite-invalid",
        "The Suite is invalid. Run hurdle validate --offline to inspect its diagnostics.",
      );
    const ids = [
      ...new Set(
        authored.defaults.agentSelections.map((agent) => agent.adapterId),
      ),
    ].sort();
    const tasks = authored.defaults.taskIds.map(
      (id) => authored.value.definition.tasks[id],
    );
    const needsCapture = tasks.some((task) =>
        task.executionRequirements?.some((requirement) =>
          [
            "environment.trusted-egress-capture",
            "environment.trusted-request-blocking",
          ].includes(requirement),
        ),
      );
    const runtimePath = projectRuntimePath(io.cwd) ?? DEFAULT_PROJECT_RUNTIME;
    const previous = await regularFileContents(resolve(io.cwd, runtimePath));
    // A Runtime saved before 0.5.0 may name E2B or a Together snapshot. Setup
    // replaces only those execution settings and keeps the Result Store,
    // Judge and Viewer, which are checked below; any other load error stops
    // here and leaves the file as it is.
    let removed = null;
    if (previous !== null) {
      try { resolveRuntimeProfile({ cwd: io.cwd, runtimePath }); }
      catch (error) {
        if (!(error instanceof RuntimeProfileError) || !error.removedSandbox) throw error;
        removed = error.removedSandbox;
      }
    }
    const config =
      previous === null
        ? {
            schemaVersion: 1,
            resultStore: { kind: "local", root: "../together-results-v1" },
          }
        : JSON.parse(previous);
    const savedTogether = !removed && config.environment?.kind === "together";
    // Runs use Together's own Hurdle image over its socket; nothing is built.
    const settings = normalizeTogetherSettings({
      ...(savedTogether
        ? config.environment.settings
        : { maxLifetimeMs: needsCapture ? 600_000 : 300_000 }),
      // API capture needs ten minutes, so replace the five-minute artifact
      // default an earlier setup saved; other configured limits stay.
      ...(needsCapture &&
      savedTogether &&
      config.environment.settings?.maxLifetimeMs === 300_000
        ? { maxLifetimeMs: 600_000 }
        : {}),
    });
    config.environment = {
      kind: "together",
      apiKeyEnv:
        config.environment?.kind === "together"
          ? config.environment.apiKeyEnv
          : "TOGETHER_API_KEY",
      settings: { ...settings },
    };
    const env = { ...dependencies.env };
    const source = await regularFileContents(join(io.cwd, ".env.local"));
    if (source !== null) Object.assign(env, parseProjectEnvironment(source));
    if (previous === null) {
      const models = [
        ...new Set(
          authored.value.definition.authorityProfiles
            .filter((profile) => profile.judge.availability === "required")
            .map((profile) => profile.judge.capability.model),
        ),
      ];
      if (models.length === 1)
        config.judge = {
          kind: "anthropic-json-v1",
          model: models[0],
          credentialEnv: judgeCredentialEnvironment(env),
        };
    }
    const profile = resolveRuntimeProfile(
      { cwd: io.cwd, runtimePath },
      { readFile: () => JSON.stringify(config) },
    );
    const authority = resolveAuthoritySelections({
      definition: authored.value.definition,
      selectedTaskIds: authored.defaults.taskIds,
      judgeCapability: describeRuntimeJudgeCapability(profile),
    });
    if (!authority.ok)
      throw setupError(
        "setup.authority",
        authority.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      );
    const judgeRequired = Object.values(authority.value.byTaskId).some(
      (value) => value.judge?.availability === "required",
    );
    const taskCredentials = [
      ...new Set(tasks.flatMap((task) => task.credentialRequirements)),
    ];
    await regularFileContents(join(io.cwd, ".gitignore"));
    const requirements = [
      { label: "Together sandbox", anyOf: [profile.environment.apiKeyEnv] },
      ...ids.map((id) => ({
        label: id === "codex" ? "Codex" : "Claude Code",
        anyOf:
          id === "codex"
            ? ["CODEX_API_KEY", "OPENAI_API_KEY"]
            : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      })),
      ...taskCredentials.map((name) => ({ label: "Task", anyOf: [name] })),
      ...(judgeRequired
        ? [{ label: "Judge", anyOf: [profile.judge.credentialEnv] }]
        : []),
      ...(profile.resultStore.kind === "postgres"
        ? [{ label: "Postgres", anyOf: [profile.resultStore.databaseUrlEnv] }]
        : []),
    ];
    const entered = await ensureSetupCredentials({
      requirements,
      environment: env,
      interactive,
      prompt: dependencies.promptSetup ?? promptSetup,
      io,
      report: output.result,
    });
    const readiness = await dependencies.checkAgentReadiness({
      agentSelections: authored.defaults.agentSelections,
      runtimeProfile: profile,
      runtimeEnv: env,
      requiredCredentials: taskCredentials,
      judgeCredentialName: judgeRequired ? profile.judge.credentialEnv : null,
      allowResultStoreSetup: true,
      allowHostGuardianSetup: true,
      suite,
      cwd: io.cwd,
    });
    for (const check of readiness.checks)
      output.check(check.status, check.message, check.code);
    if (!readiness.ok)
      throw setupError(
        "setup.not-ready",
        "Resolve the setup errors above and rerun setup. No evaluation started.",
      );
    // Every Together workload sends its egress through this machine.
    io.stdout.write(terminalNote("Installing the egress Guardian on this machine…", io.stdout));
    try {
      await (dependencies.ensureHostGuardianRuntime ?? ensureHostGuardianRuntime)();
    } catch (error) {
      throw setupError(
        "setup.host-guardian",
        error.code === "environment.host-guardian-platform"
          ? error.message
          : "The egress Guardian could not be installed on this machine. Check network access to github.com and pypi.org, then rerun setup.",
      );
    }
    output.check("pass", "Egress Guardian installed on this machine.");
    await saveCredentials(io.cwd, entered);
    output.check("pass", "Together's Hurdle image selected; nothing to build.");
    await atomicWrite(
      resolve(io.cwd, runtimePath),
      `${JSON.stringify(config, null, 2)}\n`,
      0o600,
    );
    if (removed)
      output.check(
        "pass",
        `Moved ${runtimePath} from ${removed === "e2b" ? "the removed E2B sandbox" : "a removed Together snapshot image"} to the Together sandbox; kept its Result Store, Judge and Viewer settings.`,
        "setup.runtime-replaced",
      );
    const needsStorageSetup = readiness.checks.some(check => check.code === "runtime.postgres-setup-required");
    const nextCommands = [...(needsStorageSetup ? [`${suiteCommand("setup", suite, { cwd: io.cwd })} --store postgres`] : []), suiteCommand("run", suite, { view: true, cwd: io.cwd })];
    output.check("pass", needsStorageSetup ? "Together sandbox configured." : "Setup complete · Together sandbox configured.");
    io.stdout.write(terminalNote(needsCapture
      ? "All sandbox traffic routes through this machine, which protects credentials and seals request evidence. Keep it online during runs."
      : "All sandbox traffic routes through this machine. Keep it online during runs.", io.stdout));
    io.stdout.write(
      "\n" +
        runtimeSummaryRows(profile, io.cwd).map(([label, value]) => fact(label, value)).join("") +
        terminalNext(nextCommands, io.stdout),
    );
    Object.assign(output.result, {
      runtimePath,
      executionEnvironment: "together",
      resultStore: config.resultStore.kind,
      nextCommands,
    });
    return output.finish(0);
  } catch (error) {
    const known =
      error.code?.startsWith("setup.") ||
      error.code?.startsWith("runtime.") ||
      error.code === "backend-not-installed";
    return output.finish(1, {
      code: known ? error.code : "setup.failed",
      message: known
        ? error.message
        : "Together setup could not complete. Check project files, credentials, and organization access.",
    });
  } finally {
    authored?.dispose();
  }
}
