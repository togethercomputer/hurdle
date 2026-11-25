import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPostgresTestDatabase, postgresTestAdminConnectionString } from "./helpers/postgres-test-database.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = path => JSON.parse(readFileSync(join(root, path), "utf8"));

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForOutput(child, pattern, readOutput, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error(`Timed out waiting for ${pattern}:\n${readOutput()}`));
    }, timeoutMs);
    const inspect = () => {
      if (!pattern.test(readOutput())) return;
      cleanUp();
      resolve();
    };
    const onClose = (code, signal) => {
      cleanUp();
      reject(new Error(`CLI closed before ${pattern} (code ${code}, signal ${signal}):\n${readOutput()}`));
    };
    const cleanUp = () => {
      clearTimeout(timer);
      child.stdout?.off("data", inspect);
      child.stderr?.off("data", inspect);
      child.off("close", onClose);
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("close", onClose);
    inspect();
  });
}

function waitForClose(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve([child.exitCode, child.signalCode]);
      return;
    }
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("Timed out waiting for the installed CLI to stop"));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    };
    child.once("close", onClose);
  });
}

test("the harness needs only the WebSocket client beside the Postgres driver, with no optional SDKs", () => {
  const harness = read("harness/package.json");
  const pkg = read("package.json");
  const scripts = pkg.scripts;
  assert.ok(harness.dependencies.ws, "the Together socket needs the WebSocket client");
  assert.ok(pkg.dependencies.ws, "the published package needs it too");
  assert.equal(harness.optionalDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(harness.devDependencies?.typescript, undefined);
  assert.equal(harness.devDependencies?.["@types/node"], undefined);
  assert.ok(harness.dependencies.pg, "the Viewer keeps its small Postgres driver");
  assert.match(scripts.setup, /--prefix harness install(?! --omit=optional)/);
  assert.equal(scripts["setup:backends"], undefined);
  assert.match(scripts["setup:ci"], /--prefix harness ci(?! --include=optional)/);
  const quickstart = readFileSync(join(root, "harness/bin/source-quickstart.mjs"), "utf8");
  assert.doesNotMatch(quickstart, /omit=optional/);
});

test("the root hurdle command exposes the public CLI", () => {
  const result = spawnSync("npm", ["run", "hurdle", "--", "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^> node harness\/bin\/hurdle\.mjs --help$/m);
  assert.match(result.stdout, /^Hurdle\n\nUsage:\n  hurdle <command> \[options\]/m);
});

test("the npm tarball installs a working CLI and Viewer", { timeout: 120_000 }, async (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tae-package-install-"));
  const packRoot = join(temporaryRoot, "pack");
  const consumerRoot = join(temporaryRoot, "consumer");
  mkdirSync(packRoot);
  mkdirSync(consumerRoot);
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 90_000,
  });
  assert.equal(packed.status, 0, `${packed.stderr}\n${packed.stdout}`);
  const metadataStart = packed.stdout.lastIndexOf("\n[");
  const [packageMetadata] = JSON.parse(
    metadataStart === -1 ? packed.stdout : packed.stdout.slice(metadataStart + 1),
  );
  assert.equal(packageMetadata.name, "hurdle");
  assert.equal(packageMetadata.version, read("package.json").version);
  const packagedPaths = new Set(packageMetadata.files.map(({ path }) => path));
  for (const path of [
    "LICENSE",
    "CHANGELOG.md",
    "examples/copy-message/example.suite.mjs",
    "examples/concurrency-smoke/example.suite.mjs",
    ...["copy-alpha", "copy-beta", "copy-gamma"].flatMap(task => [
      `examples/concurrency-smoke/tasks/${task}/prompt.md`,
      `examples/concurrency-smoke/tasks/${task}/checks.mjs`,
      `examples/concurrency-smoke/tasks/${task}/fixtures/message.txt`,
    ]),
    "examples/kitchen-sink/example.suite.mjs",
    "examples/kitchen-sink/skills/house-style/SKILL.md",
    "examples/kitchen-sink/tasks/fix-the-bug/workspace/test/slugify.test.js",
    "harness/bin/hurdle.mjs",
    "harness/bin/tae.mjs",
    "harness/lib/hurdle-environment.mjs",
    "harness/lib/postgres-setup.mjs",
    "harness/lib/setup-project-files.mjs",
    "harness/lib/setup-output.mjs",
    "harness/lib/setup-credentials.mjs",
    "harness/migrations/postgres/0001_canonical_result_store.sql",
    "harness/migrations/postgres/0002_hurdle_schema.sql",
    "harness/verify/proxy/agent-node-runtime/package-lock.json",
    "harness/verify/proxy/generic_guardian.py",
    "node_modules/pg/package.json",
    "viewer/launcher.mjs",
    "viewer-runtime/server.js",
    "viewer-runtime/THIRD_PARTY_NOTICES.txt",
  ]) assert.equal(packagedPaths.has(path), true, `missing package runtime file: ${path}`);
  for (const path of packagedPaths) {
    assert.equal(path.endsWith(".node"), false, `native package payload: ${path}`);
    assert.equal(path.includes("__pycache__"), false, `Python cache payload: ${path}`);
    assert.equal(path.endsWith(".env.local"), false, `private environment payload: ${path}`);
  }
  const archives = readdirSync(packRoot).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, `Expected one package archive, found: ${archives.join(", ")}`);

  writeFileSync(join(consumerRoot, "package.json"), `${JSON.stringify({ private: true })}\n`);
  const installed = spawnSync("npm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    join(packRoot, archives[0]),
  ], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      npm_config_cache: join(temporaryRoot, "empty-npm-cache"),
    },
    timeout: 30_000,
  });
  assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);
  const installedPackage = JSON.parse(readFileSync(join(consumerRoot, "node_modules", "hurdle", "package.json"), "utf8"));
  assert.equal(
    readFileSync(join(consumerRoot, "node_modules", "hurdle", "README.md"), "utf8"),
    readFileSync(join(root, "README.md"), "utf8"),
    "GitHub and npm must use the same root README",
  );
  assert.equal(installedPackage.license, "MIT");
  assert.notEqual(installedPackage.private, true);
  assert.equal(installedPackage.publishConfig.tag, "latest");
  const notices = readFileSync(join(consumerRoot, "node_modules", "hurdle", "viewer-runtime", "THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const name of ["next", "react", "react-dom", "geist"]) {
    assert.ok(notices.includes(`## ${name}@`), `missing bundled dependency notices: ${name}`);
  }

  const cliPath = join(consumerRoot, "node_modules", ".bin", "hurdle");
  assert.equal(existsSync(cliPath), true, "the package must install its hurdle executable");
  const legacyCliPath = join(consumerRoot, "node_modules", ".bin", "tae");
  assert.equal(existsSync(legacyCliPath), true, "the package keeps its legacy tae executable");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", [
    'import assert from "node:assert/strict";',
    'import { defineSuite, defineChecks, defineGuard } from "hurdle";',
    'const suite = { tasks: ["./tasks/copy-message"] };',
    'const checks = () => {};',
    'const guard = () => {};',
    'assert.equal(defineSuite(suite), suite);',
    'assert.equal(defineChecks(checks), checks);',
    'assert.equal(defineGuard(guard), guard);',
  ].join("\n")], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  const executed = spawnSync("npx", ["--offline", "hurdle", "--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", npm_config_cache: join(temporaryRoot, "empty-npm-cache") },
    timeout: 20_000,
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.match(executed.stdout, /^Hurdle\n\nUsage:\n  hurdle <command>/);
  const cli = (...args) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 20_000,
  });

  for (const command of ["version", "--version", "-v"]) {
    const result = cli(command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${installedPackage.version}\n`);
    assert.equal(result.stderr, "");
  }
  const legacyVersion = spawnSync(process.execPath, [legacyCliPath, "--version"], { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(legacyVersion.status, 0, legacyVersion.stderr);
  assert.equal(legacyVersion.stdout, `${installedPackage.version}\n`);

  const initialized = cli("init");
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /^✓ Evaluation created$/m);
  assert.match(initialized.stdout, /^  Model\s+claude-opus-5-5$/m);
  assert.match(initialized.stdout, /^  Effort\s+medium$/m);
  assert.match(initialized.stdout, /npx hurdle validate\n            npx hurdle run --view/);
  const validated = cli("validate", "--offline");
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /^  Suite     evals\/example\.suite\.mjs$/m);

  const fakeBin = join(consumerRoot, "fake-bin");
  mkdirSync(fakeBin);
  const fakeClaude = join(fakeBin, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'readFileSync(0, "utf8");',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "package-smoke" }));',
    'console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "package-smoke", model: "test-model" }));',
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const codexInitialized = cli("init", "codex-evals", "--agent", "codex");
  assert.equal(codexInitialized.status, 0, codexInitialized.stderr);
  assert.match(readFileSync(join(consumerRoot, "codex-evals/example.suite.mjs"), "utf8"), /runner: "codex"/);
  assert.match(readFileSync(join(consumerRoot, "codex-evals/example.suite.mjs"), "utf8"), /model: "gpt-6\.1-sol", effort: "medium"/);
  const codexValidated = cli("validate", "codex-evals/example.suite.mjs", "--offline");
  assert.equal(codexValidated.status, 0, codexValidated.stderr);

  const setupHelp = cli("help", "setup");
  assert.equal(setupHelp.status, 0, setupHelp.stderr);
  assert.match(setupHelp.stdout, /hurdle setup/);
  assert.match(setupHelp.stdout, /--store postgres/);
  const storageProject = join(temporaryRoot, "postgres-project");
  mkdirSync(storageProject);
  const storageSetup = connectionString => spawnSync(process.execPath, [cliPath, "setup", "--store", "postgres", "--json"], {
    cwd: storageProject,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", HURDLE_RESULT_STORE_DATABASE_URL: connectionString },
    timeout: 20_000,
  });
  const invalidStorage = storageSetup("https://example.test/private-placeholder");
  assert.equal(invalidStorage.status, 1, invalidStorage.stderr);
  assert.equal(JSON.parse(invalidStorage.stdout).error.code, "setup.database-url");
  assert.doesNotMatch(invalidStorage.stdout, /private-placeholder/);
  if (postgresTestAdminConnectionString) {
    const database = await createPostgresTestDatabase();
    try {
      for (let index = 0; index < 2; index++) {
        const configured = storageSetup(database.connectionString);
        assert.equal(configured.status, 0, `${configured.stderr}\n${configured.stdout}`);
        assert.equal(JSON.parse(configured.stdout).ok, true);
        assert.equal(JSON.parse(configured.stdout).resultStore, "postgres");
        assert.doesNotMatch(configured.stdout, /postgresql:\/\//);
      }
      const saved = JSON.parse(readFileSync(join(storageProject, ".hurdle/runtime/default.json"), "utf8"));
      assert.equal(saved.resultStore.kind, "postgres");
      assert.equal(saved.environment.kind, "local");
    } finally { await database.cleanup(); }
  }
  const togetherInitialized = cli("init", "together-evals", "--example", "together-api");
  assert.equal(togetherInitialized.status, 0, togetherInitialized.stderr);
  const togetherValidated = cli("validate", "together-evals/example.suite.mjs", "--offline");
  assert.equal(togetherValidated.status, 0, togetherValidated.stderr);
  assert.match(readFileSync(join(consumerRoot, "together-evals/tasks/together-api/fixtures/request.json"), "utf8"), /max_tokens/);

  const concurrentInitialized = cli("init", "concurrent-tasks", "--example", "concurrency-smoke");
  assert.equal(concurrentInitialized.status, 0, concurrentInitialized.stderr);
  const concurrentValidated = cli("validate", "concurrent-tasks/example.suite.mjs", "--offline");
  assert.equal(concurrentValidated.status, 0, concurrentValidated.stderr);
  assert.match(concurrentValidated.stdout, /3 tasks · 1 condition/);
  for (const task of ["copy-alpha", "copy-beta", "copy-gamma"]) {
    assert.ok(existsSync(join(consumerRoot, "concurrent-tasks/tasks", task, "fixtures/message.txt")));
  }

  const kitchenSinkInitialized = cli("init", "kitchen-sink", "--example", "kitchen-sink");
  assert.equal(kitchenSinkInitialized.status, 0, kitchenSinkInitialized.stderr);
  const kitchenSinkValidated = cli("validate", "kitchen-sink/example.suite.mjs", "--offline");
  assert.equal(kitchenSinkValidated.status, 0, kitchenSinkValidated.stderr);
  assert.match(kitchenSinkValidated.stdout, /5 tasks · 2 conditions/);
  assert.ok(existsSync(join(consumerRoot, "kitchen-sink/skills/house-style/SKILL.md")));
  assert.ok(existsSync(join(consumerRoot, "kitchen-sink/tasks/fix-the-bug/workspace/src/slugify.js")));

  const customInitialized = cli("init", "custom-evals", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
  assert.equal(customInitialized.status, 0, customInitialized.stderr);
  const modelsHelp = cli("models", "--help");
  assert.equal(modelsHelp.status, 0, modelsHelp.stderr);
  assert.match(modelsHelp.stdout, /upstream catalogs/);
  const modelHelp = cli("run", "custom-evals", "--model", "-h");
  assert.equal(modelHelp.status, 0, modelHelp.stderr);
  assert.match(modelHelp.stdout, /Suite defaults \(custom-evals\)/);
  assert.match(modelHelp.stdout, /npx hurdle models --agent codex/);
  const overridden = cli("validate", "custom-evals", "--offline", "--model", "future-codex-2099");
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stdout, /future-codex-2099 · high effort/);
  assert.match(cli("validate", "custom-evals/example.suite.mjs", "--offline").stdout, /gpt-6\.1-sol · high effort/);

  const port = await availablePort();
  writeFileSync(join(consumerRoot, "runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    environment: { kind: "local", settings: {} },
    resultStore: { kind: "local", root: "./results" },
    viewer: { port },
  }, null, 2)}\n`);

  const rejectedEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: "test-only-rejected-key",
    PATH: `${fakeBin}:${process.env.PATH}`,
    NODE_OPTIONS: `--import=${join(root, "harness/test/helpers/readiness-fetch.mjs")}`,
    HURDLE_TEST_AUTH_REJECT: "1",
  };
  for (const command of [["validate"], ["run", "--view"]]) {
    const rejected = spawnSync(process.execPath, [cliPath, ...command], {
      cwd: consumerRoot, env: rejectedEnv, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(rejected.status, 1, rejected.stderr + rejected.stdout);
    assert.match(rejected.stdout, /rejected ANTHROPIC_API_KEY/);
    assert.match(rejected.stderr, /No evaluation started/);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /test-only-rejected-key|Viewer ready/);
    assert.equal(existsSync(join(consumerRoot, ".hurdle/results-v1")), false);
    assert.equal(existsSync(join(consumerRoot, "results")), false);
  }

  const ready = spawnSync("npx", ["--offline", "hurdle", "validate"], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${join(root, "harness/test/helpers/readiness-fetch.mjs")}`,
      PATH: `${fakeBin}:${process.env.PATH}`,
      npm_config_cache: join(temporaryRoot, "empty-npm-cache"),
    },
    timeout: 20_000,
  });
  assert.equal(ready.status, 0, ready.stderr + ready.stdout);
  assert.equal(existsSync(join(consumerRoot, ".hurdle/results-v1")), false);

  let stdout = "";
  let stderr = "";
  // Control the persistent CLI directly: signalling only npm's PID leaves
  // its child alive on Linux. npx installation and readiness are checked above.
  const child = spawn(process.execPath, [
    cliPath,
    "run",
    "--runtime",
    "runtime.json",
    "--view",
  ], {
    cwd: consumerRoot,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${join(root, "harness/test/helpers/readiness-fetch.mjs")}`,
      NO_COLOR: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const output = () => `${stdout}\n${stderr}`;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      await waitForClose(child).catch(() => child.kill("SIGKILL"));
    }
  });

  await waitForOutput(child, new RegExp(`URL\\s+http://127\\.0\\.0\\.1:${port}`), output);
  assert.match(stdout, /^  Result\s+Passed$/m);
  assert.match(stdout, /^  Runs\s+1 passed$/m);
  assert.match(stdout, /claude-opus-5-5 · medium effort/);
  const response = await fetch(`http://127.0.0.1:${port}`);
  assert.equal(response.status, 200);
  await response.body?.cancel();

  const [runId] = readdirSync(join(consumerRoot, "results", "runs"));
  assert.ok(runId, "the packaged run must save a result");
  const runResponse = await fetch(`http://127.0.0.1:${port}/s/canonical--${runId}`);
  const runHtml = await runResponse.text();
  assert.equal(runResponse.status, 200, runHtml);
  assert.match(runHtml, /copy-message/, "the packaged Viewer must render the saved run");
  assert.doesNotMatch(runHtml, /__next_error__/);

  child.kill("SIGINT");
  const [exitCode, signal] = await waitForClose(child);
  assert.equal(signal, null);
  assert.equal(exitCode, 130, output());
  assert.doesNotMatch(output(), /viewer-disposal-unconfirmed|internal-error/);
});

