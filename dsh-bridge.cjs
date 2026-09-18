'use strict';
/*
 * dsh-bridge - lop dem giua browser (di qua Cloudflare Tunnel + proxy cong ty)
 * va DSH web (127.0.0.1:3080).
 *
 * Muc dich: proxy cong ty chan ket noi dai / stream. DSH client mo WebSocket
 * toi /api/remote.mux va KHONG co fallback HTTP. Bridge nay:
 *   1. proxy toan bo HTTP (static + /api/*) nhu cu  -> khong doi hanh vi
 *   2. pass-through WebSocket that (neu proxy cho phep) -> khong regression
 *   3. phoi them transport POLLING (request ngan, ket thuc ngay) de shim
 *      trong browser dung khi WebSocket bi chan
 *   4. tiem ws-shim.js vao index.html truoc bundle cua DSH
 *
 * Khong phu thuoc package ngoai tru ./node_modules/ws (da vendor).
 *
 * ENV:
 *   BRIDGE_HOST/BRIDGE_PORT            mac dinh 127.0.0.1:3090
 *   BRIDGE_UPSTREAM_HOST/PORT          mac dinh 127.0.0.1:3080
 *   BRIDGE_POLL_MS                     nhip poll cua client, mac dinh 600
 *   BRIDGE_OUTBOX_HIGH/LOW             nguong backpressure (byte)
 *   BRIDGE_SESSION_IDLE_MS             don session polling bo hoang
 */
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require('./node_modules/ws');

const CFG = {
  listenHost: process.env.BRIDGE_HOST || '127.0.0.1',
  listenPort: Number(process.env.BRIDGE_PORT || 3090),
  upHost: process.env.BRIDGE_UPSTREAM_HOST || '127.0.0.1',
  upPort: Number(process.env.BRIDGE_UPSTREAM_PORT || 3080),
  muxPath: '/api/remote.mux',
  prefix: '/__dsh_bridge',
  pollMs: Number(process.env.BRIDGE_POLL_MS || 600),
  outboxHigh: Number(process.env.BRIDGE_OUTBOX_HIGH || 1048576),
  outboxLow: Number(process.env.BRIDGE_OUTBOX_LOW || 262144),
  idleMs: Number(process.env.BRIDGE_SESSION_IDLE_MS || 60000),
  maxFrames: Number(process.env.BRIDGE_MAX_FRAMES || 200),
  maxBytes: Number(process.env.BRIDGE_MAX_BYTES || 524288),
};

const started = Date.now();
const stats = { http: 0, wsNative: 0, wsNativeBytes: 0, pollOpen: 0, pollRecv: 0, pollSend: 0, framesToBrowser: 0, framesFromBrowser: 0, blobUploads: 0, blobChunks: 0, blobBytes: 0 };

function log() {
  console.log('[' + new Date().toISOString() + ']', Array.prototype.slice.call(arguments).join(' '));
}
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}
function readBody(req, limit) {
  const cap = limit || 8 * 1024 * 1024;
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > cap) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
function readJson(req) {
  return readBody(req).then(function (buf) {
    if (buf.length === 0) return {};
    return JSON.parse(buf.toString('utf8'));
  });
}

/* ------------------------------------------------------------------ *
 * 1. HTTP proxy (static + /api/*) - giu nguyen header, stream response
 * ------------------------------------------------------------------ */

const SHIM_TAG = '<script src="' + CFG.prefix + '/ws-shim.js"></script>';

function injectShim(html) {
  const m = /<head[^>]*>/i.exec(html);
  if (m) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + SHIM_TAG + html.slice(at);
  }
  return SHIM_TAG + html;
}

function proxyHttp(req, res) {
  const headers = Object.assign({}, req.headers);
  // Goi y upstream tra ve identity de bridge co the tiem script vao HTML.
  // Cloudflare se tu nen lai khi tra cho browser.
  headers['accept-encoding'] = 'identity';
  const up = http.request({
    host: CFG.upHost,
    port: CFG.upPort,
    method: req.method,
    path: req.url,
    headers: headers,
  }, function (upRes) {
    stats.http += 1;
    const ctype = String(upRes.headers['content-type'] || '');
    if (!ctype.toLowerCase().startsWith('text/html')) {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      return;
    }
    const chunks = [];
    upRes.on('data', function (c) { chunks.push(c); });
    upRes.on('end', function () {
      let html = Buffer.concat(chunks).toString('utf8');
      if (html.indexOf(CFG.prefix + '/ws-shim.js') === -1) html = injectShim(html);
      const out = Buffer.from(html, 'utf8');
      const h = Object.assign({}, upRes.headers);
      delete h['content-encoding'];
      delete h['transfer-encoding'];
      h['content-length'] = out.length;
      res.writeHead(upRes.statusCode, h);
      res.end(out);
      log('HTTP', req.method, req.url, '->', upRes.statusCode, '(html ' + out.length + 'B, shim ' + (html.indexOf('ws-shim.js') !== -1 ? 'injected' : 'MISSING') + ')');
    });
  });
  up.on('error', function (e) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh-bridge: upstream error: ' + e.message + '\n');
    } else {
      res.destroy();
    }
  });
  req.pipe(up);
}

