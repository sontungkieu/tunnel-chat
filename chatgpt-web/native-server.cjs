'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { FrameWindow, unpackFrame, MAX_FRAME } = require('./frame-stream.cjs');
const { inputCommand } = require('./native-protocol.cjs');

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message), { compress: false });
}
class Driver extends EventEmitter {
  constructor(token) {
    super(); this.token = token; this.next = 0; this.pending = new Map(); this.socket = null; this.frameSeq = 0;
    this.status = { ready: false, message: 'Đang chờ Chrome trên máy cá nhân…' }; this.frame = null;
  }
  attach(socket) {
    this.socket = socket;
    socket.on('error', () => {});
    socket.on('message', (data, binary) => {
      try { binary ? this.receiveFrame(data) : this.receive(JSON.parse(data.toString())); }
      catch { socket.close(1008, 'Invalid driver message'); }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null; this.frame = null;
      this.receive({ event:'status', ready:false, message:'Chrome đã ngắt kết nối. Bật lại truyền giao diện trên máy cá nhân.' });
      this.failPending();
    });
  }
  receiveFrame(packet) {
    const frame = unpackFrame(packet);
    // A server sequence stays monotonic even if the Windows helper reconnects.
    frame.seq = ++this.frameSeq; packet.writeUInt32BE(frame.seq, 4);
    this.frame = frame; this.emit('frame', frame);
  }
  receive(message) {
    if (message.event === 'status') {
      this.status = { ready: !!message.ready, message: String(message.message || '').slice(0,500) };
      if (!this.status.ready) this.frame = null;
      this.emit('status', this.status);
    } else if (message.event === 'notice') this.emit('notice', { message: String(message.message || '').slice(0,500) });
    else if (message.id) {
      const job = this.pending.get(message.id); if (!job) return;
      this.pending.delete(message.id); clearTimeout(job.timer);
      if (message.ok) job.resolve(); else job.reject(new Error('Browser action failed'));
    }
  }
  call(value) {
    if (!this.status.ready || this.socket?.readyState !== 1) return Promise.reject(new Error('Browser is not connected'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Browser is busy'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Browser input timed out; do not automatically retry'));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      send(this.socket, { id, ...value });
    });
  }
  failPending() {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Bridge disconnected; do not replay input')); }
    this.pending.clear();
  }
  close() { this.socket?.terminate(); this.failPending(); }
}
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function reject(socket, status) {
  socket.end('HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}
function sameOrigin(req) {
  try { const origin = new URL(req.headers.origin); return ['http:','https:'].includes(origin.protocol) && origin.host === req.headers.host; }
  catch { return false; }
}
function validateCommand(message) {
  if (message.type === 'input') {
    inputCommand(message.data, { width:1000, height:1000 });
    return { type:'input', data:message.data };
  }
  if (message.type === 'control') {
    if (['home','reload'].includes(message.action)) return { type:'control', action:message.action };
    const { width, height } = message;
    if (message.action === 'viewport' && Number.isInteger(width) && width >= 640 && width <= 1920 &&
        Number.isInteger(height) && height >= 360 && height <= 1400)
      return { type:'control', action:'viewport', width, height };
  }
  throw new Error('Unsupported browser action');
}
function createNativeServer(driver, { canaryFile } = {}) {
  const viewers = new Map();
  const publicWS = new WebSocketServer({ noServer:true, perMessageDeflate:false, maxPayload:100000 });
  const privateWS = new WebSocketServer({ noServer:true, perMessageDeflate:false, maxPayload:MAX_FRAME });
  function broadcast(event, value) { for (const socket of viewers.keys()) send(socket, { event, ...value }); }
  const onFrame = frame => { for (const window of viewers.values()) window.offer(frame); };
  const onStatus = status => {
    if (!status.ready) for (const window of viewers.values()) window.reset();
    broadcast('status', status);
  };
  const onNotice = notice => broadcast('notice', notice);
  driver.on('frame', onFrame); driver.on('status', onStatus); driver.on('notice', onNotice);
  publicWS.on('connection', socket => {
    const window = new FrameWindow(socket); viewers.set(socket, window);
    socket.on('error', () => {}); socket.on('close', () => viewers.delete(socket));
    send(socket, { event:'status', ...driver.status });
    if (driver.frame) window.offer(driver.frame);
    let lastId = 0, pending = 0;
    socket.on('message', (data, binary) => {
      let message;
      try {
        if (binary) throw new Error('Binary input is not supported');
        message = JSON.parse(data.toString());
        if (message.type === 'frameAck') { window.ack(message.seq); return; }
        if (message.type === 'ping' && Number.isSafeInteger(message.id)) { send(socket, { event:'pong', id:message.id }); return; }
        if (!Number.isSafeInteger(message.id) || message.id <= lastId || pending >= 16) throw new Error('Invalid command sequence');
        lastId = message.id;
        const command = validateCommand(message);
        pending++;
        driver.call(command).then(() => send(socket, { event:'ack', id:message.id, ok:true }),
          () => send(socket, { event:'ack', id:message.id, ok:false,
            error:'Thao tác chưa được xác nhận. Kiểm tra trang trước khi thử lại.' }))
          .finally(() => { pending--; });
      } catch { socket.close(1008, 'Invalid browser request'); }
    });
  });
  // Protocol pings detect dead peers without depending on page activity.
  const heartbeat = setInterval(() => {
    for (const socket of [...publicWS.clients, ...privateWS.clients]) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false; socket.ping();
    }
  }, 15000); heartbeat.unref();
  for (const wss of [publicWS, privateWS]) wss.on('connection', socket => {
    socket.isAlive = true; socket.on('pong', () => { socket.isAlive = true; });
  });
  const stale = setInterval(() => {
    for (const [socket, window] of viewers) if (window.stale()) socket.terminate();
  }, 1000); stale.unref();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/chat/api/status') { json(res, 200, driver.status); return; }
    if (req.method === 'GET') {
      const names = { '/chat/':'viewer.html', '/chat/viewer.js':'viewer.js',
        '/chat/input-buffer.js':'input-buffer.js', '/chat/viewer.css':'viewer.css' };
      if (names[pathname]) {
        const name = names[pathname], type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
        res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control':'no-store',
          'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'",
          'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' });
        res.end(fs.readFileSync(path.join(__dirname, name))); return;
      }
      if (canaryFile && pathname === '/__native_canary') {
        res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' });
        res.end(fs.readFileSync(canaryFile)); return;
      }
    }
    if (['/chat/api/frames','/chat/api/input','/chat/api/control','/chat/api/socket'].includes(pathname)) {
      json(res, 426, { error:'Reload the viewer to use WebSocket streaming.' }); return;
    }
    json(res, 404, { error:'Not found' });
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__driver/socket') {
      const actual = Buffer.from(req.headers.authorization || ''), wanted = Buffer.from('Bearer ' + (driver.token || ''));
      if (!driver.token || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) { reject(socket, 401); return; }
      if (driver.socket?.readyState === 1) { reject(socket, 409); return; }
      privateWS.handleUpgrade(req, socket, head, ws => { privateWS.emit('connection', ws); driver.attach(ws); });
      return;
    }
    if (pathname !== '/chat/api/socket') { reject(socket, 404); return; }
    if (!sameOrigin(req)) { reject(socket, 403); return; }
    if (viewers.size >= 8) { reject(socket, 429); return; }
    publicWS.handleUpgrade(req, socket, head, ws => publicWS.emit('connection', ws));
  });
  server.closeViewers = () => { for (const socket of viewers.keys()) socket.terminate(); };
  server.on('close', () => {
    clearInterval(heartbeat); clearInterval(stale);
    server.closeViewers(); for (const socket of privateWS.clients) socket.terminate();
    publicWS.close(); privateWS.close();
    driver.off('frame', onFrame); driver.off('status', onStatus); driver.off('notice', onNotice);
  });
  return server;
}
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.env.CHAT_WEB_NATIVE_CONFIG, 'utf8'));
  const driver = new Driver(config.token);
  const server = createNativeServer(driver, { canaryFile: process.env.CHAT_WEB_CANARY === '1'
    ? path.join(__dirname, '../tests/native_canary.html') : undefined });
  server.listen(Number(process.env.CHAT_WEB_NATIVE_PORT || 3000), '127.0.0.1', () => console.log('Native web bridge ready'));
  const stop = () => { server.closeViewers(); driver.close(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createNativeServer, Driver, validateCommand };