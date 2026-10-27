import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_JSON_JUDGE_ID,
  createAnthropicJsonJudge,
} from "../lib/judges/anthropic-json.mjs";

function streamingResponse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

test("Anthropic JSON Judge exposes the fixed v2 capability", () => {
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    fetch: async () => { throw new Error("not invoked"); },
  });

  assert.equal(judge.id, ANTHROPIC_JSON_JUDGE_ID);
  assert.equal(judge.model, "claude-test-model");
  assert.deepEqual(judge.inputSchemaVersions, [2]);
  assert.equal(judge.maxTimeoutMs, 120_000);
  assert.equal(judge.maxInputBytes, 1_048_576);
  assert.equal(judge.maxOutputBytes, 4_096);
  assert.ok(Object.isFrozen(judge));
});

test("Anthropic JSON Judge sends the fixed evidence-only Messages protocol and reads streamed JSON", async () => {
  const requests = [];
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch(url, options) {
      requests.push({ url, options });
      return streamingResponse([
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: JSON.stringify({
              outcome: "pass",
              summary: "Evidence satisfies the rubric.",
            }),
          },
        },
        { type: "message_stop" },
      ]);
    },
  });

  const decision = await judge.judge({ schemaVersion: 2, run: { id: "run_1" } });

  assert.deepEqual(decision, {
    outcome: "pass",
    summary: "Evidence satisfies the rubric.",
  });
  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["x-api-key"], "test-anthropic-key");
  assert.equal(options.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(options.body);
  assert.equal(body.model, "claude-test-model");
  assert.equal(body.stream, true);
  assert.equal("temperature" in body, false);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(JSON.parse(body.messages[0].content), { schemaVersion: 2, run: { id: "run_1" } });
  assert.match(body.system, /evidence-only/i);
  assert.match(body.system, /untrusted/i);
  assert.match(body.system, /exactly two keys/i);
  assert.equal("tools" in body, false);
});

test("Anthropic JSON Judge accepts only the exact decision and keeps provider failures secret-safe", async () => {
  const secret = "anthropic-provider-secret";
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    async fetch() {
      return streamingResponse([
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: JSON.stringify({ outcome: "pass", summary: "Looks good.", extra: true }),
          },
        },
        { type: "message_stop" },
      ]);
    },
  });
  await assert.rejects(
    judge.judge({ schemaVersion: 2 }),
    (error) => error.message === "Anthropic JSON Judge returned invalid output"
      && !error.message.includes(secret),
  );

  const failedJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    retryDelayMs: 0,
    async fetch() {
      throw new Error(`upstream rejected ${secret}`);
    },
  });
  await assert.rejects(
    failedJudge.judge({ schemaVersion: 2 }),
    (error) => error.message === "Anthropic JSON Judge provider failed"
      && !error.message.includes(secret),
  );

  const streamedFailureJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    async fetch() {
      return streamingResponse([{ type: "error", error: { message: secret } }]);
    },
  });
  await assert.rejects(
    streamedFailureJudge.judge({ schemaVersion: 2 }),
    (error) => error.message === "Anthropic JSON Judge provider failed"
      && !error.message.includes(secret),
  );
});

test("Anthropic JSON Judge reads the decision after a model's thinking blocks", async () => {
  // Current models think by default and stream thinking before the answer.
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      return streamingResponse([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The rubric asks for 'done'; output pass." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: '{"outcome":"pass","summary":"The transcript says done."}' } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]);
    },
  });

  assert.deepEqual(await judge.judge({ schemaVersion: 2 }), {
    outcome: "pass",
    summary: "The transcript says done.",
  });

  const toolUse = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      return streamingResponse([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "x", input: {} } },
        { type: "message_stop" },
      ]);
    },
  });
  await assert.rejects(toolUse.judge({ schemaVersion: 2 }), /returned invalid output/);
});

