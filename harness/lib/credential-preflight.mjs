import { normalizePostgresConnectionString, postgresConnectionFailure } from "./postgres-connection-string.mjs";
import { hurdleEnvironmentValue, RESULT_STORE_DATABASE_URL_ENV } from "./hurdle-environment.mjs";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const TOGETHER_CHAT_URL = "https://api.together.xyz/v1/chat/completions";

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
// Together's model list still includes retired models, so only a completion
// proves a model is served. Together offers no serverless embedding models,
// so preflight checks the key with one native tool call only.
const TOGETHER_CHAT_MODEL = "Qwen/Qwen3.5-9B";
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;

function result(provider, status, message, code) {
  return Object.freeze({ provider, status, message, ...(code ? { code } : {}) });
}

function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function boundedJson(response) {
  const contentLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_LIMIT_BYTES) return null;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > RESPONSE_LIMIT_BYTES) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function knownProviderFailure(provider, response, body) {
  const message = typeof body?.error?.message === "string"
    ? body.error.message
    : typeof body?.message === "string" ? body.message : "";
  if (/credit balance|insufficient (?:credit|funds)|billing/iu.test(message)) {
    return result(provider, "fail", "authenticated, but the credit balance is too low");
  }
  if (body?.error?.code === "model_not_available") {
    return result(provider, "fail", "authenticated, but the preflight model is no longer served; Hurdle needs an update");
  }
  if ([401, 403].includes(response?.status)) {
    return result(provider, "fail", `credential rejected (HTTP ${response.status})`);
  }
  return result(provider, "fail", `provider request failed (HTTP ${response?.status ?? "unknown"})`);
}

async function postJson(fetch, url, { headers, body }) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: requestSignal(),
  });
}

export async function checkAnthropicCredential(apiKey, { fetch = globalThis.fetch } = {}) {
  if (!apiKey?.trim()) return result("Anthropic", "skip", "ANTHROPIC_API_KEY is not set");
  try {
    const response = await postJson(fetch, ANTHROPIC_MESSAGES_URL, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: ANTHROPIC_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with OK." }],
      },
    });
    const body = await boundedJson(response);
    if (!response.ok) return knownProviderFailure("Anthropic", response, body);
    if (body?.type !== "message") {
      return result("Anthropic", "fail", "provider returned an unexpected response");
    }
    return result("Anthropic", "pass", `${ANTHROPIC_MODEL} request succeeded`);
  } catch {
    return result("Anthropic", "fail", "request could not reach the provider");
  }
}

export async function checkTogetherCredential(apiKey, { fetch = globalThis.fetch } = {}) {
  if (!apiKey?.trim()) return result("Together", "skip", "TOGETHER_API_KEY is not set");
  try {
    const chatResponse = await postJson(fetch, TOGETHER_CHAT_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: TOGETHER_CHAT_MODEL,
        max_tokens: 32,
        // Reasoning would spend the token budget before the tool call.
        reasoning: { enabled: false },
        messages: [{ role: "user", content: "Use the preflight tool once." }],
        tools: [{
          type: "function",
          function: {
            name: "preflight",
            description: "Confirm that native tool calling works.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        }],
        tool_choice: { type: "function", function: { name: "preflight" } },
      },
    });
    const chatBody = await boundedJson(chatResponse);
    if (!chatResponse.ok) return knownProviderFailure("Together", chatResponse, chatBody);
    if (!Array.isArray(chatBody?.choices?.[0]?.message?.tool_calls)) {
      return result("Together", "fail", "native tool calling returned an unexpected response");
    }
    return result("Together", "pass", `${TOGETHER_CHAT_MODEL} native tool calling succeeded`);
  } catch {
    return result("Together", "fail", "request could not reach the provider");
  }
}

export async function checkPostgresCredential(connectionString, { createPool } = {}) {
  if (!connectionString?.trim()) {
    return result("Postgres", "skip", `${RESULT_STORE_DATABASE_URL_ENV} is not set`);
  }
  let pool;
  let client;
  try {
    if (!createPool) {
      const { createPostgresResultStorePool } = await import("./postgres-result-store-connection.mjs");
      createPool = (value) => createPostgresResultStorePool(value, { max: 1 });
    }
    const selectedConnectionString = normalizePostgresConnectionString(connectionString);
    pool = createPool(selectedConnectionString);
    client = await pool.connect();
    await client.query("SELECT 1");
    const schema = await client.query("SELECT to_regclass('hurdle.runs') AS runs, to_regclass('tae.runs') AS legacy_runs");
    if (schema.rows?.[0]?.runs && schema.rows?.[0]?.legacy_runs) {
      return result("Postgres", "fail", "connection succeeded; both tae and hurdle schemas contain results; resolve the schema conflict before setup");
    }
    if (schema.rows?.[0]?.runs) return result("Postgres", "pass", "connection succeeded; hurdle schema is present");
    return result("Postgres", "warning", schema.rows?.[0]?.legacy_runs
      ? "connected, but the result schema needs upgrading"
      : "connected, but the result schema needs initializing", "postgres.setup-required");
  } catch (error) {
    return result("Postgres", "fail", postgresConnectionFailure(error));
  } finally {
    client?.release?.();
    try {
      await pool?.end?.();
    } catch { /* a failed close does not expose connection details */ }
  }
}

export async function runCredentialPreflight(environment, dependencies = {}) {
  return Promise.all([
    checkAnthropicCredential(environment.ANTHROPIC_API_KEY, dependencies),
    checkTogetherCredential(environment.TOGETHER_API_KEY, dependencies),
    checkPostgresCredential(hurdleEnvironmentValue(environment, RESULT_STORE_DATABASE_URL_ENV), dependencies),
  ]);
}
