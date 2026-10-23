import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeConfig, initializeRuntime } from "../lib/runtime-init.mjs";

test("runtime init creates the three supported backend combinations", () => {
  const e2b = createRuntimeConfig("e2b", { template: "tae-claude:v1" });
  assert.equal(e2b.environment.kind, "e2b");
  assert.equal(e2b.environment.settings.workloadTemplate, "tae-claude:v1");
  assert.equal(e2b.resultStore.kind, "local");
  assert.equal(e2b.viewer.port, 3000);

  const postgres = createRuntimeConfig("postgres");
  assert.equal(postgres.environment.kind, "local");
  assert.equal(postgres.resultStore.kind, "postgres");
  assert.equal(postgres.viewer.port, 3001);

  const combined = createRuntimeConfig("e2b-postgres", { template: "tae-claude:v1" });
  assert.equal(combined.environment.kind, "e2b");
  assert.equal(combined.resultStore.kind, "postgres");
});

test("Together runtime init uses Together's Hurdle image unless a snapshot is named", () => {
  const image = createRuntimeConfig("together");
  assert.equal(image.environment.kind, "together");
  assert.deepEqual(image.environment.settings, { maxLifetimeMs: 3_600_000 });
  assert.equal(image.resultStore.root, "../together-results-v1");

  const snapshot = createRuntimeConfig("together-postgres", { snapshot: "mine@v1" });
  assert.equal(snapshot.environment.settings.snapshotAlias, "mine@v1");
  assert.equal(snapshot.environment.settings.cpuCount, 1);
  assert.equal(snapshot.resultStore.kind, "postgres");
  assert.throws(() => createRuntimeConfig("together", { snapshot: " " }), /must not be empty/);
});

test("E2B runtime init requires the caller's template", () => {
  assert.throws(
    () => createRuntimeConfig("e2b"),
    /requires a workload template/,
  );
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