test("a Local install runs a real controller from framework source", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-core-only-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const harness = join(cwd, "harness");
  cpSync(join(root, "examples/copy-message"), join(cwd, "examples/copy-message"), { recursive: true });
  // No npm/network in unit tests: isolate framework source and expose only core modules.
  mkdirSync(harness);
  for (const path of ["bin", "lib", "verify", "types", "index.mjs", "package.json"]) {
    cpSync(join(root, "harness", path), join(harness, path), { recursive: true });
  }
  mkdirSync(join(harness, "node_modules"));
  for (const name of Object.keys(read("harness/package.json").dependencies)) {
    symlinkSync(join(root, "harness/node_modules", name), join(harness, "node_modules", name));
  }
  const env = { PATH: process.env.PATH, TOGETHER_API_KEY: "test-not-a-real-key", NODE_OPTIONS: `--import=${join(root, "harness/test/helpers/readiness-fetch.mjs")}` };
  const cli = (...args) => spawnSync(process.execPath, [join(harness, "bin/hurdle.mjs"), ...args], { cwd, env, encoding: "utf8", timeout: 20_000 });
  const initialized = cli("init", "evals");
  assert.equal(initialized.status, 0, initialized.stderr);
  const validated = cli("validate", "evals/example.suite.mjs", "--offline");
  assert.equal(validated.status, 0, validated.stderr);
  // Exercise the real Local controller and filesystem store with a fake Agent.
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const agent = join(bin, "claude");
  writeFileSync(agent, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'readFileSync(0, "utf8");',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "core-only" }));',
    'console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "core-only", model: "test-model" }));',
  ].join("\n"));
  chmodSync(agent, 0o755);
  env.PATH = `${bin}:${process.env.PATH}`;
  env.ANTHROPIC_API_KEY = "test-only-key";
  const local = cli("run", "evals/example.suite.mjs");
  assert.equal(local.status, 0, local.stderr + local.stdout);
  assert.match(local.stdout, /^  Result\s+Passed$/m);
  assert.match(local.stdout, /^  Runs\s+1 passed$/m);
  assert.equal(existsSync(join(cwd, ".hurdle/results-v1")), true);
});
