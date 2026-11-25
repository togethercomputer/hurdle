import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { EventEmitter } from "node:events";

import { createFrameworkCli } from "../bin/hurdle.mjs";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import {
  ANTHROPIC_JSON_JUDGE_ID,
  ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
  ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
} from "../lib/judges/anthropic-json.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { resolveRuntimeProfile } from "../lib/runtime-profile.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const legacySuite = fileURLToPath(new URL(
  "../../evals/together/legacy.suite.mjs",
  import.meta.url,
));
const chatAppSuite = fileURLToPath(new URL(
  "../../evals/together/chat-app.suite.mjs",
  import.meta.url,
));
const localJudgeRuntime = fileURLToPath(new URL(
  "../../evals/together/runtime/local-judge.json",
  import.meta.url,
));

function writeSuite(root, checks) {
  const taskRoot = join(root, "tasks", "native-tools");
  mkdirSync(join(taskRoot, "fixtures"), { recursive: true });
  mkdirSync(join(root, "skills", "provider-tools"), { recursive: true });
  writeFileSync(join(root, "skills", "provider-tools", "SKILL.md"), "# Provider tools\n");
  writeFileSync(join(taskRoot, "prompt.md"), "Use the provider's native tools.\n");
  writeFileSync(join(taskRoot, "checks.mjs"), checks);
  writeFileSync(join(root, "general.suite.mjs"), [
    'import { defineSuite } from "tae";',
    "",
    "export default defineSuite({",
    '  api: { authorizationCredential: "PROVIDER_API_KEY", hosts: ["api.provider.test"] },',
    '  tasks: ["./tasks/native-tools"],',
    '  agents: [{ runner: "claude-code", model: "sonnet" }],',
    "  conditions: {",
    "    baseline: { skills: [], mcpServers: [] },",
    "    mcp: {",
    "      skills: [],",
    '      mcpServers: [{ id: "provider-docs", transport: { kind: "http", url: "https://docs.provider.test/mcp" } }],',
    "    },",
    "    skills: {",
    '      skills: [{ name: "provider-tools", sourceDirectory: "skills/provider-tools" }],',
    "      mcpServers: [],",
    "    },",
    "  },",
    "  repeats: 1,",
    '  verdict: "hybrid",',
    '  judge: { model: "claude-opus-4-8" },',
    "});",
    "",
  ].join("\n"));
}

