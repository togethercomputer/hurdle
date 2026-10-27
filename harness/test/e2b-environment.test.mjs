import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  closeExecutionCredentialLease,
  createExecutionEnvelope,
} from "../lib/execution-envelope.mjs";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { createE2BExecutionEnvironment } from "../lib/execution-environments/e2b.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const togetherSuitePath = fileURLToPath(new URL("../../evals/together/chat-app.suite.mjs", import.meta.url));

async function togetherRunPlan() {
  const resolved = await resolveV1Suite({ suitePath: togetherSuitePath });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  test.after(() => resolved.dispose());
  const definition = structuredClone(resolved.value.definition);
  definition.authorityProfiles = [{
    schemaVersion: 1,
    id: "e2b-code",
    kind: "deterministic-primary",
    checkPolicy: { defaultRule: "required" },
    judge: { availability: "disabled" },
  }];
  for (const task of Object.values(definition.tasks)) {
    task.credentialDeliveryOverrides = {
      TOGETHER_API_KEY: {
        kind: "captured-http-header",
        hosts: ["api.together.ai", "api.together.xyz"],
        headerNames: ["authorization"],
      },
    };
    delete task.egress.captureMode;
    task.executionRequirements = [
      "environment.isolated-workspace",
      "environment.trusted-egress-capture",
    ];
    task.evaluation.authority = {
      defaultProfileId: "e2b-code",
      bindings: [{ profileId: "e2b-code", checkRules: [] }],
    };
  }
  return { ...resolved.value, definition };
}

function controlledAdapter() {
  return {
    id: "controlled-agent",
    capabilities: ["agent.selected-context"],
    normalizeSettings({ requestedModel, settings }) {
      return { requestedModel: requestedModel ?? null, settings: settings ?? {} };
    },
    createLaunchPlan() {
      return {
        command: "/opt/agent/bin/controlled",
        args: ["run"],
        env: {
          ADAPTER_AUTH: "adapter-secret",
          PATH: "/controller-only",
          HOME: "/Users/controller",
          SHELL: "/bin/zsh",
          USER: "controller",
          LOGNAME: "controller",
          TMPDIR: "/controller-tmp",
        },
        stdin: "prompt",
        timeoutMs: 1_000,
        workspaceFiles: [],
      };
    },
    decodeControllerEvidence({ stdout }) {
      return {
        transcript: stdout,
        observedModel: "controlled-model",
        sessionId: "controlled-session",
        metrics: { common: {}, adapter: {} },
      };
    },
    redactControllerText(value) {
      return value.replaceAll("adapter-secret", "<REDACTED>");
    },
  };
}

