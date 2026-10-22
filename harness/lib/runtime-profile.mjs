import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultLocalStoreRoot } from "./project-paths.mjs";
import { canonicalEnvironmentName, hurdleEnvironmentValue } from "./hurdle-environment.mjs";

import {
  ANTHROPIC_JSON_JUDGE_ID,
  ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
} from "./judges/anthropic-json.mjs";

import { normalizeTogetherSettings } from "./execution-environments/together.mjs";
import { normalizeTogetherLiteSettings } from "./execution-environments/together-lite.mjs";

const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_COLLECTION_ITEMS = 256;
const MAX_SETTINGS_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTERPOLATION = /\$\{|\{\{/;
const SECRET_FIELD = /api[^a-z0-9]*key|token|secret|password|credential|authorization|private[^a-z0-9]*key|cookie/i;

export class RuntimeProfileError extends Error {
  constructor(code, message, { sourcePath = null, pointer = "/", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeProfileError";
    this.code = code;
    this.sourcePath = sourcePath;
    this.pointer = pointer;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictJson(source, sourcePath) {
  let index = 0;
  const error = (message) => {
    throw new RuntimeProfileError("runtime.profile-json", message, { sourcePath });
  };
  const skipWhitespace = () => {
    while ([" ", "\t", "\n", "\r"].includes(source[index])) index += 1;
  };
  const string = () => {
    const start = index;
    if (source[index] !== '"') error("Runtime Profile contains invalid JSON.");
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          error("Runtime Profile contains invalid JSON.");
        }
      }
      if (character.charCodeAt(0) < 0x20) error("Runtime Profile contains invalid JSON.");
      if (character === "\\") {
        index += 1;
        const escape = source[index];
        if (!'"\\/bfnrtu'.includes(escape ?? "")) error("Runtime Profile contains invalid JSON.");
        if (escape === "u") {
          const unicode = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(unicode)) error("Runtime Profile contains invalid JSON.");
          index += 4;
        }
      }
      index += 1;
    }
    error("Runtime Profile contains invalid JSON.");
  };
  const value = (depth = 0) => {
    if (depth > MAX_JSON_DEPTH) error("Runtime Profile JSON exceeds the maximum nesting depth.");
    skipWhitespace();
    const character = source[index];
    if (character === '"') return string();
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const object = {};
      const keys = new Set();
      if (source[index] === "}") {
        index += 1;
        return object;
      }
      for (let count = 0; ; count += 1) {
        if (count >= MAX_COLLECTION_ITEMS) error("Runtime Profile JSON has too many object properties.");
        skipWhitespace();
        const key = string();
        if (keys.has(key)) error(`Runtime Profile contains duplicate decoded JSON key '${key}'.`);
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ":") error("Runtime Profile contains invalid JSON.");
        index += 1;
        const child = value(depth + 1);
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: true,
          value: child,
          writable: true,
        });
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return object;
        }
        if (source[index] !== ",") error("Runtime Profile contains invalid JSON.");
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      const array = [];
      if (source[index] === "]") {
        index += 1;
        return array;
      }
      for (let count = 0; ; count += 1) {
        if (count >= MAX_COLLECTION_ITEMS) error("Runtime Profile JSON has too many array items.");
        array.push(value(depth + 1));
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return array;
        }
        if (source[index] !== ",") error("Runtime Profile contains invalid JSON.");
        index += 1;
      }
    }
    const primitive = source.slice(index).match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
    );
    if (!primitive) error("Runtime Profile contains invalid JSON.");
    index += primitive[0].length;
    try {
      return JSON.parse(primitive[0]);
    } catch {
      error("Runtime Profile contains invalid JSON.");
    }
  };

  const parsed = value();
  skipWhitespace();
  if (index !== source.length) error("Runtime Profile contains invalid JSON.");
  return parsed;
}

function schemaError(message, sourcePath, pointer = "/") {
  throw new RuntimeProfileError("runtime.profile-schema", message, { sourcePath, pointer });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, { allowed, required }, sourcePath, pointer) {
  if (!isRecord(value)) schemaError("Runtime Profile field must be an object.", sourcePath, pointer);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) schemaError(`Runtime Profile does not allow '${key}'.`, sourcePath, pointer);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) schemaError(`Runtime Profile requires '${key}'.`, sourcePath, pointer);
  }
}

function nonblankString(value, label, sourcePath, pointer, maximum = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    schemaError(`${label} must be a nonblank string no longer than ${maximum} characters.`, sourcePath, pointer);
  }
  if (INTERPOLATION.test(value)) schemaError(`${label} must not use interpolation syntax.`, sourcePath, pointer);
  return value;
}

