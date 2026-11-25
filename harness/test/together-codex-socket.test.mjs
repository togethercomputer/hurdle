import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";

import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";
import { createSandboxServer } from "../lib/execution-environments/sandbox-server.mjs";
import { createTogetherExecutionEnvironment } from "../lib/execution-environments/together.mjs";
import { createTogetherSocketProvider } from "../lib/execution-environments/together-socket-provider.mjs";
import { openLocalResultStore } from "../lib/local-result-store.mjs";
import { createRunEngine } from "../lib/run-engine.mjs";
import { sha256 } from "../lib/run-model.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

// Codex runs end to end through Together's Hurdle socket: the real socket
// provider talks to a local sandbox server, whose task steps are faked at the
// sandbox boundary. Every key is a fake and nothing leaves this machine.

const CA = `${rootCertificates[0]}\n`;
const TOGETHER_HOSTS = ["api.together.ai", "api.together.xyz"];
const FIXTURE = "Hello from the fixture.\n";
const CODEX_ARGS = [
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
  "--model",
  "test-model",
  "-",
];

async function writeCodexSuite(root) {
  const taskRoot = join(root, "tasks", "codex-chat");
  await mkdir(join(taskRoot, "fixtures"), { recursive: true });
  await writeFile(join(taskRoot, "fixtures", "message.txt"), FIXTURE);
  await writeFile(join(taskRoot, "prompt.md"), [
    "Send one chat completion request to Together AI.",
    "Then write the exact contents of `fixtures/message.txt` to `answer.txt`.",
    "",
  ].join("\n"));
  await writeFile(join(taskRoot, "checks.mjs"), [
    'import { defineChecks } from "hurdle";',
    "",
    "export default defineChecks((run) => {",
    '  run.expect.request({ id: "chat-request", method: "POST", path: "/v1/chat/completions", status: 200 });',
    '  run.expect.artifact({ id: "answer", path: "answer.txt", format: "text", maxBytes: 4096 });',
    "  run.check({",
    '    id: "exact-copy",',
    `    passed: run.artifacts.text("answer.txt") === ${JSON.stringify(FIXTURE)},`,
    '    summary: "answer.txt must match the fixture exactly.",',
    "  });",
    "});",
    "",
  ].join("\n"));
  await writeFile(join(root, "codex.suite.mjs"), [
    'import { defineSuite } from "hurdle";',
    "",
    "export default defineSuite({",
    "  api: {",
    '    authorizationCredential: "TOGETHER_API_KEY",',
    `    hosts: ${JSON.stringify(TOGETHER_HOSTS)},`,
    "  },",
    '  tasks: ["./tasks/codex-chat"],',
    '  agents: [{ runner: "codex", model: "test-model" }],',
    '  verdict: "code",',
    "});",
    "",
  ].join("\n"));
  const resolved = await resolveV1Suite({ suitePath: join(root, "codex.suite.mjs") });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  return resolved;
}

function codexStdout(threadId, secret, usage) {
  return [
    { type: "thread.started", thread_id: threadId },
    { type: "item.completed", item: { type: "agent_message", text: `auth=${secret}` } },
    { type: "item.completed", item: { type: "command_execution", command: "node app.mjs" } },
    { type: "turn.completed", usage },
  ].map((frame) => JSON.stringify(frame)).join("\n") + "\n";
}

