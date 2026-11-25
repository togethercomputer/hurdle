import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import { createCanonicalDashboardProjection } from "../../viewer/lib/canonical-dashboard-projection.mjs";

const together = new URL("../../evals/together/", import.meta.url);
const observedAt = "2026-09-10T12:00:00.000Z";
const tool = {
  model: "model",
  tool_calls: [{ arguments: '{"sku":"SKU-1"}' }, { arguments: { zip: "94107" } }],
  local_tool_results: [{ result: "in stock" }, { result: "two days" }],
  final_answer: "In stock; arrives in two days.", finish_reasons: ["tool_calls", "stop"],
};
const artifacts = { "tool_calling_agent_results.json": tool };
const routes = [
  ["POST", "/v1/chat/completions"], ["POST", "/v1/chat/completions"],
  ["POST", "/v1/images/generations"], ["POST", "/v1/audio/transcriptions"],
  ["GET", "/v1/compute/regions"],
];
const expected = {
  "chat-app": ["chat-completion", "image-generation", "transcription"],
  "tool-calling-agent-loop": ["chat-traffic-two-turns", "tool-loop-results", "artifact-schema"],
  "gpu-clusters": ["region-inventory", "no-reservation"],
};

async function resolveSuite(t, file = "legacy.suite.mjs") {
  const suite = await resolveV1Suite({ suitePath: fileURLToPath(new URL(file, together)) });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
  return suite;
}

function input({ requests = routes, capture = "trusted", artifactValues = artifacts } = {}) {
  return {
    snapshot: { target: { egress: { relevantHosts: ["api.together.ai", "api.together.xyz"] } } },
    transcript: { jsonl: "", evidenceRef: "sha256:transcript" },
    egress: capture === "unavailable" ? [] : [{
      status: "captured",
      provenance: { lifecyclePhase: "execution", trust: capture === "trusted" ? "environment-observed" : "agent-reported" },
      requests: requests.map(([method, path, statusCode = 200, host = "api.together.ai"], sequence) => ({
        method, path, statusCode, host, sequence, evidenceRef: `sha256:request-${sequence}`,
      })),
    }],
    readArtifactText(path) {
      if (!Object.hasOwn(artifactValues, path)) return { status: "missing" };
      const value = artifactValues[path];
      return { status: "present", text: typeof value === "string" ? value : JSON.stringify(value), evidenceRef: "sha256:artifact" };
    },
  };
}

async function checksFor(suite, task) {
  const path = suite.value.definition.tasks[task].evaluation.deterministicEvaluator;
  assert.equal(typeof path, "string", `${task} must have a deterministic evaluator`);
  return (await import(pathToFileURL(join(suite.generatedRoot, path)).href)).evaluate;
}

test("Together checks are advisory, Local-compatible and excluded from Judge input", async (t) => {
  const suite = await resolveSuite(t);
  for (const [id, task] of Object.entries(suite.value.definition.tasks)) {
    assert.deepEqual(task.executionRequirements, ["environment.isolated-workspace"], id);
    assert.equal(task.egress.captureMode, "optional", id);
    assert.equal(task.credentialDeliveryOverrides, undefined, id);
    assert.ok((task.outputArtifacts ?? []).every(artifact => artifact.required === false));
    const evaluate = await checksFor(suite, id);
    const checks = evaluate(input()).checks;
    assert.deepEqual(checks.map(check => check.id), expected[id]);
    assert.ok(checks.every(check => check.outcome === "pass"), id);
    assert.deepEqual(checks.filter(check => check.required).map(check => check.id),
      id === "tool-calling-agent-loop" ? ["artifact-schema"] : []);
  }
  const profiles = Object.values(suite.value.definition.authorityProfiles);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].kind, "judge-primary");
  assert.equal(profiles[0].checkPolicy.defaultRule, "advisory");
  assert.equal(profiles[0].judge.projection.include.advisoryChecks, false);
  assert.equal(profiles[0].judge.projection.include.textArtifacts, false);
});

test("unavailable or Agent-claimed traffic skips; sealed empty traffic does not invent success", async (t) => {
  const suite = await resolveSuite(t);
  for (const task of Object.keys(expected)) {
    const evaluate = await checksFor(suite, task);
    for (const capture of ["unavailable", "agent-reported"]) {
      const checks = evaluate(input({ capture, artifactValues: {} })).checks;
      assert.ok(checks.every(check => check.outcome === "skip"), `${task}: ${capture}`);
    }
    const checks = evaluate(input({ requests: [], artifactValues: {} })).checks;
    for (const check of checks) {
      const negative = check.id === "no-reservation";
      const artifact = ["tool-loop-results", "artifact-schema"].includes(check.id);
      assert.equal(check.outcome, negative ? "pass" : artifact ? "skip" : "fail", `${task}: ${check.id}`);
    }
  }
});

