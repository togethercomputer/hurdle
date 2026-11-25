import assert from "node:assert/strict";
import test from "node:test";

import {
  checkAnthropicCredential,
  checkPostgresCredential,
  checkTogetherCredential,
  runCredentialPreflight,
} from "../lib/credential-preflight.mjs";
import { normalizePostgresConnectionString, postgresConnectionFailure } from "../lib/postgres-connection-string.mjs";

function response(status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name === "content-length" ? String(bytes.length) : null; } },
    async arrayBuffer() { return bytes; },
  };
}

test("Anthropic preflight makes a bounded Sonnet request without exposing the key", async () => {
  let request;
  const result = await checkAnthropicCredential("secret-anthropic", {
    async fetch(url, options) {
      request = { url, options };
      return response(200, { type: "message" });
    },
  });

  assert.deepEqual(result, {
    provider: "Anthropic",
    status: "pass",
    message: "claude-sonnet-4-6 request succeeded",
  });
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.options.headers["x-api-key"], "secret-anthropic");
  assert.equal(JSON.parse(request.options.body).max_tokens, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret-anthropic/);
});

test("Anthropic preflight gives a safe low-credit diagnosis", async () => {
  const result = await checkAnthropicCredential("secret", {
    fetch: async () => response(400, { error: { message: "Your credit balance is too low" } }),
  });
  assert.deepEqual(result, {
    provider: "Anthropic",
    status: "fail",
    message: "authenticated, but the credit balance is too low",
  });
});

test("Together preflight verifies one native tool call on a serverless model", async () => {
  const requests = [];
  const result = await checkTogetherCredential("secret-together", {
    async fetch(url, options) {
      requests.push({ url, options });
      return response(200, { choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] });
    },
  });

  assert.deepEqual(result, {
    provider: "Together",
    status: "pass",
    message: "Qwen/Qwen3.5-9B native tool calling succeeded",
  });
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://api.together.xyz/v1/chat/completions",
  ]);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, "Qwen/Qwen3.5-9B");
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(body.max_tokens, 32);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "preflight" } });
  assert.equal(requests[0].options.headers.authorization, "Bearer secret-together");
  assert.doesNotMatch(JSON.stringify(result), /secret-together/);
});

test("Together preflight names a retired model instead of a bare HTTP 400", async () => {
  const result = await checkTogetherCredential("secret-together", {
    fetch: async () => response(400, {
      error: {
        message: "Unable to access non-serverless model Qwen/Qwen3.5-9B.",
        type: "invalid_request_error",
        code: "model_not_available",
      },
    }),
  });
  assert.deepEqual(result, {
    provider: "Together",
    status: "fail",
    message: "authenticated, but the preflight model is no longer served; Hurdle needs an update",
  });
});

