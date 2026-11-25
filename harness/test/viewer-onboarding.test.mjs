import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createViewerOnboarding, validateViewerOnboarding } from "../lib/viewer-onboarding.mjs";

test("Viewer commands use npx and preserve selected Suite/Runtime arguments as literal shell words", t => {
  if (process.platform === "win32") return t.skip("POSIX shell guidance");
  const root = mkdtempSync(join(tmpdir(), "hurdle-viewer-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project '$(echo unexpected)' dir");
  mkdirSync(join(cwd, "evals"), { recursive: true });
  writeFileSync(join(cwd, "example.suite.mjs"), "");
  writeFileSync(join(cwd, "evals", "custom '$(echo unexpected)' suite.suite.mjs"), "");
  const capture = join(root, "args.jsonl");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npx = join(bin, "npx");
  writeFileSync(npx, `#!${process.execPath}\nconst {appendFileSync}=require("node:fs"); appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2))+"\\n");`);
  chmodSync(npx, 0o755);
  const context = createViewerOnboarding({
    cwd, cliPath: "/unused/cli.mjs", sourceCheckout: true,
    suite: "evals/custom '$(echo unexpected)' suite.suite.mjs",
    runtimeProfile: { sourcePath: join(cwd, "runtime ' file.json"), environment: { kind: "together" } },
  });
  const result = spawnSync("/bin/sh", [], {
    input: context.commands, encoding: "utf8", cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse), [
    ["hurdle", "run", "custom '$(echo unexpected)' suite", "--runtime", "runtime ' file.json", "--view"],
  ]);
  assert.equal(context.runtimeLabel, "Together sandbox");
  assert.doesNotMatch(context.commands, /alias|node |cd |validate/);
});

test("installed Viewer commands select the requested Local store rather than a discovered Runtime", () => {
  const context = createViewerOnboarding({
    cwd: "/project", cliPath: "/package/cli.mjs", sourceCheckout: false, suite: "example.suite.mjs",
    runtimeProfile: { sourcePath: null, environment: { kind: "local" }, resultStore: { kind: "local", root: "/project/custom-results" } },
  });
  assert.doesNotMatch(context.commands, /validate/);
  assert.match(context.commands, /npx hurdle run --environment local --store custom-results/);
  assert.equal(context.setupCommand, "npx hurdle setup");
});

test("a store override conflicting with a saved Runtime does not suggest an incorrect run", () => {
  const context = createViewerOnboarding({
    cwd: "/project", cliPath: "/package/cli.mjs", sourceCheckout: false, suite: "example.suite.mjs", storeOverride: true,
    runtimeProfile: { sourcePath: "/project/runtime.json", environment: { kind: "together" } },
  });
  assert.equal(context.commands, null);
});

test("Viewer display metadata rejects extra fields and control characters", () => {
  const context = { projectDirectory: "/project", commands: "hurdle run", setupCommand: "hurdle setup", runtimeLabel: "Local" };
  assert.deepEqual(validateViewerOnboarding(context), context);
  assert.throws(() => validateViewerOnboarding({ ...context, ANTHROPIC_API_KEY: "secret" }), /invalid/);
  assert.throws(() => validateViewerOnboarding({ ...context, commands: "bad\u001bcommand" }), /invalid/);
});


test("first-run steps create a missing evaluation, set up Together and open results with short commands", t => {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-first-run-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtimeProfile = { sourcePath: null, environment: { kind: "local" }, resultStore: { kind: "local", root: join(cwd, ".hurdle/results-v1") } };
  const context = createViewerOnboarding({ cwd, suite: "example.suite.mjs", runtimeProfile });
  assert.deepEqual(context.steps.map(step => step.command), ["npx hurdle init", "npx hurdle setup", "npx hurdle run --view"]);
  assert.equal(context.commands, "npx hurdle init\nnpx hurdle setup\nnpx hurdle run --view");
  assert.doesNotMatch(context.commands, /results-v1|--environment|--runtime/);

  mkdirSync(join(cwd, "evals", "sandbox-smoke"), { recursive: true });
  writeFileSync(join(cwd, "evals", "sandbox-smoke", "example.suite.mjs"), "");
  writeFileSync(join(cwd, "example.suite.mjs"), "");
  const implicit = createViewerOnboarding({ cwd, runtimeProfile });
  assert.deepEqual(implicit.steps.map(step => step.command), ["npx hurdle setup", "npx hurdle run --view"]);
  const authored = createViewerOnboarding({ cwd, suite: "evals/sandbox-smoke/example.suite.mjs", runtimeProfile });
  assert.deepEqual(authored.steps.map(step => step.command), ["npx hurdle setup sandbox-smoke", "npx hurdle run sandbox-smoke --view"]);
  const configured = createViewerOnboarding({ cwd, suite: "evals/sandbox-smoke/example.suite.mjs", runtimeProfile: { ...runtimeProfile, sourcePath: join(cwd, ".hurdle/runtime/default.json"), environment: { kind: "together" } } });
  assert.deepEqual(configured.steps.map(step => step.command), ["npx hurdle run sandbox-smoke --view"]);
});

test("initialization uses a fresh folder and ambiguous Suite names retain their explicit path", t => {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-first-run-folders-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "evals/my-eval"), { recursive: true });
  const runtimeProfile = { sourcePath: null, environment: { kind: "local" }, resultStore: { kind: "local", root: join(cwd, ".hurdle/results-v1") } };
  const context = createViewerOnboarding({ cwd, suite: "example.suite.mjs", runtimeProfile });
  assert.deepEqual(context.steps.map(step => step.command), ["npx hurdle init evals/my-eval-2", "npx hurdle setup evals/my-eval-2/example.suite.mjs", "npx hurdle run evals/my-eval-2/example.suite.mjs --view"]);
  for (const directory of ["a/copy", "b/copy"]) {
    mkdirSync(join(cwd, directory), { recursive: true });
    writeFileSync(join(cwd, directory, "example.suite.mjs"), "");
  }
  const ambiguous = createViewerOnboarding({ cwd, suite: "a/copy/example.suite.mjs", runtimeProfile });
  assert.equal(ambiguous.steps[0].command, "npx hurdle setup a/copy/example.suite.mjs");
});

test("onboarding steps remain bounded, closed display metadata", () => {
  const context = { projectDirectory: "/project", commands: "npx hurdle run --view", setupCommand: "npx hurdle setup", runtimeLabel: "Together sandbox", steps: [{ title: "Run and view results", command: "npx hurdle run --view" }] };
  assert.deepEqual(validateViewerOnboarding(context), context);
  for (const steps of [[], Array(4).fill(context.steps[0]), [{...context.steps[0], credential: "secret"}], [{ title: "Run\nunsafe", command: "npx hurdle run" }], [{ title: "Run", command: "bad\u001bcommand" }]]) {
    assert.throws(() => validateViewerOnboarding({ ...context, steps }), /invalid/);
  }
});