function environmentName(value, label, sourcePath, pointer) {
  nonblankString(value, label, sourcePath, pointer);
  if (!ENV_NAME.test(value)) schemaError(`${label} must be a valid environment variable name.`, sourcePath, pointer);
  return value;
}

function validateJson(value, sourcePath, pointer, depth = 0) {
  if (depth > MAX_JSON_DEPTH) schemaError("Runtime Profile settings exceed the maximum nesting depth.", sourcePath, pointer);
  if (typeof value === "string") {
    if (value.length > 16 * 1024) schemaError("Runtime Profile string exceeds 16384 characters.", sourcePath, pointer);
    if (INTERPOLATION.test(value)) schemaError("Runtime Profile string must not use interpolation syntax.", sourcePath, pointer);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) schemaError("Runtime Profile number must be finite.", sourcePath, pointer);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) schemaError("Runtime Profile settings array is too large.", sourcePath, pointer);
    value.forEach((item, itemIndex) => validateJson(item, sourcePath, `${pointer}/${itemIndex}`, depth + 1));
    return;
  }
  if (!isRecord(value)) schemaError("Runtime Profile setting is not JSON.", sourcePath, pointer);
  const entries = Object.entries(value);
  if (entries.length > MAX_COLLECTION_ITEMS) schemaError("Runtime Profile settings object is too large.", sourcePath, pointer);
  for (const [key, child] of entries) {
    nonblankString(key, "Runtime Profile settings key", sourcePath, pointer, 256);
    if (SECRET_FIELD.test(key)) {
      schemaError(
        "Runtime Profile settings must name secrets through a dedicated environment field.",
        sourcePath,
        `${pointer}/${key}`,
      );
    }
    validateJson(child, sourcePath, `${pointer}/${key}`, depth + 1);
  }
}

function settings(value, sourcePath, pointer) {
  if (!isRecord(value)) schemaError("Runtime Profile settings must be a JSON object.", sourcePath, pointer);
  validateJson(value, sourcePath, pointer);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SETTINGS_BYTES) {
    schemaError("Runtime Profile settings exceed 65536 bytes.", sourcePath, pointer);
  }
  return structuredClone(value);
}

function e2bSettings(value, sourcePath) {
  const normalized = settings(value, sourcePath, "/environment/settings");
  const allowed = new Set([
    "captureProfile",
    "workloadTemplate",
    "guardianTemplate",
    "region",
    "cpuCount",
    "memoryMiB",
    "maxLifetimeMs",
  ]);
  for (const key of Object.keys(normalized)) {
    if (!allowed.has(key)) schemaError(`E2B settings do not allow '${key}'.`, sourcePath, "/environment/settings");
  }
  for (const key of ["captureProfile", "workloadTemplate", "guardianTemplate"]) {
    if (normalized[key] !== undefined) {
      nonblankString(normalized[key], `E2B ${key}`, sourcePath, `/environment/settings/${key}`);
    }
  }
  if (
    normalized.captureProfile !== undefined
    && normalized.captureProfile !== "external-guardian-http-metadata-v1"
  ) {
    schemaError("E2B captureProfile is not supported.", sourcePath, "/environment/settings/captureProfile");
  }
  if (normalized.region !== undefined && normalized.region !== null) {
    schemaError("E2B region selection is not supported.", sourcePath, "/environment/settings/region");
  }
  for (const [key, minimum, maximum] of [
    ["cpuCount", 1, 64],
    ["memoryMiB", 512, 262_144],
    ["maxLifetimeMs", 1_000, 86_400_000],
  ]) {
    if (normalized[key] !== undefined) {
      positiveInteger(normalized[key], `E2B ${key}`, minimum, maximum, sourcePath, `/environment/settings/${key}`);
    }
  }
  return normalized;
}

function positiveInteger(value, label, minimum, maximum, sourcePath, pointer) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    schemaError(`${label} must be an integer from ${minimum} to ${maximum}.`, sourcePath, pointer);
  }
  return value;
}

function resolveProfilePath(value, label, sourcePath, pointer) {
  return resolve(dirname(sourcePath), nonblankString(value, label, sourcePath, pointer, 4096));
}

