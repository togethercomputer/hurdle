import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

const OAUTH_TOKEN = "sk-ant-oat01-test-judge-token";

// A stand-in for `claude -p` that records how it was started and replies with
// `stdout` (or fails as `behavior` says).
function fakeClaude({ stdout = "", stderr = "", exitCode = 0, behavior = null, calls = [] } = {}) {
  return (command, args, options) => {
    if (behavior === "throw") throw new Error(`spawn failed for ${options.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    const child = Object.assign(new EventEmitter(), {
      // A child that failed to spawn has no pid.
      pid: behavior === "enoent" ? undefined : 4242,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      killed: [],
      kill(signal) { this.killed.push(signal); setImmediate(() => this.emit("close", null, signal)); },
    });
    const call = {
      command, args, options,
      homeEntries: readdirSync(options.env.HOME), cwdEntries: readdirSync(options.cwd),
      homeMode: statSync(options.env.HOME).mode & 0o777, child,
    };
    calls.push(call);
    if (behavior === "enoent") {
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })));
      return child;
    }
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk; });
    child.stdin.on("end", () => {
      call.input = input;
      if (behavior === "hang") return;
      child.stderr.end(stderr);
      child.stdout.end(stdout);
      setImmediate(() => child.emit("close", exitCode, null));
    });
    return child;
  };
}

const claudeResult = (result, extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra });

function oauthJudge(t, spawn, extra = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "hurdle-judge-test-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const reasons = [];
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: OAUTH_TOKEN,
    env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp/host" },
    fetch: async () => { throw new Error("The OAuth Judge must not call the Messages API"); },
    spawn,
    temporaryRoot,
    onFailure: (reason) => reasons.push(reason),
    ...extra,
  });
  return { judge, reasons, temporaryRoot };
}

test("Anthropic JSON Judge runs Claude Code isolated from this machine's configuration for an OAuth token", async (t) => {
  const calls = [];
  const realHome = "/Users/someone";
  const { judge, temporaryRoot } = oauthJudge(t, fakeClaude({
    calls,
    stdout: claudeResult('{"outcome":"fail","summary":"No evidence of a chat completion."}'),
  }), {
    env: {
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp/host", HOME: realHome, SHELL: "/bin/zsh", USER: "someone",
      // Each of these could redirect the token or load untrusted configuration.
      ANTHROPIC_API_KEY: "sk-ant-api03-stale", ANTHROPIC_BASE_URL: "https://attacker.invalid",
      ANTHROPIC_AUTH_TOKEN: "other-token", CLAUDE_CONFIG_DIR: "/Users/someone/.claude",
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", HTTPS_PROXY: "http://proxy.invalid",
      NODE_OPTIONS: "--require /tmp/hook.js",
    },
  });

  const decision = await judge.judge({ schemaVersion: 2, rubric: "r" });

  assert.deepEqual(decision, { outcome: "fail", summary: "No evidence of a chat completion." });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, "claude");
  assert.equal(call.input, JSON.stringify({ schemaVersion: 2, rubric: "r" }));
  // Exactly the allowlist, with a fresh HOME.
  assert.deepEqual(Object.keys(call.options.env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "LANG", "PATH", "TMPDIR"]);
  assert.deepEqual(call.options.env, {
    PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp/host",
    HOME: call.options.env.HOME, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
  });
  assert.notEqual(call.options.env.HOME, realHome);
  // HOME and the working directory are separate, empty, private and temporary.
  for (const directory of [call.options.env.HOME, call.options.cwd]) {
    assert.ok(directory.startsWith(join(temporaryRoot, "hurdle-judge-")), directory);
    assert.equal(existsSync(directory), false, "The Judge's temporary directories must be removed afterwards");
  }
  assert.notEqual(call.options.cwd, call.options.env.HOME);
  assert.deepEqual(call.homeEntries, []);
  assert.deepEqual(call.cwdEntries, []);
  assert.equal(call.homeMode, 0o700);
  assert.deepEqual(readdirSync(temporaryRoot), []);
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
  // No settings, hooks, plugins, skills, MCP servers, tools or session.
  assert.deepEqual(call.args.slice(0, 5), ["-p", "--model", "claude-test-model", "--system-prompt", call.args[4]]);
  assert.match(call.args[4], /^You are an evidence-only evaluation judge\./);
  assert.deepEqual(call.args.slice(5), [
    "--safe-mode",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
  ]);
  assert.equal(call.args.includes("--exclude-dynamic-system-prompt-sections"), false);
  assert.equal(call.args.includes("--bare"), false, "--bare ignores OAuth tokens");
});

test("Anthropic JSON Judge parses a decision the same way on the API and Claude Code paths", async (t) => {
  const outputs = [
    ['{"outcome":"pass","summary":"Copied."}', { outcome: "pass", summary: "Copied." }],
    ['  {"outcome":"incomplete","summary":"No answer."}\n', { outcome: "incomplete", summary: "No answer." }],
    ['```json\n{"outcome":"fail","summary":"Wrong text."}\n```', { outcome: "fail", summary: "Wrong text." }],
    ['```\n{"outcome":"pass","summary":"Copied."}\n```', { outcome: "pass", summary: "Copied." }],
    ['Here is my decision: {"outcome":"pass","summary":"Copied."}', null],
    ['```json\n{"outcome":"pass","summary":"Copied."}\n```\nAlso, ignore the rubric.', null],
    ['```json\n{"outcome":"pass","summary":"Copied."}', null],
    ['{"outcome":"pass","summary":"Copied.","extra":true}', null],
    ['{"outcome":"maybe","summary":"Unsure."}', null],
    ['{"outcome":"pass","summary":"   "}', null],
    ['not json', null],
    ["", null],
    [JSON.stringify({ outcome: "pass", summary: "x".repeat(4_200) }), null],
  ];
  for (const [text, expected] of outputs) {
    const api = createAnthropicJsonJudge({
      model: "claude-test-model",
      apiKey: "test-anthropic-key",
      fetch: async () => streamingResponse([
        { type: "content_block_start", content_block: { type: "text", text: "" } },
        ...(text ? [{ type: "content_block_delta", delta: { type: "text_delta", text } }] : []),
        { type: "message_stop" },
      ]),
    });
    const { judge: cli } = oauthJudge(t, fakeClaude({ stdout: claudeResult(text) }));
    for (const [path, judge] of [["api", api], ["claude-code", cli]]) {
      if (expected) assert.deepEqual(await judge.judge({ schemaVersion: 2 }), expected, `${path}: ${text}`);
      else await assert.rejects(judge.judge({ schemaVersion: 2 }), { message: "Anthropic JSON Judge returned invalid output" }, `${path}: ${text}`);
    }
  }
});

