import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import {
  collectTaskDeclarations,
  evaluateChecks,
} from "../lib/v1-evaluator-runtime.mjs";
import { createCanonicalDashboardProjection } from "../../viewer/lib/canonical-dashboard-projection.mjs";

const cliPath = fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url));
const testAgentCredential = "TEST-PLACEHOLDER-CLAUDE-CREDENTIAL";

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--import=${fileURLToPath(new URL("./helpers/readiness-fetch.mjs", import.meta.url))}`, ...env },
  });
}

test("a code-authored Suite runs two independent Local repeats through the canonical store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-suite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
  writeFileSync(
    join(taskRoot, "prompt.md"),
    "Read `fixtures/message.txt` and reply with its exact contents.\n",
  );
  writeFileSync(join(taskRoot, "fixtures", "message.txt"), "Hello from v1.\n");
  writeFileSync(
    join(taskRoot, "checks.mjs"),
    [
      'import { defineChecks } from "hurdle";',
      "",
      "export default defineChecks((run) => {",
      "  run.check({",
      '    id: "exact-reply",',
      '    passed: run.agentReply === "Hello from v1.",',
      '    summary: "The Agent replied with the exact fixture contents.",',
      "    evidence: [run.evidence.transcript],",
      "  });",
      '  run.expect.replyIncludes("Hello from v1.");',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "general.suite.mjs"),
    [
      'import { defineSuite } from "hurdle";',
      "",
      "export default defineSuite({",
      '  tasks: ["./tasks/copy-message"],',
      "  agents: [{",
      '    runner: "claude-code",',
      '    model: "test-model",',
      "  }],",
      "  conditions: {",
      "    default: { skills: [], mcpServers: [] },",
      "  },",
      "  repeats: 2,",
      '  verdict: "code",',
      "});",
      "",
    ].join("\n"),
  );

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
      'const { readFileSync } = require("node:fs");',
      'const reply = readFileSync("fixtures/message.txt", "utf8").trimEnd();',
      'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
      'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: reply })}\\n`);',
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);

  const validation = runCli(root, ["validate", "general.suite.mjs", "--offline"]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /^  Suite     general\.suite\.mjs$/m);
  assert.match(validation.stdout, /^  Plan      1 task · 1 condition$/m);

  const storeRoot = join(root, ".hurdle", "results-v1");
  const result = runCli(
    root,
    ["run", "general.suite.mjs"],
    {
      PATH: `${binRoot}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: testAgentCredential,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^  Plan\s+2 runs · 1 task · 1 condition$/m);
  assert.match(result.stdout, /^  Runs\s+2 passed$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const records = await store.listRuns();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map(({ invocation }) => invocation.repeatOrdinal).sort(),
    [1, 2],
  );
  assert.ok(records.every(({ verdict }) => verdict === "pass"));
  assert.ok(records.every(({ snapshot }) => snapshot.task.id === "copy-message"));
  assert.ok(records.every(({ snapshot }) => (
    snapshot.task.prompt === "Read `fixtures/message.txt` and reply with its exact contents.\n"
    && Object.hasOwn(
      snapshot.behavior.deterministicEvaluator.modules,
      "evaluators/copy-message-checks.mjs",
    )
  )));
  assert.equal(new Set(records.map(({ snapshotFingerprint }) => snapshotFingerprint)).size, 1);
  assert.ok(records.every(({ checks }) => (
    checks.length === 2
    && checks[0].id === "exact-reply"
    && checks[0].outcome === "pass"
    && checks[0].evidenceRefs.length === 1
    && checks[1].id === "reply-includes"
    && checks[1].outcome === "pass"
  )));

  const projection = createCanonicalDashboardProjection(store);
  const versions = await projection.listVersions();
  const sessions = await projection.listSessions(versions[0].id);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(({ passed, result }) => passed === true && result === "pass"));
});

test("compact Suite defaults compile identically to their explicit forms", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-suite-defaults-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with hello.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    '  run.expect.replyIncludes("hello");',
    "});",
    "",
  ].join("\n"));

  const sharedSuiteSource = [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  tasks: ["./tasks/copy-message"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
  ];
  writeFileSync(join(root, "compact.suite.mjs"), [
    ...sharedSuiteSource,
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "verbose.suite.mjs"), [
    ...sharedSuiteSource,
    "  conditions: { baseline: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const compact = await resolveV1Suite({ suitePath: join(root, "compact.suite.mjs") });
  const verbose = await resolveV1Suite({ suitePath: join(root, "verbose.suite.mjs") });
  t.after(() => compact.dispose());
  t.after(() => verbose.dispose());

  assert.equal(compact.ok, true, JSON.stringify(compact.diagnostics));
  assert.equal(verbose.ok, true, JSON.stringify(verbose.diagnostics));
  assert.deepEqual(compact.value.definition, verbose.value.definition);
  assert.equal(compact.value.definitionFingerprint, verbose.value.definitionFingerprint);
  assert.deepEqual(compact.defaults.conditionIds, ["baseline"]);
  assert.equal(compact.defaults.repeat, 1);
  assert.equal(compact.defaults.concurrency, 3);
});

test("a Task workspace preserves legacy fixture paths at the Agent workspace root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "legacy-message");
  mkdirSync(join(taskRoot, "workspace", "harness", "fixtures"), { recursive: true });
  writeFileSync(
    join(taskRoot, "prompt.md"),
    "Read `harness/fixtures/message.txt` and reply with its exact contents.\n",
  );
  writeFileSync(
    join(taskRoot, "workspace", "harness", "fixtures", "message.txt"),
    "Hello from the legacy path.\n",
  );
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    '  run.expect.replyIncludes("Hello from the legacy path.");',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "legacy.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  tasks: ["./tasks/legacy-message"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'const { readFileSync } = require("node:fs");',
    'const reply = readFileSync("harness/fixtures/message.txt", "utf8").trimEnd();',
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: reply })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const result = runCli(root, ["run", "legacy.suite.mjs"], {
    PATH: `${binRoot}:${process.env.PATH}`,
    ANTHROPIC_API_KEY: testAgentCredential,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  Runs\s+1 passed$/m);
});

test("a Local API Task can require completion while observing unavailable HTTP evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-local-api-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "local-api");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Use the configured API, then report completion.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    "  run.expect.completed();",
    "  run.observe.request({",
    '    id: "chat-completion",',
    '    method: "POST",',
    '    path: "/v1/chat/completions",',
    "    status: 200,",
    "  });",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "local.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    "  api: {",
    '    authorizationCredential: "TOGETHER_API_KEY",',
    '    hosts: ["api.together.xyz"],',
    "  },",
    '  tasks: ["./tasks/local-api"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'const present = process.env.TOGETHER_API_KEY === "TEST-LOCAL-TARGET-CREDENTIAL";',
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: present ? "credential-present" : "credential-missing" })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const storeRoot = join(root, "results");
  const result = runCli(
    root,
    ["run", "local.suite.mjs", "--store", storeRoot],
    {
      PATH: `${binRoot}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: testAgentCredential,
      TOGETHER_API_KEY: "TEST-LOCAL-TARGET-CREDENTIAL",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  Runs\s+1 passed$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const [record] = await store.listRuns();
  assert.equal(record.verdict, "pass");
  assert.equal(record.snapshot.task.credentialDefinitions[0].delivery.kind, "environment");
  assert.deepEqual(record.snapshot.task.executionRequirements, ["environment.isolated-workspace"]);
  assert.equal(record.snapshot.target.egress.captureMode, "optional");
  assert.deepEqual(
    record.checks.map(({ id, outcome, authoredAuthority }) => ({ id, outcome, authoredAuthority })),
    [
      { id: "completed", outcome: "pass", authoredAuthority: "required" },
      { id: "chat-completion", outcome: "skip", authoredAuthority: "advisory" },
    ],
  );
  const transcript = String(await store.readEvidence(
    record.evidence.transcript,
    { maxBytes: 64 * 1024 },
  ));
  assert.match(transcript, /credential-present/);
  assert.doesNotMatch(transcript, /TEST-LOCAL-TARGET-CREDENTIAL/);
});

