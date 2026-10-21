import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseProjectEnvironment } from "./project-environment.mjs";
import { managedImageAgents, managedImageName, SETUP_AGENT_PACKAGES } from "./managed-images.mjs";
import { normalizeTogetherSettings } from "./execution-environments/together.mjs";
import { ensureHostGuardianRuntime } from "./host-guardian-runtime.mjs";
import {
  resolveRuntimeProfile,
  describeRuntimeJudgeCapability,
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

export async function loadTogetherSetupBackend() {
  const { TogetherSandbox } = await import("together-sandbox");
  const client = (apiKey) =>
    new TogetherSandbox({
      apiKey,
      baseUrl: "https://api.bartender.codesandbox.io",
      retry: { maxAttempts: 1 },
    });
  return {
    async exists(alias, apiKey) {
      try {
        const info = await client(apiKey).snapshots.getByAlias(alias);
        return !(info.retiredAt ?? info.retired_at);
      } catch (error) {
        if (error.status === 404) return false;
        throw setupError(
          "setup.snapshot-access",
          "Could not read the Together snapshot. Check organization access and retry.",
        );
      }
    },
    async build(alias, agents, apiKey) {
      const context = await mkdtemp(join(tmpdir(), "hurdle-together-image-"));
      try {
        await writeFile(
          join(context, "Dockerfile"),
          togetherSandboxDockerfile(agents),
        );
        return await client(apiKey).snapshots.create({
          context,
          alias,
          cacheKey: `hurdle/${agents.slice().sort().join("-")}`,
        });
      } finally {
        await rm(context, { recursive: true, force: true });
      }
    },
  };
}

export async function setupTogetherSandbox(
  { suite, snapshot, yes = false, interactive = false, json = false },
  io,
  dependencies,
) {
  const output = createSetupOutput(io, { json, target: "together" });
  io = output.io;
  const fact = (label, value) =>
    terminalFact(label, value, { useColor: terminalUsesColor(io.stdout) });
  const prompt = dependencies.promptSetup ?? promptSetup;
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
    dependencies.assertRuntimeDependencies({
      environment: { kind: "together" },
    });
    const runtimePath = projectRuntimePath(io.cwd) ?? DEFAULT_PROJECT_RUNTIME;
    const previous = await regularFileContents(resolve(io.cwd, runtimePath));
    if (previous !== null) resolveRuntimeProfile({ cwd: io.cwd, runtimePath });
    const config =
      previous === null
        ? {
            schemaVersion: 1,
            resultStore: { kind: "local", root: "../together-results-v1" },
          }
        : JSON.parse(previous);
    const saved =
      config.environment?.kind === "together"
        ? config.environment.settings?.snapshotAlias
        : null;
    const managed = saved ? managedImageAgents(saved, "together") : null;
    // A Hurdle snapshot must hold every Agent CLI the project runs, and keeps
    // network tools once capture needs them; caller-owned snapshots stay.
    const agents = [...new Set([...(managed?.agents ?? []), ...ids])].sort();
    const alias =
      snapshot ??
      (saved && !managed
        ? saved
        : managedImageName(agents, "together", { network: needsCapture || managed?.network }));
    const settings = normalizeTogetherSettings({
      ...(config.environment?.kind === "together"
        ? config.environment.settings
        : { maxLifetimeMs: needsCapture ? 600_000 : 300_000 }),
      // API capture needs ten minutes, so replace the five-minute artifact
      // default an earlier setup saved; other configured limits stay.
      ...(needsCapture &&
      config.environment?.kind === "together" &&
      config.environment.settings?.maxLifetimeMs === 300_000
        ? { maxLifetimeMs: 600_000 }
        : {}),
      snapshotAlias: alias,
    });
    config.environment = {
      kind: "together",
      apiKeyEnv:
        config.environment?.kind === "together"
          ? config.environment.apiKeyEnv
          : "TOGETHER_API_KEY",
      settings,
    };
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
          credentialEnv: "ANTHROPIC_API_KEY",
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
    const env = { ...dependencies.env };
    const source = await regularFileContents(join(io.cwd, ".env.local"));
    if (source !== null) Object.assign(env, parseProjectEnvironment(source));
    await regularFileContents(join(io.cwd, ".gitignore"));
    const requirements = [
      { label: "Together sandbox", anyOf: [profile.environment.apiKeyEnv] },
      ...ids.map((id) => ({
        label: id === "codex" ? "Codex" : "Claude Code",
        anyOf:
          id === "codex"
            ? ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"]
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
      prompt,
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
        "Resolve the setup errors above and rerun setup --sandbox together. No snapshot build or evaluation started.",
      );
    // Every Together workload sends its egress through this machine.
    io.stdout.write(terminalNote("Installing the egress Guardian on this machine…", io.stdout));
    try {
      await (dependencies.ensureHostGuardianRuntime ?? ensureHostGuardianRuntime)();
    } catch (error) {
      throw setupError(
        "setup.host-guardian",
        error.code === "environment.host-guardian-platform"
          ? `${error.message} Use --sandbox e2b instead.`
          : "The egress Guardian could not be installed on this machine. Check network access to github.com and pypi.org, then rerun setup --sandbox together.",
      );
    }
    output.check("pass", "Egress Guardian installed on this machine.");
    const backend = await (
      dependencies.loadTogetherSetupBackend ?? loadTogetherSetupBackend
    )();
    const available = await backend.exists(
      alias,
      env[profile.environment.apiKeyEnv],
    );
    if (!available && snapshot)
      throw setupError(
        "setup.snapshot-missing",
        "The selected snapshot alias is unavailable. Check --snapshot ALIAS, or omit it to build the Hurdle snapshot.",
      );
    if (!available) {
      io.stdout.write(
        "\n" +
          fact("Snapshot", alias) +
          fact("Build", agents.map(id => id === "claude-code" ? "Claude Code" : "Codex").join(" + ")) +
          "\n",
      );
      if (!yes) {
        if (!interactive)
          throw setupError(
            "setup.build-required",
            "Snapshot build required. Rerun setup --sandbox together --yes to build it, or use --interactive. No snapshot was built and Project Runtime was not changed.",
          );
        const answer = await prompt(
          { message: "  Build this snapshot? [y/N]: " },
          io,
        );
        if (!answer || !["y", "yes"].includes(answer.trim().toLowerCase()))
          throw setupError(
            "setup.build-required",
            "Snapshot build not started.",
          );
      }
      await saveCredentials(io.cwd, entered);
      io.stdout.write(terminalNote("Building Together snapshot…", io.stdout));
      try {
        await backend.build(alias, agents, env[profile.environment.apiKeyEnv]);
      } catch {
        throw setupError(
          "setup.build-failed",
          "Together snapshot build failed. Inspect the builder status and retry; Project Runtime was not changed.",
        );
      }
      output.check("pass", "Together snapshot built.");
    } else {
      await saveCredentials(io.cwd, entered);
      output.check("pass", `Together snapshot available · ${alias}`);
    }
    await atomicWrite(
      resolve(io.cwd, runtimePath),
      `${JSON.stringify(config, null, 2)}\n`,
      0o600,
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
