import { cliExecutable } from "../lib/terminal-output.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrameworkCli, main } from "../bin/hurdle.mjs";
import { defaultProjectSuite, discoverProjectSuites, resolveProjectSuite } from "../lib/project-suites.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const sourceExecutable = cliExecutable();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hurdle-project-suites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let stdout = "", stderr = "";
  return {
    root,
    io: { cwd: root, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } },
    stdout: () => stdout, stderr: () => stderr,
    file(path, text = 'throw new Error("Discovery must not execute Suite modules");') {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    },
  };
}

test("Suite discovery lists filenames without imports, credentials, generated files or symlink traversal", async t => {
  const f = fixture(t);
  f.file("evals/sandbox-smoke/example.suite.mjs");
  f.file("examples/together-api/example.suite.mjs");
  for (const directory of ["node_modules", ".git", ".hurdle", ".tae", "dist", "viewer-runtime"]) f.file(`${directory}/hidden.suite.mjs`);
  f.file("outside/linked.suite.mjs");
  symlinkSync(join(f.root, "outside"), join(f.root, "evals", "linked-directory"));
  symlinkSync(join(f.root, "outside/linked.suite.mjs"), join(f.root, "evals", "linked-file.suite.mjs"));
  mkdirSync(join(f.root, ".env.local")); // Read-only discovery must work even with an unreadable environment file.
  assert.equal(await main(["suites", "--json"], f.io), 0);
  const report = JSON.parse(f.stdout());
  assert.deepEqual(report.suites.map(suite => [suite.name, suite.path]), [
    ["sandbox-smoke", "evals/sandbox-smoke/example.suite.mjs"],
    ["together-api", "examples/together-api/example.suite.mjs"],
    ["linked", "outside/linked.suite.mjs"],
  ]);
  assert.equal(report.defaultSuite, null, "multiple project Suites must not be guessed");
  assert.equal(f.stderr(), "");
});

test("Suite discovery skips unreadable directories such as container volumes", { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t);
  f.file("evals/smoke.suite.mjs");
  const volume = join(f.root, "pgdata");
  mkdirSync(volume);
  chmodSync(volume, 0o000);
  try {
    assert.deepEqual(discoverProjectSuites(f.root).map(suite => suite.path), ["evals/smoke.suite.mjs"]);
    assert.deepEqual(resolveProjectSuite(f.root, "smoke"), { path: "evals/smoke.suite.mjs" });
  } finally {
    chmodSync(volume, 0o700);
  }
});

test("default discovery selects a sole authored Suite, preserves conventional defaults and excludes bundled examples", t => {
  const f = fixture(t);
  f.file("examples/copy-message/example.suite.mjs");
  assert.equal(defaultProjectSuite(f.root), "example.suite.mjs");
  f.file("custom-evals/smoke.suite.mjs");
  assert.equal(defaultProjectSuite(f.root), "custom-evals/smoke.suite.mjs");
  f.file("example.suite.mjs");
  assert.equal(defaultProjectSuite(f.root), "example.suite.mjs");
  f.file("evals/example.suite.mjs");
  assert.equal(defaultProjectSuite(f.root), "evals/example.suite.mjs");
});

test("ambiguous short names require explicit paths and never select the first matching Suite", async t => {
  const f = fixture(t);
  f.file("evals/together-api/example.suite.mjs");
  f.file("examples/together-api/example.suite.mjs");
  const result = resolveProjectSuite(f.root, "together-api");
  assert.equal(result.path, null);
  assert.equal(result.matches.length, 2);
  assert.ok(discoverProjectSuites(f.root).every(suite => suite.ambiguous));
  const cli = createFrameworkCli({ resolveV1Suite() { assert.fail("An ambiguous name must not load a Suite"); } });
  assert.equal(await cli.main(["run", "together-api"], f.io), 2);
  assert.match(f.stderr(), /ambiguous/);
  assert.match(f.stderr(), /evals\/together-api\/example\.suite\.mjs/);
  assert.match(f.stderr(), /examples\/together-api\/example\.suite\.mjs/);
  assert.deepEqual(resolveProjectSuite(f.root, "examples/together-api/example.suite.mjs"), { path: "examples/together-api/example.suite.mjs" });
  assert.equal(existsSync(join(f.root, ".hurdle")), false);
});

