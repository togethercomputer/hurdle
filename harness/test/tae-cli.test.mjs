import { cliExecutable } from "../lib/terminal-output.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";

const sourceExecutable = cliExecutable();

function editStarter(cwd, { agents = [{ runner: "claude-code", model: "test-model", effort: "medium" }], matrix = false, secret = false, delay = false } = {}) {
  const root = join(cwd, "evals");
  if (matrix) cpSync(join(root, "tasks", "copy-message"), join(root, "tasks", "copy-message-alt"), { recursive: true });
  writeFileSync(join(root, "example.suite.mjs"), 'import { defineSuite } from "tae";\nexport default defineSuite(' + JSON.stringify({
    tasks: matrix ? ["./tasks/copy-message", "./tasks/copy-message-alt"] : ["./tasks/copy-message"],
    agents,
    conditions: matrix ? { baseline: { skills: [], mcpServers: [] }, alternate: { skills: [], mcpServers: [] } } : { baseline: { skills: [], mcpServers: [] } },
    repeats: 1,
    verdict: "code",
  }) + ');\n');
  if (secret || delay) {
    const path = join(root, "tasks", "copy-message", "checks.mjs");
    writeFileSync(path, readFileSync(path, "utf8").replace("defineChecks((run) => {", "defineChecks((run) => {\n"
      + (secret ? 'run.expect.artifact({ id: "secret", path: "secret.txt", format: "text", maxBytes: 4096, required: false });\n' : "")
      + (delay ? "setTimeout(() => {}, 4000);\n" : "")));
  }
}