function controlledRuntime(events, secret, {
  controllerStdout = `${JSON.stringify({ type: "result" })}\n`,
  controllerStderr = "",
  processExitCode = 0,
  onRun = null,
  expectedFixtureCount = 1,
  expectedCaptureProtocols = ["https"],
  artifactBytesFor = null,
  egressEvents = null,
  egressRequests = null,
  processDurationMs = 1,
  workspaceArtifacts = [],
} = {}) {
  let nextId = 0;
  const resources = [];
  const preparedAgentCredentials = [];
  const provider = {
    async acquire({ role, apiKey }) {
      const resource = {
        id: `${role}-${++nextId}`,
        sandboxId: `sandbox-${role}-${nextId}`,
        role,
        apiKey,
        disposed: false,
      };
      resources.push(resource);
      events.push(`acquire:${role}`);
      return resource;
    },
    async stage(_workload, input) {
      events.push("stage:workload");
      assert.equal(input.fixtures.length, expectedFixtureCount);
    },
    async run(_workload, { launchPlan, environment, onStdout, onStderr }) {
      events.push("run:workload");
      assert.equal(environment.TOGETHER_API_KEY.startsWith("tae_visible_"), true);
      assert.notEqual(environment.TOGETHER_API_KEY, secret);
      assert.equal(launchPlan.env.TOGETHER_API_KEY, undefined);
      if (onRun) await onRun({ launchPlan, environment });
      else assert.equal(environment.ADAPTER_AUTH, "adapter-secret");
      for (const name of ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR"]) {
        assert.equal(environment[name], undefined);
      }
      onStdout(controllerStdout);
      if (controllerStderr) onStderr(controllerStderr);
      const now = new Date().toISOString();
      return {
        exitCode: processExitCode,
        signal: null,
        timedOut: false,
        spawnError: null,
        quiescent: true,
        startedAt: now,
        endedAt: now,
        durationMs: processDurationMs,
      };
    },
    async collectArtifacts(_workload, declarations) {
      events.push("collect:artifacts");
      return declarations.map((declaration) => {
        const bytes = artifactBytesFor
          ? artifactBytesFor(declaration)
          : Buffer.from("89504e470d0a1a0a", "hex");
        return bytes === null
          ? { ...declaration, status: "missing", reason: "not-created" }
          : {
              ...declaration,
              status: "captured",
              bytes,
              sizeBytes: bytes.byteLength,
              sha256: `sha256:${"0".repeat(64)}`,
              capturedAt: new Date().toISOString(),
            };
      });
    },
    async collectWorkspaceArtifactMetadata() {
      events.push("collect:workspace-artifact-metadata");
      return structuredClone(workspaceArtifacts);
    },
    async dispose(resource) {
      events.push(`dispose:${resource.role}`);
      resource.disposed = true;
    },
    async isDisposed(resource) {
      return resource.disposed;
    },
  };
  const guardian = {
    async prepare({ capture, credentialBindings, credentialValues, surrogates, agentCredentials }) {
      events.push("prepare:guardian");
      preparedAgentCredentials.push(...structuredClone(agentCredentials));
      assert.equal(capture.mode, "network-egress-metadata-v1");
      assert.deepEqual(capture.protocols, expectedCaptureProtocols);
      assert.deepEqual(capture.routes.map(({ host }) => host), [
        "api.together.ai",
        "api.together.xyz",
      ]);
      assert.equal(credentialValues.TOGETHER_API_KEY, secret);
      assert.deepEqual(Object.keys(credentialValues), ["TOGETHER_API_KEY"]);
      assert.equal(credentialBindings.length, 1);
      assert.equal(credentialBindings[0].delivery.kind, "captured-http-header");
      assert.notEqual(surrogates.TOGETHER_API_KEY, secret);
      return { id: "guardian-session", workloadEnvironment: { HTTPS_PROXY: "http://relay" } };
    },
    async attach() {
      events.push("attach:guardian");
    },
    async seal() {
      events.push("seal:guardian");
      const observedAt = new Date().toISOString();
      return {
        status: "captured",
        requests: egressEvents ?? (egressRequests ?? [
          ["POST", "/v1/chat/completions"],
          ["POST", "/v1/images/generations"],
          ["POST", "/v1/audio/transcriptions"],
        ]).map(([method, path], sequence) => ({
          kind: "http-request",
          sequence,
          observedAt,
          method,
          scheme: "https",
          host: "api.together.ai",
          path,
          statusCode: 200,
          durationMs: 1,
          selectedFields: {},
        })),
        provenance: {
          producer: "e2b-guardian",
          authority: "environment",
          lifecyclePhase: "execution",
          capturedAt: observedAt,
          trust: "environment-observed",
        },
      };
    },
  };
  return { guardian, provider, resources, preparedAgentCredentials };
}

test("E2B runs one canonical cell with Guardian-only Target credentials and terminal disposal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-environment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const events = [];
  const secret = "e2b-target-secret";
  const runtime = controlledRuntime(events, secret);
  const progressEvents = [];
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
    entropy: () => "fixed-surrogate-entropy",
    progressObserver: { observe(event) { progressEvents.push(event); } },
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  assert.deepEqual(environment.capabilities, [
    "environment.isolated-workspace",
    "environment.trusted-egress-capture",
    "environment.trusted-request-blocking",
    "environment.exclusive-resources",
    "environment.fixed-workspace-layout",
    "environment.workspace-artifact-metadata",
  ]);
  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: secret },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.verdict, "pass", JSON.stringify(record.verdictReasons));
  assert.deepEqual(events, [
    "acquire:capture",
    "prepare:guardian",
    "acquire:execution",
    "attach:guardian",
    "stage:workload",
    "run:workload",
    "seal:guardian",
    "collect:artifacts",
    "dispose:execution",
    "dispose:capture",
  ]);
  assert.ok(runtime.resources.every(({ apiKey, disposed }) => (
    apiKey === "e2b-test-key" && disposed
  )));
  assert.deepEqual(progressEvents.filter(event => event.kind === "environment-resource-allocated"), [
    {
      kind: "environment-resource-allocated",
      executionId: result.runs[0].id,
      environmentId: "e2b",
      resource: { provider: "e2b", role: "guardian", id: "sandbox-capture-1" },
    },
    {
      kind: "environment-resource-allocated",
      executionId: result.runs[0].id,
      environmentId: "e2b",
      resource: { provider: "e2b", role: "agent", id: "sandbox-execution-2" },
    },
  ]);
  assert.deepEqual(progressEvents.filter(event => event.kind === "environment-status").map(event => event.status), [
    "starting-guardian", "guardian-started", "starting-sandbox", "sandbox-started",
    "preparing-environment", "preparing-workspace", "agent-running", "collecting-results", "stopping-sandboxes",
  ]);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  assert.equal(record.evidence.egress[0].provenance.producer, "e2b-guardian");
  // An adapter without credential routes keeps environment delivery.
  assert.deepEqual(runtime.preparedAgentCredentials, []);
});