test("setup, validate and run resolve the same short name and a sole Suite remains the default", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, "evals"));
  assert.equal((await initializeSuite({ destination: join(f.root, "evals/sandbox-smoke") })).ok, true);
  const paths = [];
  const cli = createFrameworkCli({
    env: {}, processTarget: new EventEmitter(),
    async resolveV1Suite(options) { paths.push(options.suitePath); return resolveV1Suite(options); },
    async checkAgentReadiness() { return { ok: false, checks: [{ status: "fail", message: "No test Agent credentials." }] }; },
    loadSetupBackend() { assert.fail("No provider requests allowed"); },
    loadTogetherSetupBackend() { assert.fail("No provider requests allowed"); },
    openLocalResultStore() { assert.fail("No execution allowed"); },
  });
  assert.equal(await cli.main(["validate", "sandbox-smoke", "--offline"], f.io), 0, f.stderr());
  assert.equal(await cli.main(["validate", "--offline"], f.io), 0, f.stderr());
  assert.equal(await cli.main(["setup", "sandbox-smoke", "--sandbox", "together"], f.io), 1);
  assert.equal(await cli.main(["run", "sandbox-smoke"], f.io), 1);
  assert.deepEqual(paths, Array(4).fill(join(f.root, "evals/sandbox-smoke/example.suite.mjs")));
});

test("run and validate without a default explain Suite selection without importing any Suite or starting work", async t => {
  for (const command of ["run", "validate"]) {
    for (const ambiguous of [false, true]) {
      const f = fixture(t);
      f.file("evals/my eval/example.suite.mjs");
      f.file(ambiguous ? "other/my eval/example.suite.mjs" : "other/second.suite.mjs");
      const forbidden = () => assert.fail("Selection guidance must not import Suites or start an evaluation");
      const cli = createFrameworkCli({ resolveV1Suite: forbidden, checkAgentReadiness: forbidden, openLocalResultStore: forbidden, createRunEngine: forbidden });
      assert.equal(await cli.main([command, command === "run" ? "--view" : "--offline"], f.io), 1);
      assert.match(f.stderr(), /\[suite.selection-required\] No default Suite found\. Choose a Suite by name or path\./);
      const selection = ambiguous ? "evals/my eval/example.suite.mjs" : "my eval";
      assert.ok(f.stderr().includes(`  Example   ${sourceExecutable} ${command} '${selection}'${command === "run" ? " --view" : ""}\n`));
      assert.ok(f.stderr().endsWith(`\n  Next      ${sourceExecutable} suites\n\n`));
      assert.doesNotMatch(f.stderr(), /suite.file-invalid/);
      assert.equal(f.stdout(), "");
      assert.equal(existsSync(join(f.root, ".hurdle")), false);
    }
  }
});

test("an empty project gets an init action using an unused destination even when evals already exists", async t => {
  for (const command of ["run", "validate"]) {
    for (const occupied of [false, true]) {
      const f = fixture(t);
      if (occupied) f.file("evals/my-eval/keep.txt", "User-owned content");
      const cli = createFrameworkCli({ resolveV1Suite() { assert.fail("An empty project must not try the fallback Suite file"); } });
      assert.equal(await cli.main([command], f.io), 1);
      assert.match(f.stderr(), /\[suite.missing\] No Suites found in this project\. Create an evaluation first\./);
      const destination = occupied ? "evals/my-eval-2" : "evals";
      assert.ok(f.stderr().endsWith(`\n  Next      ${sourceExecutable} init${occupied ? ` ${destination}` : ""}\n\n`));
      assert.equal(f.stdout(), "");
      assert.equal(existsSync(join(f.root, destination)), false, "Guidance must not create files");
      assert.equal(await cli.main(["init", destination], f.io), 0, "The suggested init destination must work");
      assert.equal(existsSync(join(f.root, destination, "example.suite.mjs")), true);
    }
  }
});

test("an explicit missing Suite keeps its file diagnostic and offers discovery while definition errors remain specific", async t => {
  for (const command of ["run", "validate"]) {
    const f = fixture(t);
    f.file("evals/known/example.suite.mjs");
    const cli = createFrameworkCli({ checkAgentReadiness() { assert.fail("An unreadable Suite must not check providers"); } });
    assert.equal(await cli.main([command, "missing.suite.mjs"], f.io), 1);
    assert.match(f.stderr(), /missing\.suite\.mjs \[suite.file-invalid\] Could not read the Suite file\. Check the path and file permissions\./);
    assert.ok(f.stderr().includes(`  Example   ${sourceExecutable} ${command} known${command === "run" ? " --view" : ""}\n`));
    assert.ok(f.stderr().endsWith(`\n  Next      ${sourceExecutable} suites\n\n`));
    assert.equal(f.stdout(), "");
  }
  const f = fixture(t);
  f.file("example.suite.mjs", 'import { defineSuite } from "hurdle"; throw new Error("Invalid Suite module");');
  assert.equal(await createFrameworkCli().main(["validate", "--offline"], f.io), 1);
  assert.match(f.stderr(), /suite.module-invalid/);
  assert.doesNotMatch(f.stderr(), /suite.selection-required|\n  Next/);
});

