import { cliExecutable } from "../lib/terminal-output.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, stripVTControlCharacters } from "node:util";
import test from "node:test";
import pg from "pg";
import { createFrameworkCli, main } from "../bin/hurdle.mjs";
import { createPostgresTestDatabase, postgresTestAdminConnectionString } from "./helpers/postgres-test-database.mjs";
import { PostgresMigrationError } from "../lib/postgres-migration-error.mjs";

const credentialName = "HURDLE_RESULT_STORE_DATABASE_URL";
const secret = "postgresql://example:private-password@example.test/results?sslmode=require";

const sourceExecutable = cliExecutable();

function fixture(t, { config, legacy = false, env = { [credentialName]: secret } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hurdle-postgres-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, legacy ? ".tae/runtime/default.json" : ".hurdle/runtime/default.json");
  if (config) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(config)); }
  let output = "";
  const io = { cwd: root, stdout: { write(text) { output += text; } }, stderr: { write(text) { output += text; } } };
  const calls = [];
  const dependencies = {
    env,
    promptSetup: async () => null,
    loadPostgresSetupBackend: async () => ({
      checkConnection: async value => { calls.push(["connection", value]); },
      migrate: async value => { calls.push(["migrate", value]); },
    }),
    checkAgentReadiness() { assert.fail("Storage setup must not require Agent or sandbox readiness"); },
    ensureHostGuardianRuntime() { assert.fail("Storage setup must not install the Guardian"); },
    createAgentAdapter() { assert.fail("Storage setup must not run an Agent"); },
  };
  return { root, path, io, dependencies, calls, output: () => stripVTControlCharacters(output), runtime: () => JSON.parse(readFileSync(path, "utf8")) };
}

test("Postgres setup needs no Suite or Agent credentials and becomes the discovered default", async t => {
  const f = fixture(t);
  const cli = createFrameworkCli({ ...f.dependencies, launchViewer: async ({ storeEnvironment }) => {
    assert.equal(storeEnvironment.HURDLE_RESULT_STORE_MODE, "postgres");
    assert.equal(storeEnvironment.HURDLE_RESULT_STORE_DATABASE_URL, secret);
    return { kind: "stopped" };
  } });
  assert.equal(await cli.main(["setup", "--store", "postgres"], f.io), 0, f.output());
  assert.deepEqual(f.calls, [["connection", secret], ["migrate", secret]]);
  assert.equal(f.runtime().environment.kind, "local");
  assert.equal(f.runtime().judge, undefined);
  assert.equal(f.runtime().resultStore.databaseUrlEnv, credentialName);
  assert.equal(f.runtime().resultStore.artifactRoot, "../postgres-artifacts");
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.root, ".env.local")), false);
  assert.equal(await cli.main(["view"], f.io), 0, f.output());
  assert.match(f.output(), /✓ Postgres connection verified\./);
  assert.doesNotMatch(f.output(), /private-password|example\.test|\x1b\[/);
});

test("storage setup preserves the Together sandbox, custom settings, and legacy paths without moving local results", async t => {
  const config = {
    schemaVersion: 1,
    environment: { kind: "together", apiKeyEnv: "MY_TOGETHER_KEY", settings: { maxLifetimeMs: 120_000 } },
    resultStore: { kind: "local", root: "../old-results" },
    judge: { kind: "anthropic-json-v1", model: "custom-model", credentialEnv: "MY_JUDGE_KEY" },
    viewer: { port: 3050 },
  };
  const f = fixture(t, { config, legacy: true });
  const results = join(f.root, ".tae/old-results/keep.txt");
  mkdirSync(join(results, ".."), { recursive: true }); writeFileSync(results, "old-results");
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["setup", "--store", "postgres"], f.io), 0, f.output());
  const saved = f.runtime();
  assert.deepEqual(saved.environment, config.environment);
  assert.deepEqual(saved.judge, config.judge);
  assert.deepEqual(saved.viewer, config.viewer);
  assert.equal(existsSync(join(f.root, ".hurdle")), false);
  assert.equal(readFileSync(results, "utf8"), "old-results");
  assert.equal(await cli.main(["setup", "--store", "postgres"], f.io), 0, f.output());
  assert.deepEqual(f.runtime(), saved);
});