for (const [authName, credential, standInPrefix] of [
  ["ANTHROPIC_API_KEY", "sk-ant-api03-fixture-claude-agent-key", "sk-ant-api03-"],
  ["CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-fixture-claude-agent-token", "sk-ant-oat01-"],
]) {
  test(`E2B keeps Claude Code's ${authName} in the Guardian and gives the Agent a stand-in`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "tae-claude-e2b-agent-credential-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pack = await togetherRunPlan();
    const store = await openLocalResultStore({ root: join(root, "results") });
    const target = "faketarget-77c1-together";
    let observedRun = null;
    const runtime = controlledRuntime([], target, {
      onRun(value) {
        observedRun = value;
      },
    });
    const environment = createE2BExecutionEnvironment({
      apiKey: "claude-e2b-provider-secret",
      provider: runtime.provider,
      guardian: runtime.guardian,
      entropy: () => "claude-e2b-entropy",
    });
    const engine = createRunEngine({
      resultStore: store,
      agentAdapter: createClaudeCodeAdapter({
        runtimeEnv: { PATH: "/controller-only/bin", [authName]: credential },
      }),
      executionEnvironment: environment,
    });

    const result = await engine.run({
      runPlan: pack,
      taskIds: ["chat-app"],
      conditionIds: ["baseline"],
      credentials: { TOGETHER_API_KEY: target },
    });

    assert.notEqual(result.status, "invalid", JSON.stringify(result));
    assert.ok(observedRun);
    const standIn = `${standInPrefix}claude-e2b-entropy`;
    assert.equal(observedRun.environment[authName], standIn);
    assert.doesNotMatch(JSON.stringify(observedRun.environment), new RegExp(credential));
    assert.equal(observedRun.environment.TOGETHER_API_KEY, "tae_visible_claude-e2b-entropy");
    assert.deepEqual(runtime.preparedAgentCredentials, [{
      environmentName: authName,
      surrogate: standIn,
      value: credential,
      hosts: ["api.anthropic.com"],
      headerNames: ["x-api-key", "authorization"],
    }]);
    const record = await store.getRun(result.runs[0].id);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(credential));
  });
}

test("E2B keeps an advisory Task's API key in the Guardian too", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-advisory-task-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  for (const task of Object.values(pack.definition.tasks)) {
    // Undo the test helper's capture override: authoring delivers an advisory
    // Suite's key through the environment.
    delete task.credentialDeliveryOverrides;
    task.egress.captureMode = "optional";
    task.executionRequirements = ["environment.isolated-workspace"];
  }
  const secret = "advisory-target-secret";
  const runtime = controlledRuntime([], secret);
  const engine = createRunEngine({
    resultStore: await openLocalResultStore({ root: join(root, "results") }),
    agentAdapter: controlledAdapter(),
    executionEnvironment: createE2BExecutionEnvironment({
      apiKey: "e2b-test-key",
      provider: runtime.provider,
      guardian: runtime.guardian,
      entropy: () => "advisory-entropy",
    }),
  });
  assert.deepEqual(
    pack.definition.credentialRequirements.TOGETHER_API_KEY.delivery,
    { kind: "environment" },
    "the Suite declares environment delivery",
  );

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: secret },
  });

  // controlledRuntime asserts the Guardian receives a captured binding with
  // the real value and the workload a tae_visible_ stand-in.
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(result.runs[0].verdict, "pass", JSON.stringify(result.runs[0]));
});

test("E2B refuses a Task credential it has no API hosts to carry, before allocation", async () => {
  let allocations = 0;
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.acquire = async () => {
    allocations += 1;
    throw new Error("must not allocate");
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  await assert.rejects(environment.execute({
    capture: { mode: "none" },
    workspaceArtifactMetadata: false,
    credentialBindings: [{
      environmentName: "TARGET_API_KEY",
      delivery: { kind: "environment" },
    }],
    launchPlan: { command: "agent", env: {} },
  }), (error) => (
    /^E2B sandboxes receive credentials only through the Guardian; the Suite declares no API hosts to carry TARGET_API_KEY$/
      .test(error.message)
    && error.operatorReason === error.message
  ));
  assert.equal(allocations, 0);
});

test("E2B rejects malformed Agent credential routes before provider allocation", async () => {
  let allocations = 0;
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.acquire = async () => {
    allocations += 1;
    throw new Error("must not allocate");
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });

  for (const credentialRoutes of [
    [{ environmentName: "MISSING_KEY", hosts: ["api.example.com"], headerNames: ["authorization"] }],
    [{ environmentName: "AGENT_KEY", hosts: ["API.EXAMPLE.COM"], headerNames: ["authorization"] }],
    [{ environmentName: "AGENT_KEY", hosts: ["api.example.com"], headerNames: [] }],
    [{ environmentName: "AGENT_KEY", hosts: ["api.example.com"], headerNames: ["authorization"], extra: true }],
  ]) {
    await assert.rejects(environment.execute({
      capture: { mode: "none" },
      workspaceArtifactMetadata: false,
      credentialBindings: [],
      launchPlan: { command: "agent", env: { AGENT_KEY: "agent-secret" }, credentialRoutes },
    }), /Agent credential routes are invalid/);
  }
  assert.equal(allocations, 0);
});

