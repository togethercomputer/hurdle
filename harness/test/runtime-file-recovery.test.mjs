import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { judgeCredentialEnvironment, resolveRuntimeProfile } from "../lib/runtime-profile.mjs";
import { cliExecutable } from "../lib/terminal-output.mjs";

const RUNTIME = ".hurdle/runtime/default.json";
const DATABASE_URL = "postgresql://fake:fake@invalid.test/results";
// Runtime environments saved before 0.5.0 that name a removed sandbox.
const E2B_ENVIRONMENT = { kind: "e2b", apiKeyEnv: "E2B_API_KEY", settings: { workloadTemplate: "hurdle-claude-code:v1", cpuCount: 2, memoryMiB: 2048, maxLifetimeMs: 3_600_000 } };
const SNAPSHOT_ENVIRONMENT = { kind: "together", apiKeyEnv: "MY_TOGETHER_KEY", settings: { snapshotAlias: "hurdle-claude-code:v1", cpuCount: 1, memoryMiB: 2048, maxLifetimeMs: 1_800_000 } };
const KEPT = {
  resultStore: { kind: "postgres", databaseUrlEnv: "HURDLE_RESULT_STORE_DATABASE_URL", artifactRoot: "../postgres-artifacts" },
  judge: { kind: "anthropic-json-v1", model: "custom-judge-model", credentialEnv: "MY_JUDGE_KEY" },
  viewer: { port: 3022 },
};
const HURDLE_BIN = fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url));

async function fixture(t, { runtime = null, judge = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hurdle-runtime-file-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal((await initializeSuite({ destination: join(root, "evals") })).ok, true);
  if (judge) {
    // Score with a Judge so setup and the built-in Runtime name a Judge credential.
    const suite = join(root, "evals/example.suite.mjs");
    writeFileSync(suite, readFileSync(suite, "utf8").replace('verdict: "code",', 'verdict: "hybrid",\n  judge: { model: "claude-test-judge" },'));
    const checks = join(root, "evals/tasks/copy-message/checks.mjs");
    writeFileSync(checks, readFileSync(checks, "utf8").replace("run.expect.completed();", 'run.expect.completed();\n  run.judge("Pass only when answer.txt copies the fixture.");'));
  }
  if (runtime !== null) {
    mkdirSync(join(root, ".hurdle/runtime"), { recursive: true });
    writeFileSync(join(root, RUNTIME), runtime);
  }
  let output = "";
  const io = { cwd: root, stdout: { write(value) { output += value; } }, stderr: { write(value) { output += value; } } };
  const dependencies = {
    env: {
      TOGETHER_API_KEY: "test-sandbox-secret", MY_TOGETHER_KEY: "test-sandbox-secret", ANTHROPIC_API_KEY: "test-agent-secret",
      MY_JUDGE_KEY: "test-judge-secret", HURDLE_RESULT_STORE_DATABASE_URL: DATABASE_URL,
    },
    processTarget: new EventEmitter(),
    checkAgentReadiness: async () => ({ ok: true, checks: [] }),
    ensureHostGuardianRuntime: async () => ({}),
    createRunEngine: () => assert.fail("A Runtime that does not load must not start a run"),
    launchViewer: () => assert.fail("A Runtime that does not load must not start the Viewer"),
  };
  return {
    root, io, dependencies,
    output: () => stripVTControlCharacters(output),
    reset: () => { output = ""; },
    raw: () => readFileSync(join(root, RUNTIME), "utf8"),
    runtime: () => JSON.parse(readFileSync(join(root, RUNTIME), "utf8")),
  };
}

test("a Runtime that names a removed sandbox points to setup with the project's own executable", async t => {
  for (const environment of [E2B_ENVIRONMENT, SNAPSHOT_ENVIRONMENT]) {
    const f = await fixture(t, { runtime: JSON.stringify({ schemaVersion: 1, environment, ...KEPT }) });
    const removed = environment.kind === "e2b" ? "the E2B sandbox" : "Together snapshot images";
    const hint = `Runtime file: .hurdle/runtime/default.json. Hurdle 0.5.0 removed ${removed}; run \`${cliExecutable(f.root)} setup\` to switch it to the Together sandbox.`;
    const cli = createFrameworkCli(f.dependencies);
    for (const args of [["validate"], ["run"], ["runtime"], ["view"], ["setup", "--store", "postgres"]]) {
      f.reset();
      assert.notEqual(await cli.main(args, f.io), 0, args.join(" "));
      assert.ok(f.output().includes(hint), `${args.join(" ")}: ${f.output()}`);
    }
    // An npm project sees the npx command.
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "my-evals", bin: { hurdle: HURDLE_BIN } }));
    assert.equal(cliExecutable(f.root), "npx hurdle");
    assert.throws(() => resolveRuntimeProfile({ cwd: f.root, runtimePath: RUNTIME }), { message: /run `npx hurdle setup` to switch it to the Together sandbox\.$/ });
  }
});