/* ------------------------------------------------------------------ *
 * 2. Pass-through WebSocket native (raw TCP tunnel, khong decode frame)
 * ------------------------------------------------------------------ */

function handleUpgrade(req, socket, head) {
  const pathname = String(req.url || '').split('?')[0];
  if (pathname !== CFG.muxPath) {
    socket.destroy();
    return;
  }
  stats.wsNative += 1;
  const id = crypto.randomUUID().slice(0, 8);
  log('WS native', id, 'open from', socket.remoteAddress, 'host=' + (req.headers.host || '-'));
  const up = net.connect(CFG.upPort, CFG.upHost, function () {
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1'];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('data', function (c) { stats.wsNativeBytes += c.length; });
  up.on('error', function (e) {
    log('WS native', id, 'upstream error:', e.message);
    socket.destroy();
  });
  socket.on('error', function () { up.destroy(); });
  up.on('close', function () { socket.destroy(); });
  socket.on('close', function () { up.destroy(); log('WS native', id, 'closed'); });
}

/* ------------------------------------------------------------------ *
 * 3. Transport polling
 * ------------------------------------------------------------------ */

const sessions = new Map();

function pollOpen(req, res) {
  readJson(req).then(function (body) {
    const headers = { host: req.headers.host || CFG.upHost + ':' + CFG.upPort };
    if (req.headers.origin) headers.origin = req.headers.origin;
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (body && body.session) headers['x-dsh-bridge-session'] = String(body.session);
    const url = 'ws://' + CFG.upHost + ':' + CFG.upPort + CFG.muxPath;
    const ws = new WebSocket(url, { headers: headers, perMessageDeflate: false });
    const sid = crypto.randomUUID();
    const session = {
      sid: sid, ws: ws, outbox: [], base: 0, bytes: 0, paused: false,
      lastSeen: Date.now(), createdAt: Date.now(), closed: false, error: null,
    };
    sessions.set(sid, session);
    let settled = false;
    function fail(status, message) {
      if (settled) return;
      settled = true;
      sessions.delete(sid);
      sendJson(res, status, { error: message });
    }
    ws.on('open', function () {
      stats.pollOpen += 1;
      if (settled) return;
      settled = true;
      log('POLL session', sid.slice(0, 8), 'opened (host=' + headers.host + ', poll=' + CFG.pollMs + 'ms)');
      sendJson(res, 200, { sid: sid, cursor: 0, pollMs: CFG.pollMs });
    });
    ws.on('message', function (data, isBinary) {
      if (isBinary) return;
      const text = data.toString('utf8');
      session.outbox.push(text);
      session.bytes += Buffer.byteLength(text);
      stats.framesToBrowser += 1;
      if (session.bytes > CFG.outboxHigh && !session.paused) {
        session.paused = true;
        try { ws.pause(); } catch (e) {}
        log('POLL session', sid.slice(0, 8), 'backpressure ON (' + session.bytes + 'B queued)');
      }
    });
    ws.on('close', function (code, reason) {
      session.closed = true;
      log('POLL session', sid.slice(0, 8), 'upstream closed', code);
      if (!settled) fail(502, 'upstream closed before open: ' + code);
    });
    ws.on('error', function (e) {
      session.error = e.message;
      log('POLL session', sid.slice(0, 8), 'upstream error:', e.message);
      if (!settled) fail(502, 'upstream error: ' + e.message);
    });
    ws.on('unexpected-response', function (r) {
      fail(502, 'upstream rejected upgrade: HTTP ' + r.statusCode);
    });
  }).catch(function (e) { sendJson(res, 400, { error: e.message }); });
}

function pollSend(req, res) {
  readJson(req).then(function (body) {
    const s = sessions.get(String(body.sid || ''));
    if (!s) return sendJson(res, 409, { error: 'no such session' });
    if (s.ws.readyState !== WebSocket.OPEN) return sendJson(res, 409, { error: 'session closed' });
    const frames = Array.isArray(body.frames) ? body.frames : [];
    stats.pollSend += 1;
    for (const f of frames) {
      s.ws.send(String(f));
      stats.framesFromBrowser += 1;
    }
    s.lastSeen = Date.now();
    sendJson(res, 200, { ok: true, count: frames.length });
  }).catch(function (e) { sendJson(res, 400, { error: e.message }); });
}

function pollRecv(req, res, url) {
  const s = sessions.get(String(url.searchParams.get('sid') || ''));
  if (!s) return sendJson(res, 409, { error: 'no such session' });
  const cursor = Number(url.searchParams.get('cursor') || 0);
  s.lastSeen = Date.now();
  stats.pollRecv += 1;

  if (cursor < s.base) {
    // Client tut lai qua xa: bao reset de no dong socket va resync.
    return sendJson(res, 200, { reset: true, cursor: s.base, frames: [] });
  }
  const start = cursor - s.base;
  const frames = [];
  let bytes = 0;
  for (let i = start; i < s.outbox.length; i++) {
    const f = s.outbox[i];
    if (frames.length >= CFG.maxFrames || (frames.length > 0 && bytes + f.length > CFG.maxBytes)) break;
    frames.push(f);
    bytes += f.length;
  }
  if (frames.length > 0) {
    s.outbox.splice(0, frames.length);
    s.base += frames.length;
    s.bytes -= frames.reduce(function (a, f) { return a + Buffer.byteLength(f); }, 0);
  }
  const more = s.outbox.length > 0;
  if (s.paused && s.bytes < CFG.outboxLow) {
    s.paused = false;
    try { s.ws.resume(); } catch (e) {}
    log('POLL session', s.sid.slice(0, 8), 'backpressure OFF');
  }
  sendJson(res, 200, { cursor: s.base, frames: frames, more: more, queued: s.outbox.length, closed: s.closed });
}

function pollClose(req, res) {
  readJson(req).then(function (body) {
    const s = sessions.get(String(body.sid || ''));
    if (s) {
      sessions.delete(s.sid);
      try { s.ws.close(1000, 'client closed'); } catch (e) {}
      log('POLL session', s.sid.slice(0, 8), 'closed by client');
    }
    sendJson(res, 200, { ok: true });
  }).catch(function (e) { sendJson(res, 400, { error: e.message }); });
}

setInterval(function () {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastSeen > CFG.idleMs) {
      sessions.delete(s.sid);
      try { s.ws.close(1000, 'idle'); } catch (e) {}
      log('POLL session', s.sid.slice(0, 8), 'reaped (idle)');
    }
  }
}, 10000).unref();