test("Postgres setup preserves Together and guides a selected Suite or lists ambiguous choices", async t => {
  const config = { schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: {} }, resultStore: { kind: "local", root: "../results" } };
  for (const json of [false, true]) for (const selected of [true, false]) {
    const f = fixture(t, { config });
    for (const name of ["selected", "another"]) {
      mkdirSync(join(f.root, "evals", name), { recursive: true });
      writeFileSync(join(f.root, "evals", name, "example.suite.mjs"), 'throw Error("Storage must not import Suites");');
    }
    assert.equal(await createFrameworkCli(f.dependencies).main(["setup", ...(selected ? ["selected"] : []), "--store", "postgres", ...(json ? ["--json"] : [])], f.io), 0, f.output());
    assert.deepEqual(f.runtime().environment, config.environment);
    const next = selected ? [`${sourceExecutable} run evals/selected/example.suite.mjs --view`] : [`${sourceExecutable} suites`];
    if (json) assert.deepEqual(JSON.parse(f.output()).nextCommands, next);
    else {
      assert.match(f.output(), /Execution\s+Together sandbox/);
      for (const command of next) assert.ok(f.output().includes(command));
    }
    assert.equal(f.output().includes(`${sourceExecutable} init`), false);
  }
});
test("bare storage setup uses a sole Suite, lists bundled examples, or initializes a fresh folder", async t => {
  for (const scenario of ["sole", "bundled", "empty", "occupied"]) {
    const f = fixture(t);
    if (scenario === "sole" || scenario === "bundled") {
      const directory = scenario === "sole" ? "evals/smoke" : "examples/copy-message";
      mkdirSync(join(f.root, directory), { recursive: true });
      writeFileSync(join(f.root, directory, "example.suite.mjs"), 'throw Error("Storage must not import Suites");');
    }
    if (scenario === "occupied") mkdirSync(join(f.root, "evals/my-eval"), { recursive: true });
    const cli = createFrameworkCli(f.dependencies);
    assert.equal(await cli.main(["setup", "--store", "postgres", "--json"], f.io), 0);
    const next = JSON.parse(f.output()).nextCommands;
    const expected = { sole: `${sourceExecutable} run evals/smoke/example.suite.mjs --view`, bundled: `${sourceExecutable} suites`,
      empty: `${sourceExecutable} init`, occupied: `${sourceExecutable} init evals/my-eval-2` };
    assert.deepEqual(next, [expected[scenario]]);
    if (scenario === "empty" || scenario === "occupied") {
      assert.equal(await cli.main(next[0].split(" ").slice(2), f.io), 0, f.output());
      assert.equal(await cli.main(["validate", "--offline"], f.io), 0, f.output());
    }
  }
});
test("rerunning setup preserves a custom Postgres credential name and artifact root", async t => {
  const config = { schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "postgres", databaseUrlEnv: "CUSTOM_DB_URL", artifactRoot: "../../custom-artifacts" } };
  const f = fixture(t, { config, env: { CUSTOM_DB_URL: secret } });
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres"], f.io), 0, f.output());
  assert.deepEqual(f.runtime(), config);
  assert.deepEqual(f.calls, [["connection", secret], ["migrate", secret]]);
});

test("legacy Postgres credentials and profiles upgrade their default name without changing storage", async t => {
  const legacyName = "TAE_RESULT_STORE_DATABASE_URL";
  const config = { schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "postgres", databaseUrlEnv: legacyName, artifactRoot: "../../existing-artifacts" } };
  for (const environment of [{ [legacyName]: secret }, { [credentialName]: secret }, { [legacyName]: "old-value", [credentialName]: secret }]) {
    const f = fixture(t, { config, legacy: true, env: environment });
    assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres", "--json"], f.io), 0, f.output());
    assert.deepEqual(f.runtime(), { ...config, resultStore: { ...config.resultStore, databaseUrlEnv: credentialName } });
    assert.deepEqual(f.calls, [["connection", secret], ["migrate", secret]]);
    const report = JSON.parse(f.output());
    assert.deepEqual(report.requiredCredentials, [{ label: "Postgres", anyOf: [credentialName] }]);
    assert.doesNotMatch(f.output(), /TAE_RESULT_STORE|private-password|old-value/);
  }
});

