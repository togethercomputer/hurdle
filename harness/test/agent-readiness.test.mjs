import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkAgentReadiness, probeAgentCli, probeAgentCliVersion } from "../lib/agent-readiness.mjs";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const profile = { environment: { kind: "local" }, resultStore: { kind: "local" } };
const input = (runtimeEnv, adapterId = "claude-code") => ({
  runtimeProfile: profile, runtimeEnv, agentSelections: [{ adapterId }],
});
const success = () => new Response('{"data":[]}', { status: 200 });

test("invalid Claude key wins over OAuth and yields a safe actionable diagnosis", async () => {
  let probes = 0, bodiesRead = 0;
  const checked = await checkAgentReadiness(input({
    ANTHROPIC_API_KEY: "private-bad-key", CLAUDE_CODE_OAUTH_TOKEN: "private-token",
    ANTHROPIC_BASE_URL: "https://untrusted.example",
  }), {
    probeCli: async command => { assert.equal(command, "claude"); return true; },
    fetch: async (url, options) => {
      probes++;
      assert.equal(url, "https://api.anthropic.com/v1/models?limit=1");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.body, undefined);
      assert.equal(options.headers["x-api-key"], "private-bad-key");
      assert.equal(options.headers.authorization, undefined);
      return { status: 401, body: { cancel() {} }, text() { bodiesRead++; throw Error("private-response"); } };
    },
  });
  assert.equal(checked.ok, false);
  assert.equal(probes, 1);
  assert.equal(bodiesRead, 0);
  const text = JSON.stringify(checked);
  assert.match(text, /takes precedence/);
  assert.match(text, /HTTP 401/);
  assert.match(text, /claude setup-token/);
  assert.doesNotMatch(text, /private-bad-key|private-token|private-response|untrusted/);
});

test("an agent and Judge sharing a key get one authentication check and one status line", async () => {
  let requests = 0;
  const checked = await checkAgentReadiness({
    ...input({ ANTHROPIC_API_KEY: "test-only-key" }),
    judgeCredentialName: "ANTHROPIC_API_KEY",
  }, {
    probeCli: async () => true,
    fetch: async () => { requests++; return success(); },
  });
  assert.equal(checked.ok, true);
  assert.equal(requests, 1);
  assert.equal(checked.checks.filter(value => value.code.startsWith("auth.")).length, 1);
});

test("OpenAI key probes follow the Codex adapter's precedence and never infer", async () => {
  const checked = await checkAgentReadiness(input({ CODEX_API_KEY: "selected", OPENAI_API_KEY: "ignored" }, "codex"), {
    probeCli: async command => command === "codex",
    fetch: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.equal(options.headers.authorization, "Bearer selected");
      return success();
    },
  });
  assert.equal(checked.ok, true);
  assert.match(JSON.stringify(checked), /OpenAI · CODEX_API_KEY verified/);
  assert.equal(checked.checks.filter(value => value.code.startsWith("auth.")).length, 1);
});

test("a Codex ChatGPT access token is ignored, and alone it is no credential", async () => {
  const alone = await checkAgentReadiness(input({ CODEX_ACCESS_TOKEN: "chatgpt-token" }, "codex"), {
    probeCli: async () => true,
    fetch() { assert.fail("A ChatGPT access token must not be probed"); },
  });
  assert.equal(alone.ok, false);
  assert.ok(alone.checks.some(value => value.code === "auth.access-token-unsupported" && value.status === "warning"));
  assert.ok(alone.checks.some(value => value.code === "auth.missing" && /CODEX_API_KEY or OPENAI_API_KEY/.test(value.message)));
  const withKey = await checkAgentReadiness(input({ CODEX_ACCESS_TOKEN: "chatgpt-token", OPENAI_API_KEY: "selected" }, "codex"), {
    probeCli: async () => true,
    fetch: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer selected");
      return success();
    },
  });
  assert.equal(withKey.ok, true);
  assert.match(JSON.stringify(withKey), /OpenAI · OPENAI_API_KEY verified/);
});

