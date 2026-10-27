import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";

process.env.TAE_EGRESS_CAPTURE_HOSTS = JSON.stringify([
  "api.together.ai",
  "api.together.xyz",
  "api-inference.together.ai",
]);
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BRIDGE = join(REPO, "harness", "verify", "proxy", "tcp_ws_bridge.cjs");
const NODE_PATH = join(REPO, "harness", "node_modules");
const require = createRequire(import.meta.url);
const { isPublicIpAddress, resolvePublicDestination } = require(BRIDGE);

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startBridge(mode, env) {
  const child = spawn(process.execPath, [BRIDGE, mode], {
    env: { ...process.env, NODE_PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, getStderr: () => stderr, getStdout: () => stdout };
}

async function waitReady(process, timeoutMs = 5_000) {
  const started = Date.now();
  while (!process.getStdout().includes("READY")) {
    if (process.child.exitCode !== null) {
      throw new Error(`bridge exited ${process.child.exitCode}: ${process.getStderr()}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`bridge readiness timed out: ${process.getStderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function roundTrip(port, payload) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`round trip timed out after ${received}/${payload.length} bytes`));
    }, 5_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= payload.length) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (received < payload.length) {
        clearTimeout(timer);
        reject(new Error(`connection closed after ${received}/${payload.length} bytes`));
      }
    });
  });
}

async function delayedRoundTrip(port, payload, delayMs) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`delayed round trip timed out after ${received}/${payload.length} bytes`));
    }, 5_000);
    socket.on("connect", () => setTimeout(() => socket.write(payload), delayMs));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= payload.length) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (received < payload.length) {
        clearTimeout(timer);
        reject(new Error(`connection closed after ${received}/${payload.length} bytes`));
      }
    });
  });
}

async function readToEnd(port, timeoutMs = 5_000) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("response timed out before EOF"));
    }, timeoutMs);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function proxyTunnelRoundTrip(port, authority, payload, { coalesce = false } = {}) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = Buffer.alloc(0);
    let tunnelReady = false;
    const echoed = [];
    let echoedBytes = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("selective proxy tunnel timed out"));
    }, 5_000);
    const preamble = Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    socket.on("connect", () => socket.write(
      coalesce ? Buffer.concat([preamble, payload]) : preamble,
    ));
    socket.on("data", (chunk) => {
      if (!tunnelReady) {
        response = Buffer.concat([response, chunk]);
        const boundary = response.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        assert.match(response.subarray(0, boundary).toString("latin1"), /^HTTP\/1\.1 200 /);
        tunnelReady = true;
        const remainder = response.subarray(boundary + 4);
        if (remainder.length > 0) {
          echoed.push(remainder);
          echoedBytes += remainder.length;
        }
        if (!coalesce) socket.write(payload);
      } else {
        echoed.push(chunk);
        echoedBytes += chunk.length;
      }
      if (tunnelReady && echoedBytes >= payload.length) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(echoed).subarray(0, payload.length));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (!tunnelReady || echoedBytes < payload.length) {
        clearTimeout(timer);
        reject(new Error("selective proxy tunnel closed early"));
      }
    });
  });
}

async function stopBridge(process) {
  if (!process || process.child.exitCode !== null) return;
  process.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.child.exitCode === null) process.child.kill("SIGKILL");
}

test("TCP-over-WebSocket bridge preserves sequential and large binary streams", async () => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echoServer);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  const cellToken = randomBytes(32).toString("base64url");
  let guardian = null;
  let agent = null;
  try {
    guardian = startBridge("server", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(targetPort),
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
    });
    await waitReady(agent);

    for (let index = 0; index < 5; index += 1) {
      const payload = Buffer.from(`sequential-${index}-${"x".repeat(index * 97)}`);
      assert.deepEqual(await roundTrip(agentPort, payload), payload);
    }
    const large = randomBytes(2 * 1024 * 1024);
    assert.deepEqual(await roundTrip(agentPort, large), large);
    assert.equal(guardian.child.exitCode, null, guardian.getStderr());
    assert.equal(agent.child.exitCode, null, agent.getStderr());
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => echoServer.close(resolve));
  }
});

