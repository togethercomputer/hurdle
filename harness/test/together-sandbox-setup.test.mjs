import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { initializeSuite } from "../lib/starter-suite.mjs";
import {
  BARTENDER_CONTEXT_FILES,
  TOGETHER_BARTENDER_SERVER_COMMAND,
  togetherBartenderDockerfile,
  togetherSandboxDockerfile,
  writeTogetherBartenderContext,
} from "../lib/together-sandbox-setup.mjs";

async function fixture(t, example = "copy-message") {
  const root = await mkdtemp(join(tmpdir(), "hurdle-together-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    (await initializeSuite({ destination: join(root, "evals"), example })).ok,
    true,
  );
  const calls = [];
  let text = "";
  const io = {
    cwd: root,
    stdout: {
      write: (value) => {
        text += value;
      },
    },
    stderr: {
      write: (value) => {
        text += value;
      },
    },
  };
  const dependencies = {
    env: {
      TOGETHER_API_KEY: "test-sandbox-secret",
      ANTHROPIC_API_KEY: "test-agent-secret",
    },
    processTarget: new EventEmitter(),
    assertRuntimeDependencies() {},
    checkAgentReadiness: async () => ({ ok: true, checks: [] }),
    ensureHostGuardianRuntime: async () => ({}),
    loadTogetherSetupBackend: async () => ({
      exists: async () => {
        calls.push("exists");
        return false;
      },
      build: async (...args) => {
        calls.push(["build", ...args]);
      },
    }),
  };
  return {
    root,
    io,
    calls,
    dependencies,
    output: () => text,
    runtimePath: join(root, ".hurdle/runtime/default.json"),
  };
}
test("setup --sandbox together selects Together's Hurdle image without a build, and validate discovers its private Runtime", async (t) => {
  const f = await fixture(t);
  const cli = createFrameworkCli({
    ...f.dependencies,
    loadSetupBackend() { assert.fail("Together setup must not use E2B"); },
    loadTogetherSetupBackend() { assert.fail("no snapshot is needed"); },
  });
  assert.equal(
    await cli.main(["setup", "--sandbox", "together", "--yes", "--json"], f.io),
    0,
    f.output(),
  );
  const report = JSON.parse(f.output());
  assert.equal(report.executionEnvironment, "together");
  assert.equal(report.target, "together");
  assert.ok(report.checks.some(check => check.status === "pass" && check.message === "Setup complete · Together sandbox configured."));
  assert.ok(report.checks.some(check => check.message === "Together's Hurdle image selected; nothing to build."));
  const config = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.equal(config.environment.settings.snapshotAlias, undefined);
  assert.equal(config.environment.settings.maxLifetimeMs, 300000);
  assert.equal(config.resultStore.root, "../together-results-v1");
  assert.equal(config.judge, undefined);
  assert.equal(existsSync(join(f.root, ".env.local")), false);
  assert.doesNotMatch(f.output(), /test-sandbox-secret|test-agent-secret/);
  assert.equal(await cli.main(["validate"], f.io), 0, f.output());
});
test("Together setup preserves an existing store, Judge and limits while reusing snapshots", async (t) => {
  const f = await fixture(t);
  const config = {
    schemaVersion: 1,
    environment: {
      kind: "together",
      apiKeyEnv: "TOGETHER_API_KEY",
      settings: {
        snapshotAlias: "existing@v1",
        cpuCount: 2,
        memoryMiB: 4096,
        maxLifetimeMs: 120000,
      },
    },
    resultStore: { kind: "local", root: "../../saved" },
    viewer: { port: 3022 },
  };
  await mkdir(join(f.root, ".hurdle/runtime"), { recursive: true });
  await writeFile(f.runtimePath, JSON.stringify(config));
  const cli = createFrameworkCli({
    ...f.dependencies,
    loadTogetherSetupBackend: async () => ({
      exists: async () => true,
      build: () => assert.fail("must reuse snapshot"),
    }),
  });
  assert.equal(
    await cli.main(["setup", "--sandbox", "together"], f.io),
    0,
    f.output(),
  );
  const saved = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.deepEqual(saved.resultStore, config.resultStore);
  assert.equal(saved.environment.settings.maxLifetimeMs, 120000);
  assert.equal(saved.viewer.port, 3022);
  assert.match(f.output(), /✓ Setup complete · Together sandbox configured\./);
});
// A project that built a Hurdle snapshot before keeps using the sandbox API.
async function savedSnapshot(f, snapshotAlias) {
  await mkdir(join(f.root, ".hurdle/runtime"), { recursive: true });
  await writeFile(f.runtimePath, JSON.stringify({
    schemaVersion: 1,
    environment: { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: { snapshotAlias, maxLifetimeMs: 300000 } },
    resultStore: { kind: "local", root: "../together-results-v1" },
  }));
}

test("Together setup adds a new Agent to a project's Hurdle snapshot instead of reusing one without its CLI", async (t) => {
  const f = await fixture(t);
  f.dependencies.env.OPENAI_API_KEY = "test-openai-secret";
  const available = new Set(["hurdle-claude-code@v1"]);
  const builds = [];
  const cli = createFrameworkCli({
    ...f.dependencies,
    loadTogetherSetupBackend: async () => ({
      exists: async (alias) => available.has(alias),
      build: async (alias, ids) => {
        builds.push([alias, ids]);
        available.add(alias);
      },
    }),
  });
  const savedAlias = async () => JSON.parse(await readFile(f.runtimePath, "utf8")).environment.settings.snapshotAlias;
  await savedSnapshot(f, "hurdle-claude-code@v1");
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes"], f.io), 0, f.output());
  assert.equal(await savedAlias(), "hurdle-claude-code@v1");
  assert.equal(builds.length, 0);

  assert.equal((await initializeSuite({ destination: join(f.root, "codex"), agent: "codex" })).ok, true);
  assert.equal(
    await cli.main(["setup", "codex/example.suite.mjs", "--sandbox", "together", "--yes"], f.io),
    0,
    f.output(),
  );
  assert.equal(await savedAlias(), "hurdle-claude-code-codex@v2");
  assert.deepEqual(builds.at(-1), ["hurdle-claude-code-codex@v2", ["claude-code", "codex"]]);

  // A snapshot saved by an earlier Hurdle has an older Codex CLI.
  const runtime = JSON.parse(await readFile(f.runtimePath, "utf8"));
  runtime.environment.settings.snapshotAlias = "hurdle-claude-code-codex@v1";
  await writeFile(f.runtimePath, JSON.stringify(runtime));
  available.clear();
  available.add("hurdle-claude-code-codex@v1");
  assert.equal(
    await cli.main(["setup", "codex/example.suite.mjs", "--sandbox", "together", "--yes"], f.io),
    0,
    f.output(),
  );
  assert.equal(await savedAlias(), "hurdle-claude-code-codex@v2");
  assert.equal(builds.length, 2);
});

test("Together API setup configures a longer Guardian lifetime, and a project's snapshot gains network tools", async (t) => {
  const f = await fixture(t, "together-api");
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(
    await cli.main(["setup", "--sandbox", "together", "--yes"], f.io),
    0,
    f.output(),
  );
  assert.deepEqual(f.calls, []);
  const config = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.equal(config.environment.settings.maxLifetimeMs, 600000);
  assert.match(f.output(), /All sandbox traffic routes through this machine/);

  await savedSnapshot(f, "hurdle-claude-code@v1");
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes"], f.io), 0, f.output());
  assert.equal(f.calls[1][1], "hurdle-claude-code-network@v1");
});
test("Together setup gives a later API Suite ten minutes but keeps a configured limit", async (t) => {
  const f = await fixture(t);
  const cli = createFrameworkCli(f.dependencies);
  const lifetime = async () =>
    JSON.parse(await readFile(f.runtimePath, "utf8")).environment.settings.maxLifetimeMs;
  assert.equal(await cli.main(["setup", "--sandbox", "together", "--yes"], f.io), 0, f.output());
  assert.equal(await lifetime(), 300000);

  assert.equal((await initializeSuite({ destination: join(f.root, "api"), example: "together-api" })).ok, true);
  const api = ["setup", "api/example.suite.mjs", "--sandbox", "together", "--yes"];
  assert.equal(await cli.main(api, f.io), 0, f.output());
  assert.equal(await lifetime(), 600000);

  const runtime = JSON.parse(await readFile(f.runtimePath, "utf8"));
  runtime.environment.settings.maxLifetimeMs = 420000;
  await writeFile(f.runtimePath, JSON.stringify(runtime));
  assert.equal(await cli.main(api, f.io), 0, f.output());
  assert.equal(await lifetime(), 420000);
});

test("Together setup declines unapproved builds and missing caller-selected snapshots", async (t) => {
  const unapproved = await fixture(t);
  await savedSnapshot(unapproved, "hurdle-claude-code@v1");
  const before = await readFile(unapproved.runtimePath, "utf8");
  assert.equal(await createFrameworkCli(unapproved.dependencies).main(["setup", "--sandbox", "together"], unapproved.io), 1);
  assert.ok(!unapproved.calls.some((call) => Array.isArray(call)));
  assert.equal(await readFile(unapproved.runtimePath, "utf8"), before);

  const missing = await fixture(t);
  assert.equal(
    await createFrameworkCli(missing.dependencies).main(
      ["setup", "--sandbox", "together", "--snapshot", "missing@v1", "--yes"],
      missing.io,
    ),
    1,
  );
  assert.ok(!missing.calls.some((call) => Array.isArray(call)));
  assert.equal(existsSync(missing.runtimePath), false);
});
test("Together Dockerfile includes pinned agents and Linux controller dependencies", () => {
  const text = togetherSandboxDockerfile([
    "claude-code",
    "codex",
    "claude-code",
  ]);
  assert.match(text, /FROM node:22-bookworm/);
  assert.match(text, /util-linux passwd/);
  assert.match(text, /passwd iptables/);
  assert.match(text, /@anthropic-ai\/claude-code@2\.1\.288/);
  assert.match(text, /@openai\/codex@0\.159\.3/);
  assert.throws(() => togetherSandboxDockerfile(["unknown-agent"]));
});

test("Bartender snapshot context bakes in the sandbox server and everything it loads", async (t) => {
  const context = await mkdtemp(join(tmpdir(), "hurdle-bartender-context-test-"));
  t.after(() => rm(context, { recursive: true, force: true }));
  await writeTogetherBartenderContext(context, ["claude-code", "codex"]);

  const dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
  assert.equal(dockerfile, togetherBartenderDockerfile(["claude-code", "codex"]));
  assert.ok(dockerfile.startsWith(togetherSandboxDockerfile(["claude-code", "codex"]).trimEnd()));
  assert.match(dockerfile, /\nCOPY hurdle\/ \/opt\/hurdle\/\nRUN cd \/opt\/hurdle && npm ci /);

  const harness = join(import.meta.dirname, "..");
  for (const file of BARTENDER_CONTEXT_FILES)
    assert.equal(
      await readFile(join(context, "hurdle", "harness", file), "utf8"),
      await readFile(join(harness, file), "utf8"),
    );
  const runtime = JSON.parse(await readFile(join(context, "hurdle", "package.json"), "utf8"));
  assert.ok(runtime.dependencies.ws);
  // Loading the baked modules from the context proves every relative import
  // and every asset they read at load time was copied.
  for (const module of ["sandbox-server", "sandbox-task", "together-workload-egress"])
    await import(join(context, "hurdle", "harness", "lib", "execution-environments", `${module}.mjs`));
  assert.equal(
    TOGETHER_BARTENDER_SERVER_COMMAND,
    "node /opt/hurdle/harness/bin/hurdle-sandbox-server.mjs",
  );
});
