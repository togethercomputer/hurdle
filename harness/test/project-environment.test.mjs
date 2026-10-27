import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProjectEnvironment } from "../lib/project-environment.mjs";

test("project .env.local overrides stale inherited credentials", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "tae-project-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env.local"), [
    "ANTHROPIC_API_KEY=working-local-key",
    "CUSTOM_SETTING=tae-claude:v2",
    "",
  ].join("\n"));

  const selected = loadProjectEnvironment(cwd, {
    ANTHROPIC_API_KEY: "stale-shell-key",
    TOGETHER_API_KEY: "shell-together-key",
  });

  assert.equal(selected.environment.ANTHROPIC_API_KEY, "working-local-key");
  assert.equal(selected.environment.TOGETHER_API_KEY, "shell-together-key");
  assert.equal(selected.environment.CUSTOM_SETTING, "tae-claude:v2");
  assert.match(selected.source, /^\.env\.local/);
});

test("a byte order mark does not hide the first .env.local credential", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "tae-project-env-bom-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env.local"), "\uFEFFANTHROPIC_API_KEY=local-key\nOTHER=value\n");

  const selected = loadProjectEnvironment(cwd, {});

  assert.equal(selected.environment.ANTHROPIC_API_KEY, "local-key");
  assert.equal(Object.keys(selected.environment).some((name) => name.startsWith("\uFEFF")), false);
});

test("project environment falls back to a copy of the shell", () => {
  const selected = loadProjectEnvironment("/directory/that/does/not/exist", { SAFE: "value" });
  assert.deepEqual(selected.environment, { SAFE: "value" });
  assert.equal(selected.source, "shell environment");
});
