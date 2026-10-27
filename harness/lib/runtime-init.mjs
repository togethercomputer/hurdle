import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RESULT_STORE_DATABASE_URL_ENV } from "./hurdle-environment.mjs";

const MODES = new Set(["e2b", "postgres", "e2b-postgres", "together", "together-postgres"]);

function e2bEnvironment(template) {
  return {
    kind: "e2b",
    apiKeyEnv: "E2B_API_KEY",
    settings: {
      workloadTemplate: template,
      guardianTemplate: "base",
      cpuCount: 2,
      memoryMiB: 2048,
      maxLifetimeMs: 3_600_000,
    },
  };
}

function localEnvironment() {
  return { kind: "local", settings: {} };
}

function localStore() {
  return { kind: "local", root: "../e2b-results-v1" };
}

function postgresStore() {
  return {
    kind: "postgres",
    databaseUrlEnv: RESULT_STORE_DATABASE_URL_ENV,
    artifactRoot: "../postgres-artifacts",
  };
}

export function createRuntimeConfig(mode, { template, snapshot } = {}) {
  if (!MODES.has(mode)) {
    throw new TypeError("Runtime kind must be e2b, postgres, e2b-postgres, together, or together-postgres.");
  }
  const usesE2b = mode === "e2b" || mode === "e2b-postgres";
  const usesTogether = mode === "together" || mode === "together-postgres";
  if (usesTogether && snapshot !== undefined && (typeof snapshot !== "string" || !snapshot.trim())) throw new TypeError("Together snapshot alias must not be empty.");
  if (usesE2b && (typeof template !== "string" || !template.trim())) {
    throw new TypeError("E2B runtime requires a workload template.");
  }
  const usesPostgres = mode.endsWith("postgres");
  // Without a snapshot alias, runs use Together's Hurdle image over its socket.
  const togetherSettings = {
    ...(snapshot ? { snapshotAlias: snapshot.trim(), cpuCount: 1, memoryMiB: 2048 } : {}),
    maxLifetimeMs: 3_600_000,
  };
  return Object.freeze({
    schemaVersion: 1,
    environment: usesE2b ? e2bEnvironment(template.trim()) : usesTogether ? { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: togetherSettings } : localEnvironment(),
    resultStore: usesPostgres ? postgresStore() : usesTogether ? { kind: "local", root: "../together-results-v1" } : localStore(),
    judge: {
      kind: "anthropic-json-v1",
      model: "claude-opus-4-8",
      credentialEnv: "ANTHROPIC_API_KEY",
    },
    viewer: { port: usesPostgres ? 3001 : 3000 },
  });
}

export async function initializeRuntime({ cwd, mode, template, snapshot }) {
  const relativePath = `.hurdle/runtime/${mode}.json`;
  const path = resolve(cwd, relativePath);
  const config = createRuntimeConfig(mode, { template, snapshot });
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(new Error(`${relativePath} already exists; it was not changed.`), {
        code: "runtime-exists",
      });
    }
    throw error;
  }
  return Object.freeze({ path, relativePath, usesPostgres: mode.endsWith("postgres") });
}