test("setup typo guidance preserves the requested sandbox, uses the existing Suite and separates Postgres", async t => {
  for (const json of [false, true]) {
    const f = fixture(t);
    f.file("evals/sandbox-smoke/example.suite.mjs");
    f.file("harness/bin/hurdle.mjs", "");
    const cli = createFrameworkCli({
      resolveV1Suite() { assert.fail("Invalid arguments must not import a Suite"); },
      loadPostgresSetupBackend() { assert.fail("Invalid arguments must not touch Postgres"); },
    });
    assert.equal(await cli.main(["setup", "---store", "postgres", "--sandbox", "together", ...(json ? ["--json"] : [])], f.io), 2);
    const commands = [
      "node harness/bin/hurdle.mjs setup sandbox-smoke",
      "node harness/bin/hurdle.mjs setup --store postgres",
    ];
    if (json) {
      const report = JSON.parse(f.stdout());
      assert.equal(report.error.code, "argument-error");
      assert.match(report.error.message, /'--store' with two dashes/);
      assert.deepEqual(report.nextCommands, commands);
      assert.equal(f.stderr(), "");
    } else {
      assert.match(f.stderr(), /Unknown setup option '---store'/);
      assert.match(f.stderr(), /separate commands/);
      assert.ok(f.stderr().includes(`\n\nSeparate setup steps (sandbox, then storage):\n  ${commands.join("\n  ")}`));
      assert.equal(f.stdout(), "");
    }
    assert.equal(existsSync(join(f.root, ".hurdle")), false);
  }
});

test("setup reports missing values, duplicates and incompatible options before any setup work", async t => {
  for (const [args, message] of [
    [["--sandbox"], /'--sandbox' requires a value/],
    [["--sandbox", "--yes"], /'--sandbox' requires a value/],
    [["--sandbox", "together", "--sandbox", "together"], /'--sandbox' may only be supplied once/],
    [["--yes", "--yes"], /'--yes' may only be supplied once/],
    [["--store", "postgres", "--sandbox", "together"], /cannot be combined with sandbox options/],
  ]) {
    const f = fixture(t);
    const cli = createFrameworkCli({ resolveV1Suite() { assert.fail("No Suite execution allowed"); }, loadPostgresSetupBackend() { assert.fail("No storage calls allowed"); } });
    assert.equal(await cli.main(["setup", ...args, "--json"], f.io), 2);
    const report = JSON.parse(f.stdout());
    assert.match(report.error.message, message);
    assert.equal(report.nextCommands.length, 2);
    assert.equal(f.stderr(), "");
  }
});

test("a Suite named together does not change the default sandbox in setup recovery commands", async t => {
  const f = fixture(t);
  f.file("evals/together/example.suite.mjs");
  assert.equal(await createFrameworkCli().main(["setup", "together", "--unknown", "--json"], f.io), 2);
  const report = JSON.parse(f.stdout());
  assert.equal(report.nextCommands[0], `${sourceExecutable} setup together`);
  assert.equal(f.stderr(), "");
});