function capturedToolInput(snapshot) {
  return {
    snapshot,
    transcript: { jsonl: "", evidenceRef: "sha256:transcript" },
    egress: [{
      status: "captured",
      provenance: {
        producer: "controlled-sandbox",
        authority: "environment",
        lifecyclePhase: "execution",
        capturedAt: "2026-08-28T12:00:00.000Z",
        trust: "environment-observed",
      },
      requests: [{
        kind: "http-request",
        sequence: 0,
        observedAt: "2026-08-28T12:00:00.000Z",
        method: "POST",
        scheme: "https",
        host: "api.provider.test",
        path: "/v1/chat/completions",
        statusCode: 200,
        durationMs: 1,
        selectedFields: {},
        evidenceRef: "sha256:first-chat",
        exchangeFacts: {
          schemaVersion: 1,
          captureProfile: "bounded-json-exchange-facts-v1",
          policyFingerprint: `sha256:${"a".repeat(64)}`,
          profileId: "v1-native-tool-calls",
          request: {
            "request-assistant-call-id-hashes": { state: "absent" },
            "request-assistant-call-argument-hashes": { state: "absent" },
            "request-tool-result-call-id-hashes": { state: "absent" },
          },
          response: {
            "response-tool-call-id-hashes": {
              state: "present",
              matches: [{ pointer: "/choices/0/message/tool_calls/0/id", value: "sha256:call" }],
            },
            "response-tool-call-name-hashes": {
              state: "present",
              matches: [{ pointer: "/choices/0/message/tool_calls/0/function/name", value: "sha256:b14e779c51db377f684965afc1cd2dc3664ac38008b72173dca348c6ebb67594" }],
            },
            "response-tool-call-argument-hashes": {
              state: "present",
              matches: [{ pointer: "/choices/0/message/tool_calls/0/function/arguments", value: "sha256:e456ee5a2121a8b0392d6969023a489d800de77a11226ccc09752ec16ef19e69" }],
            },
          },
        },
      }, {
        kind: "http-request",
        sequence: 1,
        observedAt: "2026-08-28T12:00:01.000Z",
        method: "POST",
        scheme: "https",
        host: "api.provider.test",
        path: "/v1/chat/completions",
        statusCode: 200,
        durationMs: 1,
        selectedFields: {},
        evidenceRef: "sha256:second-chat",
        exchangeFacts: {
          schemaVersion: 1,
          captureProfile: "bounded-json-exchange-facts-v1",
          policyFingerprint: `sha256:${"a".repeat(64)}`,
          profileId: "v1-native-tool-calls",
          request: {
            "request-assistant-call-id-hashes": {
              state: "present",
              matches: [{ pointer: "/messages/1/tool_calls/0/id", value: "sha256:call" }],
            },
            "request-assistant-call-argument-hashes": {
              state: "present",
              matches: [{ pointer: "/messages/1/tool_calls/0/function/arguments", value: "sha256:e456ee5a2121a8b0392d6969023a489d800de77a11226ccc09752ec16ef19e69" }],
            },
            "request-tool-result-call-id-hashes": {
              state: "present",
              matches: [{ pointer: "/messages/2/tool_call_id", value: "sha256:call" }],
            },
          },
          response: {
            "response-tool-call-id-hashes": { state: "absent" },
            "response-tool-call-name-hashes": { state: "absent" },
            "response-tool-call-argument-hashes": { state: "absent" },
          },
        },
      }],
    }],
    readArtifactText() { return { status: "missing" }; },
  };
}

test("Suite-owned API and Condition resources apply to every selected Task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-task-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSuite(root, [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    "  run.expect.request({",
    '    id: "chat-request", method: "POST", path: "/v1/chat/completions", status: 200,',
    "  });",
    '  run.judge("The final answer resolves the request.");',
    "});",
    "",
  ].join("\n"));

  const resolved = await resolveV1Suite({
    suitePath: join(root, "general.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  assert.deepEqual(Object.keys(resolved.value.definition.conditions), ["baseline", "mcp", "skills"]);
  const task = resolved.value.definition.tasks["native-tools"];
  assert.deepEqual(task.credentialRequirements, ["PROVIDER_API_KEY"]);
  assert.deepEqual(resolved.value.definition.conditions.skills.resources.skills.map(({ name }) => name), [
    "provider-tools",
  ]);
  assert.deepEqual(resolved.value.definition.conditions.mcp.resources.mcpServers.map(({ id }) => id), [
    "provider-docs",
  ]);
  assert.equal(
    resolved.value.definition.referencedContent.conditionResources[
      "skills/provider-tools/SKILL.md"
    ].startsWith("sha256:"),
    true,
  );
});

test("run.expect.tool proves a provider-native call and its correlated result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-native-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSuite(root, [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    "  run.expect.request({",
    '    id: "chat-request", method: "POST", path: "/v1/chat/completions", status: 200,',
    "  });",
    '  run.expect.tool("lookup_inventory", {',
    "    count: 1,",
    "  });",
    '  run.judge("The final answer resolves the request.");',
    "});",
    "",
  ].join("\n"));

  const resolved = await resolveV1Suite({
    suitePath: join(root, "general.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const task = resolved.value.definition.tasks["native-tools"];
  assert.deepEqual(
    task.egress.exchangeFactProfiles.map(({ id }) => id),
    ["v1-native-tool-calls"],
  );

  const evaluator = await import(pathToFileURL(join(
    resolved.generatedRoot,
    "evaluators",
    "native-tools.mjs",
  )).href);
  const result = evaluator.evaluate(capturedToolInput(resolved.value.definition));
  assert.deepEqual(result.checks.map(({ id, outcome }) => ({ id, outcome })), [
    { id: "chat-request", outcome: "pass" },
    { id: "tool-lookup-inventory", outcome: "pass" },
  ]);
  const differentJsonEncoding = capturedToolInput(resolved.value.definition);
  const alternateArgumentsHash = `sha256:${"b".repeat(64)}`;
  differentJsonEncoding.egress[0].requests[0].exchangeFacts.response[
    "response-tool-call-argument-hashes"
  ].matches[0].value = alternateArgumentsHash;
  differentJsonEncoding.egress[0].requests[1].exchangeFacts.request[
    "request-assistant-call-argument-hashes"
  ].matches[0].value = alternateArgumentsHash;
  assert.deepEqual(
    evaluator.evaluate(differentJsonEncoding).checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "pass" },
      { id: "tool-lookup-inventory", outcome: "pass" },
    ],
  );
  const broken = capturedToolInput(resolved.value.definition);
  broken.egress[0].requests[1].exchangeFacts.request[
    "request-tool-result-call-id-hashes"
  ].matches[0].value = "sha256:other-call";
  assert.deepEqual(
    evaluator.evaluate(broken).checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "pass" },
      { id: "tool-lookup-inventory", outcome: "fail" },
    ],
  );
  const unavailable = capturedToolInput(resolved.value.definition);
  unavailable.egress[0].status = "unavailable";
  assert.deepEqual(
    evaluator.evaluate(unavailable).checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "skip" },
      { id: "tool-lookup-inventory", outcome: "skip" },
    ],
  );
});