// The sandbox side of the socket: each step the controller sends is recorded
// and answered as Together's Hurdle image would answer it.
async function codexSandbox(t, root, { controlToken, stdout, stderr = "", exitCode = 0 }) {
  const taskRoot = join(root, "sandbox-task");
  const artifactRoot = join(root, "sandbox-sealed");
  await mkdir(artifactRoot, { recursive: true });
  const jobs = [];
  let closed = 0;
  const server = createSandboxServer({
    controlToken,
    async runTask(job, { onStdout, onStderr }) {
      jobs.push(structuredClone(job));
      if (job.kind === "agent") {
        onStdout(stdout);
        if (stderr) onStderr(stderr);
        const now = new Date().toISOString();
        return {
          exitCode,
          signal: null,
          timedOut: false,
          spawnError: null,
          quiescent: true,
          startedAt: now,
          endedAt: now,
          durationMs: 1,
        };
      }
      if (job.kind === "collect") {
        const bytes = Buffer.from(FIXTURE);
        return {
          artifacts: await Promise.all(job.declarations.map(async (declaration, index) => {
            await writeFile(join(artifactRoot, String(index)), bytes);
            return {
              ...declaration,
              status: "captured",
              sizeBytes: bytes.byteLength,
              sha256: sha256(bytes),
              textEncoding: "utf8",
              index,
              capturedAt: new Date().toISOString(),
            };
          })),
        };
      }
      if (job.kind === "metadata") return { metadata: [] };
      return {};
    },
    port: 0,
    flowPort: 0,
    caPath: join(taskRoot, "guardian-ca.pem"),
    writeRoots: [taskRoot],
    readRoots: [artifactRoot],
    onClosed: () => { closed += 1; },
  });
  const { port } = await server.listen({ host: "127.0.0.1" });
  t.after(() => server.close());
  const provider = createTogetherSocketProvider({
    runUrl: () => `ws://127.0.0.1:${port}/`,
    taskRoot,
    artifactRoot,
  });
  async function uploads() {
    const files = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push({ path, bytes: await readFile(path) });
      }
    };
    await walk(taskRoot);
    return files;
  }
  return { provider, jobs, uploads, closed: () => closed };
}

// The controller-host Guardian, stubbed: it records what it is given and, like
// the real one for a socket workload, attaches the sandbox's egress.
function codexGuardian(observedAt) {
  const prepared = [];
  let closed = 0;
  const guardian = {
    async prepare(input) {
      prepared.push(input);
      return { caCertificate: CA, hosts: input.capture.routes.map(({ host }) => host), workloadEnvironment: {} };
    },
    async attach({ workload, session }) {
      session.workload = workload;
      await workload.attachEgress({ hosts: session.hosts, openUpstream: () => null });
      session.workloadEnvironment = { HTTPS_PROXY: "http://127.0.0.1:18082" };
    },
    async seal({ session }) {
      session.workload.assertEgressHealthy();
      return {
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
          durationMs: 1,
          selectedFields: {},
        }],
        provenance: {
          producer: "together-host-guardian",
          authority: "environment",
          lifecyclePhase: "execution",
          capturedAt: observedAt,
          trust: "environment-observed",
        },
      };
    },
    close(session) { if (session) closed += 1; },
  };
  return { guardian, prepared, closed: () => closed };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

