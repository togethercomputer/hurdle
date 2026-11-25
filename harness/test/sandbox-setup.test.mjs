import { cliExecutable } from "../lib/terminal-output.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { checkAgentReadiness } from "../lib/agent-readiness.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import { evaluateChecks } from "../lib/v1-evaluator-runtime.mjs";
import { promptSetup } from "../lib/setup-prompts.mjs";
import { PassThrough } from "node:stream";

async function fixture(t, example = "copy-message") {
  const root = mkdtempSync(join(tmpdir(), "hurdle-setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal((await initializeSuite({ destination: join(root, "evals"), example })).ok, true);
  let output = "";
  const io = { cwd: root, stdout: { write(v) { output += v; } }, stderr: { write(v) { output += v; } } };
  const calls = [];
  const env = { ANTHROPIC_API_KEY: "test-agent-secret", TOGETHER_API_KEY: "test-target-secret" };
  const dependencies = {
    env,
    processTarget: new EventEmitter(),
    async checkAgentReadiness(input) { calls.push(["readiness", input]); return { ok: true, checks: [{ status: "pass", message: "Credentials verified." }] }; },
    async ensureHostGuardianRuntime() { calls.push(["guardian"]); return {}; },
    createTogetherExecutionEnvironment() { assert.fail("Setup/validation must not allocate execution resources"); },
    async openLocalResultStore() { assert.fail("Setup/validation must not create a Result Store"); },
    promptSetup: async () => null,
  };
  return { root, io, dependencies, calls, output: () => stripVTControlCharacters(output), runtime: () => JSON.parse(readFileSync(join(root, ".hurdle/runtime/default.json"), "utf8")) };
}

const sourceExecutable = cliExecutable();

test("setup saves a default, and validate/view discover it without execution", async t => {
  const f = await fixture(t, "together-api");
  const cli = createFrameworkCli({ ...f.dependencies,
    async launchViewer({ storeEnvironment }) { assert.equal(storeEnvironment.HURDLE_RESULT_STORE_ROOT, join(f.root, ".hurdle/together-results-v1")); return { kind: "stopped" }; },
  });
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes"], f.io), 0, f.output());
  assert.equal(f.calls.filter(([kind]) => kind === "guardian").length, 1);
  const config = f.runtime();
  assert.equal(config.environment.kind, "together");
  assert.equal(config.environment.settings.maxLifetimeMs, 600_000);
  assert.equal(config.judge, undefined);
  assert.equal(existsSync(join(f.root, ".env.local")), false, "Exported credentials must not be copied");
  assert.equal(await cli.main(["validate"], f.io), 0, f.output());
  const checked = f.calls.at(-1)[1];
  assert.equal(checked.runtimeProfile.environment.kind, "together");
  assert.deepEqual(checked.requiredCredentials, ["TOGETHER_API_KEY"]);
  assert.equal(await cli.main(["view"], f.io), 0);
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes"], f.io), 0);
  assert.equal(readFileSync(join(f.root, ".gitignore"), "utf8"), "/.env.local\n/.hurdle/\n/.tae/\n");
  assert.doesNotMatch(f.output(), /test-agent-secret|test-target-secret/);
});

test("setup defaults to the Together sandbox", async t => {
  const f = await fixture(t);
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["setup", "--yes", "--json"], f.io), 0, f.output());
  const report = JSON.parse(f.output());
  assert.equal(report.target, "together");
  assert.equal(report.executionEnvironment, "together");
  assert.ok(report.checks.some(check => check.status === "pass" && check.message === "Setup complete · Together sandbox configured."));
  const config = f.runtime();
  assert.equal(config.environment.kind, "together");
  assert.equal(config.environment.apiKeyEnv, "TOGETHER_API_KEY");
  assert.equal(config.resultStore.root, "../together-results-v1");
});

