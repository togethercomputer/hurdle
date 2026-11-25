import assert from "node:assert/strict";
import test from "node:test";

import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";

test("Codex redacts authentication prefixes in nested controller output and artifacts", () => {
  const secret = "codex-abcdefghijkl-long-test-credential";
  const adapter = createCodexAdapter({ runtimeEnv: { OPENAI_API_KEY: secret } });
  const output = JSON.stringify({ key: secret.slice(0, 20) });
  const frame = JSON.stringify({ type: "item.completed", item: { output } });
  const redacted = JSON.parse(adapter.redactControllerText(frame));
  assert.deepEqual(JSON.parse(redacted.item.output), { key: "<REDACTED>" });
  assert.equal(adapter.redactEvidenceBytes(Buffer.from(`${secret.slice(0, 10)}...`)).toString(), "<REDACTED>...");
});

test("Codex Adapter names model, authentication and quota failures for the operator", () => {
  const adapter = createCodexAdapter({ runtimeEnv: { OPENAI_API_KEY: "test-key" } });
  const reason = (message) => adapter.decodeControllerEvidence({
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "error", message: `Reconnecting... 1/5 (${message})` }),
      JSON.stringify({ type: "turn.failed", error: { message } }),
      "",
    ].join("\n"),
  }).operatorReason;

  assert.equal(
    reason("unexpected status 404 Not Found: The model `gpt-typo` does not exist or you do not have access to it."),
    "Codex could not use the requested model; it may not exist or the account may lack access. Check the model ID with `npx hurdle models --agent codex`.",
  );
  assert.match(reason("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"), /^Codex authentication failed\./);
  assert.match(reason("You exceeded your current quota, please check your plan and billing details."), /insufficient quota/);
  assert.equal(reason("provider-supplied detail must not become an operator reason"), undefined);
});

test("Codex Adapter creates a bounded launch plan from normalized settings", () => {
  const adapter = createCodexAdapter({
    runtimeEnv: {
      PATH: "/test/bin",
      HOME: "/test/home",
      CODEX_HOME: "/test/codex-home",
      CODEX_ACCESS_TOKEN: "ignored-access-token",
      CODEX_API_KEY: "selected-codex-key",
      OPENAI_API_KEY: "unselected-openai-key",
      UNRELATED_SECRET: "must-not-reach-codex",
    },
    command: "/test/bin/codex",
    timeoutMs: 5_000,
  });

  assert.equal(adapter.id, "codex");
  assert.deepEqual(
    adapter.normalizeSettings({ requestedModel: "  gpt-test  ", settings: {} }),
    { requestedModel: "gpt-test", settings: {} },
  );
  assert.throws(
    () => adapter.normalizeSettings({ requestedModel: null, settings: { reasoningEffort: "high" } }),
    /does not support Agent Adapter settings/,
  );

  const plan = adapter.createLaunchPlan({
    prompt: "Copy the fixture.",
    requestedModel: "gpt-test",
    settings: {},
  });

  assert.deepEqual(plan, {
    command: "/test/bin/codex",
    versionProbe: true,
    args: [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--model",
      "gpt-test",
      "-",
    ],
    env: {
      PATH: "/test/bin",
      HOME: "/test/home",
      CODEX_API_KEY: "selected-codex-key",
    },
    // Only the API key: a ChatGPT access token never reaches Codex.
    credentialRoutes: [{
      environmentName: "CODEX_API_KEY",
      hosts: ["api.openai.com"],
      headerNames: ["authorization"],
    }],
    stdin: "Copy the fixture.",
    timeoutMs: 5_000,
    workspaceFiles: [],
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.args), true);
  assert.equal(Object.isFrozen(plan.env), true);
  assert.equal(
    adapter.redactControllerText(
      "ignored-access-token selected-codex-key unselected-openai-key",
    ),
    "<REDACTED> <REDACTED> <REDACTED>",
  );
});

test("Codex Adapter ignores blank auth and prefers CODEX_API_KEY over OpenAI", () => {
  const adapter = createCodexAdapter({
    runtimeEnv: {
      CODEX_ACCESS_TOKEN: "   ",
      CODEX_API_KEY: "codex-key",
      OPENAI_API_KEY: "openai-key",
    },
  });

  const plan = adapter.createLaunchPlan({
    prompt: "Copy the fixture.",
    requestedModel: null,
    settings: {},
  });

  assert.deepEqual(plan.env, { CODEX_API_KEY: "codex-key" });
  assert.equal(
    adapter.redactControllerText("codex-key openai-key"),
    "<REDACTED> <REDACTED>",
  );
});

test("Codex Adapter maps GitHub API-key auth and redacts every candidate secret", () => {
  const escapedSecret = "line\n\"quote";
  const adapter = createCodexAdapter({
    runtimeEnv: {
      HOME: "/test/home",
      OPENAI_API_KEY: escapedSecret,
      UNRELATED_SECRET: "must-not-reach-codex",
    },
  });

  const plan = adapter.createLaunchPlan({
    prompt: "Copy the fixture.",
    requestedModel: null,
    settings: {},
  });
  assert.deepEqual(plan.env, {
    HOME: "/test/home",
    CODEX_API_KEY: escapedSecret,
  });

  const redactedJsonl = adapter.redactControllerText(
    `${JSON.stringify({ type: "event", auth: escapedSecret })}\n`,
  );
  assert.deepEqual(JSON.parse(redactedJsonl), {
    type: "event",
    auth: "<REDACTED>",
  });
  assert.equal(
    adapter.redactEvidenceBytes(Buffer.from(`before ${escapedSecret} after`)).toString("utf8"),
    "before <REDACTED> after",
  );
  assert.doesNotMatch(redactedJsonl, /line|quote/);
});

