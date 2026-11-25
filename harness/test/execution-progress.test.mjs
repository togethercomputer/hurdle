import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExecutionProgressObserver,
  reportExecutionProgress,
} from "../lib/execution-progress.mjs";

test("execution progress projects closed frozen events and isolates observer failures", async () => {
  const events = [];
  const observer = normalizeExecutionProgressObserver({
    observe(event) {
      events.push(event);
      if (event.kind === "cell-started") throw new Error("presentation failed");
      if (event.kind === "cell-completed") return Promise.reject(new Error("async failure"));
      return undefined;
    },
  });

  assert.doesNotThrow(() => reportExecutionProgress(observer, {
    kind: "matrix-ready",
    total: 6,
    secret: "must-not-cross",
  }));
  assert.doesNotThrow(() => reportExecutionProgress(observer, {
    kind: "cell-started",
    cell: {
      ordinal: 1,
      total: 6,
      taskId: "rag-search-evidence-v1",
      conditionId: "baseline",
      adapterId: "claude-code",
      repeatOrdinal: 1,
      repeatTotal: 1,
      secret: "must-not-cross",
    },
  }));
  assert.doesNotThrow(() => reportExecutionProgress(observer, {
    kind: "cell-completed",
    cell: {
      ordinal: 1,
      total: 6,
      taskId: "rag-search-evidence-v1",
      conditionId: "baseline",
      adapterId: "claude-code",
      repeatOrdinal: 1,
      repeatTotal: 1,
    },
    terminal: {
      id: "run_one",
      verdict: "pass",
      snapshotFingerprint: "must-not-cross",
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    { kind: "matrix-ready", total: 6 },
    {
      kind: "cell-started",
      cell: {
        ordinal: 1,
        total: 6,
        taskId: "rag-search-evidence-v1",
        conditionId: "baseline",
        adapterId: "claude-code",
        repeatOrdinal: 1,
        repeatTotal: 1,
      },
    },
    {
      kind: "cell-completed",
      cell: {
        ordinal: 1,
        total: 6,
        taskId: "rag-search-evidence-v1",
        conditionId: "baseline",
        adapterId: "claude-code",
        repeatOrdinal: 1,
        repeatTotal: 1,
      },
      terminal: { id: "run_one", verdict: "pass", verdictReasons: [] },
    },
  ]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.equal(Object.isFrozen(events[1].cell), true);
  assert.equal(reportExecutionProgress(null, { kind: "matrix-ready", total: 1 }), false);
  assert.equal(reportExecutionProgress(observer, { kind: "unknown" }), false);
});

test("non-pass progress projects only bounded single-line stored reasons", () => {
  const events = [];
  const cell = { ordinal: 1, total: 1, taskId: "sample", conditionId: "baseline", adapterId: "codex", repeatOrdinal: 1, repeatTotal: 1 };
  const reason = { code: "environment.acquire-failed", summary: "Sandbox failed.\n\u001b[31mCheck setup.\u001b[0m", evidenceRefs: ["not-for-terminal"], rawError: "private-error" };
  reportExecutionProgress({ observe(event) { events.push(event); } }, {
    kind: "cell-completed", cell,
    terminal: { id: "run_one", verdict: "incomplete", runTrustReasons: [{
      code: "environment.nonzero-exit",
      summary: "Agent could not start.",
      evidenceRefs: ["not-for-terminal"],
    }], verdictReasons: [
      reason, reason, { code: "invalid\ncode", summary: "ignored" },
      { code: "artifact.required-missing", summary: "x".repeat(1000) },
      { code: "judge.result-required", summary: "Judge unavailable." },
      { code: "omitted", summary: "fourth reason" },
    ] },
  });
  const reasons = events[0].terminal.verdictReasons;
  assert.deepEqual(events[0].terminal.runTrustReasons, [{
    code: "environment.nonzero-exit",
    summary: "Agent could not start.",
  }]);
  assert.equal(reasons.length, 3);
  assert.deepEqual(reasons[0], { code: reason.code, summary: "Sandbox failed. Check setup." });
  assert.equal(reasons[1].summary.length, 300);
  assert.ok(reasons[1].summary.endsWith("…"));
  assert.ok(Object.isFrozen(reasons) && reasons.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(reasons), /private-error|not-for-terminal|fourth reason|\\u001b|\\n/);
});


test("remote resource progress preserves provider identity and strips private metadata", () => {
  const events = [];
  const observer = { observe: event => events.push(event) };
  for (const provider of ["together"]) {
    assert.equal(reportExecutionProgress(observer, {
      kind: "environment-resource-allocated", executionId: "execution-one", environmentId: provider,
      resource: { provider, role: "agent", id: "vm-one", token: "private-token" },
    }), true);
    assert.deepEqual(events.at(-1).resource, { provider, role: "agent", id: "vm-one" });
  }
  assert.equal(reportExecutionProgress(observer, {
    kind: "environment-resource-allocated", executionId: "execution-one", environmentId: "together",
    resource: { provider: "other", role: "agent", id: "vm-one" },
  }), false);
  assert.doesNotMatch(JSON.stringify(events), /private-token/);
});

test("environment status accepts only closed lifecycle stages and omits private metadata", () => {
  const events = [];
  const observer = { observe: event => events.push(event) };
  const stage = { kind: "environment-status", environmentId: "together", executionId: "run-one", status: "agent-running", token: "private-token", stderr: "private-error" };
  assert.equal(reportExecutionProgress(observer, stage), true);
  assert.deepEqual(events, [{ kind: stage.kind, environmentId: stage.environmentId, executionId: stage.executionId, status: stage.status }]);
  assert.ok(Object.isFrozen(events[0]));
  for (const invalid of [{ status: "private-error" }, { status: "toString" }, { status: null }, { environmentId: "unknown" }, { executionId: "run\nunsafe" }])
    assert.equal(reportExecutionProgress(observer, { ...stage, ...invalid }), false);
  assert.equal(events.length, 1);
});


test("attempt progress maps concurrent lifecycle events to a cell without private metadata", () => {
  const events = [];
  const observer = { observe: event => events.push(event) };
  const cell = { ordinal: 2, total: 5, taskId: "copy", conditionId: "baseline", adapterId: "codex", repeatOrdinal: 1, repeatTotal: 1, secret: "private-cell" };
  const event = { kind: "cell-attempt-started", cell, executionId: "run-two", token: "private-token" };
  assert.equal(reportExecutionProgress(observer, event), true);
  assert.deepEqual(events[0], { kind: event.kind, cell: { ordinal: 2, total: 5, taskId: "copy", conditionId: "baseline", adapterId: "codex", repeatOrdinal: 1, repeatTotal: 1 }, executionId: "run-two" });
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].cell));
  for (const executionId of [null, "", "run\nunsafe", "x".repeat(257)]) {
    assert.equal(reportExecutionProgress(observer, { ...event, executionId }), false);
  }
  assert.doesNotMatch(JSON.stringify(events), /private-cell|private-token/);
});