test("help shows project-specific examples without credentials and safely quotes Suite names", async t => {
  const f = fixture(t);
  f.file("my evals/smoke test/example.suite.mjs");
  mkdirSync(join(f.root, ".env.local"));
  assert.equal(await main(["help", "setup"], f.io), 0);
  assert.doesNotMatch(f.stdout(), /Available Suites/);
  assert.ok(f.stdout().includes(`${sourceExecutable} setup 'smoke test'`));
  assert.match(f.stdout(), /setup 'smoke test' +# Together sandbox/);
  assert.ok(f.stdout().includes(`${sourceExecutable} setup --store postgres`));
  assert.ok(f.stdout().includes(`${sourceExecutable} run 'smoke test' --view`));
  assert.equal(f.stderr(), "");
  assert.equal(existsSync(join(f.root, ".hurdle")), false);
});

test("empty and invalid JSON Suite listings are single documents", async t => {
  for (const args of [["suites", "--json"], ["suites", "--json", "--unknown"]]) {
    const f = fixture(t);
    const exit = await main(args, f.io);
    const report = JSON.parse(f.stdout());
    assert.deepEqual(report.suites, []);
    assert.equal(report.defaultSuite, null);
    assert.equal(exit, args.length === 2 ? 0 : 2);
    assert.equal(f.stderr(), "");
  }
});

test("suites and ls inspect the same Suite matrix without reading credentials or opening services and dispose generated definitions", async t => {
  for (const command of ["suites", "ls"]) {
    for (const json of [false, true]) {
      const f = fixture(t);
      mkdirSync(join(f.root, "evals"));
      assert.equal((await initializeSuite({ destination: join(f.root, "evals/codex-evals"), agent: "codex", example: "concurrency-smoke" })).ok, true);
      f.file("evals/codex-evals/example.suite.mjs", 'import { defineSuite } from "hurdle"; export default defineSuite(' + JSON.stringify({
        tasks: ["./tasks/copy-alpha", "./tasks/copy-beta", "./tasks/copy-gamma"],
        agents: [{ runner: "codex", model: "gpt-6.1-sol", effort: "medium" }],
        conditions: { baseline: {}, extra: {} }, repeats: 2, concurrency: 5, verdict: "code",
      }) + ');');
      mkdirSync(join(f.root, ".env.local"));
      let generatedRoot, disposals = 0;
      const forbidden = () => assert.fail("Inspection must not read credentials or start an evaluation");
      const cli = createFrameworkCli({
        env: new Proxy({}, { get: forbidden }), checkAgentReadiness: forbidden,
        openLocalResultStore: forbidden, openPostgresResultStore: forbidden, createRunEngine: forbidden,
        async resolveV1Suite(options) {
          const result = await resolveV1Suite(options);
          generatedRoot = result.generatedRoot;
          return { ...result, dispose() { disposals++; result.dispose(); } };
        },
      });
      const args = [command, ...(json ? ["--json"] : []), "codex-evals"];
      assert.equal(await (json ? cli.main(args, f.io) : main(args, f.io)), 0, f.stderr());
      if (json) {
        const report = JSON.parse(f.stdout());
        assert.equal(report.command, "suites", "aliases keep the canonical JSON command");
        assert.deepEqual(report.suite, {
          name: "codex-evals", path: "evals/codex-evals/example.suite.mjs",
          tasks: ["copy-alpha", "copy-beta", "copy-gamma"], conditions: ["baseline", "extra"],
          agents: [{ runner: "codex", model: "gpt-6.1-sol", effort: "medium" }],
          repeats: 2, concurrency: 5, plannedRuns: 12, scoring: "Code", judge: null,
        });
        assert.equal(report.runtime.sourcePath, null);
        assert.equal(report.runtime.environment.kind, "local");
        assert.equal(disposals, 1);
        assert.equal(existsSync(generatedRoot), false);
      } else {
        assert.match(f.stdout(), /Plan\s+12 runs · 3 tasks · 2 conditions/);
        assert.match(f.stdout(), /Agent\s+Codex · gpt-6\.1-sol · medium effort/);
        assert.match(f.stdout(), /Concurrency\s+5/);
        assert.ok(f.stdout().includes(`${sourceExecutable} run codex-evals --view`));
      }
      assert.equal(f.stderr(), "");
      assert.equal(existsSync(join(f.root, ".hurdle")), false);
    }
  }
});

test("ls lists filenames and both command spellings reject ambiguous names and bad arguments before importing Suite code", async t => {
  const listed = fixture(t);
  listed.file("evals/codex-evals/example.suite.mjs");
  mkdirSync(join(listed.root, ".env.local"));
  assert.equal(await main(["ls", "--json"], listed.io), 0);
  assert.equal(JSON.parse(listed.stdout()).suites[0].name, "codex-evals");
  for (const command of ["suites", "ls"]) {
    for (const args of [["codex-evals"], ["unknown"], ["--unknown"], ["a", "b"], ["--json"], [""], ["--runtime"], ["--runtime", "file.json"]]) {
      const f = fixture(t);
      f.file("evals/codex-evals/example.suite.mjs");
      f.file("examples/codex-evals/example.suite.mjs");
      const cli = createFrameworkCli({ resolveV1Suite() { assert.fail("Invalid selections must not import a Suite"); } });
      assert.equal(await cli.main([command, ...args, "--json"], f.io), 2);
      const report = JSON.parse(f.stdout());
      assert.equal(report.error.code, "argument-error");
      if (args[0] === "codex-evals") assert.match(report.error.message, /ambiguous/);
      assert.equal(f.stderr(), "");
    }
  }
  for (const args of [["ls", "--help"], ["help", "ls"]]) {
    const f = fixture(t);
    mkdirSync(join(f.root, ".env.local"));
    assert.equal(await main(args, f.io), 0);
    assert.match(f.stdout(), /hurdle ls \[suite\] \[--runtime FILE\] \[--json\]/);
  }
});

test("Suite inspection accepts explicit paths and returns useful JSON diagnostics for invalid definitions", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".env.local"));
  f.file("broken.suite.mjs", 'import { defineSuite } from "hurdle"; export default defineSuite({ tasks: [], agents: [{runner: "codex"}], verdict: "code" });');
  assert.equal(await main(["ls", "broken.suite.mjs", "--json"], f.io), 1);
  const report = JSON.parse(f.stdout());
  assert.equal(report.suite, null);
  assert.equal(report.error.code, "suite.tasks-invalid");
  assert.match(report.error.diagnostics[0].message, /nonempty array/);
  assert.equal(report.error.diagnostics[0].file, join(f.root, "broken.suite.mjs"));
  assert.equal(f.stderr(), "");
});

