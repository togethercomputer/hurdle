import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rootCertificates } from "node:tls";

import { sha256 } from "../lib/run-model.mjs";
import { createLocalWorkload } from "../lib/execution-environments/local-workload.mjs";
import {
  certificateFromHeader,
  createSandboxServer,
} from "../lib/execution-environments/sandbox-server.mjs";
import { createTogetherGuardianController } from "../lib/execution-environments/together-guardian.mjs";
import { createSandboxTask } from "../lib/execution-environments/sandbox-task.mjs";
import {
  certificateHeader,
  createTogetherSocketProvider,
} from "../lib/execution-environments/together-socket-provider.mjs";
import { DEFAULT_TOGETHER_RUN_URL, togetherRunUrl } from "../lib/together-api-url.mjs";

const CA = new X509Certificate(rootCertificates[0]).toString();
const controlToken = randomBytes(32).toString("base64url");

async function harness(t, runTask = async () => ({})) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-socket-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskRoot = join(root, "task");
  const artifactRoot = join(root, "sealed");
  await mkdir(artifactRoot);
  let closed = 0;
  const jobs = [];
  const server = createSandboxServer({
    controlToken,
    runTask: (job, callbacks) => { jobs.push(job); return runTask(job, callbacks); },
    port: 0,
    flowPort: 0,
    caPath: join(taskRoot, "guardian-ca.pem"),
    writeRoots: [taskRoot],
    readRoots: [artifactRoot],
    onClosed: () => { closed += 1; },
  });
  const { port, flowPort } = await server.listen({ host: "127.0.0.1" });
  t.after(() => server.close());
  const provider = createTogetherSocketProvider({
    runUrl: () => `ws://127.0.0.1:${port}/`,
    taskRoot,
    artifactRoot,
  });
  return { root, taskRoot, artifactRoot, provider, port, flowPort, jobs, closed: () => closed };
}

function acquire(provider, signal) {
  return provider.acquire({ apiKey: controlToken, caCertificate: CA, signal });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

test("runs connect to Together's production Hurdle API unless told otherwise", () => {
  assert.equal(DEFAULT_TOGETHER_RUN_URL, "wss://hurdle.us.codesandbox.io/v1/compute/experimental/run");
  assert.equal(togetherRunUrl({}), DEFAULT_TOGETHER_RUN_URL);
  assert.equal(togetherRunUrl({ HURDLE_TOGETHER_RUN_URL: " ws://127.0.0.1:9/run " }), "ws://127.0.0.1:9/run");
  for (const url of ["https://hurdle.us.codesandbox.io/v1/compute/experimental/run", "wss://user:pass@example.com/run"]) {
    assert.throws(() => togetherRunUrl({ HURDLE_TOGETHER_RUN_URL: url }), /must be a ws\(s\) URL/);
  }
});

test("the CA crosses the header as its PEM body and is restored in the sandbox", () => {
  const header = certificateHeader(CA);
  assert.match(header, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(certificateFromHeader(header), CA);
  assert.equal(certificateFromHeader("not a certificate!"), null);
  assert.equal(certificateFromHeader(Buffer.from("not DER").toString("base64")), null);
  assert.throws(() => certificateHeader("-----BEGIN PRIVATE KEY-----"));
});

test("the sandbox requires a provisioned controller token", () => {
  assert.throws(() => createSandboxServer({ runTask: async () => {} }), /HURDLE_SANDBOX_CONTROL_TOKEN/);
});

test("one connection per sandbox, carrying the Guardian CA", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.provider.acquire({ apiKey: randomBytes(32).toString("base64url"), caCertificate: CA }),
    (error) => error.status === 401);
  const malformed = "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n";
  await assert.rejects(h.provider.acquire({ apiKey: controlToken, caCertificate: malformed }),
    (error) => error.status === 400);
  await assert.rejects(readFile(join(h.taskRoot, "guardian-ca.pem")), { code: "ENOENT" });
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  assert.equal(await readFile(join(h.taskRoot, "guardian-ca.pem"), "utf8"), CA);
  await assert.rejects(acquire(h.provider), (error) => error.status === 409);
});

