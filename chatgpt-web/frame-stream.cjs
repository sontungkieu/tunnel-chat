'use strict';
const MAGIC = 0x54434631, HEADER = 24, MAX_FRAME = 5 * 1024 * 1024;
function unpackFrame(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < HEADER + 4 || packet.length > MAX_FRAME || packet.readUInt32BE(0) !== MAGIC)
    throw new Error('Invalid image packet');
  const seq = packet.readUInt32BE(4), width = packet.readUInt32BE(8), height = packet.readUInt32BE(12);
  const capturedAt = packet.readDoubleBE(16);
  if (width < 1 || width > 8192 || height < 1 || height > 8192 || !Number.isFinite(capturedAt) ||
      packet[HEADER] !== 0xff || packet[HEADER + 1] !== 0xd8)
    throw new Error('Invalid image metadata');
  return { seq, width, height, capturedAt, packet };
}
function packFrame({ data, width, height, capturedAt = Date.now(), seq = 0 }) {
  const jpeg = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
  const packet = Buffer.allocUnsafe(HEADER + jpeg.length);
  packet.writeUInt32BE(MAGIC, 0); packet.writeUInt32BE(seq >>> 0, 4);
  packet.writeUInt32BE(Math.round(width), 8); packet.writeUInt32BE(Math.round(height), 12);
  packet.writeDoubleBE(capturedAt, 16); jpeg.copy(packet, HEADER);
  unpackFrame(packet);
  return packet;
}
// Two frames may be in transit. Everything newer replaces a single waiting frame.
class FrameWindow {
  constructor(socket, { limit = 2, timeoutMs = 5000 } = {}) {
    this.socket = socket; this.limit = limit; this.timeoutMs = timeoutMs;
    this.inFlight = new Map(); this.latest = null; this.lastSent = 0;
  }
  offer(frame) { this.latest = frame; this.flush(); }
  flush() {
    if (!this.latest || this.socket.readyState !== 1 || this.inFlight.size >= this.limit || this.socket.bufferedAmount > MAX_FRAME) return;
    const frame = this.latest; this.latest = null;
    if (frame.seq <= this.lastSent) return;
    this.lastSent = frame.seq; this.inFlight.set(frame.seq, Date.now());
    this.socket.send(frame.packet, { binary: true, compress: false }, error => { if (error) this.socket.terminate(); });
  }
  ack(seq) {
    if (!Number.isInteger(seq) || seq < 1 || seq > this.lastSent) throw new Error('Invalid frame acknowledgement');
    for (const id of this.inFlight.keys()) if (id <= seq) this.inFlight.delete(id);
    this.flush();
  }
  reset() { this.inFlight.clear(); this.latest = null; }
  stale(now = Date.now()) { return [...this.inFlight.values()].some(sent => now - sent > this.timeoutMs); }
}
module.exports = { packFrame, unpackFrame, FrameWindow, MAX_FRAME };