test("Codex runs end to end through the Together socket with Guardian-only keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-codex-socket-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await writeCodexSuite(root);
  t.after(() => suite.dispose());
  const secrets = {
    codex: "sk-test-fake-codex-agent-key",
    target: "tgp_v1_fake-task-target-key",
    sandbox: randomBytes(32).toString("base64url"),
  };
  const sandbox = await codexSandbox(t, root, {
    controlToken: secrets.sandbox,
    stdout: codexStdout("codex-socket-thread", secrets.codex, {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
      reasoning_output_tokens: 2,
    }),
    stderr: `codex diagnostic auth=${secrets.codex}\n`,
  });
  const observedAt = new Date().toISOString();
  const host = codexGuardian(observedAt);
  const store = await openLocalResultStore({ root: join(root, "results") });
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
    executionEnvironment: createTogetherExecutionEnvironment({
      apiKey: secrets.sandbox,
      provider: sandbox.provider,
      guardian: host.guardian,
      entropy: () => "codex-socket-entropy",
    }),
  });

  const result = await engine.run({
    runPlan: suite.value,
    agentSelections: suite.defaults.agentSelections,
    credentials: { TOGETHER_API_KEY: secrets.target },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.deepEqual(result.summary.terminalVerdicts, { pass: 1, fail: 0, incomplete: 0, unknown: 0 });
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.verdict, "pass", JSON.stringify(record.verdictReasons));
  assert.deepEqual(record.integrityIssues, []);
  assert.equal(record.snapshot.agent.adapterId, "codex");
  assert.equal(record.snapshot.environment.environmentId, "together");
  assert.equal(record.execution.adapterId, "codex");
  assert.equal(record.execution.environmentId, "together");
  assert.equal(record.execution.sessionId, "codex-socket-thread");
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
    completedItemsByType: { agent_message: 1, command_execution: 1 },
    agentMessages: 1,
    commandExecutions: 1,
    fileChanges: 0,
    mcpToolCalls: 0,
    webSearches: 0,
  });
  assert.deepEqual(
    record.checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "pass" },
      { id: "answer", outcome: "pass" },
      { id: "exact-copy", outcome: "pass" },
    ],
  );

  // Every step crossed the one socket, which then closed.
  assert.deepEqual(sandbox.jobs.map(({ kind }) => kind), ["setup", "stage", "agent", "collect"]);
  assert.deepEqual(sandbox.jobs[0].hosts, TOGETHER_HOSTS);
  const [fixture] = sandbox.jobs[1].fixtures;
  assert.equal(fixture.workspacePath, "fixtures/message.txt");
  assert.equal(await readFile(fixture.pinnedPath, "utf8"), FIXTURE);
  assert.equal(await until(() => sandbox.closed() === 1), true);
  assert.equal(host.closed(), 1);

  // The sandbox runs Codex from the command, args and stdin alone, holding
  // only stand-ins; the real keys stay with the controller's Guardian.
  const agent = sandbox.jobs[2];
  assert.equal(agent.launchPlan.command, "codex");
  assert.deepEqual(agent.launchPlan.args, CODEX_ARGS);
  assert.match(Buffer.from(agent.launchPlan.stdinBase64, "base64").toString(), /Send one chat completion request/);
  assert.equal(agent.environment.CODEX_API_KEY, "sk-codex-socket-entropy");
  assert.match(agent.environment.TOGETHER_API_KEY, /^tae_surrogate_/);
  assert.equal(agent.environment.HTTPS_PROXY, "http://127.0.0.1:18082");
  for (const name of ["OPENAI_API_KEY", "PATH", "HOME"]) {
    assert.equal(agent.environment[name], undefined, name);
  }
  const [prepared] = host.prepared;
  assert.deepEqual(prepared.agentCredentials, [{
    environmentName: "CODEX_API_KEY",
    surrogate: "sk-codex-socket-entropy",
    value: secrets.codex,
    hosts: ["api.openai.com"],
    headerNames: ["authorization"],
  }]);
  assert.equal(prepared.credentialValues.TOGETHER_API_KEY, secrets.target);
  assert.equal(prepared.surrogates.TOGETHER_API_KEY, agent.environment.TOGETHER_API_KEY);
  assert.deepEqual(prepared.capture.routes.map(({ host: route }) => route), TOGETHER_HOSTS);
  const crossed = JSON.stringify([...sandbox.jobs, ...(await sandbox.uploads()).map(({ bytes }) => bytes.toString("latin1"))]);
  for (const secret of Object.values(secrets)) {
    assert.ok(!crossed.includes(secret), "no real key crosses the socket");
  }

  // Stored evidence is redacted and carries no key.
  const transcript = await store.readEvidence(record.evidence.transcript, { maxBytes: 64 * 1024 });
  const stderr = await store.readEvidence(record.evidence.stderr, { maxBytes: 64 * 1024 });
  const egress = await store.readEvidence(record.evidence.egress[0].content, { maxBytes: 64 * 1024 });
  assert.match(transcript.toString("utf8"), /<REDACTED>/);
  assert.equal(stderr.toString("utf8"), "codex diagnostic auth=<REDACTED>\n");
  assert.deepEqual(
    JSON.parse(egress).requests.map(({ method, host: requestHost, path, statusCode }) => ({
      method, host: requestHost, path, statusCode,
    })),
    [{ method: "POST", host: "api.together.ai", path: "/v1/chat/completions", statusCode: 200 }],
  );
  const storedText = [
    JSON.stringify(record),
    JSON.stringify(await store.getRunHistory(record.id)),
    transcript.toString("utf8"),
    stderr.toString("utf8"),
    egress.toString("utf8"),
  ].join("\n");
  for (const secret of Object.values(secrets)) {
    assert.ok(!storedText.includes(secret), "no key is stored");
  }
});