test("traffic checks reject failed calls, unrelated hosts, missing turns and attempted mutations", async (t) => {
  const suite = await resolveSuite(t);
  const chat = await checksFor(suite, "chat-app");
  for (const requests of [routes.map(([method, path]) => [method, path, 401]), routes.map(([method, path]) => [method, path, 200, "example.com"])]) {
    assert.ok(chat(input({ requests })).checks.every(check => check.outcome === "fail"));
  }
  assert.ok(chat(input({ requests: routes.map(([method, path]) => [method, path, 201, "api.together.xyz"]) })).checks.every(check => check.outcome === "pass"));
  const toolChecks = await checksFor(suite, "tool-calling-agent-loop");
  assert.equal(toolChecks(input({ requests: [["POST", "/v1/chat/completions"]] })).checks[0].outcome, "fail");
  const gpu = await checksFor(suite, "gpu-clusters");
  for (const path of ["/compute/regions", "/v1/compute/regions"]) {
    assert.equal(gpu(input({ requests: [["GET", path]] })).checks[0].outcome, "pass");
  }
  for (const path of ["/compute/reservations", "/v1/clusters", "/v1/gpu/reservations"]) {
    assert.equal(gpu(input({ requests: [["POST", path, 403]] })).checks[1].outcome, "fail");
  }
});

test("ported artifact validators retain legacy aliases and reject malformed or incomplete outputs", async (t) => {
  const suite = await resolveSuite(t);
  const toolChecks = await checksFor(suite, "tool-calling-agent-loop");
  const outcome = (evaluate, path, value) => evaluate(input({ artifactValues: { [path]: value } })).checks.find(check => check.id === "artifact-schema").outcome;
  assert.equal(outcome(toolChecks, "tool_calling_agent_results.json", {
    model: "model", tool_calls: [], toolCalls: tool.tool_calls, local_tool_results: [],
    toolResults: tool.local_tool_results, finalAnswer: "done", finishReasons: [{ finish_reason: "stop" }],
  }), "pass");
  for (const value of ["not JSON", "null", "[]", "{}", JSON.stringify({ ...tool, tool_calls: [{ arguments: "bad JSON" }, { arguments: "{}" }] }), JSON.stringify({ ...tool, final_answer: "" })]) {
    assert.equal(outcome(toolChecks, "tool_calling_agent_results.json", value), "fail", value);
  }
});

test("legacy and hybrid share task inputs, models and all Conditions, but select different authority", async (t) => {
  const legacy = await resolveSuite(t);
  const hybrid = await resolveSuite(t, "hybrid.suite.mjs");
  assert.deepEqual(hybrid.defaults.taskIds, ["tool-calling-agent-loop"]);
  assert.deepEqual(legacy.defaults.agentSelections, hybrid.defaults.agentSelections);
  assert.deepEqual(legacy.value.definition.conditions, hybrid.value.definition.conditions);
  const legacyPolicy = legacy.value.definition.authorityProfiles[0];
  const hybridPolicy = hybrid.value.definition.authorityProfiles[0];
  assert.equal(hybridPolicy.schemaVersion, 2);
  assert.equal(hybridPolicy.kind, "hybrid");
  assert.equal(hybridPolicy.checkPolicy.defaultRule, "authored");
  assert.deepEqual(legacyPolicy.judge, hybridPolicy.judge);
  for (const id of hybrid.defaults.taskIds) {
    const a = legacy.value.definition.tasks[id], b = hybrid.value.definition.tasks[id];
    for (const key of ["prompt", "fixtures", "outputArtifacts", "egress", "executionRequirements", "credentialRequirements"]) {
      assert.deepEqual(a[key], b[key], `${id}: ${key}`);
    }
    assert.equal(a.evaluation.authority.bindings[0].rubric, b.evaluation.authority.bindings[0].rubric);
    assert.equal(a.evaluation.deterministicEvaluator, b.evaluation.deterministicEvaluator);
  }
});