test("request blockers compile to sandbox-only policy and fail on a blocked attempt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-block-request-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "safe-cluster-advice");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Explain how to create a cluster without creating one.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "hurdle";',
    "export default defineChecks((run) => {",
    "  run.expect.completed();",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(taskRoot, "guard.mjs"), [
    'import { defineGuard } from "hurdle";',
    "export default defineGuard((guard) => {",
    "  guard.block.request({",
    '    id: "no-reservation",',
    '    method: "POST",',
    '    path: "/v1/compute/clusters",',
    "  });",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "safe.suite.mjs"), [
    'import { defineSuite } from "hurdle";',
    "export default defineSuite({",
    '  api: { authorizationCredential: "TOGETHER_API_KEY", hosts: ["api.together.xyz"] },',
    '  tasks: ["./tasks/safe-cluster-advice"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const resolved = await resolveV1Suite({ suitePath: join(root, "safe.suite.mjs") });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true);
  const task = resolved.value.definition.tasks["safe-cluster-advice"];
  assert.deepEqual(task.egress.blockedRequests, [{
    id: "no-reservation",
    method: "POST",
    path: "/v1/compute/clusters",
  }]);
  assert.deepEqual(task.executionRequirements, [
    "environment.isolated-workspace",
    "environment.trusted-egress-capture",
    "environment.trusted-request-blocking",
  ]);
  assert.equal(task.credentialDeliveryOverrides.TOGETHER_API_KEY.kind, "captured-http-header");

  assert.ok(resolved.value.behaviorGraphsByEntry["evaluators/safe-cluster-advice.mjs"]
    .includes("evaluators/safe-cluster-advice-guard.mjs"));

  const checks = (run) => run.expect.completed();
  const guard = (value) => value.block.request({
    id: "no-reservation",
    method: "POST",
    path: "/v1/compute/clusters",
  });
  const result = evaluateChecks(checks, {
    snapshot: { target: { egress: { relevantHosts: ["api.together.xyz"] } } },
    transcript: {
      evidenceRef: `sha256:${"b".repeat(64)}`,
      jsonl: `${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`,
    },
    readArtifactText() { return { status: "missing", evidenceRef: null }; },
    egress: [{
      status: "captured",
      provenance: {
        lifecyclePhase: "execution",
        trust: "environment-observed",
      },
      requests: [{
        method: "POST",
        host: "api.together.xyz",
        path: "/v1/compute/clusters",
        statusCode: 403,
        disposition: "blocked",
        evidenceRef: `sha256:${"a".repeat(64)}`,
      }],
    }],
  }, guard);
  assert.deepEqual(result.checks.map(({ id, outcome }) => ({ id, outcome })), [
    { id: "completed", outcome: "pass" },
    { id: "no-reservation", outcome: "fail" },
  ]);
  assert.equal(
    result.checks[1].summary,
    "Blocked 1 matching request before reaching the target API.",
  );
  assert.deepEqual(result.checks[1].evidenceRefs, [`sha256:${"a".repeat(64)}`]);
});