function normalizedEnvironment(value, sourcePath) {
  exactObject(value, { allowed: ["kind", "apiKeyEnv", "settings"], required: ["kind"] }, sourcePath, "/environment");
  if (value.kind === "local") {
    if (Object.hasOwn(value, "apiKeyEnv")) schemaError("Local Environment does not allow 'apiKeyEnv'.", sourcePath, "/environment/apiKeyEnv");
    const normalizedSettings = settings(value.settings ?? {}, sourcePath, "/environment/settings");
    if (Object.keys(normalizedSettings).length > 0) {
      schemaError("Local Environment settings must be empty.", sourcePath, "/environment/settings");
    }
    return { kind: "local", settings: normalizedSettings };
  }
  if (value.kind === "e2b") {
    if (!Object.hasOwn(value, "apiKeyEnv")) schemaError("E2B Environment requires 'apiKeyEnv'.", sourcePath, "/environment/apiKeyEnv");
    return {
      kind: "e2b",
      apiKeyEnv: environmentName(value.apiKeyEnv, "E2B apiKeyEnv", sourcePath, "/environment/apiKeyEnv"),
      settings: e2bSettings(value.settings ?? {}, sourcePath),
    };
  }
  if (value.kind === "together") {
    if (!Object.hasOwn(value, "apiKeyEnv")) schemaError("Together Environment requires 'apiKeyEnv'.", sourcePath, "/environment/apiKeyEnv");
    const input = settings(value.settings ?? {}, sourcePath, "/environment/settings");
    try { normalizeTogetherSettings(input); }
    catch (error) { schemaError(error.message, sourcePath, "/environment/settings"); }
    return { kind: "together", apiKeyEnv: environmentName(value.apiKeyEnv, "Together apiKeyEnv", sourcePath, "/environment/apiKeyEnv"), settings: input };
  }
  if (value.kind === "together-lite") {
    if (!Object.hasOwn(value, "apiKeyEnv")) schemaError("Together Lite Environment requires 'apiKeyEnv'.", sourcePath, "/environment/apiKeyEnv");
    const input = settings(value.settings ?? {}, sourcePath, "/environment/settings");
    // The image is the unit of work on this backend, so the profile names it.
    try { normalizeTogetherLiteSettings(input); }
    catch (error) { schemaError(error.message, sourcePath, "/environment/settings"); }
    return { kind: "together-lite", apiKeyEnv: environmentName(value.apiKeyEnv, "Together Lite apiKeyEnv", sourcePath, "/environment/apiKeyEnv"), settings: input };
  }
  schemaError("Runtime Profile Environment kind must be 'local', 'e2b', 'together', or 'together-lite'.", sourcePath, "/environment/kind");
}

function normalizedResultStore(value, sourcePath) {
  exactObject(value, { allowed: ["kind", "root", "databaseUrlEnv", "artifactRoot"], required: ["kind"] }, sourcePath, "/resultStore");
  if (value.kind === "local") {
    if (!Object.hasOwn(value, "root")) schemaError("Local Result Store requires 'root'.", sourcePath, "/resultStore/root");
    if (Object.hasOwn(value, "databaseUrlEnv") || Object.hasOwn(value, "artifactRoot")) schemaError("Local Result Store only allows 'kind' and 'root'.", sourcePath, "/resultStore");
    return { kind: "local", root: resolveProfilePath(value.root, "Local Result Store root", sourcePath, "/resultStore/root") };
  }
  if (value.kind === "postgres") {
    if (!Object.hasOwn(value, "databaseUrlEnv") || !Object.hasOwn(value, "artifactRoot")) {
      schemaError("Postgres Result Store requires 'databaseUrlEnv' and 'artifactRoot'.", sourcePath, "/resultStore");
    }
    return {
      kind: "postgres",
      databaseUrlEnv: environmentName(value.databaseUrlEnv, "Postgres databaseUrlEnv", sourcePath, "/resultStore/databaseUrlEnv"),
      artifactRoot: resolveProfilePath(value.artifactRoot, "Postgres artifactRoot", sourcePath, "/resultStore/artifactRoot"),
    };
  }
  schemaError("Runtime Profile Result Store kind must be 'local' or 'postgres'.", sourcePath, "/resultStore/kind");
}

function normalizedJudge(value, sourcePath) {
  if (value === undefined) return undefined;
  exactObject(value, { allowed: ["kind", "model", "credentialEnv"], required: ["kind", "model", "credentialEnv"] }, sourcePath, "/judge");
  if (value.kind !== "anthropic-json-v1") schemaError("Runtime Profile Judge kind must be 'anthropic-json-v1'.", sourcePath, "/judge/kind");
  return {
    kind: value.kind,
    model: nonblankString(value.model, "Judge model", sourcePath, "/judge/model"),
    credentialEnv: environmentName(value.credentialEnv, "Judge credentialEnv", sourcePath, "/judge/credentialEnv"),
  };
}

function normalizedViewer(value, sourcePath) {
  if (value === undefined) return { port: 3000 };
  exactObject(value, { allowed: ["port"], required: [] }, sourcePath, "/viewer");
  return { port: value.port === undefined ? 3000 : positiveInteger(value.port, "Viewer port", 1, 65_535, sourcePath, "/viewer/port") };
}

