import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecretText } from "./evidence-redaction.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_PAGES = 10;
const TIMEOUT_MS = 10_000;
const nonblank = value => typeof value === "string" && value.trim().length > 0;

export class ModelDiscoveryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = () => new ModelDiscoveryError("models.invalid-catalog", "The model catalog returned invalid or oversized data. Retry or supply --model MODEL directly.");
const unavailable = () => new ModelDiscoveryError("models.unavailable", "Model discovery failed. Check connectivity or update the runner; you can still supply --model MODEL directly.");
const cancelled = () => new ModelDiscoveryError("models.cancelled", "Model discovery was cancelled.");

function secrets(env) {
  return [env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, env.CODEX_API_KEY, env.OPENAI_API_KEY, env.CODEX_ACCESS_TOKEN].filter(nonblank);
}
function safeString(value, privateValues, max = 256) {
  return typeof value === "string" && value.trim() && value.length <= max
    && !/[\x00-\x1f\x7f]/.test(value) && redactSecretText(value, privateValues) === value ? value : null;
}
function efforts(values, privateValues) {
  if (!Array.isArray(values)) return null;
  const result = values.map(value => safeString(value, privateValues, 64));
  if (result.some(value => value === null)) throw invalid();
  return [...new Set(result)];
}
function catalogDate(value) {
  const milliseconds = typeof value === "number" ? value * 1000
    : typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15
    ? new Date(milliseconds).toISOString() : null;
}

// Presentation only: the complete catalog and explicit --model IDs stay available.
export function selectCatalogModels(catalog, { all = false } = {}) {
  if (all) return { ...catalog, models: [...catalog.models] };
  const ids = new Set(catalog.models.map(model => model.id));
  const models = catalog.models.filter(model => {
    if (model.lifecycle && model.lifecycle !== "active") return false;
    if (catalog.agent === "codex" && model.compatibility !== "agent-catalog") {
      // The Models API has no modality/coding metadata. This is a conservative
      // naming heuristic, never a runner allowlist; unfamiliar IDs remain in --all.
      if (!/^(?:gpt-\d|o\d)/i.test(model.id)
        || /(?:^|-)(?:audio|image|realtime|transcribe|tts|search|deep-research|instruct)(?:-|$)/i.test(model.id)) return false;
    }
    const alias = model.id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
    return alias === model.id || !ids.has(alias);
  });
  // Unknown/epoch dates retain upstream ordering, including a cached native list.
  models.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { ...catalog, models: models.slice(0, 10) };
}
function normalizeModel(value, agent, privateValues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const id = safeString(agent === "codex" ? value.model ?? value.id : value.id, privateValues);
  if (!id) throw invalid();
  const supported = agent === "codex" ? value.supportedReasoningEfforts?.map?.(entry => entry?.reasoningEffort)
    : value.capabilities?.effort ? Object.entries(value.capabilities.effort)
      .filter(([key, entry]) => key !== "supported" && entry?.supported === true).map(([key]) => key) : null;
  return {
    id,
    name: safeString(agent === "codex" ? value.displayName : value.display_name, privateValues) ?? id,
    reasoningEfforts: efforts(supported, privateValues),
    defaultReasoningEffort: agent === "codex" ? safeString(value.defaultReasoningEffort, privateValues, 64) : null,
    isDefault: agent === "codex" && value.isDefault === true,
    lifecycle: agent === "claude-code" ? safeString(value.lifecycle, privateValues, 64) : null,
    createdAt: catalogDate(agent === "claude-code" ? value.created_at : value.created),
    compatibility: agent === "codex" ? "agent-catalog" : "provider-catalog",
  };
}
function addPage(models, data, agent, privateValues) {
  if (!Array.isArray(data) || data.length > MAX_MODELS || models.size + data.length > MAX_MODELS) throw invalid();
  for (const value of data) {
    if (agent === "codex" && value?.hidden === true) continue;
    const model = normalizeModel(value, agent, privateValues);
    if (!models.has(model.id)) models.set(model.id, model);
  }
}
async function readJson(response, signal) {
  let size = 0;
  const chunks = [];
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new Error("Model catalog read cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw invalid();
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw invalid(); }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.cancel().catch(() => {});
  }
}