test("sandbox setup guides pending Postgres migrations and run blocks until explicit storage setup", async t => {
  for (const json of [false, true]) {
    const f = await fixture(t, "together-api");
    const suite = "examples/together-api/example.suite.mjs";
    mkdirSync(join(f.root, "examples"));
    renameSync(join(f.root, "evals"), join(f.root, "examples/together-api"));
    for (const name of ["one", "two"]) {
      mkdirSync(join(f.root, "evals", name), { recursive: true });
      writeFileSync(join(f.root, "evals", name, "example.suite.mjs"), 'throw Error("Must not select another Suite");');
    }
    const environment = { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: {} };
    mkdirSync(join(f.root, ".hurdle/runtime"), { recursive: true });
    writeFileSync(join(f.root, ".hurdle/runtime/default.json"), JSON.stringify({ schemaVersion: 1, environment,
      resultStore: { kind: "postgres", databaseUrlEnv: "DATABASE_URL", artifactRoot: "../artifacts" } }));
    let ready = false, migrations = 0;
    const cli = createFrameworkCli({ ...f.dependencies, env: { ...f.dependencies.env, DATABASE_URL: "postgresql://synthetic:synthetic@invalid.test/results" },
      checkAgentReadiness: input => checkAgentReadiness(input, { fetch: async () => new Response("{}"),
        findHostGuardian: () => ({}),
        checkPostgres: async () => ready ? { status: "pass", message: "schema ready" }
          : { status: "warning", code: "postgres.setup-required", message: "result schema needs upgrading" } }),
      loadPostgresSetupBackend: async () => ({ checkConnection: async () => {}, migrate: async () => { ready = true; migrations++; } }),
      openPostgresResultStore() { assert.fail("Unready storage must block before opening a store"); },
    });
    assert.equal(await cli.main(["setup", suite, "--sandbox", "together", ...(json ? ["--json"] : [])], f.io), 0, f.output());
    const next = [`${sourceExecutable} setup ${suite} --store postgres`, `${sourceExecutable} run ${suite} --view`];
    if (json) assert.deepEqual(JSON.parse(f.output()).nextCommands, next);
    else { assert.doesNotMatch(f.output(), /Setup complete/); assert.ok(f.output().indexOf(next[0]) < f.output().indexOf(next[1])); }
    assert.equal(migrations, 0);
    let blocked = "";
    const io = { cwd: f.root, stdout: { write(v) { blocked += v; } }, stderr: { write(v) { blocked += v; } } };
    assert.equal(await cli.main(["run", suite, "--view"], io), 1, blocked);
    assert.match(blocked, /\[runtime.postgres-setup-required\]/);
    assert.ok(blocked.includes(next[0]));
    assert.doesNotMatch(blocked, /store-unavailable|Plan\s|Ready to run/);
    assert.equal(migrations, 0);
    let storageOutput = "";
    const storageIo = { ...io, stdout: { write(v) { storageOutput += v; } } };
    assert.equal(await cli.main([...next[0].split(" ").slice(2), "--json"], storageIo), 0);
    assert.deepEqual(JSON.parse(storageOutput).nextCommands, [next[1]]);
    assert.equal(migrations, 1);
    blocked = "";
    assert.equal(await cli.main(["validate", suite], io), 0, blocked);
    assert.match(blocked, /Ready to run/);
  }
});
test("setup, validate, and view reuse an existing .tae Runtime and preserve its store", async t => {
  const f = await fixture(t, "together-api");
  const path = join(f.root, ".tae/runtime/default.json");
  const config = { schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { maxLifetimeMs: 120_000 } }, resultStore: { kind: "local", root: "../together-results-v1" }, viewer: { port: 3050 } };
  mkdirSync(join(f.root, ".tae/runtime"), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  const stores = [];
  const cli = createFrameworkCli({ ...f.dependencies,
    async launchViewer({ storeEnvironment }) { stores.push(storeEnvironment.HURDLE_RESULT_STORE_ROOT); return { kind: "stopped" }; },
  });
  assert.equal(await cli.main(["setup", "--sandbox", "together"], f.io), 0, f.output());
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config);
  assert.equal(existsSync(join(f.root, ".hurdle")), false);
  assert.match(f.output(), /Runtime\s+\.tae\/runtime\/default\.json/);
  assert.equal(await cli.main(["validate"], f.io), 0, f.output());
  assert.equal(f.calls.at(-1)[1].runtimeProfile.environment.kind, "together");
  assert.equal(await cli.main(["view"], f.io), 0, f.output());
  assert.deepEqual(stores, [join(f.root, ".tae/together-results-v1")]);
  assert.match(readFileSync(join(f.root, ".gitignore"), "utf8"), /\/\.tae\//);
});

