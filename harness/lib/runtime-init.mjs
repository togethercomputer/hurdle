import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RESULT_STORE_DATABASE_URL_ENV } from "./hurdle-environment.mjs";

const MODES = new Set(["postgres", "together", "together-postgres"]);

function localEnvironment() {
  return { kind: "local", settings: {} };
}

function postgresStore() {
  return {
    kind: "postgres",
    databaseUrlEnv: RESULT_STORE_DATABASE_URL_ENV,
    artifactRoot: "../postgres-artifacts",
  };
}

export function createRuntimeConfig(mode) {
  if (!MODES.has(mode)) {
    throw new TypeError("Runtime kind must be postgres, together, or together-postgres.");
  }
  const usesTogether = mode === "together" || mode === "together-postgres";
  const usesPostgres = mode.endsWith("postgres");
  // Runs use Together's Hurdle image over its socket.
  const togetherSettings = { maxLifetimeMs: 3_600_000 };
  return Object.freeze({
    schemaVersion: 1,
    environment: usesTogether ? { kind: "together", apiKeyEnv: "TOGETHER_API_KEY", settings: togetherSettings } : localEnvironment(),
    resultStore: usesPostgres ? postgresStore() : { kind: "local", root: "../together-results-v1" },
    judge: {
      kind: "anthropic-json-v1",
      model: "claude-opus-4-8",
      credentialEnv: "ANTHROPIC_API_KEY",
    },
    viewer: { port: usesPostgres ? 3001 : 3000 },
  });
}

export async function initializeRuntime({ cwd, mode }) {
  const relativePath = `.hurdle/runtime/${mode}.json`;
  const path = resolve(cwd, relativePath);
  const config = createRuntimeConfig(mode);
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
