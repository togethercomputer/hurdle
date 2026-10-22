import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertRuntimeDependencies } from "../lib/backend-dependencies.mjs";
import { createExecutionEnvelope } from "../lib/execution-envelope.mjs";
import {
  createTogetherLiteExecutionEnvironment,
  normalizeTogetherLiteSettings,
} from "../lib/execution-environments/together-lite.mjs";
import { resolveRuntimeProfile, resolveRuntimeSecrets } from "../lib/runtime-profile.mjs";
import {
  caHeaderValue,
  STDERR_STREAM_ID,
  STDOUT_STREAM_ID,
  websocketDuplex,
} from "../lib/sandbox-lite-client.mjs";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
const { Server } = require("yamux-js");

const CA = readFileSync(new URL("./fixtures/sandbox-lite-ca.pem", import.meta.url), "utf8");
const IMAGE = `sha256:${"ab".repeat(32)}`;
const API_KEY = "platform-key";
const REAL_AGENT_KEY = "sk-ant-api03-real-agent-secret-material";
const CONNECT = "CONNECT api.together.ai:443 HTTP/1.1\r\nHost: api.together.ai:443\r\n\r\n";
const MCP = Buffer.from('{"mcpServers":{}}\n');
const FIXTURE = Buffer.from("fixture data\n");
// The prefixed form hurdle pins inputs with (run-model's sha256).
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function envelope(options = {}) {
  return createExecutionEnvelope({
    executionId: "lite-run",
    settings: {},
    launchPlan: {
      command: "agent",
      env: { PATH: "/host", HOME: "/host-home", AGENT_FLAG: "on", ANTHROPIC_API_KEY: REAL_AGENT_KEY },
      timeoutMs: 5000,
    },
    fixtures: [],
    outputArtifacts: [{ path: "result.txt", kind: "text", maxBytes: 100, required: true }],
    target: {},
    credentialDefinitions: [],
    credentialValues: {},
    ...options,
  });
}

// A task fixture pinned on disk plus a generated workspace file, the two input
// kinds a sandbox backend stages before the agent starts.
function stagedEnvelope(t, { fixtureBytes = FIXTURE, maxBytes = 1024 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "together-lite-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pinnedPath = join(root, "data.txt");
  writeFileSync(pinnedPath, fixtureBytes);
  return envelope({
    fixtures: [{ workspacePath: "input/data.txt", pinnedPath, sha256: digest(fixtureBytes), maxBytes, source: "fixtures/data.txt" }],
    launchPlan: {
      command: "agent",
      env: { PATH: "/host", HOME: "/host-home", AGENT_FLAG: "on", ANTHROPIC_API_KEY: REAL_AGENT_KEY },
      timeoutMs: 5000,
      workspaceFiles: [{ path: ".hurdle/claude-mcp.json", source: { kind: "generated", bytes: MCP, sha256: digest(MCP) } }],
    },
  });
}

function sealedCollection() {
  return {
    status: "captured",
    requests: [],
    provenance: {
      producer: "together-lite-host-guardian",
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: new Date().toISOString(),
      trust: "environment-observed",
    },
  };
}

// Stands in for the platform: authenticates the upgrade, then plays the
// in-sandbox muxer over yamux. The local "proxy" the environment pumps egress
// into is a plain TCP listener that answers any CONNECT with 200.
async function fakePlatform(t, { authorize = true } = {}) {
  const received = { url: null, headers: null, hello: null, frames: [], proxyBytes: "", egressReply: null, closeCode: null };
  let resolveClosed;
  received.closed = new Promise((resolve) => { resolveClosed = resolve; });
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      received.proxyBytes += data.toString("latin1");
      if (received.proxyBytes.includes("\r\n\r\n")) socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    received.url = request.url;
    received.headers = request.headers;
    if (!authorize || request.headers.authorization !== `Bearer ${API_KEY}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data) => received.frames.push(Buffer.from(data)));
      const transport = websocketDuplex(ws);
      const mux = new Server((control) => {
        let buffered = "";
        control.on("data", (chunk) => {
          buffered += chunk.toString("utf8");
          const index = buffered.indexOf("\n");
          if (index < 0) return;
          const message = JSON.parse(buffered.slice(0, index));
          buffered = buffered.slice(index + 1);
          if (message.type !== "hello") return;
          received.hello = message;
          control.write(`${JSON.stringify({ type: "ready", stdout: STDOUT_STREAM_ID, stderr: STDERR_STREAM_ID })}\n`);
          const stdout = mux.open();
          stdout.write("agent transcript\n");
          stdout.close();
          const stderr = mux.open();
          stderr.write("agent warning\n");
          stderr.close();
          const egress = mux.open();
          egress.once("data", (reply) => {
            received.egressReply = reply.toString("latin1");
            egress.close();
            control.write(`${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false, quiescent: true })}\n`);
          });
          egress.write(CONNECT);
        });
      }, { logger: () => {} });
      mux.pipe(transport).pipe(mux);
      ws.once("close", (code) => { received.closeCode = code; mux.close(); resolveClosed(code); });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close();
    server.close();
    proxy.close();
  });
  return {
    received,
    url: `ws://127.0.0.1:${server.address().port}/v1/compute/experimental/run`,
    proxyPort: proxy.address().port,
  };
}

