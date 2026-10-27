import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTogetherGuardianController, togetherApplicationHost } from "../lib/execution-environments/together-guardian.mjs";

const JOURNAL_ROW = { kind: "http-request", sequence: 0, method: "GET", scheme: "https", host: "api.example.com", path: "/v1/models", statusCode: 200 };

// A stand-in for mitmdump + generic_guardian.py: it serves the control
// endpoint on the proxy port, writes public CA material and one journal row,
// and records the environment it was started with.
async function fakeMitmdump(t, { badDigest = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-fake-mitmdump-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "mitmdump");
  await writeFile(path, `#!${process.execPath}
const http = require("node:http"), fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--listen-port") + 1]);
const confdir = args.find((value) => value.startsWith("confdir=")).slice("confdir=".length);
fs.writeFileSync(path.join(confdir, "..", "env.json"), JSON.stringify(process.env));
fs.mkdirSync(confdir, { recursive: true });
fs.writeFileSync(path.join(confdir, "mitmproxy-ca-cert.pem"), "-----BEGIN CERTIFICATE-----\\npublic\\n-----END CERTIFICATE-----\\n");
const line = ${JSON.stringify(JSON.stringify(JOURNAL_ROW) + "\n")};
fs.writeFileSync(process.env.TAE_EGRESS_LOG, line, { flag: "wx" });
let sealed = false;
http.createServer((request, response) => {
  if (request.headers["x-tae-egress-control"] !== process.env.TAE_EGRESS_CONTROL_TOKEN) { response.writeHead(403); return response.end(); }
  if (request.url.endsWith("/seal")) sealed = true;
  const digest = ${badDigest} ? "sha256:" + "0".repeat(64) : "sha256:" + crypto.createHash("sha256").update(line).digest("hex");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ sealed, activeFlows: 0, rowCount: 1, journalBytes: Buffer.byteLength(line),
    maxRows: 10000, maxJournalBytes: 15 * 1024 * 1024, maxPathBytes: 4096, truncated: false,
    journalDigest: digest, policyFingerprint: null }));
}).listen(port, "127.0.0.1");
`);
  await chmod(path, 0o755);
  return { mitmdump: path };
}

function fakeWorkload() {
  const commands = [];
  let pid = 100;
  return {
    commands: {
      async run(command, options = {}) {
        commands.push({ command, options });
        if (options.background) return { pid: pid++, kill: async () => {} };
        return { stdout: command.includes("socket.create_connection") ? "READY\n" : "GUARDIAN_BRIDGE_READY", exitCode: 0 };
      },
      list: async () => [],
    },
    files: { write: async () => {} },
    getHost: (port) => `vm-${port}.cluster.example`,
    agentToken: "sandbox-token",
    recorded: commands,
  };
}

const capture = { mode: "network-egress-metadata-v1", protocols: ["http", "https", "wss"], routes: [{ host: "api.example.com", selectedFields: ["x-request-id"] }] };
const credentials = {
  credentialBindings: [{ environmentName: "KEY", delivery: { kind: "captured-http-header", hosts: ["api.example.com"], headerNames: ["authorization"] } }],
  credentialValues: { KEY: "real-key" },
  surrogates: { KEY: "surrogate-key" },
  profile: "external-guardian-http-metadata-v1",
};

