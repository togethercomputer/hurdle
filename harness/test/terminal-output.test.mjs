import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { quoteCommandArgument, cliExecutable } from "../lib/terminal-output.mjs";
import { createQuickstartViewerOutput } from "../lib/source-quickstart.mjs";

const sourceExecutable = cliExecutable();
const cliPath = fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url));

function output(cwd, isTTY) {
  let stdout = "", stderr = "";
  return {
    io: { cwd, stdin: { isTTY: false }, stdout: { isTTY, write(v) { stdout += v; } }, stderr: { isTTY, write(v) { stderr += v; } } },
    read: () => ({ stdout, stderr }),
  };
}

test("init, validation, setup, and help share terminal styling without ANSI in redirected/NO_COLOR output", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = process.env.NO_COLOR;
  t.after(() => original === undefined ? delete process.env.NO_COLOR : process.env.NO_COLOR = original);
  const cli = createFrameworkCli({ env: {}, promptSetup: async () => null, checkAgentReadiness: async () => ({ ok: true, checks: [{ status: "pass", message: "Credentials verified" }] }) });
  for (const [name, isTTY, noColor] of [["color", true, false], ["pipe", false, false], ["no-color", true, true]]) {
    if (noColor) process.env.NO_COLOR = "1"; else delete process.env.NO_COLOR;
    const capture = output(root, isTTY);
    assert.equal(await cli.main(["init", name, "--example", "together-api"], capture.io), 0);
    assert.equal(await cli.main(["validate", `${name}/example.suite.mjs`, "--offline"], capture.io), 0);
    // Missing credentials stop setup before any network call or template build.
    assert.equal(await cli.main(["setup", `${name}/example.suite.mjs`], capture.io), 1);
    assert.equal(await cli.main(["help", "init"], capture.io), 0);
    assert.equal(await cli.main(["init", "--agent", "unknown"], capture.io), 2);
    const raw = capture.read();
    const text = stripVTControlCharacters(raw.stdout);
    assert.equal((text.match(/^Hurdle$/gm) ?? []).length, 4);
    assert.match(text, /✓ Evaluation created/);
    assert.match(text, /! Readiness not checked/);
    assert.match(text, /✗ hurdle \[setup\.credentials-missing\] Missing credentials: TOGETHER_API_KEY; ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN\./);
    assert.ok(text.includes(`Next      ${sourceExecutable} setup ${name}/example.suite.mjs`));
    assert.equal(existsSync(join(root, ".hurdle")), false);
    if (isTTY && !noColor) {
      assert.match(raw.stdout, /\u001b\[1mHurdle/);
      assert.match(raw.stdout, /\u001b\[32m✓/);
      assert.match(raw.stdout, /\u001b\[33m!/);
      assert.match(raw.stdout, /\u001b\[31m✗/);
      assert.match(raw.stderr, /\u001b\[31m✗/);
    } else assert.doesNotMatch(raw.stdout + raw.stderr, /\u001b/);
  }
});

test("custom-suite next steps are concise and round-trip shell metacharacters safely", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-output-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = "evals/a ' $(touch unexpected) `touch unexpected`";
  const suite = `${directory}/example.suite.mjs`;
  mkdirSync(join(root, "evals"));
  const capture = output(root, false);
  const cli = createFrameworkCli();
  assert.equal(await cli.main(["init", directory, "--example", "together-api"], capture.io), 0);
  const commands = capture.read().stdout.split("\n").filter(line => line.includes(`${sourceExecutable} setup`) || line.includes(`${sourceExecutable} run`));
  assert.equal(commands.length, 2);
  for (const line of commands) {
    const command = line.slice(line.indexOf(sourceExecutable));
    const parsed = spawnSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { cwd: root, encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(parsed.stdout.trimEnd().split("\n"), ["node", cliPath, command.includes(" setup ") ? "setup" : "run", suite, ...(command.endsWith(" --view") ? ["--view"] : command.endsWith(" --yes") ? ["--yes"] : [])]);
  }
  assert.equal(existsSync(join(root, "unexpected")), false);
  assert.equal(quoteCommandArgument("evals/together-api/example.suite.mjs"), "evals/together-api/example.suite.mjs");
});

test("a source init Next command executes the same CLI from a fresh project", t => {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-source-next-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const initialized = spawnSync(process.execPath, [cliPath, "init"], { cwd, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const next = initialized.stdout.split("\n").find(line => /^  Next\s+/.test(line)).replace(/^  Next\s+/, "");
  assert.equal(next, `${sourceExecutable} validate`);
  assert.ok(initialized.stdout.includes(`see ${sourceExecutable} help init`));
  const followed = spawnSync("/bin/sh", ["-c", `${next} --offline`], { cwd, encoding: "utf8" });
  assert.equal(followed.status, 0, followed.stderr);
  assert.match(followed.stdout, /claude-opus-5-5 · medium effort/);
  const unknown = spawnSync(process.execPath, [cliPath, "unknown"], { cwd, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.includes(`Run ${sourceExecutable} help.`));
});

test("checkout guidance uses npx only when the project bin resolves to this CLI", async t => {
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal(cliExecutable(checkout), "npx hurdle");
  const capture = output(checkout, false);
  assert.equal(await createFrameworkCli().main(["suites"], capture.io), 0);
  assert.match(capture.read().stdout, /Run by name or path:\n  npx hurdle run /);

  const cwd = mkdtempSync(join(tmpdir(), "hurdle-checkout-bin-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "hurdle", bin: { hurdle: "cli.mjs" } }));
  writeFileSync(join(cwd, "cli.mjs"), "// A different CLI must not be selected by a recovery hint.\n");
  assert.equal(cliExecutable(cwd), sourceExecutable);
  rmSync(join(cwd, "cli.mjs"));
  symlinkSync(cliPath, join(cwd, "cli.mjs"));
  assert.equal(cliExecutable(cwd), "npx hurdle", "a project's linked bin can safely use npx");
});

test("source executable paths with shell metacharacters round-trip safely", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-source-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "clone ' $(touch unexpected) `touch unexpected`");
  mkdirSync(join(checkout, "harness/lib"), { recursive: true });
  mkdirSync(join(checkout, "harness/bin"));
  mkdirSync(join(checkout, "viewer"));
  writeFileSync(join(checkout, "viewer/package.json"), "{}");
  writeFileSync(join(checkout, "harness/bin/hurdle.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  copyFileSync(fileURLToPath(new URL("../lib/terminal-output.mjs", import.meta.url)), join(checkout, "harness/lib/terminal-output.mjs"));
  const { suiteCommand } = await import(pathToFileURL(join(checkout, "harness/lib/terminal-output.mjs")));
  const next = suiteCommand("validate", "evals/example.suite.mjs");
  const followed = spawnSync("/bin/sh", ["-c", `${next} --offline`], { cwd: root, encoding: "utf8" });
  assert.equal(followed.status, 0, followed.stderr);
  assert.deepEqual(JSON.parse(followed.stdout), ["validate", "--offline"]);
  assert.equal(existsSync(join(root, "unexpected")), false);
});

test("source runtime tools share formatting without making provider requests", t => {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-source-output-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (file, args = []) => spawnSync(process.execPath, [fileURLToPath(new URL(`../bin/${file}`, import.meta.url)), ...args], {
    cwd, encoding: "utf8", env: { PATH: process.env.PATH },
  });
  const created = run("init-runtime.mjs", ["together"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Hurdle\n\n✓ Runtime created/);
  assert.match(created.stdout, /Runtime   \.hurdle\/runtime\/together.json/);
  assert.match(created.stdout, /Next      npm run preflight/);
  const duplicate = run("init-runtime.mjs", ["together"]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /^✗ .*already exists/);
  const checked = run("preflight.mjs");
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /Hurdle\n\n  Source/);
  assert.match(checked.stdout, /! No configured credentials found/);
  const migrated = run("migrate-postgres-result-store.mjs");
  assert.equal(migrated.status, 1);
  assert.match(migrated.stderr, /^✗ hurdle \[migration-failed\]/);
  assert.doesNotMatch(created.stdout + duplicate.stderr + checked.stdout + migrated.stderr, /\u001b/);
});

test("source quickstart stops its spinner when the current Viewer output is ready", async () => {
  let text = "", ready = 0;
  const cli = createFrameworkCli({ async launchViewer({ onReady }) {
    onReady("http://127.0.0.1:3000");
    return { kind: "stopped" };
  } });
  const stream = { isTTY: true, write(value) { text += value; } };
  const stdout = createQuickstartViewerOutput({ stream, onReady() { ready++; } });
  assert.equal(await cli.main(["view", "--store", "/tmp/hurdle-output-results"], { cwd: "/tmp", stdout, stderr: { write() {} } }), 0);
  const plain = stripVTControlCharacters(text);
  assert.equal(ready, 1);
  assert.doesNotMatch(plain, /^Hurdle$/m);
  assert.match(plain, /✓ Viewer ready/);
  assert.match(plain, /URL       http:\/\/127.0.0.1:3000/);
  assert.match(plain, /Store     Filesystem/);
  assert.match(plain, /Results   hurdle-output-results/);
});