test("run.evidence.requests exposes only trusted bounded HTTP metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-request-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSuite(root, [
    'import { defineChecks } from "tae";',
    "export default defineChecks((run) => {",
    "  run.expect.request({",
    '    id: "chat-request", method: "POST", path: "/v1/chat/completions", status: 200,',
    "  });",
    "  run.check({",
    '    id: "no-mutation",',
    "    passed: run.evidence.requests === null ? null : !run.evidence.requests.some((request) => (",
    '      request.method === "DELETE" || request.path.startsWith("/v1/endpoints")',
    "    )),",
    '    summary: "No provider resource mutation was observed.",',
    "    evidence: run.evidence.requests?.map(({ evidence }) => evidence) ?? [],",
    "  });",
    '  run.judge("The final answer resolves the request.");',
    "});",
    "",
  ].join("\n"));
  const resolved = await resolveV1Suite({
    suitePath: join(root, "general.suite.mjs"),
  });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const evaluator = await import(pathToFileURL(join(
    resolved.generatedRoot,
    "evaluators",
    "native-tools.mjs",
  )).href);
  const input = capturedToolInput(resolved.value.definition);
  const result = evaluator.evaluate(input);
  assert.deepEqual(result.checks.map(({ id, outcome }) => ({ id, outcome })), [
    { id: "chat-request", outcome: "pass" },
    { id: "no-mutation", outcome: "pass" },
  ]);
  const checkSource = readFileSync(join(
    resolved.generatedRoot,
    "evaluators",
    "native-tools-checks.mjs",
  ), "utf8");
  assert.doesNotMatch(checkSource, /headers|body|query/);
});

test("the checked-in chat app Suite is one Local-first Judge cell", async (t) => {
  const resolved = await resolveV1Suite({ suitePath: chatAppSuite });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  assert.deepEqual(resolved.defaults.taskIds, ["chat-app"]);
  assert.deepEqual(resolved.defaults.conditionIds, ["baseline"]);
  assert.deepEqual(resolved.defaults.agentSelections, [{
    adapterId: "claude-code",
    requestedModel: "claude-sonnet-4-6",
    settings: {},
  }]);
  assert.equal(resolved.defaults.repeat, 1);
  assert.equal(
    resolved.value.definition.tasks["chat-app"].evaluation.authority.defaultProfileId,
    "v1-judge",
  );
});

