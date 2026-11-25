import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createFrameworkCli } from "../bin/hurdle.mjs";
import { resolveRuntimeProfile } from "../lib/runtime-profile.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const togetherRoot = fileURLToPath(new URL("../../evals/together/", import.meta.url));
const legacyRoot = join(togetherRoot, "legacy");
const legacySuite = join(togetherRoot, "legacy.suite.mjs");
const legacySmokeSuite = join(togetherRoot, "legacy-smoke.suite.mjs");
const togetherRuntime = join(togetherRoot, "runtime", "together.example.json");
test("the Together Runtime example selects Together's Hurdle image and a local Result Store", () => {
  const profile = resolveRuntimeProfile({
    runtimePath: togetherRuntime,
    cwd: togetherRoot,
  });

  assert.deepEqual(profile.environment, {
    kind: "together",
    apiKeyEnv: "TOGETHER_API_KEY",
    settings: { maxLifetimeMs: 600_000 },
  });
  assert.deepEqual(profile.resultStore, {
    kind: "local",
    root: resolve(togetherRoot, "../../.hurdle/together-results-v1"),
  });
  assert.deepEqual(profile.judge, {
    kind: "anthropic-json-v1",
    model: "claude-opus-4-8",
    credentialEnv: "ANTHROPIC_API_KEY",
  });
  assert.equal(profile.viewer.port, 3000);
});