const cliPath = fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url));

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--import=${fileURLToPath(new URL("./helpers/readiness-fetch.mjs", import.meta.url))}`, ...env },
  });
}

test("hurdle exposes global and per-command help without executing a command", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-help-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const result = runCli(cwd, args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Hurdle\n\nUsage:\n  hurdle <command> \[options\]/);
    for (const command of ["init", "validate", "run", "view", "version"]) {
      assert.match(result.stdout, new RegExp(`^  ${command}\\b`, "m"));
    }
  }

  const commandHelp = new Map();
  for (const [command, expected] of [
    ["init", /hurdle init \[directory\]/],
    ["validate", /hurdle validate \[suite\]/],
    ["run", /hurdle run \[suite\] \[options\]/],
    ["view", /hurdle view \[--runtime FILE \| --store DIR\]/],
    ["version", /hurdle version/],
  ]) {
    const direct = runCli(cwd, [command, "--help"]);
    const topic = runCli(cwd, ["help", command]);
    assert.equal(direct.status, 0);
    assert.equal(direct.stderr, "");
    assert.match(direct.stdout, expected);
    assert.equal(topic.status, 0);
    assert.equal(topic.stderr, "");
    assert.equal(topic.stdout, direct.stdout);
    commandHelp.set(command, direct.stdout);
  }

  for (const [args, command] of [
    [["init", "custom-evals", "--help"], "init"],
    [["validate", "custom.suite.mjs", "--help"], "validate"],
    [["run", "custom.suite.mjs", "--help"], "run"],
    [["view", "--store", "results", "--help"], "view"],
  ]) {
    const result = runCli(cwd, args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, commandHelp.get(command));
  }

  const runHelp = runCli(cwd, ["run", "--help"]);
  for (const option of [
    "--task",
    "--condition",
    "--agent",
    "--model",
    "--runtime",
    "--environment",
    "--environment-settings",
    "--store",
    "--experiment-version",
    "--view",
  ]) {
    assert.match(runHelp.stdout, new RegExp(`^  ${option}\\b`, "m"));
  }
  assert.equal(existsSync(join(cwd, "evals")), false);
});

test("hurdle reports its installed version without reading project configuration", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hurdle-cli-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".env.local"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "99.0.0" }));
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const command of ["version", "--version", "-v"]) {
    const result = runCli(cwd, [command]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
    const invalid = runCli(cwd, [command, "extra"]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /\[argument-error\]/);
    assert.equal(invalid.stdout, "");
  }
  assert.equal(runCli(cwd, ["version", "--help"]).status, 0);
  assert.equal(existsSync(join(cwd, ".hurdle")), false);
});

test("hurdle init and offline validation work without credentials", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const initialized = runCli(cwd, ["init"]);
  assert.equal(initialized.status, 0);
  assert.equal(initialized.stderr, "");
  assert.match(initialized.stdout, /✓ Evaluation created\n\n  Suite     evals\/example\.suite\.mjs\n/);
  assert.ok(initialized.stdout.includes(`  Next      ${sourceExecutable} validate\n            ${sourceExecutable} run --view\n`));
  assert.doesNotMatch(initialized.stdout, /sha256:/);

  const validated = runCli(cwd, ["validate", "--offline"]);
  assert.equal(validated.status, 0);
  assert.equal(validated.stderr, "");
  assert.match(validated.stdout, /✓ Suite valid\n\n  Suite     evals\/example\.suite\.mjs\n/);
  assert.match(validated.stdout, /  Plan      1 task · 1 condition\n/);
  assert.doesNotMatch(validated.stdout, /sha256:/);
});

test("hurdle validate reports a missing Suite as an ordinary validation failure", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-missing-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const result = runCli(cwd, ["validate"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /\[suite\.missing\] No Suites found in this project\. Create an evaluation first\./,
  );
  assert.ok(result.stderr.endsWith(`\n  Next      ${cliExecutable(cwd)} init\n\n`));
});

test("an unreadable .env.local is reported as an actionable error", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-env-unreadable-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".env.local"));

  // Creating a starter needs no credentials.
  const initialized = runCli(cwd, ["init"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const args of [["validate"], ["run"], ["view"]]) {
    const result = runCli(cwd, args);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, /\[environment-unavailable\] Could not read \.env\.local\./);
    assert.doesNotMatch(result.stderr, /internal-error/);
  }
});

test("hurdle run settles the Run when its output pipe closes early", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-closed-output-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(runCli(cwd, ["init"]).status, 0);
  editStarter(cwd);
  const binRoot = join(cwd, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'readFileSync(0, "utf8");',
    // Finish after the reader has gone, so later progress writes fail.
    "setTimeout(() => {",
    '  writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    '  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "s", model: "test-model" })}\\n`);',
    "}, 1_500);",
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);
  const storeRoot = join(cwd, "run-results");
  const child = spawn(process.execPath, [cliPath, "run", "--store", storeRoot], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${fileURLToPath(new URL("./helpers/readiness-fetch.mjs", import.meta.url))}`,
      ANTHROPIC_API_KEY: "test-only-key",
      PATH: `${binRoot}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  // Like `hurdle run | head -1`, or a closed terminal: read once, then go away.
  await once(child.stdout, "data");
  child.stdout.destroy();
  const [code] = await once(child, "exit");

  assert.doesNotMatch(stderr, /Unhandled 'error' event|EPIPE/);
  assert.equal(code, 0);
  const store = await openLocalResultStore({ root: storeRoot });
  const [record] = await store.listRuns();
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "pass");
});