test("a blank canonical database credential blocks legacy fallback before any database work", async t => {
  const f = fixture(t, { env: { TAE_RESULT_STORE_DATABASE_URL: secret, [credentialName]: "" } });
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres", "--json"], f.io), 1);
  const report = JSON.parse(f.output());
  assert.equal(report.error.code, "setup.credentials-missing");
  assert.deepEqual(report.missingCredentials, [{ label: "Postgres", anyOf: [credentialName] }]);
  assert.match(report.error.message, /Source\s+environment \(blank value\)/);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(f.path), false);
});

test("legacy credentials from .env.local override the same legacy shell key", async t => {
  const f = fixture(t, { env: { TAE_RESULT_STORE_DATABASE_URL: "old-shell-value" } });
  writeFileSync(join(f.root, ".env.local"), `TAE_RESULT_STORE_DATABASE_URL=${secret}\n`);
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres"], f.io), 0, f.output());
  assert.deepEqual(f.calls, [["connection", secret], ["migrate", secret]]);
  assert.equal(f.runtime().resultStore.databaseUrlEnv, credentialName);
});

test("prompted database URLs remain private, and .env.local overrides shell values", async t => {
  const f = fixture(t);
  f.io.stdin = { isTTY: true }; f.io.stdout.isTTY = true;
  writeFileSync(join(f.root, ".env.local"), `# keep this\nKEEP_ME=yes\n${credentialName}=\n`);
  let prompts = 0;
  const cli = createFrameworkCli({ ...f.dependencies, promptSetup: async options => {
    prompts++; assert.equal(options.secret, true); return secret;
  } });
  assert.equal(await cli.main(["setup", "--store", "postgres", "--interactive"], f.io), 0, f.output());
  assert.equal(prompts, 1);
  const envPath = join(f.root, ".env.local");
  const saved = parseEnv(readFileSync(envPath, "utf8"));
  assert.equal(saved.KEEP_ME, "yes"); assert.equal(saved[credentialName], secret);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.match(readFileSync(join(f.root, ".gitignore"), "utf8"), /\/\.env\.local\n\/\.hurdle\/\n\/\.tae\//);
  assert.doesNotMatch(f.output(), /private-password|example\.test/);
});

test("Postgres setup is noninteractive on a terminal and JSON exposes names without values", async t => {
  const human = fixture(t, { env: {} });
  human.io.stdin = { isTTY: true }; human.io.stdout.isTTY = true;
  let prompts = 0;
  const humanCli = createFrameworkCli({ ...human.dependencies, promptSetup() { prompts++; return secret; } });
  assert.equal(await humanCli.main(["setup", "--store", "postgres"], human.io), 1);
  assert.equal(prompts, 0);
  assert.match(human.output(), /setup.credentials-missing/);
  for (const hasCredential of [false, true]) {
    const f = fixture(t, { env: hasCredential ? { [credentialName]: secret } : {} });
    f.io.stdin = { isTTY: true }; f.io.stdout.isTTY = true; f.io.stderr.isTTY = true;
    const cli = createFrameworkCli({ ...f.dependencies, promptSetup() { assert.fail("Default setup must never prompt"); } });
    assert.equal(await cli.main(["setup", "--store", "postgres", "--json", "--yes"], f.io), hasCredential ? 0 : 1);
    const report = JSON.parse(f.output());
    assert.equal(report.command, "setup");
    assert.equal(report.target, "postgres");
    assert.equal(report.ok, hasCredential);
    assert.deepEqual(report.requiredCredentials, [{ label: "Postgres", anyOf: [credentialName] }]);
    assert.equal(report.missingCredentials.length, hasCredential ? 0 : 1);
    if (hasCredential) assert.equal(report.executionEnvironment, "local");
    else {
      assert.equal(report.error.code, "setup.credentials-missing");
      assert.deepEqual(report.nextCommands, [`${sourceExecutable} setup --store postgres`, `${sourceExecutable} setup --store postgres --interactive`]);
    }
    assert.doesNotMatch(f.output(), /private-password|example\.test/);
  }
});

test("JSON argument errors and database failures have stable codes and never prompt", async t => {
  for (const scenario of ["argument", "flags", "terminal", "connection", "migration"]) {
    const f = fixture(t);
    const cli = createFrameworkCli({ ...f.dependencies, promptSetup() { assert.fail("These invocations must never prompt"); },
      loadPostgresSetupBackend: async () => ({
        checkConnection: async () => { if (scenario === "connection") throw Object.assign(Error(secret), { code: "3D000" }); },
        migrate: async () => { if (scenario === "migration") throw Error(secret); },
      }),
    });
    const args = scenario === "terminal" ? ["setup", "--store", "postgres", "--interactive"]
      : ["setup", "--store", scenario === "argument" ? "invalid" : "postgres", "--json", ...(scenario === "flags" ? ["--interactive"] : [])];
    const exit = await cli.main(args, f.io);
    assert.equal(exit, ["argument", "flags", "terminal"].includes(scenario) ? 2 : 1);
    if (scenario !== "terminal") {
      const report = JSON.parse(f.output());
      assert.equal(report.exitCode, exit);
      assert.equal(report.error.code, scenario === "connection" ? "setup.database-connection" : scenario === "migration" ? "setup.database-migration" : "argument-error");
      if (scenario === "connection") assert.match(report.error.message, /connection failed: the database named in the connection URL does not exist\./);
    }
    assert.doesNotMatch(f.output(), /private-password|example\.test/);
  }
});

test("schema conflicts give safe setup guidance and leave the project Runtime unchanged", async t => {
  const config = { schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "../keep-results" } };
  const f = fixture(t, { config });
  const cli = createFrameworkCli({ ...f.dependencies, loadPostgresSetupBackend: async () => ({
    checkConnection: async () => {},
    migrate: async () => { throw new PostgresMigrationError("migration.schema-conflict", "Both 'tae' and 'hurdle' Postgres schemas exist. Resolve the schema conflict before retrying."); },
  }) });
  assert.equal(await cli.main(["setup", "--store", "postgres", "--json"], f.io), 1);
  const report = JSON.parse(f.output());
  assert.equal(report.error.code, "setup.database-migration");
  assert.match(report.error.message, /Both 'tae' and 'hurdle'.*Resolve the schema conflict/);
  assert.deepEqual(f.runtime(), config);
  assert.doesNotMatch(f.output(), /private-password|example\.test/);
});