test("setup rejects invalid Runtime limits before provider requests and leaves the file", async t => {
  const f = await fixture(t);
  const config = { schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { maxLifetimeMs: -1 } }, resultStore: { kind: "local", root: "../together-results-v1" } };
  mkdirSync(join(f.root, ".hurdle/runtime"), { recursive: true });
  writeFileSync(join(f.root, ".hurdle/runtime/default.json"), JSON.stringify(config));
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--sandbox", "together"], f.io), 1);
  assert.deepEqual(f.calls, []);
  assert.match(f.output(), /maxLifetimeMs.*integer/);
  assert.deepEqual(f.runtime(), config);
});

test("the API starter's Local runtime is rejected by validate and run before authentication or store creation", async t => {
  const f = await fixture(t, "together-api");
  const cli = createFrameworkCli(f.dependencies);
  for (const command of ["validate", "run"]) assert.equal(await cli.main([command], f.io), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.output(), /runtime.capture-required/);
  assert.equal(existsSync(join(f.root, ".hurdle/results-v1")), false);
});

test("missing or rejected credentials stop before the Guardian is installed", async t => {
  for (const scenario of ["missing", "rejected"]) {
    const f = await fixture(t);
    const deps = { ...f.dependencies };
    if (scenario === "missing") deps.env = {};
    if (scenario === "rejected") deps.checkAgentReadiness = async () => ({ ok: false, checks: [{ status: "fail", message: "Credential rejected." }] });
    assert.equal(await createFrameworkCli(deps).main(["setup", "--sandbox", "together"], f.io), 1, `${scenario}: ${f.output()}`);
    assert.equal(f.calls.some(c => c[0] === "guardian"), false, scenario);
    assert.equal(existsSync(join(f.root, ".hurdle/runtime/default.json")), false, scenario);
  }
});

