import assert from "node:assert/strict";
import test from "node:test";
import {
  createExecutionEnvelope,
  closeExecutionCredentialLease,
} from "../lib/execution-envelope.mjs";
import {
  agentCredentialSurrogate,
  createTogetherExecutionEnvironment,
  normalizeTogetherSettings,
} from "../lib/execution-environments/together.mjs";
import {
  resolveRuntimeProfile,
  resolveRuntimeSecrets,
} from "../lib/runtime-profile.mjs";
import { createRuntimeConfig } from "../lib/runtime-init.mjs";

function envelope(options = {}) {
  return createExecutionEnvelope({
    executionId: "controlled-run",
    settings: {},
    launchPlan: {
      command: "agent",
      env: {
        PATH: "/host",
        HOME: "/host-home",
        AGENT_KEY: "explicit-agent-auth",
      },
      timeoutMs: 1000,
    },
    fixtures: [],
    outputArtifacts: [
      { path: "result.txt", kind: "text", maxBytes: 100, required: true },
    ],
    target: {},
    credentialDefinitions: [],
    credentialValues: {},
    ...options,
  });
}
function sealedCollection() {
  return {
    status: "captured",
    requests: [],
    provenance: {
      producer: "together-host-guardian",
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: new Date().toISOString(),
      trust: "environment-observed",
    },
  };
}
function stubGuardian() {
  return {
    async prepare() { return { workloadEnvironment: {} }; },
    async attach() {},
    async seal() { return sealedCollection(); },
  };
}
function fixture(options = {}) {
  const events = [];
  const guardian = options.guardian ?? {
    async prepare({ sandbox }) {
      // The Guardian runs on the controller host, not in a sandbox.
      assert.equal(sandbox, undefined);
      events.push("guardian:prepare");
      return { workloadEnvironment: {} };
    },
    async attach() { events.push("guardian:attach"); },
    async seal() { events.push("guardian:seal"); return sealedCollection(); },
    close(session) { if (session) events.push("guardian:close"); },
  };
  const provider = {
    async acquire() {
      events.push("acquire");
      return { sandboxId: "controlled-sandbox" };
    },
    async stage() {
      events.push("stage");
    },
    async run(_resource, { environment, onStdout }) {
      events.push("run");
      assert.equal(environment.PATH, undefined);
      assert.equal(environment.HOME, undefined);
      assert.equal(environment.AGENT_KEY, "explicit-agent-auth");
      onStdout("controller transcript\n");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        quiescent: true,
        spawnError: null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1,
      };
    },
    async collectArtifacts() {
      events.push("collect");
      return [];
    },
    async dispose() {
      events.push("dispose");
    },
    async isDisposed() {
      events.push("confirm");
      return true;
    },
    ...options,
  };
  return {
    events,
    provider,
    environment: createTogetherExecutionEnvironment({
      apiKey: "provider-secret",
      provider,
      guardian,
    }),
  };
}
test("Together runs with controller evidence and a confirmed disposal barrier", async () => {
  const f = fixture();
  const result = await f.environment.execute(envelope());
  assert.deepEqual(f.events, [
    "guardian:prepare",
    "acquire",
    "guardian:attach",
    "stage",
    "run",
    "guardian:seal",
    "collect",
    "guardian:close",
    "dispose",
    "confirm",
  ]);
  assert.equal(result.process.stdout.text, "controller transcript\n");
  assert.equal(result.process.exitCode, 0);
  assert.deepEqual(result.integrityIssues, []);
  // Tasks without capture hosts still journal all egress for diagnosis.
  assert.equal(result.egressCollections[0].status, "captured");
  assert.ok(
    f.environment.capabilities.includes("environment.trusted-egress-capture"),
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /provider-secret|explicit-agent-auth/,
  );
});
test("Together rejects invalid credential scopes before allocation", async () => {
  const f = fixture();
  for (const input of [
    envelope({
      credentialDefinitions: [
        { name: "KEY", delivery: { kind: "captured-http-header" } },
      ],
      credentialValues: { KEY: "test" },
    }),
  ]) {
    try {
      await assert.rejects(
        f.environment.execute(input),
        /credential delivery is not supported/,
      );
    } finally {
      closeExecutionCredentialLease(input);
    }
  }
  assert.deepEqual(f.events, []);
});
test("Together disposes resources returned after cancellation during allocation", async () => {
  let allocated;
  let acquiring;
  const acquireCalled = new Promise((resolve) => { acquiring = resolve; });
  const controller = new AbortController();
  const f = fixture({
    acquire: () =>
      new Promise((resolve) => {
        allocated = resolve;
        acquiring();
      }),
  });
  const pending = f.environment.execute(
    envelope({ signal: controller.signal }),
  );
  await acquireCalled;
  controller.abort();
  allocated({ sandboxId: "late-resource" });
  const result = await pending;
  assert.deepEqual(f.events, ["guardian:prepare", "guardian:close", "dispose", "confirm"]);
  assert.equal(result.integrityIssues[0].code, "environment.cancelled");
});
test("Together failure and non-quiescence never produce a passing artifact capture", async () => {
  for (const mode of ["stage", "quiescence", "disposal"]) {
    const options =
      mode === "stage"
        ? {
            stage: async () => {
              throw new Error("secret provider diagnostic");
            },
          }
        : mode === "quiescence"
          ? { run: async () => ({ quiescent: false, durationMs: 1 }) }
          : {
              dispose: async () => {
                throw new Error("secret provider diagnostic");
              },
            };
    const f = fixture(options);
    const result = await f.environment.execute(envelope());
    assert.ok(result.integrityIssues.length);
    if (mode !== "disposal") assert.ok(!f.events.includes("collect"));
    assert.doesNotMatch(JSON.stringify(result), /secret provider diagnostic/);
  }
});
test("Together rejects pre-cancelled execution without allocating and closes its credential lease", async () => {
  const controller = new AbortController();
  controller.abort();
  const input = envelope({ signal: controller.signal });
  const f = fixture();
  assert.equal(
    (await f.environment.execute(input)).integrityIssues[0].code,
    "environment.cancelled",
  );
  assert.deepEqual(f.events, []);
  await assert.rejects(
    f.environment.execute(input),
    /credential lease is unavailable/,
  );
});
test("Together retries transient termination confirmation without invalidating a completed run", async () => {
  let confirmations = 0;
  const f = fixture({ async isDisposed() {
    if (++confirmations === 1) throw Object.assign(Error("synthetic service failure"), { status: 503 });
    return true;
  } });
  const result = await f.environment.execute(envelope());
  assert.equal(confirmations, 2);
  assert.deepEqual(result.integrityIssues, []);
  assert.equal(result.process.exitCode, 0);
});
test("Together capture overflow remains visible to Run Trust", async () => {
  const f = fixture();
  const environment = createTogetherExecutionEnvironment({
    apiKey: "provider",
    provider: f.provider,
    guardian: {
      async prepare() { return {}; }, async attach() {},
      async seal() { return sealedCollection(); },
    },
    captureMaxBytes: 1,
  });
  const result = await environment.execute(envelope());
  assert.equal(result.process.captureOverflow, true);
  assert.equal(result.process.stdout.complete, false);
});