async function anthropicModels(env, { fetch, signal }) {
  if (!nonblank(env.ANTHROPIC_API_KEY)) {
    throw new ModelDiscoveryError("models.credentials-missing", "Claude model discovery requires ANTHROPIC_API_KEY in .env.local or the shell. OAuth discovery is unavailable; you can still supply a Claude model ID or alias directly.");
  }
  const models = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await fetch(url.href, {
      method: "GET", redirect: "error", signal,
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      const message = response.status === 401 ? "Anthropic rejected ANTHROPIC_API_KEY. Set a valid key, then retry."
        : response.status === 403 ? "Anthropic denied model discovery. Check the API key's permissions."
        : "Anthropic model discovery is temporarily unavailable. Retry later or supply --model MODEL directly.";
      throw new ModelDiscoveryError(response.status === 401 ? "models.auth-rejected" : response.status === 403 ? "models.auth-forbidden" : "models.unavailable", message);
    }
    const result = await readJson(response, signal);
    addPage(models, result?.data, "claude-code", secrets(env));
    if (result.has_more === false) return [...models.values()];
    if (result.has_more !== true || !safeString(result.last_id, [], 512) || cursors.has(result.last_id)) throw invalid();
    cursor = result.last_id;
    cursors.add(cursor);
  }
  throw invalid();
}