test("Codex composes with E2B through the canonical Together path", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-codex-e2b-success-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const secrets = {
    // Credentials must not share their leading bytes with ordinary session IDs:
    // that diagnostic prefix is intentionally redacted just like a printed key.
    codex: "fakeauth-42b7-codex-agent",
    e2b: "codex-e2b-provider-secret",
    target: "faketarget-5a21-together",
  };
  const controllerStdout = [
    { type: "thread.started", thread_id: "codex-e2b-thread" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: `auth=${secrets.codex}` },
    },
    {
      type: "item.completed",
      item: { type: "command_execution", command: "node app.mjs" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_output_tokens: 2,
      },
    },
  ].map((frame) => JSON.stringify(frame)).join("\n") + "\n";
  const events = [];
  let observedRun = null;
  const runtime = controlledRuntime(events, secrets.target, {
    controllerStdout,
    controllerStderr: `codex diagnostic auth=${secrets.codex}\n`,
    onRun(value) {
      observedRun = value;
    },
  });
  const environment = createE2BExecutionEnvironment({
    apiKey: secrets.e2b,
    provider: runtime.provider,
    guardian: runtime.guardian,
    entropy: () => "codex-e2b-surrogate",
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createCodexAdapter({
      runtimeEnv: {
        PATH: "/controller-only/bin",
        HOME: "/controller-only/home",
        OPENAI_API_KEY: secrets.codex,
      },
      command: "codex",
      timeoutMs: 5_000,
    }),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: secrets.target },
    environmentSettings: {
      workloadTemplate: "caller/tae-codex:v1",
      cpuCount: 2,
      memoryMiB: 2_048,
    },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.deepEqual(result.summary.terminalVerdicts, {
    pass: 1,
    fail: 0,
    incomplete: 0,
    unknown: 0,
  });
  const record = await store.getRun(result.runs[0].id);
  const history = await store.getRunHistory(record.id);
  assert.deepEqual(
    history.map(({ revision, state, verdict }) => ({ revision, state, verdict })),
    [
      { revision: 0, state: "queued", verdict: null },
      { revision: 1, state: "running", verdict: null },
      { revision: 2, state: "complete", verdict: "pass" },
    ],
  );
  assert.equal(record.judgeStatus, "not_requested");
  assert.equal(record.snapshot.target.id, "api-target");
  assert.equal(record.snapshot.task.id, "chat-app");
  assert.equal(record.snapshot.condition.id, "baseline");
  assert.equal(record.snapshot.agent.adapterId, "codex");
  assert.equal(record.snapshot.environment.environmentId, "e2b");
  assert.deepEqual(record.snapshot.environment.settings, {
    captureProfile: "external-guardian-http-metadata-v1",
    workloadTemplate: "caller/tae-codex:v1",
    guardianTemplate: "base",
    region: null,
    cpuCount: 2,
    memoryMiB: 2_048,
    maxLifetimeMs: 3_600_000,
  });
  assert.ok(observedRun);
  assert.equal(observedRun.launchPlan.command, "codex");
  assert.deepEqual(observedRun.launchPlan.args, [
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
    "-",
  ]);
  assert.match(observedRun.launchPlan.stdin, /Build a CLI tool/);
  // The real Codex key stays with the Guardian; the Agent's VM sees a stand-in.
  assert.equal(
    observedRun.environment.CODEX_API_KEY,
    "codex-e2b-surrogate",
  );
  assert.doesNotMatch(JSON.stringify(observedRun.environment), new RegExp(secrets.codex));
  assert.deepEqual(runtime.preparedAgentCredentials, [{
    environmentName: "CODEX_API_KEY",
    surrogate: "codex-e2b-surrogate",
    value: secrets.codex,
    hosts: ["api.openai.com"],
    headerNames: ["authorization"],
  }]);
  assert.equal(observedRun.environment.OPENAI_API_KEY, undefined);
  assert.equal(observedRun.environment.PATH, undefined);
  assert.equal(observedRun.environment.HOME, undefined);
  assert.equal(
    observedRun.environment.TOGETHER_API_KEY,
    "tae_visible_codex-e2b-surrogate",
  );
  assert.equal(record.execution.adapterId, "codex");
  assert.equal(record.execution.environmentId, "e2b");
  assert.equal(record.execution.sessionId, "codex-e2b-thread");
  assert.equal(record.execution.exitCode, 0);
  assert.deepEqual(record.metrics.common, {
    inputTokens: 11,
    outputTokens: 7,
    reportedCostUsd: null,
    turns: 1,
    toolCalls: 1,
  });
  assert.deepEqual(record.metrics.adapters.codex, {
    toolVersions: null,
    cachedInputTokens: 3,
    reasoningOutputTokens: 2,
    completedItemsByType: {
      agent_message: 1,
      command_execution: 1,
    },
    agentMessages: 1,
    commandExecutions: 1,
    fileChanges: 0,
    mcpToolCalls: 0,
    webSearches: 0,
  });
  assert.deepEqual(
    record.checks.map(({ id, outcome, authoredAuthority, effectiveAuthority }) => ({
      id,
      outcome,
      authoredAuthority,
      effectiveAuthority,
    })),
    [
      { id: "chat-completion", outcome: "pass", authoredAuthority: "advisory", effectiveAuthority: "required" },
      { id: "image-generation", outcome: "pass", authoredAuthority: "advisory", effectiveAuthority: "required" },
      { id: "transcription", outcome: "pass", authoredAuthority: "advisory", effectiveAuthority: "required" },
    ],
  );
  assert.deepEqual(events, [
    "acquire:capture",
    "prepare:guardian",
    "acquire:execution",
    "attach:guardian",
    "stage:workload",
    "run:workload",
    "seal:guardian",
    "collect:artifacts",
    "dispose:execution",
    "dispose:capture",
  ]);
  assert.ok(runtime.resources.every(({ apiKey, disposed }) => (
    apiKey === secrets.e2b && disposed
  )));

  const transcript = await store.readEvidence(record.evidence.transcript, {
    maxBytes: 64 * 1024,
  });
  const stderr = await store.readEvidence(record.evidence.stderr, {
    maxBytes: 64 * 1024,
  });
  const egress = await store.readEvidence(record.evidence.egress[0].content, {
    maxBytes: 64 * 1024,
  });
  assert.match(transcript.toString("utf8"), /<REDACTED>/);
  assert.equal(stderr.toString("utf8"), "codex diagnostic auth=<REDACTED>\n");
  const parsedEgress = JSON.parse(egress);
  assert.equal(parsedEgress.status, "captured");
  assert.deepEqual(
    parsedEgress.requests.map(({ observedAt, ...request }) => request),
    [
      "/v1/chat/completions",
      "/v1/images/generations",
      "/v1/audio/transcriptions",
    ].map((path, sequence) => ({
      kind: "http-request",
      sequence,
      method: "POST",
      scheme: "https",
      host: "api.together.ai",
      path,
      statusCode: 200,
      durationMs: 1,
      selectedFields: {},
    })),
  );
  for (const { observedAt } of parsedEgress.requests) {
    assert.equal(new Date(observedAt).toISOString(), observedAt);
  }
  assert.deepEqual(
    {
      transcript: {
        authority: record.evidence.transcript.authority,
        producer: record.evidence.transcript.producer,
        lifecyclePhase: record.evidence.transcript.lifecyclePhase,
        provenance: record.evidence.transcript.provenance,
        trust: record.evidence.transcript.trust,
      },
      egress: record.evidence.egress[0].provenance,
    },
    {
      transcript: {
        authority: "controller",
        producer: "agent",
        lifecyclePhase: "execute",
        provenance: "controller_observed_parent_pipe",
        trust: "controller_observed",
      },
      egress: {
        producer: "e2b-guardian",
        authority: "environment",
        lifecyclePhase: "execution",
        capturedAt: record.evidence.egress[0].provenance.capturedAt,
        trust: "environment-observed",
      },
    },
  );
  const storedText = [
    JSON.stringify(record),
    JSON.stringify(history),
    transcript.toString("utf8"),
    stderr.toString("utf8"),
    egress.toString("utf8"),
  ].join("\n");
  for (const secret of Object.values(secrets)) {
    assert.doesNotMatch(storedText, new RegExp(secret));
  }
});

