import assert from "node:assert/strict";
import { PassThrough, Transform } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { DEFAULT_WINDOW, HEADER_BYTES, Session } from "../lib/execution-environments/yamux.mjs";

// Splits every chunk into pieces of `size` bytes, so frames arrive torn.
function fragmenting(size) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      for (let offset = 0; offset < chunk.length; offset += size) this.push(chunk.subarray(offset, offset + size));
      callback();
    },
  });
}

// Two sessions joined back to back, through an optional transform each way.
function pair({ shape = () => new PassThrough(), onStream, window, keepAliveIntervalMs = 0 } = {}) {
  const accepted = [];
  const client = new Session({ client: true, window, keepAliveIntervalMs });
  const server = new Session({
    client: false, window, keepAliveIntervalMs,
    onStream: (stream) => { accepted.push(stream); onStream?.(stream); },
  });
  const toServer = shape();
  const toClient = shape();
  client.pipe(toServer).pipe(server);
  server.pipe(toClient).pipe(client);
  return { client, server, accepted, toServer, toClient };
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on("data", (chunk) => parts.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(parts)));
    stream.once("error", reject);
  });
}

test("frames are reassembled whatever the chunking, and streams carry bytes both ways", async () => {
  const { client, server, accepted } = pair({ shape: () => fragmenting(5) });
  const stream = client.open();
  stream.end("hello from the client");
  await sleep(20);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, 1);
  assert.equal((await collect(accepted[0])).toString(), "hello from the client");
  accepted[0].end("and back");
  assert.equal((await collect(stream)).toString(), "and back");
  await sleep(20);
  assert.equal(client.streamCount, 0, "a stream finished both ways is forgotten");
  assert.equal(server.streamCount, 0);
  client.close();
  server.close();
});

test("a slow reader holds back only its own stream, by at most one window", async () => {
  const { client, server, accepted } = pair();
  const slow = client.open();
  const quick = client.open();
  const payload = Buffer.alloc(DEFAULT_WINDOW * 4, 7);
  let slowDone = false;
  slow.write(payload, () => { slowDone = true; });
  await sleep(50);
  assert.equal(slowDone, false, "the writer waits for the reader");
  assert.equal(accepted[0].readableLength, DEFAULT_WINDOW, "exactly one window is buffered");
  const quickEcho = collect(accepted[1]);
  quick.end("still flowing");
  assert.equal((await quickEcho).toString(), "still flowing");
  const received = collect(accepted[0]);
  slow.end();
  assert.equal((await received).length, payload.length);
  assert.equal(slowDone, true);
  // Streams still open when the session closes are destroyed with an error.
  for (const stream of [slow, quick, ...accepted]) stream.on("error", () => {});
  client.close();
  server.close();
});

test("resetting a stream reaches the peer as an error, and closing the session ends every stream", async () => {
  const { client, server, accepted } = pair();
  const reset = client.open();
  const kept = client.open();
  await sleep(10);
  const peerErrors = [];
  accepted[0].on("error", (error) => peerErrors.push(error.message));
  reset.destroy();
  await sleep(10);
  assert.match(peerErrors[0], /reset by the peer/);
  const keptErrors = [];
  accepted[1].on("error", (error) => keptErrors.push(error.message));
  kept.on("error", () => {});
  server.close();
  await sleep(10);
  assert.equal(server.closed, true);
  assert.match(keptErrors[0], /session closed/);
  client.close();
});

test("the peer's parity is enforced and over-window data closes the session", async () => {
  const { client, server } = pair();
  const errors = [];
  server.on("error", (error) => errors.push(error.message));
  client.on("error", () => {});
  // A SYN on an even id from the client side: not its to open.
  const head = Buffer.alloc(HEADER_BYTES);
  head[1] = 1;
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(2, 4);
  server.write(head);
  await sleep(10);
  assert.match(errors[0], /may not/);
  assert.equal(server.closed, true);

  const second = pair({ onStream: (stream) => stream.on("error", () => {}) });
  const secondErrors = [];
  second.server.on("error", (error) => secondErrors.push(error.message));
  second.client.on("error", () => {});
  second.client.open().on("error", () => {});
  await sleep(10);
  const data = Buffer.alloc(HEADER_BYTES);
  data.writeUInt32BE(1, 4);
  data.writeUInt32BE(DEFAULT_WINDOW + 1, 8);
  second.server.write(data);
  await sleep(10);
  assert.match(secondErrors[0], /exceeded the stream window/);
  assert.equal(second.server.closed, true, "rejects the header before receiving any body bytes");
});

test("keepalive pings are answered, and an unanswered one ends the session", async () => {
  const live = pair({ keepAliveIntervalMs: 10 });
  await sleep(60);
  assert.equal(live.client.closed, false);
  live.client.close();
  live.server.close();

  const quiet = new Session({ client: true, keepAliveIntervalMs: 10, keepAliveTimeoutMs: 20 });
  const errors = [];
  quiet.on("error", (error) => errors.push(error.message));
  quiet.pipe(new PassThrough());
  await sleep(60);
  assert.equal(quiet.closed, true);
  assert.match(errors[0], /keepalive timed out/);
});
