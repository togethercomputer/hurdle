import { createRequire } from "node:module";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 2 * MAX_FRAME_BYTES;
const GRACEFUL_CLOSE_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_FLOWS = 512;

// No payload logging or persistence: the controller only moves opaque bytes
// between the workload's reverse bridge and the controller-host Guardian.
export async function startTogetherControllerRelay({
  workloadUrl, cellToken, sandboxToken = null, openUpstream, signal,
}) {
  const WebSocket = createRequire(import.meta.url)("ws");
  if (typeof openUpstream !== "function") throw new TypeError("Together relay requires an upstream");
  if (signal?.aborted) throw Object.assign(new Error("Together relay cancelled"), { name: "AbortError" });
  const sockets = new Set();
  const upstreams = new Set();
  const ids = new Set();
  let failure = null, stopping = false, expectedShutdown = false;
  // Keep preview routes alive while the Agent is thinking or using tools.
  // Protocol ping/pong frames never enter the TCP data stream or journal.
  const heartbeat = setInterval(() => {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20000).unref();
  const options = {
    headers: {
      "x-together-egress-cell-token": cellToken,
      // Required by the port's inbound allowlist; stripped by Together ingress.
      ...(sandboxToken ? { "X-Sandbox-Token": sandboxToken } : {}),
    },
    handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES,
  };
  const fail = (reason = "transport-closed") => {
    if (!expectedShutdown && !stopping) failure ||= new Error(`Together controller relay lost its authenticated transport (${typeof reason === "string" ? reason : "transport-error"})`);
    close();
  };
  function socket(url) {
    const ws = new WebSocket(url, options);
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    return ws;
  }
  function close() {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", fail);
    for (const ws of sockets) ws.terminate();
    for (const tcp of upstreams) tcp.destroy();
    sockets.clear();
    upstreams.clear();
  }
  function connectFlow(id) {
    // Claim the workload flow before the upstream connects; bytes the Agent
    // already sent are buffered by bounded WebSocket backpressure below.
    const ws = socket(`${workloadUrl}/relay/${id}`);
    let tcp;
    try { tcp = openUpstream(); } catch { ws.terminate(); ids.delete(id); return; }
    upstreams.add(tcp);
    let finished = false, timer = null, wsOpen = false, tcpPaused = false, wsPaused = false;
    let tcpConnected = false;
    tcp.once("connect", () => { tcpConnected = true; });
    const pending = [];
    let queued = 0;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ids.delete(id);
      upstreams.delete(tcp);
      tcp.destroy();
      ws.terminate();
    };
    const send = (data) => {
      ws.send(data, { binary: true, compress: false }, (error) => {
        // An Agent may abort a response while a write callback is pending.
        if (error) return cleanup();
        if (tcpPaused && ws.bufferedAmount <= MAX_BUFFER_BYTES / 2) {
          tcpPaused = false; tcp.resume();
        }
      });
      if (ws.bufferedAmount > MAX_BUFFER_BYTES && !tcpPaused) {
        tcpPaused = true; tcp.pause();
      }
    };
    tcp.on("data", (data) => {
      if (finished) return;
      if (wsOpen && ws.readyState === WebSocket.OPEN) return send(data);
      if (ws.readyState !== WebSocket.CONNECTING) return cleanup();
      queued += data.length;
      if (queued > MAX_BUFFER_BYTES) return cleanup();
      pending.push(data);
      if (!tcpPaused) { tcpPaused = true; tcp.pause(); }
    });
    ws.once("open", () => {
      wsOpen = true;
      for (const data of pending) send(data);
      pending.length = 0; queued = 0;
      if (tcpPaused && ws.bufferedAmount <= MAX_BUFFER_BYTES / 2) { tcpPaused = false; tcp.resume(); }
    });
    ws.on("message", (data, binary) => {
      if (!binary) return fail("non-binary-frame");
      if (finished) return;
      if (!tcp.write(data) && !wsPaused) {
        wsPaused = true;
        ws._socket?.pause();
        tcp.once("drain", () => { wsPaused = false; ws._socket?.resume(); });
      }
    });
    // Preserve EOF ordering: a close frame follows all queued data, and TCP
    // FIN follows all written data. Neither leg is cut at the first EOF.
    tcp.once("end", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      else if (ws.readyState === WebSocket.CONNECTING) ws.once("open", () => ws.close(1000));
      timer ||= setTimeout(cleanup, GRACEFUL_CLOSE_TIMEOUT_MS).unref();
    });
    ws.once("close", () => {
      tcp.end();
      if (tcp.destroyed) return cleanup();
      timer ||= setTimeout(cleanup, GRACEFUL_CLOSE_TIMEOUT_MS).unref();
    });
    tcp.once("close", () => {
      if (ws.readyState === WebSocket.CLOSED) cleanup();
      else timer ||= setTimeout(cleanup, GRACEFUL_CLOSE_TIMEOUT_MS).unref();
    });
    // A refused upstream means the host Guardian is gone: fail closed.
    // Sockets may emit more than one error; every one must be handled.
    tcp.on("error", () => tcpConnected ? cleanup() : (cleanup(), fail("guardian-unavailable")));
    ws.on("error", () => wsOpen ? cleanup() : fail("channel-error"));
    ws.once("unexpected-response", () => fail("channel-upgrade"));
  }
  const control = socket(`${workloadUrl}/control`);
  control.on("message", (data, binary) => {
    let value;
    try { if (binary || data.length > 1024) throw new Error(); value = JSON.parse(data.toString()); }
    catch { return fail(); }
    if (value.kind !== "open" || !/^[a-f0-9]{32}$/.test(value.id) || ids.has(value.id)) return fail();
    // All workload egress crosses this relay. Beyond the bound, leave the flow
    // unclaimed (the bridge refuses it) rather than cutting every other flow.
    if (ids.size >= MAX_ACTIVE_FLOWS) return;
    ids.add(value.id); connectFlow(value.id);
  });
  control.once("close", () => fail("control-closed"));
  control.once("error", () => fail("control-error"));
  signal?.addEventListener("abort", fail, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Together relay handshake timed out")), 12000);
      const done = error => { clearTimeout(timer); control.removeListener("open", opened); control.removeListener("close", closed); control.removeListener("error", closed); error ? reject(error) : resolve(); };
      const opened = () => done();
      const closed = () => done(failure ?? new Error("Together relay handshake failed"));
      control.once("open", opened); control.once("close", closed); control.once("error", closed);
    });
    if (failure || stopping) throw failure ?? new Error("Together relay cancelled");
    return { assertHealthy() { if (failure || stopping) throw failure ?? new Error("Together relay closed"); },
      allowShutdown() { expectedShutdown = true; }, close };
  } catch (error) { close(); throw error; }
}
