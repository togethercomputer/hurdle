import assert from "node:assert/strict";
import {
  initializeStarterRunPlan,
  resolveStarterRunPlan,
} from "./helpers/run-plan-starter.mjs";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { createLocalExecutionEnvironment } from "../lib/execution-environments/local.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";

function createHermeticProcessAdapter(scriptPath, {
  id = "hermetic-process",
  timeoutMs = 5_000,
  capabilities = [],
} = {}) {
  return {
    id,
    capabilities,
    normalizeSettings({ requestedModel, settings }) {
      return {
        requestedModel: requestedModel ?? null,
        settings: settings ?? {},
      };
    },
    createLaunchPlan({ prompt }) {
      return {
        command: process.execPath,
        args: [scriptPath],
        env: {},
        stdin: prompt,
        timeoutMs,
      };
    },
    decodeControllerEvidence({ stdout }) {
      const frames = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const result = frames.findLast((frame) => frame.type === "result");
      return {
        transcript: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
        observedModel: result?.model ?? null,
        sessionId: result?.session_id ?? null,
        metrics: {
          common: {},
          adapter: {},
        },
      };
    },
  };
}

for (const name of ["HOME", "PIP_REQUIRE_VIRTUALENV"]) {
  test(`Local rejects the framework-owned credential name ${name} before allocation`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "tae-local-credential-collision-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runPlan = await initializeStarterRunPlanFixture(root, {
      mutateDefinition(definition) {
        definition.credentialRequirements[name] = { minimumScopes: ["project"], delivery: { kind: "environment" } };
        definition.tasks["copy-message"].credentialRequirements = [name];
      },
    });
    const store = await openLocalResultStore({ root: join(root, "results") });
    let allocations = 0;
    const local = createLocalExecutionEnvironment();
    const engine = createRunEngine({
      resultStore: store,
      agentAdapter: createHermeticProcessAdapter(writeHermeticAgentScript(root)),
      executionEnvironment: { ...local, async execute(input) { allocations += 1; return local.execute(input); } },
    });
    const result = await engine.run({ runPlan, credentials: { [name]: "controlled-credential" } });
    assert.equal(result.status, "rejected");
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "credential.environment-collision"));
    assert.equal(allocations, 0);
    assert.deepEqual(await store.listRuns(), []);
  });
}

function writeHermeticAgentScript(root, body = []) {
  const scriptPath = join(root, `hermetic-agent-${randomUUID()}.mjs`);
  writeFileSync(
    scriptPath,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      ...body,
      'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "test-session" })}\\n`);',
      'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "test-session", model: "test-model" })}\\n`);',
      "",
    ].join("\n"),
  );
  return scriptPath;
}

function writeExecutableAgent(root, name, body) {
  const scriptPath = join(root, `${name}-${randomUUID()}`);
  writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    'const { readFileSync, writeFileSync } = require("node:fs");',
    'const prompt = readFileSync(0, "utf8");',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    ...body,
    "",
  ].join("\n"));
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function waitForPath(path, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for '${path}'`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function initializeStarterRunPlanFixture(root, {
  evaluatorSource,
  mutateDefinition,
} = {}) {
  const sourceRoot = join(root, "run-plan-fixture");
  const initialized = await initializeStarterRunPlan({ destination: sourceRoot });
  assert.equal(initialized.ok, true);
  if (mutateDefinition) {
    const definitionPath = join(sourceRoot, "run-plan.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    mutateDefinition(definition);
    writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  }
  if (evaluatorSource) {
    writeFileSync(join(sourceRoot, "evaluators", "exact-copy.mjs"), evaluatorSource);
  }
  return resolveStarterRunPlan({ sourceRoot });
}

function configureJudgeAuthorityV2(definition, {
  id,
  kind,
  evaluator = true,
}) {
  definition.schemaVersion = 2;
  definition.authorityProfiles = [{
    schemaVersion: 1,
    id,
    kind,
    checkPolicy: { defaultRule: "authored" },
    judge: {
      availability: "required",
      capability: {
        judgeId: "controlled-judge-v2",
        model: "judge-test-model-v2",
        inputSchemaVersion: 2,
      },
      timeoutMs: 1_000,
      projection: {
        schemaVersion: 1,
        include: {
          transcript: true,
          stderr: false,
          textArtifacts: true,
          egress: false,
          lifecycleReceipts: false,
          runTrustIssues: true,
          baselineDeterministicOutcome: true,
          effectiveDeterministicOutcome: true,
          requiredChecks: true,
          advisoryChecks: false,
        },
        limits: {
          maxEvidenceItems: 8,
          maxEvidenceItemBytes: 4_096,
          maxEvidenceTextBytes: 16_384,
          maxChecks: 8,
          maxRunTrustIssues: 8,
          maxInputBytes: 65_536,
        },
      },
      output: { maxSummaryBytes: 1_024 },
    },
  }];
  const task = definition.tasks["copy-message"];
  if (!evaluator) delete task.evaluation.deterministicEvaluator;
  task.evaluation.authority = {
    defaultProfileId: id,
    bindings: [{
      profileId: id,
      rubric: "Apply the controlled rubric.",
      checkRules: evaluator
        ? [{ checkId: "exact-copy", rule: "required" }]
        : [],
    }],
  };
}

async function runStarter({
  root,
  runPlan,
  agentScript,
  adapterOptions,
  agentAdapter = createHermeticProcessAdapter(agentScript, adapterOptions),
  progressObserver = null,
  runRequest = {},
}) {
  const storeRoot = join(root, `results-${randomUUID()}`);
  const store = await openLocalResultStore({ root: storeRoot });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter,
    executionEnvironment: createLocalExecutionEnvironment(),
    progressObserver,
  });
  const result = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
    requestedModel: "test-model",
    experimentVersion: "starter-local-test",
    ...runRequest,
  });
  const [run] = result.runs;
  return { store, storeRoot, result, run, record: await store.getRun(run.id) };
}

test("Run Engine reports accepted cell progress from the stored terminal reference", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const events = [];

  const { run, record } = await runStarter({
    root,
    runPlan,
    agentScript,
    progressObserver: { observe(event) { events.push(event); } },
  });

  assert.deepEqual(record.checks.map(({ id, outcome }) => [id, outcome]), [["exact-copy", "pass"]]);
  assert.deepEqual(events, [
    { kind: "matrix-ready", total: 1 },
    {
      kind: "cell-started",
      cell: {
        ordinal: 1,
        total: 1,
        taskId: "copy-message",
        conditionId: "default",
        adapterId: "hermetic-process",
        repeatOrdinal: 1,
        repeatTotal: 1,
      },
    },
    { kind: "cell-attempt-started", cell: events[1].cell, executionId: run.id },
    { kind: "cell-finalizing", cell: events[1].cell },
    {
      kind: "cell-completed",
      cell: {
        ordinal: 1,
        total: 1,
        taskId: "copy-message",
        conditionId: "default",
        adapterId: "hermetic-process",
        repeatOrdinal: 1,
        repeatTotal: 1,
      },
      terminal: {
        id: run.id,
        verdict: run.verdict,
        verdictReasons: [],
        checks: record.checks.map(({ id, outcome, effectiveAuthority, summary }) => ({
          id, outcome, effectiveAuthority, summary,
        })),
      },
    },
  ]);
});

async function recordStoreHistory(record, store) {
  return (await store.getRunHistory(record.id))
    .map(({ revision, state, verdict }) => ({ revision, state, verdict }));
}

test("the Starter evaluation completes through the Run Engine and Local Result Store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);

  const agentScript = writeHermeticAgentScript(root, [
      'const message = readFileSync("fixtures/message.txt", "utf8");',
      'writeFileSync("answer.txt", message);',
  ]);

  const { store, record } = await runStarter({ root, runPlan, agentScript });
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "pass");
  assert.equal(record.judgeStatus, "not_requested");
  assert.equal(record.snapshot.agent.requestedModel, "test-model");
  assert.equal(record.snapshot.task.id, "copy-message");
  assert.equal(record.snapshot.condition.id, "default");
  assert.equal(record.experimentVersion, "starter-local-test");
  assert.match(record.snapshotFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    record.snapshotFingerprint,
    runPlan.definitionFingerprint,
  );
  assert.equal(record.evidence.transcript.provenance, "controller_observed_parent_pipe");
  const evaluatorSources = record.evidence.structured.filter(({ provenance }) => (
    provenance.startsWith("run_definition_behavior_source:")
  ));
  assert.deepEqual(
    evaluatorSources.map(({ provenance, sha256, mediaType, authority, trust }) => ({
      provenance,
      sha256,
      mediaType,
      authority,
      trust,
    })),
    [{
      provenance: "run_definition_behavior_source:evaluators%2Fexact-copy.mjs",
      sha256: record.snapshot.behavior.deterministicEvaluator.modules[
        "evaluators/exact-copy.mjs"
      ],
      mediaType: "text/javascript; charset=utf-8",
      authority: "controller",
      trust: "controller_verified",
    }],
  );
  assert.equal(
    Buffer.from(await store.readEvidence(evaluatorSources[0], { maxBytes: 512 * 1024 }))
      .toString("utf8"),
    readFileSync(join(runPlan.sourceRoot, "evaluators", "exact-copy.mjs"), "utf8"),
  );
  assert.deepEqual(
    {
      authority: record.evidence.transcript.authority,
      producer: record.evidence.transcript.producer,
      lifecyclePhase: record.evidence.transcript.lifecyclePhase,
      trust: record.evidence.transcript.trust,
    },
    {
      authority: "controller",
      producer: "agent",
      lifecyclePhase: "execute",
      trust: "controller_observed",
    },
  );
  assert.match(record.evidence.transcript.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    record.evidence.artifacts.map(({ path, status }) => ({ path, status })),
    [{ path: "answer.txt", status: "captured" }],
  );
  assert.equal(record.checks[0].id, "exact-copy");
  assert.equal(record.checks[0].outcome, "pass");

  const answer = await store.readEvidence(
    record.evidence.artifacts[0].content,
    { maxBytes: 4096 },
  );
  assert.equal(answer.toString("utf8"), "Hello from the fixture.\n");

  const history = await store.getRunHistory(record.id);
  assert.deepEqual(
    history.map(({ revision, state, verdict }) => ({ revision, state, verdict })),
    [
      { revision: 0, state: "queued", verdict: null },
      { revision: 1, state: "running", verdict: null },
      { revision: 2, state: "complete", verdict: "pass" },
    ],
  );
  assert.equal(
    store[Symbol.for("tae.internal.result-store-writer.v1")],
    undefined,
    "the public Result Store must not expose a recoverable write authority",
  );
});

test("Claude Code and Codex run the same Starter cell through the public boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-first-party-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root);

  const fakeClaude = writeExecutableAgent(root, "fake-claude", [
    'process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "claude-session", model: "claude-test", usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0, num_turns: 1 })}\\n`);',
  ]);
  const fakeCodex = writeExecutableAgent(root, "fake-codex", [
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-session" })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "file_change" } })}\\n`);',
    'process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } })}\\n`);',
  ]);
  const [claude, codex] = await Promise.all([
    runStarter({
      root,
      runPlan,
      agentAdapter: createClaudeCodeAdapter({
        runtimeEnv: {
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: "test-claude-key",
        },
        command: fakeClaude,
        timeoutMs: 5_000,
      }),
    }),
    runStarter({
      root,
      runPlan,
      agentAdapter: createCodexAdapter({
        runtimeEnv: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "test-openai-key",
        },
        command: fakeCodex,
        timeoutMs: 5_000,
      }),
    }),
  ]);

  for (const { record, store } of [claude, codex]) {
    assert.equal(record.state, "complete");
    assert.equal(record.verdict, "pass");
    assert.equal(record.snapshot.task.id, "copy-message");
    assert.equal(record.snapshot.condition.id, "default");
    assert.equal(record.evidence.transcript.provenance, "controller_observed_parent_pipe");
    assert.deepEqual(
      record.evidence.artifacts.map(({ path, status }) => ({ path, status })),
      [{ path: "answer.txt", status: "captured" }],
    );
    assert.deepEqual(
      record.checks.map(({ id, outcome }) => ({ id, outcome })),
      [{ id: "exact-copy", outcome: "pass" }],
    );
    assert.deepEqual(
      await recordStoreHistory(record, store),
      [
        { revision: 0, state: "queued", verdict: null },
        { revision: 1, state: "running", verdict: null },
        { revision: 2, state: "complete", verdict: "pass" },
      ],
    );
  }

  const [claudeAnswer, codexAnswer] = await Promise.all([
    claude.store.readEvidence(claude.record.evidence.artifacts[0].content, { maxBytes: 4096 }),
    codex.store.readEvidence(codex.record.evidence.artifacts[0].content, { maxBytes: 4096 }),
  ]);
  assert.deepEqual(claudeAnswer, codexAnswer);
  assert.equal(claude.record.execution.adapterId, "claude-code");
  assert.equal(claude.record.execution.sessionId, "claude-session");
  assert.equal(claude.record.metrics.common.toolCalls, null);
  assert.equal(codex.record.execution.adapterId, "codex");
  assert.equal(codex.record.execution.sessionId, "codex-session");
  assert.equal(codex.record.metrics.common.toolCalls, 1);
  assert.equal(codex.record.metrics.adapters.codex.fileChanges, 1);
});

