import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import {
  closePostgresResultStore,
  openPostgresResultStore,
} from "../lib/postgres-result-store.mjs";
import { applyPostgresResultStoreMigrations } from "../lib/postgres-result-store-migrations.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import {
  createPostgresTestDatabase,
  postgresTestAdminConnectionString,
} from "./helpers/postgres-test-database.mjs";

const observedAt = "2026-08-28T12:00:00.000Z";
const targetCredential = "TEST-PLACEHOLDER-TOGETHER-CREDENTIAL";
const adminConnectionString = postgresTestAdminConnectionString;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeTogetherTracer(root) {
  const taskRoot = join(root, "tasks", "together-chat-smoke");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "prompt.md"), [
    "Send one chat completion request to Together AI.",
    "Write `outputs/chat.json` as JSON with the selected model and nonempty reply.",
    "Do not create or mutate any Together resource.",
    "",
  ].join("\n"));
  writeFileSync(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "tae";',
    "",
    "export default defineChecks((run) => {",
    "  run.expect.request({",
    '    id: "chat-request",',
    '    method: "POST",',
    '    path: "/v1/chat/completions",',
    "    status: 200,",
    "  });",
    "  run.expect.artifact({",
    '    id: "chat-output",',
    '    path: "outputs/chat.json",',
    '    format: "json",',
    "    maxBytes: 4096,",
    "  });",
    '  const output = run.artifacts.json("outputs/chat.json");',
    "  run.check({",
    '    id: "chat-output-shape",',
    "    passed: output === null ? null : (",
    '      typeof output.model === "string"',
    '      && typeof output.reply === "string"',
    "      && output.reply.length > 0",
    "    ),",
    '    summary: "The output records the selected model and a nonempty reply.",',
    '    evidence: [run.evidence.artifact("outputs/chat.json")],',
    "  });",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "together.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    "  api: {",
    '    authorizationCredential: "TOGETHER_API_KEY",',
    '    hosts: ["api.together.ai", "api.together.xyz"],',
    "  },",
    '  tasks: ["./tasks/together-chat-smoke"],',
    "  agents: [",
    '    { runner: "claude-code", model: "test-model" },',
    '    { runner: "codex", model: "test-model" },',
    "  ],",
    "  conditions: { default: { skills: [], mcpServers: [] } },",
    "  repeats: 1,",
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));
}

function captured(requests) {
  return [{
    status: "captured",
    requests,
    provenance: {
      producer: "controlled-sandbox",
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: observedAt,
      trust: "environment-observed",
    },
  }];
}

function evaluatorInput({ mode = "captured", artifact = "valid" } = {}) {
  const artifactBytes = artifact === "valid"
    ? Buffer.from('{"model":"test-model","reply":"hello"}\n')
    : Buffer.from("not json\n");
  return {
    snapshot: {
      target: {
        egress: { relevantHosts: ["api.together.ai", "api.together.xyz"] },
      },
    },
    transcript: { jsonl: "", evidenceRef: "sha256:transcript" },
    egress: mode === "unavailable"
      ? [{
          status: "unavailable",
          reason: "capture-failed",
          requests: [],
          provenance: {
            producer: "controlled-sandbox",
            authority: "environment",
            lifecyclePhase: "execution",
            capturedAt: observedAt,
            trust: "environment-observed",
          },
        }]
      : captured(mode === "empty" ? [] : [{
          kind: "http-request",
          sequence: 0,
          observedAt,
          method: "POST",
          scheme: "https",
          host: "api.together.ai",
          path: "/v1/chat/completions",
          statusCode: 200,
          durationMs: 1,
          selectedFields: {},
          evidenceRef: "sha256:request",
        }]),
    readArtifactText(path) {
      assert.equal(path, "outputs/chat.json");
      if (mode === "unavailable") return { status: "missing" };
      return {
        status: "present",
        text: artifactBytes.toString("utf8"),
        evidenceRef: "sha256:artifact",
      };
    },
  };
}