test("the environment refuses an environment credential with no API hosts to carry it, with a reason", async () => {
  const provider = { ...fixture().provider, async acquire() { throw new Error("must not allocate"); } };
  const guardian = { async prepare() { throw new Error("must not start"); }, async attach() {}, async seal() {} };
  const environment = createTogetherExecutionEnvironment({ apiKey: "provider", provider, guardian });
  await assert.rejects(environment.execute(envelope({
    credentialDefinitions: [{ name: "KEY", delivery: { kind: "environment" } }],
    credentialValues: { KEY: "real-target-secret" },
  })), (error) => /no API hosts to carry KEY/.test(error.message) && error.operatorReason === error.message);
});

test("the environment delivers an environment credential through the Guardian on the task's API hosts", async () => {
  const seen = {};
  const provider = {
    ...fixture().provider,
    async run(_resource, { environment }) { seen.workloadKey = environment.KEY; return { exitCode: 0, quiescent: true, durationMs: 1 }; },
  };
  const guardian = {
    async prepare({ credentialBindings, credentialValues, surrogates }) {
      seen.binding = credentialBindings.find(({ environmentName }) => environmentName === "KEY");
      seen.realValue = credentialValues.KEY;
      seen.surrogate = surrogates.KEY;
      return {};
    },
    async attach() {},
    async seal() { return sealedCollection(); },
  };
  const environment = createTogetherExecutionEnvironment({ apiKey: "provider", provider, guardian });
  const result = await environment.execute(envelope({
    target: { egress: { relevantHosts: ["api.example.com"], selectedFields: [] } },
    credentialDefinitions: [{ name: "KEY", delivery: { kind: "environment" } }],
    credentialValues: { KEY: "real-target-secret" },
  }));
  assert.deepEqual(seen.binding.delivery, { kind: "captured-http-header", hosts: ["api.example.com"], headerNames: ["authorization"] });
  assert.equal(seen.realValue, "real-target-secret");
  assert.match(seen.surrogate, /^tae_surrogate_/);
  assert.equal(seen.workloadKey, seen.surrogate);
  assert.deepEqual(result.integrityIssues, []);
});