test("a nonzero Codex E2B process cannot pass on successful Target evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-codex-e2b-nonzero-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const codexSecret = "fakeauth-42b7-codex-failure";
  const targetSecret = "faketarget-5a21-together-failure";
  const controllerStdout = [
    { type: "thread.started", thread_id: "codex-e2b-failed-thread" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: `auth=${codexSecret}` },
    },
    { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
  ].map((frame) => JSON.stringify(frame)).join("\n") + "\n";
  const events = [];
  const runtime = controlledRuntime(events, targetSecret, {
    controllerStdout,
    processExitCode: 17,
    onRun() {},
  });
  const environment = createE2BExecutionEnvironment({
    apiKey: "codex-e2b-failure-provider-secret",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createCodexAdapter({
      runtimeEnv: { OPENAI_API_KEY: codexSecret },
      command: "codex",
      timeoutMs: 5_000,
    }),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: targetSecret },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.deepEqual(result.summary.terminalVerdicts, {
    pass: 0,
    fail: 0,
    incomplete: 1,
    unknown: 0,
  });
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.judgeStatus, "not_requested");
  assert.equal(record.execution.sessionId, "codex-e2b-failed-thread");
  assert.equal(record.execution.exitCode, 17);
  assert.deepEqual(
    record.checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-completion", outcome: "pass" },
      { id: "image-generation", outcome: "pass" },
      { id: "transcription", outcome: "pass" },
    ],
  );
  assert.ok(record.integrityIssues.some(({ code }) => (
    code === "environment.nonzero-exit"
  )));
  assert.ok(record.verdictReasons.some(({ code }) => (
    code === "environment.nonzero-exit"
  )));
  const history = await store.getRunHistory(record.id);
  assert.deepEqual(
    history.map(({ revision, state, verdict }) => ({ revision, state, verdict })),
    [
      { revision: 0, state: "queued", verdict: null },
      { revision: 1, state: "running", verdict: null },
      { revision: 2, state: "complete", verdict: "incomplete" },
    ],
  );
  assert.deepEqual(events.slice(-4), [
    "seal:guardian",
    "collect:artifacts",
    "dispose:execution",
    "dispose:capture",
  ]);
  assert.ok(runtime.resources.every(({ disposed }) => disposed));
  const transcript = await store.readEvidence(record.evidence.transcript, {
    maxBytes: 64 * 1024,
  });
  assert.match(transcript.toString("utf8"), /<REDACTED>/);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(codexSecret));
  assert.doesNotMatch(JSON.stringify(record), new RegExp(targetSecret));
});