test("invalid Codex controller JSONL remains an observed incomplete run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-codex-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root);
  const fakeCodex = writeExecutableAgent(root, "fake-codex-invalid", [
    'process.stdout.write("not-json\\n");',
    "process.exitCode = 4;",
  ]);

  const { record } = await runStarter({
    root,
    runPlan,
    agentAdapter: createCodexAdapter({
      runtimeEnv: { PATH: process.env.PATH },
      command: fakeCodex,
      timeoutMs: 5_000,
    }),
  });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.execution.adapterId, "codex");
  assert.equal(record.execution.exitCode, 4);
  assert.equal(record.execution.timedOut, false);
  assert.equal(record.evidence.transcript, null);
  assert.ok(
    record.integrityIssues.some(({ code }) => code === "controller.transcript-invalid"),
  );
  assert.ok(
    record.integrityIssues.some(({ code }) => code === "environment.nonzero-exit"),
  );
});

test("a recognized Claude billing failure becomes the primary non-pass reason", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-claude-billing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root);
  const fakeClaude = join(root, `fake-claude-billing-${randomUUID()}`);
  writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'process.stdout.write(`${JSON.stringify({',
    '  type: "result", subtype: "success", session_id: "billing-session",',
    '  terminal_reason: "api_error", is_error: true, api_error_status: 400,',
    '  result: "Credit balance is too low",',
    '})}\\n`);',
    "process.exitCode = 1;",
    "",
  ].join("\n"));
  chmodSync(fakeClaude, 0o755);

  const { record } = await runStarter({
    root,
    runPlan,
    agentAdapter: createClaudeCodeAdapter({
      runtimeEnv: {
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "test-claude-key",
      },
      command: fakeClaude,
      timeoutMs: 5_000,
    }),
  });

  assert.equal(record.verdict, "incomplete");
  assert.deepEqual(record.verdictReasons.slice(0, 2).map(({ code }) => code), [
    "environment.nonzero-exit",
    "artifact.required-missing",
  ]);
  assert.equal(
    record.verdictReasons[0].summary,
    "The evaluated agent process did not exit cleanly: Claude Code could not run because the Anthropic credit balance is too low.",
  );
});

test("Run Engine expands every selected Task and Condition cell", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-matrix-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message-alt"] = structuredClone(
        definition.tasks["copy-message"],
      );
      definition.conditions.alternate = { displayName: "Alternate" };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const progressEvents = [];
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    progressObserver: { observe(event) { progressEvents.push(event); } },
  });

  const result = await engine.run({ runPlan, requestedModel: "test-model", concurrency: 1 });
  assert.equal(result.runs.length, 4);
  const records = await Promise.all(result.runs.map(({ id }) => store.getRun(id)));
  assert.deepEqual(
    records.map(({ snapshot }) => [snapshot.task.id, snapshot.condition.id]),
    [
      ["copy-message", "default"],
      ["copy-message", "alternate"],
      ["copy-message-alt", "default"],
      ["copy-message-alt", "alternate"],
    ],
  );
  assert.deepEqual(
    records.map(({ invocation }) => [invocation.ordinal, invocation.total]),
    [[1, 4], [2, 4], [3, 4], [4, 4]],
  );
  assert.ok(records.every(({ verdict }) => verdict === "pass"));
  assert.deepEqual(
    progressEvents.map((event) => (
      event.kind === "matrix-ready"
        ? [event.kind, event.total]
        : [event.kind, event.cell.ordinal, event.cell.total]
    )),
    [
      ["matrix-ready", 4],
      ["cell-started", 1, 4],
      ["cell-attempt-started", 1, 4],
      ["cell-finalizing", 1, 4],
      ["cell-completed", 1, 4],
      ["cell-started", 2, 4],
      ["cell-attempt-started", 2, 4],
      ["cell-finalizing", 2, 4],
      ["cell-completed", 2, 4],
      ["cell-started", 3, 4],
      ["cell-attempt-started", 3, 4],
      ["cell-finalizing", 3, 4],
      ["cell-completed", 3, 4],
      ["cell-started", 4, 4],
      ["cell-attempt-started", 4, 4],
      ["cell-finalizing", 4, 4],
      ["cell-completed", 4, 4],
    ],
  );

  const equivalent = await engine.run({
    runPlan,
    taskIds: ["copy-message"],
    conditionIds: ["default"],
    agentSelections: [{
      adapterId: "hermetic-process",
      requestedModel: "test-model",
      settings: {},
    }],
  });
  const equivalentRecord = await store.getRun(equivalent.runs[0].id);
  assert.equal(
    equivalentRecord.snapshotFingerprint,
    records[0].snapshotFingerprint,
    "equivalent scalar and selected-matrix requests keep one definition identity",
  );
});