test("Codex Adapter redacts secrets inside JSON serialized in controller frames", () => {
  const secret = "line\n\"quote";
  const adapter = createCodexAdapter({
    runtimeEnv: { OPENAI_API_KEY: secret },
  });
  const serializedOutput = JSON.stringify({ apiKey: secret });
  const frame = {
    type: "item.completed",
    item: { type: "command_execution", output: serializedOutput },
  };

  const redacted = adapter.redactControllerText(`${JSON.stringify(frame)}\n`);
  const parsed = JSON.parse(redacted);

  assert.deepEqual(JSON.parse(parsed.item.output), { apiKey: "<REDACTED>" });
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes(JSON.stringify(secret).slice(1, -1)), false);
});

test("Codex Adapter keeps controller JSONL valid for punctuation-only secrets", () => {
  for (const secret of ['"', "\\"]) {
    const adapter = createCodexAdapter({
      runtimeEnv: { OPENAI_API_KEY: secret },
    });
    const redacted = adapter.redactControllerText(
      `${JSON.stringify({
        type: "event",
        nested: { auth: `before${secret}after` },
        serialized: JSON.stringify({ auth: `before${secret}after` }),
      })}\n`,
    );
    const parsed = JSON.parse(redacted);
    assert.deepEqual(parsed.nested, { auth: "before<REDACTED>after" });
    assert.deepEqual(JSON.parse(parsed.serialized), {
      auth: "before<REDACTED>after",
    });
    assert.equal(parsed.type, "event");
  }
});

test("Codex Adapter decodes native controller JSONL without changing token meanings", () => {
  const adapter = createCodexAdapter({ runtimeEnv: {} });
  const frames = [
    { type: "thread.started", thread_id: "codex-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message" } },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "file_change" } },
    { type: "item.completed", item: { type: "mcp_tool_call" } },
    { type: "item.completed", item: { type: "web_search" } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 20,
        reasoning_output_tokens: 10,
      },
    },
    { type: "turn.started" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ];
  const stdout = `${frames.map((frame) => `  ${JSON.stringify(frame)}  `).join("\n")}\n`;

  assert.deepEqual(adapter.decodeControllerEvidence({ stdout }), {
    transcript: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    observedModel: null,
    sessionId: "codex-thread",
    metrics: {
      common: {
        inputTokens: 0,
        outputTokens: 0,
        reportedCostUsd: null,
        turns: 2,
        toolCalls: 4,
      },
      adapter: {
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        completedItemsByType: {
          agent_message: 1,
          command_execution: 1,
          file_change: 1,
          mcp_tool_call: 1,
          web_search: 1,
        },
        agentMessages: 1,
        commandExecutions: 1,
        fileChanges: 1,
        mcpToolCalls: 1,
        webSearches: 1,
      },
    },
  });
});

test("Codex Adapter preserves the latest valid value for each usage metric", () => {
  const adapter = createCodexAdapter({ runtimeEnv: {} });
  const frames = [
    {
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        cached_input_tokens: 7,
        output_tokens: 5,
        reasoning_output_tokens: 3,
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: "invalid",
        output_tokens: 0,
      },
    },
  ];

  const decoded = adapter.decodeControllerEvidence({
    stdout: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
  });

  assert.deepEqual(decoded.metrics.common, {
    inputTokens: 11,
    outputTokens: 0,
    reportedCostUsd: null,
    turns: 2,
    toolCalls: 0,
  });
  assert.equal(decoded.metrics.adapter.cachedInputTokens, 7);
  assert.equal(decoded.metrics.adapter.reasoningOutputTokens, 3);
});

test("Codex Adapter counts every completed item type in adapter metrics", () => {
  const adapter = createCodexAdapter({ runtimeEnv: {} });
  const frames = [
    { type: "item.completed", item: { type: "reasoning" } },
    { type: "item.completed", item: { type: "plan" } },
    { type: "item.completed", item: { type: "reasoning" } },
    { type: "item.completed", item: { type: "  " } },
  ];

  const decoded = adapter.decodeControllerEvidence({
    stdout: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
  });

  assert.deepEqual(decoded.metrics.adapter.completedItemsByType, {
    plan: 1,
    reasoning: 2,
  });
  assert.equal(decoded.metrics.common.toolCalls, 0);
});

test("Codex Adapter excludes ambient CODEX_HOME and fails closed on invalid JSONL", () => {
  const adapter = createCodexAdapter({
    runtimeEnv: { HOME: "/test/home", CODEX_HOME: "/test/codex-home" },
  });
  assert.deepEqual(
    adapter.createLaunchPlan({
      prompt: "Copy the fixture.",
      requestedModel: null,
      settings: {},
    }).env,
    { HOME: "/test/home" },
  );
  assert.throws(
    () => adapter.decodeControllerEvidence({ stdout: "" }),
    (error) => error?.code === "CONTROLLER_TRANSCRIPT_EMPTY",
  );
  assert.throws(
    () => adapter.decodeControllerEvidence({ stdout: "not-json\n" }),
    (error) => error?.code === "CONTROLLER_TRANSCRIPT_INVALID_FRAME",
  );
});