function controlledLocalEnvironment(artifactMode) {
  return {
    id: "local", capabilities: ["environment.isolated-workspace"],
    normalizeSettings(settings = {}) { return settings; },
    async execute(envelope) {
      return {
        process: {
          stdout: { text: `${JSON.stringify({ type: "result", subtype: "success", session_id: "controlled-session", model: "claude-sonnet-4-6", result: "Controlled test completed." })}\n`, complete: true },
          stderr: { text: "", complete: true }, exitCode: 0, signal: null, timedOut: false,
          captureOverflow: false, spawnError: null, quiescent: true,
          startedAt: observedAt, endedAt: observedAt, durationMs: 1,
        },
        artifacts: envelope.outputArtifacts.map(declaration => {
          if (artifactMode === "missing") return { ...declaration, status: "missing", capturedAt: observedAt };
          const bytes = Buffer.from(JSON.stringify(artifactMode === "valid" ? artifacts[declaration.path] : {}));
          return { ...declaration, status: "captured", bytes, sizeBytes: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, capturedAt: observedAt };
        }),
        integrityIssues: [],
        egressCollections: [{
          status: "unavailable", reason: "unsupported-platform", requests: [],
          provenance: { producer: "controlled-local", authority: "environment", lifecyclePhase: "execution", capturedAt: observedAt, trust: "environment-observed" },
        }],
      };
    },
  };
}

test("Local engine, store and Viewer preserve legacy observations and strict hybrid outcomes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-together-hybrid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["legacy.suite.mjs", "hybrid.suite.mjs"]) {
    const suite = await resolveSuite(t, file);
    const hybrid = file.startsWith("hybrid");
    for (const [artifactMode, judgeOutcome] of [["valid", "pass"], ["invalid", "pass"], ["missing", "pass"], ["valid", "fail"], ["valid", "incomplete"], ["valid", "error"]]) {
      const store = await openLocalResultStore({ root: join(root, `${file}-${artifactMode}-${judgeOutcome}`) });
      const judgeInputs = [];
      const engine = createRunEngine({
        resultStore: store,
        agentAdapter: createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: "TEST-PLACEHOLDER" }, command: "controlled-claude" }),
        executionEnvironment: controlledLocalEnvironment(artifactMode),
        judge: {
          id: "anthropic-json-v1", model: "claude-opus-4-8", inputSchemaVersions: [2], maxTimeoutMs: 120_000,
          async judge(input) {
            judgeInputs.push(input);
            if (judgeOutcome === "error") throw new Error("private provider error");
            return { outcome: judgeOutcome, summary: "Controlled Judge result." };
          },
        },
      });
      const result = await engine.run({
        runPlan: suite.value, taskIds: ["tool-calling-agent-loop"],
        conditionIds: ["baseline"], agentSelections: suite.defaults.agentSelections,
        credentials: { TOGETHER_API_KEY: "TEST-PLACEHOLDER-TARGET" }, experimentVersion: file,
      });
      assert.equal(result.status, "complete", JSON.stringify(result.diagnostics));
      const expected = hybrid && artifactMode !== "valid" ? artifactMode === "missing" ? "incomplete" : "fail"
        : judgeOutcome === "error" ? hybrid ? "incomplete" : "unknown" : judgeOutcome;
      assert.deepEqual(result.runs.map(run => run.verdict), [expected], `${file}: ${artifactMode}, ${judgeOutcome}`);
      if (!hybrid) assert.equal(result.summary.authorityCoverage.comparableRuns, 0, "advisory-only unknown must not count as a Judge disagreement");
      assert.equal(judgeInputs.length, 1);
      for (const input of judgeInputs) {
        assert.deepEqual(input.deterministic.checks, []);
        assert.equal(input.deterministic.effective, null);
        assert.equal(input.deterministic.baseline, null);
        assert.ok(input.evidence.every(item => !item.kind.includes("artifact") && !item.kind.includes("egress")));
      }
      const reopened = await openLocalResultStore({ root: join(root, `${file}-${artifactMode}-${judgeOutcome}`) });
      const records = await reopened.listRuns();
      assert.equal(records.length, 1);
      for (const record of records) {
        assert.equal(record.runTrust.status, "trusted");
        assert.equal(record.snapshot.evaluation.authority.schemaVersion, hybrid ? 2 : 1);
        const shape = record.checks.find(check => check.id === "artifact-schema");
        assert.equal(shape.effectiveAuthority, hybrid ? "required" : "advisory");
        assert.ok(record.checks.filter(check => check.id.includes("traffic")).every(check => check.outcome === "skip" && check.effectiveAuthority === "advisory"));
      }
      const viewer = createCanonicalDashboardProjection(reopened);
      const versions = await viewer.listVersions();
      const sessions = await viewer.listSessions(versions[0].id);
      assert.deepEqual(sessions.map(session => session.result), [expected]);
    }
  }
});