function fixture(platform, events) {
  const guardian = {
    async prepare({ sandbox, agentCredentials }) {
      assert.equal(sandbox, undefined, "the Guardian runs on this machine");
      assert.equal(agentCredentials[0]?.value, REAL_AGENT_KEY, "the real key reaches only the Guardian");
      events.push("guardian:prepare");
      return { caCertificate: CA, proxyPort: platform.proxyPort, controlToken: "t", policyFingerprint: null, proxy: null };
    },
    async close(session) { if (session) events.push("guardian:close"); },
  };
  return createTogetherLiteExecutionEnvironment({
    apiKey: API_KEY,
    guardian,
    seal: async () => { events.push("seal"); return sealedCollection(); },
    defaults: { url: platform.url, image: IMAGE, maxLifetimeMs: 60_000 },
  });
}

test("Together Lite runs a cell over one connection and pumps egress into the local Guardian", async (t) => {
  const platform = await fakePlatform(t);
  const events = [];
  const result = await fixture(platform, events).execute(stagedEnvelope(t));

  assert.deepEqual(events, ["guardian:prepare", "seal", "guardian:close"]);
  assert.deepEqual(result.integrityIssues, []);
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.process.quiescent, true);
  assert.equal(result.process.stdout.text, "agent transcript\n");
  assert.equal(result.process.stderr.text, "agent warning\n");
  assert.equal(result.egressCollections[0].status, "captured");
  assert.equal(result.artifacts[0].status, "missing");

  // The upgrade carries the image, the key and the public CA only.
  const { received } = platform;
  assert.equal(new URL(received.url, "http://x").searchParams.get("image"), IMAGE);
  assert.equal(received.headers.authorization, `Bearer ${API_KEY}`);
  const sent = new X509Certificate(Buffer.from(received.headers["x-sandbox-ca"], "base64"));
  assert.equal(sent.fingerprint256, new X509Certificate(CA).fingerprint256);

  // The agent receives its configuration and surrogates, never host locators
  // or the real key; the platform owns proxy and trust settings.
  const { env } = received.hello;
  assert.equal(received.hello.v, 1);
  assert.equal(env.AGENT_FLAG, "on");
  assert.equal(env.PATH, undefined);
  assert.equal(env.HOME, undefined);
  assert.match(env.ANTHROPIC_API_KEY, /^sk-ant-api03-[A-Za-z0-9_-]{43}$/);
  assert.notEqual(env.ANTHROPIC_API_KEY, REAL_AGENT_KEY);
  assert.equal(env.HTTPS_PROXY, undefined);

  // The fixture and the workspace file travel with hello, digest-pinned, for
  // the muxer to write before the agent starts.
  assert.deepEqual(received.hello.files.map(({ path, sha256 }) => [path, sha256]), [
    ["input/data.txt", digest(FIXTURE)],
    [".hurdle/claude-mcp.json", digest(MCP)],
  ]);
  assert.equal(Buffer.from(received.hello.files[0].content, "base64").toString(), FIXTURE.toString());
  assert.equal(Buffer.from(received.hello.files[1].content, "base64").toString(), MCP.toString());

  // The agent's CONNECT reached the Guardian verbatim and its answer came back
  // through the same stream.
  assert.ok(received.proxyBytes.startsWith(CONNECT));
  assert.match(received.egressReply, /^HTTP\/1\.1 200 /);

  // Nothing on the wire carried the real key, and the connection was closed
  // normally once the run ended, which is what ends the sandbox.
  assert.doesNotMatch(Buffer.concat(received.frames).toString("latin1"), /real-agent-secret/);
  assert.equal(await received.closed, 1000);
});

