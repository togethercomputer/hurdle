import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openLocalResultStoreReader,
} from "../../harness/lib/local-result-store-reader.mjs";
import {
  createCanonicalDashboardProjection,
  MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES,
} from "../lib/canonical-dashboard-projection.mjs";
import { createClaudeCodeAdapter } from "../../harness/lib/agent-adapters/claude-code.mjs";
import { DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES } from "../../harness/lib/controller-transcript.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../../harness/test/fixtures/canonical-run-record-v2.json", import.meta.url),
  "utf8",
));
const completeRecord = fixture.history.at(-1);

test("new and existing Claude runs show the same full usage and tools without changing stored runs", async () => {
  const usage = { input_tokens: 8, output_tokens: 1158, cache_read_input_tokens: 74793, cache_creation_input_tokens: 4734 };
  const tool = id => ({ type: "assistant", message: { role: "assistant", id: "message-one", usage: { ...usage, output_tokens: 40 }, content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
  const jsonl = [tool("tool-one"), tool("tool-one"), tool("tool-two"), tool("tool-three"), { type: "result", usage }].map(frame => JSON.stringify(frame)).join("\n");
  const decoded = createClaudeCodeAdapter({ runtimeEnv: {} }).decodeControllerEvidence({ stdout: jsonl });
  for (const existing of [false, true]) {
    const record = structuredClone(completeRecord);
    record.metrics = { common: { ...decoded.metrics.common }, adapters: { "claude-code": { ...decoded.metrics.adapter } } };
    record.execution.durationMs = 27126;
    record.evidence.egress = [];
    if (existing) {
      record.metrics.common.toolCalls = null;
      record.metrics.adapters["claude-code"] = {};
    }
    const before = structuredClone(record);
    let reads = 0;
    const projection = createCanonicalDashboardProjection({ ...fixtureReader(record),
      async readEvidence(reference, options) {
        reads++;
        assert.equal(reference, record.evidence.transcript);
        assert.equal(options.maxBytes, MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES);
        return Buffer.from(jsonl);
      },
    });
    const [summary] = await projection.listSessions(record.experimentVersion);
    const [again] = await projection.listSessions(record.experimentVersion);
    assert.deepEqual(again, summary);
    assert.equal(reads, existing ? 1 : 0, "only old summaries need a bounded, cached transcript read");
    const detail = await projection.findSession(summary.id);
    for (const row of [summary, detail]) {
      assert.equal(row.totalTokens, 80693);
      assert.deepEqual(row.tokenUsage, { input: 8, output: 1158, cacheRead: 74793, cacheCreate: 4734, totalIn: 79535 });
      assert.equal(row.toolCalls, 3, "duplicate tool frames are one call");
      assert.equal(row.durationSec, 27);
      assert.equal(row.result, record.verdict);
    }
    assert.deepEqual(record, before);
  }
});

test("missing or unreadable usage stays unavailable, while recorded zero usage is meaningful", async () => {
  for (const bytes of [null, Buffer.from("broken transcript")]) {
    const record = structuredClone(completeRecord);
    record.metrics = { common: { inputTokens: 4, outputTokens: 202, toolCalls: null }, adapters: {} };
    record.evidence.egress = [];
    if (!bytes) record.evidence.transcript = null;
    const projection = createCanonicalDashboardProjection({ ...fixtureReader(record), async readEvidence() { return bytes; } });
    const [summary] = await projection.listSessions(record.experimentVersion);
    const detail = await projection.findSession(summary.id);
    for (const row of [summary, detail]) {
      assert.equal(row.totalTokens, null, "uncached input alone is not a run total");
      assert.equal(row.tokenUsage, null);
      assert.equal(row.toolCalls, null);
    }
  }
  const record = structuredClone(completeRecord);
  record.metrics = { common: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    adapters: { "claude-code": { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
  record.evidence.transcript = null;
  const [zero] = await createCanonicalDashboardProjection(fixtureReader(record)).listSessions(record.experimentVersion);
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.toolCalls, 0);
  assert.equal(zero.tokenUsage.totalIn, 0);
});

test("runtime metadata uses the saved Run snapshot even before execution or without a transcript", async () => {
  for (const original of [fixture.history[0], completeRecord]) {
    for (const [provider, label, settings, template] of [
      ["together", "Together sandbox", { snapshotAlias: "hurdle-claude-code-network@v1" }, "hurdle-claude-code-network@v1"],
      ["e2b", "E2B sandbox", { workloadTemplate: "saved-workload", guardianTemplate: "private-guardian" }, "saved-workload"],
      ["local", "Local", { cwd: "/private/workspace", snapshotAlias: "irrelevant" }, null],
      ["custom", "custom", { snapshotAlias: "irrelevant" }, null],
    ]) {
      const record = structuredClone(original);
      record.snapshot.environment = { environmentId: provider, settings: { ...settings, credential: "private" } };
      if (record.execution) record.execution.environmentId = "different-provider";
      const before = structuredClone(record);
      const projection = createCanonicalDashboardProjection(fixtureReader(record));
      const [summary] = await projection.listSessions(record.experimentVersion);
      const expected = { provider, label, template };
      assert.deepEqual(summary.runtime, expected);
      const detail = await projection.findSession(summary.id);
      assert.deepEqual(detail.runtime, expected);
      assert.equal(detail.sessionJsonl, null, "runtime must not need transcript evidence");
      assert.deepEqual(record, before, "presentation must not rewrite historical configuration");
    }
  }
});

test("missing runtime metadata is not inferred and malformed templates stay out of the Viewer", async () => {
  for (const environment of [undefined, {}, { environmentId: "bad\nprovider" }]) {
    const record = structuredClone(completeRecord);
    record.snapshot.environment = environment;
    const projection = createCanonicalDashboardProjection(fixtureReader(record));
    assert.equal((await projection.findSession(`canonical--${record.id}`)).runtime, null);
  }
  for (const snapshotAlias of [null, {}, [], "", " ", "x".repeat(257), "alias\nwith-controls"]) {
    const record = structuredClone(completeRecord);
    record.snapshot.environment = { environmentId: "together", settings: { snapshotAlias } };
    const projection = createCanonicalDashboardProjection(fixtureReader(record));
    assert.deepEqual((await projection.findSession(`canonical--${record.id}`)).runtime,
      { provider: "together", label: "Together sandbox", template: null });
  }
});

test("Judge status distinguishes code-only runs from a configured Judge that did not run", async () => {
  for (const [availability, status, expected] of [
    ["disabled", "not_requested", "Not used"],
    ["required", "not_requested", "Not run"],
    ["required", "pending", "Pending"],
    ["required", "failed", "Failed"],
    ["required", "complete", "Complete"],
  ]) {
    const record = structuredClone(completeRecord);
    record.snapshot.evaluation = { authority: { judge: { availability } } };
    record.judgeStatus = status;
    const before = structuredClone(record);
    const projection = createCanonicalDashboardProjection(fixtureReader(record));
    const detail = await projection.findSession(`canonical--${record.id}`);
    assert.equal(detail.judgeStatusLabel, expected);
    assert.equal(detail.result, record.verdict, "Judge display must not change the Decision");
    assert.deepEqual(record, before);
  }
  const old = createCanonicalDashboardProjection(fixtureReader());
  assert.equal((await old.findSession(`canonical--${completeRecord.id}`)).judgeStatusLabel, "Not used");
});

test("the Viewer shows recorded tool versions without inferring versions for old runs", async () => {
  const record = structuredClone(completeRecord);
  const versions = { runner: "2.1.263", node: "22.19.0", python: "3.12.9", pip: null };
  record.metrics.adapters[record.snapshot.agent.adapterId] = { toolVersions: versions };
  const projection = createCanonicalDashboardProjection(fixtureReader(record));
  const [summary] = await projection.listSessions(record.experimentVersion);
  assert.deepEqual(summary.toolVersions, versions);
  const detail = await projection.findSession(summary.id);
  assert.equal(detail.agentVersion, "2.1.263");
  assert.deepEqual(detail.toolVersions, versions);
  const older = createCanonicalDashboardProjection(fixtureReader());
  assert.equal((await older.findSession(`canonical--${completeRecord.id}`)).agentVersion, null);
  assert.equal(completeRecord.metrics.adapters[completeRecord.snapshot.agent.adapterId]?.toolVersions, undefined);
});

test("the Viewer bounds the tool-version metadata projection", async () => {
  for (const value of [null, [], "2.1.263", { runner: { bad: true }, node: "v22.0.0", python: "x".repeat(1_000), pip: "25.1.1", extra: "hidden" }]) {
    const record = structuredClone(completeRecord);
    record.metrics.adapters[record.snapshot.agent.adapterId] = { toolVersions: value };
    const projection = createCanonicalDashboardProjection(fixtureReader(record));
    const [summary] = await projection.listSessions(record.experimentVersion);
    assert.deepEqual(summary.toolVersions, value && !Array.isArray(value) && typeof value === "object"
      ? { runner: null, node: null, python: null, pip: "25.1.1" } : null);
    assert.equal((await projection.findSession(summary.id)).agentVersion, null);
  }
});

test("ordinary unversioned runs have a selectable dashboard bucket without rewriting records", async () => {
  const record = structuredClone(completeRecord);
  record.experimentVersion = null;
  const explicit = structuredClone(record);
  explicit.id = "run_22222222-2222-4222-8222-222222222222";
  explicit.experimentVersion = "__tae_unversioned__";
  const projection = createCanonicalDashboardProjection({
    ...fixtureReader(record), async listRuns() { return [record, explicit]; },
  });
  const versions = await projection.listVersions();
  const unversioned = versions.find(version => version.id === "__tae_unversioned__");
  assert.ok(unversioned?.id, "Home needs a nonempty selectable version ID");
  assert.equal(unversioned.name, "Aug 21, 2026");
  const sessions = await projection.listSessions(unversioned.id);
  assert.deepEqual(sessions.map(session => session.canonicalRunId), [record.id]);
  assert.equal(sessions[0].version, unversioned.id);
  assert.equal(sessions[0].result, record.verdict);
  assert.equal(new Set(versions.map(version => version.id)).size, 2);
  assert.equal(versions.find(version => version.id !== unversioned.id).name, explicit.experimentVersion);
  assert.equal(record.experimentVersion, null);

  const later = structuredClone(record);
  later.id = "run_44444444-4444-4444-8444-444444444444";
  later.completedAt = "2026-08-23T03:00:00.000Z";
  const ranged = createCanonicalDashboardProjection({
    ...fixtureReader(record), async listRuns() { return [later, explicit, record]; },
  });
  const range = (await ranged.listVersions()).find(version => version.id === unversioned.id);
  assert.equal(range.name.replace(/\s+/g, " "), "Aug 21 – 23, 2026");
  assert.equal(range.runAt, later.completedAt);
  assert.equal(range.createdAt, record.completedAt);
  assert.deepEqual((await ranged.listSessions(range.id)).map(session => session.canonicalRunId), [later.id, record.id]);
  assert.equal(later.experimentVersion, null);
});

function fixtureReader(record = completeRecord) {
  return {
    async listRuns() {
      return [record];
    },
    async getRun(id) {
      return id === record.id ? record : null;
    },
    async getRunHistory() {
      throw new Error("dashboard projection must not inspect Run history");
    },
    async readEvidence() {
      throw new Error("fixture evidence is unavailable");
    },
  };
}

function seedFixtureStore(root) {
  const runRoot = join(root, "runs", completeRecord.id);
  const revisionsRoot = join(runRoot, "revisions");
  const blobsRoot = join(runRoot, "blobs");
  mkdirSync(revisionsRoot, { recursive: true });
  mkdirSync(blobsRoot, { recursive: true });
  fixture.history.forEach((record, revision) => {
    writeFileSync(
      join(revisionsRoot, `${String(revision).padStart(6, "0")}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
  for (const [key, base64] of Object.entries(fixture.blobs)) {
    writeFileSync(join(blobsRoot, key), Buffer.from(base64, "base64"));
  }
}

test("canonical local runs list through the mature dashboard without copying or rescoring", async () => {
  const projection = createCanonicalDashboardProjection(fixtureReader());

  assert.deepEqual(await projection.listVersions(), [{
    id: "viewer-fixture-v1",
    name: "viewer-fixture-v1",
    description: null,
    kind: "experiment",
    runAt: "2026-08-21T10:00:05.000Z",
    createdAt: "2026-08-21T10:00:05.000Z",
    model: "claude-sonnet-4-5",
    ccVersion: null,
  }]);

  const sessions = await projection.listSessions("viewer-fixture-v1");
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    id: `canonical--${completeRecord.id}`,
    canonicalRunId: completeRecord.id,
    snapshotFingerprint: completeRecord.snapshotFingerprint,
    sourceKind: "canonical",
    createdAt: new Date("2026-08-21T10:00:05.000Z"),
    version: "viewer-fixture-v1",
    run: "run1",
    agent: "CC",
    agentName: "Claude Code",
    configId: "default",
    configLabel: "Default",
    configFull: "default — Default",
    configDir: "default",
    model: "claude-sonnet-4-5",
    modelResolved: "claude-sonnet-4-5-20250929",
    runtime: { provider: "local", label: "Local", template: null },
    task: "copy-message",
    taskName: "copy-message",
    durationSec: 4,
    passed: true,
    result: "pass",
    rawResult: "pass",
    auditVerdict: null,
    manualOverride: null,
    toolCalls: 7,
    totalTokens: 1_234,
    tokenUsage: null,
    costUsd: 0.42,
    costSource: "reported",
    mcpCalls: 0,
    skillInjections: 0,
    injectedSkills: [],
    mcpMethods: [],
    toolVersions: null,
    failureAnalysis: null,
    failureReview: null,
    note: "checks.required-pass: All required checks passed.\n"
      + "style-note fail — An advisory style signal did not pass.",
    prompt: "Copy the fixture into answer.txt.",
    gradingCriteria: null,
    needsFollowup: false,
    followupReason: null,
    docsCandidateCount: 0,
    docsCandidateStatuses: [],
  });
});

test("canonical dashboard detail reads only the selected digest-verified transcript", async () => {
  const record = structuredClone(completeRecord);
  record.evidence.egress = [];
  const calls = [];
  const transcript = Buffer.from(fixture.blobs[record.evidence.transcript.key], "base64");
  const reader = fixtureReader(record);
  reader.readEvidence = async (reference, options) => {
    calls.push({ reference, options });
    return transcript;
  };
  const projection = createCanonicalDashboardProjection(reader);

  const detail = await projection.findSession(`canonical--${record.id}`);

  assert.equal(detail.canonicalRunId, record.id);
  assert.equal(detail.sourceKind, "canonical");
  assert.equal(detail.readOnly, true);
  assert.equal("canonicalDetailHref" in detail, false);
  assert.equal(detail.sessionJsonl, transcript.toString("utf8"));
  assert.equal(detail.claudeSessionId, "session_viewer_fixture");
  assert.equal(detail.deepAudit, null);
  assert.deepEqual(detail.storedChecks, completeRecord.checks);
  assert.deepEqual(detail.evaluatorSources, []);
  assert.deepEqual(calls, [{
    reference: record.evidence.transcript,
    options: { maxBytes: MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES },
  }]);
});

test("canonical dashboard projects captured API calls from bounded egress evidence", async () => {
  const record = structuredClone(completeRecord);
  record.snapshot.target.egress.relevantHosts = ["api.together.ai"];
  const observedAt = "2026-08-21T10:00:03.000Z";
  const egress = Buffer.from(`${JSON.stringify({
    status: "captured",
    requests: [{
      kind: "http-request",
      sequence: 0,
      observedAt,
      method: "POST",
      scheme: "https",
      host: "api.together.ai",
      path: "/v1/chat/completions",
      statusCode: 200,
      durationMs: 42,
      selectedFields: {},
    }, {
      kind: "http-request",
      sequence: 1,
      observedAt,
      method: "POST",
      scheme: "https",
      host: "api.together.ai",
      path: "/v1/compute/clusters",
      statusCode: 403,
      durationMs: 0,
      disposition: "blocked",
      selectedFields: {},
    }, {
      kind: "websocket-session",
      sequence: 2,
      observedAt,
      scheme: "wss",
      host: "api.together.ai",
      path: "/v1/realtime",
      statusCode: 101,
      durationMs: 84,
      selectedFields: {},
      framesSent: 3,
      framesReceived: 4,
      bytesSent: 128,
      bytesReceived: 256,
    }],
  })}\n`);
  record.evidence.egress[0].content.sizeBytes = egress.byteLength;
  const transcriptBytes = Buffer.from(fixture.blobs[record.evidence.transcript.key], "base64");
  const reader = fixtureReader(record);
  let egressReadOptions;
  reader.readEvidence = async (reference, options) => {
    if (reference.sha256 === record.evidence.transcript.sha256) return transcriptBytes;
    egressReadOptions = options;
    return egress;
  };

  const detail = await createCanonicalDashboardProjection(reader)
    .findSession(`canonical--${record.id}`);

  assert.deepEqual(detail.togetherRequests, [{
    ts: observedAt,
    method: "POST",
    host: "api.together.ai",
    path: "/v1/chat/completions",
    status: 200,
    model: null,
    response_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    duration_ms: 42,
  }, {
    ts: observedAt,
    method: "POST",
    host: "api.together.ai",
    path: "/v1/compute/clusters",
    status: 403,
    model: null,
    response_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    duration_ms: 0,
    disposition: "blocked",
  }, {
    ts: observedAt,
    method: "WS",
    host: "api.together.ai",
    path: "/v1/realtime",
    status: 101,
    model: null,
    response_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    duration_ms: 84,
    frames_sent: 3,
    frames_recv: 4,
    bytes_sent: 128,
    bytes_recv: 256,
  }]);
  assert.equal(detail.togetherRequestsTruncated, false);
  assert.deepEqual(egressReadOptions, { maxBytes: 16 * 1024 * 1024 });
});

test("canonical dashboard bounds rendered API calls and marks truncation", async () => {
  const record = structuredClone(completeRecord);
  record.evidence.transcript = null;
  record.snapshot.target.egress.relevantHosts = ["api.together.ai"];
  const requests = Array.from({ length: 251 }, (_, sequence) => ({
    kind: "http-request",
    sequence,
    observedAt: "2026-08-21T10:00:03.000Z",
    method: "GET",
    scheme: "https",
    host: "api.together.ai",
    path: `/v1/items/${sequence}`,
    statusCode: 200,
    durationMs: 1,
    selectedFields: {},
  }));
  const egress = Buffer.from(`${JSON.stringify({ status: "captured", requests })}\n`);
  record.evidence.egress[0].content.sizeBytes = egress.byteLength;
  const reader = fixtureReader(record);
  reader.readEvidence = async () => egress;

  const detail = await createCanonicalDashboardProjection(reader)
    .findSession(`canonical--${record.id}`);

  assert.equal(detail.togetherRequests.length, 250);
  assert.equal(detail.togetherRequests.at(-1).path, "/v1/items/249");
  assert.equal(detail.togetherRequestsTruncated, true);
});

test("canonical dashboard lists only Task API calls, without the Agent's own traffic", async () => {
  const request = (sequence, host, path, statusCode) => ({
    kind: "http-request",
    sequence,
    observedAt: "2026-10-27T10:00:03.000Z",
    method: "GET",
    scheme: "https",
    host,
    path,
    ...(statusCode === undefined ? {} : { statusCode }),
    durationMs: 1,
    selectedFields: {},
  });
  const project = async (record, requests) => {
    record.evidence.transcript = null;
    const egress = Buffer.from(`${JSON.stringify({ status: "captured", requests })}\n`);
    record.evidence.egress[0].content.sizeBytes = egress.byteLength;
    const reader = fixtureReader(record);
    reader.readEvidence = async () => egress;
    return createCanonicalDashboardProjection(reader).findSession(`canonical--${record.id}`);
  };

  // On Together the Guardian also records Claude Code's model, config and telemetry calls.
  const together = structuredClone(completeRecord);
  together.snapshot.target.egress.relevantHosts = ["API.together.ai"];
  const detail = await project(together, [
    request(0, "api.anthropic.com", "/api/claude_code/settings", 404),
    request(1, "api.together.ai", "/v1/models", 200),
    request(2, "api.anthropic.com", "/v1/messages", 200),
    request(3, "http-intake.logs.us5.datadoghq.com", "/api/v2/logs"),
    request(4, "api.together.ai", "/v1/chat/completions", 200),
  ]);
  assert.deepEqual(detail.togetherRequests.map(row => [row.host, row.path]), [
    ["api.together.ai", "/v1/models"],
    ["api.together.ai", "/v1/chat/completions"],
  ]);
  assert.equal(detail.togetherRequestsTruncated, false);

  // Heavy Agent traffic cannot push the Task's calls past the row limit.
  const busy = structuredClone(completeRecord);
  busy.snapshot.target.egress.relevantHosts = ["api.together.ai"];
  const bounded = await project(busy, [
    ...Array.from({ length: 300 }, (_, sequence) => request(sequence, "api.anthropic.com", `/v1/messages/${sequence}`, 200)),
    request(300, "api.together.ai", "/v1/chat/completions", 200),
  ]);
  assert.deepEqual(bounded.togetherRequests.map(row => row.path), ["/v1/chat/completions"]);
  assert.equal(bounded.togetherRequestsTruncated, false);

  // A record that does not list its API hosts keeps every row as a task call.
  const older = structuredClone(completeRecord);
  delete older.snapshot.target.egress;
  const unlisted = await project(older, [request(0, "api.anthropic.com", "/v1/messages", 200)]);
  assert.deepEqual(unlisted.togetherRequests.map(row => row.host), ["api.anthropic.com"]);
});

test("canonical dashboard explains Run Trust failures before downstream check symptoms", async () => {
  const record = structuredClone(completeRecord);
  record.headline = {
    verdict: "incomplete",
    decidedBy: "effective-deterministic",
    verdictReasons: [{ code: "check.artifact", summary: "answer.txt was unavailable." }],
  };
  record.verdict = "incomplete";
  record.verdictReasons = record.headline.verdictReasons;
  record.runTrust = {
    schemaVersion: 1,
    status: "incomplete",
    reasons: [{
      code: "environment.nonzero-exit",
      summary: "Claude Code could not run because the Anthropic credit balance is too low.",
    }],
  };
  record.checks = [{ id: "artifact", outcome: "skip", summary: "answer.txt was unavailable." }];
  const [projected] = await createCanonicalDashboardProjection(fixtureReader(record))
    .listSessions(record.experimentVersion);

  assert.equal(projected.note.split("\n")[0],
    "environment.nonzero-exit: Claude Code could not run because the Anthropic credit balance is too low.");
  assert.match(projected.note, /check\.artifact: answer\.txt was unavailable/);
});

test("canonical dashboard exposes snapshot-matched evaluator source metadata without reading its bytes", async () => {
  const record = structuredClone(completeRecord);
  record.evidence.egress = [];
  const [path, sha256] = Object.entries(record.snapshot.behavior.deterministicEvaluator.modules)[0];
  record.evidence.structured = [{
    runId: record.id,
    key: sha256.slice("sha256:".length),
    mediaType: "text/javascript; charset=utf-8",
    sizeBytes: 96,
    sha256,
    provenance: `run_definition_behavior_source:${encodeURIComponent(path)}`,
    authority: "controller",
    producer: "run-engine",
    lifecyclePhase: "definition",
    capturedAt: record.createdAt,
    trust: "controller_verified",
    availability: "available",
  }];
  const reads = [];
  const transcriptBytes = Buffer.from(fixture.blobs[record.evidence.transcript.key], "base64");
  const reader = fixtureReader(record);
  reader.readEvidence = async (reference) => {
    reads.push(reference.sha256);
    return transcriptBytes;
  };

  const detail = await createCanonicalDashboardProjection(reader)
    .findSession(`canonical--${record.id}`);

  assert.deepEqual(detail.evaluatorSources, [{
    path,
    sha256,
    sizeBytes: 96,
    entry: true,
  }]);
  assert.deepEqual(reads, [record.evidence.transcript.sha256]);
});

test("canonical dashboard keeps Judge truth separate and drops unreadable evidence", async () => {
  const judged = structuredClone(completeRecord);
  judged.judgeStatus = "complete";
  judged.judge = {
    kind: "result",
    outcome: "fail",
    summary: "The stored Judge rejected the answer.",
    judgeId: "legacy-score-judge-v1",
    model: "claude-opus-4-8",
    basis: { sourceRevision: 2 },
  };
  const reader = fixtureReader(judged);
  reader.readEvidence = async () => {
    throw new Error("Stored evidence does not match its manifest");
  };
  const projection = createCanonicalDashboardProjection(reader);

  const detail = await projection.findSession(`canonical--${judged.id}`);

  assert.equal(detail.sessionJsonl, null);
  assert.deepEqual(detail.deepAudit, {
    verdict: "fail",
    summary: "The stored Judge rejected the answer.",
    judgeId: "legacy-score-judge-v1",
    model: "claude-opus-4-8",
    basis: { sourceRevision: 2 },
  });
  assert.equal(await projection.findSession("canonical--../../secret"), null);
  assert.equal(await projection.findSession("canonical--run_not-a-canonical-id"), null);
});

test("canonical dashboard projects the stored deterministic result for the session review", async () => {
  const evaluated = structuredClone(completeRecord);
  evaluated.deterministic = {
    baseline: { verdict: "pass", verdictReasons: [] },
    effective: { verdict: "pass", verdictReasons: [] },
  };
  const reader = fixtureReader(evaluated);
  reader.readEvidence = async () => Buffer.from("", "utf8");
  const projection = createCanonicalDashboardProjection(reader);

  const detail = await projection.findSession(`canonical--${evaluated.id}`);

  assert.equal(detail.deterministicEffectiveVerdict, "pass");
});

test("the Viewer reads every transcript that capture keeps", async () => {
  assert.equal(MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES, DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES);
  const record = structuredClone(completeRecord);
  record.evidence.transcript.sizeBytes = 40 * 1024 * 1024;
  let reads = 0;
  const projection = createCanonicalDashboardProjection({ ...fixtureReader(record),
    async readEvidence() {
      reads++;
      return Buffer.from("");
    },
  });
  const [summary] = await projection.listSessions(record.experimentVersion);
  await projection.findSession(summary.id);
  assert.ok(reads > 0, "a 40 MB transcript is read, not reported unavailable");
});

test("canonical dashboard keeps absent headline unknown and never reads oversized transcript", async () => {
  const unknown = structuredClone(completeRecord);
  unknown.evidence.egress = [];
  delete unknown.verdict;
  delete unknown.verdictReasons;
  delete unknown.headline;
  unknown.evidence.transcript.sizeBytes = MAX_CANONICAL_DASHBOARD_TRANSCRIPT_BYTES + 1;
  let evidenceReads = 0;
  const reader = fixtureReader(unknown);
  reader.readEvidence = async () => {
    evidenceReads += 1;
    return Buffer.alloc(0);
  };
  const projection = createCanonicalDashboardProjection(reader);

  const [summary] = await projection.listSessions("viewer-fixture-v1");
  const detail = await projection.findSession(summary.id);

  assert.equal(summary.result, "unknown");
  assert.equal(summary.passed, null);
  assert.equal(detail.sessionJsonl, null);
  assert.equal(evidenceReads, 0);
});

test("canonical dashboard projects a real read-only Local Result Store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-canonical-dashboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedFixtureStore(root);

  const reader = await openLocalResultStoreReader({ root });
  const projection = createCanonicalDashboardProjection(reader);
  const sessions = await projection.listSessions("viewer-fixture-v1");
  const detail = await projection.findSession(sessions[0].id);

  assert.equal(sessions.length, 1);
  assert.equal(detail.canonicalRunId, completeRecord.id);
  assert.match(detail.sessionJsonl, /misleading transcript/);
  assert.equal("transition" in reader, false);
  assert.equal("putEvidence" in reader, false);
});