test("E2B settings are closed, normalized, and snapshot-relevant", () => {
  const runtime = controlledRuntime([], "secret");
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });

  assert.deepEqual(environment.normalizeSettings({}), {
    captureProfile: "external-guardian-http-metadata-v1",
    workloadTemplate: "base",
    guardianTemplate: "base",
    region: null,
    cpuCount: 2,
    memoryMiB: 512,
    maxLifetimeMs: 3_600_000,
  });
  assert.throws(
    () => environment.normalizeSettings({ unknown: true }),
    /unknown E2B environment setting/,
  );
  assert.throws(
    () => environment.normalizeSettings({ region: "us-east" }),
    /region selection is not supported/,
  );
  assert.throws(
    () => environment.normalizeSettings({ captureProfile: "future-profile" }),
    /unsupported E2B capture profile/,
  );
  for (const key of ["workloadTemplate", "guardianTemplate"]) {
    assert.throws(
      () => environment.normalizeSettings({ [key]: "REPLACE_WITH_CALLER_OWNED_CLAUDE_E2B_TEMPLATE" }),
      new RegExp(`E2B ${key} is an example placeholder.*valid template`),
    );
    assert.equal(environment.normalizeSettings({ [key]: "my-agent:v2" })[key], "my-agent:v2");
  }
});

test("E2B rejects unknown credential delivery before provider allocation", async () => {
  let allocations = 0;
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.acquire = async () => {
    allocations += 1;
    throw new Error("must not allocate");
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });

  await assert.rejects(environment.execute({
    capture: { mode: "http-egress-metadata-v1", relevantHosts: ["api.example.com"] },
    workspaceArtifactMetadata: false,
    credentialBindings: [{
      environmentName: "TARGET_API_KEY",
      delivery: { kind: "unknown-mode" },
    }],
  }), /credential delivery is not supported/);
  assert.equal(allocations, 0);
});

test("E2B rejects selected-field capture before provider allocation", async () => {
  let allocations = 0;
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.acquire = async () => {
    allocations += 1;
    throw new Error("must not allocate");
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const envelope = createExecutionEnvelope({
    executionId: "selected_fields_preflight",
    settings: environment.normalizeSettings({}),
    launchPlan: {
      command: "agent",
      args: [],
      env: {},
      stdin: "",
      timeoutMs: 1_000,
      workspaceFiles: [],
    },
    fixtures: [],
    outputArtifacts: [],
    target: {
      egress: {
        relevantHosts: ["api.example.com"],
        selectedFields: ["response.id"],
      },
    },
    credentialDefinitions: [],
    credentialValues: {},
  });

  try {
    await assert.rejects(
      environment.execute(envelope),
      /selected-field capture is not supported/,
    );
  } finally {
    closeExecutionCredentialLease(envelope);
  }
  assert.equal(allocations, 0);
});

test("E2B advertises bounded exchange-fact capture", () => {
  const runtime = controlledRuntime([], "target-secret");
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });

  assert.equal(environment.captureCapabilities.exchangeFacts, true);
  assert.equal(
    environment.capabilities.includes("environment.fixed-workspace-layout"),
    true,
  );
});