test("the checked-in Local Judge Runtime stores results at the repository root", () => {
  const runtime = resolveRuntimeProfile({
    runtimePath: localJudgeRuntime,
    cwd: dirname(localJudgeRuntime),
  });
  assert.equal(runtime.environment.kind, "local");
  assert.equal(runtime.judge.model, "claude-opus-4-8");
  assert.equal(runtime.judge.credentialEnv, "ANTHROPIC_API_KEY");
  assert.equal(
    runtime.resultStore.root,
    fileURLToPath(new URL("../../.hurdle/results-v1", import.meta.url)),
  );
});

test("the CLI previews the showcase denominator and billable services before execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-showcase-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    environment: { kind: "local" },
    resultStore: { kind: "local", root: "results" },
    judge: {
      kind: "anthropic-json-v1",
      model: "claude-opus-4-8",
      credentialEnv: "TEST_JUDGE_KEY",
    },
  })}\n`);
  const events = [];
  const stdout = { write(value) { events.push(["stdout", value]); } };
  const stderr = { write(value) { events.push(["stderr", value]); } };
  const processTarget = new EventEmitter();
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: { TEST_JUDGE_KEY: "TEST-PLACEHOLDER-JUDGE-CREDENTIAL" },
    processTarget,
    async openLocalResultStore() { events.push(["store"]); return Object.freeze({}); },
    createAgentAdapter(adapterId) { return Object.freeze({ id: adapterId }); },
    createLocalExecutionEnvironment() { return Object.freeze({ id: "local" }); },
    createAnthropicJsonJudge() { return Object.freeze({ id: "anthropic-json-v1" }); },
    createRunEngine() {
      return { async run(input) {
        events.push(["execute"]);
        assert.equal(input.taskIds.length, 3);
        assert.equal(input.conditionIds.length, 3);
        assert.equal(input.agentSelections.length, 1);
        return {
          status: "completed",
          diagnostics: [],
          summary: {
            plannedCells: 9,
            plannedRepeats: 9,
            attempts: 9,
            retriesPerformed: 0,
            terminalVerdicts: { pass: 9, fail: 0, incomplete: 0, unknown: 0 },
            authorityCoverage: {
              totalRuns: 9,
              recordedRuns: 9,
              judgeRequiredRuns: 9,
              judgeCompletedRuns: 9,
              comparableRuns: 9,
              agreements: 9,
              disagreements: 0,
            },
            nonPasses: [],
            omittedNonPasses: 0,
          },
        };
      } };
    },
  });

  const exit = await cli.main([
    "run",
    legacySuite,
    "--runtime",
    join(root, "runtime.json"),
  ], { cwd: root, stdout, stderr });
  assert.equal(exit, 0, events.filter(([kind]) => kind === "stderr").flat().join(""));
  const output = events.filter(([kind]) => kind === "stdout").map(([, value]) => value).join("");
  assert.match(output, /^  Plan\s+9 runs · 3 tasks · 3 conditions$/m);
  assert.match(output, /^  Runtime\s+runtime.json\n  Execution\s+Local\n  Store\s+Filesystem$/m);
  assert.match(output, /^  Scoring\s+Judge$/m);
  assert.match(output, /^  Usage\s+Agent, Judge, and external API may be billed$/m);
  assert.match(
    output,
    /^  Access\s+Target API credentials available to Agent$/m,
  );
  assert.match(output, /^  Keys\s+[A-Z0-9_]+ → the Agent's environment$/m);
  assert.ok(events.findIndex(([kind]) => kind === "stdout") < events.findIndex(([kind]) => kind === "store"));
  assert.ok(events.findIndex(([kind]) => kind === "stdout") < events.findIndex(([kind]) => kind === "execute"));
});

test("representative Claude and Codex Runs store code, Judge, version, and denominator truth", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-v1-showcase-records-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolved = await resolveV1Suite({ suitePath: legacySuite });
  t.after(() => resolved.dispose());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const store = await openLocalResultStore({ root: join(root, "results") });
  const environment = {
    id: "controlled-sandbox",
    capabilities: ["environment.isolated-workspace", "environment.trusted-egress-capture"],
    captureCapabilities: { protocols: ["https"], selectedFields: true },
    normalizeSettings(settings = {}) { return settings; },
    async execute(envelope) {
      const claude = envelope.launchPlan.command === "controlled-claude";
      const stdout = claude
        ? `${JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "showcase-claude-session",
            model: "sonnet",
            result: "Chat, image, and transcription completed.",
          })}\n`
        : `${JSON.stringify({ type: "thread.started", thread_id: "showcase-codex-thread" })}\n`
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
          startedAt: "2026-08-28T12:00:00.000Z",
          endedAt: "2026-08-28T12:00:01.000Z",
          durationMs: 1_000,
        },
        artifacts: [],
        integrityIssues: [],
        egressCollections: [{
          status: "captured",
          provenance: {
            producer: "controlled-sandbox",
            authority: "environment",
            lifecyclePhase: "execution",
            capturedAt: "2026-08-28T12:00:01.000Z",
            trust: "environment-observed",
          },
          requests: [
            ["/v1/chat/completions", 0],
            ["/v1/images/generations", 1],
            ["/v1/audio/transcriptions", 2],
          ].map(([path, sequence]) => ({
            kind: "http-request",
            sequence,
            observedAt: "2026-08-28T12:00:00.000Z",
            method: "POST",
            scheme: "https",
            host: "api.together.ai",
            path,
            statusCode: 200,
            durationMs: 1,
            selectedFields: {},
          })),
        }],
      };
    },
  };
  const judge = {
    id: ANTHROPIC_JSON_JUDGE_ID,
    model: "claude-opus-4-8",
    inputSchemaVersions: [2],
    maxTimeoutMs: ANTHROPIC_JSON_JUDGE_MAX_TIMEOUT_MS,
    maxInputBytes: ANTHROPIC_JSON_JUDGE_MAX_INPUT_BYTES,
    maxOutputBytes: ANTHROPIC_JSON_JUDGE_MAX_OUTPUT_BYTES,
    async judge() { return { outcome: "pass", summary: "All three capabilities were demonstrated." }; },
  };
  const result = await createRunEngine({
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
    executionEnvironment: environment,
    judge,
  }).run({
    runPlan: resolved.value,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    agentSelections: [
      { adapterId: "claude-code", requestedModel: "claude-sonnet-4-6", settings: {} },
      { adapterId: "codex", requestedModel: "gpt-5.5", settings: {} },
    ],
    credentials: { TOGETHER_API_KEY: "TEST-PLACEHOLDER-TOGETHER-CREDENTIAL" },
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(result.summary.terminalVerdicts, {
    pass: 2,
    fail: 0,
    incomplete: 0,
    unknown: 0,
  });
  assert.deepEqual(result.summary.authorityCoverage, {
    totalRuns: 2,
    recordedRuns: 2,
    judgeRequiredRuns: 2,
    judgeCompletedRuns: 2,
    comparableRuns: 0,
    agreements: 0,
    disagreements: 0,
  });
  const records = await store.listRuns();
  assert.equal(records.length, 2);
  assert.ok(records.every(({ checks, judge, snapshot }) => (
    checks.length === 3
    && checks.every(({ outcome, effectiveAuthority }) => outcome === "pass" && effectiveAuthority === "advisory")
    && judge.outcome === "pass"
    && judge.judgeId === "anthropic-json-v1"
    && judge.model === "claude-opus-4-8"
    && snapshot.evaluation.authority.kind === "judge-primary"
    && snapshot.evaluation.authority.judge.capability.model === "claude-opus-4-8"
    && typeof snapshot.agent.adapterId === "string"
    && typeof snapshot.agent.requestedModel === "string"
  )), JSON.stringify(records, null, 2));
  assert.deepEqual(
    records.map(({ snapshot }) => snapshot.agent.adapterId).sort(),
    ["claude-code", "codex"],
  );
});