function normalizedProfile(parsed, sourcePath) {
  exactObject(parsed, { allowed: ["schemaVersion", "environment", "resultStore", "judge", "viewer"], required: ["schemaVersion", "environment", "resultStore"] }, sourcePath, "/");
  if (parsed.schemaVersion !== 1) schemaError("Runtime Profile schemaVersion must be 1.", sourcePath, "/schemaVersion");
  return {
    sourcePath,
    schemaVersion: 1,
    environment: normalizedEnvironment(parsed.environment, sourcePath),
    resultStore: normalizedResultStore(parsed.resultStore, sourcePath),
    ...(parsed.judge === undefined ? {} : { judge: normalizedJudge(parsed.judge, sourcePath) }),
    viewer: normalizedViewer(parsed.viewer, sourcePath),
  };
}

export function resolveRuntimeProfile({ runtimePath, cwd, defaultRoot } = {}, { readFile = readFileSync } = {}) {
  if (runtimePath === undefined) {
    return deepFreeze({
      sourcePath: null,
      schemaVersion: 1,
      environment: { kind: "local", settings: {} },
      resultStore: { kind: "local", root: defaultLocalStoreRoot(defaultRoot ?? cwd) },
      viewer: { port: 3000 },
    });
  }
  if (typeof runtimePath !== "string" || !runtimePath.trim()) {
    throw new RuntimeProfileError("runtime.profile-schema", "Runtime Profile path must be nonblank.");
  }
  const sourcePath = resolve(cwd, runtimePath);
  let source;
  try {
    source = readFile(sourcePath, "utf8");
  } catch (cause) {
    throw new RuntimeProfileError("runtime.profile-read", "Runtime Profile could not be read.", { sourcePath, cause });
  }
  if (typeof source !== "string") source = Buffer.from(source).toString("utf8");
  // RFC 8259 lets parsers ignore a byte order mark; some editors add one.
  source = source.replace(/^\uFEFF/, "");
  if (Buffer.byteLength(source) > MAX_PROFILE_BYTES) {
    throw new RuntimeProfileError("runtime.profile-schema", "Runtime Profile exceeds 262144 bytes.", { sourcePath });
  }
  return deepFreeze(normalizedProfile(strictJson(source, sourcePath), sourcePath));
}

export function describeRuntimeJudgeCapability(profile) {
  if (!profile?.judge) return null;
  return deepFreeze({
    judgeId: ANTHROPIC_JSON_JUDGE_ID,
    model: profile.judge.model,
    inputSchemaVersions: [2],
    maxTimeoutMs: ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
    maxInputBytes: ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
    maxOutputBytes: ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
  });
}

function resolveNamedSecret(name, env) {
  const value = hurdleEnvironmentValue(env, name);
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeProfileError(
      "runtime.secret-missing",
      `Runtime Profile requires named secret '${canonicalEnvironmentName(name)}'.`,
    );
  }
  return value;
}

export function resolveRuntimeSecrets(profile, env = process.env, needs = {}) {
  const resolved = {};
  if (profile?.environment?.kind === "e2b" && needs.environment !== false) {
    resolved.e2bApiKey = resolveNamedSecret(profile.environment.apiKeyEnv, env);
  }
  if ((profile?.environment?.kind === "together" || profile?.environment?.kind === "together-lite")
    && needs.environment !== false) {
    resolved.togetherApiKey = resolveNamedSecret(profile.environment.apiKeyEnv, env);
  }
  if (profile?.resultStore?.kind === "postgres" && needs.resultStore !== false) {
    resolved.postgresDatabaseUrl = resolveNamedSecret(profile.resultStore.databaseUrlEnv, env);
  }
  if (profile?.judge && needs.judge === true) {
    resolved.judgeCredential = resolveNamedSecret(profile.judge.credentialEnv, env);
  }
  return deepFreeze(resolved);
}

export function viewerStoreEnvironment(profile, env = process.env) {
  if (profile?.resultStore?.kind === "local") {
    return deepFreeze({
      HURDLE_RESULT_STORE_MODE: "local",
      HURDLE_RESULT_STORE_ROOT: profile.resultStore.root,
    });
  }
  if (profile?.resultStore?.kind === "postgres") {
    return deepFreeze({
      HURDLE_RESULT_STORE_MODE: "postgres",
      HURDLE_RESULT_STORE_DATABASE_URL: resolveNamedSecret(
        profile.resultStore.databaseUrlEnv,
        env,
      ),
    });
  }
  throw new TypeError("Runtime Profile Result Store is invalid");
}