test("hurdle run composes Claude Code and local execution into the canonical store", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-run-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const initialized = runCli(cwd, ["init"]);
  assert.equal(initialized.status, 0);

  editStarter(cwd, { secret: true, delay: true });

  const binRoot = join(cwd, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("node:fs");',
      'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
      'const prompt = readFileSync(0, "utf8");',
      'const authSecret = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;',
      'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
      'writeFileSync("secret.txt", authSecret);',
      'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "cli-session" })}\\n`);',
      'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "cli-session", model: "test-model", args: process.argv.slice(2), prompt, auth_secret: authSecret, unrelated_secret: process.env.UNRELATED_SECRET ?? null })}\\n`);',
      'process.stderr.write(`stderr auth=${authSecret}\\n`);',
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);

  const storeRoot = join(cwd, "run-results");
  const runStartedAt = Date.now();
  const result = runCli(
    cwd,
    [
      "run",
      "--agent",
      "claude-code",
      "--model",
      "test-model",
      "--store",
      storeRoot,
    ],
    {
      ANTHROPIC_API_KEY: "test-only-key",
      UNRELATED_SECRET: "must-not-reach-agent",
      PATH: `${binRoot}:${process.env.PATH}`,
    },
  );

  assert.equal(result.status, 0);
  assert.ok(
    Date.now() - runStartedAt < 10_000,
    "the evaluator worker must exit after returning checks",
  );
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^  Plan\s+1 run · 1 task · 1 condition$/m);
  assert.match(result.stdout, /^  Result\s+Passed$/m);
  assert.match(result.stdout, /^  Runs\s+1 passed$/m);
  assert.doesNotMatch(result.stdout, /Matrix:|Authority:|sha256:/);

  const store = await openLocalResultStore({ root: storeRoot });
  const [record] = await store.listRuns();
  assert.ok(record);
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "pass");
  assert.equal(record.execution.adapterId, "claude-code");
  assert.deepEqual(record.snapshot.agent, { adapterId: "claude-code", requestedModel: "test-model", settings: { effort: "medium" } });
  assert.equal(record.execution.sessionId, "cli-session");
  assert.deepEqual(record.snapshot.environment.settings, {});
  const transcriptBytes = await store.readEvidence(record.evidence.transcript, {
    maxBytes: 64 * 1024,
  });
  const resultFrame = transcriptBytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((frame) => frame.type === "result");
  assert.deepEqual(resultFrame.args, [
    "--verbose",
    "--output-format",
    "stream-json",
    "--setting-sources",
    "project",
    "--mcp-config",
    ".hurdle/claude-mcp.json",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--model",
    "test-model",
    "--effort",
    "medium",
    "--dangerously-skip-permissions",
    "-p",
  ]);
  assert.match(resultFrame.prompt, /write its exact contents to `answer\.txt`/);
  assert.equal(resultFrame.auth_secret, "<REDACTED>");
  assert.equal(resultFrame.unrelated_secret, null);
  const stderrBytes = await store.readEvidence(record.evidence.stderr, {
    maxBytes: 64 * 1024,
  });
  assert.equal(stderrBytes.toString("utf8"), "stderr auth=<REDACTED>\n");
  const secretArtifact = record.evidence.artifacts.find(
    ({ path }) => path === "secret.txt",
  );
  const secretArtifactBytes = await store.readEvidence(secretArtifact.content, {
    maxBytes: 4096,
  });
  assert.equal(secretArtifactBytes.toString("utf8"), "<REDACTED>");
  assert.doesNotMatch(
    `${JSON.stringify(record)}\n${transcriptBytes}\n${stderrBytes}\n${secretArtifactBytes}`,
    /test-only-key/,
  );
});