test("request blockers reject contradictory expectations", () => {
  assert.throws(() => collectTaskDeclarations((run) => {
    run.expect.request({
      id: "create-succeeds",
      method: "POST",
      path: "/v1/compute/clusters",
      status: 200,
    });
  }, (guard) => {
    guard.block.request({
      id: "no-reservation",
      method: "POST",
      path: "/v1/compute/clusters",
    });
  }), /cannot be both expected and blocked/);
});

function jsonl(frames) {
  return `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
}

function evaluateReply(transcript, expected) {
  let agentReply;
  const { checks } = evaluateChecks((run) => {
    agentReply = run.agentReply;
    run.expect.completed();
    run.expect.replyIncludes(expected);
  }, {
    snapshot: { target: {} },
    transcript: { evidenceRef: `sha256:${"c".repeat(64)}`, jsonl: transcript },
    readArtifactText() { return { status: "missing", evidenceRef: null }; },
  });
  return { agentReply, checks: Object.fromEntries(checks.map(({ id, outcome }) => [id, outcome])) };
}

test("reply checks read the final agent message from a Codex transcript", () => {
  const codex = createCodexAdapter({ runtimeEnv: {} });
  const transcript = (frames) => codex.decodeControllerEvidence({ stdout: jsonl(frames) }).transcript;
  const replied = transcript([
    { type: "thread.started", thread_id: "codex-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Inspecting slugify**" } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Checking src/slugify.js." } },
    { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "npm test", exit_code: 0 } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Fixed: slugify replaces every space.\n\n" } },
    // Only a later completed agent message with text replaces the reply.
    { type: "item.completed", item: { id: "item_4", type: "reasoning", text: "A later note." } },
    { type: "item.started", item: { id: "item_5", type: "agent_message", text: "An unfinished message." } },
    { type: "item.completed", item: { id: "item_6", type: "agent_message" } },
    { type: "item.completed", item: { id: "item_7", type: "agent_message", text: 42 } },
    { type: "item.completed", item: null },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  assert.deepEqual(evaluateReply(replied, "Fixed: slugify"), {
    agentReply: "Fixed: slugify replaces every space.",
    checks: { completed: "pass", "reply-includes": "pass" },
  });
  assert.equal(evaluateReply(replied, "Checking").checks["reply-includes"], "fail");

  const noReply = transcript([
    { type: "thread.started", thread_id: "codex-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "npm test", exit_code: 1 } },
    { type: "turn.failed", error: { message: "The model stream disconnected." } },
  ]);
  assert.deepEqual(evaluateReply(noReply, "Fixed:"), {
    agentReply: null,
    checks: { completed: "fail", "reply-includes": "skip" },
  });
});

test("reply checks keep reading the Claude Code result frame", () => {
  const claude = jsonl([
    { type: "system", subtype: "init", session_id: "claude-session" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Checking src/slugify.js." }] },
      session_id: "claude-session",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-session",
      result: "Fixed: slugify replaces every space.\n",
    },
  ]);
  assert.deepEqual(evaluateReply(claude, "Fixed: slugify"), {
    agentReply: "Fixed: slugify replaces every space.",
    checks: { completed: "pass", "reply-includes": "pass" },
  });
  assert.equal(evaluateReply(claude, "Checking").checks["reply-includes"], "fail");

  // A result frame decides the reply even beside Codex-shaped frames and invalid lines.
  const mixed = `${jsonl([
    { type: "item.completed", item: { type: "agent_message", text: "Codex-shaped message." } },
    { type: "result", subtype: "success", result: "Claude result." },
    { type: "item.completed", item: { type: "agent_message", text: "Later Codex-shaped message." } },
  ])}not-json\n`;
  assert.equal(evaluateReply(mixed, "Claude").agentReply, "Claude result.");
});

test("failed and unavailable checks remain distinct and do not stop later repeats", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-outcomes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [taskId, passed, summary] of [
    ["failing-task", "false", "The deliberate code check failed."],
    ["unavailable-task", "null", "The required evidence was unavailable."],
  ]) {
    const taskRoot = join(root, "tasks", taskId);
    mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
    writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
    writeFileSync(join(taskRoot, "fixtures", "message.txt"), "done\n");
    writeFileSync(join(taskRoot, "checks.mjs"), [
      'import { defineChecks } from "tae";',
      "",
      "export default defineChecks((run) => {",
      "  run.check({",
      `    id: ${JSON.stringify(taskId)},`,
      `    passed: ${passed},`,
      `    summary: ${JSON.stringify(summary)},`,
      "  });",
      "});",
      "",
    ].join("\n"));
  }
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  tasks: ["./tasks/failing-task", "./tasks/unavailable-task"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 2,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const binRoot = join(root, "bin");
  mkdirSync(binRoot);
  const fakeClaude = join(binRoot, "claude");
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) { console.log("test-agent"); process.exit(0); }',
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: `session-${process.pid}` })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: `session-${process.pid}`, model: "test-model", result: "done" })}\\n`);',
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const storeRoot = join(root, "results");
  const result = runCli(
    root,
    ["run", "general.suite.mjs", "--store", storeRoot],
    {
      PATH: `${binRoot}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: testAgentCredential,
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^  Plan\s+4 runs · 2 tasks · 1 condition$/m);
  assert.match(result.stdout, /^  Runs\s+2 failed · 2 incomplete$/m);

  const store = await openLocalResultStore({ root: storeRoot });
  const records = await store.listRuns();
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.filter(({ snapshot }) => snapshot.task.id === "failing-task")
      .map(({ invocation }) => invocation.repeatOrdinal).sort(),
    [1, 2],
  );
  assert.deepEqual(
    records.filter(({ snapshot }) => snapshot.task.id === "unavailable-task")
      .map(({ invocation }) => invocation.repeatOrdinal).sort(),
    [1, 2],
  );
  assert.ok(records
    .filter(({ snapshot }) => snapshot.task.id === "failing-task")
    .every(({ verdict, checks }) => verdict === "fail" && checks[0].outcome === "fail"));
  assert.ok(records
    .filter(({ snapshot }) => snapshot.task.id === "unavailable-task")
    .every(({ state, verdict, checks }) => (
      state === "complete" && verdict === "incomplete" && checks[0].outcome === "skip"
    )));

  const projection = createCanonicalDashboardProjection(store);
  const versions = await projection.listVersions();
  const sessions = await projection.listSessions(versions[0].id);
  assert.equal(sessions.filter(({ result }) => result === "fail").length, 2);
  assert.equal(sessions.filter(({ result }) => result === "incomplete").length, 2);
});

test("v1 rejects the removed task.json configuration surface", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-task-json-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    '  run.check({ id: "done", passed: true, summary: "Done." });',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(taskRoot, "task.json"), "{}\n");
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/copy-message"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const result = runCli(root, ["validate", "general.suite.mjs", "--offline"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /task\.json is not supported by the v1 facade/);
});

test("v1 reports an unreadable fixture as a Task diagnostic", { skip: process.getuid?.() === 0 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-unreadable-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "hurdle";',
    "export default defineChecks((run) => {",
    '  run.check({ id: "done", passed: true, summary: "Done." });',
    "});",
    "",
  ].join("\n"));
  const fixture = join(taskRoot, "fixtures", "secret.txt");
  writeFileSync(fixture, "private\n");
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "hurdle";',
    "export default defineSuite({",
    '  tasks: ["./tasks/copy-message"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));
  chmodSync(fixture, 0o000);

  let result;
  try {
    result = runCli(root, ["validate", "general.suite.mjs", "--offline"]);
  } finally {
    chmodSync(fixture, 0o600);
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[task\.fixture-unreadable\]/);
  assert.doesNotMatch(result.stderr, /internal-error/);
});

test("v1 rejects duplicate completion checks during validation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-completed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "duplicate-completion");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply with `done`.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    "  run.expect.completed();",
    "  run.expect.completed();",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/duplicate-completion"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const result = runCli(root, ["validate", "general.suite.mjs", "--offline"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[task\.checks-invalid\]/);
});

test("v1 rejects fixture and workspace paths that target the same Agent file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-fixture-collision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const taskRoot = join(root, "tasks", "duplicate-input");
  mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
  mkdirSync(join(taskRoot, "workspace", "fixtures"), { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Read `fixtures/message.txt`.\n");
  writeFileSync(join(taskRoot, "fixtures", "message.txt"), "first\n");
  writeFileSync(join(taskRoot, "workspace", "fixtures", "message.txt"), "second\n");
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    '  run.expect.replyIncludes("first");',
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "export default defineSuite({",
    '  tasks: ["./tasks/duplicate-input"],',
    '  agents: [{ runner: "claude-code", model: "test-model" }],',
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));

  const result = runCli(root, ["validate", "general.suite.mjs", "--offline"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[task\.fixture-collision\]/);
});


test("Suite concurrency accepts an explicit limit and rejects invalid values", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-suite-concurrency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskRoot = join(root, "tasks", "copy-message");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), "Reply hello.");
  writeFileSync(join(taskRoot, "checks.mjs"), 'import { defineChecks } from "hurdle"; export default defineChecks(run => run.expect.replyIncludes("hello"));');
  for (const [index, value] of ["3", "100", "0", "-1", "101", "1.5", '"5"', "null", "NaN"].entries()) {
    const suitePath = join(root, `limit-${index}.suite.mjs`);
    writeFileSync(suitePath, `import { defineSuite } from "hurdle"; export default defineSuite({ tasks: ["./tasks/copy-message"], agents: [{runner: "claude-code"}], concurrency: ${value}, verdict: "code" });`);
    if (index < 2) {
      const resolved = await resolveV1Suite({ suitePath });
      assert.equal(resolved.defaults.concurrency, Number(value));
      resolved.dispose();
    } else {
      await assert.rejects(resolveV1Suite({ suitePath }), error => error.code === "suite.concurrency-invalid");
    }
  }
});
