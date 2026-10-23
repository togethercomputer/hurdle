import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";

import {
  chunks,
  decodeData,
  encodeData,
  FRAME_KIND,
  isChannel,
  MAX_ACTIVE_FLOWS,
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
} from "./sandbox-socket-protocol.mjs";

// The server inside a Bartender Hurdle sandbox. Bartender starts it and
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
  const lines = body.match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

function within(path, roots) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return false;
  const absolute = resolve(path);
  return absolute === path && roots.some((root) => absolute.startsWith(`${root}/`));
}

export function createSandboxServer({
  runTask,
  port = 18083,
  flowPort = 18082,
  caPath = `${TASK_ROOT}/guardian-ca.pem`,
  writeRoots = [TASK_ROOT],
  readRoots = [],
  onClosed = () => {},
}) {
  const WebSocket = createRequire(import.meta.url)("ws");
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocket.WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES,
  });
  const flows = new Map();
  const writes = new Map();
  let client = null;
  let used = false;
  let running = false;
  let nextFlow = 1;
  let heartbeat = null;

  const send = (message) => {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const sendData = (kind, channel, payload, callback) => {
    if (client?.readyState !== WebSocket.OPEN) return callback?.(new Error("closed"));
    client.send(encodeData(kind, channel, payload), { binary: true }, callback);
  };
  const fail = (id, error) => send({ op: "error", id, message: String(error?.message ?? error) });

  function closeFlow(id, notify) {
    const flow = flows.get(id);
    if (!flow) return;
    flows.delete(id);
    flow.socket.destroy();
    if (notify) send({ op: "flow.close", id });
  }

  // Egress the Agent sends to the loopback relay port leaves only through the
  // socket. Without a connected controller there is nowhere to send it.
  const relay = net.createServer({ allowHalfOpen: false }, (socket) => {
    if (client?.readyState !== WebSocket.OPEN || flows.size >= MAX_ACTIVE_FLOWS) {
      socket.destroy();
      return;
    }
    const id = nextFlow++;
    flows.set(id, { socket });
    send({ op: "flow.open", id });
    socket.on("data", (chunk) => {
      sendData(FRAME_KIND.flow, id, chunk, () => {
        if (socket.isPaused() && client && client.bufferedAmount <= MAX_BUFFERED_BYTES / 2) socket.resume();
      });
      if (client && client.bufferedAmount > MAX_BUFFERED_BYTES) socket.pause();
    });
    socket.on("error", () => closeFlow(id, true));
    socket.on("close", () => closeFlow(id, true));
  });

  async function handleRun(id, job) {
    if (running) return fail(id, "a task step is already running");
    running = true;
    try {
      const value = await runTask(job, {
        onStdout: (text) => sendData(FRAME_KIND.stdout, id, Buffer.from(text)),
        onStderr: (text) => sendData(FRAME_KIND.stderr, id, Buffer.from(text)),
      });
      send({ op: "done", id, value: value ?? null });
    } catch (error) {
      fail(id, error);
    } finally {
      running = false;
    }
  }

  async function handleRead(id, path) {
    if (!within(path, readRoots)) return fail(id, "read outside the sealed roots");
    try {
      const bytes = await readFile(path);
      for (const chunk of chunks(bytes)) sendData(FRAME_KIND.read, id, chunk);
      send({ op: "done", id, value: { bytes: bytes.length } });
    } catch (error) {
      fail(id, error);
    }
  }

  async function finishWrite(id) {
    const write = writes.get(id);
    writes.delete(id);
    if (!write) return fail(id, "unknown write");
    try {
      await mkdir(dirname(write.path), { recursive: true, mode: 0o700 });
      const temporary = `${write.path}.${id}.tmp`;
      await writeFile(temporary, Buffer.concat(write.parts), { mode: 0o600 });
      await rename(temporary, write.path);
      send({ op: "done", id, value: { bytes: write.size } });
    } catch (error) {
      fail(id, error);
    }
  }

  function onControl(message) {
    const { op, id } = message;
    if (op === "flow.close") return closeFlow(id, false);
    if (!isChannel(id)) return;
    if (op === "run") return handleRun(id, message.job);
    if (op === "read") return handleRead(id, message.path);
    if (op === "write") {
      if (!within(message.path, writeRoots)) return fail(id, "write outside the task root");
      writes.set(id, { path: message.path, parts: [], size: 0 });
      return;
    }
    if (op === "end") return finishWrite(id);
    fail(id, "unknown operation");
  }

  function onData(frame) {
    const { kind, channel, payload } = decodeData(frame);
    if (kind === FRAME_KIND.flow) {
      // The shared socket cannot pause one flow; the TCP socket buffers it.
      flows.get(channel)?.socket.write(payload);
      return;
    }
    if (kind === FRAME_KIND.write) {
      const write = writes.get(channel);
      if (!write) return;
      write.size += payload.length;
      if (write.size > MAX_WRITE_BYTES) {
        writes.delete(channel);
        return fail(channel, "write exceeded its byte bound");
      }
      write.parts.push(Buffer.from(payload));
    }
  }

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const reject = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (request.url !== "/") return reject(404);
    // One controller per sandbox, for the sandbox's whole life.
    if (used) return reject(409);
    const certificate = certificateFromHeader(request.headers["x-sandbox-ca"]);
    if (!certificate) return reject(400);
    used = true;
    mkdir(dirname(caPath), { recursive: true, mode: 0o700 })
      .then(() => writeFile(caPath, certificate, { mode: 0o644 }))
      .then(() => wss.handleUpgrade(request, socket, head, (websocket) => {
        client = websocket;
        heartbeat = setInterval(() => websocket.ping(), PING_INTERVAL_MS).unref();
        websocket.on("message", (data, isBinary) => {
          try {
            if (isBinary) onData(data);
            else onControl(JSON.parse(data.toString("utf8")));
          } catch {
            websocket.terminate();
          }
        });
        websocket.once("close", () => {
          clearInterval(heartbeat);
          for (const id of [...flows.keys()]) closeFlow(id, false);
          client = null;
          onClosed();
        });
      }))
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
      for (const id of [...flows.keys()]) closeFlow(id, false);
      await Promise.all([
        new Promise((done) => server.close(() => done())),
        new Promise((done) => relay.close(() => done())),
      ]);
    },
  });
}
