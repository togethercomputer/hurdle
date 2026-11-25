import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  RuntimeProfileError,
  describeRuntimeJudgeCapability,
  resolveRuntimeProfile,
  resolveRuntimeSecrets,
  viewerStoreEnvironment,
} from "../lib/runtime-profile.mjs";

test("resolveRuntimeProfile preserves the built-in Local topology without a runtime file", () => {
  const cwd = resolve("/workspace/current");
  const defaultRoot = resolve("/workspace/evals");

  const profile = resolveRuntimeProfile({
    command: "run",
    runtimePath: undefined,
    cwd,
    defaultRoot,
  });

  assert.deepEqual(profile, {
    sourcePath: null,
    schemaVersion: 1,
    environment: { kind: "local", settings: {} },
    resultStore: { kind: "local", root: resolve(defaultRoot, ".hurdle/results-v1") },
    viewer: { port: 3000 },
  });
  assert.equal(Object.isFrozen(profile), true);
});

test("resolveRuntimeProfile anchors profile paths to the Runtime Profile file", () => {
  const cwd = resolve("/workspace/current");
  const sourcePath = resolve(cwd, "config/runtime.json");
  const profile = resolveRuntimeProfile(
    { command: "run", runtimePath: "config/runtime.json", cwd },
    {
      readFile(path, encoding) {
        assert.equal(path, sourcePath);
        assert.equal(encoding, "utf8");
        return JSON.stringify({
          schemaVersion: 1,
          environment: { kind: "local", settings: {} },
          resultStore: { kind: "local", root: "results" },
          viewer: { port: 4310 },
        });
      },
    },
  );

  assert.deepEqual(profile, {
    sourcePath,
    schemaVersion: 1,
    environment: { kind: "local", settings: {} },
    resultStore: { kind: "local", root: resolve(cwd, "config/results") },
    viewer: { port: 4310 },
  });
});

test("resolveRuntimeProfile ignores a UTF-8 byte order mark", () => {
  const profile = resolveRuntimeProfile(
    { runtimePath: "runtime.json", cwd: resolve("/workspace/current") },
    {
      readFile: () => `\uFEFF${JSON.stringify({
        schemaVersion: 1,
        environment: { kind: "local" },
        resultStore: { kind: "local", root: "results" },
      })}`,
    },
  );

  assert.equal(profile.environment.kind, "local");
});

test("resolveRuntimeProfile rejects duplicate decoded JSON keys and closed-profile violations", () => {
  const cwd = resolve("/workspace/current");
  const invalidProfiles = [
    [
      '{"schemaVersion":1,"environment":{"kind":"local","kind":"together"},"resultStore":{"kind":"local","root":"results"}}',
      "runtime.profile-json",
    ],
    [
      '{"schemaVersion":1,"environment":{"kind":"local","settings":{}},"resultStore":{"kind":"local","root":"results"},"secret":"literal"}',
      "runtime.profile-schema",
    ],
    [
      '{"schemaVersion":1,"environment":{"kind":"together","apiKeyEnv":"TOGETHER_${ENV}"},"resultStore":{"kind":"local","root":"results"}}',
      "runtime.profile-schema",
    ],
    [
      '{"schemaVersion":1,"environment":{"kind":"local"},"resultStore":{"kind":"local","root":"results"},"viewer":{"port":0}}',
      "runtime.profile-schema",
    ],
    [
      '{"schemaVersion":1,"environment":{"kind":"together","apiKeyEnv":"TOGETHER_KEY","settings":{"maxLifetimeMs":0}},"resultStore":{"kind":"local","root":"results"}}',
      "runtime.profile-schema",
    ],
    [
      '{"schemaVersion":1,"environment":{"kind":"local","settings":{"nested":{"apiKey":"literal-secret"}}},"resultStore":{"kind":"local","root":"results"}}',
      "runtime.profile-schema",
    ],
    [
      '{"schemaVersion":1,"environment":{"kind":"local","settings":{"auth":"postgresql://user:password@host/db"}},"resultStore":{"kind":"local","root":"results"}}',
      "runtime.profile-schema",
    ],
  ];

  for (const [source, code] of invalidProfiles) {
    assert.throws(
      () => resolveRuntimeProfile(
        { command: "run", runtimePath: "runtime.json", cwd },
        { readFile: () => source },
      ),
      (error) => error instanceof RuntimeProfileError && error.code === code,
    );
  }
});

test("Runtime Profile exposes a fixed Judge capability without reading its credential", () => {
  const profile = resolveRuntimeProfile(
    { runtimePath: "runtime.json", cwd: "/workspace" },
    {
      readFile: () => JSON.stringify({
        schemaVersion: 1,
        environment: { kind: "together", apiKeyEnv: "TOGETHER_KEY" },
        resultStore: {
          kind: "postgres",
          databaseUrlEnv: "DATABASE_URL",
          artifactRoot: "artifacts",
        },
        judge: {
          kind: "anthropic-json-v1",
          model: "claude-test",
          credentialEnv: "ANTHROPIC_API_KEY",
        },
      }),
    },
  );

  assert.deepEqual(describeRuntimeJudgeCapability(profile), {
    judgeId: "anthropic-json-v1",
    model: "claude-test",
    inputSchemaVersions: [2],
    maxTimeoutMs: 120_000,
    maxInputBytes: 1_048_576,
    maxOutputBytes: 4_096,
  });
  assert.deepEqual(
    resolveRuntimeSecrets(profile, {
      TOGETHER_KEY: "together-secret",
      DATABASE_URL: "postgres-secret",
      ANTHROPIC_API_KEY: "judge-secret",
    }),
    { togetherApiKey: "together-secret", postgresDatabaseUrl: "postgres-secret" },
  );
  assert.deepEqual(
    resolveRuntimeSecrets(
      profile,
      { TOGETHER_KEY: "together-secret", DATABASE_URL: "postgres-secret", ANTHROPIC_API_KEY: "judge-secret" },
      { judge: true },
    ),
    {
      togetherApiKey: "together-secret",
      postgresDatabaseUrl: "postgres-secret",
      judgeCredential: "judge-secret",
    },
  );
});

test("Runtime Profile derives Viewer environment from only the selected Result Store", () => {
  const local = resolveRuntimeProfile({ command: "view", cwd: "/workspace" });
  assert.deepEqual(viewerStoreEnvironment(local), {
    HURDLE_RESULT_STORE_MODE: "local",
    HURDLE_RESULT_STORE_ROOT: resolve("/workspace", ".hurdle/results-v1"),
  });

  const postgres = resolveRuntimeProfile(
    { runtimePath: "runtime.json", cwd: "/workspace" },
    {
      readFile: () => JSON.stringify({
        schemaVersion: 1,
        environment: { kind: "local" },
        resultStore: {
          kind: "postgres",
          databaseUrlEnv: "DATABASE_URL",
          artifactRoot: "private-artifacts",
        },
      }),
    },
  );
  assert.deepEqual(viewerStoreEnvironment(postgres, { DATABASE_URL: "postgres-secret" }), {
    HURDLE_RESULT_STORE_MODE: "postgres",
    HURDLE_RESULT_STORE_DATABASE_URL: "postgres-secret",
  });
  assert.throws(
    () => viewerStoreEnvironment(postgres, {}),
    (error) => error instanceof RuntimeProfileError && error.code === "runtime.secret-missing",
  );
});