test("hurdle run composes Codex and maps CI auth into redacted canonical evidence", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-codex-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(runCli(cwd, ["init"]).status, 0);

  editStarter(cwd, { agents: [{ runner: "codex", model: "gpt-test", effort: "medium" }], secret: true });

  const binRoot = join(cwd, "bin");
  mkdirSync(binRoot);
  const fakeCodex = join(binRoot, "codex");
  writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
      'const prompt = readFileSync(0, "utf8");',
    'const authSecret = process.env.CODEX_ACCESS_TOKEN ?? process.env.CODEX_API_KEY ?? null;',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'writeFileSync("secret.txt", authSecret);',
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-cli-session" })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "command_execution", args: process.argv.slice(2), prompt, auth_secret: authSecret, original_openai_key: process.env.OPENAI_API_KEY ?? null, unrelated_secret: process.env.UNRELATED_SECRET ?? null } })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 } })}\\n`);',
    'process.stderr.write(`stderr auth=${authSecret}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);

  const storeRoot = join(cwd, "codex-results");
  const result = runCli(cwd, [
    "run",
    "evals/example.suite.mjs",
    "--agent",
    "codex",
    "--model",
    "future-codex-2099",
    "--store",
    storeRoot,
  ], {
    CODEX_ACCESS_TOKEN: "",
    CODEX_API_KEY: "",
    OPENAI_API_KEY: "test-only-openai-key",
    UNRELATED_SECRET: "must-not-reach-agent",
    PATH: `${binRoot}:${process.env.PATH}`,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^  Plan\s+1 run · 1 task · 1 condition$/m);
  assert.match(result.stdout, /^  Runs\s+1 passed$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const [record] = await store.listRuns();
  assert.ok(record);
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "pass");
  assert.equal(record.execution.adapterId, "codex");
  assert.deepEqual(record.snapshot.agent, { adapterId: "codex", requestedModel: "future-codex-2099", settings: { effort: "medium" } });
  assert.match(readFileSync(join(cwd, "evals/example.suite.mjs"), "utf8"), /gpt-test/);
  assert.equal(record.execution.sessionId, "codex-cli-session");
  assert.deepEqual(record.metrics.common, {
    inputTokens: 7,
    outputTokens: 5,
    reportedCostUsd: null,
    turns: 1,
    toolCalls: 1,
  });
  assert.equal(record.metrics.adapters.codex.cachedInputTokens, 3);
  assert.equal(record.metrics.adapters.codex.reasoningOutputTokens, 2);
  assert.deepEqual(record.metrics.adapters.codex.completedItemsByType, {
    command_execution: 1,
  });

  const transcriptBytes = await store.readEvidence(record.evidence.transcript, {
    maxBytes: 64 * 1024,
  });
  const commandItem = transcriptBytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((frame) => frame.type === "item.completed").item;
  assert.deepEqual(commandItem.args, [
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
    "-c",
    'model_reasoning_effort="medium"',
    "--model",
    "future-codex-2099",
    "-",
  ]);
  assert.match(commandItem.prompt, /write its exact contents to `answer\.txt`/);
  assert.equal(commandItem.auth_secret, "<REDACTED>");
  assert.equal(commandItem.original_openai_key, null);
  assert.equal(commandItem.unrelated_secret, null);

  const stderrBytes = await store.readEvidence(record.evidence.stderr, {
    maxBytes: 64 * 1024,
  });
  assert.equal(stderrBytes.toString("utf8"), "stderr auth=<REDACTED>\n");
  const secretArtifact = record.evidence.artifacts.find(({ path }) => path === "secret.txt");
  const secretArtifactBytes = await store.readEvidence(secretArtifact.content, {
    maxBytes: 4096,
  });
  assert.equal(secretArtifactBytes.toString("utf8"), "<REDACTED>");
  assert.doesNotMatch(
    `${JSON.stringify(record)}\n${transcriptBytes}\n${stderrBytes}\n${secretArtifactBytes}`,
    /test-only-openai-key|must-not-reach-agent/,
  );
});

test("Claude Code redacts both supported authentication modes", () => {
  for (const [name, secret] of [
    ["ANTHROPIC_API_KEY", "api-secret-value"],
    ["CLAUDE_CODE_OAUTH_TOKEN", "oauth-secret-value"],
  ]) {
    const adapter = createClaudeCodeAdapter({ runtimeEnv: { [name]: secret } });
    assert.equal(
      adapter.redactControllerText(`before ${secret} after`),
      "before <REDACTED> after",
    );
  }
});

test("Claude Code redacts authentication prefixes in controller text and artifacts", () => {
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const secret = "sk-ant-abcdefghijk-long-test-credential";
    const adapter = createClaudeCodeAdapter({ runtimeEnv: { [name]: secret } });
    const text = JSON.stringify({ output: `${secret.slice(0, 10)}... ${secret.slice(0, 20)}...` });
    assert.deepEqual(JSON.parse(adapter.redactControllerText(text)), { output: "<REDACTED>... <REDACTED>..." });
    assert.equal(adapter.redactEvidenceBytes(Buffer.from(text)).toString(), adapter.redactControllerText(text));
  }
});

test("Claude Code disables all skills only for Conditions without selected skills, including continuations", () => {
  const adapter = createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: "test-credential" } });
  const skill = { name: "selected-skill", files: [{ relativePath: "SKILL.md", handle: {}, sha256: "test-hash" }] };
  for (const resources of [
    { skills: [], mcpServers: [] },
    { skills: [], mcpServers: [{ id: "test", transport: { kind: "http", url: "https://example.invalid/mcp" } }] },
    { skills: [skill], mcpServers: [] },
  ]) {
    const plan = adapter.createLaunchPlan({ prompt: "Test the Condition.", requestedModel: null, resources });
    assert.equal(plan.args.includes("--disable-slash-commands"), resources.skills.length === 0);
    assert.equal(plan.workspaceFiles.some(({ path }) => path === ".claude/skills/selected-skill/SKILL.md"), resources.skills.length > 0);
    const decoded = adapter.decodeControllerEvidence({ stdout: '{"type":"result","session_id":"session-123"}\n' });
    const continuation = adapter.createContinuationPlan({
      handle: decoded.continuationHandle, prompt: "Continue.", requestedModel: null, resources,
    });
    assert.equal(continuation.args.includes("--disable-slash-commands"), resources.skills.length === 0);
  }
});

