import { Duplex } from "node:stream";

// A multiplexer speaking the yamux wire format (hashicorp/yamux, version 0):
// a 12-byte header, then for data frames a body. Streams are Node Duplexes
// with the protocol's flow control, so a slow reader on one stream holds back
// only that stream's sender and buffers at most one window.
//
// Kept here rather than taken from a package: the available one drops the
// bytes of a frame that arrives split across chunks, acknowledges streams only
// when it has data to send (the reference implementation closes the session
// when an acknowledgement is late), and grants window as data arrives rather
// than as it is read, which is no backpressure at all. The format is small, and
// the reference implementation is what the node-side relay will speak.

export const HEADER_BYTES = 12;
const VERSION = 0;
const TYPE = Object.freeze({ data: 0, windowUpdate: 1, ping: 2, goAway: 3 });
const FLAG = Object.freeze({ syn: 1, ack: 2, fin: 4, rst: 8 });
const GO_AWAY = Object.freeze({ normal: 0, protocol: 1, internal: 2 });

// The protocol's initial window is 256 KiB; a session grants up to this much
// as its reader consumes. Throughput per stream is one window per round trip
// to the Guardian, so 256 KiB over a 150 ms relay path was under 1 MB/s.
export const INITIAL_WINDOW = 256 * 1024;
export const DEFAULT_WINDOW = 2 * 1024 * 1024;
// Bodies are cut so that one frame stays a modest WebSocket message.
export const MAX_FRAME_BODY = 64 * 1024;

function header(type, flags, streamId, length) {
  const bytes = Buffer.allocUnsafe(HEADER_BYTES);
  bytes[0] = VERSION;
  bytes[1] = type;
  bytes.writeUInt16BE(flags, 2);
  bytes.writeUInt32BE(streamId, 4);
  bytes.writeUInt32BE(length, 8);
  return bytes;
}

function protocolError(message) {
  return Object.assign(new Error(message), { code: "yamux-protocol" });
}

export class Stream extends Duplex {
  #session;
  #id;
  #window;
  #sendWindow = INITIAL_WINDOW;
  #recvWindow;
  #sentFin = false;
  #receivedFin = false;
  #gone = false;
  #blocked = null;

  constructor(session, id, window) {
    // The readable buffer holds at most the window the peer was granted, so
    // the high-water mark need not be smaller than that.
    super({ readableHighWaterMark: window, allowHalfOpen: true });
    this.#session = session;
    this.#id = id;
    this.#window = window;
    // What the peer may send before a grant: the protocol's initial window.
    // A larger window is granted as soon as the stream exists (_replenish).
    this.#recvWindow = INITIAL_WINDOW;
  }