test("an unreadable environment file produces a JSON diagnostic before setup starts", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".env.local"));
  assert.equal(await main(["setup", "--store", "postgres", "--json"], f.io), 1);
  assert.equal(JSON.parse(f.output()).error.code, "setup.environment-unavailable");
  assert.equal(existsSync(f.path), false);
});

test("missing, invalid, or cancelled database credentials stop before connecting", async t => {
  for (const scenario of ["missing", "blank", "invalid", "cancelled"]) {
    const f = fixture(t, { env: scenario === "invalid" ? { [credentialName]: "https://example:private-password@example.test" } : {} });
    if (scenario === "blank") writeFileSync(join(f.root, ".env.local"), `${credentialName}=\n`);
    if (scenario === "cancelled") { f.io.stdin = { isTTY: true }; f.io.stdout.isTTY = true; }
    assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres", ...(scenario === "cancelled" ? ["--interactive"] : [])], f.io), 1, f.output());
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(f.path), false);
    assert.doesNotMatch(f.output(), /private-password/);
    assert.match(f.output(), scenario === "cancelled" ? /setup.cancelled/ : scenario === "invalid" ? /setup.database-url/ : /setup.credentials-missing/);
    if (scenario !== "cancelled") assert.match(f.output(), /postgresql:\/\/USER:PASSWORD@HOST:5432\/DATABASE/);
    if (scenario === "blank") assert.match(f.output(), /Source\s+\.env\.local \(blank value\)/);
  }
});