test("Suite inspection reads the shared Runtime or explicit override without resolving secrets and keeps the override in Next", async t => {
  for (const explicit of [false, true]) {
    const f = fixture(t);
    assert.equal((await initializeSuite({ destination: join(f.root, "codex-evals"), agent: "codex" })).ok, true);
    f.file(".hurdle/runtime/default.json", JSON.stringify({
      schemaVersion: 1,
      environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: {} },
      resultStore: { kind: "postgres", databaseUrlEnv: "DATABASE_URL", artifactRoot: "../artifacts" },
    }));
    const alternate = "profiles/runtime with spaces.json";
    f.file(alternate, JSON.stringify({ schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "selected-results" } }));
    mkdirSync(join(f.root, ".env.local"));
    const args = ["ls", "codex-evals", ...(explicit ? ["--runtime", alternate] : [])];
    const forbidden = () => assert.fail("Runtime inspection must not read credentials or contact services");
    const cli = createFrameworkCli({ env: new Proxy({}, { get: forbidden }), checkAgentReadiness: forbidden, openPostgresResultStore: forbidden, createRunEngine: forbidden });
    assert.equal(await cli.main([...args, "--json"], f.io), 0);
    const report = JSON.parse(f.stdout());
    assert.equal(report.runtime.sourcePath, join(f.root, explicit ? alternate : ".hurdle/runtime/default.json"));
    assert.equal(report.runtime.environment.kind, explicit ? "local" : "together");
    if (!explicit) {
      assert.equal(report.runtime.environment.settings.maxLifetimeMs, 3_600_000);
      assert.equal(report.runtime.environment.settings.memoryMiB, undefined);
      assert.equal(report.runtime.resultStore.databaseUrlEnv, "DATABASE_URL");
    }
    let text = "";
    assert.equal(await main(args, { ...f.io, stdout: { write(value) { text += value; } } }), 0);
    assert.ok(text.includes(`${sourceExecutable} run codex-evals${explicit ? " --runtime 'profiles/runtime with spaces.json'" : ""} --view`));
    assert.equal(existsSync(join(f.root, ".hurdle/artifacts")), false);
    assert.equal(existsSync(join(f.root, "profiles/selected-results")), false);
    assert.equal(f.stderr(), "");
  }
});

