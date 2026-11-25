import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { ensureSetupCredentials } from "../lib/setup-credentials.mjs";
import { saveCredentials } from "../lib/setup-project-files.mjs";
import { cliExecutable } from "../lib/terminal-output.mjs";

const PROTECTED = "/.env.local\n/.hurdle/\n/.tae/\n";
const EXAMPLES = ["copy-message", "together-api", "concurrency-smoke", "kitchen-sink"];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), "hurdle-first-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let text = "";
  const io = { cwd: root, stdout: { write(value) { text += value; } }, stderr: { write(value) { text += value; } } };
  return { root, io, output: () => stripVTControlCharacters(text) };
}

function shellCommands(markdown) {
  return [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(([, block]) => block.trim().split("\n"));
}

test("starter READMEs give npx users commands that work in their own project", async t => {
  const f = project(t);
  const cli = createFrameworkCli();
  for (const example of EXAMPLES) {
    assert.equal(await cli.main(["init", example, "--example", example], f.io), 0, f.output());
  }
  for (const example of ["copy-message", "together-api"]) {
    const readme = readFileSync(join(f.root, example, "README.md"), "utf8");
    const commands = shellCommands(readme);
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.match(command, /^npx hurdle /, `${example} README: ${command}`);
      assert.doesNotMatch(command, /harness\/|examples\//, `${example} README: ${command}`);
    }
    assert.doesNotMatch(readme, /`hurdle init|`init --/, "init examples include npx hurdle");
  }
});

test("init keeps .env.local and results out of git without clobbering .gitignore", async t => {
  const fresh = project(t);
  const cli = createFrameworkCli();
  assert.equal(await cli.main(["init"], fresh.io), 0, fresh.output());
  assert.equal(readFileSync(join(fresh.root, ".gitignore"), "utf8"), PROTECTED);
  assert.match(fresh.output(), /^  Git\s+Added \.env\.local and \.hurdle\/ to \.gitignore$/m);

  // A second starter and a later setup leave the file as it is.
  assert.equal(await cli.main(["init", "codex-evals", "--agent", "codex"], fresh.io), 0, fresh.output());
  await saveCredentials(fresh.root, {});
  assert.equal(readFileSync(join(fresh.root, ".gitignore"), "utf8"), PROTECTED);
  assert.equal((fresh.output().match(/^  Git\s/gm) ?? []).length, 1, "init reports only a change");

  const existing = project(t);
  writeFileSync(join(existing.root, ".gitignore"), "node_modules/\n!.env.local");
  assert.equal(await cli.main(["init"], existing.io), 0, existing.output());
  assert.equal(readFileSync(join(existing.root, ".gitignore"), "utf8"), `node_modules/\n!.env.local\n${PROTECTED}`);

  // A failed write still leaves a working starter and says what to do.
  const linked = project(t);
  writeFileSync(join(linked.root, "elsewhere"), "keep\n");
  symlinkSync(join(linked.root, "elsewhere"), join(linked.root, ".gitignore"));
  assert.equal(await cli.main(["init"], linked.io), 0, linked.output());
  assert.equal(existsSync(join(linked.root, "evals", "example.suite.mjs")), true);
  assert.equal(lstatSync(join(linked.root, ".gitignore")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(linked.root, "elsewhere"), "utf8"), "keep\n");
  assert.match(linked.output(), /^  Git\s+Could not update \.gitignore; add \/\.env\.local and \/\.hurdle\/ to it yourself$/m);

  // A failed init changes nothing.
  const failed = project(t);
  assert.equal(await cli.main(["init", "missing/evals"], failed.io), 1);
  assert.equal(existsSync(join(failed.root, ".gitignore")), false);
});

test("init and run suggest setup, as the README does", async t => {
  const f = project(t);
  const cli = createFrameworkCli();
  assert.equal(await cli.main(["init", "api-evals", "--example", "together-api"], f.io), 0, f.output());
  const executable = cliExecutable(f.root);
  assert.match(f.output(), /^  Needs\s+Together sandbox \+ TOGETHER_API_KEY$/m);
  assert.ok(f.output().includes(`Next      ${executable} setup api-evals/example.suite.mjs\n`), f.output());

  const g = project(t);
  assert.equal(await cli.main(["init", "--example", "together-api"], g.io), 0, g.output());
  assert.ok(g.output().includes(`Next      ${executable} setup\n`), g.output());
  // The Local Runtime cannot capture API traffic, so run stops before any work.
  assert.equal(await cli.main(["run"], g.io), 1);
  assert.ok(g.output().includes(`Run \`${executable} setup\` to configure the Together sandbox`), g.output());
});

test("setup names a key once when the sandbox and a Task both need it", async () => {
  const requirements = [
    { label: "Together sandbox", anyOf: ["TOGETHER_API_KEY"] },
    { label: "Claude Code", anyOf: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
    { label: "Task", anyOf: ["TOGETHER_API_KEY"] },
  ];
  await assert.rejects(
    ensureSetupCredentials({ requirements, environment: {}, interactive: false, report: {} }),
    error => {
      assert.equal(error.code, "setup.credentials-missing");
      assert.match(error.message, /^Missing credentials: TOGETHER_API_KEY; ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN\. /);
      return true;
    },
  );
});