test("connection and migration failures preserve the active runtime and suppress database errors", async t => {
  for (const failedStep of ["connection", "migrate"]) {
    const config = { schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "../results-v1" } };
    const f = fixture(t, { config });
    const cli = createFrameworkCli({ ...f.dependencies, loadPostgresSetupBackend: async () => ({
      checkConnection: async () => { if (failedStep === "connection") throw Error(secret); },
      migrate: async () => { assert.equal(failedStep, "migrate"); throw Error(secret); },
    }) });
    assert.equal(await cli.main(["setup", "--store", "postgres"], f.io), 1);
    assert.deepEqual(f.runtime(), config);
    assert.equal(existsSync(join(f.root, ".env.local")), false);
    assert.doesNotMatch(f.output(), /private-password|example\.test/);
    assert.match(f.output(), /Project Runtime was not changed/);
    if (failedStep === "connection") assert.ok(f.output().includes(`${sourceExecutable} setup --store postgres`));
  }
});

test("Postgres recovery reports the selected file, environment, custom or hidden-input source", async t => {
  const legacy = "TAE_RESULT_STORE_DATABASE_URL";
  const cases = [
    { env: { [credentialName]: "old-shell-value" }, file: { [credentialName]: secret }, source: ".env.local", sourceCheckout: true },
    { env: { [credentialName]: secret }, file: { [legacy]: "unused-file-value" }, source: "environment" },
    { env: { [legacy]: "old-shell-value" }, file: { [legacy]: secret }, source: ".env.local" },
    { env: { CUSTOM_DB_URL: "old-shell-value" }, file: { CUSTOM_DB_URL: secret }, source: ".env.local", name: "CUSTOM_DB_URL" },
    { env: {}, file: {}, source: "hidden terminal input", interactive: true },
    { env: {}, file: {}, source: "hidden terminal input", interactive: true, input: "invalid input" },
  ];
  for (const entry of cases) {
    const name = entry.name ?? credentialName;
    const config = { schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "postgres", databaseUrlEnv: name, artifactRoot: "../keep-artifacts" } };
    const f = fixture(t, { config, env: entry.env });
    writeFileSync(join(f.root, ".env.local"), Object.entries(entry.file).map(([key,value]) => `${key}=${value}\n`).join(""));
    const original = readFileSync(join(f.root, ".env.local"), "utf8");
    if (entry.sourceCheckout) {
      mkdirSync(join(f.root, "harness/bin"), { recursive: true });
      writeFileSync(join(f.root, "harness/bin/hurdle.mjs"), "");
    }
    if (entry.interactive) { f.io.stdin = { isTTY: true }; f.io.stdout.isTTY = true; }
    const cli = createFrameworkCli({ ...f.dependencies, promptSetup: async () => entry.input ?? secret, loadPostgresSetupBackend: async () => ({
      checkConnection(value) { assert.equal(value, secret); throw Error(secret); },
      migrate() { assert.fail("Failed connection must never migrate"); },
    }) });
    assert.equal(await cli.main(["setup", "--store", "postgres", ...(entry.interactive ? ["--interactive"] : ["--json"])], f.io), 1);
    const message = entry.interactive ? f.output() : JSON.parse(f.output()).error.message;
    assert.ok(message.includes(`Source    ${entry.source}`), message);
    assert.ok(message.includes(`${entry.sourceCheckout ? "node harness/bin/hurdle.mjs" : sourceExecutable} setup --store postgres`));
    assert.ok(message.includes(`${name}="postgresql://USER:PASSWORD@HOST:5432/DATABASE"`), message);
    assert.equal(readFileSync(join(f.root, ".env.local"), "utf8"), original);
    assert.deepEqual(f.runtime(), config);
    assert.doesNotMatch(f.output(), /private-password|example\.test|old-shell-value|unused-file-value/);
  }
});