function capturedEnvelope(options = {}) {
  return envelope({ target: { egress: { relevantHosts: ["api.example.com"], selectedFields: [] } },
    credentialDefinitions: [{ name: "KEY", delivery: { kind: "captured-http-header", hosts: ["api.example.com"], headerNames: ["authorization"] } }],
    credentialValues: { KEY: "real-target-secret" }, ...options });
}

test("Together API execution keeps target secrets in the host Guardian and disposes its one sandbox after sealing", async () => {
  const calls = [], progress = [];
  const provider = {
    async acquire() { calls.push("acquire"); return { sandboxId: "execution" }; },
    async stage() { calls.push("stage"); },
    async run(_resource, { environment }) {
      calls.push("run");
      assert.match(environment.KEY, /^tae_surrogate_/);
      assert.notEqual(environment.KEY, "real-target-secret");
      assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:18082");
      return { exitCode: 0, quiescent: true, durationMs: 1 };
    },
    async collectArtifacts() { calls.push("artifacts"); return []; },
    async dispose(resource) { calls.push(`dispose:${resource.sandboxId}`); },
    async isDisposed() { return true; },
  };
  const guardian = {
    async prepare({ credentialValues, surrogates }) {
      calls.push("prepare");
      assert.equal(credentialValues.KEY, "real-target-secret");
      assert.match(surrogates.KEY, /^tae_surrogate_/);
      return { workloadEnvironment: { HTTPS_PROXY: "http://127.0.0.1:18082" } };
    },
    async attach() { calls.push("attach"); },
    async seal() { calls.push("seal"); return sealedCollection(); },
  };
  const environment = createTogetherExecutionEnvironment({ apiKey: "management-secret", provider, guardian, progressObserver: { observe: event => progress.push(event) } });
  const result = await environment.execute(capturedEnvelope());
  assert.deepEqual(calls, ["prepare", "acquire", "attach", "stage", "run", "seal", "artifacts", "dispose:execution"]);
  assert.deepEqual(progress.filter(event => event.kind === "environment-resource-allocated").map(event => event.resource.role), ["agent"]);
  assert.deepEqual(progress.filter(event => event.kind === "environment-status").map(event => event.status), [
    "starting-guardian", "guardian-started", "starting-sandbox", "sandbox-started",
    "preparing-environment", "preparing-workspace", "agent-running", "collecting-results", "stopping-sandboxes",
  ]);
  assert.equal(result.egressCollections[0].status, "captured");
  assert.deepEqual(result.integrityIssues, []);
  assert.doesNotMatch(JSON.stringify(result), /real-target-secret|management-secret|tae_surrogate_/);
});