async function openaiModels(env, key, { fetch, signal }) {
  const response = await fetch("https://api.openai.com/v1/models", {
    method: "GET", redirect: "error", signal, headers: { authorization: `Bearer ${key}` },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    const message = response.status === 401 ? "OpenAI rejected the configured API key. Set a valid CODEX_API_KEY or OPENAI_API_KEY, then retry."
      : response.status === 403 ? "OpenAI denied model discovery. Check the configured API key's permissions."
      : "OpenAI's live catalog could not be refreshed. Check the configured API key and connectivity.";
    throw new ModelDiscoveryError("models.provider-unavailable", message);
  }
  const result = await readJson(response, signal);
  const models = new Map();
  addPage(models, result?.data, "openai", secrets(env));
  return [...models.values()];
}

async function codexModels(env, { spawn, signal }) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-models-"));
  let child;
  let closed;
  let failure;
  const pending = new Map();
  let requestId = 0;
  let buffer = "";
  let bytes = 0;
  const terminate = signalName => {
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill(signalName);
      else process.kill(-child.pid, signalName);
    } catch { /* Already terminated. */ }
  };
  const fail = error => {
    failure ??= error;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
    terminate("SIGTERM");
  };
  const abort = () => fail(cancelled());
  try {
    const selectedEnv = { PATH: env.PATH ?? "", HOME: root, CODEX_HOME: root, ...(process.platform === "win32" ? { SystemRoot: env.SystemRoot } : {}) };
    if (nonblank(env.CODEX_API_KEY)) selectedEnv.CODEX_API_KEY = env.CODEX_API_KEY;
    else if (nonblank(env.OPENAI_API_KEY)) selectedEnv.CODEX_API_KEY = env.OPENAI_API_KEY;
    // Isolated HOME and cwd exclude interactive credentials and project plugins.
    child = spawn("codex", ["app-server"], { cwd: root, env: selectedEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    closed = new Promise(resolve => child.once("close", resolve));
    child.on("error", () => fail(new ModelDiscoveryError("models.runner-unavailable", "Codex could not start. Install or update Codex and ensure it is on PATH; --model MODEL remains available.")));
    child.on("close", () => fail(failure ?? unavailable()));
    child.stdin.on("error", () => fail(unavailable()));
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) fail(invalid()); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) return fail(invalid());
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { return fail(invalid()); }
        const request = pending.get(response?.id);
        if (!request) continue; // Notifications never trigger a thread or turn.
        pending.delete(response.id);
        if (response.error) {
          request.reject(new ModelDiscoveryError("models.runner-unavailable", "Codex model discovery failed. Update Codex, or supply --model MODEL directly."));
        } else if (!Object.hasOwn(response, "result")) request.reject(invalid());
        else request.resolve(response.result);
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, error => { if (error) fail(unavailable()); });
    });
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    await rpc("initialize", { clientInfo: { name: "hurdle", title: "Hurdle model discovery", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const models = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await rpc("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      addPage(models, result?.data, "codex", secrets(env));
      if (result.nextCursor === null) return [...models.values()];
      if (!safeString(result.nextCursor, [], 512) || cursors.has(result.nextCursor)) throw invalid();
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw invalid();
  } finally {
    signal.removeEventListener("abort", abort);
    child?.stdin.end();
    terminate("SIGTERM");
    if (closed) {
      const force = setTimeout(() => terminate("SIGKILL"), 1000);
      try { await closed; } finally { clearTimeout(force); terminate("SIGKILL"); }
    }
    await rm(root, { recursive: true, force: true });
  }
}

// IDs the installed Codex CLI knows. For any other model it falls back to
// generic metadata and drops tools such as apply_patch.
export async function listLocalCodexModels({ env = process.env, signal = AbortSignal.timeout(TIMEOUT_MS) } = {}, { spawn = nodeSpawn } = {}) {
  return (await codexModels(env, { spawn, signal })).map((model) => model.id);
}

export async function discoverModels({ agent, env = process.env, signal }, { fetch = globalThis.fetch, spawn = nodeSpawn, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    if (!["claude-code", "codex"].includes(agent)) throw new ModelDiscoveryError("argument-error", "Use models --agent claude-code|codex [--json].");
    let models, source, compatibility;
    const warnings = [];
    if (agent === "claude-code") {
      models = await anthropicModels(env, { fetch, signal: combined });
      source = "Anthropic Models API";
      compatibility = "provider-catalog";
    } else {
      // Same precedence as the Codex Adapter.
      const key = nonblank(env.CODEX_API_KEY) ? env.CODEX_API_KEY : nonblank(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : null;
      const [native, provider] = await Promise.allSettled([
        codexModels(env, { spawn, signal: combined }),
        key ? openaiModels(env, key, { fetch, signal: combined }) : Promise.resolve(null),
      ]);
      combined.throwIfAborted();
      const nativeModels = native.status === "fulfilled" ? native.value : null;
      const providerModels = provider.status === "fulfilled" ? provider.value : null;
      if (!nativeModels && !providerModels) throw native.reason;
      const merged = new Map((nativeModels ?? []).map(model => [model.id, model]));
      for (const model of providerModels ?? []) {
        const nativeModel = merged.get(model.id);
        merged.set(model.id, nativeModel ? { ...nativeModel, createdAt: model.createdAt } : model);
      }
      models = [...merged.values()];
      // Native entries replace provider-only metadata for matching IDs.
      source = nativeModels && providerModels ? "local Codex model/list + OpenAI Models API"
        : nativeModels ? "local Codex model/list (may be cached)" : "OpenAI Models API";
      compatibility = nativeModels && providerModels ? "mixed" : nativeModels ? "agent-catalog" : "provider-catalog";
      if (native.status === "rejected") warnings.push("Local Codex discovery is unavailable; provider IDs have unverified runner compatibility.");
      if (provider.status === "rejected") warnings.push(`${provider.reason instanceof ModelDiscoveryError ? provider.reason.message : "OpenAI's live catalog could not be refreshed."} Showing Codex's potentially cached catalog; newer models may be missing.`);
      if (!key && nativeModels) warnings.push("No API key selected for a live provider catalog; Codex's catalog may omit newer models.");
    }
    return {
      agent,
      source, compatibility, warnings,
      accessVerified: false,
      models,
    };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (controller.signal.aborted) throw new ModelDiscoveryError("models.timeout", "Model discovery exceeded its time limit. Retry or supply --model MODEL directly.");
    if (error instanceof ModelDiscoveryError) throw error;
    throw unavailable();
  } finally { clearTimeout(deadline); }
}