test("one Run Engine call expands explicit agent profiles and repeats", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-selected-matrix-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message-alt"] = structuredClone(
        definition.tasks["copy-message"],
      );
      definition.conditions.alternate = { displayName: "Alternate" };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapters: [
      createHermeticProcessAdapter(agentScript, { id: "agent-a" }),
      createHermeticProcessAdapter(agentScript, { id: "agent-b" }),
    ],
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  const result = await engine.run({
    runPlan,
    agentSelections: [
      { adapterId: "agent-a", requestedModel: "model-a", settings: {} },
      { adapterId: "agent-b", requestedModel: "model-b", settings: {} },
    ],
    repeat: 2,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.runs.length, 16);
  assert.deepEqual(result.summary, {
    plannedCells: 8,
    plannedRepeats: 16,
    attempts: 16,
    retriesPerformed: 0,
    terminalVerdicts: { pass: 16, fail: 0, incomplete: 0, unknown: 0 },
    authorityCoverage: {
      recordedRuns: 16,
      totalRuns: 16,
      judgeCompletedRuns: 0,
      judgeRequiredRuns: 0,
      comparableRuns: 0,
      agreements: 0,
      disagreements: 0,
    },
    nonPasses: [],
    omittedNonPasses: 0,
  });
  const records = await Promise.all(result.runs.map(({ id }) => store.getRun(id)));
  assert.deepEqual(
    records.map(({ snapshot, invocation }) => [
      snapshot.task.id,
      snapshot.condition.id,
      snapshot.agent.adapterId,
      snapshot.agent.requestedModel,
      invocation.repeatOrdinal,
    ]),
    [
      ["copy-message", "default", "agent-a", "model-a", 1],
      ["copy-message", "default", "agent-a", "model-a", 2],
      ["copy-message", "default", "agent-b", "model-b", 1],
      ["copy-message", "default", "agent-b", "model-b", 2],
      ["copy-message", "alternate", "agent-a", "model-a", 1],
      ["copy-message", "alternate", "agent-a", "model-a", 2],
      ["copy-message", "alternate", "agent-b", "model-b", 1],
      ["copy-message", "alternate", "agent-b", "model-b", 2],
      ["copy-message-alt", "default", "agent-a", "model-a", 1],
      ["copy-message-alt", "default", "agent-a", "model-a", 2],
      ["copy-message-alt", "default", "agent-b", "model-b", 1],
      ["copy-message-alt", "default", "agent-b", "model-b", 2],
      ["copy-message-alt", "alternate", "agent-a", "model-a", 1],
      ["copy-message-alt", "alternate", "agent-a", "model-a", 2],
      ["copy-message-alt", "alternate", "agent-b", "model-b", 1],
      ["copy-message-alt", "alternate", "agent-b", "model-b", 2],
    ],
  );
  for (let index = 0; index < records.length; index += 2) {
    assert.equal(
      records[index].snapshotFingerprint,
      records[index + 1].snapshotFingerprint,
      "repeats of one definition cell keep the stable snapshot identity",
    );
    assert.notEqual(records[index].id, records[index + 1].id);
  }
});

test("equivalent normalized profiles cannot create duplicate definition cells", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-duplicate-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  let allocations = 0;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute(input) {
        allocations += 1;
        return local.execute(input);
      },
    },
  });

  const result = await engine.run({
    runPlan,
    agentSelections: [
      {
        adapterId: "hermetic-process",
        requestedModel: "test-model",
        settings: { first: 1, second: 2 },
      },
      {
        adapterId: "hermetic-process",
        requestedModel: "test-model",
        settings: { second: 2, first: 1 },
      },
    ],
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.diagnostics[0].code, "matrix.duplicate-cell");
  assert.equal(allocations, 0);
  assert.deepEqual(await store.listRuns(), []);
});

test("Run Engine returns selection diagnostics instead of rejected promises", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-selection-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  let allocations = 0;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute(input) {
        allocations += 1;
        return local.execute(input);
      },
    },
  });

  for (const request of [
    { taskIds: ["missing-task"] },
    { conditionIds: ["missing-condition"] },
    {
      agentSelections: [{
        adapterId: "missing-agent",
        requestedModel: null,
        settings: {},
      }],
    },
    { taskIds: ["copy-message", "copy-message"] },
  ]) {
    const result = await engine.run({ runPlan, ...request });
    assert.equal(result.status, "rejected");
    assert.equal(result.diagnostics[0].category, "selection");
    assert.equal(result.summary.attempts, 0);
  }
  assert.equal(allocations, 0);
  assert.deepEqual(await store.listRuns(), []);
});

test("omitted and empty execution requirements have one snapshot identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-requirement-default-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const omittedRoot = join(root, "omitted");
  const explicitRoot = join(root, "explicit");
  mkdirSync(omittedRoot);
  mkdirSync(explicitRoot);
  const omitted = await initializeStarterRunPlanFixture(omittedRoot);
  const explicit = await initializeStarterRunPlanFixture(explicitRoot, {
    mutateDefinition(definition) {
      definition.conditions.default.executionRequirements = [];
      definition.tasks["copy-message"].executionRequirements = [];
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const [omittedRun, explicitRun] = await Promise.all([
    runStarter({ root: join(root, "omitted-run"), runPlan: omitted, agentScript }),
    runStarter({ root: join(root, "explicit-run"), runPlan: explicit, agentScript }),
  ]);

  assert.equal(
    omittedRun.record.snapshotFingerprint,
    explicitRun.record.snapshotFingerprint,
  );
});

test("matrix preparation does not freeze stateful Agent Adapter dependencies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-stateful-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const baseAdapter = createHermeticProcessAdapter(agentScript);
  const agentAdapter = {
    ...baseAdapter,
    attempts: 0,
    createLaunchPlan(input) {
      this.attempts += 1;
      return baseAdapter.createLaunchPlan(input);
    },
  };

  const { record } = await runStarter({
    root,
    runPlan,
    agentScript,
    agentAdapter,
  });

  assert.equal(record.verdict, "pass");
  assert.equal(agentAdapter.attempts, 1);
});

test("an unsupported later matrix cell rejects before environment allocation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-capability-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.conditions.alternate = {
        displayName: "Needs trusted egress",
        executionRequirements: ["environment.trusted-egress-capture"],
      };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  let allocations = 0;
  const environment = {
    ...local,
    capabilities: [],
    async execute(input) {
      allocations += 1;
      return local.execute(input);
    },
  };
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: environment,
  });

  const result = await engine.run({ runPlan });

  assert.equal(result.status, "rejected");
  assert.equal(result.summary.attempts, 0);
  assert.equal(allocations, 0);
  assert.deepEqual(await store.listRuns(), []);
  assert.deepEqual(
    result.diagnostics.map(({ code, conditionId, capability }) => ({
      code,
      conditionId,
      capability,
    })),
    [{
      code: "matrix.capability-missing",
      conditionId: "alternate",
      capability: "environment.trusted-egress-capture",
    }],
  );

  const supported = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...environment,
      capabilities: ["environment.trusted-egress-capture"],
    },
  });
  const completed = await supported.run({ runPlan });
  assert.equal(completed.status, "complete");
  assert.equal(completed.runs.length, 2);
  assert.equal(allocations, 2);
});

test("fixed execution retries are immediate, linked, and zero by default", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-fixed-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const attemptCounter = join(root, "attempt-count.txt");
  writeFileSync(attemptCounter, "0");
  const agentScript = writeHermeticAgentScript(root, [
    `const attemptPath = ${JSON.stringify(attemptCounter)};`,
    'const attempt = Number(readFileSync(attemptPath, "utf8"));',
    'writeFileSync(attemptPath, String(attempt + 1));',
    'if (attempt === 0) { process.exitCode = 7; }',
    'else { writeFileSync("answer.txt", readFileSync("fixtures/message.txt")); }',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  const withoutRetries = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
  });
  assert.equal(withoutRetries.runs.length, 1);
  assert.equal(withoutRetries.runs[0].verdict, "incomplete");
  assert.equal(withoutRetries.summary.retriesPerformed, 0);

  writeFileSync(attemptCounter, "0");
  const withRetry = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
    retries: 1,
  });

  assert.equal(withRetry.status, "complete");
  assert.equal(withRetry.runs.length, 2);
  assert.deepEqual(withRetry.summary, {
    plannedCells: 1,
    plannedRepeats: 1,
    attempts: 2,
    retriesPerformed: 1,
    terminalVerdicts: { pass: 1, fail: 0, incomplete: 0, unknown: 0 },
    authorityCoverage: {
      recordedRuns: 1,
      totalRuns: 1,
      judgeCompletedRuns: 0,
      judgeRequiredRuns: 0,
      comparableRuns: 0,
      agreements: 0,
      disagreements: 0,
    },
    nonPasses: [],
    omittedNonPasses: 0,
  });
  const [first, second] = await Promise.all(
    withRetry.runs.map(({ id }) => store.getRun(id)),
  );
  assert.equal(first.verdict, "incomplete");
  assert.equal(second.verdict, "pass");
  assert.equal(first.snapshotFingerprint, second.snapshotFingerprint);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.invocation, {
    groupId: withRetry.groupId,
    ordinal: 1,
    total: 1,
    repeatOrdinal: 1,
    repeatTotal: 1,
    retryPolicy: {
      kind: "fixed-execution-failures-v1",
      maxRetries: 1,
      retryableIssueCodes: [
        "environment.spawn-failed",
        "environment.timed-out",
        "environment.nonzero-exit",
      ],
      blockingIssueCodes: [
        "environment.not-quiescent",
        "environment.dispose-failed",
      ],
    },
    attemptOrdinal: 1,
    rootRunId: first.id,
    retryOf: null,
    retryTrigger: null,
  });
  assert.deepEqual(second.invocation, {
    ...first.invocation,
    attemptOrdinal: 2,
    rootRunId: first.id,
    retryOf: first.id,
    retryTrigger: "environment.nonzero-exit",
  });
});