test("Together capture setup, sealing, cancellation and disposal failures retain incomplete evidence and clean up each allocated resource", async () => {
  for (const mode of ["prepare", "seal", "late-cancel", "dispose", "relay-close"]) {
    const calls = [], progress = [], controller = new AbortController();
    const provider = {
      async acquire() { calls.push("acquire"); if (mode === "late-cancel") controller.abort(); return { sandboxId: "execution" }; },
      async stage() {}, async run() { return { exitCode: 0, quiescent: true, durationMs: 1 }; },
      async collectArtifacts() { return []; },
      async dispose(resource) { calls.push(`dispose:${resource.sandboxId}`); if (mode === "dispose" && resource.sandboxId === "execution") throw new Error("private diagnostic"); },
      async isDisposed() { return true; },
    };
    const guardian = {
      async prepare() { if (mode === "prepare") throw new Error("private diagnostic"); return {}; },
      close() { if (mode === "relay-close") throw new Error("private diagnostic"); },
      async attach() {}, async seal() { if (mode === "seal") throw new Error("private diagnostic"); return { status: "captured", requests: [] }; },
    };
    const environment = createTogetherExecutionEnvironment({ apiKey: "management-secret", provider, guardian, progressObserver: { observe: event => progress.push(event) } });
    const result = await environment.execute(capturedEnvelope({ signal: controller.signal }));
    assert.ok(result.integrityIssues.length, mode);
    if (mode === "prepare") assert.ok(!progress.some(event => event.status === "guardian-started"), mode);
    if (["prepare", "late-cancel"].includes(mode)) {
      assert.ok(!progress.some(event => event.status === "agent-running"), mode);
    }
    if (mode === "prepare") {
      // No sandbox is allocated when the host Guardian cannot start.
      assert.deepEqual(calls, [], mode);
      assert.equal(progress.at(-1).status, "starting-guardian", mode);
    } else {
      assert.equal(progress.at(-1).status, "stopping-sandboxes", mode);
      assert.ok(calls.includes("dispose:execution"), mode);
    }
    if (!["dispose", "relay-close"].includes(mode)) assert.equal(result.egressCollections[0].status, "unavailable", mode);
    assert.doesNotMatch(JSON.stringify(result), /private diagnostic|real-target-secret|management-secret/);
  }
});
test("Together keeps the Agent's model credentials on the host and gives the workload surrogates", async () => {
  const realToken = "sk-ant-oat01-real-agent-token-value";
  let prepared, launched;
  const f = fixture({
    guardian: {
      async prepare(input) { prepared = input; return { workloadEnvironment: {} }; },
      async attach() {},
      async seal() { return sealedCollection(); },
    },
    async run(_resource, { environment }) {
      launched = environment;
      return { exitCode: 0, quiescent: true, durationMs: 1 };
    },
  });
  const result = await f.environment.execute(envelope({
    launchPlan: { command: "agent", env: { CLAUDE_CODE_OAUTH_TOKEN: realToken }, timeoutMs: 1000 },
  }));
  assert.match(launched.CLAUDE_CODE_OAUTH_TOKEN, /^sk-ant-oat01-[A-Za-z0-9_-]{43}$/);
  assert.notEqual(launched.CLAUDE_CODE_OAUTH_TOKEN, realToken);
  assert.ok(!JSON.stringify(launched).includes("real-agent-token"), "the workload never receives the real token");
  assert.deepEqual(prepared.agentCredentials, [{
    environmentName: "CLAUDE_CODE_OAUTH_TOKEN",
    value: realToken,
    surrogate: launched.CLAUDE_CODE_OAUTH_TOKEN,
    hosts: ["api.anthropic.com"],
    headerNames: ["authorization"],
  }]);
  assert.doesNotMatch(JSON.stringify(result), /real-agent-token/);
});