test("E2B seals the bounded legacy-compatible workspace artifact inventory", async () => {
  const events = [];
  const runtime = controlledRuntime(events, "target-secret", {
    expectedFixtureCount: 0,
    expectedCaptureProtocols: ["http", "https"],
    onRun() {},
    workspaceArtifacts: [
      { path: "app.py", bytes: 321, source: "controller_capture" },
      { path: "generated.png", bytes: 654, source: "controller_capture" },
    ],
  });
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const envelope = createExecutionEnvelope({
    executionId: "workspace_metadata",
    settings: environment.normalizeSettings({}),
    launchPlan: {
      command: "agent",
      args: [],
      env: {},
      stdin: "",
      timeoutMs: 1_000,
      workspaceFiles: [],
    },
    fixtures: [],
    outputArtifacts: [],
    workspaceArtifactMetadata: true,
    target: {
      egress: {
        relevantHosts: ["api.together.ai", "api.together.xyz"],
        selectedFields: [],
      },
    },
    credentialDefinitions: [{
      name: "TOGETHER_API_KEY",
      delivery: {
        kind: "captured-http-header",
        hosts: ["api.together.ai", "api.together.xyz"],
        headerNames: ["authorization"],
      },
    }],
    credentialValues: { TOGETHER_API_KEY: "target-secret" },
  });

  try {
    const observed = await environment.execute(envelope);
    assert.deepEqual(observed.integrityIssues, []);
    assert.deepEqual(observed.workspaceArtifacts, [
      { path: "app.py", bytes: 321, source: "controller_capture" },
      { path: "generated.png", bytes: 654, source: "controller_capture" },
    ]);
    assert.equal(events.includes("collect:workspace-artifact-metadata"), true);
  } finally {
    closeExecutionCredentialLease(envelope);
  }
});

test("E2B rejects malformed exchange-fact capture before provider allocation", async () => {
  let allocations = 0;
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.acquire = async () => {
    allocations += 1;
    throw new Error("must not allocate");
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });

  await assert.rejects(environment.execute({
    capture: {
      mode: "network-egress-metadata-v1",
      protocols: ["https"],
      routes: [],
      exchangeFacts: { schemaVersion: 1, profiles: [] },
    },
    workspaceArtifactMetadata: false,
    credentialBindings: [],
  }), /exchange-fact capture is not supported/);
  assert.equal(allocations, 0);
});

test("E2B advertises bounded selected response-header capture", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-selected-fields-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolved = await togetherRunPlan();
  const runPlan = {
    ...resolved,
    definition: structuredClone(resolved.definition),
  };
  runPlan.definition.target.egress.selectedFields = ["x-cluster"];
  const runtime = controlledRuntime([], "target-secret");
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
  });

  assert.equal(environment.captureCapabilities.selectedFields, true);
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(runtime.resources.length, 2);
});

test("E2B bounds a running Agent process by its launch timeout", async () => {
  const events = [];
  const runtime = controlledRuntime(events, "target-secret", {
    processDurationMs: 20,
    expectedCaptureProtocols: ["http", "https"],
    async onRun({ launchPlan }) {
      assert.ok(launchPlan.timeoutMs <= 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const envelope = createExecutionEnvelope({
    executionId: "e2b_elapsed_limit",
    settings: environment.normalizeSettings({}),
    launchPlan: {
      command: "agent",
      args: [],
      env: {},
      stdin: "",
      timeoutMs: 10,
      workspaceFiles: [],
    },
    fixtures: [{ path: "fixture.txt", source: { kind: "generated", bytes: Buffer.from("x") } }],
    outputArtifacts: [],
    target: {
      egress: {
        relevantHosts: ["api.together.ai", "api.together.xyz"],
        selectedFields: [],
      },
    },
    credentialDefinitions: [{
      name: "TOGETHER_API_KEY",
      delivery: {
        kind: "captured-http-header",
        hosts: ["api.together.ai", "api.together.xyz"],
        headerNames: ["authorization"],
      },
    }],
    credentialValues: { TOGETHER_API_KEY: "target-secret" },
  });

  try {
    const observed = await environment.execute(envelope);
    assert.ok(observed.integrityIssues.some(
      ({ code }) => code === "environment.agent-elapsed-limit",
    ));
  } finally {
    closeExecutionCredentialLease(envelope);
  }
});

test("E2B cancellation during allocation disposes a late resource", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-late-allocation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const controller = new AbortController();
  let resolveAllocation;
  const resource = { role: "capture", sandboxId: "unsafe\nidentifier", disposed: false };
  const progressEvents = [];
  const provider = {
    acquire() {
      return new Promise((resolve) => {
        resolveAllocation = () => resolve(resource);
      });
    },
    async dispose(value) {
      value.disposed = true;
    },
    async isDisposed(value) {
      return value.disposed;
    },
    async stage() {},
    async run() {},
    async collectArtifacts() {},
  };
  const guardian = {
    async prepare() {
      throw new Error("must not prepare after cancellation");
    },
    async attach() {},
    async seal() {},
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider,
    guardian,
    progressObserver: { observe(event) { progressEvents.push(event); } },
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  const pending = engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
    signal: controller.signal,
  });
  while (!resolveAllocation) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resolveAllocation();
  const result = await pending;

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(resource.disposed, true);
  assert.deepEqual(progressEvents.map(event => event.status), ["starting-guardian", "stopping-sandboxes"]);
  assert.ok(progressEvents.every(event => event.kind === "environment-status"));
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.verdict, "incomplete");
  assert.ok(record.integrityIssues.some(({ code }) => code === "environment.cancelled"));
});

test("E2B maps an abort-driven provider rejection to cancellation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-abort-rejection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.acquire = async () => {
    const error = new Error("provider abort details");
    error.name = "AbortError";
    throw error;
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
  });

  const record = await store.getRun(result.runs[0].id);
  assert.deepEqual(record.integrityIssues.map(({ code }) => code), [
    "environment.cancelled",
  ]);
  assert.doesNotMatch(JSON.stringify(record), /provider abort details/);
});

