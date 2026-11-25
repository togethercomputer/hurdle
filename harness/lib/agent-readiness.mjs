import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPostgresCredential } from "./credential-preflight.mjs";
import { findHostGuardianRuntime } from "./host-guardian-runtime.mjs";
import { CLAUDE_CODE_JUDGE_MIN_VERSION, isClaudeCodeOauthToken } from "./judges/anthropic-json.mjs";
import { listLocalCodexModels } from "./model-discovery.mjs";
import { cliExecutable, suiteCommand } from "./terminal-output.mjs";

const nonblank = value => typeof value === "string" && value.trim().length > 0;
const result = (status, code, message) => ({ status, code, message });
const CLAUDE_RECOVERY = "Set a valid ANTHROPIC_API_KEY in .env.local, or unset it and set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`. Hurdle uses isolated credentials rather than your interactive login.";
const CODEX_RECOVERY = "Set CODEX_API_KEY or OPENAI_API_KEY in .env.local. Hurdle uses OpenAI API keys only, not ChatGPT access tokens or your interactive Codex login.";

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

// Like probeAgentCli, and also reads the version the executable prints.
export async function probeAgentCliVersion(command, env) {
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
      }, (error, stdout) => resolve(error
        ? { installed: false, version: null }
        : { installed: true, version: /\b(\d+\.\d+\.\d+)\b/.exec(String(stdout))?.[1] ?? null }));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function versionAtLeast(version, minimum) {
  const parts = value => value.split(".").map(Number);
  const [found, required] = [parts(version), parts(minimum)];
  for (let index = 0; index < required.length; index += 1) {
    if ((found[index] ?? 0) !== required[index]) return (found[index] ?? 0) > required[index];
  }
  return true;
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
  fetch = globalThis.fetch, probeCli = probeAgentCli, probeCliVersion = probeAgentCliVersion,
  checkPostgres = checkPostgresCredential,
  findHostGuardian = findHostGuardianRuntime,
  listCodexModels = listLocalCodexModels,
} = {}) {
  const checks = [];
  const verified = new Map();
  // A Judge on a Claude Code OAuth token runs `claude -p` on this machine,
  // whatever the execution environment.
  const oauthJudge = Boolean(judgeCredentialName) && isClaudeCodeOauthToken(runtimeEnv[judgeCredentialName]);
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
      checks.push(result("skip", "agent.remote-unverified", claude && oauthJudge
        ? `${label} runs inside the Together sandbox.`
        : `${label} runs inside the Together sandbox; no local CLI installation needed.`));
    }
    if (!claude && nonblank(runtimeEnv.CODEX_ACCESS_TOKEN)) {
      checks.push(result("warning", "auth.access-token-unsupported", "Codex · CODEX_ACCESS_TOKEN is ignored: Hurdle runs Codex with an OpenAI API key only."));
    }
    const name = (claude
      ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
      : ["CODEX_API_KEY", "OPENAI_API_KEY"])
      .find(name => nonblank(runtimeEnv[name]));
    if (!name) {
      checks.push(result("fail", "auth.missing", `${label} has no explicit credential. ${claude ? CLAUDE_RECOVERY : CODEX_RECOVERY}`));
      continue;
    }
    const overridden = claude && name === "ANTHROPIC_API_KEY" && nonblank(runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN)
      ? " (takes precedence over CLAUDE_CODE_OAUTH_TOKEN)" : "";
    if (name === "CLAUDE_CODE_OAUTH_TOKEN") {
      // This first-party subscription token has no supported model-list
      // authentication probe. Presence is not proof of validity or billing.
      checks.push(result("warning", "auth.token-unverified", `${label} · ${name} configured; live validity unverified.`));
    } else {
      await verify(claude ? "Anthropic" : "OpenAI", name, overridden ? ` ${name}${overridden}.` : "");
    }
  }
  if (judgeCredentialName && nonblank(runtimeEnv[judgeCredentialName])) {
    if (oauthJudge) {
      // Runs only `claude --version` (no network, no credential), so a
      // missing or too-old CLI stops the run before any paid work.
      const { installed, version } = await probeCliVersion("claude", runtimeEnv);
      const runs = `Judge · ${judgeCredentialName} is a Claude Code OAuth token, so the Judge runs Claude Code (claude) on this machine`;
      checks.push(!installed
        ? result("fail", "judge.claude-missing", `${runs}, but claude is missing or could not start. Install Claude Code and ensure it is on PATH, or give the Judge an Anthropic API key.`)
        : !version || !versionAtLeast(version, CLAUDE_CODE_JUDGE_MIN_VERSION)
          ? result("fail", "judge.claude-outdated", `${runs}, which needs Claude Code ${CLAUDE_CODE_JUDGE_MIN_VERSION} or newer; found ${version ?? "a version it could not read"}. Update Claude Code (\`claude update\`), or give the Judge an Anthropic API key.`)
          : result("warning", "auth.token-unverified", `${runs} (Claude Code ${version}); live validity unverified.`));
    } else {
      await verify("Anthropic", judgeCredentialName);
    }
  }
  for (const name of requiredCredentials) {
    if (name === "TOGETHER_API_KEY" && nonblank(runtimeEnv[name])) { await verify("Together", name); continue; }
    checks.push(result(nonblank(runtimeEnv[name]) ? "pass" : "fail", "credential.required", nonblank(runtimeEnv[name])
      ? `Required task credential ${name} is configured (provider access is not checked).`
      : `Required task credential ${name} is missing. Set it in .env.local before running.`));
  }
  if (runtimeProfile.environment.kind === "together") {
    // Never allocate a sandbox here: Together's Hurdle API refuses a bad key
    // when the run connects.
    checks.push(nonblank(runtimeEnv[runtimeProfile.environment.apiKeyEnv])
      ? result("skip", "runtime.together", "Together sandbox: key is checked when the run connects.")
      : result("fail", "runtime.together", "Together sandbox: sandbox API key is missing."));
    // Setup installs the Guardian after readiness passes.
    if (!allowHostGuardianSetup) {
      checks.push(findHostGuardian()
        ? result("pass", "runtime.host-guardian", "Egress Guardian installed on this machine.")
        : result("fail", "runtime.host-guardian", `Egress Guardian is not installed on this machine. Run ${suiteCommand("setup", suite, { cwd })}.`));
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
