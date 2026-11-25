import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeConfig, initializeRuntime } from "../lib/runtime-init.mjs";

test("runtime init creates the supported backend combinations", () => {
  const postgres = createRuntimeConfig("postgres");
  assert.equal(postgres.environment.kind, "local");
  assert.equal(postgres.resultStore.kind, "postgres");
  assert.equal(postgres.viewer.port, 3001);

  const image = createRuntimeConfig("together");
  assert.equal(image.environment.kind, "together");
  assert.deepEqual(image.environment.settings, { maxLifetimeMs: 3_600_000 });
  assert.equal(image.resultStore.root, "../together-results-v1");
  assert.equal(image.viewer.port, 3000);

  const combined = createRuntimeConfig("together-postgres");
  assert.equal(combined.environment.kind, "together");
  assert.equal(combined.resultStore.kind, "postgres");
  assert.throws(() => createRuntimeConfig("e2b"), /Runtime kind must be/);
});

test("runtime init creates a private file and refuses to overwrite it", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "tae-runtime-init-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const first = await initializeRuntime({ cwd, mode: "postgres" });
  const stored = JSON.parse(await readFile(first.path, "utf8"));
  assert.equal(stored.resultStore.kind, "postgres");
  await assert.rejects(
    initializeRuntime({ cwd, mode: "postgres" }),
    /already exists; it was not changed/,
  );
});