test("symlinked project files and invalid runtimes fail before database changes", async t => {
  for (const name of [".env.local", ".gitignore", ".hurdle/runtime/default.json"]) {
    const f = fixture(t);
    const target = join(f.root, "keep.txt"); writeFileSync(target, "untouched");
    mkdirSync(join(f.root, name, ".."), { recursive: true }); symlinkSync(target, join(f.root, name));
    assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres"], f.io), 1);
    assert.deepEqual(f.calls, []);
    assert.equal(readFileSync(target, "utf8"), "untouched");
  }
  const f = fixture(t, { config: { schemaVersion: 999 } });
  assert.equal(await createFrameworkCli(f.dependencies).main(["setup", "--store", "postgres"], f.io), 1);
  assert.deepEqual(f.calls, []);
});

test("storage help and invalid combinations do not connect or configure a sandbox", async t => {
  const f = fixture(t); const cli = createFrameworkCli(f.dependencies);
  assert.equal(await cli.main(["help", "setup"], f.io), 0);
  assert.match(f.output(), /--store postgres/);
  for (const args of [["--store"], ["--store", "local"], ["--store", "postgres", "--store", "postgres"], ["--store", "postgres", "--sandbox", "together"], ["--store", "postgres", "--template", "custom:v1"]]) {
    assert.equal(await cli.main(["setup", ...args], f.io), 2, f.output());
  }
  assert.deepEqual(f.calls, []);
});

test("real storage setup migrates once, preserves database contents, and validate/run/view discover Postgres", { skip: !postgresTestAdminConnectionString }, async t => {
  const database = await createPostgresTestDatabase();
  const f = fixture(t, { env: { [credentialName]: database.connectionString } });
  const pool = new pg.Pool({ connectionString: database.connectionString });
  t.after(async () => { await pool.end(); await database.cleanup(); });
  await pool.query("CREATE TABLE public.keep_me (value text); INSERT INTO public.keep_me VALUES ('untouched')");
  const { loadPostgresSetupBackend } = await import("../lib/postgres-setup.mjs");
  const cli = createFrameworkCli({ ...f.dependencies, loadPostgresSetupBackend });
  for (let index = 0; index < 2; index++) assert.equal(await cli.main(["setup", "--store", "postgres"], f.io), 0, f.output());
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM hurdle.schema_migrations")).rows[0].count, 2);
  assert.equal((await pool.query("SELECT value FROM public.keep_me")).rows[0].value, "untouched");
  const { initializeSuite } = await import("../lib/starter-suite.mjs");
  assert.equal((await initializeSuite({ destination: join(f.root, "evals") })).ok, true);
  const checked = [];
  const runner = createFrameworkCli({ ...f.dependencies, loadPostgresSetupBackend,
    checkAgentReadiness: async ({ runtimeProfile }) => { checked.push(runtimeProfile); return { ok: true, checks: [] }; },
    createAgentAdapter: () => ({ agentId: "claude-code", adapterId: "claude-code", adapterVersion: "test", capabilities: [], async execute() {} }),
    createRunEngine: options => {
      assert.equal(typeof options.resultStore.listRuns, "function");
      return { run: async () => ({ status: "rejected", summary: { plannedCells: 1 }, diagnostics: [{ code: "test.rejection", category: "selection", message: "No Agent runs in this test." }] }) };
    },
    launchViewer: async ({ storeEnvironment }) => { assert.equal(storeEnvironment.HURDLE_RESULT_STORE_MODE, "postgres"); return { kind: "stopped" }; },
  });
  assert.equal(await runner.main(["validate"], f.io), 0, f.output());
  assert.equal(checked.at(-1).resultStore.kind, "postgres");
  assert.equal(await runner.main(["run"], f.io), 2, f.output());
  assert.equal(await runner.main(["view"], f.io), 0, f.output());
});