test("Local Result Store rejects mutable invocation history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-invocation-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const { store, storeRoot, run } = await runStarter({
    root,
    runPlan,
    agentScript,
  });
  const runningRevisionPath = join(
    storeRoot,
    "runs",
    run.id,
    "revisions",
    "000001.json",
  );
  const running = JSON.parse(readFileSync(runningRevisionPath, "utf8"));
  running.invocation.attemptOrdinal = 99;
  writeFileSync(runningRevisionPath, `${JSON.stringify(running, null, 2)}\n`);

  await assert.rejects(
    store.getRunHistory(run.id),
    /run invocation cannot change/,
  );
});

test("complete is published only after local sealing and disposal return", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-lifecycle-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  const observedStates = [];
  const environment = {
    ...local,
    async execute(input) {
      observedStates.push((await store.listRuns())[0].state);
      const evidence = await local.execute(input);
      observedStates.push(evidence.artifacts[0].status);
      observedStates.push((await store.listRuns())[0].state);
      return evidence;
    },
  };
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: environment,
  });

  const { runs: [run] } = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
  });
  assert.deepEqual(observedStates, ["running", "captured", "running"]);
  assert.equal((await store.getRun(run.id)).state, "complete");
});

test("a missing required Output Artifact is incomplete rather than a deterministic failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-missing-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root);
  const { record, result } = await runStarter({
    root,
    runPlan,
    agentScript,
    runRequest: { retries: 2 },
  });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(result.runs.length, 1);
  assert.equal(result.summary.retriesPerformed, 0);
  assert.deepEqual(
    record.evidence.artifacts.map(({ path, status }) => ({ path, status })),
    [{ path: "answer.txt", status: "missing" }],
  );
  assert.ok(
    record.integrityIssues.some(({ code }) => code === "artifact.required-missing"),
  );
  assert.equal(record.checks.length, 0);
});

test("a declared Output Artifact cannot seal a hard-linked host file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-hard-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const hostFile = join(root, "host-secret.txt");
  writeFileSync(hostFile, "not agent output\n");
  const agentScript = writeHermeticAgentScript(root, [
    'import { linkSync } from "node:fs";',
    `linkSync(${JSON.stringify(hostFile)}, "answer.txt");`,
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.deepEqual(
    record.evidence.artifacts.map(({ path, status, reason, content }) => ({
      path,
      status,
      reason,
      content,
    })),
    [{ path: "answer.txt", status: "rejected", reason: "hard_link", content: null }],
  );
  assert.equal(record.checks.length, 0);
});

test("a declared Output Artifact cannot seal a symlink", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-output-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const hostFile = join(root, "host-file.txt");
  writeFileSync(hostFile, "not agent output\n");
  const agentScript = writeHermeticAgentScript(root, [
    'import { symlinkSync as createSymlink } from "node:fs";',
    `createSymlink(${JSON.stringify(hostFile)}, "answer.txt");`,
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.deepEqual(
    record.evidence.artifacts.map(({ path, status, reason, content }) => ({
      path,
      status,
      reason,
      content,
    })),
    [{ path: "answer.txt", status: "rejected", reason: "symlink", content: null }],
  );
});

test("invalid UTF-8 in a required text artifact is incomplete", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-invalid-text-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", Buffer.from([0xff]));',
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.evidence.artifacts[0].status, "captured");
  assert.equal(record.evidence.artifacts[0].textEncoding, "invalid_utf8");
  assert.equal(record.checks.length, 0);
  assert.ok(
    record.integrityIssues.some(({ code }) => code === "artifact.required-invalid-text"),
  );
});

test("local timeout escalates to SIGKILL when the agent ignores SIGTERM", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'process.on("SIGTERM", () => {});',
    'setTimeout(() => process.exit(0), 800);',
  ]);
  const { record } = await runStarter({
    root,
    runPlan,
    agentScript,
    adapterOptions: { timeoutMs: 200 },
  });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.execution.timedOut, true);
  assert.equal(record.execution.signal, "SIGKILL");
  assert.ok(record.execution.durationMs < 650);
});

test("local execution abort stops the evaluated process group", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-abort-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const readyPath = join(root, "agent-ready");
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'process.on("SIGTERM", () => {});',
    `writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
    'setTimeout(() => process.exit(0), 5_000);',
  ]);
  const controller = new AbortController();
  const running = runStarter({
    root,
    runPlan,
    agentScript,
    adapterOptions: { timeoutMs: 10_000 },
    runRequest: { signal: controller.signal },
  });
  await waitForPath(readyPath);
  const abortedAt = Date.now();
  controller.abort(new Error("controller interrupted"));

  const { record } = await running;

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.execution.timedOut, false);
  assert.equal(record.execution.signal, "SIGKILL");
  assert.ok(Date.now() - abortedAt < 1_250);
});

test("cancelling an unfinished local Agent records cancellation, not a failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-cancel-running-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const readyPath = join(root, "agent-ready");
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    `writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
    // Stay busy so the helper's result frame is never written.
    "await new Promise(() => setInterval(() => {}, 1_000));",
  ]);
  const controller = new AbortController();
  const running = runStarter({
    root,
    runPlan,
    agentScript,
    adapterOptions: { timeoutMs: 10_000 },
    runRequest: { signal: controller.signal },
  });
  await waitForPath(readyPath);
  controller.abort(new Error("operator interrupted"));

  const { record } = await running;

  assert.equal(record.verdict, "incomplete");
  const codes = record.integrityIssues.map(({ code }) => code);
  assert.ok(codes.includes("environment.cancelled"));
  assert.ok(codes.includes("artifact.required-uncollected"));
  assert.equal(codes.includes("evaluator.invalid"), false);
  assert.equal(record.checks.some(({ outcome }) => outcome === "fail"), false);
});

test("local execution stops background descendants after the agent exits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-descendant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'import { spawn } from "node:child_process";',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "inherit" });',
    "descendant.unref();",
  ]);
  const { record } = await runStarter({
    root,
    runPlan,
    agentScript,
    adapterOptions: { timeoutMs: 1_000 },
  });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "pass");
  assert.equal(record.execution.timedOut, false);
  assert.ok(record.execution.durationMs < 750);
});

test("local capture keeps multibyte characters split across output chunks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-split-utf8-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  // Pause mid-character so each half reaches the controller as its own chunk.
  const agentScript = writeHermeticAgentScript(root, [
    'const pause = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 100));',
    'const line = Buffer.from(`${JSON.stringify({ type: "assistant", text: "split 😀 — done" })}\\n`);',
    'const cut = line.indexOf(Buffer.from("😀")) + 2;',
    "process.stdout.write(line.subarray(0, cut));",
    "await pause();",
    "process.stdout.write(line.subarray(cut));",
    'const note = Buffer.from("stderr — 😀\\n");',
    "process.stderr.write(note.subarray(0, 9));",
    "await pause();",
    "process.stderr.write(note.subarray(9));",
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const { store, record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.verdict, "pass");
  const transcript = (await store.readEvidence(record.evidence.transcript, { maxBytes: 65_536 })).toString("utf8");
  const stderr = (await store.readEvidence(record.evidence.stderr, { maxBytes: 65_536 })).toString("utf8");
  assert.match(transcript, /split 😀 — done/);
  assert.equal(stderr, "stderr — 😀\n");
  assert.doesNotMatch(transcript + stderr, /�/);
});

test("non-JSON evaluator details produce an unknown canonical verdict", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-invalid-evaluator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root, {
    evaluatorSource: [
      "export function evaluate() {",
      "  return { checks: [{",
      '    id: "invalid-details",',
      "    required: true,",
      '    outcome: "pass",',
      '    summary: "This check must not be accepted.",',
      "    details: { score: NaN },",
      "  }], targetMetrics: {} };",
      "}",
      "",
    ].join("\n"),
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "unknown");
  assert.equal(record.checks.length, 0);
  assert.ok(record.integrityIssues.some(({ code }) => code === "evaluator.invalid"));
});

test("Deterministic Evaluators cannot read the controller environment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-evaluator-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root, {
    evaluatorSource: [
      "export function evaluate() {",
      '  if (process.env.PATH) throw new Error("controller environment is visible");',
      "  return { checks: [{",
      '    id: "isolated-environment",',
      "    required: true,",
      '    outcome: "pass",',
      '    summary: "The evaluator has no controller environment.",',
      "  }], targetMetrics: {} };",
      "}",
      "",
    ].join("\n"),
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.verdict, "pass");
  assert.equal(record.checks[0].id, "isolated-environment");
});