test("subscription credentials report presence without claiming live verification", async () => {
  for (const [adapter, name] of [["claude-code", "CLAUDE_CODE_OAUTH_TOKEN"]]) {
    const checked = await checkAgentReadiness(input({ [name]: "configured-token", OPENAI_API_KEY: "ignored" }, adapter), {
      probeCli: async () => true,
      fetch() { throw new Error("Subscription tokens must not be sent to API-key endpoints"); },
    });
    assert.equal(checked.ok, true);
    assert.ok(checked.checks.some(value => value.code === "auth.token-unverified" && value.status === "warning"));
    assert.equal(checked.checks.some(value => value.code === "auth.verified"), false);
  }
});

test("missing executable, isolated authentication, and task credentials are diagnosed", async () => {
  const checked = await checkAgentReadiness({ ...input({}), requiredCredentials: ["TASK_KEY"] }, {
    probeCli: async () => false,
    fetch() { assert.fail("No credential to probe"); },
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.checks.filter(value => value.status === "fail").length, 3);
  assert.match(JSON.stringify(checked), /interactive login/);
});

test("network failures, forbidden checks, and provider errors are not called invalid credentials", async () => {
  for (const status of [403, 429, 500, 302]) {
    const checked = await checkAgentReadiness(input({ ANTHROPIC_API_KEY: "secret" }), {
      probeCli: async () => true,
      fetch: async () => new Response("secret-provider-body", { status }),
    });
    assert.equal(checked.ok, false);
    assert.equal(checked.checks.some(value => value.code === "auth.rejected"), false);
    assert.doesNotMatch(JSON.stringify(checked), /secret-provider-body/);
  }
  let signal;
  const checked = await checkAgentReadiness(input({ ANTHROPIC_API_KEY: "secret" }), {
    probeCli: async () => true,
    fetch: async (_, options) => { signal = options.signal; throw new Error("secret-error"); },
  });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(checked.ok, false);
  assert.match(JSON.stringify(checked), /within 5 seconds/);
  assert.doesNotMatch(JSON.stringify(checked), /secret-error/);
});

test("remote readiness diagnoses account failures and blocks unconfigured stores except during sandbox setup", async () => {
  for (const provider of ["together"]) for (const mode of ["connection", "schema", "sandbox-setup"]) {
    const checked = await checkAgentReadiness({
      ...input({ CLAUDE_CODE_OAUTH_TOKEN: "token", REMOTE_KEY: "sandbox-key", DATABASE_URL: "postgres-secret" }),
      runtimeProfile: { environment: { kind: provider, apiKeyEnv: "REMOTE_KEY" }, resultStore: { kind: "postgres", databaseUrlEnv: "DATABASE_URL" } },
      allowResultStoreSetup: mode === "sandbox-setup",
    }, {
      probeCli() { assert.fail("Local executable does not establish remote readiness"); },
      findHostGuardian: () => ({}),
      checkPostgres: async value => { assert.equal(value, "postgres-secret"); return mode === "connection"
        ? { status: "fail", message: "connection unavailable" }
        : { status: "warning", code: "postgres.setup-required", message: "schema upgrade required" }; },
    });
    assert.equal(checked.ok, mode === "sandbox-setup");
    const store = checked.checks.find(check => check.code.startsWith("runtime.postgres"));
    assert.equal(store.status, mode === "sandbox-setup" ? "warning" : "fail");
    const remote = checked.checks.find(value => value.code === "agent.remote-unverified");
    assert.equal(remote.status, "skip");
    assert.equal(remote.message, "Claude Code runs inside the Together sandbox; no local CLI installation needed.");
    assert.equal(checked.checks.find(value => value.code === "runtime.together").status, "skip");
    assert.doesNotMatch(JSON.stringify(checked), /postgres-secret|availability will be checked/);
  }
});

test("Local Codex readiness warns when the installed CLI does not list the selected model", async () => {
  const listings = [];
  const check = (models, { installed = true, listed = ["gpt-5.5", "gpt-5.4"] } = {}) => checkAgentReadiness({
    runtimeProfile: profile, runtimeEnv: { OPENAI_API_KEY: "key", PATH: "/test-bin" },
    agentSelections: models.map(requestedModel => ({ adapterId: "codex", requestedModel })),
  }, {
    probeCli: async () => installed,
    fetch: async () => success(),
    listCodexModels: async ({ env }) => {
      listings.push(env);
      if (listed instanceof Error) throw listed;
      return listed;
    },
  });

  let checked = await check(["gpt-6.1-sol", "gpt-5.5", "gpt-6.1-sol"]);
  assert.equal(checked.ok, true);
  const warning = checked.checks.find(value => value.code === "agent.model-unlisted");
  assert.equal(warning.status, "warning");
  assert.match(warning.message, /does not list gpt-6\.1-sol, so it runs without that model's metadata/);
  assert.match(warning.message, /models --agent codex/);
  assert.deepEqual(listings, [{ OPENAI_API_KEY: "key", PATH: "/test-bin" }], "one listing per readiness check");

  for (const [models, options] of [
    [["gpt-5.4"], {}],
    [["gpt-6.1-sol"], { listed: new Error("app-server unsupported") }],
    [[null], {}],
    [["gpt-6.1-sol"], { installed: false }],
  ]) {
    listings.length = 0;
    checked = await check(models, options);
    assert.equal(checked.checks.some(value => value.code === "agent.model-unlisted"), false, JSON.stringify(models));
    assert.equal(listings.length, models[0] === null || options.installed === false ? 0 : 1);
  }
});

test("CLI validate and run reject bad authentication before a store, agent, Judge, or Viewer starts", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = () => {
    let text = "";
    return { cwd: root, stdout: { write(v) { text += v; } }, stderr: { write(v) { text += v; } }, read: () => text };
  };
  let effects = 0, checks = 0;
  const forbidden = () => { effects++; throw Error("must not start"); };
  const cli = createFrameworkCli({
    env: { ANTHROPIC_API_KEY: "bad-secret" }, environmentSource: ".env.local", processTarget: new EventEmitter(),
    checkAgentReadiness: async args => {
      checks++;
      return checkAgentReadiness(args, { probeCli: async () => true, fetch: async () => new Response("private", { status: 401 }) });
    },
    openLocalResultStore: forbidden, openPostgresResultStore: forbidden,
    createAgentAdapter: forbidden, createRunEngine: forbidden,
    createAnthropicJsonJudge: forbidden, launchViewer: forbidden,
  });
  assert.equal(await cli.main(["init"], io()), 0);
  for (const command of [["validate"], ["run", "--view"]]) {
    const output = io();
    assert.equal(await cli.main(command, output), 1);
    assert.match(output.read(), /Readiness \(.env.local\)/);
    assert.match(output.read(), /rejected ANTHROPIC_API_KEY/);
    assert.match(output.read(), /No evaluation started/);
    assert.doesNotMatch(output.read(), /bad-secret|private/);
  }
  assert.equal(checks, 2);
  assert.equal(effects, 0);
  assert.equal(existsSync(join(root, ".hurdle/results-v1")), false);
  const offline = io();
  assert.equal(await cli.main(["validate", "--offline"], offline), 0);
  assert.equal(checks, 2);
  assert.match(offline.read(), /Readiness not checked/);
  assert.equal(await cli.main(["run", "--offline"], io()), 2, "Run cannot bypass readiness");
});

test("a real executable version probe receives no credentials and an isolated HOME", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-probe-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "probe");
  const receipt = join(root, "receipt.json");
  writeFileSync(command, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,realHome:fs.realpathSync(process.env.HOME),hasCredential:Boolean(process.env.ANTHROPIC_API_KEY),hasOptions:Boolean(process.env.NODE_OPTIONS)}));\n`);
  chmodSync(command, 0o755);
  assert.equal(await probeAgentCli(command, { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: "private", NODE_OPTIONS: "private-options" }), true);
  const observed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(observed.args, ["--version"]);
  assert.equal(observed.hasCredential, false);
  assert.equal(observed.hasOptions, false);
  assert.notEqual(observed.home, root);
  assert.equal(observed.cwd, observed.realHome);
  assert.equal(existsSync(observed.home), false, "probe workspace is disposed");
  assert.equal(await probeAgentCli("hurdle-no-such-executable", { PATH: "" }), false);
});

test("Claude's actual terminal 401 frame yields a safe operator reason without terminal_reason", () => {
  const decoded = createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: "private" } }).decodeControllerEvidence({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 API key is invalid. private" }) + "\n", exitCode: 1,
  });
  assert.match(decoded.operatorReason, /Claude Code authentication failed/);
  assert.match(decoded.operatorReason, /npx hurdle validate/);
  assert.doesNotMatch(decoded.operatorReason, /private/);
});

test("init --agent codex creates a valid Codex starter and gives the right credential guidance", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-codex-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let text = "";
  const io = { cwd: root, stdout: { write(v) { text += v; } }, stderr: { write(v) { text += v; } } };
  const cli = createFrameworkCli();
  assert.equal(await cli.main(["init", "--agent", "codex"], io), 0);
  assert.match(text, /Agent     Codex/);
  assert.match(text, /Auth      .env.local or shell/);
  let guidance = "";
  await cli.main(["help", "init"], { ...io, stdout: { write(v) { guidance += v; } } });
  assert.match(guidance, /Codex uses CODEX_API_KEY or/);
  assert.doesNotMatch(guidance, /CODEX_ACCESS_TOKEN/);
  const suite = await resolveV1Suite({ suitePath: join(root, "evals/example.suite.mjs") });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true);
  assert.equal(suite.defaults.agentSelections[0].adapterId, "codex");
  assert.equal(await cli.main(["init", "another", "--agent", "unknown"], io), 2);
  assert.equal(existsSync(join(root, "another")), false);
});

test("readiness symbols use run colors and respect NO_COLOR and redirected output", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-readiness-colors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = createFrameworkCli({
    env: {},
    checkAgentReadiness: async () => ({ ok: false, checks: [
      { status: "pass", message: "installed" },
      { status: "warning", message: "unverified" },
      { status: "fail", message: "rejected" },
    ] }),
  });
  let text = "";
  const output = { cwd: root, stdout: { isTTY: true, write(v) { text += v; } }, stderr: { write(v) { text += v; } } };
  assert.equal(await cli.main(["init"], output), 0);
  const original = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    text = "";
    assert.equal(await cli.main(["validate"], output), 1);
    assert.match(text, /\u001b\[32m✓\u001b\[0m installed/);
    assert.match(text, /\u001b\[33m!\u001b\[0m unverified/);
    assert.match(text, /\u001b\[31m✗\u001b\[0m rejected/);
    process.env.NO_COLOR = "1";
    text = "";
    await cli.main(["validate"], output);
    assert.doesNotMatch(text, /\u001b/);
    delete process.env.NO_COLOR;
    output.stdout.isTTY = false;
    output.stderr.isTTY = false;
    text = "";
    await cli.main(["validate"], output);
    assert.doesNotMatch(text, /\u001b/);
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});

test("Together readiness requires the controller-host Guardian except during setup", async () => {
  const dependencies = (installed) => ({
    probeCli() { assert.fail("Remote readiness does not probe a local CLI"); },
    fetch: async () => success(),
    findHostGuardian: () => installed ? {} : null,
  });
  const check = (installed, allowHostGuardianSetup = false) => checkAgentReadiness({
    ...input({ ANTHROPIC_API_KEY: "key", REMOTE_KEY: "key" }),
    runtimeProfile: { environment: { kind: "together", apiKeyEnv: "REMOTE_KEY" }, resultStore: { kind: "local" } },
    allowHostGuardianSetup,
  }, dependencies(installed));
  const missing = await check(false);
  assert.equal(missing.ok, false);
  const guardian = missing.checks.find(({ code }) => code === "runtime.host-guardian");
  assert.equal(guardian.status, "fail");
  assert.match(guardian.message, /Run .*setup/);
  assert.equal((await check(true)).checks.find(({ code }) => code === "runtime.host-guardian").status, "pass");
  assert.equal((await check(false, true)).checks.some(({ code }) => code === "runtime.host-guardian"), false);
});

test("an OAuth Judge needs a recent enough Claude Code on this machine, even when the Agent runs in the Together sandbox", async () => {
  const token = "sk-ant-oat01-test-judge-token";
  const together = { environment: { kind: "together", apiKeyEnv: "REMOTE_KEY" }, resultStore: { kind: "local" } };
  for (const [runtimeProfile, adapterId] of [[together, "claude-code"], [together, "codex"], [profile, "claude-code"], [profile, "codex"]]) {
    for (const [host, ok, code, message] of [
      [{ installed: true, version: "2.1.296" }, true, "auth.token-unverified", /runs Claude Code \(claude\) on this machine \(Claude Code 2\.1\.296\); live validity unverified\./],
      [{ installed: true, version: "2.1.288" }, true, "auth.token-unverified", /\(Claude Code 2\.1\.288\)/],
      [{ installed: true, version: "2.1.287" }, false, "judge.claude-outdated", /needs Claude Code 2\.1\.288 or newer; found 2\.1\.287\. Update Claude Code \(`claude update`\), or give the Judge an Anthropic API key\./],
      [{ installed: true, version: "1.9.999" }, false, "judge.claude-outdated", /found 1\.9\.999/],
      [{ installed: true, version: null }, false, "judge.claude-outdated", /found a version it could not read/],
      [{ installed: false, version: null }, false, "judge.claude-missing", /claude is missing or could not start\. Install Claude Code and ensure it is on PATH, or give the Judge an Anthropic API key\./],
    ]) {
      const versionProbes = [];
      const checked = await checkAgentReadiness({
        runtimeProfile,
        agentSelections: [{ adapterId }],
        runtimeEnv: { ANTHROPIC_API_KEY: "test-agent-key", CODEX_API_KEY: "test-codex-key", REMOTE_KEY: "test-sandbox-key", CLAUDE_CODE_OAUTH_TOKEN: token },
        judgeCredentialName: "CLAUDE_CODE_OAUTH_TOKEN",
      }, {
        probeCli: async () => true,
        probeCliVersion: async command => { versionProbes.push(command); return host; },
        listCodexModels: async () => [],
        findHostGuardian: () => ({}),
        fetch: async (_url, options) => {
          assert.doesNotMatch(JSON.stringify(options.headers), /sk-ant-oat01/, "An OAuth token must never reach an API-key endpoint");
          return success();
        },
      });
      const label = `${runtimeProfile.environment.kind} ${adapterId} ${JSON.stringify(host)}`;
      assert.deepEqual(versionProbes, ["claude"], label);
      const judge = checked.checks.find(check => check.message.startsWith("Judge · CLAUDE_CODE_OAUTH_TOKEN"));
      assert.equal(checked.ok, ok, label);
      assert.equal(judge.code, code, label);
      assert.equal(judge.status, ok ? "warning" : "fail", label);
      assert.match(judge.message, message, label);
      const remote = checked.checks.find(check => check.code === "agent.remote-unverified");
      if (remote && adapterId === "claude-code") assert.equal(remote.message, "Claude Code runs inside the Together sandbox.", label);
      assert.doesNotMatch(JSON.stringify(checked), /sk-ant-oat01-test-judge-token/);
    }
  }
});

test("the host Claude Code version probe reads the version without credentials", async (t) => {
  const bin = mkdtempSync(join(tmpdir(), "hurdle-version-probe-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  for (const [name, script] of [
    ["claude", '#!/bin/sh\n[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 9\necho "2.1.288 (Claude Code)"\n'],
    ["claude-garbled", "#!/bin/sh\necho 'Claude Code dev build'\n"],
    ["claude-broken", "#!/bin/sh\nexit 1\n"],
  ]) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-must-not-pass" };
  assert.deepEqual(await probeAgentCliVersion("claude", env), { installed: true, version: "2.1.288" });
  assert.deepEqual(await probeAgentCliVersion("claude-garbled", env), { installed: true, version: null });
  assert.deepEqual(await probeAgentCliVersion("claude-broken", env), { installed: false, version: null });
  assert.deepEqual(await probeAgentCliVersion("claude-missing", env), { installed: false, version: null });
});

test("an API-key Judge on Together does not probe a local Claude Code", async () => {
  const checked = await checkAgentReadiness({
    runtimeProfile: { environment: { kind: "together", apiKeyEnv: "REMOTE_KEY" }, resultStore: { kind: "local" } },
    agentSelections: [{ adapterId: "claude-code" }],
    runtimeEnv: { ANTHROPIC_API_KEY: "test-agent-key", REMOTE_KEY: "test-sandbox-key", JUDGE_KEY: "test-judge-key" },
    judgeCredentialName: "JUDGE_KEY",
  }, {
    probeCli() { assert.fail("An API-key Judge on Together needs no local CLI"); },
    findHostGuardian: () => ({}),
    fetch: async () => success(),
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.checks.find(check => check.code === "agent.remote-unverified").message, "Claude Code runs inside the Together sandbox; no local CLI installation needed.");
  assert.ok(checked.checks.some(check => check.message === "Anthropic · JUDGE_KEY verified."));
});