test("Claude Code owns opaque single-use continuation handles", () => {
  const adapter = createClaudeCodeAdapter({
    runtimeEnv: { ANTHROPIC_API_KEY: "claude-test-secret" },
    command: "/opt/claude",
  });
  const decoded = adapter.decodeControllerEvidence({
    stdout: `${JSON.stringify({ type: "result", session_id: "session-123" })}\n`,
  });

  assert.ok(decoded.continuationHandle);
  assert.equal(JSON.stringify(decoded.continuationHandle), "{}");
  const plan = adapter.createContinuationPlan({
    handle: decoded.continuationHandle,
    prompt: "Continue teardown.",
    requestedModel: null,
    settings: { effort: "medium" },
  });
  assert.equal(plan.command, "/opt/claude");
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--effort"), plan.args.indexOf("--effort") + 2), ["--effort", "medium"]);
  assert.deepEqual(
    plan.args.slice(plan.args.indexOf("--resume"), plan.args.indexOf("--resume") + 2),
    ["--resume", "session-123"],
  );
  assert.deepEqual(plan.workspaceFiles, []);
  assert.throws(() => adapter.createContinuationPlan({
    handle: decoded.continuationHandle,
    prompt: "Reuse.",
    requestedModel: null,
    settings: {},
  }), /unavailable/);
});

test("Claude Code classifies a low-credit API failure for the operator", () => {
  const adapter = createClaudeCodeAdapter({
    runtimeEnv: { ANTHROPIC_API_KEY: "test-credential" },
  });
  const decoded = adapter.decodeControllerEvidence({
    stdout: `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "billing-session",
      terminal_reason: "api_error",
      is_error: true,
      api_error_status: 400,
      result: "Credit balance is too low",
    })}\n`,
    exitCode: 1,
  });

  assert.equal(
    decoded.operatorReason,
    "Claude Code could not run because the Anthropic credit balance is too low.",
  );

  const unknown = adapter.decodeControllerEvidence({
    stdout: `${JSON.stringify({
      type: "result", subtype: "success", session_id: "other-api-error",
      terminal_reason: "api_error", is_error: true,
      result: "provider-supplied detail must not become an operator reason",
    })}\n`,
    exitCode: 1,
  });
  assert.equal(unknown.operatorReason, undefined);
});

test("Claude Code tells the operator when the requested model is unavailable", () => {
  const adapter = createClaudeCodeAdapter({
    runtimeEnv: { ANTHROPIC_API_KEY: "test-credential" },
  });
  const decoded = adapter.decodeControllerEvidence({
    stdout: `${JSON.stringify({
      type: "result", subtype: "success", session_id: "model-session",
      is_error: true, api_error_status: 404,
      result: "There's an issue with the selected model (claude-typo). It may not exist or you may not have access to it. Run --model to pick a different model.",
    })}\n`,
    exitCode: 1,
  });

  assert.equal(
    decoded.operatorReason,
    "Claude Code could not use the requested model; it may not exist or the account may lack access. Check the model ID with `npx hurdle models --agent claude-code`.",
  );
});

test("Claude Code requires explicit auth for isolated execution", () => {
  const adapter = createClaudeCodeAdapter({ runtimeEnv: {} });
  assert.throws(
    () => adapter.createLaunchPlan({
      prompt: "Run without ambient credentials.",
      requestedModel: null,
      settings: {},
    }),
    /not authenticated/,
  );
});

