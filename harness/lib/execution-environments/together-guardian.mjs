import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
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
  guardianSubstitutions,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_ROWS,
  PROCESS_TIMEOUT_MS,
  RELAY_PORT,
  sealedJournalCollection,
  stopProcess,
  waitForPort,
  workloadProxyEnvironment,
} from "./guardian.mjs";
import { startTogetherControllerRelay } from "./together-controller-relay.mjs";
import { blockSandboxAgentPort, verifyGuardianPath } from "./together-workload-egress.mjs";
import {
  findHostGuardianRuntime,
  hostGuardianRuntimeError,
} from "../host-guardian-runtime.mjs";
import { togetherUsesLocalControlPlane } from "../together-api-url.mjs";

export const TOGETHER_WORKLOAD_BRIDGE_PORT = 18083;
const PRODUCER = "together-host-guardian";

function workloadEnvironment(hosts) {
  return {
    ...workloadProxyEnvironment(hosts),
    GIT_SSL_CAINFO: CA_BUNDLE_PATH,
    PIP_CERT: CA_BUNDLE_PATH,
  };
}

// The current SDK exposes the authenticated agent URL rather than url_format.
// This port substitution has been verified against an actual application port.
// Refuse unfamiliar routing layouts instead of inventing a public endpoint.
// TODO: switch to the SDK's url_format once it ships.
export function togetherApplicationHost(agentUrl, port) {
  const url = new URL(agentUrl);
  // Together ingress names ports `<id>-<port>.<zone>`; a runsb node addressed
  // directly (devbox) uses `<id>-<port>-<node host>`, over http only when a
  // local control plane was explicitly selected.
  const label = /-57468([.-])/.exec(url.hostname);
  const protocols = togetherUsesLocalControlPlane() ? ["https:", "http:"] : ["https:"];
  if (!protocols.includes(url.protocol) || url.username || url.password
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !label) {
    throw new Error("Together application-port routing is unavailable");
  }
  url.hostname = url.hostname.replace(label[0], `-${port}${label[1]}`);
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

// The Guardian stops on its own this long after its sandbox's lifetime ends,
// leaving time to drain and seal its journal.
const LIFETIME_GRACE_MS = 10 * 60_000;
const DEFAULT_LIFETIME_MS = 60 * 60_000;
const GUARDIAN_DIRECTORY_PREFIX = "hurdle-guardian-";

// A Guardian directory holds the per-run CA key. Ones this old belong to no
// live Guardian, since each stops by its lifetime limit; remove them, for
// example after the machine lost power mid-run.
export async function sweepStaleGuardianDirectories(root = tmpdir(), { now = Date.now(), maxAgeMs = 26 * 60 * 60_000 } = {}) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GUARDIAN_DIRECTORY_PREFIX)) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > maxAgeMs) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
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
    async prepare({
      capture, credentialBindings, credentialValues, surrogates, profile, signal,
      agentCredentials = [], maxLifetimeMs = DEFAULT_LIFETIME_MS,
    }) {
      if (profile !== "external-guardian-http-metadata-v1") {
        throw new TypeError("unsupported external Guardian capture profile");
      }
      const runtime = findRuntime();
      if (!runtime) throw hostGuardianRuntimeError();
      const { hosts, selectedResponseHeaders, exchangeFacts, blockedRequests } = capturePolicy(capture);
      // The Agent's own model credentials are swapped like captured Task
      // credentials: the workload holds stand-ins and the real values exist
      // only in this host process. Intercept-all forwards every host, so the
      // model hosts need no separate pass-through route here.
      const { substitutions } = guardianSubstitutions({
        credentialBindings,
        credentialValues,
        surrogates,
        agentCredentials,
        captureHosts: hosts,
      });
      await sweepStaleGuardianDirectories();
      const directory = await mkdtemp(join(tmpdir(), GUARDIAN_DIRECTORY_PREFIX));
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
          // stdin stays open for the Guardian's life: when this process ends,
          // however it ends, the pipe closes and the Guardian exits with it.
          stdio: ["pipe", "ignore", "ignore"],
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
            TAE_EGRESS_EXIT_WITH_CONTROLLER: "1",
            TAE_EGRESS_CLEANUP_DIR: directory,
            TAE_EGRESS_MAX_LIFETIME_S: String(Math.ceil((maxLifetimeMs + LIFETIME_GRACE_MS) / 1000)),
          },
        });
        session.proxy.once("error", () => {});
        session.proxy.stdin?.on("error", () => {});
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
      if (typeof workload.attachEgress === "function") {
        // Together's Hurdle API: the workload's only transport is one socket,
        // which carries every flow to the Guardian, and the server inside the
        // sandbox seals its own egress with the same steps as below.
        session.workload = workload;
        await workload.attachEgress({
          hosts: session.hosts,
          openUpstream: () => net.connect({ host: "127.0.0.1", port: session.proxyPort }),
          signal,
        });
        session.workloadEnvironment = workloadEnvironment(session.hosts);
        return;
      }
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
        workloadUrl: `${workload.applicationWebSocketScheme ?? "wss"}://${workload.getHost(TOGETHER_WORKLOAD_BRIDGE_PORT)}`,
        cellToken: session.bridgeToken,
        sandboxToken: workload.agentToken ?? null,
        openUpstream: () => net.connect({ host: "127.0.0.1", port: session.proxyPort }),
        signal,
      });
      await verifyGuardianPath(workload, session.hosts[0], signal);
      session.controllerRelay.assertHealthy();
      await blockSandboxAgentPort(workload, signal);
      session.workloadEnvironment = workloadEnvironment(session.hosts);
    },
    async seal({ session }) {
      // A socket workload carries its flows itself; there is no relay to drain.
      session.controllerRelay?.assertHealthy();
      session.controllerRelay?.allowShutdown();
      session.workload?.assertEgressHealthy?.();
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
        session.controllerRelay?.close();
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