/* ------------------------------------------------------------------ *
 * 3b. Chunked blob: nhan anh/file lon qua nhieu POST nho roi day 1 lan
 *     xuong DSH (doan nay chay qua loopback nen khong qua proxy).
 * ------------------------------------------------------------------ */

const blobs = new Map();
const BLOB_IDLE_MS = 10 * 60 * 1000;

function blobInit(req, res) {
  readJson(req).then(function (body) {
    const target = String(body.url || '');
    if (target.charAt(0) !== '/' || target.indexOf(CFG.prefix) === 0) {
      return sendJson(res, 400, { error: 'invalid target url' });
    }
    const forwarded = {};
    const meta = body.headers || {};
    for (const k of Object.keys(meta)) forwarded[String(k).toLowerCase()] = String(meta[k]);
    if (req.headers.host) forwarded['host'] = req.headers.host;
    if (req.headers.origin) forwarded['origin'] = req.headers.origin;
    if (req.headers.cookie) forwarded['cookie'] = req.headers.cookie;
    const bid = crypto.randomUUID();
    const file = path.join(os.tmpdir(), 'dsh-bridge-' + bid + '.bin');
    fs.writeFileSync(file, Buffer.alloc(0));
    blobs.set(bid, { bid: bid, file: file, url: target, method: String(body.method || 'POST'), headers: forwarded, size: Number(body.size || 0), received: 0, seq: 0, createdAt: Date.now() });
    log('BLOB', bid.slice(0, 8), 'init size=' + Number(body.size || 0) + ' -> ' + target.slice(0, 90));
    sendJson(res, 200, { bid: bid });
  }).catch(function (e) { sendJson(res, 400, { error: e.message }); });
}

function blobChunk(req, res, url) {
  const b = blobs.get(String(url.searchParams.get('bid') || ''));
  if (!b) return sendJson(res, 409, { error: 'no such blob' });
  const seq = Number(url.searchParams.get('seq') || 0);
  if (seq !== b.seq) return sendJson(res, 409, { error: 'out of order chunk: expected ' + b.seq + ', got ' + seq });
  const out = fs.createWriteStream(b.file, { flags: 'a' });
  let size = 0;
  req.on('data', function (c) { size += c.length; });
  req.on('error', function () { try { out.destroy(); } catch (e) {} });
  out.on('error', function (e) { if (!res.headersSent) sendJson(res, 500, { error: 'write failed: ' + e.message }); });
  out.on('finish', function () {
    b.received += size;
    b.seq += 1;
    stats.blobChunks += 1;
    stats.blobBytes += size;
    sendJson(res, 200, { ok: true, received: b.received, seq: b.seq });
  });
  req.pipe(out);
}