test("hurdle run expands the configured matrix and filters narrow it", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-matrix-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(runCli(cwd, ["init"]).status, 0);

  editStarter(cwd, { matrix: true, agents: [{ runner: "claude-code", model: "test-claude" }, { runner: "codex", model: "test-codex" }] });

  const binRoot = join(cwd, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "matrix-session", model: "test-model" })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);
  const fakeCodex = join(binRoot, "codex");
  writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "matrix-codex-session" })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);
  const env = {
    ANTHROPIC_API_KEY: "matrix-test-key",
    OPENAI_API_KEY: "matrix-openai-key",
    PATH: `${binRoot}:${process.env.PATH}`,
  };

  const matrixStore = join(cwd, "matrix-results");
  const matrix = runCli(cwd, [
    "run",
    "evals/example.suite.mjs",
    "--store",
    matrixStore,
  ], env);
  assert.equal(matrix.status, 0, `${matrix.stdout}\n${matrix.stderr}`);
  assert.match(matrix.stdout, /^  Plan\s+8 runs · 2 tasks · 2 conditions$/m);
  assert.match(matrix.stdout, /^  Runs\s+8 passed$/m);
  const matrixResults = await openLocalResultStore({ root: matrixStore });
  const matrixRecords = await matrixResults.listRuns();
  assert.equal(matrixRecords.length, 8);
  assert.deepEqual(
    new Set(matrixRecords.map(({ snapshot }) => snapshot.agent.adapterId)),
    new Set(["claude-code", "codex"]),
  );

  const narrowedStore = join(cwd, "narrowed-results");
  const narrowed = runCli(cwd, [
    "run",
    "evals/example.suite.mjs",
    "--task",
    "copy-message-alt",
    "--agent",
    "claude-code",
    "--condition",
    "alternate",
    "--store",
    narrowedStore,
  ], env);
  assert.equal(narrowed.status, 0);
  assert.match(narrowed.stdout, /^  Plan\s+1 run · 1 task · 1 condition$/m);
});

test("hurdle run reports unknown matrix filters as argument errors", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-selection-error-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(runCli(cwd, ["init"]).status, 0);

  for (const [flag, value, expected] of [
    ["--task", "missing-task", "Task 'missing-task' does not exist."],
    ["--condition", "missing-condition", "Condition 'missing-condition' does not exist."],
  ]) {
    const result = runCli(cwd, [
      "run",
      "evals/example.suite.mjs",
      flag,
      value,
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `✗ hurdle [argument-error] ${expected}\n`);
    assert.doesNotMatch(result.stderr, /internal-error/);
  }
});

test("hurdle run rejects ambiguous or duplicate matrix selectors", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tae-cli-selector-errors-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(runCli(cwd, ["init"]).status, 0);
  const manifest = "evals/example.suite.mjs";

  for (const [args, expected] of [
    [
      ["--task", "copy-message", "--task", "copy-message"],
      "Option '--task' selects 'copy-message' more than once.",
    ],
    [
      ["--profile", "codex=gpt-test", "--model", "gpt-test"],
      "Unknown run option '--profile'.",
    ],
    [
      ["--profile", "codex=gpt-test", "--profile", "codex=gpt-test"],
      "Unknown run option '--profile'.",
    ],
    [
      ["--retries", "-1"],
      "Unknown run option '--retries'.",
    ],
    [
      ["--retries", "101"],
      "Unknown run option '--retries'.",
    ],
    [
      ["--agent", "codex", "--agent", "claude-code"],
      "Option '--agent' may only be supplied once.",
    ],
    [
      ["--authority-profile", "hybrid-v1", "--authority-profile", "judge-primary-v1"],
      "Unknown run option '--authority-profile'.",
    ],
    [
      ["--environment-settings", "not-json"],
      "--environment-settings must be a JSON object.",
    ],
    [
      ["--environment-settings", "[]"],
      "--environment-settings must be a JSON object.",
    ],
    [
      ["--environment-settings", '{"auth":"postgresql://user:password@host/db"}'],
      "Local Execution Environment settings must be empty.",
    ],
    [
      ["--runtime", "runtime.json", "--store", "results"],
      "--runtime cannot be combined with --environment, --environment-settings, or --store.",
    ],
  ]) {
    const result = runCli(cwd, ["run", manifest, ...args]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `✗ hurdle [argument-error] ${expected}\n`);
  }
});
