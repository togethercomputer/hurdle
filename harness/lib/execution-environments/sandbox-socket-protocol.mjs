import { Duplex } from "node:stream";

import { Session } from "./yamux.mjs";

// The single WebSocket between the controller and the server inside a
// Together Hurdle sandbox carries one yamux session: binary frames
// concatenate into the session's byte stream. The controller is the yamux
// client, so its streams have odd ids; the server's have even ids.
//
// The first stream the controller opens is the control channel, one JSON
// object per line each way. The controller asks for work by op and names, by
// id, the streams it opened to carry bytes for it:
//
//   {op:"run",   id, job, stdout, stderr}  the server writes the step's output
//                                          to those two streams and ends them
//   {op:"write", id, path, stream}         the controller ends the stream after
//                                          the file's bytes
//   {op:"read",  id, path, stream}         the server ends the stream after the
//                                          file's bytes
//   {op:"done",  id, value} | {op:"error", id, message}   the server's answer
//
// Every stream the server opens is one egress connection from the Agent,
// relayed verbatim to the controller's Guardian. Each stream has its own flow
// control, so a slow consumer holds back only its own sender.

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_ACTIVE_FLOWS = 512;
export const MAX_CONTROL_LINE_BYTES = 64 * 1024;
// How long the server waits for a stream an op names to arrive. The stream's
// SYN precedes the op on the wire, so this covers only a misbehaving peer.
export const CLAIM_TIMEOUT_MS = 10_000;

// Presents a `ws` socket as a byte Duplex. Backpressure flows both ways: an
// unread inbound buffer pauses the socket, and outbound writes complete only
// when the frame has been handed to the socket.
export function websocketDuplex(ws) {
  const OPEN = 1;
  const duplex = new Duplex({
    read() { ws.resume(); },
    write(chunk, _encoding, callback) {
      // A frame written once the socket is closing has no reader.
      if (ws.readyState !== OPEN) return callback();
      ws.send(chunk, { binary: true, compress: false }, () => callback());
    },
    final(callback) { ws.close(1000); callback(); },
    destroy(error, callback) { ws.terminate(); callback(error); },
  });
  duplex.on("error", () => {});
  ws.on("message", (data, binary) => {
    if (!binary) return duplex.destroy(new Error("sandbox transport received a text frame"));
    if (!duplex.push(data)) ws.pause();
  });
  ws.once("close", () => duplex.push(null));
  ws.on("error", (error) => duplex.destroy(error));
  return duplex;
}

// Runs a yamux session over a WebSocket. The session ends with the socket, and
// a session failure ends the socket.
export function muxOver(ws, { client, onStream }) {
  const transport = websocketDuplex(ws);
  const session = new Session({ client, onStream, acceptBacklog: MAX_ACTIVE_FLOWS + 8 });
  session.on("error", () => ws.terminate());
  session.pipe(transport);
  transport.pipe(session);
  transport.once("end", () => session.close());
  return session;
}

// Reads one JSON object per line from a stream. `onMessage` receives each;
// `onFailure` is called once for a malformed line or an overlong one.
export function readLines(stream, onMessage, onFailure) {
  let buffered = "";
  let failed = false;
  const fail = (message) => {
    if (failed) return;
    failed = true;
    onFailure(new Error(message));
  };
  stream.on("data", (chunk) => {
    if (failed) return;
    buffered += chunk.toString("utf8");
    if (buffered.length > MAX_CONTROL_LINE_BYTES) return fail("sandbox control line exceeds its bound");
    let index;
    while (!failed && (index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { return fail("sandbox control line is not JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("sandbox control line is not an object");
      onMessage(value);
    }
  });
}

export function writeLine(stream, message) {
  if (!stream.destroyed && stream.writable) stream.write(`${JSON.stringify(message)}\n`);
}

// Streams the peer opened, handed out as ops name them. A stream's SYN is sent
// before the op that names it, so it is normally already here.
export function createStreamClaims() {
  const arrived = new Map();
  const waiting = new Map();
  return {
    offer(stream) {
      const waiter = waiting.get(stream.id);
      if (waiter) {
        waiting.delete(stream.id);
        waiter(stream);
      } else {
        arrived.set(stream.id, stream);
      }
    },
    claim(id, { timeoutMs = CLAIM_TIMEOUT_MS } = {}) {
      if (arrived.has(id)) {
        const stream = arrived.get(id);
        arrived.delete(id);
        return Promise.resolve(stream);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`stream ${id} never arrived`));
        }, timeoutMs);
        waiting.set(id, (stream) => { clearTimeout(timer); resolve(stream); });
      });
    },
    // Streams nobody claimed are the peer's mistake; drop them.
    discard() {
      for (const stream of arrived.values()) stream.destroy();
      arrived.clear();
    },
  };
}

export function isId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
}

// Collects a stream into one buffer, refusing more than `maxBytes`.
export function readAll(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy(new Error("stream exceeded its byte bound"));
        return;
      }
      parts.push(chunk);
    });
    stream.once("end", () => resolve(Buffer.concat(parts)));
    stream.once("error", reject);
  });
}