test("v1 request and artifact expectations preserve pass, fail, and unavailable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTogetherTracer(root);

  const resolved = await resolveV1Suite({
    suitePath: join(root, "together.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const task = resolved.value.definition.tasks["together-chat-smoke"];
  assert.deepEqual(task.credentialRequirements, ["TOGETHER_API_KEY"]);
  assert.deepEqual(task.executionRequirements, [
    "environment.isolated-workspace",
    "environment.trusted-egress-capture",
  ]);
  assert.deepEqual(task.outputArtifacts, [{
    path: "outputs/chat.json",
    kind: "text",
    maxBytes: 4096,
    required: true,
  }]);

  const evaluator = await import(pathToFileURL(join(
    resolved.generatedRoot,
    "evaluators",
    "together-chat-smoke.mjs",
  )).href);
  assert.deepEqual(
    evaluator.evaluate(evaluatorInput()).checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "pass" },
      { id: "chat-output", outcome: "pass" },
      { id: "chat-output-shape", outcome: "pass" },
    ],
  );
  assert.deepEqual(
    evaluator.evaluate(evaluatorInput({ mode: "empty" })).checks
      .map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "fail" },
      { id: "chat-output", outcome: "pass" },
      { id: "chat-output-shape", outcome: "pass" },
    ],
  );
  assert.deepEqual(
    evaluator.evaluate(evaluatorInput({ mode: "unavailable" })).checks
      .map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "skip" },
      { id: "chat-output", outcome: "skip" },
      { id: "chat-output-shape", outcome: "skip" },
    ],
  );
  assert.equal(
    evaluator.evaluate(evaluatorInput({ artifact: "invalid" })).checks[1].outcome,
    "fail",
  );
});

function controlledEnvironment(observedEnvelopes) {
  return {
    id: "controlled-sandbox",
    capabilities: [
      "environment.isolated-workspace",
      "environment.trusted-egress-capture",
    ],
    captureCapabilities: { protocols: ["https"], selectedFields: true },
    normalizeSettings(settings = {}) { return settings; },
    async execute(envelope) {
      observedEnvelopes.push(envelope);
      const artifactBytes = Buffer.from('{"model":"test-model","reply":"hello"}\n');
      const claude = envelope.launchPlan.command === "controlled-claude";
      const stdout = claude
        ? `${JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "controlled-claude-session",
            model: "test-model",
            result: `hello ${targetCredential}`,
          })}\n`
        : `${JSON.stringify({ type: "thread.started", thread_id: "controlled-codex-thread" })}\n`
          + `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`;
      return {
        process: {
          stdout: { text: stdout, complete: true },
          stderr: { text: "", complete: true },
          exitCode: 0,
          signal: null,
          timedOut: false,
          captureOverflow: false,
          spawnError: null,
          quiescent: true,
          startedAt: observedAt,
          endedAt: observedAt,
          durationMs: 1,
        },
        artifacts: [{
          ...envelope.outputArtifacts[0],
          status: "captured",
          bytes: artifactBytes,
          sizeBytes: artifactBytes.byteLength,
          sha256: sha256(artifactBytes),
          capturedAt: observedAt,
        }],
        integrityIssues: [],
        egressCollections: captured([{
          kind: "http-request",
          sequence: 0,
          observedAt,
          method: "POST",
          scheme: "https",
          host: "api.together.ai",
          path: "/v1/chat/completions",
          statusCode: 200,
          durationMs: 1,
          selectedFields: {},
        }]),
      };
    },
  };
}