  get id() { return this.#id; }

  // Sends what the window allows and parks the rest until the peer grants more.
  _write(chunk, _encoding, callback) {
    if (this.#gone) return callback(protocolError("yamux stream is closed"));
    let offset = 0;
    const pump = () => {
      while (offset < chunk.length) {
        if (this.#sendWindow === 0) {
          this.#blocked = pump;
          return;
        }
        const size = Math.min(chunk.length - offset, this.#sendWindow, MAX_FRAME_BODY);
        const body = chunk.subarray(offset, offset + size);
        this.#sendWindow -= size;
        offset += size;
        this.#session._emit(header(TYPE.data, 0, this.#id, size), body);
      }
      this.#blocked = null;
      callback();
    };
    pump();
  }

  _final(callback) {
    if (!this.#gone && !this.#sentFin) {
      this.#sentFin = true;
      this.#session._emit(header(TYPE.windowUpdate, FLAG.fin, this.#id, 0));
      if (this.#receivedFin) this.#session._forget(this.#id);
    }
    callback();
  }

  // Consumption grants window: once the peer may send less than half the
  // window beyond what is buffered, tell it the rest. Hooked on read() rather
  // than _read(), which Node calls only until a call of it fails to push.
  read(size) {
    const chunk = super.read(size);
    this._replenish();
    return chunk;
  }

  _replenish() {
    if (this.#gone || this.#receivedFin) return;
    const delta = this.#window - this.readableLength - this.#recvWindow;
    if (delta < this.#window / 2) return;
    this.#recvWindow += delta;
    this.#session._emit(header(TYPE.windowUpdate, 0, this.#id, delta));
  }

  _read() {}

  _destroy(error, callback) {
    if (!this.#gone) {
      this.#gone = true;
      if (!(this.#sentFin && this.#receivedFin)) {
        this.#session._emit(header(TYPE.windowUpdate, FLAG.rst, this.#id, 0));
      }
      this.#session._forget(this.#id);
    }
    this.#blocked = null;
    callback(error);
  }

  // Acknowledges a stream the peer opened, on arrival.
  _acknowledge() {
    this.#session._emit(header(TYPE.windowUpdate, FLAG.ack, this.#id, 0));
  }

  _receive(flags, body) {
    if (this.#gone) return;
    if (flags & FLAG.rst) {
      this.#gone = true;
      this.#session._forget(this.#id);
      this.destroy(protocolError("yamux stream was reset by the peer"));
      return;
    }
    if (body !== null && body.length > 0) {
      if (body.length > this.#recvWindow) {
        this.#session._fail(protocolError("yamux peer exceeded the stream window"));
        return;
      }
      this.#recvWindow -= body.length;
      this.push(body);
    }
    if (flags & FLAG.fin && !this.#receivedFin) {
      this.#receivedFin = true;
      this.push(null);
      if (this.#sentFin) this.#session._forget(this.#id);
    }
  }

  _grant(delta) {
    this.#sendWindow += delta;
    if (this.#sendWindow > 0 && this.#blocked) this.#blocked();
  }

  _abandon(error) {
    if (this.#gone) return;
    this.#gone = true;
    this.destroy(error);
  }
}

// One multiplexed connection. Pipe the transport into it and it into the
// transport: the writable side takes the peer's bytes in any chunking, the
// readable side yields whole frames.
export class Session extends Duplex {
  #client;
  #window;
  #acceptBacklog;
  #onStream;
  #streams = new Map();
  #nextId;
  #header = Buffer.alloc(HEADER_BYTES);
  #headerBytes = 0;
  #body = null;
  #bodyBytes = 0;
  #remoteGoAway = false;
  #closed = false;
  #pingId = 0;
  #pings = new Map();
  #keepAlive = null;
  #keepAliveTimeoutMs;

  constructor({
    client,
    onStream = null,
    window = DEFAULT_WINDOW,
    acceptBacklog = 256,
    keepAliveIntervalMs = 30_000,
    keepAliveTimeoutMs = 30_000,
  }) {
    super({ writableHighWaterMark: 1024 * 1024 });
    this.#client = Boolean(client);
    this.#nextId = this.#client ? 1 : 2;
    // The protocol fixes the initial window; a session may only grant more.
    this.#window = Math.max(window, INITIAL_WINDOW);
    this.#acceptBacklog = acceptBacklog;
    this.#onStream = onStream;
    this.#keepAliveTimeoutMs = keepAliveTimeoutMs;
    if (keepAliveIntervalMs > 0) {
      this.#keepAlive = setInterval(() => this.#ping(), keepAliveIntervalMs);
      this.#keepAlive.unref?.();
    }
  }

  get closed() { return this.#closed; }
  get streamCount() { return this.#streams.size; }

  // Opens a stream. The SYN goes out now rather than with the first write, so
  // the peer learns of the stream in order with anything that names it.
  open() {
    if (this.#closed) throw protocolError("yamux session is closed");
    if (this.#remoteGoAway) throw protocolError("yamux peer accepts no more streams");
    const id = this.#nextId;
    this.#nextId += 2;
    const stream = new Stream(this, id, this.#window);
    this.#streams.set(id, stream);
    this._emit(header(TYPE.windowUpdate, FLAG.syn, id, 0));
    stream._replenish();
    return stream;
  }

  // Ends the session: a GoAway, then every stream is destroyed and the
  // outbound side ends. `error` is what the streams and this session report.
  close(error = null) {
    if (this.#closed) return;
    this.#closed = true;
    this.#body = null;
    clearInterval(this.#keepAlive);
    for (const timer of this.#pings.values()) clearTimeout(timer);
    this.#pings.clear();
    this._emit(header(TYPE.goAway, 0, 0, error ? GO_AWAY.internal : GO_AWAY.normal));
    for (const stream of [...this.#streams.values()]) stream._abandon(error ?? protocolError("yamux session closed"));
    this.#streams.clear();
    this.push(null);
    if (error) this.destroy(error);
  }

  _emit(head, body = null) {
    if (this.#closed && head[1] !== TYPE.goAway) return;
    this.push(body ? Buffer.concat([head, body]) : head);
  }

  _forget(id) { this.#streams.delete(id); }

  _fail(error) {
    this._emit(header(TYPE.goAway, 0, 0, GO_AWAY.protocol));
    this.close(error);
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      if (this.#headerBytes < HEADER_BYTES) {
        const copied = chunk.copy(this.#header, this.#headerBytes, offset, offset + HEADER_BYTES - this.#headerBytes);
        this.#headerBytes += copied;
        offset += copied;
        if (this.#headerBytes < HEADER_BYTES) break;

        if (this.#header[0] !== VERSION) {
          this._fail(protocolError("yamux peer sent an unknown version"));
          break;
        }
        const length = this.#header[1] === TYPE.data ? this.#header.readUInt32BE(8) : 0;
        if (length > this.#window) {
          this._fail(protocolError("yamux peer exceeded the stream window"));
          break;
        }
        // Reassemble one frame at a time, bounded by the largest receive window.
        if (length > 0) this.#body = Buffer.alloc(length);
      }

      const body = this.#body;
      if (body) {
        const copied = chunk.copy(body, this.#bodyBytes, offset, offset + body.length - this.#bodyBytes);
        this.#bodyBytes += copied;
        offset += copied;
        if (this.#bodyBytes < body.length) break;
      }

      this.#headerBytes = 0;
      this.#body = null;
      this.#bodyBytes = 0;
      this.#frame(this.#header, body);
    }
    callback();
  }

  _final(callback) {
    this.close();
    callback();
  }

  _destroy(error, callback) {
    this.close(error);
    callback(error);
  }

  #frame(head, body) {
    const type = head[1];
    const flags = head.readUInt16BE(2);
    const id = head.readUInt32BE(4);
    const length = head.readUInt32BE(8);
    switch (type) {
      case TYPE.data:
      case TYPE.windowUpdate:
        return this.#streamFrame(type, flags, id, length, body);
      case TYPE.ping:
        if (flags & FLAG.syn) return this._emit(header(TYPE.ping, FLAG.ack, 0, length));
        clearTimeout(this.#pings.get(length));
        this.#pings.delete(length);
        return;
      case TYPE.goAway:
        this.#remoteGoAway = true;
        if (length !== GO_AWAY.normal) return this.close(protocolError(`yamux peer went away (${length})`));
        return this.emit("goAway");
      default:
        return this._fail(protocolError("yamux peer sent an unknown frame type"));
    }
  }

  #streamFrame(type, flags, id, length, body) {
    let stream = this.#streams.get(id);
    if (flags & FLAG.syn) {
      if (stream || id === 0 || (id % 2 === 1) !== !this.#client) {
        return this._fail(protocolError("yamux peer opened a stream it may not"));
      }
      if (this.#streams.size >= this.#acceptBacklog || this.#closed) {
        return this._emit(header(TYPE.windowUpdate, FLAG.rst, id, 0));
      }
      stream = new Stream(this, id, this.#window);
      this.#streams.set(id, stream);
      stream._acknowledge();
      stream._replenish();
      this.#onStream?.(stream);
    }
    // A stream already finished with: the peer's late frames are noise.
    if (!stream) return;
    if (type === TYPE.windowUpdate) stream._grant(length);
    stream._receive(flags, body);
  }

  #ping() {
    if (this.#closed) return;
    const id = ++this.#pingId >>> 0;
    this.#pings.set(id, setTimeout(() => {
      this.#pings.delete(id);
      this.close(protocolError("yamux keepalive timed out"));
    }, this.#keepAliveTimeoutMs));
    this._emit(header(TYPE.ping, FLAG.syn, 0, id));
  }
}