test("hidden prompted credentials are saved privately without changing existing project values", async t => {
  const f = await fixture(t, "together-api");
  writeFileSync(join(f.root, ".env.local"), "# existing settings\nKEEP_ME=yes\nANTHROPIC_API_KEY=\n");
  const prompts = [];
  f.io.stdin = { isTTY: true };
  f.io.stdout.isTTY = true;
  const cli = createFrameworkCli({ ...f.dependencies, env: {},
    promptSetup: async options => {
      prompts.push(options);
      if (!options.secret) return "";
      const name = options.message.trim().split(" ")[0];
      return `private-${name}`;
    },
  });
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes", "--interactive"], f.io), 0, f.output());
  const path = join(f.root, ".env.local");
  const saved = parseEnv(readFileSync(path, "utf8"));
  assert.equal(saved.KEEP_ME, "yes");
  for (const name of ["ANTHROPIC_API_KEY", "TOGETHER_API_KEY"]) assert.equal(saved[name], `private-${name}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(join(f.root, ".gitignore"), "utf8"), /\/\.env\.local\n\/\.hurdle\//);
  assert.equal(prompts.filter(p => p.secret).length, 2);
  assert.doesNotMatch(f.output(), /private-ANTHROPIC|private-TOGETHER/);
});

test("setup never prompts on a TTY without --interactive and JSON lists all missing credential alternatives", async t => {
  const human = await fixture(t, "together-api");
  human.io.stdin = { isTTY: true }; human.io.stdout.isTTY = true;
  let prompts = 0;
  const humanCli = createFrameworkCli({ ...human.dependencies, env: {}, promptSetup() { prompts++; return "private-value"; } });
  assert.equal(await humanCli.main(["setup", "--sandbox", "together"], human.io), 1);
  assert.equal(prompts, 0);
  assert.match(human.output(), /setup.credentials-missing/);
  assert.match(human.output(), /TOGETHER_API_KEY.*ANTHROPIC_API_KEY/);
  const f = await fixture(t, "together-api");
  f.io.stdin = { isTTY: true }; f.io.stdout.isTTY = true; f.io.stderr.isTTY = true;
  const cli = createFrameworkCli({ ...f.dependencies, env: {}, promptSetup() { assert.fail("Default setup must never prompt"); } });
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--json"], f.io), 1);
  const report = JSON.parse(f.output());
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.error.code, "setup.credentials-missing");
  assert.deepEqual(report.missingCredentials.map(group => group.anyOf), [
    ["TOGETHER_API_KEY"], ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], ["TOGETHER_API_KEY"],
  ]);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(join(f.root, ".env.local")), false);
  assert.equal(existsSync(join(f.root, ".hurdle/runtime/default.json")), false);
});

test("JSON setup emits one result without progress", async t => {
  const g = await fixture(t);
  g.io.stdout.isTTY = true; g.io.stderr.isTTY = true;
  const cli = createFrameworkCli({ ...g.dependencies, promptSetup() { assert.fail("Noninteractive setup must never prompt"); } });
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--json"], g.io), 0);
  const configured = JSON.parse(g.output());
  assert.equal(configured.ok, true);
  assert.equal(configured.executionEnvironment, "together");
  assert.equal(configured.resultStore, "local");
  assert.equal(configured.runtimePath, ".hurdle/runtime/default.json");
  assert.doesNotMatch(g.output(), /test-agent-secret|test-target-secret/);
});

test("JSON reports rejected readiness without raw backend errors", async t => {
  const f = await fixture(t);
  const cli = createFrameworkCli({ ...f.dependencies,
    checkAgentReadiness: async () => ({ ok: false, checks: [{ code: "auth.rejected", status: "fail", message: "Credential rejected. test-agent-secret" }] }),
  });
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--json"], f.io), 1);
  const report = JSON.parse(f.output());
  assert.equal(report.error.code, "setup.not-ready");
  assert.equal(f.calls.some(c => c[0] === "guardian"), false);
});

test("setup refuses credential symlinks and suppresses provider exception details", async t => {
  const f = await fixture(t);
  const target = join(f.root, "secret-target");
  writeFileSync(target, "KEEP=untouched\n");
  symlinkSync(target, join(f.root, ".env.local"));
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--sandbox", "together", "--yes"], f.io), 1);
  assert.equal(readFileSync(target, "utf8"), "KEEP=untouched\n");
  assert.equal(f.calls.length, 0);
  const g = await fixture(t);
  const cli = createFrameworkCli({ ...g.dependencies, checkAgentReadiness: async () => { throw Error("private-response test-agent-secret"); } });
  assert.equal(await cli.main(["setup", "--sandbox", "together"], g.io), 1);
  assert.doesNotMatch(g.output(), /private-response|test-agent-secret/);
});

test("explicit Runtime/topology selections override the saved default and unsupported providers fail early", async t => {
  const f = await fixture(t);
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--sandbox", "together", "--yes"], f.io), 0);
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["validate", "--environment", "local"], f.io), 0);
  assert.equal(f.calls.at(-1)[1].runtimeProfile.environment.kind, "local");
  assert.match(f.output(), /Runtime\s+Command-line configuration\n  Execution\s+Local\n  Store\s+Filesystem/);
  writeFileSync(join(f.root, "local.json"), JSON.stringify({ schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "./local-results" } }));
  assert.equal(await cli.main(["validate", "--runtime", "local.json"], f.io), 0);
  assert.equal(f.calls.at(-1)[1].runtimeProfile.environment.kind, "local");
  assert.match(f.output(), /Runtime\s+local.json\n  Execution\s+Local\n  Store\s+Filesystem/);
  const before = f.calls.length;
  for (const args of [["--sandbox", "e2b"], ["--sandbox"], ["--template", "custom:v1"], ["--snapshot", "custom@v1"], ["--yes", "--yes"]]) assert.equal(await cli.main(["setup", ...args], f.io), 2);
  assert.equal(f.calls.length, before);
});

test("Together credentials are authenticated read-only without inference or provider body disclosure", async () => {
  for (const status of [200, 401]) {
    const checked = await checkAgentReadiness({ agentSelections: [], runtimeProfile: { environment: { kind: "local" }, resultStore: { kind: "local" } }, runtimeEnv: { TOGETHER_API_KEY: "test-target-secret" }, requiredCredentials: ["TOGETHER_API_KEY"] }, { fetch: async (url, options) => {
      assert.equal(url, "https://api.together.ai/v1/models");
      assert.equal(options.method, "GET"); assert.equal(options.body, undefined); assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, "Bearer test-target-secret");
      return { status, body: { cancel() {} }, text() { assert.fail("Provider body must not be read"); } };
    } });
    assert.equal(checked.ok, status === 200);
    assert.equal(checked.checks.length, 1);
    assert.doesNotMatch(JSON.stringify(checked), /test-target-secret/);
  }
});

test("Together starter requires trusted traffic and rejects missing evidence and extra inference attempts", async t => {
  const f = await fixture(t, "together-api");
  const suite = await resolveV1Suite({ suitePath: join(f.root, "evals/example.suite.mjs") });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true);
  const task = suite.value.definition.tasks["together-api"];
  assert.ok(task.executionRequirements.includes("environment.trusted-egress-capture"));
  assert.equal(task.credentialDeliveryOverrides.TOGETHER_API_KEY.kind, "captured-http-header");
  const { default: checks } = await import(join(suite.generatedRoot, "evaluators/together-api-checks.mjs"));
  const completion = { id: "chat-test", choices: [{ message: { content: "It checks agent behavior." } }], usage: { total_tokens: 20 } };
  const artifacts = { "completion.json": JSON.stringify(completion) };
  const request = { method: "POST", host: "api.together.ai", path: "/v1/chat/completions", statusCode: 200, evidenceRef: "request-chat" };
  const input = {
    snapshot: { target: { egress: { relevantHosts: ["api.together.ai"] } } },
    transcript: { jsonl: JSON.stringify({ type: "result", subtype: "success" }), evidenceRef: "transcript" },
    readArtifactText: path => ({ status: "present", text: artifacts[path], evidenceRef: path }),
    egress: [{ status: "captured", provenance: { lifecyclePhase: "execution", trust: "environment-observed" }, requests: [{ ...request, method: "GET", path: "/v1/models" }, request] }],
  };
  assert.ok(evaluateChecks(checks, input).checks.every(c => c.outcome === "pass"));
  assert.equal(evaluateChecks(checks, { ...input, egress: [] }).checks.find(c => c.id === "chat-completion").outcome, "skip");
  const completionOutcome = (...statuses) => evaluateChecks(checks, { ...input, egress: [{ ...input.egress[0], requests: [input.egress[0].requests[0], ...statuses.map(statusCode => ({ ...request, statusCode }))] }] }).checks.find(c => c.id === "one-completion").outcome;
  // One retry is allowed after a timeout (no status) or a 5xx, and only before the success.
  assert.equal(completionOutcome(503, 200), "pass");
  assert.equal(completionOutcome(null, 200), "pass");
  for (const statuses of [[200, 200], [400, 200], [429, 200], [503, 503, 200], [null, null, 200], [200, 503], [503], []]) {
    assert.equal(completionOutcome(...statuses), "fail", `completion statuses ${JSON.stringify(statuses)}`);
  }
  assert.equal(evaluateChecks(checks, { ...input, readArtifactText: () => ({ status: "missing" }) }).checks.find(c => c.id === "completion-shape").outcome, "fail");
  for (const invalid of [{}, { choices: [{ message: { content: "" } }], usage: { total_tokens: 20 } }, { ...completion, usage: { total_tokens: 0 } }]) {
    assert.equal(evaluateChecks(checks, { ...input, readArtifactText: () => ({ status: "present", text: JSON.stringify(invalid) }) }).checks.find(c => c.id === "completion-shape").outcome, "fail");
  }
});

test("secret terminal prompts do not echo input and restore terminal state after Enter or cancellation", async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough();
    input.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let output = "";
    const pending = promptSetup({ message: "Key (hidden): ", secret: true }, { stdin: input, stdout: { isTTY: true, write(v) { output += v; } } });
    input.write("private-prompt-key");
    input.write(cancel ? "\u0003" : "\r");
    assert.equal(await pending, cancel ? null : "private-prompt-key");
    assert.equal(output, "Key (hidden): \n");
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("keypress"), 0);
    input.destroy();
  }
});