test("Agent credential surrogates keep non-secret shape but none of the secret", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJhY2NvdW50IjoiYSJ9.c2lnbmF0dXJlLXNlY3JldA";
  const surrogate = agentCredentialSurrogate(jwt);
  assert.match(surrogate, /^eyJhbGciOiJSUzI1NiJ9\.eyJhY2NvdW50IjoiYSJ9\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!surrogate.endsWith("c2lnbmF0dXJlLXNlY3JldA"));
  assert.match(agentCredentialSurrogate("sk-proj-abcdef"), /^sk-proj-[A-Za-z0-9_-]{43}$/);
  assert.match(agentCredentialSurrogate("opaque"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(agentCredentialSurrogate("sk-ant-api03-secret"), /^sk-ant-api03-[A-Za-z0-9_-]{43}$/);
  assert.match(agentCredentialSurrogate("agent-auth-secret-value"), /^[A-Za-z0-9_-]{43}$/, "unknown prefixes may be secret");
  assert.notEqual(agentCredentialSurrogate("sk-x"), agentCredentialSurrogate("sk-x"));
});

test("Together seal failure is incomplete only for tasks with capture hosts", async () => {
  for (const captured of [false, true]) {
    const f = fixture({ guardian: {
      async prepare() { return {}; }, async attach() {},
      async seal() { throw new Error("private diagnostic"); },
    } });
    const result = await f.environment.execute(captured ? capturedEnvelope() : envelope());
    assert.equal(result.egressCollections[0].status, "unavailable");
    assert.deepEqual(result.integrityIssues.map(({ code }) => code),
      captured ? ["environment.egress-seal-failed"] : [], String(captured));
  }
});

test("Together settings allow only a lifetime within Together's 1-hour limit", () => {
  for (const settings of [
    { maxLifetimeMs: 0 },
    { maxLifetimeMs: 999 },
    { maxLifetimeMs: 3_600_001 },
    { maxLifetimeMs: 86_400_000 },
    { maxLifetimeMs: "600000" },
    { snapshotAlias: "custom@v1" },
    { snapshotId: "unsupported" },
  ])
    assert.throws(() => normalizeTogetherSettings(settings), /maxLifetimeMs|unknown Together environment setting/);
  assert.deepEqual(normalizeTogetherSettings({}), { maxLifetimeMs: 3_600_000 });
  assert.deepEqual(normalizeTogetherSettings({ maxLifetimeMs: 3_600_000 }), { maxLifetimeMs: 3_600_000 });
  assert.deepEqual(normalizeTogetherSettings({ maxLifetimeMs: 1_000 }), { maxLifetimeMs: 1_000 });
});

test("Together sizing settings are refused because Together sizes its own sandbox", () => {
  for (const [settings, pattern] of [
    [{ cpuCount: 2 }, /^Together cpuCount is not supported: Together sizes its own sandbox\. Remove cpuCount\.$/],
    [{ memoryMiB: 4096 }, /^Together memoryMiB is not supported: Together sizes its own sandbox\. Remove memoryMiB\.$/],
  ])
    assert.throws(() => normalizeTogetherSettings(settings), { name: "RunSelectionInputError", message: pattern });
  assert.throws(() => normalizeTogetherSettings({ maxLifetimeMs: 7_200_000 }), /Together ends every sandbox after 1 hour/);
});
test("Together Runtime files resolve secrets by name without persisting credentials", () => {
  const config = createRuntimeConfig("together");
  const profile = resolveRuntimeProfile(
    { cwd: "/workspace", runtimePath: "runtime.json" },
    { readFile: () => JSON.stringify(config) },
  );
  assert.equal(profile.environment.kind, "together");
  assert.deepEqual(
    resolveRuntimeSecrets(profile, { TOGETHER_API_KEY: "secret" }),
    { togetherApiKey: "secret" },
  );
  assert.doesNotMatch(JSON.stringify(profile), /"secret"/);
  assert.throws(
    () =>
      resolveRuntimeProfile(
        { cwd: "/workspace", runtimePath: "runtime.json" },
        {
          readFile: () =>
            JSON.stringify({
              ...config,
              environment: {
                ...config.environment,
                settings: { cpuCount: 99 },
              },
            }),
        },
      ),
    /cpuCount/,
  );
  assert.equal(
    createRuntimeConfig("together-postgres")
      .resultStore.kind,
    "postgres",
  );
});

test('Together composes with the public Suite API, Claude adapter, checks, and canonical store', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createRunEngine } = await import('../lib/run-engine.mjs');
  const { openLocalResultStore } = await import('../lib/local-result-store.mjs');
  const { resolveV1Suite } = await import('../lib/v1-authoring.mjs');
  const { createClaudeCodeAdapter } = await import('../lib/agent-adapters/claude-code.mjs');
  const { sha256 } = await import('../lib/run-model.mjs');
  const root = await mkdtemp(join(tmpdir(), 'hurdle-together-canonical-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await resolveV1Suite({ suitePath: fileURLToPath(new URL('../../examples/copy-message/example.suite.mjs', import.meta.url)) });
  assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
  t.after(() => suite.dispose());
  const store = await openLocalResultStore({ root: join(root, 'results') });
  let disposed = false;
  const provider = {
    async acquire() { return { sandboxId: 'controlled-sandbox' }; },
    async stage(_resource, input) { assert.equal(input.fixtures.length, 1); },
    async run(_resource, { onStdout, environment }) {
      // The workload holds a surrogate; the host Guardian substitutes the key.
      assert.match(environment.ANTHROPIC_API_KEY, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(environment.TOGETHER_API_KEY, undefined);
      onStdout(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'controlled-session', result: 'Copied fixture', num_turns: 1, total_cost_usd: 0 }) + '\n');
      return { exitCode: 0, signal: null, timedOut: false, quiescent: true, spawnError: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 };
    },
    async collectArtifacts(_resource, declarations) {
      const bytes = Buffer.from('Hello from the fixture.\n');
      return declarations.map(declaration => ({ ...declaration, status: 'captured', bytes, sizeBytes: bytes.length, sha256: sha256(bytes), textEncoding: 'utf8', capturedAt: new Date().toISOString() }));
    },
    async dispose() { disposed = true; }, async isDisposed() { return disposed; },
  };
  const engine = createRunEngine({ resultStore: store, agentAdapter: createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: 'agent-auth-test-value' } }), executionEnvironment: createTogetherExecutionEnvironment({ apiKey: 'sandbox-auth-test-value', provider, guardian: stubGuardian() }) });
  const result = await engine.run({ runPlan: suite.value });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.runs[0].verdict, 'pass', JSON.stringify(result));
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.execution.environmentId, 'together');
  assert.equal(record.execution.sessionId, 'controlled-session');
  assert.equal(disposed, true);
  assert.doesNotMatch(JSON.stringify(record), /agent-auth-test-value|sandbox-auth-test-value/);
});