test("Deterministic Evaluators cannot read arbitrary host files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-evaluator-fs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hostFile = join(root, "controller-only.txt");
  writeFileSync(hostFile, "controller only\n");

  const runPlan = await initializeStarterRunPlanFixture(root, {
    evaluatorSource: [
      'import { readFileSync } from "node:fs";',
      "export function evaluate() {",
      `  readFileSync(${JSON.stringify(hostFile)}, "utf8");`,
      "  return [{",
      '    id: "host-file-readable",',
      "    required: true,",
      '    outcome: "pass",',
      '    summary: "The host file was readable.",',
      "  }];",
      "}",
      "",
    ].join("\n"),
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.verdict, "unknown");
  assert.equal(record.checks.length, 0);
  assert.ok(record.integrityIssues.some(({ code }) => code === "evaluator.invalid"));
  assert.doesNotMatch(JSON.stringify(record), /controller-only\.txt/);
});

test("invalid controller transcript preserves observed execution facts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-invalid-transcript-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'process.stdout.write("not-json\\n");',
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.execution.exitCode, 0);
  assert.equal(record.execution.timedOut, false);
  assert.equal(record.evidence.transcript, null);
  assert.ok(
    record.integrityIssues.some(({ code }) => code === "controller.transcript-invalid"),
  );
});

test("runtime errors are scrubbed before the Result Store write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-secret-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root);
  const baseAdapter = createHermeticProcessAdapter(agentScript);
  const agentAdapter = {
    ...baseAdapter,
    createLaunchPlan() {
      throw new Error("adapter exposed test-only-secret-value");
    },
  };
  const { record } = await runStarter({ root, runPlan, agentAdapter });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.doesNotMatch(JSON.stringify(record), /test-only-secret-value/);
  assert.ok(record.integrityIssues.some(({ code }) => code === "run.execution-failed"));
});

test("an operator-safe failure reason reaches the record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-operator-reason-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root);
  const baseAdapter = createHermeticProcessAdapter(agentScript);
  const agentAdapter = {
    ...baseAdapter,
    createLaunchPlan() {
      // Whoever throws asserts this text is safe to show the operator. The
      // message still carries a secret to prove only the marked field travels.
      throw Object.assign(new Error("adapter exposed test-only-secret-value"), {
        operatorReason: "Starter agent is not configured. Set STARTER_TOKEN.",
      });
    },
  };
  const { record } = await runStarter({ root, runPlan, agentAdapter });

  assert.equal(record.verdict, "incomplete");
  const issue = record.integrityIssues.find(({ code }) => code === "run.execution-failed");
  assert.ok(issue, "the run must report an execution failure");
  assert.match(issue.message, /Starter agent is not configured\. Set STARTER_TOKEN\./);
  // The unmarked message stays scrubbed even when a reason is offered.
  assert.doesNotMatch(JSON.stringify(record), /test-only-secret-value/);
});

test("Agent Adapter contract defects reject instead of becoming normal incompletes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-adapter-defect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const baseAdapter = createHermeticProcessAdapter(agentScript);
  const agentAdapter = {
    ...baseAdapter,
    redactControllerText() {
      return null;
    },
  };
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter,
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  await assert.rejects(
    engine.run({ runPlan }),
    /invalid redacted controller evidence/,
  );
  const [record] = await store.listRuns();
  assert.equal(record.state, "running");
  assert.equal(record.verdict, null);
});

test("Execution Environment contract defects reject instead of becoming normal incompletes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-environment-defect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute() {
        return {};
      },
    },
  });

  await assert.rejects(
    engine.run({ runPlan }),
    /returned no process observation/,
  );
  const [record] = await store.listRuns();
  assert.equal(record.state, "running");
  assert.equal(record.verdict, null);
});

test("malformed normalized Agent Adapter settings reject as a contract defect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-normalization-defect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root);
  const baseAdapter = createHermeticProcessAdapter(agentScript);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: {
      ...baseAdapter,
      normalizeSettings() {
        return { requestedModel: null, settings: null };
      },
    },
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  await assert.rejects(
    engine.run({ runPlan }),
    /invalid normalized settings/,
  );
  assert.deepEqual(await store.listRuns(), []);
});

test("malformed Agent Adapter launch plans reject as a contract defect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-launch-plan-defect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root);
  const baseAdapter = createHermeticProcessAdapter(agentScript);
  for (const launchPlan of [
    {},
    { command: process.execPath, args: [1] },
    {
      command: process.execPath,
      env: { AGENT_KEY: "agent-secret" },
      credentialRoutes: [{
        environmentName: "UNDECLARED_KEY",
        hosts: ["api.example.com"],
        headerNames: ["authorization"],
      }],
    },
  ]) {
    const store = await openLocalResultStore({
      root: join(root, `results-${randomUUID()}`),
    });
    const engine = createRunEngine({
      resultStore: store,
      agentAdapter: {
        ...baseAdapter,
        createLaunchPlan() {
          return launchPlan;
        },
      },
      executionEnvironment: createLocalExecutionEnvironment(),
    });

    await assert.rejects(
      engine.run({ runPlan }),
      /invalid launch plan/,
    );
    const [record] = await store.listRuns();
    assert.equal(record.state, "running");
    assert.equal(record.verdict, null);
  }
});

test("snapshot pinning rejects a referenced path changed to a symlink after resolution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-mutated-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const originalFixtures = join(runPlan.sourceRoot, "fixtures-original");
  renameSync(join(runPlan.sourceRoot, "fixtures"), originalFixtures);
  symlinkSync("fixtures-original", join(runPlan.sourceRoot, "fixtures"), "dir");

  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  const result = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.diagnostics[0].category, "preparation");
  assert.equal(result.diagnostics[0].code, "matrix.definition-preparation-failed");
  assert.match(result.diagnostics[0].message, /symlink/);
  assert.deepEqual(await store.listRuns(), []);
});

test("snapshot pinning reports a resolved input that becomes unreadable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-unreadable-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  chmodSync(runPlan.filesByPath["fixtures/message.txt"], 0o000);
  const agentScript = writeHermeticAgentScript(root);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  const result = await engine.run({ runPlan });

  assert.equal(result.status, "rejected");
  assert.equal(result.diagnostics[0].category, "preparation");
  assert.match(result.diagnostics[0].message, /no longer readable/);
  assert.deepEqual(await store.listRuns(), []);
});

test("snapshot pinning reports a resolved input beneath an unreadable directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-unreadable-parent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root);
  const fixtureDirectory = join(runPlan.sourceRoot, "fixtures");
  const agentScript = writeHermeticAgentScript(root);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
  });

  chmodSync(fixtureDirectory, 0o000);
  let result;
  try {
    result = await engine.run({ runPlan });
  } finally {
    chmodSync(fixtureDirectory, 0o700);
  }

  assert.equal(result.status, "rejected");
  assert.equal(result.diagnostics[0].category, "preparation");
  assert.match(result.diagnostics[0].message, /no longer reachable/);
  assert.deepEqual(await store.listRuns(), []);
});

test("one verified fixture source can be staged at multiple workspace paths", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-shared-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].fixtures.push({
        source: "fixtures/message.txt",
        workspacePath: "fixtures/message-copy.txt",
      });
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message-copy.txt"));',
  ]);
  const { record } = await runStarter({ root, runPlan, agentScript });

  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "pass");
  assert.equal(record.snapshot.task.fixtures.length, 2);
});

test("optional Judge runs only after deterministic completion and returns final stored truth", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-success-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rubric = "Fail when the response does not explain the copied result.";
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].evaluation.judge = { rubric };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const observedInputs = [];
  const judge = {
    id: "controlled-judge",
    model: "judge-test-model",
    timeoutMs: 1_000,
    async judge(input, { signal }) {
      observedInputs.push(input);
      assert.equal(signal.aborted, false);
      assert.equal(Object.isFrozen(input), true);
      assert.equal(input.rubric, rubric);
      assert.equal(input.run.sourceRevision, 2);
      const duringJudge = await store.getRunHistory(input.run.id);
      assert.equal(duringJudge[2].revision, 2);
      assert.equal(duringJudge[2].verdict, "pass");
      assert.equal(duringJudge[2].judgeStatus, "not_requested");
      assert.equal(duringJudge.at(-1).revision, 3);
      assert.equal(duringJudge.at(-1).judgeStatus, "pending");
      return { outcome: "fail", summary: "The response did not explain the result." };
    },
  };
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge,
  });

  const result = await engine.run({
    runPlan,
    taskId: "copy-message",
    conditionId: "default",
  });

  assert.equal(observedInputs.length, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.runs[0].revision, 4);
  assert.equal(result.runs[0].judgeStatus, "complete");
  assert.equal(result.runs[0].verdict, "fail");
  assert.deepEqual(result.summary.terminalVerdicts, {
    pass: 0,
    fail: 1,
    incomplete: 0,
    unknown: 0,
  });
  const history = await store.getRunHistory(result.runs[0].id);
  assert.deepEqual(
    history.map(({ revision, state, verdict, judgeStatus }) => ({
      revision,
      state,
      verdict,
      judgeStatus,
    })),
    [
      { revision: 0, state: "queued", verdict: null, judgeStatus: "not_requested" },
      { revision: 1, state: "running", verdict: null, judgeStatus: "not_requested" },
      { revision: 2, state: "complete", verdict: "pass", judgeStatus: "not_requested" },
      { revision: 3, state: "complete", verdict: "pass", judgeStatus: "pending" },
      { revision: 4, state: "complete", verdict: "fail", judgeStatus: "complete" },
    ],
  );
  assert.equal(history[4].judge.kind, "result");
  assert.equal(history[4].judge.outcome, "fail");
  assert.equal(history[4].judge.basis.sourceRevision, 2);
  assert.equal(history[4].judge.basis.snapshotFingerprint, history[2].snapshotFingerprint);
});

