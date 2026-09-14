'use strict';
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { upstreamURL, proxyRequest, proxyUpgrade, rejectUpgrade } = require('../http_proxy.cjs');

const COOKIE = 'tunnel_chat_web';
const AUTH_CLIENT = readFileSync(join(__dirname, 'auth.js'));
function page(res, status, message, form = false) {
  const body = '<!doctype html><html lang="vi"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>ChatGPT web · Tunnel Chat</title><style>' +
    'body{font:16px system-ui;background:#10151f;color:#e9edf4;margin:0;padding:8vh 24px}' +
    'main{max-width:460px;margin:auto}h1{font-size:28px}p{line-height:1.6;color:#bcc7d8}' +
    'input,button{box-sizing:border-box;font:inherit;border-radius:8px;padding:12px;width:100%;margin:8px 0}' +
    'input{background:#192334;color:white;border:1px solid #47556b}button{background:#8bbaff;border:0;color:#10151f;cursor:pointer}' +
    'a{color:#a7caff}label{display:block;margin-top:24px}</style><main><h1>ChatGPT web</h1><p id="authStatus">' +
    message + '</p>' + (form ? '<form method="post" action="/chat/_auth/login">' +
    '<label for="password">Mật khẩu dự phòng</label>' +
    '<input id="password" name="password" type="password" autocomplete="current-password" required>' +
    '<button>Mở ChatGPT web</button></form>' : '') +
    '<p><a href="/codex">Mở Codex</a> · <a href="/chat/_auth/session">Phiên truy cập web</a></p>' +
    (form ? '<script defer src="/chat/_auth/client.js"></script>' : '') + '</main></html>';
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);
}
function unavailable(res) {
  page(res, 503, 'Trình duyệt ChatGPT trên máy cá nhân chưa chạy. Bạn có thể tiếp tục dùng Codex qua liên kết bên dưới.');
}
function sameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch { return false; }
}
function digest(value) { return createHash('sha256').update(value).digest(); }
async function readBody(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RangeError('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function createChatBridge({ passwordFile, upstream, sessionSeconds = 28800,
  shortSessionSeconds = 1800, ticketSeconds = 1800, authorizeCodex } = {}) {
  let passwordHash;
  if (passwordFile) {
    const password = readFileSync(passwordFile, 'utf8').trim();
    if (password.length < 24) throw new Error('Chat web password must contain at least 24 characters');
    passwordHash = digest(password);
  }
  const target = upstream ? upstreamURL(upstream) : null;
  const sessions = new Map(), tickets = new Map();
  const failures = [];
  const ttl = Math.max(60, Math.min(86400, Number(sessionSeconds) || 28800)) * 1000;
  const shortTtl = Math.max(60, Math.min(1800, Number(shortSessionSeconds) || 1800)) * 1000;
  const ticketTtl = Math.max(60, Math.min(1800, Number(ticketSeconds) || 1800)) * 1000;
  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expires <= now) {
        for (const socket of session.sockets) socket.destroy();
        sessions.delete(id);
      }
    }
    for (const [id, ticket] of tickets) if (ticket.expires <= now) tickets.delete(id);
    while (failures.length && failures[0].time <= now - 60000) failures.shift();
  }
  function sessionFor(req) {
    prune();
    const raw = (req.headers.cookie || '').split(';').map(x => x.trim())
      .find(x => x.startsWith(COOKIE + '='));
    return raw ? sessions.get(raw.slice(COOKIE.length + 1)) : undefined;
  }
  function cookie(req, value, age) {
    const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '');
    const secure = !local || req.headers['x-forwarded-proto'] === 'https';
    return COOKIE + '=' + value + '; Path=/chat/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(age) +
      (secure ? '; Secure' : '');
  }
  function redirect(res, location, setCookie) {
    const headers = { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (setCookie) headers['set-cookie'] = setCookie;
    res.writeHead(303, headers); res.end();
  }
  function grant(req, res, age, location) {
    prune();
    if (sessions.size >= 128) { page(res, 429, 'Đã đạt giới hạn phiên truy cập.'); return false; }
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { expires: Date.now() + age, sockets: new Set() });
    const value = cookie(req, id, age / 1000);
    if (location) redirect(res, location, value);
    else {
      res.writeHead(204, { 'set-cookie': value, 'cache-control':'no-store', 'referrer-policy':'no-referrer' });
      res.end();
    }
    return true;
  }
  async function codexAuthorized(req) {
    const token = req.headers['x-chat-token'];
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096 || typeof authorizeCodex !== 'function') return false;
    try { return await authorizeCodex(token); } catch { return false; }
  }
  async function handle(req, res, path) {
    if (path === '/chat/_auth/client.js' && req.method === 'GET') {
      res.writeHead(200, { 'content-type':'text/javascript; charset=utf-8', 'cache-control':'no-store',
        'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' });
      res.end(AUTH_CLIENT); return;
    }
    if (path === '/chat/_auth/ticket' && req.method === 'POST') {
      if (req.headers.origin && !sameOrigin(req)) { page(res, 403, 'Yêu cầu tạo liên kết không hợp lệ.'); return; }
      if (!await codexAuthorized(req)) { page(res, 401, 'Quyền Codex không hợp lệ.'); return; }
      prune();
      if (tickets.size >= 128) { page(res, 429, 'Đã đạt giới hạn liên kết tạm thời.'); return; }
      const value = randomBytes(32).toString('base64url'), expiresAt = Date.now() + ticketTtl;
      tickets.set(digest(value).toString('base64url'), { expires: expiresAt });
      res.writeHead(201, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
        'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' });
      res.end(JSON.stringify({ ticket:value, expiresAt })); return;
    }
    if (path === '/chat/_auth/exchange' && req.method === 'POST') {
      if (!sameOrigin(req)) { page(res, 403, 'Yêu cầu mở liên kết không hợp lệ.'); return; }
      let supplied;
      try { supplied = JSON.parse(await readBody(req)).ticket; }
      catch (error) { page(res, error instanceof RangeError ? 413 : 400, 'Liên kết không hợp lệ.'); return; }
      if (typeof supplied !== 'string' || supplied.length > 256) { page(res, 401, 'Liên kết đã hết hạn hoặc đã được dùng.'); return; }
      prune();
      const key = digest(supplied).toString('base64url'), ticket = tickets.get(key);
      if (!ticket || ticket.expires <= Date.now()) { page(res, 401, 'Liên kết đã hết hạn hoặc đã được dùng.'); return; }
      tickets.delete(key);
      grant(req, res, shortTtl); return;
    }
    if (path === '/chat/_auth/codex' && req.method === 'POST') {
      if (!sameOrigin(req)) { page(res, 403, 'Yêu cầu dùng quyền Codex không hợp lệ.'); return; }
      if (!await codexAuthorized(req)) { page(res, 401, 'Phiên Codex không hợp lệ.'); return; }
      grant(req, res, shortTtl); return;
    }
    if (path === '/chat/_auth/login' && req.method === 'POST') {
      if (!passwordHash) { unavailable(res); return; }
      if (!sameOrigin(req)) { page(res, 403, 'Yêu cầu đăng nhập không hợp lệ.'); return; }
      prune();
      if (failures.length >= 10) { page(res, 429, 'Vui lòng thử lại sau một phút.'); return; }
      const attempt = { time: Date.now() }; failures.push(attempt);
      let supplied;
      try { supplied = new URLSearchParams(await readBody(req)).get('password') || ''; }
      catch { page(res, 413, 'Yêu cầu quá dài.'); return; }
      if (!timingSafeEqual(digest(supplied), passwordHash)) {
        page(res, 401, 'Mật khẩu truy cập chưa đúng.', true); return;
      }
      const index = failures.indexOf(attempt);
      if (index !== -1) failures.splice(index, 1);
      grant(req, res, ttl, '/chat/'); return;
    }
    const session = sessionFor(req);
    if (!session) {
      page(res, req.method === 'GET' && path === '/chat/' ? 200 : 401,
        'Đang kiểm tra quyền Codex hoặc liên kết 30 phút. Bạn vẫn có thể dùng mật khẩu dự phòng.', !!passwordHash);
      return;
    }
    if (path === '/chat/_auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) { page(res, 403, 'Yêu cầu đăng xuất không hợp lệ.'); return; }
      for (const socket of session.sockets) socket.destroy();
      for (const [id, value] of sessions) if (value === session) sessions.delete(id);
      redirect(res, '/chat/', cookie(req, '', 0)); return;
    }
    if (path === '/chat/_auth/session' && req.method === 'GET') {
      const minutes = Math.max(1, Math.ceil((session.expires - Date.now()) / 60000));
      page(res, 200, 'Phiên truy cập còn tối đa ' + minutes + ' phút. ' +
        '<a href="/chat/">Quay lại ChatGPT</a></p><form method="post" action="/chat/_auth/logout">' +
        '<button>Đăng xuất khỏi tunnel</button></form><p>Đăng xuất khỏi tunnel không xóa phiên ChatGPT trên máy cá nhân.');
      return;
    }
    if (path.startsWith('/chat/_auth/')) { page(res, 404, 'Không tìm thấy trang.'); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
      page(res, 403, 'Yêu cầu không hợp lệ.'); return;
    }
    if (!target) { unavailable(res); return; }
    proxyRequest(req, res, target, { privateChat: true, unavailable, session });
  }
  function upgrade(req, socket, head) {
    const session = sessionFor(req);
    if (!session || !sameOrigin(req)) { rejectUpgrade(socket, 401); return; }
    if (!target) { rejectUpgrade(socket, 503); return; }
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      rejectUpgrade(socket, 400); return;
    }
    proxyUpgrade(req, socket, head, target, session);
  }
  function close() {
    for (const session of sessions.values()) for (const socket of session.sockets) socket.destroy();
    sessions.clear(); tickets.clear();
  }
  return { handle, upgrade, close };
}
module.exports = { createChatBridge };