test("Together bridge uses per-cell authentication without an SDK or traffic token", async () => {
  const echo = net.createServer(socket => socket.pipe(socket));
  const targetPort = await listen(echo);
  const guardianPort = await freePort(), agentPort = await freePort();
  const token = randomBytes(32).toString('base64url');
  let guardian, agent;
  try {
    guardian = startBridge('server', { EGRESS_BRIDGE_CELL_TOKEN: token,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort), EGRESS_BRIDGE_TARGET_PORT: String(targetPort) });
    await waitReady(guardian);
    agent = startBridge('client', { EGRESS_BRIDGE_CELL_TOKEN: token,
      EGRESS_BRIDGE_TRAFFIC_HEADER: 'none', EGRESS_BRIDGE_TRAFFIC_TOKEN: '',
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`, EGRESS_BRIDGE_LISTEN_PORT: String(agentPort) });
    await waitReady(agent);
    const bytes = randomBytes(256 * 1024);
    assert.deepEqual(await roundTrip(agentPort, bytes), bytes);
  } finally {
    await stopBridge(agent); await stopBridge(guardian);
    await new Promise(resolve => echo.close(resolve));
  }
});

test("TCP-over-WebSocket bridge does not impose a simultaneous connection cap", async () => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echoServer);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  const cellToken = randomBytes(32).toString("base64url");
  let guardian = null;
  let agent = null;
  try {
    guardian = startBridge("server", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(targetPort),
      EGRESS_BRIDGE_MAX_ACTIVE: "1",
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
      EGRESS_BRIDGE_MAX_ACTIVE: "1",
    });
    await waitReady(agent);

    const payloads = Array.from({ length: 12 }, (_, index) => Buffer.from(`parallel-${index}`));
    const responses = await Promise.all(payloads.map((payload) => roundTrip(agentPort, payload)));
    assert.deepEqual(responses, payloads);
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => echoServer.close(resolve));
  }
});

test("TCP-over-WebSocket bridge does not cap cumulative connection count", async () => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echoServer);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  const cellToken = randomBytes(32).toString("base64url");
  let guardian = null;
  let agent = null;
  try {
    guardian = startBridge("server", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(targetPort),
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
    });
    await waitReady(agent);

    for (let index = 0; index < 70; index += 1) {
      const payload = Buffer.from(`unlimited-${index}`);
      assert.deepEqual(await roundTrip(agentPort, payload), payload);
    }
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => echoServer.close(resolve));
  }
});

test("guardian bridge drains a large final response before propagating TCP EOF", async () => {
  const payload = randomBytes(2 * 1024 * 1024);
  const responseServer = net.createServer((socket) => socket.end(payload));
  const targetPort = await listen(responseServer);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  const cellToken = randomBytes(32).toString("base64url");
  let guardian = null;
  let agent = null;
  try {
    guardian = startBridge("server", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(targetPort),
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
    });
    await waitReady(agent);

    assert.deepEqual(await readToEnd(agentPort), payload);
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => responseServer.close(resolve));
  }
});

test("guardian bridge rejects an incorrect per-cell data token", async () => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echoServer);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  let guardian = null;
  let agent = null;
  try {
    guardian = startBridge("server", {
      EGRESS_BRIDGE_CELL_TOKEN: "correct-cell-token",
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(targetPort),
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: "wrong-cell-token",
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
    });
    await waitReady(agent);

    await assert.rejects(roundTrip(agentPort, Buffer.from("must-not-cross")));
    assert.equal(guardian.child.exitCode, null, guardian.getStderr());
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => echoServer.close(resolve));
  }
});

test("guardian bridge does not impose byte, idle, or fixed-lifetime leases", async () => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echoServer);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  const cellToken = randomBytes(32).toString("base64url");
  let guardian = null;
  let agent = null;
  try {
    const limits = {
      EGRESS_BRIDGE_MAX_BYTES: "1024",
      EGRESS_BRIDGE_IDLE_TIMEOUT_MS: "100",
      EGRESS_BRIDGE_LIFETIME_MS: "1000",
    };
    guardian = startBridge("server", {
      ...limits,
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(targetPort),
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      ...limits,
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
    });
    await waitReady(agent);

    const payload = randomBytes(2048);
    assert.deepEqual(await delayedRoundTrip(agentPort, payload, 1_200), payload);
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => echoServer.close(resolve));
  }
});

test("selective agent proxy rejects a loopback CONNECT destination", async () => {
  let targetConnections = 0;
  const target = net.createServer((socket) => {
    targetConnections += 1;
    socket.pipe(socket);
  });
  const targetPort = await listen(target);
  const agentPort = await freePort();
  let agent = null;
  try {
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: "unused-cell-token",
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "unused-edge-token",
      EGRESS_BRIDGE_URL: "ws://127.0.0.1:1/proxy",
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
      EGRESS_BRIDGE_SELECTIVE_PROXY: "1",
    });
    await waitReady(agent);

    await assert.rejects(
      proxyTunnelRoundTrip(agentPort, `127.0.0.1:${targetPort}`, Buffer.from("must-not-cross")),
    );
    assert.equal(targetConnections, 0);
  } finally {
    await stopBridge(agent);
    await new Promise((resolve) => target.close(resolve));
  }
});

test("direct proxy rejects a hostname if any DNS answer is non-public", async () => {
  let lookupCalls = 0;
  await assert.rejects(
    resolvePublicDestination(
      { host: "public-looking.example", port: 443 },
      async (host, options) => {
        lookupCalls += 1;
        assert.equal(host, "public-looking.example");
        assert.deepEqual(options, { all: true, verbatim: true });
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ];
      },
    ),
    /non-public address/,
  );
  assert.equal(lookupCalls, 1);
});

test("direct proxy rejects private, link-local, metadata, and reserved addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "168.63.129.16",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "100:0:0:1::1",
    "2001:5::1",
    "2001:db8::1",
    "4000::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress("93.184.216.34"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("direct proxy pins a hostname to its validated public DNS answer", async () => {
  const destination = await resolvePublicDestination(
    { host: "public.example", port: 8443 },
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  assert.deepEqual(destination, {
    host: "93.184.216.34",
    family: 4,
    port: 8443,
  });

  const literal = await resolvePublicDestination(
    { host: "1.1.1.1", port: 443 },
    async () => {
      throw new Error("IP literals must not be resolved again");
    },
  );
  assert.deepEqual(literal, {
    host: "1.1.1.1",
    family: 4,
    port: 443,
  });
});

test("selective agent proxy routes exact Together destinations without cumulative caps", async () => {
  let guardianConnections = 0;
  const guardianTarget = net.createServer((socket) => {
    guardianConnections += 1;
    socket.pipe(socket);
  });
  const guardianTargetPort = await listen(guardianTarget);
  const guardianPort = await freePort();
  const agentPort = await freePort();
  const cellToken = randomBytes(32).toString("base64url");
  let guardian = null;
  let agent = null;
  try {
    guardian = startBridge("server", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_LISTEN_PORT: String(guardianPort),
      EGRESS_BRIDGE_TARGET_PORT: String(guardianTargetPort),
    });
    await waitReady(guardian);
    agent = startBridge("client", {
      EGRESS_BRIDGE_CELL_TOKEN: cellToken,
      EGRESS_BRIDGE_TRAFFIC_TOKEN: "test-edge-token",
      EGRESS_BRIDGE_URL: `ws://127.0.0.1:${guardianPort}/proxy`,
      EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
      EGRESS_BRIDGE_SELECTIVE_PROXY: "1",
    });
    await waitReady(agent);

    const togetherConnect = Buffer.from(
      "CONNECT api.together.xyz:443 HTTP/1.1\r\n"
      + "Host: api.together.xyz\r\n"
      + "Connection: close\r\n"
      + "Proxy-Connection: keep-alive\r\n\r\n",
    );
    assert.deepEqual(await roundTrip(agentPort, togetherConnect), togetherConnect);
    assert.deepEqual(await roundTrip(agentPort, togetherConnect), togetherConnect);
    assert.equal(guardianConnections, 2);

    const lookalike = Buffer.from(
      "CONNECT api.together.xyz.attacker.test:443 HTTP/1.1\r\n"
      + "Host: api.together.xyz.attacker.test:443\r\n\r\n",
    );
    await assert.rejects(roundTrip(agentPort, lookalike));
    assert.equal(guardianConnections, 2, "Together lookalikes must fail closed, never route direct");

    const conflictingAuthority = Buffer.from(
      "CONNECT api.together.xyz:443 HTTP/1.1\r\n"
      + "Host: 127.0.0.1:8443\r\n\r\n",
    );
    await assert.rejects(roundTrip(agentPort, conflictingAuthority));
    assert.equal(guardianConnections, 2, "conflicting proxy authorities must not reach either route");
    assert.equal(guardianConnections, 2, "non-Together traffic must not consume the guardian lease");
  } finally {
    await stopBridge(agent);
    await stopBridge(guardian);
    await new Promise((resolve) => guardianTarget.close(resolve));
  }
});