test("required judging rejects before allocation while disabled judging stays deterministic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  let allocations = 0;
  const environment = {
    ...local,
    async execute(input) {
      allocations += 1;
      return local.execute(input);
    },
  };
  const withoutJudge = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: environment,
  });

  const rejected = await withoutJudge.run({ runPlan, judging: "required" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.summary.attempts, 0);
  assert.equal(rejected.diagnostics[0].code, "authority.judge-capability-missing");
  assert.equal(allocations, 0);
  assert.deepEqual(await store.listRuns(), []);

  let judgeCalls = 0;
  const disabled = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: environment,
    judge: {
      id: "controlled-judge",
      model: null,
      timeoutMs: 1_000,
      async judge() {
        judgeCalls += 1;
        return { outcome: "fail", summary: "Should not run." };
      },
    },
  });
  const completed = await disabled.run({ runPlan, judging: "disabled" });
  assert.equal(completed.runs[0].revision, 2);
  assert.equal(completed.runs[0].judgeStatus, "not_requested");
  assert.equal(completed.runs[0].verdict, "pass");
  assert.equal(judgeCalls, 0);
  assert.equal(allocations, 1);
});

test("RunPlan v1 rejects Authority Profile selection before allocation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-authority-v1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root);
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  let allocations = 0;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute(input) {
        allocations += 1;
        return local.execute(input);
      },
    },
  });

  const result = await engine.run({
    runPlan,
    authorityProfileId: "deterministic-primary-v1",
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.summary.attempts, 0);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    "authority.profile-selection-unsupported",
  ]);
  assert.equal(allocations, 0);
  assert.deepEqual(await store.listRuns(), []);
});

test("RunPlan v2 default and explicit Authority Profile selection write the same Snapshot v2", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-authority-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.schemaVersion = 2;
      definition.authorityProfiles = [{
        schemaVersion: 1,
        id: "deterministic-primary-v1",
        kind: "deterministic-primary",
        checkPolicy: { defaultRule: "authored" },
        judge: { availability: "disabled" },
      }];
      definition.tasks["copy-message"].evaluation.authority = {
        defaultProfileId: "deterministic-primary-v1",
        bindings: [{
          profileId: "deterministic-primary-v1",
          checkRules: [{ checkId: "exact-copy", rule: "required" }],
        }],
      };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);

  const implicit = await runStarter({ root, runPlan, agentScript });
  const explicit = await runStarter({
    root,
    runPlan,
    agentScript,
    runRequest: { authorityProfileId: "deterministic-primary-v1" },
  });

  assert.equal(implicit.result.status, "complete");
  assert.equal(explicit.result.status, "complete");
  assert.equal(implicit.record.schemaVersion, 3);
  assert.equal(implicit.record.snapshot.schemaVersion, 2);
  assert.equal(implicit.record.snapshotFingerprint, explicit.record.snapshotFingerprint);
  assert.deepEqual(implicit.record.snapshot, explicit.record.snapshot);
  assert.equal(implicit.record.snapshot.evaluation.authority.id, "deterministic-primary-v1");
  assert.equal(implicit.record.headline.verdict, "pass");
  assert.equal(implicit.record.verdict, implicit.record.headline.verdict);
  assert.deepEqual(implicit.record.verdictReasons, implicit.record.headline.verdictReasons);
});

test("RunPlan v2 builds the selected bounded Judge Input v2 and stores separate truth lanes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-authority-judge-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.schemaVersion = 2;
      definition.authorityProfiles = [{
        schemaVersion: 1,
        id: "hybrid-v1",
        kind: "hybrid",
        checkPolicy: { defaultRule: "authored" },
        judge: {
          availability: "required",
          capability: {
            judgeId: "controlled-judge-v2",
            model: "judge-test-model-v2",
            inputSchemaVersion: 2,
          },
          timeoutMs: 1_000,
          projection: {
            schemaVersion: 1,
            include: {
              transcript: true,
              stderr: false,
              textArtifacts: true,
              egress: false,
              lifecycleReceipts: false,
              runTrustIssues: true,
              baselineDeterministicOutcome: true,
              effectiveDeterministicOutcome: true,
              requiredChecks: true,
              advisoryChecks: false,
            },
            limits: {
              maxEvidenceItems: 8,
              maxEvidenceItemBytes: 4_096,
              maxEvidenceTextBytes: 16_384,
              maxChecks: 8,
              maxRunTrustIssues: 8,
              maxInputBytes: 65_536,
            },
          },
          output: { maxSummaryBytes: 1_024 },
        },
      }];
      definition.tasks["copy-message"].evaluation.authority = {
        defaultProfileId: "hybrid-v1",
        bindings: [{
          profileId: "hybrid-v1",
          rubric: "Fail when the copied answer is not sufficiently explained.",
          checkRules: [{ checkId: "exact-copy", rule: "required" }],
        }],
      };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const observedInputs = [];
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge-v2",
      model: "judge-test-model-v2",
      inputSchemaVersions: [2],
      maxTimeoutMs: 2_000,
      maxInputBytes: 65_536,
      maxOutputBytes: 1_024,
      async judge(input) {
        observedInputs.push(input);
        return { outcome: "fail", summary: "The answer copied text but did not explain it." };
      },
    },
  });

  const result = await engine.run({ runPlan });

  assert.equal(result.status, "complete");
  assert.equal(observedInputs.length, 1);
  const [input] = observedInputs;
  assert.equal(input.schemaVersion, 2);
  assert.deepEqual(input.authority, { profileId: "hybrid-v1", kind: "hybrid" });
  assert.equal(input.deterministic.baseline.verdict, "pass");
  assert.equal(input.deterministic.effective.verdict, "pass");
  assert.equal(input.runTrust.status, "trusted");
  assert.deepEqual(input.deterministic.checks.map(({ id }) => id), ["exact-copy"]);
  assert.deepEqual(
    input.evidence.map(({ kind }) => kind),
    ["transcript", "artifact"],
  );
  assert.deepEqual(input.omissions.stderr, {
    omittedCount: 1,
    reasons: ["profile-excluded"],
  });

  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.deterministic.baseline.verdict, "pass");
  assert.equal(record.deterministic.effective.verdict, "pass");
  assert.equal(record.judge.outcome, "fail");
  assert.equal(record.headline.verdict, "fail");
  assert.equal(record.headline.decidedBy, "judge");
});

test("RunPlan v2 Judge-primary keeps absent deterministic lanes absent before and after judging", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-authority-judge-primary-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      configureJudgeAuthorityV2(definition, {
        id: "judge-primary-v1",
        kind: "judge-primary",
        evaluator: false,
      });
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const judge = {
    id: "controlled-judge-v2",
    model: "judge-test-model-v2",
    inputSchemaVersions: [2],
    maxTimeoutMs: 2_000,
    maxInputBytes: 65_536,
    maxOutputBytes: 1_024,
    async judge() {
      return { outcome: "pass", summary: "The response satisfies the rubric." };
    },
  };

  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge,
  });
  const result = await engine.run({ runPlan });
  const history = await store.getRunHistory(result.runs[0].id);

  assert.equal(history[2].deterministic.evaluatorStatus, "not_configured");
  assert.equal(history[2].deterministic.baseline, null);
  assert.equal(history[2].deterministic.effective, null);
  assert.equal(history[2].headline.verdict, "unknown");
  assert.equal(history[4].deterministic.evaluatorStatus, "not_configured");
  assert.equal(history[4].deterministic.baseline, null);
  assert.equal(history[4].deterministic.effective, null);
  assert.equal(history[4].headline.verdict, "pass");
  assert.equal(history[4].headline.decidedBy, "judge");

  const failedStore = await openLocalResultStore({ root: join(root, "failed-results") });
  const local = createLocalExecutionEnvironment();
  const failedEngine = createRunEngine({
    resultStore: failedStore,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute() {
        return {
          process: null,
          integrityIssues: [{
            code: "environment.dispose-failed",
            phase: "dispose",
            effect: "incomplete",
            message: "The environment could not prove disposal.",
          }],
          artifacts: [],
          egressCollections: [{
            status: "unavailable",
            reason: "not-configured",
            requests: [],
            provenance: {
              producer: "controlled-environment",
              authority: "environment",
              lifecyclePhase: "execution",
              capturedAt: "2026-08-22T10:00:00.000Z",
              trust: "environment-observed",
            },
          }],
        };
      },
    },
    judge,
  });
  const failedResult = await failedEngine.run({ runPlan });
  const failedRecord = await failedStore.getRun(failedResult.runs[0].id);
  assert.equal(failedRecord.deterministic.evaluatorStatus, "not_configured");
  assert.equal(failedRecord.deterministic.baseline, null);
  assert.equal(failedRecord.deterministic.effective, null);
  assert.equal(failedRecord.headline.verdict, "incomplete");
  assert.equal(failedRecord.headline.decidedBy, "mandatory-run-trust");
});