test("Together's Hurdle API refusal surfaces its status and code", async (t) => {
  const hurdleApi = http.createServer((_request, response) => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "sandbox_connection_failed", message: "x" }));
  });
  await new Promise((ready) => hurdleApi.listen(0, "127.0.0.1", ready));
  t.after(() => hurdleApi.close());
  const provider = createTogetherSocketProvider({
    runUrl: () => `ws://127.0.0.1:${hurdleApi.address().port}/v1/compute/experimental/run`,
  });
  await assert.rejects(acquire(provider), (error) => (
    error.status === 502 && error.code === "sandbox_connection_failed"
  ));
});

test("a connection Together never answers fails instead of hanging", async (t) => {
  // Accepts the upgrade request and never replies, as a stalled boot would.
  const held = new Set();
  const ended = [];
  const hurdleApi = http.createServer();
  hurdleApi.on("upgrade", (_request, socket) => {
    held.add(socket);
    socket.on("error", () => {});
    socket.once("end", () => ended.push(socket));
  });
  await new Promise((ready) => hurdleApi.listen(0, "127.0.0.1", ready));
  t.after(() => {
    for (const socket of held) socket.destroy();
    hurdleApi.close();
  });
  const provider = createTogetherSocketProvider({
    runUrl: () => `ws://127.0.0.1:${hurdleApi.address().port}/v1/compute/experimental/run`,
    connectTimeoutMs: 200,
  });
  const started = Date.now();
  await assert.rejects(acquire(provider), (error) => (
    error.code === "sandbox_connection_timeout" && /did not open a sandbox/.test(error.message)
  ));
  assert.ok(Date.now() - started < 5_000);
  // The abandoned request is closed, so it cannot keep a sandbox waiting.
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(ended.length, 1);

  // Cancelling while connecting still wins over the timeout.
  const cancelling = createTogetherSocketProvider({
    runUrl: () => `ws://127.0.0.1:${hurdleApi.address().port}/v1/compute/experimental/run`,
    connectTimeoutMs: 60_000,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(acquire(cancelling, controller.signal), (error) => error.name === "AbortError");
});

test("stage uploads pinned inputs and runs the stage step against them", async (t) => {
  const h = await harness(t);
  const fixture = join(h.root, "fixture.txt");
  await writeFile(fixture, "fixture bytes");
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  await h.provider.stage(resource, {
    fixtures: [{ workspacePath: "data/in.txt", pinnedPath: fixture, sha256: sha256(Buffer.from("fixture bytes")) }],
    workspaceFiles: [{ path: "gen.txt", source: { kind: "generated", bytes: Buffer.from("generated"), sha256: sha256(Buffer.from("generated")) } }],
  });
  const [job] = h.jobs;
  assert.equal(job.kind, "stage");
  assert.equal(job.fixtures[0].workspacePath, "data/in.txt");
  assert.equal(await readFile(job.fixtures[0].pinnedPath, "utf8"), "fixture bytes");
  assert.deepEqual(job.workspaceFiles[0].source.kind, "pinned");
  assert.equal(await readFile(job.workspaceFiles[0].source.pinnedPath, "utf8"), "generated");
});

test("writes outside the task root are refused", async (t) => {
  const h = await harness(t);
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  await assert.rejects(resource.write("/etc/hurdle", Buffer.from("x")), /outside the task root/);
  await assert.rejects(resource.write(`${h.taskRoot}/../escape`, Buffer.from("x")), /outside the task root/);
  await assert.rejects(resource.read("/etc/passwd"), /outside the sealed roots/);
});

test("the agent step streams its output and returns the process facts", async (t) => {
  const facts = { exitCode: 0, quiescent: true, timedOut: false };
  const h = await harness(t, async (job, { onStdout, onStderr }) => {
    onStdout("hello ");
    onStderr("warn");
    onStdout(Buffer.from(job.launchPlan.stdinBase64, "base64").toString());
    return facts;
  });
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  let stdout = "";
  let stderr = "";
  const result = await h.provider.run(resource, {
    launchPlan: { command: "agent", args: [], stdin: "world", timeoutMs: 1000 },
    environment: { A: "1" },
    onStdout: (text) => { stdout += text; },
    onStderr: (text) => { stderr += text; },
  });
  assert.deepEqual(result, facts);
  assert.equal(stdout, "hello world");
  assert.equal(stderr, "warn");
  assert.deepEqual(h.jobs[0].environment, { A: "1" });
});

test("only what the sandbox runs crosses the socket, never the plan's own env", async (t) => {
  const real = "sk-ant-api03-REAL-VALUE-THAT-MUST-STAY-ON-THE-CONTROLLER";
  const h = await harness(t, async () => ({ exitCode: 0, quiescent: true, timedOut: false }));
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  const workspaceLayout = { workingDirectory: "/workspace" };
  await h.provider.run(resource, {
    launchPlan: {
      command: "agent",
      args: ["--print"],
      workspaceLayout,
      timeoutMs: 1000,
      stdin: "go",
      env: { ANTHROPIC_API_KEY: real, PATH: "/usr/bin" },
      credentialRoutes: [{ environmentName: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"], headerNames: ["x-api-key"] }],
      workspaceFiles: [],
    },
    environment: { ANTHROPIC_API_KEY: "sk-ant-api03-stand-in" },
  });
  const [job] = h.jobs.filter((value) => value.kind === "agent");
  assert.deepEqual(Object.keys(job.launchPlan).sort(), ["args", "command", "stdinBase64", "timeoutMs", "workspaceLayout"]);
  assert.deepEqual(job.launchPlan.workspaceLayout, workspaceLayout);
  assert.deepEqual(job.environment, { ANTHROPIC_API_KEY: "sk-ant-api03-stand-in" });
  assert.ok(!JSON.stringify(job).includes(real));
});

test("a failing step rejects without ending the connection", async (t) => {
  const h = await harness(t, async () => { throw new Error("staged input hash mismatch"); });
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  await assert.rejects(resource.step({ kind: "stage" }), /staged input hash mismatch/);
  assert.equal(resource.closed, false);
});

test("artifacts are read back from their sealed paths and re-verified", async (t) => {
  const good = Buffer.from("report");
  const h = await harness(t, async () => ({
    artifacts: [
      { path: "report.txt", kind: "text", maxBytes: 100, required: true, status: "captured", sizeBytes: good.length, sha256: sha256(good), textEncoding: "utf8", index: 0, capturedAt: "t" },
      { path: "tampered.bin", kind: "binary", maxBytes: 100, required: false, status: "captured", sizeBytes: 3, sha256: sha256(Buffer.from("abc")), index: 1, capturedAt: "t" },
      { path: "missing.txt", kind: "text", maxBytes: 100, required: false, status: "missing", capturedAt: "t" },
    ],
  }));
  await writeFile(join(h.artifactRoot, "0"), good);
  await writeFile(join(h.artifactRoot, "1"), "xyz");
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  const declarations = [
    { path: "report.txt", kind: "text", maxBytes: 100, required: true },
    { path: "tampered.bin", kind: "binary", maxBytes: 100, required: false },
    { path: "missing.txt", kind: "text", maxBytes: 100, required: false },
  ];
  const [report, tampered, missing] = await h.provider.collectArtifacts(resource, declarations);
  assert.equal(report.status, "captured");
  assert.equal(report.bytes.toString(), "report");
  assert.equal(report.index, undefined);
  assert.equal(tampered.status, "rejected");
  assert.equal(tampered.reason, "changed_during_transfer");
  assert.equal(missing.status, "missing");
  assert.deepEqual(h.jobs[0], { kind: "collect", declarations });
});

test("artifact collection refuses an escaping declaration or manifest before reading", async (t) => {
  const good = Buffer.from("report");
  const h = await harness(t, async () => ({
    // The manifest names another declaration's sealed file.
    artifacts: [{ path: "report.txt", kind: "text", maxBytes: 100, required: true, status: "captured", sizeBytes: good.length, sha256: sha256(good), textEncoding: "utf8", index: 1, capturedAt: "t" }],
  }));
  await writeFile(join(h.artifactRoot, "1"), good);
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  for (const path of ["/etc/passwd", "../outside.txt"]) {
    await assert.rejects(
      h.provider.collectArtifacts(resource, [{ path, kind: "text", maxBytes: 100, required: true }]),
      /must stay inside the workspace/,
    );
  }
  assert.deepEqual(h.jobs, [], "an escaping declaration never reaches the sandbox");
  await assert.rejects(
    h.provider.collectArtifacts(resource, [{ path: "report.txt", kind: "text", maxBytes: 100, required: true }]),
    /escaped its sealed path/,
  );
});

test("egress flows ride the socket to the Guardian", async (t) => {
  const guardian = net.createServer((socket) => socket.pipe(socket));
  await new Promise((ready) => guardian.listen(0, "127.0.0.1", ready));
  t.after(() => guardian.close());
  const h = await harness(t);
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  await resource.attachEgress({
    hosts: ["api.anthropic.com"],
    openUpstream: () => net.connect({ host: "127.0.0.1", port: guardian.address().port }),
  });
  assert.deepEqual(h.jobs[0], { kind: "setup", hosts: ["api.anthropic.com"] });
  const payload = Buffer.alloc(3 * 1024 * 1024, 7);
  const echoed = await new Promise((resolve, reject) => {
    const agent = net.connect({ host: "127.0.0.1", port: h.flowPort });
    const parts = [];
    let received = 0;
    agent.on("data", (chunk) => {
      parts.push(chunk);
      received += chunk.length;
      if (received >= payload.length) { agent.destroy(); resolve(Buffer.concat(parts)); }
    });
    agent.on("error", reject);
    agent.write(payload);
  });
  assert.ok(echoed.equals(payload));
  resource.assertEgressHealthy();
});

test("a flow nobody reads holds back only its own sender, and other flows keep moving", async (t) => {
  // A Guardian that answers the first connection but never reads from it.
  let stalled = null;
  const guardian = net.createServer((socket) => {
    if (!stalled) { stalled = socket; socket.pause(); return; }
    socket.pipe(socket);
  });
  await new Promise((ready) => guardian.listen(0, "127.0.0.1", ready));
  t.after(() => guardian.close());
  const h = await harness(t);
  const resource = await acquire(h.provider);
  t.after(() => resource.close());
  await resource.attachEgress({
    hosts: ["api.anthropic.com"],
    openUpstream: () => net.connect({ host: "127.0.0.1", port: guardian.address().port }),
  });
  const blocked = net.connect({ host: "127.0.0.1", port: h.flowPort });
  await new Promise((ready) => blocked.once("connect", ready));
  let written = 0;
  const feed = () => { while (written < 8 * 1024 * 1024 && blocked.write(Buffer.alloc(64 * 1024, 1))) written += 64 * 1024; };
  blocked.on("drain", feed);
  feed();
  await new Promise((wait) => setTimeout(wait, 200));
  assert.ok(written < 8 * 1024 * 1024, "the stalled flow's sender stopped");
  const echoed = await new Promise((resolve, reject) => {
    const agent = net.connect({ host: "127.0.0.1", port: h.flowPort });
    agent.once("data", (chunk) => { agent.destroy(); resolve(chunk.toString()); });
    agent.on("error", reject);
    agent.write("still flowing");
  });
  assert.equal(echoed, "still flowing");
  blocked.destroy();
});

test("the session survives a relay that tears frames across WebSocket messages", async (t) => {
  // A relay between controller and server that forwards every message in
  // 7-byte pieces, so no yamux frame arrives whole.
  const h = await harness(t);
  const relay = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const WebSocket = createRequire(import.meta.url)("ws");
  const wss = new WebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false });
  relay.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.authorization, "Bearer public-api-test-key");
    const upstream = new WebSocket(`ws://127.0.0.1:${h.port}/`, {
      headers: { authorization: `Bearer ${controlToken}`, "x-sandbox-ca": request.headers["x-sandbox-ca"] },
      perMessageDeflate: false,
    });
    const torn = (from, to) => from.on("message", (data) => {
      for (let offset = 0; offset < data.length; offset += 7) to.send(data.subarray(offset, offset + 7), { binary: true });
    });
    upstream.once("open", () => wss.handleUpgrade(request, socket, head, (client) => {
      torn(client, upstream);
      torn(upstream, client);
      client.once("close", () => upstream.terminate());
      upstream.once("close", () => client.terminate());
    }));
  });
  await new Promise((ready) => relay.listen(0, "127.0.0.1", ready));
  t.after(() => relay.close());
  const provider = createTogetherSocketProvider({
    runUrl: () => `ws://127.0.0.1:${relay.address().port}/`, taskRoot: h.taskRoot, artifactRoot: h.artifactRoot,
  });
  const resource = await provider.acquire({ apiKey: "public-api-test-key", caCertificate: CA });
  t.after(() => resource.close());
  const bytes = Buffer.alloc(300 * 1024, 9);
  await resource.write(join(h.taskRoot, "torn.bin"), bytes);
  assert.ok((await readFile(join(h.taskRoot, "torn.bin"))).equals(bytes));
});