test("runtime inspection uses the same default, project, legacy and explicit profile precedence without loading the environment or Suites", async t => {
  const profile = port => JSON.stringify({ schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "results" }, viewer: { port } });
  for (const selection of ["built-in", "legacy", "project", "explicit"]) {
    const f = fixture(t);
    f.file("example.suite.mjs");
    mkdirSync(join(f.root, ".env.local"));
    if (selection !== "built-in") f.file(".tae/runtime/default.json", profile(4001));
    if (["project", "explicit"].includes(selection)) f.file(".hurdle/runtime/default.json", profile(4002));
    if (selection === "explicit") f.file("config/runtime with spaces.json", profile(4003));
    const args = ["runtime", "--json", ...(selection === "explicit" ? ["--runtime", "config/runtime with spaces.json"] : [])];
    assert.equal(await main(args, f.io), 0, f.stderr());
    const { runtime, command } = JSON.parse(f.stdout());
    assert.equal(command, "runtime");
    const source = { "built-in": null, legacy: ".tae/runtime/default.json", project: ".hurdle/runtime/default.json", explicit: "config/runtime with spaces.json" }[selection];
    assert.equal(runtime.sourcePath, source ? join(f.root, source) : null);
    assert.equal(runtime.viewer.port, { "built-in": 3000, legacy: 4001, project: 4002, explicit: 4003 }[selection]);
    assert.equal(runtime.resultStore.root, source ? join(f.root, source, "..", "results") : join(f.root, ".hurdle/results-v1"));
    assert.equal(f.stderr(), "");
    if (selection === "built-in") assert.equal(existsSync(join(f.root, ".hurdle")), false, "inspection must not initialize storage");
  }
});

test("runtime inspection reports Together effective limits and Postgres credential names without resolving credentials or opening services", async t => {
  for (const kind of ["together"]) {
    for (const json of [true, false]) {
      const f = fixture(t);
      const settings = { maxLifetimeMs: 600_000 };
      f.file(".hurdle/runtime/default.json", JSON.stringify({
        schemaVersion: 1, environment: { kind, apiKeyEnv: "SANDBOX_KEY", settings },
        resultStore: { kind: "postgres", databaseUrlEnv: "DATABASE_URL", artifactRoot: "../artifacts" },
      }));
      const forbidden = () => assert.fail("Inspection must not read credentials, load Suites or open services");
      const cli = createFrameworkCli({
        env: new Proxy({}, { get: forbidden }), resolveV1Suite: forbidden, checkAgentReadiness: forbidden,
        openLocalResultStore: forbidden, openPostgresResultStore: forbidden,
        createTogetherExecutionEnvironment: forbidden,
      });
      assert.equal(await cli.main(["runtime", ...(json ? ["--json"] : [])], f.io), 0);
      if (json) {
        const { runtime } = JSON.parse(f.stdout());
        assert.equal(runtime.environment.kind, kind);
        assert.deepEqual(Object.keys(runtime.environment.settings), ["maxLifetimeMs"]);
        assert.equal(runtime.environment.settings.maxLifetimeMs, 600_000);
        assert.deepEqual(runtime.resultStore, { kind: "postgres", databaseUrlEnv: "DATABASE_URL", artifactRoot: join(f.root, ".hurdle/artifacts") });
      } else {
        assert.match(f.stdout(), /Store\s+Postgres/);
        assert.match(f.stdout(), /Database\s+DATABASE_URL \(environment variable\)/);
        assert.match(f.stdout(), /Image\s+Together's Hurdle image/);
        assert.match(f.stdout(), /Limits\s+10m max/);
      }
      assert.equal(f.stderr(), "");
      assert.equal(existsSync(join(f.root, ".hurdle/artifacts")), false);
    }
  }
});

test("runtime argument recovery keeps the help command on the source CLI", async t => {
  const f = fixture(t);
  assert.equal(await main(["runtime", "--unknown"], f.io), 2);
  assert.ok(f.stderr().includes(`${sourceExecutable} help runtime`), f.stderr());
});

test("runtime inspection reports invalid arguments and profiles as single JSON errors without leaking literal credentials", async t => {
  for (const [args, expectedCode] of [
    [["--runtime"], "argument-error"],
    [["--runtime", "--json"], "argument-error"],
    [["--runtime", "missing.json", "--runtime", "other.json"], "argument-error"],
    [["--json"], "argument-error"],
    [["--store", "results"], "argument-error"],
    [["--runtime", "missing.json"], "runtime.profile-read"],
    [["--runtime", "invalid.json"], "runtime.profile-schema"],
  ]) {
    const f = fixture(t);
    f.file("invalid.json", JSON.stringify({ schemaVersion: 1, environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { apiKey: "must-not-display" } }, resultStore: { kind: "local", root: "results" } }));
    assert.equal(await main(["runtime", ...args, "--json"], f.io), 2);
    const report = JSON.parse(f.stdout());
    assert.equal(report.error.code, expectedCode);
    assert.equal(report.runtime, null);
    assert.doesNotMatch(f.stdout(), /must-not-display/);
    assert.equal(f.stderr(), "");
    assert.equal(existsSync(join(f.root, ".hurdle")), false);
  }
});