test("a Runtime that fails to load for another reason, or that setup does not write, says to fix or remove it", async t => {
  const f = await fixture(t);
  const setup = `${cliExecutable(f.root)} setup`;
  for (const [source, error] of [
    ["{not json", /Runtime Profile contains invalid JSON\./],
    [JSON.stringify({ schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { maxLifetimeMs: 7_200_000 } }, resultStore: { kind: "local", root: "r" } }), /maxLifetimeMs must be an integer from 1000 to 3600000/],
  ]) {
    assert.throws(
      () => resolveRuntimeProfile({ cwd: f.root, runtimePath: RUNTIME }, { readFile: () => source }),
      (thrown) => error.test(thrown.message) && thrown.message.endsWith(` Runtime file: .hurdle/runtime/default.json. Fix it, or remove it and run \`${setup}\`.`),
    );
  }
  // Setup writes only the project Runtime, so a --runtime file is the user's to fix.
  mkdirSync(join(f.root, "config"));
  writeFileSync(join(f.root, "config/custom.json"), JSON.stringify({ schemaVersion: 1, environment: E2B_ENVIRONMENT, ...KEPT }));
  const cli = createFrameworkCli(f.dependencies);
  for (const args of [["validate", "--runtime", "config/custom.json"], ["runtime", "--runtime", "config/custom.json"], ["view", "--runtime", "config/custom.json"]]) {
    f.reset();
    assert.notEqual(await cli.main(args, f.io), 0, args.join(" "));
    assert.match(f.output(), /Runtime file: config\/custom\.json\. Fix or remove it\./, args.join(" "));
    assert.doesNotMatch(f.output(), /run `[^`]*setup`/, args.join(" "));
  }
});

test("setup moves a removed sandbox to the Together sandbox and keeps the Postgres store, Judge and Viewer", async t => {
  for (const [environment, apiKeyEnv, from] of [
    [E2B_ENVIRONMENT, "TOGETHER_API_KEY", "the removed E2B sandbox"],
    [SNAPSHOT_ENVIRONMENT, "MY_TOGETHER_KEY", "a removed Together snapshot image"],
  ]) {
    for (const json of [false, true]) {
      const f = await fixture(t, { runtime: JSON.stringify({ schemaVersion: 1, environment, ...KEPT }) });
      const cli = createFrameworkCli(f.dependencies);
      assert.equal(await cli.main(["setup", ...(json ? ["--json"] : [])], f.io), 0, f.output());
      assert.deepEqual(f.runtime(), {
        schemaVersion: 1,
        environment: { kind: "together", apiKeyEnv, settings: { maxLifetimeMs: 300_000 } },
        ...KEPT,
      });
      const message = `Moved .hurdle/runtime/default.json from ${from} to the Together sandbox; kept its Result Store, Judge and Viewer settings.`;
      if (json) assert.ok(JSON.parse(f.output()).checks.some(check => check.code === "setup.runtime-replaced" && check.message === message), f.output());
      else assert.ok(f.output().includes(message), f.output());
      f.reset();
      assert.equal(await cli.main(["runtime"], f.io), 0, f.output());
      assert.doesNotMatch(f.output(), /test-(sandbox|agent|judge)-secret|fake:fake/);
    }
  }
});

test("setup refuses any other Runtime that fails to load and leaves it unchanged", async t => {
  for (const runtime of [
    "{not json",
    JSON.stringify({ schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { maxLifetimeMs: 7_200_000 } }, ...KEPT }),
    JSON.stringify({ schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { cpuCount: 2 } }, ...KEPT }),
    JSON.stringify({ schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY" }, ...KEPT, resultStore: { kind: "postgres", databaseUrlEnv: "bad name", artifactRoot: "../a" } }),
    JSON.stringify({ schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "r" }, viewr: { port: 3022 } }),
    // A removed sandbox whose other settings are invalid is not rewritten either.
    JSON.stringify({ schemaVersion: 1, environment: E2B_ENVIRONMENT, ...KEPT, viewer: { port: 0 } }),
  ]) {
    const f = await fixture(t, { runtime });
    let readiness = false;
    const cli = createFrameworkCli({ ...f.dependencies, checkAgentReadiness: async () => { readiness = true; return { ok: true, checks: [] }; } });
    assert.equal(await cli.main(["setup", "--json"], f.io), 1, runtime);
    const report = JSON.parse(f.output());
    assert.match(report.error.code, /^runtime\.profile-/, runtime);
    assert.match(report.error.message, /Runtime file: \.hurdle\/runtime\/default\.json\. Fix it, or remove it and run `.*setup`\./, runtime);
    assert.equal(readiness, false, runtime);
    assert.equal(f.raw(), runtime, "setup must leave the file unchanged");
  }
});

test("--environment-settings explains unsupported Together sizing and the 1-hour limit", async t => {
  const f = await fixture(t);
  const cli = createFrameworkCli(f.dependencies);
  for (const [settings, message] of [
    ['{"cpuCount":2}', /--environment-settings: Together cpuCount is not supported: Together sizes its own sandbox\. Remove cpuCount\./],
    ['{"memoryMiB":4096}', /--environment-settings: Together memoryMiB is not supported/],
    ['{"maxLifetimeMs":7200000}', /--environment-settings: Together maxLifetimeMs must be an integer from 1000 to 3600000; Together ends every sandbox after 1 hour\./],
  ]) {
    f.reset();
    assert.equal(await cli.main(["validate", "--environment", "together", "--environment-settings", settings], f.io), 2, settings);
    assert.match(f.output(), message, settings);
  }
});

test("a new Runtime's Judge uses a Claude Code OAuth token only when no Anthropic API key is set", async t => {
  assert.equal(judgeCredentialEnvironment({}), "ANTHROPIC_API_KEY");
  assert.equal(judgeCredentialEnvironment({ ANTHROPIC_API_KEY: "test-key" }), "ANTHROPIC_API_KEY");
  assert.equal(judgeCredentialEnvironment({ ANTHROPIC_API_KEY: "test-key", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }), "ANTHROPIC_API_KEY");
  assert.equal(judgeCredentialEnvironment({ ANTHROPIC_API_KEY: " ", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(judgeCredentialEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }), "CLAUDE_CODE_OAUTH_TOKEN");

  for (const [env, expected] of [
    [{ TOGETHER_API_KEY: "test-sandbox-secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }, "CLAUDE_CODE_OAUTH_TOKEN"],
    [{ TOGETHER_API_KEY: "test-sandbox-secret", ANTHROPIC_API_KEY: "test-agent-secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }, "ANTHROPIC_API_KEY"],
  ]) {
    // Setup names it in a new Runtime.
    const f = await fixture(t, { judge: true });
    let checked;
    const cli = createFrameworkCli({ ...f.dependencies, env, async checkAgentReadiness(input) { checked = input; return { ok: true, checks: [] }; } });
    assert.equal(await cli.main(["setup", "--json"], f.io), 0, f.output());
    assert.equal(f.runtime().judge?.credentialEnv, expected, f.output());
    assert.equal(checked.judgeCredentialName, expected);
    // The built-in Runtime (no saved file) names it too.
    rmSync(join(f.root, ".hurdle"), { recursive: true, force: true });
    f.reset();
    assert.equal(await cli.main(["validate", "--environment", "local"], f.io), 0, f.output());
    assert.equal(checked.runtimeProfile.judge?.credentialEnv, expected);
    assert.equal(checked.judgeCredentialName, expected);
  }
});
