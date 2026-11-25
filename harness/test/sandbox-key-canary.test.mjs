import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";

import {
  closeExecutionCredentialLease,
  createExecutionEnvelope,
} from "../lib/execution-envelope.mjs";
import { createSandboxServer } from "../lib/execution-environments/sandbox-server.mjs";
import { createTogetherExecutionEnvironment } from "../lib/execution-environments/together.mjs";
import { createTogetherSocketProvider } from "../lib/execution-environments/together-socket-provider.mjs";

// Canary: real-looking keys go in everywhere the controller holds them (the
// Agent's launch plan env and the Suite's credential values). Every byte the
// real provider code then sends into the Agent's sandbox is recorded: files
// written, commands and their environments, socket steps and uploads. The
// keys must appear nowhere in it, in any common encoding. The Guardian is the
// one place real values may go, so it is stubbed and not recorded here.

const AGENT_KEY = `sk-ant-api03-CANARY${randomBytes(24).toString("hex")}`;
const CODEX_KEY = `sk-proj-CANARY${randomBytes(24).toString("hex")}`;
const TARGET_KEY = `tgp_v1_CANARY${randomBytes(24).toString("hex")}`;
const CANARIES = { ANTHROPIC_API_KEY: AGENT_KEY, CODEX_API_KEY: CODEX_KEY, TOGETHER_API_KEY: TARGET_KEY };

function encodings(value) {
  const bytes = Buffer.from(value);
  return [value, bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), encodeURIComponent(value)];
}

// Also look inside anything base64-shaped, so a key inside an encoded payload
// (stdin, an uploaded file) is still found.
function haystack(records) {
  const text = records.map((record) => (
    Buffer.isBuffer(record) || record instanceof Uint8Array
      ? Buffer.from(record).toString("latin1")
      : typeof record === "string" ? record : JSON.stringify(record)
  )).join("\n");
  const decoded = (text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [])
    .map((token) => Buffer.from(token, token.includes("-") || token.includes("_") ? "base64url" : "base64").toString("latin1"));
  return [text, ...decoded].join("\n");
}

function leakedNames(records) {
  const text = haystack(records);
  return Object.entries(CANARIES)
    .filter(([, value]) => encodings(value).some((encoded) => text.includes(encoded)))
    .map(([name]) => name);
}

function canaryEnvelope(settings) {
  return createExecutionEnvelope({
    executionId: "key-canary",
    settings,
    launchPlan: {
      command: "agent",
      args: ["--print"],
      env: { ANTHROPIC_API_KEY: AGENT_KEY, CODEX_API_KEY: CODEX_KEY, CLI_VERSION: "1.0.0" },
      stdin: "Call the API and report.",
      timeoutMs: 1_000,
      workspaceFiles: [],
    },
    fixtures: [],
    outputArtifacts: [],
    target: { egress: { relevantHosts: ["api.together.ai", "api.together.xyz"], selectedFields: [] } },
    credentialDefinitions: [{
      name: "TOGETHER_API_KEY",
      delivery: { kind: "captured-http-header", hosts: ["api.together.ai", "api.together.xyz"], headerNames: ["authorization"] },
    }],
    credentialValues: { TOGETHER_API_KEY: TARGET_KEY },
  });
}

function stubGuardian(seen) {
  return {
    async prepare({ credentialValues, agentCredentials }) {
      // The Guardian does receive the real values; that is its job.
      seen.guardianTarget = credentialValues.TOGETHER_API_KEY;
      seen.guardianAgent = agentCredentials.map(({ environmentName }) => environmentName).sort();
      return { id: "canary-guardian", workloadEnvironment: { HTTPS_PROXY: "http://127.0.0.1:1" } };
    },
    async attach() {},
    async seal() {
      return {
        status: "captured",
        requests: [],
        provenance: {
          producer: "canary-guardian",
          authority: "environment",
          lifecyclePhase: "execution",
          capturedAt: new Date().toISOString(),
          trust: "environment-observed",
        },
      };
    },
    close() {},
  };
}

test("Together's Hurdle socket sends no real key into the sandbox", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-key-canary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskRoot = join(root, "task");
  const artifactRoot = join(root, "sealed");
  await mkdir(artifactRoot);
  const jobs = [];
  const controlToken = randomBytes(32).toString("base64url");
  const server = createSandboxServer({
    controlToken,
    runTask: async (job) => {
      jobs.push(job);
      if (job.kind === "agent") return { exitCode: 0, quiescent: true, timedOut: false, durationMs: 1 };
      if (job.kind === "collect") return { artifacts: [] };
      if (job.kind === "metadata") return { metadata: [] };
      return {};
    },
    port: 0,
    flowPort: 0,
    caPath: join(taskRoot, "guardian-ca.pem"),
    writeRoots: [taskRoot],
    readRoots: [artifactRoot],
  });
  const { port } = await server.listen({ host: "127.0.0.1" });
  t.after(() => server.close());
  const seen = {};
  const guardian = {
    ...stubGuardian(seen),
    async prepare(input) {
      const session = await stubGuardian(seen).prepare(input);
      return { ...session, caCertificate: `${rootCertificates[0]}\n` };
    },
  };
  const provider = createTogetherSocketProvider({ runUrl: () => `ws://127.0.0.1:${port}/`, taskRoot, artifactRoot });
  const environment = createTogetherExecutionEnvironment({ apiKey: controlToken, provider, guardian });
  const envelope = canaryEnvelope(environment.normalizeSettings({}));
  try {
    await environment.execute(envelope);
  } finally {
    closeExecutionCredentialLease(envelope);
  }
  // Everything the sandbox server received: each step, and each uploaded file.
  const uploaded = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else uploaded.push(await readFile(path));
    }
  };
  await walk(taskRoot);
  const agent = jobs.find((job) => job.kind === "agent");
  assert.ok(agent, "the run reached the Agent step");
  assert.equal(seen.guardianTarget, TARGET_KEY);
  assert.match(agent.environment.ANTHROPIC_API_KEY, /^sk-ant-api03-/);
  assert.match(agent.environment.TOGETHER_API_KEY, /^tae_surrogate_/);
  assert.ok(!JSON.stringify(jobs).includes(controlToken));
  assert.deepEqual(leakedNames([...jobs, ...uploaded]), []);
});

test("the canary finds a key however it is encoded", () => {
  assert.deepEqual(leakedNames([{ env: { ANTHROPIC_API_KEY: AGENT_KEY } }]), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(leakedNames([Buffer.from(`x${TARGET_KEY}y`).toString("base64")]), ["TOGETHER_API_KEY"]);
  assert.deepEqual(leakedNames([{ stdinBase64: Buffer.from(JSON.stringify({ k: CODEX_KEY })).toString("base64") }]), ["CODEX_API_KEY"]);
  assert.deepEqual(leakedNames([Buffer.from(TARGET_KEY).toString("hex")]), ["TOGETHER_API_KEY"]);
  assert.deepEqual(leakedNames([{ env: { ANTHROPIC_API_KEY: "sk-ant-api03-stand-in" } }]), []);
});