test("Anthropic JSON Judge retries transient provider failures before failing closed", async () => {
  const decision = { outcome: "pass", summary: "Evidence satisfies the rubric." };
  const passing = () => streamingResponse([
    { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify(decision) } },
    { type: "message_stop" },
  ]);
  const judgeWith = (fetch) => createAnthropicJsonJudge({
    model: "claude-test-model", apiKey: "test-anthropic-key", retryDelayMs: 0, fetch,
  });

  // Overload, rate limits and dropped connections must not discard a finished Agent run.
  const transient = [
    () => new Response("{}", { status: 529 }),
    () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
  ];
  let calls = 0;
  const recovered = judgeWith(async () => {
    calls += 1;
    return (transient.shift() ?? passing)();
  });
  assert.deepEqual(await recovered.judge({ schemaVersion: 2 }), decision);
  assert.equal(calls, 3);

  let dropped = 0;
  const reconnected = judgeWith(async () => {
    dropped += 1;
    if (dropped === 1) throw new TypeError("fetch failed");
    return passing();
  });
  assert.deepEqual(await reconnected.judge({ schemaVersion: 2 }), decision);

  let overloaded = 0;
  const exhausted = judgeWith(async () => {
    overloaded += 1;
    return new Response("{}", { status: 529 });
  });
  await assert.rejects(exhausted.judge({ schemaVersion: 2 }), /Anthropic JSON Judge provider failed/);
  assert.equal(overloaded, 3);

  let unauthorized = 0;
  const rejected = judgeWith(async () => {
    unauthorized += 1;
    return new Response("{}", { status: 401 });
  });
  await assert.rejects(rejected.judge({ schemaVersion: 2 }), /Anthropic JSON Judge provider failed/);
  assert.equal(unauthorized, 1);

  const controller = new AbortController();
  const waiting = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    retryDelayMs: 60_000,
    async fetch() {
      queueMicrotask(() => controller.abort());
      return new Response("{}", { status: 503 });
    },
  });
  const startedAt = Date.now();
  await assert.rejects(waiting.judge({ schemaVersion: 2 }, { signal: controller.signal }), /provider failed/);
  assert.ok(Date.now() - startedAt < 5_000, "cancellation must interrupt the retry delay");
});

test("Anthropic JSON Judge bounds its wire data and forwards cancellation to fetch", async () => {
  let fetchCalls = 0;
  const boundedJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      fetchCalls += 1;
      throw new Error("should not fetch oversized request");
    },
  });
  await assert.rejects(
    boundedJudge.judge({ schemaVersion: 2, evidence: "x".repeat(1_048_576) }),
    /request exceeds its limit/,
  );
  assert.equal(fetchCalls, 0);

  let escapedFetchCalls = 0;
  const escapedInputJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      escapedFetchCalls += 1;
      return streamingResponse([
        {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: JSON.stringify({ outcome: "pass", summary: "Bounded input accepted." }),
          },
        },
        { type: "message_stop" },
      ]);
    },
  });
  const escapedDecision = await escapedInputJudge.judge({
    schemaVersion: 2,
    evidence: "\\".repeat(500_000),
  });
  assert.equal(escapedFetchCalls, 1);
  assert.equal(escapedDecision.outcome, "pass");

  let receivedSignal = null;
  const controller = new AbortController();
  const cancelledJudge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    fetch(_url, options) {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const pending = cancelledJudge.judge({ schemaVersion: 2 }, { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /provider failed/);
  assert.equal(receivedSignal, controller.signal);
});

test("Anthropic JSON Judge fails closed on a provider error event", async () => {
  let streamCancelled = false;
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "test-anthropic-key",
    async fetch() {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "content_block_delta",
              delta: {
                type: "text_delta",
                text: JSON.stringify({ outcome: "pass", summary: "Must not survive." }),
              },
            })}\n\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "overloaded_error", message: "try later" },
            })}\n\n`,
          ));
        },
        cancel() {
          streamCancelled = true;
        },
      }));
    },
  });

  await assert.rejects(judge.judge({ schemaVersion: 2 }), /provider failed/);
  assert.equal(streamCancelled, true);
});

test("Anthropic JSON Judge runs through Claude Code when the credential is an OAuth token", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const calls = [];
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "sk-ant-oat01-test",
    env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api03-stale" },
    fetch: async () => { throw new Error("not invoked"); },
    spawn(command, args, options) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
      let input = "";
      child.stdin.on("data", (chunk) => { input += chunk; });
      child.stdin.on("end", () => {
        calls.push({ command, args, env: options.env, input });
        child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n{\"outcome\":\"fail\",\"summary\":\"No evidence of a chat completion.\"}\n```" }));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    },
  });

  const decision = await judge.judge({ schemaVersion: 2, rubric: "r" });

  assert.deepEqual(decision, { outcome: "fail", summary: "No evidence of a chat completion." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "claude");
  assert.equal(calls[0].input, JSON.stringify({ schemaVersion: 2, rubric: "r" }));
  assert.deepEqual(calls[0].args.slice(0, 3), ["-p", "--model", "claude-test-model"]);
  assert.ok(calls[0].args.includes("--tools") && calls[0].args.includes("--strict-mcp-config"));
  assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-test");
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
});

test("Anthropic JSON Judge reports a Claude Code failure as a provider failure", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: "sk-ant-oat01-test",
    env: {},
    spawn() {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
      child.stdin.resume();
      child.stdin.on("end", () => {
        child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    },
  });

  await assert.rejects(judge.judge({ schemaVersion: 2 }), { message: "Anthropic JSON Judge provider failed" });
});
