'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');

class Driver extends EventEmitter {
  constructor(token) {
    super(); this.token = token; this.next = 0; this.pending = new Map(); this.queue = []; this.waiter = null;
    this.status = { ready: false, message: 'Đang chờ Chrome trên máy cá nhân…' }; this.frame = null; this.lastSeen = 0;
    this.health = setInterval(() => {
      if (this.status.ready && Date.now() - this.lastSeen > 45000)
        this.receive({ event:'status', ready:false, message:'Mất kết nối tới helper Chrome. Chạy lại bridge trên máy cá nhân.' });
    }, 15000); this.health.unref();
  }
  receive(message) {
    if (message.event === 'frame' && typeof message.data === 'string' && message.data.length < 5 * 1024 * 1024) {
      if (!this.status.ready) this.receive({event:'status',ready:true,message:'Đã kết nối Chrome trên máy cá nhân.'});
      this.frame = { data: message.data, width: message.width, height: message.height }; this.emit('frame', this.frame);
    } else if (message.event === 'status') {
      this.status = { ready: !!message.ready, message: String(message.message || '') }; this.emit('status', this.status);
    } else if (message.event === 'notice') this.emit('notice', message);
    else if (message.id) {
      const job = this.pending.get(message.id); if (!job) return;
      this.pending.delete(message.id); clearTimeout(job.timer);
      if (message.ok) job.resolve(); else job.reject(new Error('Browser action failed'));
    }
  }
  nextCommand(res) {
    if (this.waiter) { json(res, 409, { error: 'Another driver is connected' }); return; }
    if (this.queue.length) { json(res, 200, this.queue.shift()); return; }
    const timer = setTimeout(() => {
      if (this.waiter?.res === res) this.waiter = null;
      json(res, 200, { type: 'idle' });
    }, 15000);
    this.waiter = { res, timer };
    res.on('close', () => {
      clearTimeout(timer);
      if (this.waiter?.res === res) this.waiter = null;
    });
  }
  call(value) {
    if (!this.status.ready) return Promise.reject(new Error('Browser is not connected'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Browser is busy'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.queue = this.queue.filter(item => item.id !== id);
        reject(new Error('Browser input timed out; do not automatically retry'));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      const command = { id, ...value };
      if (this.waiter) {
        const { res, timer: waitTimer } = this.waiter; this.waiter = null; clearTimeout(waitTimer);
        json(res, 200, command);
      } else this.queue.push(command);
    });
  }
  close() {
    clearInterval(this.health);
    if (this.waiter) {
      const { res, timer } = this.waiter; this.waiter = null; clearTimeout(timer);
      json(res, 200, { type: 'shutdown' });
    }
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Bridge stopped')); }
    this.pending.clear();
  }
}
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function createNativeServer(driver, { canaryFile } = {}) {
  const clients = new Set();
  function broadcast(event, data) {
    const packet = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of clients) {
      if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); continue; }
      res.write(packet);
    }
  }
  for (const event of ['frame','status','notice']) driver.on(event, value => broadcast(event, value));
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/__driver/')) {
      const actual = Buffer.from(req.headers.authorization || '');
      const wanted = Buffer.from('Bearer ' + (driver.token || ''));
      if (!driver.token || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
        json(res, 401, { error: 'Unauthorized driver' }); return;
      }
      driver.lastSeen = Date.now();
      if (req.method === 'GET' && pathname === '/__driver/next') { driver.nextCommand(res); return; }
      if (req.method === 'POST' && pathname === '/__driver/event') {
        let size = 0; const chunks = [];
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 6 * 1024 * 1024) { json(res, 413, { error: 'Frame too large' }); return; }
            chunks.push(chunk);
          }
          driver.receive(JSON.parse(Buffer.concat(chunks).toString())); json(res, 200, { ok: true });
        } catch { json(res, 400, { error: 'Invalid driver event' }); }
        return;
      }
      json(res, 404, { error: 'Not found' }); return;
    }
    if (req.method === 'GET' && pathname === '/chat/api/status') { json(res, 200, driver.status); return; }
    if (req.method === 'GET' && pathname === '/chat/api/frames') {
      if (clients.size >= 8) { json(res, 429, { error: 'Too many viewers' }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no', connection: 'keep-alive' });
      res.write(':' + ' '.repeat(4096) + '\n\n');
      clients.add(res);
      res.write('event: status\ndata: ' + JSON.stringify(driver.status) + '\n\n');
      if (driver.frame) res.write('event: frame\ndata: ' + JSON.stringify(driver.frame) + '\n\n');
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      res.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }
    if (req.method === 'GET') {
      const names = { '/chat/': 'viewer.html', '/chat/viewer.js': 'viewer.js', '/chat/viewer.css': 'viewer.css' };
      if (names[pathname]) {
        const name = names[pathname], type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
        res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        res.end(fs.readFileSync(path.join(__dirname, name))); return;
      }
      if (canaryFile && pathname === '/__native_canary') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(canaryFile)); return;
      }
    }
    if (req.method === 'POST' && ['/chat/api/input','/chat/api/control'].includes(pathname)) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) throw new Error('Origin mismatch');
      } catch { json(res, 403, { error: 'Origin mismatch' }); return; }
      let size = 0, chunks = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 100000) { json(res, 413, { error: 'Input too large' }); return; }
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString());
        await driver.call(pathname.endsWith('/input') ? { type: 'input', data } : { type: 'control', action: data.action, width: data.width, height: data.height });
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Thao tác chưa được xác nhận. Kiểm tra trang trước khi thử lại.' }); }
      return;
    }
    json(res, 404, { error: 'Not found' });
  });
  server.closeViewers = () => { for (const res of clients) res.destroy(); };
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
module.exports = { createNativeServer, Driver };
