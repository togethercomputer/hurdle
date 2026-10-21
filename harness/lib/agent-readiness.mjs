import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkE2bCredential, checkPostgresCredential, checkTogetherSandboxCredential } from "./credential-preflight.mjs";
import { findHostGuardianRuntime } from "./host-guardian-runtime.mjs";
import { normalizeTogetherSettings } from "./execution-environments/together.mjs";
import { managedImageAgents, managedImageName } from "./managed-images.mjs";
import { listLocalCodexModels } from "./model-discovery.mjs";
import { cliExecutable, suiteCommand } from "./terminal-output.mjs";

const nonblank = value => typeof value === "string" && value.trim().length > 0;
const result = (status, code, message) => ({ status, code, message });
const CLAUDE_RECOVERY = "Set a valid ANTHROPIC_API_KEY in .env.local, or unset it and set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`. Hurdle uses isolated credentials rather than your interactive login.";
const CODEX_RECOVERY = "Set CODEX_ACCESS_TOKEN, CODEX_API_KEY, or OPENAI_API_KEY in .env.local. Hurdle does not inherit your interactive Codex login.";
const AGENT_LABELS = { "claude-code": "Claude Code", codex: "Codex" };

// Probe only the executable, without credentials, project settings, or an Agent
// prompt. Bound both process lifetime and captured output; never display it.
export async function probeAgentCli(command, env) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-readiness-"));
  try {
    return await new Promise(resolve => {
      execFile(command, ["--version"], {
        cwd: root,
        env: { PATH: env.PATH ?? "", HOME: root, ...(process.platform === "win32" ? { SystemRoot: env.SystemRoot } : {}) },
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 16_384,
        windowsHide: true,
      }, error => resolve(!error));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A Hurdle-built image names the Agent CLIs it holds; caller-owned images are
// left to the caller.
function checkManagedImage(environment, adapterIds, setup) {
  const together = environment.kind === "together";
  const provider = together ? "together" : "e2b";
  const image = together ? normalizeTogetherSettings(environment.settings).snapshotAlias : environment.settings?.workloadTemplate;
  const managed = managedImageAgents(image, provider);
  if (!managed) return null;
  const label = `${together ? "Together snapshot" : "E2B template"} ${image}`;
  const agents = [...new Set([...managed.agents, ...adapterIds])];
  const rebuild = `Run \`${setup} --sandbox ${provider}\` to build ${managedImageName(agents, provider, { network: managed.network })}.`;
  const missing = adapterIds.filter(id => !managed.agents.includes(id));
  if (missing.length) {
    return result("fail", "runtime.image-agent-missing", `${label} has no ${missing.map(id => AGENT_LABELS[id]).join(" or ")} CLI. ${rebuild}`);
  }
  if (!managed.current) {
    return result("warning", "runtime.image-outdated", `${label} has older Agent CLIs than this version of Hurdle pins. ${rebuild}`);
  }
  return null;
}

async function checkApiKey(provider, name, key, fetch) {
  const anthropic = provider === "Anthropic";
  const together = provider === "Together";
  const recovery = anthropic ? CLAUDE_RECOVERY : together ? "Set a valid TOGETHER_API_KEY in .env.local; configured values override the shell." : CODEX_RECOVERY;
  try {
    const response = await fetch(anthropic
      ? "https://api.anthropic.com/v1/models?limit=1"
      : together ? "https://api.together.ai/v1/models" : "https://api.openai.com/v1/models", {
      method: "GET",
      headers: anthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    // Provider bodies can contain sensitive data. Status alone is sufficient
    // for this authentication check; do not read, retain, or echo the body.
    await response.body?.cancel();
    if (response.status === 200) {
      return result("pass", "auth.verified", `${provider} · ${name} verified.`);
    }
    if (response.status === 401) {
      return result("fail", "auth.rejected", `${provider} rejected ${name} (HTTP 401). ${recovery}`);
    }
    if (response.status === 403) {
      return result("fail", "auth.forbidden", `${provider} denied the model-list check (HTTP 403); authentication readiness could not be verified. Check the credential's permissions. ${recovery}`);
    }
    return result("fail", "auth.unavailable", `${provider} authentication check failed (HTTP ${response.status}). No evaluation started; try again after checking provider availability.`);
  } catch {
    return result("fail", "auth.unavailable", `${provider} authentication could not be checked within 5 seconds. Check your network and retry; no evaluation started.`);
  }
}

export async function checkAgentReadiness({
  agentSelections, runtimeProfile, runtimeEnv, requiredCredentials = [],
  judgeCredentialName = null,
  allowResultStoreSetup = false,
  allowHostGuardianSetup = false,
  suite = "evals/example.suite.mjs", cwd,
}, {
  fetch = globalThis.fetch, probeCli = probeAgentCli,
  checkE2b = checkE2bCredential, checkPostgres = checkPostgresCredential,
  checkTogetherSandbox = checkTogetherSandboxCredential,
  findHostGuardian = findHostGuardianRuntime,
  listCodexModels = listLocalCodexModels,
} = {}) {
  const checks = [];
  const verified = new Map();
  const verify = async (provider, name, suffix = "") => {
    const key = runtimeEnv[name];
    // Cache within this invocation only. Never persist a credential or its hash.
    const id = `${provider}:${key}`;
    if (verified.has(id)) return;
    const checked = await checkApiKey(provider, name, key, fetch);
    const displayed = { ...checked, message: `${checked.message}${suffix}` };
    verified.set(id, displayed);
    checks.push(displayed);
  };
  for (const adapterId of new Set(agentSelections.map(value => value.adapterId))) {
    const claude = adapterId === "claude-code";
    const label = claude ? "Claude Code" : "Codex";
    if (runtimeProfile.environment.kind === "local") {
      const installed = await probeCli(claude ? "claude" : "codex", runtimeEnv);
      checks.push(result(installed ? "pass" : "fail", "agent.installed", installed
        ? `${label} executable is available.`
        : `${label} executable is missing or could not start. Install ${label} and ensure it is on PATH.`));
      if (!claude && installed) {
        // Codex runs a model missing from its catalog with generic metadata
        // and without tools such as apply_patch. Older CLIs cannot list.
        const models = new Set(agentSelections.filter(value => value.adapterId === adapterId).map(value => value.requestedModel).filter(nonblank));
        const listed = models.size ? await listCodexModels({ env: runtimeEnv }).catch(() => null) : null;
        const unlisted = [...models].filter(model => listed && !listed.includes(model));
        if (unlisted.length) {
          checks.push(result("warning", "agent.model-unlisted", `The installed Codex does not list ${unlisted.join(", ")}, so it runs without that model's metadata and may lack tools such as apply_patch. Update Codex, or pick a model from \`${cliExecutable(cwd)} models --agent codex\`.`));
        }
      }
    } else {
      // A host CLI probe is inapplicable; run observes startup inside the VM.
      checks.push(result("skip", "agent.remote-unverified", `${label} runs inside the ${runtimeProfile.environment.kind === "together" ? "Together" : "E2B"} sandbox; no local CLI installation needed.`));
    }
    const name = (claude
      ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
      : ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"])
      .find(name => nonblank(runtimeEnv[name]));
    if (!name) {
      checks.push(result("fail", "auth.missing", `${label} has no explicit credential. ${claude ? CLAUDE_RECOVERY : CODEX_RECOVERY}`));
      continue;
    }
    const overridden = claude && name === "ANTHROPIC_API_KEY" && nonblank(runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN)
      ? " (takes precedence over CLAUDE_CODE_OAUTH_TOKEN)" : "";
    if (["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"].includes(name)) {
      // These first-party subscription tokens have no supported model-list
      // authentication probe. Presence is not proof of validity or billing.
      checks.push(result("warning", "auth.token-unverified", `${label} · ${name} configured; live validity unverified.`));
    } else {
      await verify(claude ? "Anthropic" : "OpenAI", name, overridden ? ` ${name}${overridden}.` : "");
    }
  }
  if (judgeCredentialName && nonblank(runtimeEnv[judgeCredentialName])) {
    await verify("Anthropic", judgeCredentialName);
  }
  for (const name of requiredCredentials) {
    if (name === "TOGETHER_API_KEY" && nonblank(runtimeEnv[name])) { await verify("Together", name); continue; }
    checks.push(result(nonblank(runtimeEnv[name]) ? "pass" : "fail", "credential.required", nonblank(runtimeEnv[name])
      ? `Required task credential ${name} is configured (provider access is not checked).`
      : `Required task credential ${name} is missing. Set it in .env.local before running.`));
  }
  if (runtimeProfile.environment.kind !== "local") {
    const adapterIds = [...new Set(agentSelections.map(value => value.adapterId))];
    const checked = checkManagedImage(runtimeProfile.environment, adapterIds, suiteCommand("setup", suite, { cwd }));
    if (checked) checks.push(checked);
  }
  if (runtimeProfile.environment.kind === "e2b") {
    const checked = await checkE2b(runtimeEnv[runtimeProfile.environment.apiKeyEnv]);
    checks.push(result(checked.status === "pass" ? "pass" : "fail", "runtime.e2b", `E2B: ${checked.message}.`));
  }
  if (runtimeProfile.environment.kind === "together") {
    const checked = await checkTogetherSandbox(runtimeEnv[runtimeProfile.environment.apiKeyEnv]);
    checks.push(result(checked.status === "pass" ? "pass" : "fail", "runtime.together", `Together sandbox: ${checked.message}.`));
    // Setup installs the Guardian after readiness passes.
    if (!allowHostGuardianSetup) {
      checks.push(findHostGuardian()
        ? result("pass", "runtime.host-guardian", "Egress Guardian installed on this machine.")
        : result("fail", "runtime.host-guardian", `Egress Guardian is not installed on this machine. Run ${suiteCommand("setup", suite, { cwd })} --sandbox together.`));
    }
  }
  if (runtimeProfile.resultStore.kind === "postgres") {
    const checked = await checkPostgres(runtimeEnv[runtimeProfile.resultStore.databaseUrlEnv]);
    const needsSetup = checked.code === "postgres.setup-required";
    const status = needsSetup && allowResultStoreSetup ? "warning" : checked.status === "pass" ? "pass" : "fail";
    checks.push(result(status, needsSetup ? "runtime.postgres-setup-required" : "runtime.postgres", `Postgres: ${checked.message}.`));
  }
  return { ok: checks.every(value => value.status !== "fail"), checks };
}