test("Together Lite reports a rejected upgrade as an acquire failure and still closes the Guardian", async (t) => {
  const platform = await fakePlatform(t, { authorize: false });
  const events = [];
  const result = await fixture(platform, events).execute(envelope());
  assert.deepEqual(events, ["guardian:prepare", "guardian:close"]);
  assert.equal(result.process, null);
  assert.deepEqual(result.integrityIssues.map(({ code, phase }) => [code, phase]), [
    ["environment.acquire-failed", "acquire"],
  ]);
  assert.equal(result.egressCollections[0].status, "unavailable");
});

test("Together Lite enforces a fixture's byte limit before anything is sent", async (t) => {
  const platform = await fakePlatform(t);
  const events = [];
  const result = await fixture(platform, events)
    .execute(stagedEnvelope(t, { fixtureBytes: Buffer.alloc(2048), maxBytes: 1024 }));
  assert.deepEqual(events, ["guardian:prepare", "guardian:close"]);
  assert.equal(result.process, null);
  assert.deepEqual(result.integrityIssues.map(({ code, phase }) => [code, phase]), [
    ["environment.stage-failed", "stage"],
  ]);
  assert.equal(platform.received.hello, null, "nothing is staged after a bound is exceeded");
});

test("a together-lite Runtime resolves its secret by name and validates the image", () => {
  const config = {
    schemaVersion: 1,
    environment: {
      kind: "together-lite",
      apiKeyEnv: "TOGETHER_API_KEY",
      settings: { url: "wss://example.invalid/run", image: IMAGE },
    },
    resultStore: { kind: "local", root: "../results" },
  };
  const read = (value) => resolveRuntimeProfile(
    { cwd: "/workspace", runtimePath: "runtime.json" },
    { readFile: () => JSON.stringify(value) },
  );
  const profile = read(config);
  assert.equal(profile.environment.kind, "together-lite");
  assert.deepEqual(resolveRuntimeSecrets(profile, { TOGETHER_API_KEY: "secret" }), { togetherApiKey: "secret" });
  assert.doesNotMatch(JSON.stringify(profile), /"secret"/);
  assert.throws(
    () => read({ ...config, environment: { ...config.environment, settings: { url: "wss://example.invalid/run", image: "latest" } } }),
    /sha256 digest/,
  );
  assert.doesNotThrow(() => assertRuntimeDependencies({ environment: { kind: "together-lite" } }));
});

test("Together Lite settings require a platform image digest and a WebSocket URL", () => {
  const defaults = { url: "wss://example.invalid/run", image: IMAGE, maxLifetimeMs: 60_000 };
  assert.equal(normalizeTogetherLiteSettings({}, defaults).image, IMAGE);
  assert.throws(() => normalizeTogetherLiteSettings({ image: "latest" }, defaults), /sha256 digest/);
  assert.throws(() => normalizeTogetherLiteSettings({ url: "https://example.invalid" }, defaults), /WebSocket URL/);
  assert.throws(() => normalizeTogetherLiteSettings({ cpuCount: 2 }, defaults), /unknown Together Lite/);
  assert.throws(() => normalizeTogetherLiteSettings({ maxLifetimeMs: 10 }, defaults), /maxLifetimeMs/);
  // A profile may leave the image to the run; the run may not.
  assert.equal(normalizeTogetherLiteSettings({ ...defaults, image: "" }, defaults, { requireImage: false }).image, "");
  assert.throws(() => normalizeTogetherLiteSettings({ image: "" }, defaults), /sha256 digest/);
});

test("the CA header is the DER of a public certificate and never key material", () => {
  const header = caHeaderValue(CA);
  assert.equal(new X509Certificate(Buffer.from(header, "base64")).fingerprint256, new X509Certificate(CA).fingerprint256);
  assert.throws(() => caHeaderValue(`${CA}-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n`), /public PEM/);
  assert.throws(() => caHeaderValue("not a certificate"), /public PEM/);
});
