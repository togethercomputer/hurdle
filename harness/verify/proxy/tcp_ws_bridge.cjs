"use strict";

// A small TCP-over-WebSocket bridge for the egress guardian. Sandbox public
// URLs carry HTTP/WebSocket traffic, so the evaluated sandbox exposes a
// loopback TCP proxy and this bridge transports each TCP connection to the
// guardian (E2B: a guardian VM; Together: the controller host, which claims
// flows over the reverse route) without placing controller credentials there.

const { timingSafeEqual } = require("node:crypto");
const dns = require("node:dns");
const http = require("node:http");
const net = require("node:net");

const MODE = process.argv[2];
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const LOW_BUFFER_BYTES = MAX_BUFFER_BYTES / 2;
const GRACEFUL_CLOSE_TIMEOUT_MS = 30_000;
const PROXY_HEADER_MAX_BYTES = 16 * 1024;
const PROXY_HEADER_TIMEOUT_MS = 10_000;
let WebSocket;
let WebSocketServer;
function configuredCaptureHosts() {
  if (process.env.TAE_EGRESS_CAPTURE_HOSTS === undefined) return new Set();
  try {
    const values = JSON.parse(process.env.TAE_EGRESS_CAPTURE_HOSTS);
    if (!Array.isArray(values)) throw new Error("invalid host list");
    return new Set(values.map((value) => String(value).toLowerCase()));
  } catch {
    return new Set();
  }
}
const CAPTURE_HOSTS = configuredCaptureHosts();
const NON_PUBLIC_IPV4S = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPV4S.addSubnet(network, prefix, "ipv4");
}
const NON_PUBLIC_IPV6S = new net.BlockList();
for (const [network, prefix] of [
  // Global unicast currently occupies 2000::/3. Reject the complement before
  // applying the special-purpose exclusions within that allocation.
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_IPV6S.addSubnet(network, prefix, "ipv6");
}

function required(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadWebSocketRuntime() {
  WebSocket ||= require("ws");
  WebSocketServer ||= WebSocket.WebSocketServer;
}

function integer(name, fallback, { min = 1, max = 65_535 } = {}) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function tokenMatches(expected, candidate) {
  if (typeof candidate !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

function couple(tcp, ws, onClosed) {
  let closed = false;
  let tcpPaused = false;
  let wsPaused = false;
  let closeTimer = null;

  function finish() {
    if (closed) return;
    closed = true;
    if (closeTimer) clearTimeout(closeTimer);
    tcp.destroy();
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    onClosed();
  }

  function beginClose() {
    if (closed) return;
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    tcp.end();
    // ws.close() queues its close frame behind pending binary frames. Keep the
    // tunnel alive while those frames drain; destroying it when the upstream
    // TCP socket closes can truncate a large final HTTP response.
    closeTimer ||= setTimeout(finish, GRACEFUL_CLOSE_TIMEOUT_MS).unref();
  }

  function websocketClosed() {
    if (closed) return;
    tcp.end();
    if (tcp.destroyed) return finish();
    closeTimer ||= setTimeout(finish, GRACEFUL_CLOSE_TIMEOUT_MS).unref();
  }

  function tcpClosed() {
    if (closed) return;
    if (ws.readyState === WebSocket.CLOSED || !closeTimer) return finish();
    // A clean TCP EOF starts WebSocket shutdown, but the TCP close event may
    // arrive before queued WebSocket frames reach the peer. websocketClosed()
    // or the bounded graceful-close timer owns cleanup in that case.
  }

  tcp.on("data", (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return finish();
    if (ws.bufferedAmount > MAX_BUFFER_BYTES && !tcpPaused) {
      tcpPaused = true;
      tcp.pause();
    }
    ws.send(chunk, { binary: true, compress: false }, (error) => {
      if (error) return finish();
      if (tcpPaused && ws.bufferedAmount <= LOW_BUFFER_BYTES) {
        tcpPaused = false;
        tcp.resume();
      }
    });
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return finish();
    if (!tcp.write(data) && !wsPaused) {
      wsPaused = true;
      ws._socket?.pause();
      tcp.once("drain", () => {
        wsPaused = false;
        ws._socket?.resume();
      });
    }
  });

  tcp.on("end", beginClose);
  ws.on("close", websocketClosed);
  tcp.on("close", tcpClosed);
  tcp.on("error", finish);
  ws.on("error", finish);
}

function coupleTcp(left, right, onClosed, {
  initialLeftToRight = Buffer.alloc(0),
  initialRightToLeft = Buffer.alloc(0),
} = {}) {
  let closed = false;

  function finish() {
    if (closed) return;
    closed = true;
    left.destroy();
    right.destroy();
    onClosed();
  }

  function forward(source, target) {
    source.on("data", (chunk) => {
      if (!target.write(chunk)) {
        source.pause();
        target.once("drain", () => source.resume());
      }
    });
  }

  forward(left, right);
  forward(right, left);
  for (const socket of [left, right]) {
    socket.on("end", () => {
      if (socket === left) right.end();
      else left.end();
    });
    socket.on("error", finish);
    socket.on("close", () => {
      if (left.destroyed && right.destroyed) finish();
    });
  }

  if (initialLeftToRight.length > 0) {
    right.write(initialLeftToRight);
  }
  if (initialRightToLeft.length > 0) {
    left.write(initialRightToLeft);
  }
  left.resume();
  right.resume();
}

function parseAuthority(value, defaultPort = null) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 512 || /[@\\/%\0\r\n\t ]/.test(raw) || raw.endsWith(".")) return null;
  let host;
  let portText;
  if (raw.startsWith("[")) {
    const match = raw.match(/^\[([0-9a-f:.]+)\](?::([0-9]{1,5}))?$/i);
    if (!match || net.isIP(match[1]) !== 6) return null;
    host = match[1].toLowerCase();
    portText = match[2];
  } else {
    const match = raw.match(/^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i);
    if (!match) return null;
    host = match[1].toLowerCase();
    portText = match[2];
    if (net.isIP(host) !== 4) {
      const labels = host.split(".");
      if (labels.some((label) => !label || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
    }
  }
  const port = Number(portText || defaultPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

function sameDestination(left, right) {
  return Boolean(left && right && left.host === right.host && left.port === right.port);
}

function isPublicIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC_IPV4S.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC_IPV6S.check(address, "ipv6");
  return false;
}

async function resolvePublicDestination(destination, lookup = dns.promises.lookup) {
  const host = destination?.host;
  const port = destination?.port;
  if (
    typeof host !== "string"
    || host.length === 0
    || host.length > 512
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new Error("direct proxy destination is invalid");
  }
  const literalFamily = net.isIP(host);
  // Resolve once and pin the subsequent socket to a validated numeric address.
  // Rejecting a mixed public/private answer set prevents DNS rebinding and
  // split-horizon aliases from selecting an internal address on a retry.
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookup(host, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64) {
    throw new Error("direct proxy destination did not resolve to a bounded address set");
  }
  const canonical = addresses.map(({ address, family }) => {
    const actualFamily = net.isIP(address);
    if (
      (family !== 4 && family !== 6)
      || actualFamily !== family
      || !isPublicIpAddress(address)
    ) {
      throw new Error("direct proxy destination resolved to a non-public address");
    }
    return { address, family };
  });
  const selected = canonical.find(({ family }) => family === 4) || canonical[0];
  return {
    host: selected.address,
    family: selected.family,
    port,
  };
}

function captureDestinationKind({ host, port }) {
  if (CAPTURE_HOSTS.has(host)) return port === 443 ? "guardian" : "reject";
  if ([...CAPTURE_HOSTS].some((allowed) => host.endsWith(`.${allowed}`) || host.startsWith(`${allowed}.`))) {
    return "reject";
  }
  return "direct";
}

function parseProxyPreamble(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerBytes = buffer.subarray(0, headerEnd + 4);
  const bodyPrefix = buffer.subarray(headerEnd + 4);
  const headerText = headerBytes.toString("latin1");
  const lines = headerText.slice(0, -4).split("\r\n");
  const requestLine = lines.shift() || "";
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) return { kind: "reject" };
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name || headers.has(name)) return { kind: "reject" };
    headers.set(name, value);
  }

  const connect = requestLine.match(/^CONNECT ([^ ]+) HTTP\/1\.[01]$/);
  if (connect) {
    const destination = parseAuthority(connect[1]);
    const hostHeader = headers.get("host");
    // Undici's ProxyAgent emits `CONNECT host:443` with `Host: host` (the
    // default port omitted). Resolve an omitted Host port to the explicit
    // CONNECT destination port, then still require exact agreement.
    const hostDestination = hostHeader === undefined
      ? destination
      : parseAuthority(hostHeader, destination?.port);
    if (!sameDestination(destination, hostDestination)) return { kind: "reject" };
    return {
      bodyPrefix,
      destination,
      guardianBytes: buffer,
      kind: captureDestinationKind(destination),
      tunnel: true,
    };
  }

  const absolute = requestLine.match(/^([A-Z]+) (http:\/\/[^ ]+) HTTP\/(1\.[01])$/);
  if (!absolute) return { kind: "reject" };
  let url;
  try {
    url = new URL(absolute[2]);
  } catch {
    return { kind: "reject" };
  }
  if (url.protocol !== "http:" || url.username || url.password || url.hash) return { kind: "reject" };
  const destination = parseAuthority(url.host, 80);
  const hostDestination = parseAuthority(headers.get("host"), 80);
  if (!sameDestination(destination, hostDestination)) return { kind: "reject" };
  const kind = captureDestinationKind(destination);
  if (kind !== "direct") return { kind: "reject" };
  const rewrittenLines = [`${absolute[1]} ${url.pathname}${url.search} HTTP/${absolute[3]}`];
  for (const [name, value] of headers) {
    if (name === "proxy-authorization" || name === "proxy-connection") continue;
    rewrittenLines.push(`${name}: ${value}`);
  }
  return {
    bodyPrefix: Buffer.concat([Buffer.from(`${rewrittenLines.join("\r\n")}\r\n\r\n`, "latin1"), bodyPrefix]),
    destination,
    kind,
    tunnel: false,
  };
}

function installShutdown(close) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    close();
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function runServer() {
  loadWebSocketRuntime();
  const listenPort = integer("EGRESS_BRIDGE_LISTEN_PORT", 18081);
  const targetPort = integer("EGRESS_BRIDGE_TARGET_PORT", 18080);
  const cellToken = required("EGRESS_BRIDGE_CELL_TOKEN");

  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("ok\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });

  function reject(socket, status, message) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on("upgrade", (request, socket, head) => {
    // A peer may reset a rejected upgrade; never let that crash the bridge.
    socket.on("error", () => socket.destroy());
    if (request.url !== "/proxy") return reject(socket, 404, "Not Found");
    if (!tokenMatches(cellToken, request.headers["x-together-egress-cell-token"])) {
      return reject(socket, 401, "Unauthorized");
    }
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket));
  });

  wss.on("connection", (websocket) => {
    const upstream = net.createConnection({ host: "127.0.0.1", port: targetPort });
    couple(upstream, websocket, () => {});
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", (error) => {
    process.stderr.write(`bridge server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(listenPort, "0.0.0.0", () => {
    process.stdout.write(`READY server ${listenPort}\n`);
  });
  installShutdown(() => {
    server.close();
    for (const websocket of wss.clients) websocket.terminate();
  });
}

// Together guests cannot reach their public preview routes. A controller
// claims each paused TCP flow over an authenticated inbound WebSocket instead.
// The Agent never receives this token or access to the Guardian journal.
function createReverseRoute(cellToken) {
  const port = integer("EGRESS_BRIDGE_PUBLIC_LISTEN_PORT", 18083);
  const pending = new Map();
  let controller = null;
  const server = http.createServer((_request, response) => {
    response.writeHead(404); response.end();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  server.on("upgrade", (request, socket, head) => {
    // A late relay leg for an expired flow is rejected; a reset on that
    // socket must not take down every other flow in the workload.
    socket.on("error", () => socket.destroy());
    if (!tokenMatches(cellToken, request.headers["x-together-egress-cell-token"])) return reject(socket, 401);
    if (request.url === "/control") {
      if (controller) return reject(socket, 409);
      wss.handleUpgrade(request, socket, head, websocket => {
        controller = websocket;
        websocket.on("error", () => websocket.terminate());
        websocket.on("message", () => websocket.terminate());
        websocket.once("close", () => {
          controller = null;
          for (const flow of pending.values()) flow.fail();
          for (const peer of wss.clients) peer.terminate();
        });
      });
      return;
    }
    const match = /^\/relay\/([a-f0-9]{32})$/.exec(request.url ?? "");
    const flow = match && pending.get(match[1]);
    if (!controller || !flow) return reject(socket, 404);
    pending.delete(match[1]);
    clearTimeout(flow.timer);
    wss.handleUpgrade(request, socket, head, websocket => {
      flow.downstream.removeListener("close", flow.fail);
      flow.downstream.removeListener("error", flow.fail);
      if (flow.initialBytes?.length) flow.downstream.unshift(flow.initialBytes);
      couple(flow.downstream, websocket, flow.release);
      flow.downstream.resume();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", () => { process.exitCode = 1; server.close(); });
  server.listen(port, "0.0.0.0", () => process.stdout.write(`READY reverse ${port}\n`));
  installShutdown(() => {
    server.close();
    for (const flow of pending.values()) flow.fail();
    for (const peer of wss.clients) peer.terminate();
  });
  return (downstream, initialBytes, release) => {
    if (!controller || controller.readyState !== WebSocket.OPEN || pending.size >= 128) return release();
    const id = require("node:crypto").randomBytes(16).toString("hex");
    const fail = () => { clearTimeout(flow.timer); pending.delete(id); release(); };
    const flow = { downstream, initialBytes, release, fail, timer: setTimeout(fail, 10000).unref() };
    pending.set(id, flow);
    downstream.once("close", fail); downstream.once("error", fail);
    controller.send(JSON.stringify({ kind: "open", id }), error => { if (error) fail(); });
  };
}

function runClient(reverse = false) {
  loadWebSocketRuntime();
  const listenPort = integer("EGRESS_BRIDGE_LISTEN_PORT", 8080);
  // A reverse client never dials out: the controller claims each flow.
  const guardianUrl = reverse ? null : required("EGRESS_BRIDGE_URL");
  // Together's application port is protected by the per-cell bridge token.
  // Its SDK/management bearer token must never enter the workload VM.
  const trafficHeader = process.env.EGRESS_BRIDGE_TRAFFIC_HEADER ?? "e2b-traffic-access-token";
  if (!["none", "e2b-traffic-access-token"].includes(trafficHeader)) {
    throw new Error("unsupported bridge traffic header");
  }
  const trafficToken = trafficHeader === "none" ? null : required("EGRESS_BRIDGE_TRAFFIC_TOKEN");
  const cellToken = required("EGRESS_BRIDGE_CELL_TOKEN");
  const selectiveProxy = process.env.EGRESS_BRIDGE_SELECTIVE_PROXY === "1";
  const reverseRoute = reverse ? createReverseRoute(cellToken) : null;

  const server = net.createServer({ allowHalfOpen: false }, (downstream) => {
    downstream.pause();
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      downstream.destroy();
    };

    function connectGuardian(initialBytes = null) {
      if (reverseRoute) return reverseRoute(downstream, initialBytes, release);
      const websocket = new WebSocket(guardianUrl, {
        headers: {
          ...(trafficHeader === "none" ? {} : { [trafficHeader]: trafficToken }),
          "x-together-egress-cell-token": cellToken,
        },
        handshakeTimeout: 10_000,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
      const releaseWithWebsocket = () => {
        if (websocket.readyState !== WebSocket.CLOSED) websocket.terminate();
        release();
      };
      downstream.once("close", releaseWithWebsocket);
      downstream.once("error", releaseWithWebsocket);
      websocket.once("error", releaseWithWebsocket);
      websocket.once("close", releaseWithWebsocket);
      websocket.once("open", () => {
        if (downstream.destroyed) return releaseWithWebsocket();
        downstream.removeListener("close", releaseWithWebsocket);
        downstream.removeListener("error", releaseWithWebsocket);
        websocket.removeListener("error", releaseWithWebsocket);
        websocket.removeListener("close", releaseWithWebsocket);
        if (initialBytes?.length) downstream.unshift(initialBytes);
        couple(downstream, websocket, release);
        downstream.resume();
      });
    }

    async function connectDirect(parsed) {
      let validatedPublicDestination;
      try {
        validatedPublicDestination = await resolvePublicDestination(parsed.destination);
      } catch {
        release();
        return;
      }
      if (downstream.destroyed) return release();
      // Connect to the already-resolved numeric address. Passing the original
      // hostname here would re-open a DNS-rebinding path after validation.
      const upstream = net.createConnection(validatedPublicDestination);
      const fail = () => {
        upstream.destroy();
        release();
      };
      downstream.once("close", fail);
      downstream.once("error", fail);
      upstream.once("error", fail);
      upstream.once("connect", () => {
        if (downstream.destroyed) return fail();
        downstream.removeListener("close", fail);
        downstream.removeListener("error", fail);
        upstream.removeListener("error", fail);
        coupleTcp(
          downstream,
          upstream,
          release,
          {
            initialLeftToRight: parsed.bodyPrefix,
            initialRightToLeft: parsed.tunnel
              ? Buffer.from("HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n")
              : Buffer.alloc(0),
          },
        );
      });
    }

    if (!selectiveProxy) {
      connectGuardian();
      return;
    }

    let buffered = Buffer.alloc(0);
    const headerTimer = setTimeout(release, PROXY_HEADER_TIMEOUT_MS).unref();
    const failBeforeRoute = () => {
      clearTimeout(headerTimer);
      release();
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffered.length > PROXY_HEADER_MAX_BYTES) return failBeforeRoute();
        return;
      }
      if (headerEnd + 4 > PROXY_HEADER_MAX_BYTES) return failBeforeRoute();
      const parsed = parseProxyPreamble(buffered);
      clearTimeout(headerTimer);
      downstream.pause();
      downstream.removeListener("data", onData);
      downstream.removeListener("close", failBeforeRoute);
      downstream.removeListener("error", failBeforeRoute);
      if (parsed.kind === "guardian") {
        connectGuardian(parsed.guardianBytes);
      } else if (parsed.kind === "direct") {
        connectDirect(parsed);
      } else {
        release();
      }
    };
    downstream.on("data", onData);
    downstream.once("close", failBeforeRoute);
    downstream.once("error", failBeforeRoute);
    downstream.resume();
  });

  server.on("error", (error) => {
    process.stderr.write(`bridge client error: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(listenPort, "127.0.0.1", () => {
    process.stdout.write(`READY client ${listenPort}\n`);
  });
  installShutdown(() => server.close());
}

module.exports = {
  isPublicIpAddress,
  resolvePublicDestination,
};

if (require.main === module) {
  if (MODE === "server") runServer();
  else if (MODE === "client") runClient();
  else if (MODE === "reverse-client") runClient(true);
  else throw new Error("usage: node tcp_ws_bridge.cjs <server|client|reverse-client>");
}