test("RunPlan v2 hybrid preserves deterministic truth when the required Judge fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-authority-hybrid-failed-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      configureJudgeAuthorityV2(definition, {
        id: "hybrid-v1",
        kind: "hybrid",
      });
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge-v2",
      model: "judge-test-model-v2",
      inputSchemaVersions: [2],
      maxTimeoutMs: 2_000,
      maxInputBytes: 65_536,
      maxOutputBytes: 1_024,
      async judge() {
        throw new Error("provider-secret-must-not-be-stored");
      },
    },
  });

  const result = await engine.run({ runPlan });
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.judgeStatus, "failed");
  assert.equal(record.judge.code, "judge.provider-failed");
  assert.equal(record.deterministic.effective.verdict, "pass");
  assert.equal(record.headline.verdict, "pass");
  assert.equal(record.headline.decidedBy, "effective-deterministic");
  assert.doesNotMatch(JSON.stringify(record), /provider-secret-must-not-be-stored/);
});

test("required judging rejects a mixed matrix before any cell is allocated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-required-matrix-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
      definition.tasks["without-rubric"] = structuredClone(definition.tasks["copy-message"]);
      delete definition.tasks["without-rubric"].evaluation.judge;
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const local = createLocalExecutionEnvironment();
  let allocations = 0;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute(input) {
        allocations += 1;
        return local.execute(input);
      },
    },
    judge: {
      id: "controlled-judge",
      model: null,
      timeoutMs: 1_000,
      async judge() {
        return { outcome: "pass", summary: "The rubric passed." };
      },
    },
  });

  const result = await engine.run({ runPlan, judging: "required" });
  assert.equal(result.status, "rejected");
  assert.equal(result.summary.attempts, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].taskId, "without-rubric");
  assert.equal(result.diagnostics[0].code, "authority.legacy-rubric-missing");
  assert.equal(allocations, 0);
  assert.deepEqual(await store.listRuns(), []);
});

test("Judge failure and ignored timeout preserve deterministic completion", async (t) => {
  for (const scenario of ["throw", "timeout"]) {
    const root = mkdtempSync(join(tmpdir(), `tae-starter-judge-${scenario}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runPlan = await initializeStarterRunPlanFixture(root, {
      mutateDefinition(definition) {
        definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
      },
    });
    const agentScript = writeHermeticAgentScript(root, [
      'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    ]);
    const store = await openLocalResultStore({ root: join(root, "results") });
    const engine = createRunEngine({
      resultStore: store,
      agentAdapter: createHermeticProcessAdapter(agentScript),
      executionEnvironment: createLocalExecutionEnvironment(),
      judge: {
        id: "controlled-judge",
        model: null,
        timeoutMs: scenario === "timeout" ? 10 : 1_000,
        async judge() {
          if (scenario === "timeout") return new Promise(() => {});
          throw new Error("provider-secret-must-not-be-stored");
        },
      },
    });

    const result = await engine.run({ runPlan });
    const record = await store.getRun(result.runs[0].id);
    const deterministic = (await store.getRunHistory(record.id))[2];
    assert.equal(result.runs[0].revision, 4);
    assert.equal(result.runs[0].judgeStatus, "failed");
    assert.equal(record.verdict, "pass");
    assert.deepEqual(record.verdictReasons, deterministic.verdictReasons);
    assert.equal(record.judge.kind, "error");
    assert.equal(
      record.judge.code,
      scenario === "timeout" ? "judge.timed-out" : "judge.provider-failed",
    );
    assert.doesNotMatch(JSON.stringify(record), /provider-secret-must-not-be-stored/);
  }
});

test("a clean Judge-only Task may establish a canonical verdict", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      delete definition.tasks["copy-message"].evaluation.deterministicEvaluator;
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge",
      model: null,
      timeoutMs: 1_000,
      async judge() {
        return { outcome: "pass", summary: "The response satisfies the rubric." };
      },
    },
  });

  const result = await engine.run({ runPlan });
  const history = await store.getRunHistory(result.runs[0].id);
  assert.equal(history[2].verdict, "unknown");
  assert.equal(history[4].verdict, "pass");
  assert.equal(history[4].verdictReasons[0].code, "judge.rubric-pass");
});

test("only the final execution attempt is judged after fixed retries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
    },
  });
  const attemptCounter = join(root, "judge-attempt-count.txt");
  writeFileSync(attemptCounter, "0");
  const agentScript = writeHermeticAgentScript(root, [
    `const attemptPath = ${JSON.stringify(attemptCounter)};`,
    'const attempt = Number(readFileSync(attemptPath, "utf8"));',
    'writeFileSync(attemptPath, String(attempt + 1));',
    'if (attempt === 0) { process.exitCode = 7; }',
    'else { writeFileSync("answer.txt", readFileSync("fixtures/message.txt")); }',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  let judgeCalls = 0;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge",
      model: null,
      timeoutMs: 1_000,
      async judge() {
        judgeCalls += 1;
        return { outcome: "fail", summary: "The final attempt missed the rubric." };
      },
    },
  });

  const result = await engine.run({ runPlan, retries: 1 });
  assert.equal(result.runs.length, 2);
  assert.equal(result.summary.retriesPerformed, 1);
  assert.equal(judgeCalls, 1);
  assert.equal(result.runs[0].revision, 2);
  assert.equal(result.runs[0].judgeStatus, "not_requested");
  assert.equal(result.runs[0].verdict, "incomplete");
  assert.equal(result.runs[1].revision, 4);
  assert.equal(result.runs[1].judgeStatus, "complete");
  assert.equal(result.runs[1].verdict, "fail");
  assert.deepEqual(result.summary.terminalVerdicts, {
    pass: 0,
    fail: 1,
    incomplete: 0,
    unknown: 0,
  });
});

test("Judge pass cannot relax no-process or expected execution failures", async (t) => {
  for (const scenario of ["no-process", "expected-error"]) {
    const root = mkdtempSync(join(tmpdir(), `tae-starter-judge-protected-${scenario}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runPlan = await initializeStarterRunPlanFixture(root, {
      mutateDefinition(definition) {
        definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
      },
    });
    const agentScript = writeHermeticAgentScript(root);
    const baseAdapter = createHermeticProcessAdapter(agentScript);
    const store = await openLocalResultStore({ root: join(root, "results") });
    const local = createLocalExecutionEnvironment();
    const engine = createRunEngine({
      resultStore: store,
      agentAdapter: scenario === "expected-error"
        ? {
            ...baseAdapter,
            createLaunchPlan() {
              throw new Error("controlled launch failure");
            },
          }
        : baseAdapter,
      executionEnvironment: scenario === "no-process"
        ? {
            ...local,
            async execute() {
              return {
                process: null,
                integrityIssues: [{
                  code: "environment.dispose-failed",
                  phase: "dispose",
                  effect: "incomplete",
                  message: "The environment could not prove disposal.",
                }],
                artifacts: [],
                egressCollections: [{
                  status: "unavailable",
                  reason: "not-configured",
                  requests: [],
                  provenance: {
                    producer: "controlled-environment",
                    authority: "environment",
                    lifecyclePhase: "execution",
                    capturedAt: "2026-08-22T10:00:00.000Z",
                    trust: "environment-observed",
                  },
                }],
              };
            },
          }
        : local,
      judge: {
        id: "controlled-judge",
        model: null,
        timeoutMs: 1_000,
        async judge() {
          return { outcome: "pass", summary: "The rubric passed." };
        },
      },
    });

    const result = await engine.run({ runPlan });
    const record = await store.getRun(result.runs[0].id);
    assert.equal(record.revision, 4);
    assert.equal(record.judgeStatus, "complete");
    assert.equal(record.judge.outcome, "pass");
    assert.equal(record.verdict, "incomplete");
    assert.ok(record.integrityIssues.length > 0);
  }
});

test("Judge input is bounded and redacted before a redacted result is stored", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-redaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "judge-target-secret-value";
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.credentialRequirements.TARGET_SECRET = {
        minimumScopes: ["project"],
        delivery: { kind: "environment" },
      };
      definition.tasks["copy-message"].credentialRequirements = ["TARGET_SECRET"];
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
      definition.tasks["copy-message"].outputArtifacts.push({
        path: "blob.bin",
        kind: "binary",
        maxBytes: 1024,
        required: false,
      });
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'process.stdout.write(`${JSON.stringify({ type: "assistant", text: `${process.env.TARGET_SECRET}${"😀".repeat(30000)}` })}\\n`);',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'writeFileSync("blob.bin", Buffer.from([0, 1, 2, 3]));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  let observedInput = null;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge",
      model: null,
      timeoutMs: 1_000,
      async judge(input) {
        observedInput = input;
        return { outcome: "pass", summary: `Accepted with ${secret}.` };
      },
    },
  });

  const result = await engine.run({
    runPlan,
    credentials: { TARGET_SECRET: secret },
  });
  const record = await store.getRun(result.runs[0].id);
  assert.doesNotMatch(JSON.stringify(observedInput), new RegExp(secret));
  assert.equal(
    observedInput.evidence.find(({ kind }) => kind === "transcript").content.truncated,
    true,
  );
  assert.doesNotMatch(
    observedInput.evidence.find(({ kind }) => kind === "transcript").content.content,
    /�/,
  );
  assert.equal(
    observedInput.evidence.find(({ name }) => name === "blob.bin").omission,
    "binary",
  );
  assert.equal(record.judge.summary, "Accepted with <REDACTED>.");
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
});

