import { createHash, X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { Duplex, Transform } from "node:stream";

// Transport for the experimental single-connection sandbox API. This module
// is the stand-in for the platform SDK: it performs the authenticated upgrade
// and returns a yamux client over the socket. It knows nothing about the
// Guardian, credentials or policy; those stay with the caller.
//
// Wire contract: one WebSocket per sandbox; binary frame payloads concatenate
// into one yamux byte stream. The first client-opened stream is the control
// channel (newline-delimited JSON); its first message is `hello`, carrying the
// agent's environment and the files to stage into the workspace (path,
// `sha256:<hex>` digest, base64 content; bounded in total) before the agent
// starts. The muxer opens
// stdout and stderr on fixed stream ids right after `ready`, and one further
// stream per egress connection, each beginning with the HTTP CONNECT the agent
// sent.

const require = createRequire(import.meta.url);

export const DEFAULT_SANDBOX_URL = "wss://api.together.ai/v1/compute/experimental/run";
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CA_HEADER_BYTES = 8 * 1024;
export const MAX_CONTROL_LINE_BYTES = 64 * 1024;
export const MAX_STREAMS = 32;
export const MAX_STAGED_BYTES = 4 * 1024 * 1024;
export const STDOUT_STREAM_ID = 2;
export const STDERR_STREAM_ID = 4;
const CLOSE_TIMEOUT_MS = 5_000;
// WebSocket readyState values.
const CONNECTING = 0;
const OPEN = 1;

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

function abortError() {
  return Object.assign(new Error("sandbox connection cancelled"), { name: "AbortError" });
}

// Header values cannot carry PEM newlines, so the public CA travels as the
// base64 DER of a single certificate. Parsing it here rejects key material
// and malformed input before anything is sent.
export function caHeaderValue(pem) {
  if (typeof pem !== "string" || !pem.includes("BEGIN CERTIFICATE") || pem.includes("PRIVATE KEY")) {
    throw new TypeError("sandbox CA must be a public PEM certificate");
  }
  const encoded = new X509Certificate(pem).raw.toString("base64");
  if (encoded.length > MAX_CA_HEADER_BYTES) throw new TypeError("sandbox CA exceeds the header bound");
  return encoded;
}

function safeWorkspacePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.includes("\\")
    && !path.startsWith("/")
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

// Encodes workspace inputs for `hello`. Each entry carries its bytes and the
// digest the caller pinned; a mismatch means the input changed since it was
// selected. The muxer verifies the same digests after writing the files.
export function stagedFiles(entries, { maxBytes = MAX_STAGED_BYTES } = {}) {
  const files = [];
  const seen = new Set();
  let total = 0;
  for (const { path, bytes, sha256 } of entries) {
    if (!safeWorkspacePath(path) || seen.has(path)) throw new TypeError(`invalid staged workspace path '${path}'`);
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`staged file '${path}' has no bytes`);
    const hex = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== undefined && String(sha256).replace(/^sha256:/, "") !== hex) {
      throw new Error(`staged file '${path}' changed since it was pinned`);
    }
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error(`staged workspace inputs exceed ${maxBytes} bytes`);
    seen.add(path);
    files.push({ path, sha256: `sha256:${hex}`, content: Buffer.from(bytes).toString("base64") });
  }
  return files;
}

// Presents a `ws` socket as a byte Duplex. Backpressure flows both ways: an
// unread inbound buffer pauses the socket, and outbound writes complete only
// when the frame has been handed to the socket.
export function websocketDuplex(ws) {
  const duplex = new Duplex({
    read() { ws.resume(); },
    write(chunk, _encoding, callback) {
      // A frame written once the socket is closing has no reader; dropping
      // it keeps an orderly shutdown from surfacing as a transport error.
      if (ws.readyState !== OPEN) return callback();
      ws.send(chunk, { binary: true, compress: false }, callback);
    },
    final(callback) { ws.close(1000); callback(); },
    destroy(error, callback) { ws.terminate(); callback(error); },
  });
  duplex.closeCode = null;
  duplex.on("error", () => {});
  ws.on("message", (data, binary) => {
    if (!binary) return duplex.destroy(new Error("sandbox transport received a non-binary frame"));
    if (!duplex.push(data)) ws.pause();
  });
  ws.once("close", (code) => { duplex.closeCode = code; duplex.push(null); });
  ws.on("error", (error) => duplex.destroy(error));
  return duplex;
}