test("the real Together tracer admits both first-party Adapters only with a trusted sandbox", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-evidence-engine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTogetherTracer(root);
  const resolved = await resolveV1Suite({
    suitePath: join(root, "together.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));

  const rejectedStore = await openLocalResultStore({ root: join(root, "rejected") });
  let localAllocations = 0;
  const rejected = await createRunEngine({
    resultStore: rejectedStore,
    agentAdapters: [createClaudeCodeAdapter({
      runtimeEnv: { ANTHROPIC_API_KEY: "TEST-PLACEHOLDER-CLAUDE-CREDENTIAL" },
      command: "controlled-claude",
    })],
    executionEnvironment: {
      id: "local",
      capabilities: [],
      normalizeSettings(settings = {}) { return settings; },
      async execute() { localAllocations += 1; throw new Error("not reached"); },
    },
  }).run({
    runPlan: resolved.value,
    taskIds: ["together-chat-smoke"],
    conditionIds: ["default"],
    agentSelections: [{ adapterId: "claude-code", requestedModel: "test-model", settings: {} }],
    credentials: { TOGETHER_API_KEY: targetCredential },
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(localAllocations, 0);
  assert.deepEqual(await rejectedStore.listRuns(), []);

  const store = await openLocalResultStore({ root: join(root, "accepted") });
  const observedEnvelopes = [];
  const engine = createRunEngine({
    resultStore: store,
    agentAdapters: [
      createClaudeCodeAdapter({
        runtimeEnv: { ANTHROPIC_API_KEY: "TEST-PLACEHOLDER-CLAUDE-CREDENTIAL" },
        command: "controlled-claude",
      }),
      createCodexAdapter({
        runtimeEnv: { CODEX_API_KEY: "TEST-PLACEHOLDER-CODEX-CREDENTIAL" },
        command: "controlled-codex",
      }),
    ],
    executionEnvironment: controlledEnvironment(observedEnvelopes),
  });
  const result = await engine.run({
    runPlan: resolved.value,
    taskIds: ["together-chat-smoke"],
    conditionIds: ["default"],
    agentSelections: resolved.defaults.agentSelections,
    credentials: { TOGETHER_API_KEY: targetCredential },
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(result.runs.map(({ verdict }) => verdict), ["pass", "pass"]);
  assert.equal(observedEnvelopes.length, 2);
  assert.ok(observedEnvelopes.every((envelope) => (
    JSON.stringify(envelope).includes(targetCredential) === false
  )));
  const records = await store.listRuns();
  assert.equal(records.length, 2);
  assert.ok(records.every(({ snapshot, checks }) => (
    snapshot.task.prompt.startsWith("Send one chat completion request")
    && checks.every(({ outcome }) => outcome === "pass")
  )));
  for (const record of records) {
    const transcript = await store.readEvidence(
      record.evidence.transcript,
      { maxBytes: 1_048_576 },
    );
    assert.equal(transcript.includes(targetCredential), false);
    const egress = (await store.readEvidence(
      record.evidence.egress[0].content,
      { maxBytes: 1_048_576 },
    )).toString("utf8");
    assert.equal(egress.includes(targetCredential), false);
    assert.doesNotMatch(egress, /requestBody|responseBody|headers/);
  }
});

test("v1 trusted evidence has equivalent Local and Postgres records", {
  skip: !adminConnectionString,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-evidence-postgres-"));
  const database = await createPostgresTestDatabase();
  let postgresStore;
  t.after(async () => {
    await closePostgresResultStore(postgresStore);
    await database.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  writeTogetherTracer(root);
  const resolved = await resolveV1Suite({
    suitePath: join(root, "together.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  await applyPostgresResultStoreMigrations({ connectionString: database.connectionString });
  const stores = {
    local: await openLocalResultStore({ root: join(root, "local") }),
    postgres: await openPostgresResultStore({
      connectionString: database.connectionString,
      localArtifactRoot: join(root, "postgres-artifacts"),
    }),
  };
  postgresStore = stores.postgres;
  const observed = {};

  for (const [kind, resultStore] of Object.entries(stores)) {
    const result = await createRunEngine({
      resultStore,
      agentAdapter: createClaudeCodeAdapter({
        runtimeEnv: { ANTHROPIC_API_KEY: "TEST-PLACEHOLDER-CLAUDE-CREDENTIAL" },
        command: "controlled-claude",
      }),
      executionEnvironment: controlledEnvironment([]),
    }).run({
      runPlan: resolved.value,
      taskIds: ["together-chat-smoke"],
      conditionIds: ["default"],
      credentials: { TOGETHER_API_KEY: targetCredential },
      experimentVersion: "v1-together-evidence-parity",
    });
    assert.equal(result.status, "complete");
    const record = await resultStore.getRun(result.runs[0].id);
    const egress = JSON.parse((await resultStore.readEvidence(
      record.evidence.egress[0].content,
      { maxBytes: 1_048_576 },
    )).toString("utf8"));
    observed[kind] = {
      snapshotFingerprint: record.snapshotFingerprint,
      snapshot: record.snapshot,
      state: record.state,
      verdict: record.verdict,
      checks: record.checks,
      metrics: record.metrics,
      integrityIssues: record.integrityIssues,
      artifacts: record.evidence.artifacts.map((artifact) => ({
        path: artifact.path,
        kind: artifact.kind,
        required: artifact.required,
        status: artifact.status,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      })),
      egress,
    };
  }

  assert.deepEqual(observed.postgres, observed.local);
});