test("disposing closes the connection, which ends the sandbox server's session", async (t) => {
  const h = await harness(t);
  const resource = await acquire(h.provider);
  assert.equal(await h.provider.isDisposed(resource), false);
  await h.provider.dispose(resource);
  assert.equal(await until(() => h.closed() === 1), true);
  assert.equal(await h.provider.isDisposed(resource), true);
  assert.throws(() => resource.assertEgressHealthy());
});

test("cancelling a step ends the connection", async (t) => {
  const h = await harness(t, () => new Promise(() => {}));
  const resource = await acquire(h.provider);
  const controller = new AbortController();
  const step = resource.step({ kind: "agent" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(step, (error) => error.name === "AbortError");
  assert.equal(await until(() => h.closed() === 1), true);
});

test("the Guardian hands a socket workload its flows instead of a relay", async () => {
  const calls = [];
  const workload = {
    attachEgress: async (options) => { calls.push(options); },
    commands: { run: async () => { throw new Error("no exec over the socket"); } },
  };
  const session = { hosts: ["api.anthropic.com"], proxyPort: 1 };
  await createTogetherGuardianController({ findRuntime: () => null }).attach({ workload, session });
  assert.deepEqual(calls[0].hosts, ["api.anthropic.com"]);
  assert.equal(typeof calls[0].openUpstream, "function");
  assert.equal(session.workload, workload);
  assert.equal(session.workloadEnvironment.HTTPS_PROXY, "http://127.0.0.1:18082");
});

test("the local workload honours the sandbox API's command contract", async (t) => {
  const workload = createLocalWorkload();
  let streamed = "";
  const ok = await workload.commands.run("printf hi; printf err >&2", { onStdout: (text) => { streamed += text; } });
  assert.deepEqual(ok, { exitCode: 0, stdout: "hi", stderr: "err" });
  assert.equal(streamed, "hi");
  await assert.rejects(workload.commands.run("echo out; exit 3"), (error) => error.exitCode === 3 && error.stdout === "out\n");
  await assert.rejects(workload.commands.run("sleep 5", { timeoutMs: 50 }), (error) => error.name === "TimeoutError");
  // A timed-out command whose descendant left the process group, as the Agent
  // runner's child does, still returns once the shell is gone.
  const orphaned = "node -e \"require('node:child_process').spawn('sleep', ['5'], { detached: true, stdio: 'inherit' }).unref(); setTimeout(() => {}, 5000)\"";
  const started = Date.now();
  await assert.rejects(workload.commands.run(orphaned, { timeoutMs: 100 }), (error) => error.name === "TimeoutError");
  assert.ok(Date.now() - started < 4_000, "the orphan held the result");
  assert.equal((await workload.commands.run("echo $HURDLE_X", { envs: { HURDLE_X: "y" } })).stdout, "y\n");
  const root = await mkdtemp(join(tmpdir(), "hurdle-local-workload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await workload.files.write([{ path: join(root, "a/b.bin"), data: new Uint8Array([1, 2, 3]).buffer }]);
  assert.deepEqual([...await workload.files.read(join(root, "a/b.bin"), { format: "bytes" })], [1, 2, 3]);
  await workload.files.write(join(root, "c.txt"), "text");
  assert.equal(await workload.files.read(join(root, "c.txt")), "text");
});

test("sandbox setup trusts the Guardian without resolving capture hosts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-sandbox-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caPath = join(root, "guardian-ca.pem");
  await writeFile(caPath, CA);
  const commands = [];
  const workload = {
    commands: {
      run: async (command, options = {}) => {
        commands.push({ command, envs: options.envs });
        return { exitCode: 0, stdout: "GUARDIAN_BRIDGE_READY", stderr: "" };
      },
    },
    files: { write: async () => {} },
  };
  const task = createSandboxTask({ caPath, nodeRuntimeRoot: "/opt/hurdle", workload });
  await task.run({ kind: "setup", hosts: ["api.together.ai"] });
  // The node refuses the sandbox's egress, DNS included: nothing may resolve a host.
  assert.equal(commands.some(({ command }) => command.includes("getaddrinfo")), false);
  // The path to the Guardian is still proven, for the first capture host.
  const preflight = commands.find(({ command }) => command.includes("GUARDIAN_BRIDGE_READY"));
  assert.equal(preflight.envs.HURDLE_CAPTURE_HOST, "api.together.ai");
  assert.ok(commands.some(({ command }) => command.includes("--dport 57468 -j DROP")));
});
