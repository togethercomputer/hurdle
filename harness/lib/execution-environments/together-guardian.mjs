import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asset,
  BRIDGE_PATH,
  CA_BUNDLE_PATH,
  capturePolicy,
  CONTROL_HOST,
  CONTROL_PREFIX,
  drainSealedGuardian,
  installWorkloadTrust,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_ROWS,
  PROCESS_TIMEOUT_MS,
  RELAY_PORT,
  sealedJournalCollection,
  stopProcess,
  waitForPort,
  workloadProxyEnvironment,
} from "./e2b-guardian.mjs";
import { startTogetherControllerRelay } from "./together-controller-relay.mjs";
import {
  findHostGuardianRuntime,
  hostGuardianRuntimeError,
} from "../host-guardian-runtime.mjs";

export const TOGETHER_WORKLOAD_BRIDGE_PORT = 18083;
const PRODUCER = "together-host-guardian";
const PREFLIGHT_HOST = "preflight.hurdle.invalid";

// The current SDK exposes the authenticated agent URL rather than url_format.
// This port substitution has been verified against an actual application port.
// Refuse unfamiliar routing layouts instead of inventing a public endpoint.
// TODO: switch to the SDK's url_format once it ships.
export function togetherApplicationHost(agentUrl, port) {
  const url = new URL(agentUrl);
  if (url.protocol !== "https:" || url.username || url.password
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !/-57468\./.test(url.hostname)) {
    throw new Error("Together application-port routing is unavailable");
  }
  url.hostname = url.hostname.replace("-57468.", `-${port}.`);
  return url.host;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForLocalPort(port, child, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Guardian proxy exited");
    const ready = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Guardian proxy did not start");
}

async function stopLocalProcess(child) {
  if (!child) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // Checked after subscribing, so an exit in between cannot be missed.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

// The control endpoint is served by the proxy itself as a plain-HTTP proxy
// request, exactly as the in-VM Guardian is controlled.
function controlState(port, token, action) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: `http://${CONTROL_HOST}${CONTROL_PREFIX}/${action}`,
      headers: { Host: CONTROL_HOST, "X-Tae-Egress-Control": token, Connection: "close" },
      timeout: 15_000,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`control failed: ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("control timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function readCaCertificate(path) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const certificate = await readFile(path, "utf8");
      if (certificate.includes("BEGIN CERTIFICATE") && !certificate.includes("PRIVATE KEY")) {
        return certificate;
      }
      lastError = new Error("Guardian returned invalid public CA material");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Guardian CA is unavailable");
}

// Runs the egress Guardian on the controller host. Every Together workload
// flow crosses the reverse WebSocket into this proxy; capture hosts keep the
// full journal policy and all other hosts are intercepted as metadata rows.
export function createTogetherGuardianController({
  startRelay = startTogetherControllerRelay,
  findRuntime = findHostGuardianRuntime,
  spawnProcess = spawn,
} = {}) {
  return Object.freeze({
    async prepare({ capture, credentialBindings, credentialValues, surrogates, profile, signal }) {
      if (profile !== "external-guardian-http-metadata-v1") {
        throw new TypeError("unsupported external Guardian capture profile");
      }
      const runtime = findRuntime();
      if (!runtime) throw hostGuardianRuntimeError();
      const { hosts, selectedResponseHeaders, exchangeFacts, blockedRequests } = capturePolicy(capture);
      const substitutions = credentialBindings
        .filter(({ delivery }) => delivery.kind === "captured-http-header")
        .map(({ environmentName, delivery }) => ({
          surrogate: surrogates[environmentName],
          value: credentialValues[environmentName],
          hosts: delivery.hosts,
          headerNames: delivery.headerNames,
        }));
      const directory = await mkdtemp(join(tmpdir(), "hurdle-guardian-"));
      const session = {
        directory,
        journalPath: join(directory, "requests.jsonl"),
        bridgeToken: randomBytes(32).toString("base64url"),
        controlToken: randomBytes(32).toString("base64url"),
        hosts,
        policyFingerprint: exchangeFacts?.policyFingerprint ?? null,
        proxy: null,
        proxyPort: null,
        caCertificate: null,
        workload: null,
        relayProcess: null,
        controllerRelay: null,
        workloadEnvironment: {},
      };
      try {
        session.proxyPort = await freeLoopbackPort();
        session.proxy = spawnProcess(runtime.mitmdump, [
          "-q", "-s", asset("generic_guardian.py"),
          "--listen-host", "127.0.0.1", "--listen-port", String(session.proxyPort),
          "--set", "upstream_cert=false",
          "--set", `confdir=${join(directory, "mitmproxy")}`,
        ], {
          stdio: "ignore",
          // Only the policy reaches the proxy; the host's own proxy and
          // credential variables stay out of the Guardian environment.
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: directory,
            TMPDIR: directory,
            LANG: "C.UTF-8",
            TAE_EGRESS_LOG: session.journalPath,
            TAE_EGRESS_CONTROL_TOKEN: session.controlToken,
            TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(hosts),
            TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify(selectedResponseHeaders),
            TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
            TAE_EGRESS_BLOCKED_REQUESTS: JSON.stringify(blockedRequests),
            TAE_EGRESS_SUBSTITUTIONS: JSON.stringify(substitutions),
            TAE_EGRESS_MAX_ROWS: String(MAX_CAPTURE_ROWS),
            TAE_EGRESS_MAX_BYTES: String(MAX_CAPTURE_BYTES),
            TAE_EGRESS_INTERCEPT_ALL: "1",
          },
        });
        session.proxy.once("error", () => {});
        await waitForLocalPort(session.proxyPort, session.proxy, signal);
        session.caCertificate = await readCaCertificate(
          join(directory, "mitmproxy", "mitmproxy-ca-cert.pem"),
        );
        return session;
      } catch (error) {
        await stopLocalProcess(session.proxy).catch(() => {});
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    },
    async attach({ workload, session, signal }) {
      await installWorkloadTrust(
        workload, session.caCertificate, session.hosts, signal, "-legacy", "DROP",
        { systemTrust: true },
      );
      session.workload = workload;
      // Without the selective proxy every flow, capture host or not, is
      // claimed by the controller over the reverse route.
      session.relayProcess = await workload.commands.run(
        `exec node ${BRIDGE_PATH} reverse-client`,
        {
          background: true,
          timeoutMs: PROCESS_TIMEOUT_MS,
          signal,
          envs: {
            EGRESS_BRIDGE_TRAFFIC_HEADER: "none",
            EGRESS_BRIDGE_CELL_TOKEN: session.bridgeToken,
            EGRESS_BRIDGE_LISTEN_PORT: String(RELAY_PORT),
            EGRESS_BRIDGE_PUBLIC_LISTEN_PORT: String(TOGETHER_WORKLOAD_BRIDGE_PORT),
            TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(session.hosts),
          },
        },
      );
      await waitForPort(workload, RELAY_PORT, "workload relay", signal);
      session.controllerRelay = await startRelay({
        workloadUrl: `wss://${workload.getHost(TOGETHER_WORKLOAD_BRIDGE_PORT)}`,
        cellToken: session.bridgeToken,
        sandboxToken: workload.agentToken ?? null,
        openUpstream: () => net.connect({ host: "127.0.0.1", port: session.proxyPort }),
        signal,
      });
      // Prove the complete loopback -> controller -> Guardian TCP path before
      // starting an Agent. CONNECT opens TLS transport without an API request.
      const checked = await workload.commands.run(String.raw`node - <<'JS'
const socket = require('node:net').createConnection({ host: '127.0.0.1', port: 18082 });
let received = '';
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 10000);
socket.once('connect', () => socket.write('CONNECT ' + process.env.HURDLE_CAPTURE_HOST + ':443 HTTP/1.1\r\nHost: ' + process.env.HURDLE_CAPTURE_HOST + ':443\r\n\r\n'));
socket.on('data', data => {
  received += data.toString();
  if (received.length > 16384) { socket.destroy(); process.exitCode = 1; }
  else if (received.includes('\r\n\r\n')) {
    if (/^HTTP\/1\.[01] 200 /.test(received)) console.log('GUARDIAN_BRIDGE_READY');
    else process.exitCode = 1;
    socket.destroy();
  }
});
socket.once('error', () => { process.exitCode = 1; });
socket.once('close', () => { clearTimeout(timer); if (!/^HTTP\/1\.[01] 200 /.test(received)) process.exitCode = 1; });
JS`, { user: "root", timeoutMs: 15000, signal,
        envs: { HURDLE_CAPTURE_HOST: session.hosts[0] ?? PREFLIGHT_HOST } });
      if (!checked.stdout?.includes("GUARDIAN_BRIDGE_READY")) {
        throw new Error("Together Guardian end-to-end preflight failed");
      }
      session.controllerRelay.assertHealthy();
      // The SDK root-exec endpoint must never be accessible to the Agent.
      await workload.commands.run(`set -eu
for binary in /usr/sbin/iptables-legacy /usr/sbin/ip6tables-legacy; do
  "$binary" --wait 5 -I OUTPUT 1 -p tcp --dport 57468 -j DROP
  "$binary" --wait 5 -C OUTPUT -p tcp --dport 57468 -j DROP
done`, { user: "root", timeoutMs: 10000, signal });
      session.workloadEnvironment = {
        ...workloadProxyEnvironment(session.hosts),
        GIT_SSL_CAINFO: CA_BUNDLE_PATH,
        PIP_CERT: CA_BUNDLE_PATH,
      };
    },
    async seal({ session }) {
      session.controllerRelay.assertHealthy();
      session.controllerRelay.allowShutdown();
      try {
        const state = await drainSealedGuardian(
          (action) => controlState(session.proxyPort, session.controlToken, action),
          { policyFingerprint: session.policyFingerprint },
        );
        await stopProcess(session.workload, session.relayProcess, "workload relay");
        await stopLocalProcess(session.proxy);
        const info = await stat(session.journalPath);
        if (info.size !== state.journalBytes || info.size > MAX_CAPTURE_BYTES) {
          throw new Error("Guardian journal exceeded its sealed byte bound");
        }
        return sealedJournalCollection(state, await readFile(session.journalPath), PRODUCER);
      } finally {
        session.controllerRelay.close();
      }
    },
    async close(session) {
      if (!session) return;
      session.controllerRelay?.close();
      await stopLocalProcess(session.proxy);
      await rm(session.directory, { recursive: true, force: true });
    },
  });
}
