'use strict';
const MAGIC = 0x54434631, HEADER = 24, MAX_FRAME = 5 * 1024 * 1024;
const MAX_BUFFERED = 256 * 1024, MAX_IN_FLIGHT = 1024 * 1024;
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
// Cover network travel time without buffering an unbounded history of old images.
class FrameWindow {
  constructor(socket, { limit = 2, timeoutMs = 5000, now = Date.now } = {}) {
    this.socket = socket; this.limit = limit; this.timeoutMs = timeoutMs; this.now = now;
    this.inFlight = new Map(); this.bytes = 0; this.latest = null; this.lastSent = 0; this.rtts = [];
  }
  networkRtt(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 5000) return;
    this.rtts.push(ms); if (this.rtts.length > 30) this.rtts.shift();
    // Use transport pongs, not decode ACKs: a slow renderer must not grow its queue.
    // The recent minimum ignores transient congestion; hard frame/byte limits still apply.
    this.limit = Math.max(2, Math.min(12, Math.ceil(Math.min(...this.rtts) * 60 / 1000) + 2));
    this.flush();
  }
  offer(frame) { this.latest = frame; this.flush(); }
  flush() {
    if (!this.latest || this.socket.readyState !== 1 || this.inFlight.size >= this.limit || this.socket.bufferedAmount > MAX_BUFFERED) return;
    const frame = this.latest;
    // Permit one large frame, but never queue several large images together.
    if (this.inFlight.size && this.bytes + frame.packet.length > MAX_IN_FLIGHT) return;
    this.latest = null;
    if (frame.seq <= this.lastSent) return;
    this.lastSent = frame.seq; this.bytes += frame.packet.length;
    this.inFlight.set(frame.seq, { sent: this.now(), bytes: frame.packet.length });
    this.socket.send(frame.packet, { binary: true, compress: false }, error => { if (error) this.socket.terminate(); });
  }
  ack(seq) {
    if (!Number.isInteger(seq) || seq < 1 || seq > this.lastSent) throw new Error('Invalid frame acknowledgement');
    for (const [id, frame] of this.inFlight) if (id <= seq) { this.bytes -= frame.bytes; this.inFlight.delete(id); }
    this.flush();
  }
  reset() { this.inFlight.clear(); this.bytes = 0; this.latest = null; }
  stale(now = this.now()) { return [...this.inFlight.values()].some(frame => now - frame.sent > this.timeoutMs); }
}
module.exports = { packFrame, unpackFrame, FrameWindow, MAX_FRAME };