function blobFinish(req, res, url) {
  const b = blobs.get(String(url.searchParams.get('bid') || ''));
  if (!b) return sendJson(res, 409, { error: 'no such blob' });
  blobs.delete(b.bid);
  stats.blobUploads += 1;
  let settled = false;
  const cleanup = function () { try { fs.unlinkSync(b.file); } catch (e) {} };
  const fail = function (status, message) {
    if (settled) return;
    settled = true;
    cleanup();
    sendJson(res, status, { error: message });
  };
  let size = 0;
  try { size = fs.statSync(b.file).size; } catch (e) { return fail(500, 'temp file missing'); }
  const headers = Object.assign({}, b.headers);
  if (req.headers.host) headers['host'] = req.headers.host;
  if (req.headers.origin) headers['origin'] = req.headers.origin;
  if (req.headers.cookie) headers['cookie'] = req.headers.cookie;
  if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  headers['content-length'] = size;
  if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
  let gotResponse = false;
  const up = http.request({ host: CFG.upHost, port: CFG.upPort, method: b.method, path: b.url, headers: headers }, function (upRes) {
    gotResponse = true;
    const chunks = [];
    upRes.on('data', function (c) { chunks.push(c); });
    upRes.on('end', function () {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks);
      log('BLOB', b.bid.slice(0, 8), 'finish ' + size + 'B -> DSH ' + upRes.statusCode + ' (' + body.length + 'B)');
      cleanup();
      res.writeHead(upRes.statusCode, { 'content-type': upRes.headers['content-type'] || 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
      res.end(body);
    });
    upRes.on('error', function (e) { fail(502, 'upstream response: ' + e.message); });
  });
  up.on('error', function (e) {
    if (gotResponse) return;
    fail(502, 'upstream: ' + e.message);
  });
  if (size <= 64 * 1024 * 1024) {
    let buf;
    try { buf = fs.readFileSync(b.file); } catch (e) { return fail(500, 'read failed: ' + e.message); }
    try { up.end(buf); } catch (e) { if (!gotResponse) fail(502, 'send failed: ' + e.message); }
  } else {
    fs.createReadStream(b.file).on('error', function (e) { try { up.destroy(); } catch (e2) {} fail(500, 'read failed: ' + e.message); }).pipe(up);
  }
}

function blobAbort(req, res, url) {
  const b = blobs.get(String(url.searchParams.get('bid') || ''));
  if (b) {
    blobs.delete(b.bid);
    try { fs.unlinkSync(b.file); } catch (e) {}
    log('BLOB', b.bid.slice(0, 8), 'abort');
  }
  sendJson(res, 200, { ok: true });
}

setInterval(function () {
  const now = Date.now();
  for (const b of blobs.values()) {
    if (now - b.createdAt > BLOB_IDLE_MS) {
      blobs.delete(b.bid);
      try { fs.unlinkSync(b.file); } catch (e) {}
      log('BLOB', b.bid.slice(0, 8), 'reaped (idle)');
    }
  }
}, 60000).unref();

/* ------------------------------------------------------------------ *
 * 3c. Dang nhap: doi ma PIN lay cookie phien cua DSH
 *     (browser may khac khong co cookie -> 401; day la duong vao gon,
 *      khong can DevTools va khong phai chep URL token dai)
 * ------------------------------------------------------------------ */

const LOGIN_KEY_FILE = path.join(__dirname, '.login-key');
const LOGIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const loginAttempts = new Map();

function loadLoginKey() {
  const fromEnv = process.env.BRIDGE_LOGIN_KEY;
  if (fromEnv === 'off' || fromEnv === 'disabled') return 'off';
  if (fromEnv) return fromEnv.trim();
  let key = '';
  try { key = fs.readFileSync(LOGIN_KEY_FILE, 'utf8').trim(); } catch (e) { key = ''; }
  if (!key) {
    key = '';
    const bytes = crypto.randomBytes(12);
    for (let i = 0; i < 12; i++) key += LOGIN_ALPHABET[bytes[i] % LOGIN_ALPHABET.length];
    try { fs.writeFileSync(LOGIN_KEY_FILE, key + '\n'); } catch (e) {}
  }
  return key;
}
const LOGIN_KEY = loadLoginKey();
const LOGIN_TICKETS = new Map();
const TICKET_TTL_MS = 10 * 60 * 1000;
function mintTicket() {
  const now = Date.now();
  for (const [k, v] of LOGIN_TICKETS) { if (v <= now) LOGIN_TICKETS.delete(k); }
  const t = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  LOGIN_TICKETS.set(t, now + TICKET_TTL_MS);
  return t;
}
function consumeTicket(t) {
  const exp = LOGIN_TICKETS.get(t);
  if (exp === void 0) return false;
  LOGIN_TICKETS.delete(t);
  return exp > Date.now();
}
function ticketGet(req, res, url) {
  if (LOGIN_KEY === 'off') return sendJson(res, 404, { error: 'login disabled' });
  // LUU Y: moi request qua Cloudflare deu den tu 127.0.0.1 (cloudflared o local),
  // nen "loopback" KHONG phai la mot cho dua duoc. Bat buoc phai co ma PIN.
  const ip = String(req.socket.remoteAddress || '?');
  if (rateLimited(req)) return loginTooMany(res, ip);
  const given = String(url.searchParams.get('k') || '').trim().toUpperCase();
  if (!given || !safeEqual(given, LOGIN_KEY)) {
    const now = Date.now();
    const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
    const next = { count: now < rec.until ? rec.count + 1 : 1, until: now + 60000 };
    loginAttempts.set(ip, next);
    log('TICKET', ip, 'sai ma PIN khi tao ticket (' + next.count + ' lan)');
    return sendJson(res, 403, { error: 'sai ma PIN' });
  }
  loginAttempts.delete(ip);
  const host = String(url.searchParams.get('host') || req.headers.host || '');
  const proto = String(req.headers['x-forwarded-proto'] || '').indexOf('https') !== -1 ? 'https' : 'http';
  const t = mintTicket();
  log('TICKET tao moi cho host ' + host + ', het han sau ' + (TICKET_TTL_MS / 60000) + ' phut');
  sendJson(res, 200, { ticket: t, url: proto + '://' + host + CFG.prefix + '/login?t=' + t, ttlSeconds: TICKET_TTL_MS / 1000, oneTime: true });
}

function dshSigningSecret() {
  try {
    const text = fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('browser-session') !== -1) {
        for (let j = i + 1; j < lines.length; j++) {
          const m = /^\s*secret:\s*([A-Za-z0-9_-]{43})\s*$/.exec(lines[j]);
          if (m) return m[1];
          if (j > i + 1 && /^\S/.test(lines[j])) break;
        }
      }
    }
    const m2 = /^\s*secret:\s*([A-Za-z0-9_-]{43})\s*$/.m.exec(text);
    return m2 ? m2[1] : '';
  } catch (e) { return ''; }
}
function b64u(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function mintDshCookie(authority) {
  const secret = dshSigningSecret();
  if (!secret) return null;
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = { version: 1, authority: authority, issuedAt: now, expiresAt: now + 30 * 86400000 };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64u(crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest());
  return { name: name, value: 'v1.' + body + '.' + sig, maxAge: 2592000 };
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function loginPage(message) {
  const err = message ? '<p class="bad">' + message + '</p>' : '';
  return '<!doctype html><html lang="vi"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>dsh-bridge dang nhap</title>'
    + '<style>body{font:15px/1.6 system-ui,Segoe UI,sans-serif;max-width:420px;margin:12vh auto;padding:0 18px;color:#111}'
    + 'input{width:100%;padding:10px;font:16px/1.4 ui-monospace,Consolas,monospace;letter-spacing:2px;text-transform:uppercase;box-sizing:border-box}'
    + 'button{margin-top:12px;width:100%;padding:11px;font-size:15px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}'
    + '.ok{color:#0a7d28}.bad{color:#b3261e}.muted{color:#666;font-size:13px}</style></head><body>'
    + '<h2>dsh-bridge</h2>'
    + '<p>Nh\u1eadp m\u00e3 PIN c\u1ee7a b\u1ea1n \u0111\u1ec3 l\u1ea5y phi\u00ean \u0111\u0103ng nh\u1eadp DSH.</p>'
    + err
    + '<form method="POST" action="' + CFG.prefix + '/login"><input name="k" autocomplete="off" autofocus placeholder="PIN">'
    + '<button type="submit">\u0110\u0103ng nh\u1eadp</button></form>'
    + '<p class="muted">M\u00e3 PIN n\u1eb1m \u1edf <code>D:\\dev\\dsh\\bridge\\.login-key</code>. '
    + 'Sau khi \u0111\u0103ng nh\u1eadp m\u1ed9t l\u1ea7n, browser nh\u1edb 30 ng\u00e0y.</p>'
    + '<p class="muted">Ho\u1eb7c d\u00f9ng link m\u1ed9t l\u1ea7n: <code>' + CFG.prefix + '/login?t=&lt;ticket&gt;</code>, t\u1ea1o b\u1eb1ng <code>' + CFG.prefix + '/ticket</code> t\u1eeb m\u00e1y ch\u1ee7.</p>'
    + '</body></html>';
}
function loginFail(res, ip, why) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  const next = { count: now < rec.until ? rec.count + 1 : 1, until: now + 60000 };
  loginAttempts.set(ip, next);
  log('LOGIN', ip, why + ' (' + next.count + ' lan sai)');
  const body = Buffer.from(loginPage('M\u00e3 PIN kh\u00f4ng \u0111\u00fang. Th\u1eed l\u1ea1i.'), 'utf8');
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
}
function loginTooMany(res, ip) {
  log('LOGIN', ip, 'bi chan tam thoi (qua nhieu lan sai)');
  sendJson(res, 429, { error: 'too many attempts' });
}
function rateLimited(req) {
  const ip = String(req.socket.remoteAddress || '?');
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  return Date.now() < rec.until && rec.count >= 5;
}
function grantLogin(req, res, ip, why) {
  const authority = String(req.headers.host || '');
  const cookie = mintDshCookie(authority);
  if (!cookie) {
    log('LOGIN', ip, 'khong doc duoc secret ky cookie cua DSH');
    return sendJson(res, 500, { error: 'khong doc duoc secret cua DSH' });
  }
  loginAttempts.delete(ip);
  const secure = String(req.headers['x-forwarded-proto'] || '').indexOf('https') !== -1;
  const setCookie = cookie.name + '=' + cookie.value + '; Path=/; Max-Age=' + cookie.maxAge + (secure ? '; Secure' : '') + '; SameSite=Lax';
  log('LOGIN', ip, 'thanh cong (' + why + '), cap cookie cho ' + authority);
  res.writeHead(303, { location: '/', 'set-cookie': setCookie, 'cache-control': 'no-store', 'content-length': 0 });
  res.end();
}
function loginGet(req, res, url) {
  if (LOGIN_KEY === 'off') return sendJson(res, 404, { error: 'login disabled' });
  const ip = String(req.socket.remoteAddress || '?');
  const ticket = String(url.searchParams.get('t') || '');
  const key = String(url.searchParams.get('k') || '').trim().toUpperCase();
  if (ticket) {
    if (consumeTicket(ticket)) return grantLogin(req, res, ip, 'link ticket mot lan');
    return loginFail(res, ip, 'ticket sai hoac da dung');
  }
  if (key) {
    if (rateLimited(req)) return loginTooMany(res, ip);
    if (safeEqual(key, LOGIN_KEY)) return grantLogin(req, res, ip, 'link co key');
    return loginFail(res, ip, 'sai key tren link');
  }
  const body = Buffer.from(loginPage(''), 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
}
function loginPost(req, res) {
  if (LOGIN_KEY === 'off') return sendJson(res, 404, { error: 'login disabled' });
  const ip = String(req.socket.remoteAddress || '?');
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (rateLimited(req)) {
    log('LOGIN', ip, 'bi chan tam thoi (qua nhieu lan sai)');
    return sendJson(res, 429, { error: 'too many attempts' });
  }
  readBody(req, 4096).then(function (buf) {
    const params = new URLSearchParams(buf.toString('utf8'));
    const given = String(params.get('k') || '').trim().toUpperCase();
    if (!given || !safeEqual(given, LOGIN_KEY)) {
      const next = { count: now < rec.until ? rec.count + 1 : 1, until: now + 60000 };
      loginAttempts.set(ip, next);
      log('LOGIN', ip, 'sai ma PIN (' + next.count + ' lan)');
      const body = Buffer.from(loginPage('M\u00e3 PIN kh\u00f4ng \u0111\u00fang. Th\u1eed l\u1ea1i.'), 'utf8');
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
      res.end(body);
      return;
    }
    grantLogin(req, res, ip, 'form PIN');
  }).catch(function (e) { sendJson(res, 400, { error: e.message }); });
}

/* ------------------------------------------------------------------ *
 * 4. Chan doan proxy
 * ------------------------------------------------------------------ */

function diagPage() {
  const lines = [
    '<!doctype html><html lang="vi"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>dsh-bridge chan doan</title>',
    '<style>body{font:14px/1.55 system-ui,Segoe UI,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111}',
    'code{background:#f2f2f2;padding:1px 5px;border-radius:4px}.ok{color:#0a7d28;font-weight:600}.bad{color:#b3261e;font-weight:600}',
    'pre{background:#0f172a;color:#e6edf3;padding:12px;border-radius:8px;overflow:auto;max-height:320px}',
    'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left}</style>',
    '</head><body>',
    '<h2>dsh-bridge &mdash; chan doan proxy cong ty</h2>',
    '<p>Mo trang nay tu may cong ty, qua chinh link tunnel. Ket qua cho biet proxy chan cai gi.</p>',
    '<table id="t"><tr><th>Phep thu</th><th>Ket qua</th><th>Ket luan</th></tr></table>',
    '<pre id="log"></pre>',
    '<script>',
    'var out = document.getElementById("log");',
    'var NL = String.fromCharCode(10);',
    'function say(s){ out.textContent += s + NL; }',
    'function row(name, val, verdict, good){',
    '  var tr = document.createElement("tr");',
    '  [name, val, verdict].forEach(function (t, i) { var td = document.createElement("td"); td.textContent = t; if (i === 2) td.className = good ? "ok" : "bad"; tr.appendChild(td); });',
    '  document.getElementById("t").appendChild(tr);',
    '}',
    'function ms(x){ return Math.round(x) + " ms"; }',
    'var wsOk = false, pollOk = false;',
    '(async function(){',
    '  var t0 = performance.now();',
    '  try {',
    '    var r = await fetch("/__dsh_bridge/diag/echo", { method:"POST", body:"x".repeat(2048), cache:"no-store" });',
    '    await r.text();',
    '    var dt = performance.now() - t0;',
    '    row("POST ngan 2 KB", ms(dt), dt < 3000 ? "di duoc" : "rat cham", dt < 3000);',
    '  } catch (e) { row("POST ngan 2 KB", String(e), "bi chan", false); }',
    '  await new Promise(function(res){',
    '    var done = false;',
    '    var u = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/remote.mux";',
    '    var t = performance.now();',
    '    var ws;',
    '    try { ws = new WebSocket(u); } catch (e) { row("WebSocket", String(e), "bi chan", false); res(); return; }',
    '    var timer = setTimeout(function(){ if(!done){done=true; row("WebSocket", "timeout 6s", "bi chan hoac buffer", false); try{ws.close();}catch(e){} res(); } }, 6000);',
    '    ws.onopen = function(){ if(!done){ done=true; wsOk=true; clearTimeout(timer); row("WebSocket", ms(performance.now()-t), "mo duoc (101)", true); try{ws.close();}catch(e){} res(); } };',
    '    ws.onerror = function(){ if(!done){ done=true; clearTimeout(timer); row("WebSocket", ms(performance.now()-t), "bi chan", false); res(); } };',
    '    ws.onclose = function(ev){ if(!done){ done=true; clearTimeout(timer); row("WebSocket", "close " + ev.code, "bi dong ngay", false); res(); } };',
    '  });',
    '  try {',
    '    var t1 = performance.now();',
    '    var r2 = await fetch("/__dsh_bridge/diag/stream?ms=6000", { cache:"no-store" });',
    '    var reader = r2.body.getReader();',
    '    var first = 0, total = 0;',
    '    for(;;){ var c = await reader.read(); if (c.done) break; if (!first) first = performance.now() - t1; total = performance.now() - t1; }',
    '    row("Stream 6s", "byte dau " + ms(first) + ", het " + ms(total), first < 1500 ? "khong buffer (stream song)" : "BI BUFFER", first < 1500);',
    '  } catch (e) { row("Stream 6s", String(e), "khong ho tro stream", false); }',
    '  try {',
    '    var t2 = performance.now();',
    '    var open = await (await fetch("/__dsh_bridge/poll/open", { method:"POST", headers:{"content-type":"application/json"}, body:"{}", cache:"no-store" })).json();',
    '    if (!open.sid) throw new Error(open.error || "khong mo duoc session polling");',
    '    var sid = open.sid, cursor = open.cursor || 0;',
    '    var muxMsg = JSON.stringify({ type:"open", streamId:"diag1", endpoint:"$events", payload:{ args:{} } });',
    '    await fetch("/__dsh_bridge/poll/send", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ sid: sid, frames: [muxMsg] }), cache:"no-store" });',
    '    var got = null;',
    '    var deadline = Date.now() + 5000;',
    '    while (Date.now() < deadline && !got) {',
    '      var r3 = await (await fetch("/__dsh_bridge/poll/recv?sid=" + encodeURIComponent(sid) + "&cursor=" + cursor, { cache:"no-store" })).json();',
    '      cursor = r3.cursor;',
    '      var fr = r3.frames || [];',
    '      for (var i = 0; i < fr.length; i++) { if (fr[i].indexOf("ready") !== -1) got = fr[i]; }',
    '      if (!fr.length) await new Promise(function(r){ setTimeout(r, 300); });',
    '    }',
    '    await fetch("/__dsh_bridge/poll/close", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ sid: sid }), cache:"no-store" });',
    '    pollOk = !!got;',
    '    row("Transport polling (duong fallback)", ms(performance.now()-t2), got ? "CHAY DUOC - GUI se tu dung duong nay" : "khong nhan duoc ready", !!got);',
    '  } catch (e) { row("Transport polling (duong fallback)", String(e), "loi - khong dung duoc", false); }',
    '  try {',
    '    var big = new Uint8Array(2 * 1024 * 1024);',
    '    var t3 = performance.now();',
    '    var rb = await fetch("/__dsh_bridge/diag/echo", { method:"POST", body: big, cache:"no-store" });',
    '    var jb = await rb.json();',
    '    var okBig = (jb.bytes === big.length);',
    '    row("POST 2 MB", ms(performance.now()-t3), okBig ? "di duoc ca request lon" : "lech byte", okBig);',
    '  } catch (e) { row("POST 2 MB", String(e), "bi chan -> can chunking (da co san)", false); }',
    '  if (wsOk) row("KET LUAN", "", "WebSocket chay duoc - dung native, khong can gi them", true);',
    '  else if (pollOk) row("KET LUAN", "", "WebSocket bi chan, polling chay - cu mo GUI, shim tu chuyen", true);',
    '  else row("KET LUAN", "", "ca hai duong deu loi - xem log bridge ben duoi", false);',
    '  say("");',
    '  say("Ep transport: them ?transport=poll hoac ?transport=native vao URL GUI (?transport=reset de ve auto).");',
    '  say("Ep kich thuoc manh upload: ?chunk=8192 (mac dinh 32768).");',
    '  row("Backend", "bridge -> DSH", "xem stats ben duoi", true);',
    '  try { var st = await (await fetch("/__dsh_bridge/diag/stats", {cache:"no-store"})).json(); say(JSON.stringify(st, null, 2)); } catch(e) { say("stats loi: " + e); }',
    '})();',
    '</script></body></html>',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 5. Router
 * ------------------------------------------------------------------ */

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://internal');
  const p = url.pathname;

  if (p === CFG.prefix + '/ws-shim.js') {
    let shim = '';
    let patch = '';
    try { shim = fs.readFileSync(path.join(__dirname, 'ws-shim.js'), 'utf8'); } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('shim missing'); return; }
    try { patch = fs.readFileSync(path.join(__dirname, 'worker-patch.js'), 'utf8'); } catch (e) { patch = ''; }
    const prelude = 'window.__DSH_BRIDGE_WORKER_PATCH__ = ' + JSON.stringify(patch) + ';\n';
    const buf = Buffer.from(prelude + shim, 'utf8');
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(buf);
    return;
  }
  if (p === CFG.prefix + '/diag') {
    const body = Buffer.from(diagPage(), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
    res.end(body);
    return;
  }
  if (p === CFG.prefix + '/diag/echo') {
    readBody(req).then(function (b) { sendJson(res, 200, { ok: true, bytes: b.length }); });
    return;
  }
  if (p === CFG.prefix + '/diag/stats') {
    return sendJson(res, 200, {
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      config: { listen: CFG.listenHost + ':' + CFG.listenPort, upstream: CFG.upHost + ':' + CFG.upPort, pollMs: CFG.pollMs },
      stats: stats,
      pollingSessions: sessions.size,
    });
  }
  if (p === CFG.prefix + '/diag/stream') {
    const total = Number(url.searchParams.get('ms') || 6000);
    const hold = Math.min(Math.max(total, 500), 30000);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
    let n = 0;
    const t = setInterval(function () {
      res.write('tick ' + (++n) + ' @' + Date.now() + '\n');
      if (n * 250 >= hold) { clearInterval(t); res.end('done after ' + n + ' ticks\n'); }
    }, 250);
    req.on('close', function () { clearInterval(t); });
    return;
  }
  if (p === CFG.prefix + '/poll/open') return pollOpen(req, res);
  if (p === CFG.prefix + '/poll/send') return pollSend(req, res);
  if (p === CFG.prefix + '/poll/recv') return pollRecv(req, res, url);
  if (p === CFG.prefix + '/poll/close') return pollClose(req, res);
  if (p === CFG.prefix + '/blob/init') return blobInit(req, res);
  if (p === CFG.prefix + '/blob/chunk') return blobChunk(req, res, url);
  if (p === CFG.prefix + '/blob/finish') return blobFinish(req, res, url);
  if (p === CFG.prefix + '/blob/abort') return blobAbort(req, res, url);
  if (p === CFG.prefix + '/login') {
    if (req.method === 'POST') return loginPost(req, res);
    return loginGet(req, res, url);
  }
  if (p === CFG.prefix + '/ticket') return ticketGet(req, res, url);

  return proxyHttp(req, res);
});

server.on('upgrade', function (req, socket, head) {
  handleUpgrade(req, socket, head);
});

server.listen(CFG.listenPort, CFG.listenHost, function () {
  log('dsh-bridge listening on http://' + CFG.listenHost + ':' + CFG.listenPort);
  log('upstream DSH  -> http://' + CFG.upHost + ':' + CFG.upPort);
  log('chan doan     -> http://' + CFG.listenHost + ':' + CFG.listenPort + CFG.prefix + '/diag');
  log('dat tunnel service tro ve cong ' + CFG.listenPort + ' (thay vi ' + CFG.upPort + ')');
  if (LOGIN_KEY === 'off') log('dang nhap: DA TAT (BRIDGE_LOGIN_KEY=off)');
  else log('dang nhap: ' + CFG.prefix + '/login  |  ma PIN trong ' + LOGIN_KEY_FILE);
});