async function reverseFixture(t, upstream) {
  const targetPort = await listen(upstream);
  const agentPort = await freePort(), controlPort = await freePort();
  const token = randomBytes(32).toString('base64url');
  // No selective proxy and no guardian URL: every flow is claimed by the
  // controller, which pipes it into the controller-host Guardian over TCP.
  const agent = startBridge('reverse-client', { EGRESS_BRIDGE_CELL_TOKEN: token,
    EGRESS_BRIDGE_TRAFFIC_HEADER: 'none', EGRESS_BRIDGE_LISTEN_PORT: String(agentPort),
    EGRESS_BRIDGE_PUBLIC_LISTEN_PORT: String(controlPort) });
  let relay;
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    relay?.close(); await stopBridge(agent);
    for (const socket of sockets) socket.destroy();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
  });
  await waitReady(agent);
  // Both listeners must be live, regardless of which READY line arrives first.
  while (!agent.getStdout().includes('READY client') || !agent.getStdout().includes('READY reverse'))
    await new Promise(resolve => setTimeout(resolve, 10));
  const { startTogetherControllerRelay } = await import('../lib/execution-environments/together-controller-relay.mjs');
  const connect = async (cellToken = token, signal) => {
    relay = await startTogetherControllerRelay({ cellToken, signal, sandboxToken: 'sandbox-token',
      workloadUrl: `ws://127.0.0.1:${controlPort}`,
      openUpstream: () => net.connect({ host: '127.0.0.1', port: targetPort }) });
    return relay;
  };
  return { connect, agentPort, agent, upstream, sockets };
}