test('a Together run cancelled while the Agent runs reports cancellation, not a process failure', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createRunEngine } = await import('../lib/run-engine.mjs');
  const { openLocalResultStore } = await import('../lib/local-result-store.mjs');
  const { resolveV1Suite } = await import('../lib/v1-authoring.mjs');
  const { createClaudeCodeAdapter } = await import('../lib/agent-adapters/claude-code.mjs');
  const root = await mkdtemp(join(tmpdir(), 'hurdle-together-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await resolveV1Suite({ suitePath: fileURLToPath(new URL('../../examples/copy-message/example.suite.mjs', import.meta.url)) });
  assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
  t.after(() => suite.dispose());
  const store = await openLocalResultStore({ root: join(root, 'results') });
  const controller = new AbortController();
  let disposed = false;
  const provider = {
    async acquire() { return { sandboxId: 'controlled-sandbox' }; },
    async stage() {},
    async run() {
      controller.abort();
      // The sandbox SDK rejects an aborted command, which the shared controller
      // reports as an unavailable remote process.
      const now = new Date().toISOString();
      return { exitCode: null, signal: null, timedOut: false, quiescent: true, spawnError: 'remote-process-unavailable', startedAt: now, endedAt: now, durationMs: 1 };
    },
    async collectArtifacts() { return []; },
    async dispose() { disposed = true; }, async isDisposed() { return disposed; },
  };
  const engine = createRunEngine({ resultStore: store, agentAdapter: createClaudeCodeAdapter({ runtimeEnv: { ANTHROPIC_API_KEY: 'agent-auth-test-value' } }), executionEnvironment: createTogetherExecutionEnvironment({ apiKey: 'sandbox-auth-test-value', provider, guardian: stubGuardian() }) });
  const result = await engine.run({ runPlan: suite.value, signal: controller.signal });
  const codes = (await store.getRun(result.runs[0].id)).integrityIssues.map(({ code }) => code);
  assert.ok(codes.includes('environment.cancelled'), JSON.stringify(codes));
  assert.deepEqual(codes, ['environment.cancelled', 'artifact.required-uncollected']);
  assert.equal(disposed, true);
});