test("completed progress projects stored checks without evidence and re-projects losslessly", () => {
  const events = [];
  const observer = { observe(event) { events.push(event); } };
  const cell = { ordinal: 1, total: 1, taskId: "sample", conditionId: "baseline", adapterId: "codex", repeatOrdinal: 1, repeatTotal: 1 };
  const stored = (id, outcome = "pass", effectiveAuthority = "required", summary = "Fine.") => ({
    id, authoredAuthority: "required", effectiveAuthority, outcome, summary,
    evidenceRefs: [`sha256:${"a".repeat(64)}`], details: { raw: "private-detail" },
  });
  reportExecutionProgress(observer, {
    kind: "cell-completed", cell,
    terminal: { id: "run_one", verdict: "fail", verdictReasons: [], checks: [
      stored("completed"),
      stored("exact-copy", "fail", "required", "answer.txt\n\u001b[31mdiffers\u001b[0m."),
      stored("tone", "skip", "advisory", "x".repeat(1000)),
      stored("completed", "fail"), stored("Invalid-Id"), stored("bad-outcome", "error"),
      stored("bad-authority", "pass", "authored"), { ...stored("no-summary"), summary: null },
      ...Array.from({ length: 130 }, (_, index) => stored(`extra-${index}`)),
    ] },
  });
  const { checks, omittedCheckCount } = events[0].terminal;
  assert.deepEqual(checks.slice(0, 2), [
    { id: "completed", outcome: "pass", effectiveAuthority: "required", summary: "Fine." },
    { id: "exact-copy", outcome: "fail", effectiveAuthority: "required", summary: "answer.txt differs." },
  ]);
  assert.equal(checks[2].effectiveAuthority, "advisory");
  assert.equal(checks[2].summary.length, 300);
  assert.equal(checks.length, 123, "invalid and duplicate checks are dropped within the projection bound");
  assert.equal(omittedCheckCount, 138 - 123);
  assert.ok(Object.isFrozen(checks) && checks.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(events), /sha256|private-detail|authoredAuthority|\\u001b|\\n/);

  reportExecutionProgress(observer, events[0]);
  assert.deepEqual(events[1], events[0], "observers that re-report a projected event keep every check");
  reportExecutionProgress(observer, { kind: "cell-completed", cell, terminal: { id: "run_two", verdict: "pass", checks: [stored("completed")] } });
  assert.deepEqual(events[2].terminal.checks, [{ id: "completed", outcome: "pass", effectiveAuthority: "required", summary: "Fine." }]);
  assert.equal(Object.hasOwn(events[2].terminal, "omittedCheckCount"), false);
});