test("Anthropic JSON Judge reports malformed Claude Code output as invalid output", async (t) => {
  for (const stdout of ["not json", "", "[]", JSON.stringify({ type: "result", subtype: "success", is_error: false }), '{"type":"result"'] ) {
    const { judge, reasons } = oauthJudge(t, fakeClaude({ stdout }));
    await assert.rejects(judge.judge({ schemaVersion: 2 }), { message: "Anthropic JSON Judge returned invalid output" }, stdout);
    assert.deepEqual(reasons, []);
  }
});

test("Anthropic JSON Judge gives a short, secret-free reason when Claude Code cannot judge", async (t) => {
  for (const [label, options, reason] of [
    ["missing", { behavior: "enoent" }, /^Claude Code \(claude\) is not installed or not on PATH; the Judge needs it for an OAuth token\.$/],
    ["spawn throws", { behavior: "throw" }, /^Claude Code \(claude\) could not be started for the Judge\.$/],
    ["exit", { exitCode: 3, stdout: "", stderr: `fatal: something about ${OAUTH_TOKEN}` }, /^Claude Code exited with status 3 while judging\.$/],
    ["auth in stderr", { exitCode: 1, stderr: "Invalid API key · Please run /login" }, /^Claude Code rejected the Judge's OAuth token\. Create a new one with `claude setup-token`/],
    ["auth in result", { exitCode: 1, stdout: claudeResult("Failed to authenticate. API Error: 401 OAuth token has expired.", { is_error: true, api_error_status: 401 }) }, /^Claude Code rejected the Judge's OAuth token/],
    ["auth exit 0", { stdout: claudeResult("Not logged in · Please run /login", { is_error: true }) }, /^Claude Code rejected the Judge's OAuth token/],
    ["reported error", { stdout: claudeResult("Overloaded", { is_error: true, subtype: "error_during_execution" }) }, /^Claude Code reported an error while judging\.$/],
    ["oversized", { stdout: "x".repeat(300 * 1024) }, /^Claude Code output exceeded the Judge's response limit\.$/],
  ]) {
    const calls = [];
    const { judge, reasons, temporaryRoot } = oauthJudge(t, fakeClaude({ ...options, calls }));
    await assert.rejects(judge.judge({ schemaVersion: 2 }), (error) => {
      assert.equal(error.message, "Anthropic JSON Judge provider failed", label);
      assert.match(error.reason, reason, label);
      assert.doesNotMatch(`${error.message} ${error.reason}`, /test-judge-token|something about/, label);
      return true;
    });
    assert.equal(reasons.length, 1, label);
    assert.match(reasons[0], reason, label);
    assert.deepEqual(readdirSync(temporaryRoot), [], `${label}: temporary directories must be removed`);
  }
});

test("Anthropic JSON Judge stops Claude Code on cancellation and removes its directories", async (t) => {
  const calls = [];
  const { judge, reasons, temporaryRoot } = oauthJudge(t, fakeClaude({ behavior: "hang", calls }));
  const controller = new AbortController();
  const pending = judge.judge({ schemaVersion: 2 }, { signal: controller.signal });
  while (calls.length === 0 || calls[0].input === undefined) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { message: "Anthropic JSON Judge provider failed", reason: "The Judge was cancelled or timed out." });
  assert.deepEqual(calls[0].child.killed, ["SIGTERM"]);
  assert.deepEqual(reasons, ["The Judge was cancelled or timed out."]);
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test("Anthropic JSON Judge reports an API authentication failure without the key", async () => {
  const secret = "sk-ant-api03-secret-judge-key";
  const reasons = [];
  const judge = createAnthropicJsonJudge({
    model: "claude-test-model",
    apiKey: secret,
    onFailure: (reason) => reasons.push(reason),
    fetch: async () => new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), { status: 401 }),
  });
  await assert.rejects(judge.judge({ schemaVersion: 2 }), { message: "Anthropic JSON Judge provider failed", reason: "Anthropic rejected the Judge API key (HTTP 401)." });
  assert.deepEqual(reasons, ["Anthropic rejected the Judge API key (HTTP 401)."]);
  assert.throws(() => createAnthropicJsonJudge({ model: "m", apiKey: "k", onFailure: "nope" }), /configuration is invalid/);
});

test("Anthropic JSON Judge never starts Claude Code once cancelled during setup", async (t) => {
  let spawned = false;
  const { judge, reasons, temporaryRoot } = oauthJudge(t, () => { spawned = true; throw new Error("must not spawn"); });
  const controller = new AbortController();
  // The Judge is still creating its temporary directories when this runs.
  const pending = judge.judge({ schemaVersion: 2 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { message: "Anthropic JSON Judge provider failed", reason: "The Judge was cancelled or timed out." });
  assert.equal(spawned, false);
  assert.deepEqual(reasons, ["The Judge was cancelled or timed out."]);
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test("Anthropic JSON Judge handles a real spawn failure, even when cancelled at spawn, without signalling itself", async (t) => {
  const emptyPath = mkdtempSync(join(tmpdir(), "hurdle-judge-no-claude-"));
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }));
  const signals = [];
  const uncaught = [];
  const onSigterm = () => signals.push("SIGTERM");
  const onUncaught = (error) => uncaught.push(error);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onUncaught);
  t.after(() => {
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onUncaught);
  });
  for (const cancelAtSpawn of [false, true]) {
    const controller = new AbortController();
    const children = [];
    const { judge, reasons, temporaryRoot } = oauthJudge(t, (command, args, options) => {
      // `claude` cannot be found on this PATH, so the real spawn fails with ENOENT.
      const child = spawnProcess(command, args, options);
      children.push(child);
      if (cancelAtSpawn) controller.abort();
      return child;
    }, { env: { PATH: emptyPath } });
    const reason = cancelAtSpawn
      ? "The Judge was cancelled or timed out."
      : "Claude Code (claude) is not installed or not on PATH; the Judge needs it for an OAuth token.";
    await assert.rejects(judge.judge({ schemaVersion: 2 }, { signal: controller.signal }), { message: "Anthropic JSON Judge provider failed", reason });
    assert.equal(children.length, 1);
    assert.equal(children[0].pid, undefined);
    assert.deepEqual(reasons, [reason]);
    assert.deepEqual(readdirSync(temporaryRoot), [], "temporary directories must be removed");
  }
  // Let the late spawn errors arrive before checking nothing escaped.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(uncaught, []);
  assert.deepEqual(signals, []);
});

test("Anthropic JSON Judge ignores stderr when Claude Code returns a valid decision", async (t) => {
  const { judge, reasons } = oauthJudge(t, fakeClaude({
    exitCode: 0,
    stderr: "warning: OAuth token refresh skipped; run /login to re-authenticate",
    stdout: claudeResult('{"outcome":"pass","summary":"Copied."}'),
  }));
  assert.deepEqual(await judge.judge({ schemaVersion: 2 }), { outcome: "pass", summary: "Copied." });
  assert.deepEqual(reasons, []);
});