test("target credential prefixes are redacted before persistence and Judge delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-prefix-redaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "7b19d03af6482ce1950b6743aedef972";
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.credentialRequirements.TARGET_SECRET = {
        minimumScopes: ["project"], delivery: { kind: "environment" },
      };
      definition.tasks["copy-message"].credentialRequirements = ["TARGET_SECRET"];
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
      definition.tasks["copy-message"].outputArtifacts.push(
        { path: "prefix.txt", kind: "text", maxBytes: 1024, required: false },
        { path: "prefix.bin", kind: "binary", maxBytes: 1024, required: false },
      );
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'const output = `${process.env.TARGET_SECRET.slice(0, 10)}... ${process.env.TARGET_SECRET.slice(0, 20)}...`;',
    'process.stdout.write(`${JSON.stringify({ type: "assistant", text: output })}\\n`);',
    'process.stderr.write(output);',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    'writeFileSync("prefix.txt", output);',
    'writeFileSync("prefix.bin", Buffer.concat([Buffer.from([255, 0]), Buffer.from(output), Buffer.from([254])]));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  let observedInput;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge", model: null, timeoutMs: 1_000,
      async judge(input) {
        observedInput = input;
        return { outcome: "pass", summary: `Checked ${secret.slice(0, 20)}...` };
      },
    },
  });
  const result = await engine.run({ runPlan, credentials: { TARGET_SECRET: secret } });
  const record = await store.getRun(result.runs[0].id);
  assert.ok(observedInput);
  assert.equal(JSON.stringify(observedInput).includes(secret.slice(0, 8)), false);
  assert.equal(JSON.stringify(record).includes(secret.slice(0, 8)), false);
  assert.equal(record.judge.summary, "Checked <REDACTED>...");
  assert.equal(record.verdict, "pass");
  for (const reference of [record.evidence.transcript, record.evidence.stderr, ...record.evidence.artifacts.map(({ content }) => content)]) {
    const bytes = await store.readEvidence(reference, { maxBytes: 64 * 1024 });
    assert.equal(bytes.includes(Buffer.from(secret.slice(0, 8))), false);
  }
  const binary = record.evidence.artifacts.find(({ path }) => path === "prefix.bin");
  assert.deepEqual(await store.readEvidence(binary.content, { maxBytes: 1024 }), Buffer.concat([
    Buffer.from([255, 0]), Buffer.from("<REDACTED>... <REDACTED>..."), Buffer.from([254]),
  ]));
});

test("an exact Judge protocol refuses a redacted transcript without persisting raw bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-exact-judge-redaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "exact-judge-transcript-secret";
  const protocol = {
    schemaVersion: 1,
    id: "exact-transcript-v1",
    fingerprint: `sha256:${"1".repeat(64)}`,
    requirements: ["controller-transcript"],
    maxRequestBytes: 65_536,
  };
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.credentialRequirements.TARGET_SECRET = {
        minimumScopes: ["project"],
        delivery: { kind: "environment" },
      };
      const task = definition.tasks["copy-message"];
      task.credentialRequirements = ["TARGET_SECRET"];
      configureJudgeAuthorityV2(definition, {
        id: "exact-judge-primary-v1",
        kind: "judge-primary",
        evaluator: false,
      });
      definition.authorityProfiles[0].judge.capability.requestProtocol = protocol;
    },
  });
  const agentScript = writeHermeticAgentScript(root, [
    'process.stdout.write(`${JSON.stringify({ type: "assistant", text: process.env.TARGET_SECRET })}\\n`);',
    'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
  ]);
  const store = await openLocalResultStore({ root: join(root, "results") });
  let judgeCalls = 0;
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: createLocalExecutionEnvironment(),
    judge: {
      id: "controlled-judge-v2",
      model: "judge-test-model-v2",
      inputSchemaVersions: [2],
      maxTimeoutMs: 1_000,
      maxInputBytes: 65_536,
      maxOutputBytes: 1_024,
      requestProtocols: [{
        ...protocol,
        project({ sources }) {
          return {
            schemaVersion: 1,
            protocolId: protocol.id,
            protocolFingerprint: protocol.fingerprint,
            systemPrompt: "Score the exact transcript.",
            userPrompt: sources.transcript,
          };
        },
      }],
      async judge() {
        judgeCalls += 1;
        return { outcome: "pass", summary: "must not run" };
      },
    },
  });

  const result = await engine.run({
    runPlan,
    credentials: { TARGET_SECRET: secret },
  });
  const record = await store.getRun(result.runs[0].id);

  assert.equal(judgeCalls, 0);
  assert.equal(record.judgeStatus, "failed");
  assert.equal(record.judge.code, "judge.input-unavailable");
  assert.equal(record.verdict, "incomplete");
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  const storedTranscript = await store.readEvidence(
    record.evidence.transcript,
    { maxBytes: 65_536 },
  );
  assert.match(storedTranscript.toString("utf8"), /<REDACTED>/);
  assert.doesNotMatch(storedTranscript.toString("utf8"), new RegExp(secret));
});

test("invalid output, caller cancellation, and late rejection settle as Judge failures", async (t) => {
  for (const scenario of ["invalid", "cancelled", "late-rejection"]) {
    const root = mkdtempSync(join(tmpdir(), `tae-starter-judge-${scenario}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runPlan = await initializeStarterRunPlanFixture(root, {
      mutateDefinition(definition) {
        definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
      },
    });
    const agentScript = writeHermeticAgentScript(root, [
      'writeFileSync("answer.txt", readFileSync("fixtures/message.txt"));',
    ]);
    const store = await openLocalResultStore({ root: join(root, "results") });
    const controller = new AbortController();
    const engine = createRunEngine({
      resultStore: store,
      agentAdapter: createHermeticProcessAdapter(agentScript),
      executionEnvironment: createLocalExecutionEnvironment(),
      judge: {
        id: "controlled-judge",
        model: null,
        timeoutMs: scenario === "late-rejection" ? 10 : 1_000,
        async judge() {
          if (scenario === "invalid") return { outcome: "maybe", summary: "Invalid." };
          if (scenario === "cancelled") {
            controller.abort(new Error("controlled cancellation"));
            return new Promise(() => {});
          }
          return new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error("late provider secret")), 40);
          });
        },
      },
    });

    const result = await engine.run({ runPlan, signal: controller.signal });
    const record = await store.getRun(result.runs[0].id);
    assert.equal(record.judgeStatus, "failed");
    assert.equal(record.verdict, "pass");
    assert.equal(
      record.judge.code,
      scenario === "invalid"
        ? "judge.invalid-output"
        : scenario === "cancelled"
          ? "judge.cancelled"
          : "judge.timed-out",
    );
    assert.doesNotMatch(JSON.stringify(record), /provider secret|controlled cancellation/);
  }
});

test("an oversized Judge input settles as unavailable without calling the provider", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-starter-judge-input-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runPlan = await initializeStarterRunPlanFixture(root, {
    mutateDefinition(definition) {
      definition.tasks["copy-message"].evaluation.judge = { rubric: "Apply the rubric." };
    },
  });
  const agentScript = writeHermeticAgentScript(root);
  const store = await openLocalResultStore({ root: join(root, "results") });
  let judgeCalls = 0;
  const local = createLocalExecutionEnvironment();
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createHermeticProcessAdapter(agentScript),
    executionEnvironment: {
      ...local,
      async execute() {
        return {
          process: null,
          integrityIssues: Array.from({ length: 64 }, (_, index) => ({
            code: `controlled.oversized-${index}`,
            phase: "execute",
            effect: "incomplete",
            message: "x".repeat(64 * 1024),
          })),
          artifacts: [],
          egressCollections: [{
            status: "unavailable",
            reason: "not-configured",
            requests: [],
            provenance: {
              producer: "controlled-environment",
              authority: "environment",
              lifecyclePhase: "execution",
              capturedAt: "2026-08-22T10:00:00.000Z",
              trust: "environment-observed",
            },
          }],
        };
      },
    },
    judge: {
      id: "controlled-judge",
      model: null,
      timeoutMs: 1_000,
      async judge() {
        judgeCalls += 1;
        return { outcome: "pass", summary: "The rubric passed." };
      },
    },
  });

  const result = await engine.run({ runPlan });
  const record = await store.getRun(result.runs[0].id);
  assert.equal(judgeCalls, 0);
  assert.equal(record.revision, 4);
  assert.equal(record.judgeStatus, "failed");
  assert.equal(record.judge.code, "judge.input-unavailable");
  assert.equal(record.verdict, "incomplete");
});