test("a failed Codex run through the Together socket cannot pass on passing evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-codex-socket-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await writeCodexSuite(root);
  t.after(() => suite.dispose());
  const codexSecret = "sk-test-fake-codex-failure-key";
  const targetSecret = "tgp_v1_fake-task-target-failure";
  const controlToken = randomBytes(32).toString("base64url");
  const sandbox = await codexSandbox(t, root, {
    controlToken,
    stdout: codexStdout("codex-socket-failed-thread", codexSecret, { input_tokens: 2, output_tokens: 1 }),
    exitCode: 17,
  });
  const store = await openLocalResultStore({ root: join(root, "results") });
  const engine = createRunEngine({
    resultStore: store,
    agentAdapter: createCodexAdapter({
      runtimeEnv: { OPENAI_API_KEY: codexSecret },
      command: "codex",
      timeoutMs: 5_000,
    }),
    executionEnvironment: createTogetherExecutionEnvironment({
      apiKey: controlToken,
      provider: sandbox.provider,
      guardian: codexGuardian(new Date().toISOString()).guardian,
    }),
  });

  const result = await engine.run({
    runPlan: suite.value,
    agentSelections: suite.defaults.agentSelections,
    credentials: { TOGETHER_API_KEY: targetSecret },
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.deepEqual(result.summary.terminalVerdicts, { pass: 0, fail: 0, incomplete: 1, unknown: 0 });
  const record = await store.getRun(result.runs[0].id);
  assert.equal(record.state, "complete");
  assert.equal(record.verdict, "incomplete");
  assert.equal(record.execution.sessionId, "codex-socket-failed-thread");
  assert.equal(record.execution.exitCode, 17);
  // The Target evidence and the artifact all pass; the exit code still decides.
  assert.deepEqual(
    record.checks.map(({ id, outcome }) => ({ id, outcome })),
    [
      { id: "chat-request", outcome: "pass" },
      { id: "answer", outcome: "pass" },
      { id: "exact-copy", outcome: "pass" },
    ],
  );
  assert.ok(record.integrityIssues.some(({ code }) => code === "environment.nonzero-exit"));
  assert.ok(record.verdictReasons.some(({ code }) => code === "environment.nonzero-exit"));
  assert.deepEqual(
    (await store.getRunHistory(record.id)).map(({ revision, state, verdict }) => ({ revision, state, verdict })),
    [
      { revision: 0, state: "queued", verdict: null },
      { revision: 1, state: "running", verdict: null },
      { revision: 2, state: "complete", verdict: "incomplete" },
    ],
  );
  assert.deepEqual(sandbox.jobs.map(({ kind }) => kind), ["setup", "stage", "agent", "collect"]);
  assert.equal(await until(() => sandbox.closed() === 1), true);
  const transcript = await store.readEvidence(record.evidence.transcript, { maxBytes: 64 * 1024 });
  assert.match(transcript.toString("utf8"), /<REDACTED>/);
  assert.ok(!JSON.stringify(record).includes(codexSecret));
  assert.ok(!JSON.stringify(record).includes(targetSecret));
});