test("Postgres preflight is read-only and reports migration state", async () => {
  const queries = [];
  let selectedConnectionString;
  let released = false;
  let ended = false;
  const result = await checkPostgresCredential("postgresql://secret", {
    createPool(connectionString) {
      selectedConnectionString = connectionString;
      return {
        async connect() {
          return {
            async query(sql) {
              queries.push(sql);
              return sql === "SELECT 1" ? { rows: [{ "?column?": 1 }] } : { rows: [{ runs: "hurdle.runs" }] };
            },
            release() { released = true; },
          };
        },
        async end() { ended = true; },
      };
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(selectedConnectionString, "postgresql://secret");
  assert.deepEqual(queries, ["SELECT 1", "SELECT to_regclass('hurdle.runs') AS runs, to_regclass('tae.runs') AS legacy_runs"]);
  assert.equal(released, true);
  assert.equal(ended, true);
  assert.doesNotMatch(JSON.stringify(result), /postgresql|secret/);
});

test("Postgres preflight directs legacy stores to setup without changing either schema", async () => {
  for (const [runs, legacy_runs, status, message] of [
    [null, "tae.runs", "warning", /result schema needs upgrading/],
    ["hurdle.runs", "tae.runs", "fail", /resolve the schema conflict/],
    [null, null, "warning", /result schema needs initializing/],
  ]) {
    const queries = [];
    const result = await checkPostgresCredential("postgresql://example", { createPool: () => ({
      connect: async () => ({ query: async sql => { queries.push(sql); return { rows: [{ runs, legacy_runs }] }; }, release() {} }),
      async end() {},
    }) });
    assert.equal(result.status, status);
    assert.match(result.message, message);
    if (status === "warning") assert.equal(result.code, "postgres.setup-required");
    assert.ok(queries.every(sql => sql.startsWith("SELECT ")));
  }
});

test("Postgres preflight preserves pg 8 strict TLS semantics without its deprecation warning", async () => {
  let selectedConnectionString;
  await checkPostgresCredential("postgresql://user:secret@example.test/db?sslmode=require", {
    createPool(connectionString) {
      selectedConnectionString = connectionString;
      return {
        async connect() {
          return {
            async query(sql) {
              return sql === "SELECT 1" ? { rows: [{}] } : { rows: [{ runs: null }] };
            },
            release() {},
          };
        },
        async end() {},
      };
    },
  });
  const parsed = new URL(selectedConnectionString);
  assert.equal(parsed.searchParams.get("sslmode"), "verify-full");
});

test("every Postgres connection path preserves pg 8 strict TLS semantics", () => {
  for (const mode of ["prefer", "require", "verify-ca"]) {
    const selected = normalizePostgresConnectionString(
      `postgresql://user:secret@example.test/db?sslmode=${mode}`,
    );
    assert.equal(new URL(selected).searchParams.get("sslmode"), "verify-full");
  }

  const explicit = "postgresql://example.test/db?sslmode=disable";
  assert.equal(normalizePostgresConnectionString(explicit), explicit);
  assert.equal(normalizePostgresConnectionString("not a URL"), "not a URL");
});

test("unconfigured services are skipped and the aggregate remains secret-safe", async () => {
  const results = await runCredentialPreflight({}, {
    fetch: async () => { throw new Error("must not be called"); },
    createPool: () => { throw new Error("must not be called"); },
  });
  assert.equal(results.length, 3);
  assert.ok(results.every(({ status }) => status === "skip"));
});

test("Postgres connection failures name the cause without echoing connection details", async () => {
  // Shapes observed from pg 8 against a real server and unreachable targets.
  const failure = (fields) => Object.assign(new Error(fields.message ?? "failed"), fields);
  const cases = [
    [{ code: "28P01", message: 'password authentication failed for user "private-user"' }, /^credential rejected/],
    [{ code: "28000", message: 'role "private-user" does not exist' }, /^credential rejected/],
    [{ code: "3D000", message: 'database "private-db" does not exist' }, /database named in the connection URL does not exist/],
    [{ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND private-host.example" }, /host .* could not be resolved/],
    [{ code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.0.0.7:5432" }, /refused the connection/],
    [{ message: "Connection terminated due to connection timeout" }, /timed out/],
    [{ message: "The server does not support SSL connections" }, /TLS connection failed/],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in certificate chain" }, /TLS connection failed/],
    [{ code: "ERR_INVALID_URL", message: "Invalid URL" }, /connection URL is invalid/],
    [{ code: "XX000", message: "private internal detail" }, /^database could not be reached$/],
  ];
  for (const [fields, expected] of cases) {
    const result = await checkPostgresCredential("postgresql://private-user:private-password@private-host.example/private-db", {
      createPool: () => ({ async connect() { throw failure(fields); }, async end() {} }),
    });
    assert.equal(result.status, "fail");
    assert.match(result.message, expected, JSON.stringify(fields));
    assert.doesNotMatch(result.message, /private|10\.0\.0\.7/);
    assert.equal(postgresConnectionFailure(failure(fields)), result.message);
  }
});