const YAMUX_HEADER_BYTES = 12;
const YAMUX_TYPE_DATA = 0;

// Re-chunks the inbound byte stream on yamux frame boundaries. yamux-js parses
// each chunk it is given as whole frames and discards one that splits a frame,
// so without this the client would depend on every relay in the path preserving
// WebSocket message boundaries. With it, relays may fragment or coalesce freely,
// which is what "the payloads concatenate into one byte stream" promises.
function yamuxFrameAligner() {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= YAMUX_HEADER_BYTES) {
        const type = pending[offset + 1];
        const length = pending.readUInt32BE(offset + 8);
        // Only data frames carry a body; for the others, length is a value.
        const body = type === YAMUX_TYPE_DATA ? length : 0;
        if (body > MAX_FRAME_BYTES) return callback(new Error("sandbox sent a yamux frame over the frame bound"));
        const size = YAMUX_HEADER_BYTES + body;
        if (pending.length - offset < size) break;
        this.push(pending.subarray(offset, offset + size));
        offset += size;
      }
      pending = offset ? pending.subarray(offset) : pending;
      callback();
    },
  });
}

export async function connectSandbox({
  url = DEFAULT_SANDBOX_URL,
  image,
  apiKey,
  ca,
  signal,
  handshakeTimeoutMs = 15_000,
  muxConfig = {},
} = {}) {
  if (typeof image !== "string" || !IMAGE_DIGEST.test(image)) {
    throw new TypeError("sandbox image must be a sha256 digest");
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new TypeError("sandbox connection requires an API key");
  }
  const target = new URL(url);
  if (target.protocol !== "wss:" && target.protocol !== "ws:") {
    throw new TypeError("sandbox URL must be a WebSocket URL");
  }
  target.searchParams.set("image", image);
  const headers = { Authorization: `Bearer ${apiKey}`, "X-Sandbox-CA": caHeaderValue(ca) };
  if (signal?.aborted) throw abortError();
  const WebSocket = require("ws");
  const { Client } = require("yamux-js");
  const ws = new WebSocket(target, {
    headers,
    handshakeTimeout: handshakeTimeoutMs,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
  });
  await new Promise((resolve, reject) => {
    const done = (error) => {
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onAbort = () => { ws.terminate(); done(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => done());
    ws.once("error", (error) => done(error));
    // Request problems are plain HTTP statuses; they never reach the mux.
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      done(Object.assign(
        new Error(`sandbox upgrade rejected with HTTP ${response.statusCode}`),
        { status: response.statusCode },
      ));
    });
  });
  const transport = websocketDuplex(ws);
  const mux = new Client({
    acceptBacklog: MAX_STREAMS,
    enableKeepAlive: true,
    keepAliveInterval: 30,
    maxStreamWindowSize: 256 * 1024,
    logger: () => {},
    ...muxConfig,
  });
  let failure = null;
  let closing = null;
  const closed = new Promise((resolve) => ws.once("close", resolve));
  mux.on("error", (error) => {
    if (closing) return;
    failure ||= error;
    transport.destroy(error);
  });
  transport.on("error", (error) => {
    if (!closing) failure ||= error;
  });
  // yamux-js acknowledges a peer-opened stream only when it first has something
  // to send; hashicorp/yamux closes the whole session when no ACK arrives within
  // its open timeout (75 s by default), so a quiet stdout or stderr would end the
  // run. Acknowledge on arrival, as the reference implementation does, whichever
  // handler the caller installs on `mux.onStream`.
  let streamHandler = (stream) => stream.sendWindowUpdate();
  Object.defineProperty(mux, "onStream", {
    configurable: true,
    get: () => streamHandler,
    set: (handler) => {
      streamHandler = typeof handler === "function"
        ? (stream) => { stream.sendWindowUpdate(); handler(stream); }
        : (stream) => stream.sendWindowUpdate();
    },
  });
  mux.pipe(transport);
  const aligner = yamuxFrameAligner();
  aligner.on("error", (error) => {
    if (!closing) failure ||= error;
    transport.destroy(error);
  });
  transport.pipe(aligner).pipe(mux);
  return Object.freeze({
    mux,
    get closeCode() { return transport.closeCode; },
    get error() { return failure; },
    // Resolves once the socket has closed. Closing the connection is what
    // ends the sandbox, so this doubles as its termination barrier.
    close(code = 1000, { timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
      closing ||= (async () => {
        try { mux.close(); } catch { /* already closed */ }
        // Let the GoAway frame reach the socket ahead of the close frame.
        await new Promise((resolve) => setImmediate(resolve));
        if (ws.readyState === OPEN || ws.readyState === CONNECTING) ws.close(code);
        const timer = setTimeout(() => ws.terminate(), timeoutMs);
        await closed;
        clearTimeout(timer);
      })();
      return closing;
    },
    terminate() { ws.terminate(); },
  });
}

// Opens the control channel and parses its newline-delimited JSON messages.
export function openControl(mux) {
  const stream = mux.open();
  const queue = [];
  const waiters = [];
  let buffered = "";
  let terminal = null;
  const deliver = (item) => {
    const waiter = waiters.shift();
    waiter ? waiter(item) : queue.push(item);
  };
  const end = (error) => {
    if (terminal) return;
    terminal = { error: error ?? new Error("sandbox control channel closed") };
    while (waiters.length) waiters.shift()(terminal);
  };
  const fail = (message) => { end(new Error(message)); stream.destroy(); };
  stream.on("data", (chunk) => {
    if (terminal) return;
    buffered += chunk.toString("utf8");
    if (buffered.length > MAX_CONTROL_LINE_BYTES) return fail("sandbox control line exceeds its bound");
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { return fail("sandbox control sent invalid JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
        return fail("sandbox control message lacks a type");
      }
      deliver({ value });
    }
  });
  stream.once("end", () => end());
  stream.once("close", () => end());
  stream.on("error", (error) => end(error));
  const next = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (terminal) return Promise.resolve(terminal);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return Object.freeze({
    stream,
    send(message) { stream.write(`${JSON.stringify(message)}\n`); },
    hello(env, files = []) { stream.write(`${JSON.stringify({ type: "hello", v: 1, env, files })}\n`); },
    next,
    // Resolves with the first message of `type`; `error` messages and channel
    // loss reject. Other message types are skipped.
    async waitFor(type, { signal, timeoutMs } = {}) {
      let timer;
      const interrupt = new Promise((_resolve, reject) => {
        if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => reject(new Error(`sandbox did not send ${type} in time`)), timeoutMs);
        }
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      interrupt.catch(() => {});
      try {
        while (true) {
          const item = await Promise.race([next(), interrupt]);
          if (item.error) throw item.error;
          const message = item.value;
          if (message.type === "error") {
            throw new Error(`sandbox reported ${message.code ?? "an error"}${message.message ? `: ${message.message}` : ""}`);
          }
          if (message.type === type) return message;
        }
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

// Pumps an egress stream into a local TCP socket in both directions. A FIN
// on either side ends only the matching write direction, so a response that
// follows the agent's EOF still drains before the pair is torn down.
export function pumpStream(stream, socket) {
  const teardown = () => { stream.destroy(); socket.destroy(); };
  stream.on("error", teardown);
  socket.on("error", teardown);
  stream.pipe(socket);
  socket.pipe(stream, { end: false });
  socket.once("end", () => { if (!stream.destroyed) stream.close(); });
}
