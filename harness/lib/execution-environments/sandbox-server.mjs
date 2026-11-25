import { timingSafeEqual, X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";

import {
  createStreamClaims,
  isId,
  MAX_ACTIVE_FLOWS,
  MAX_FRAME_BYTES,
  muxOver,
  readAll,
  readLines,
  writeLine,
} from "./sandbox-socket-protocol.mjs";

// The server inside a Together Hurdle sandbox. Together's Hurdle API starts it and
// connects the client's one WebSocket to it, so this socket is the only way in:
// the controller writes task inputs, runs task steps and reads sealed results
// over it, and the Agent's egress flows ride it to the controller's Guardian.

export const TASK_ROOT = "/tmp/hurdle-task";
const MAX_WRITE_BYTES = 256 * 1024 * 1024;
const PING_INTERVAL_MS = 20_000;

// X-Sandbox-CA carries the Guardian CA as the base64 body of its PEM, since a
// header value cannot hold the PEM's line breaks.
export function certificateFromHeader(value) {
  const body = String(value ?? "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    const certificate = new X509Certificate(Buffer.from(body, "base64"));
    return certificate.ca && certificate.raw.toString("base64") === body ? certificate.toString() : null;
  } catch {
    return null;
  }
}

function within(path, roots) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return false;
  const absolute = resolve(path);
  return absolute === path && roots.some((root) => absolute.startsWith(`${root}/`));
}

export function createSandboxServer({
  controlToken,
  runTask,
  port = 18083,
  flowPort = 18082,
  caPath = `${TASK_ROOT}/guardian-ca.pem`,
  writeRoots = [TASK_ROOT],
  readRoots = [],
  onClosed = () => {},
}) {
  const token = Buffer.from(controlToken ?? "", "base64url");
  if (token.length !== 32 || token.toString("base64url") !== controlToken) {
    throw new TypeError("HURDLE_SANDBOX_CONTROL_TOKEN must be a base64url-encoded 32-byte token");
  }
  const expectedAuthorization = Buffer.from(`Bearer ${controlToken}`);
  const WebSocket = createRequire(import.meta.url)("ws");
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocket.WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES,
  });
  const flows = new Set();
  let client = null;
  let session = null;
  let control = null;
  let used = false;
  let running = false;
  let heartbeat = null;

  const send = (message) => { if (control) writeLine(control, message); };
  const fail = (id, error) => send({ op: "error", id, message: String(error?.message ?? error) });

  // Egress the Agent sends to the loopback relay port leaves only through the
  // socket, one stream per connection. Without a connected controller there
  // is nowhere to send it.
  const relay = net.createServer({ allowHalfOpen: false }, (socket) => {
    if (!session || session.closed || flows.size >= MAX_ACTIVE_FLOWS) {
      socket.destroy();
      return;
    }
    const stream = session.open();
    flows.add(socket);
    const teardown = () => { flows.delete(socket); socket.destroy(); stream.destroy(); };
    socket.on("error", teardown);
    stream.on("error", teardown);
    socket.once("close", teardown);
    socket.pipe(stream);
    stream.pipe(socket);
  });

  async function handleRun(id, job, claims, message) {
    if (running) return fail(id, "a task step is already running");
    if (!isId(message.stdout) || !isId(message.stderr)) return fail(id, "run names no output streams");
    running = true;
    const [stdout, stderr] = await Promise.all([claims.claim(message.stdout), claims.claim(message.stderr)]);
    for (const stream of [stdout, stderr]) stream.on("error", () => {});
    try {
      const value = await runTask(job, {
        onStdout: (text) => stdout.write(Buffer.from(text)),
        onStderr: (text) => stderr.write(Buffer.from(text)),
      });
      send({ op: "done", id, value: value ?? null });
    } catch (error) {
      fail(id, error);
    } finally {
      running = false;
      stdout.end();
      stderr.end();
    }
  }

  async function handleRead(id, path, claims, message) {
    if (!within(path, readRoots)) return fail(id, "read outside the sealed roots");
    if (!isId(message.stream)) return fail(id, "read names no stream");
    const stream = await claims.claim(message.stream);
    stream.on("error", () => {});
    try {
      const bytes = await readFile(path);
      await new Promise((done) => stream.end(bytes, done));
      send({ op: "done", id, value: { bytes: bytes.length } });
    } catch (error) {
      stream.destroy();
      fail(id, error);
    }
  }

  async function handleWrite(id, path, claims, message) {
    if (!within(path, writeRoots)) return fail(id, "write outside the task root");
    if (!isId(message.stream)) return fail(id, "write names no stream");
    const stream = await claims.claim(message.stream);
    try {
      const bytes = await readAll(stream, MAX_WRITE_BYTES);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${id}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
      send({ op: "done", id, value: { bytes: bytes.length } });
    } catch (error) {
      fail(id, error);
    }
  }

  function onControl(message, claims) {
    const { op, id } = message;
    if (!isId(id)) return;
    const handle = (promise) => promise.catch((error) => fail(id, error));
    if (op === "run") return handle(handleRun(id, message.job, claims, message));
    if (op === "read") return handle(handleRead(id, message.path, claims, message));
    if (op === "write") return handle(handleWrite(id, message.path, claims, message));
    fail(id, "unknown operation");
  }

  function attach(websocket) {
    client = websocket;
    const claims = createStreamClaims();
    session = muxOver(websocket, {
      client: false,
      onStream: (stream) => {
        // The controller's first stream is the control channel; the rest are
        // claimed by the ops that name them.
        if (!control) {
          control = stream;
          control.on("error", () => {});
          readLines(control, (message) => onControl(message, claims), () => websocket.terminate());
          return;
        }
        claims.offer(stream);
      },
    });
    heartbeat = setInterval(() => websocket.ping(), PING_INTERVAL_MS).unref();
    websocket.once("close", () => {
      clearInterval(heartbeat);
      claims.discard();
      for (const socket of [...flows]) socket.destroy();
      session.close();
      client = null;
      session = null;
      control = null;
      onClosed();
    });
  }

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const reject = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (request.url !== "/") return reject(404);
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      return reject(401);
    }
    // One controller per sandbox, for the sandbox's whole life.
    if (used) return reject(409);
    const certificate = certificateFromHeader(request.headers["x-sandbox-ca"]);
    if (!certificate) return reject(400);
    used = true;
    mkdir(dirname(caPath), { recursive: true, mode: 0o700 })
      .then(() => writeFile(caPath, certificate, { mode: 0o644 }))
      .then(() => wss.handleUpgrade(request, socket, head, attach))
      .catch(() => reject(500));
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  return Object.freeze({
    async listen({ host = "0.0.0.0" } = {}) {
      await new Promise((ready, failed) => {
        relay.once("error", failed);
        relay.listen(flowPort, "127.0.0.1", ready);
      });
      await new Promise((ready, failed) => {
        server.once("error", failed);
        server.listen(port, host, ready);
      });
      return { port: server.address().port, flowPort: relay.address().port };
    },
    async close() {
      client?.terminate();
      for (const socket of [...flows]) socket.destroy();
      await Promise.all([
        new Promise((done) => server.close(() => done())),
        new Promise((done) => relay.close(() => done())),
      ]);
    },
  });
}