test('Together controller reverse relay preserves parallel binary streams and fails closed on cancellation', async t => {
  const fixture = await reverseFixture(t, net.createServer(socket => socket.pipe(socket)));
  await assert.rejects(fixture.connect('wrong-cell-token'), /handshake|authenticated/);
  await assert.rejects(roundTrip(fixture.agentPort, Buffer.from('no authenticated controller')), /closed|ECONNRESET/);
  const abort = new AbortController();
  const relay = await fixture.connect(undefined, abort.signal);
  await Promise.all(Array.from({ length: 12 }, async () => {
    const bytes = randomBytes(3 * 1024 * 1024);
    assert.deepEqual(await roundTrip(fixture.agentPort, bytes), bytes);
  }));
  relay.assertHealthy();
  abort.abort();
  assert.throws(() => relay.assertHealthy(), /authenticated transport/);
  await assert.rejects(roundTrip(fixture.agentPort, Buffer.from('cancelled')), /closed|ECONNRESET/);
});

test('Together controller reverse relay drains a large final response before EOF', async t => {
  const payload = randomBytes(8 * 1024 * 1024);
  const fixture = await reverseFixture(t, net.createServer(socket => socket.end(payload)));
  const relay = await fixture.connect();
  assert.deepEqual(await readToEnd(fixture.agentPort, 10000), payload);
  relay.assertHealthy();
});

test('Together controller relay marks a missing Guardian leg unhealthy and rejects the workload flow', async t => {
  const fixture = await reverseFixture(t, net.createServer(socket => socket.pipe(socket)));
  const relay = await fixture.connect();
  await new Promise(resolve => fixture.upstream.close(resolve));
  await assert.rejects(roundTrip(fixture.agentPort, Buffer.from('missing guardian')), /closed|ECONNRESET/);
  assert.throws(() => relay.assertHealthy(), /authenticated transport/);
});


test('Together controller keeps other channels alive when a client stops reading a response', async t => {
  const block = randomBytes(64 * 1024);
  const fixture = await reverseFixture(t, net.createServer(socket => {
    const timer = setInterval(() => { if (!socket.destroyed) socket.write(block); }, 1);
    socket.on('error', () => {}); socket.once('close', () => clearInterval(timer));
  }));
  const relay = await fixture.connect();
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: fixture.agentPort });
      socket.once('data', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    relay.assertHealthy();
  }
});
