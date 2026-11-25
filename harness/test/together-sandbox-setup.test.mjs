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
  IMAGE_CONTEXT_FILES,
  TOGETHER_SERVER_COMMAND,
  togetherImageDockerfile,
  togetherSandboxDockerfile,
  writeTogetherImageContext,
} from "../lib/together-sandbox-setup.mjs";

async function fixture(t, example = "copy-message") {
  const root = await mkdtemp(join(tmpdir(), "hurdle-together-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    (await initializeSuite({ destination: join(root, "evals"), example })).ok,
    true,
  );
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
    checkAgentReadiness: async () => ({ ok: true, checks: [] }),
    ensureHostGuardianRuntime: async () => ({}),
  };
  return {
    root,
    io,
    dependencies,
    output: () => text,
    runtimePath: join(root, ".hurdle/runtime/default.json"),
  };
}
test("setup --sandbox together selects Together's Hurdle image without a build, and validate discovers its private Runtime", async (t) => {
  const f = await fixture(t);
  const cli = createFrameworkCli(f.dependencies);
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
test("Together setup preserves an existing store, Judge and limits", async (t) => {
  const f = await fixture(t);
  const config = {
    schemaVersion: 1,
    environment: {
      kind: "together",
      apiKeyEnv: "TOGETHER_API_KEY",
      settings: {
        maxLifetimeMs: 120000,
      },
    },
    resultStore: { kind: "local", root: "../../saved" },
    viewer: { port: 3022 },
  };
  await mkdir(join(f.root, ".hurdle/runtime"), { recursive: true });
  await writeFile(f.runtimePath, JSON.stringify(config));
  const cli = createFrameworkCli(f.dependencies);
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
test("Together API setup configures a longer Guardian lifetime", async (t) => {
  const f = await fixture(t, "together-api");
  const cli = createFrameworkCli(f.dependencies);
  assert.equal(
    await cli.main(["setup", "--sandbox", "together", "--yes"], f.io),
    0,
    f.output(),
  );
  const config = JSON.parse(await readFile(f.runtimePath, "utf8"));
  assert.equal(config.environment.settings.maxLifetimeMs, 600000);
  assert.match(f.output(), /All sandbox traffic routes through this machine/);
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

test("the Together image context bakes in the sandbox server and everything it loads", async (t) => {
  const context = await mkdtemp(join(tmpdir(), "hurdle-image-context-test-"));
  t.after(() => rm(context, { recursive: true, force: true }));
  await writeTogetherImageContext(context, ["claude-code", "codex"]);

  const dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
  assert.equal(dockerfile, togetherImageDockerfile(["claude-code", "codex"]));
  assert.ok(dockerfile.startsWith(togetherSandboxDockerfile(["claude-code", "codex"]).trimEnd()));
  assert.match(dockerfile, /\nCOPY hurdle\/ \/opt\/hurdle\/\nRUN cd \/opt\/hurdle && npm ci /);

  const harness = join(import.meta.dirname, "..");
  for (const file of IMAGE_CONTEXT_FILES)
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
    TOGETHER_SERVER_COMMAND,
    "node /opt/hurdle/harness/bin/hurdle-sandbox-server.mjs",
  );
});