test("E2B process non-quiescence blocks execution retries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-not-quiescent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const runtime = controlledRuntime([], "target-secret");
  const originalRun = runtime.provider.run;
  runtime.provider.run = async (...args) => ({
    ...await originalRun(...args),
    quiescent: false,
  });
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
    retries: 1,
  });

  assert.equal(result.runs.length, 1);
  const record = await store.getRun(result.runs[0].id);
  assert.ok(record.integrityIssues.some(({ code }) => (
    code === "environment.not-quiescent"
  )));
  assert.equal(record.invocation.retryTrigger, null);
});

test("partial E2B acquisition disposes acquired resources and closes an incomplete record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-partial-acquire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const resources = [];
  const progress = [];
  const provider = {
    async acquire({ role }) {
      if (role === "execution") throw new Error("provider allocation details");
      const resource = { role, disposed: false };
      resources.push(resource);
      return resource;
    },
    async dispose(resource) {
      resource.disposed = true;
    },
    async isDisposed(resource) {
      return resource.disposed;
    },
    async stage() {},
    async run() {},
    async collectArtifacts() {},
  };
  const guardian = {
    async prepare() {
      return { workloadEnvironment: {} };
    },
    async attach() {},
    async seal() {},
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider,
    guardian,
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
    progressObserver: { observe(event) { progress.push(event); } },
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.ok(resources.every(({ disposed }) => disposed));
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.ok(record.integrityIssues.some(({ code }) => (
    code === "environment.acquire-failed"
  )));
  assert.equal(record.execution.exitCode, null);
  assert.equal(record.evidence.egress.length, 1);
  assert.equal(record.evidence.egress[0].status, "unavailable");
  assert.equal(record.evidence.egress[0].provenance.producer, "e2b-guardian");
  assert.doesNotMatch(JSON.stringify(record), /provider allocation details/);
  const expectedReasons = record.verdictReasons.map(({ code, summary }) => ({ code, summary }));
  assert.deepEqual(result.summary.nonPasses[0].verdictReasons, expectedReasons);
  assert.deepEqual(progress.at(-1).terminal.verdictReasons, expectedReasons);
  assert.doesNotMatch(JSON.stringify(progress), /provider allocation details/);
});

test("E2B capacity validation fails inside the disposal boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-capacity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const events = [];
  const runtime = controlledRuntime(events, "target-secret");
  runtime.provider.validate = async () => {
    throw new Error("unexpected E2B capacity details");
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.ok(runtime.resources.every(({ disposed }) => disposed));
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.verdict, "incomplete");
  assert.ok(record.integrityIssues.some(({ code }) => (
    code === "environment.acquire-failed"
  )));
  assert.doesNotMatch(JSON.stringify(record), /unexpected E2B capacity details/);
});

test("E2B disposal failure is a terminal integrity issue", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-e2b-dispose-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = await togetherRunPlan();
  const store = await openLocalResultStore({ root: join(root, "results") });
  const runtime = controlledRuntime([], "target-secret");
  runtime.provider.dispose = async (resource) => {
    if (resource.role === "capture") throw new Error("provider delete details");
    resource.disposed = true;
  };
  const environment = createE2BExecutionEnvironment({
    apiKey: "e2b-test-key",
    provider: runtime.provider,
    guardian: runtime.guardian,
  });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: controlledAdapter(),
    executionEnvironment: environment,
  });

  const result = await engine.run({
    runPlan: pack,
    taskIds: ["chat-app"],
    conditionIds: ["baseline"],
    credentials: { TOGETHER_API_KEY: "target-secret" },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.verdict, "incomplete");
  assert.ok(record.integrityIssues.some(({ code }) => (
    code === "environment.dispose-failed"
  )));
  assert.doesNotMatch(JSON.stringify(record), /provider delete details/);
});
