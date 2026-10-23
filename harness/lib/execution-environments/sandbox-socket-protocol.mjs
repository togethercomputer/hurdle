// Framing for the single WebSocket between the controller and the server inside
// a Bartender Hurdle sandbox. Control messages are JSON text frames; stream data
// travels in binary frames that start with a kind byte and a channel id.

export const FRAME_KIND = Object.freeze({
  write: 1,
  read: 2,
  stdout: 3,
  stderr: 4,
  flow: 5,
});

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 512 * 1024;
export const MAX_ACTIVE_FLOWS = 512;
// Pause TCP sources while this much is still queued on the shared socket.
export const MAX_BUFFERED_BYTES = 2 * MAX_FRAME_BYTES;

const HEADER_BYTES = 5;

export function encodeData(kind, channel, payload) {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt8(kind, 0);
  frame.writeUInt32BE(channel, 1);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, HEADER_BYTES);
  return frame;
}

export function decodeData(frame) {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (bytes.length < HEADER_BYTES) throw new Error("sandbox socket frame is truncated");
  return {
    kind: bytes.readUInt8(0),
    channel: bytes.readUInt32BE(1),
    payload: bytes.subarray(HEADER_BYTES),
  };
}

export function* chunks(bytes) {
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES)
    yield bytes.subarray(offset, offset + MAX_CHUNK_BYTES);
}

export function isChannel(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
}