test("Together host Guardian runs the proxy locally, routes all workload egress to it, and seals digest-verified evidence", async (t) => {
  const runtime = await fakeMitmdump(t);
  let relay;
  const controller = createTogetherGuardianController({
    findRuntime: () => runtime,
    startRelay: async (options) => {
      relay = { options, closed: false };
      return { assertHealthy() {}, allowShutdown() {}, close() { relay.closed = true; } };
    },
  });
  process.env.HURDLE_TEST_HOST_SECRET = "host-only-secret";
  t.after(() => { delete process.env.HURDLE_TEST_HOST_SECRET; });
  const session = await controller.prepare({ capture, ...credentials, agentCredentials: [{
    environmentName: "CLAUDE_CODE_OAUTH_TOKEN", value: "real-agent-token", surrogate: "agent-surrogate",
    hosts: ["api.anthropic.com"], headerNames: ["authorization"],
  }] });
  const proxyEnvironment = JSON.parse(await readFile(join(session.directory, "env.json"), "utf8"));
  assert.equal(proxyEnvironment.TAE_EGRESS_INTERCEPT_ALL, "1");
  assert.deepEqual(JSON.parse(proxyEnvironment.TAE_EGRESS_SUBSTITUTIONS), [
    { surrogate: "surrogate-key", value: "real-key", hosts: ["api.example.com"], headerNames: ["authorization"] },
    { surrogate: "agent-surrogate", value: "real-agent-token", hosts: ["api.anthropic.com"], headerNames: ["authorization"] },
  ]);
  assert.equal(proxyEnvironment.HURDLE_TEST_HOST_SECRET, undefined, "host variables must not reach the proxy");
  // The Guardian cannot outlive this process or its sandbox's lifetime.
  assert.equal(proxyEnvironment.TAE_EGRESS_EXIT_WITH_CONTROLLER, "1");
  assert.equal(proxyEnvironment.TAE_EGRESS_CLEANUP_DIR, session.directory);
  assert.equal(proxyEnvironment.TAE_EGRESS_MAX_LIFETIME_S, String(70 * 60), "default one-hour lifetime plus grace");
  assert.equal(session.proxy.stdin.writable, true, "stdin is held open for the Guardian's life");

  const workload = fakeWorkload();
  await controller.attach({ workload, session });
  const bridge = workload.recorded.find(({ command }) => command.includes("reverse-client"));
  assert.equal(bridge.options.envs.EGRESS_BRIDGE_TRAFFIC_HEADER, "none");
  assert.equal(bridge.options.envs.EGRESS_BRIDGE_SELECTIVE_PROXY, undefined, "every flow must reach the controller");
  assert.equal(bridge.options.envs.EGRESS_BRIDGE_URL, undefined);
  assert.equal(bridge.options.envs.EGRESS_BRIDGE_PUBLIC_LISTEN_PORT, "18083");
  assert.doesNotMatch(JSON.stringify(workload.recorded), /real-key|real-agent-token|PRIVATE KEY/);
  assert.ok(!JSON.stringify(workload.recorded).includes(session.controlToken), "the control token stays on the host");
  const systemTrust = workload.recorded.find(({ command }) => command.includes("update-ca-certificates"));
  assert.equal(systemTrust.options.user, "root");
  const firewall = workload.recorded.find(({ command }) => command.includes("socket.getaddrinfo"));
  assert.match(firewall.command, /"-legacy"/);
  assert.ok(workload.recorded.some(({ command }) => command.includes("--dport 57468 -j DROP")));
  assert.equal(relay.options.workloadUrl, "wss://vm-18083.cluster.example");
  assert.equal(relay.options.sandboxToken, "sandbox-token");
  assert.equal(relay.options.cellToken, session.bridgeToken);
  const upstream = relay.options.openUpstream();
  await new Promise((resolve, reject) => { upstream.once("connect", resolve); upstream.once("error", reject); });
  upstream.destroy();
  assert.equal(session.workloadEnvironment.HTTPS_PROXY, "http://127.0.0.1:18082");
  assert.equal(session.workloadEnvironment.GIT_SSL_CAINFO, "/tmp/tae-egress/ca-bundle.pem");

  const sealed = await controller.seal({ session });
  assert.equal(sealed.status, "captured");
  assert.equal(sealed.provenance.producer, "together-host-guardian");
  assert.equal(sealed.provenance.trust, "environment-observed");
  assert.deepEqual(sealed.requests, [JOURNAL_ROW]);
  assert.equal(relay.closed, true);
  const port = session.proxyPort;
  await controller.close(session);
  assert.equal(existsSync(session.directory), false);
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  }), /ECONNREFUSED/, "the local proxy is stopped");
});

test("Together host Guardian rejects a journal whose digest does not match the sealed state", async (t) => {
  const controller = createTogetherGuardianController({
    findRuntime: await fakeMitmdump(t, { badDigest: true }).then((runtime) => () => runtime),
    startRelay: async () => ({ assertHealthy() {}, allowShutdown() {}, close() {} }),
  });
  const session = await controller.prepare({ capture, ...credentials });
  t.after(() => controller.close(session));
  await controller.attach({ workload: fakeWorkload(), session });
  await assert.rejects(controller.seal({ session }), /digest mismatch/);
});

test("Together host Guardian's hard stop follows the sandbox lifetime", async (t) => {
  const controller = createTogetherGuardianController({
    findRuntime: await fakeMitmdump(t).then((runtime) => () => runtime),
    startRelay: async () => ({ assertHealthy() {}, allowShutdown() {}, close() {} }),
  });
  const session = await controller.prepare({ capture, ...credentials, maxLifetimeMs: 5 * 60_000 });
  t.after(() => controller.close(session));
  const proxyEnvironment = JSON.parse(await readFile(join(session.directory, "env.json"), "utf8"));
  assert.equal(proxyEnvironment.TAE_EGRESS_MAX_LIFETIME_S, String(15 * 60));
});

test("Together host Guardian fails before allocation when its runtime is not installed", async () => {
  const controller = createTogetherGuardianController({ findRuntime: () => null });
  await assert.rejects(
    controller.prepare({ capture: { mode: "none" }, ...credentials }),
    (error) => error.code === "environment.host-guardian-missing" && /Run setup to install it/.test(error.message),
  );
});

test("Together application port derivation rejects unknown endpoint formats", () => {
  assert.equal(togetherApplicationHost('https://vm-57468.cluster.csb.app', 18083), 'vm-18083.cluster.csb.app');
  assert.equal(togetherApplicationHost('https://vm-57468.cluster.csb.app:8443', 18083), 'vm-18083.cluster.csb.app:8443');
  for (const url of ['http://vm-57468.cluster.csb.app', 'https://arbitrary.example.com', 'https://user:secret@vm-57468.cluster.csb.app'])
    assert.throws(() => togetherApplicationHost(url, 18083), /routing is unavailable/);
});

test("Together application port derivation accepts a local runsb node only when explicitly selected", () => {
  const node = 'http://sb1-57468-dvbx-node1.192-168-2-2.nip.io:57467';
  assert.throws(() => togetherApplicationHost(node, 18083), /routing is unavailable/);
  process.env.HURDLE_TOGETHER_API_URL = 'https://api.bartender.codesandbox.dev';
  try {
    assert.equal(togetherApplicationHost(node, 18083), 'sb1-18083-dvbx-node1.192-168-2-2.nip.io:57467');
    assert.equal(togetherApplicationHost('https://vm-57468.cluster.csb.app', 18083), 'vm-18083.cluster.csb.app');
  } finally {
    delete process.env.HURDLE_TOGETHER_API_URL;
  }
});
