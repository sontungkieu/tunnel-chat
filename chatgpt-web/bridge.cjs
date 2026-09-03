'use strict';
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { upstreamURL, proxyRequest, proxyUpgrade, rejectUpgrade } = require('../http_proxy.cjs');

const COOKIE = 'tunnel_chat_web';
function page(res, status, message, form = false) {
  const body = '<!doctype html><html lang="vi"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>ChatGPT web · Tunnel Chat</title><style>' +
    'body{font:16px system-ui;background:#10151f;color:#e9edf4;margin:0;padding:8vh 24px}' +
    'main{max-width:460px;margin:auto}h1{font-size:28px}p{line-height:1.6;color:#bcc7d8}' +
    'input,button{box-sizing:border-box;font:inherit;border-radius:8px;padding:12px;width:100%;margin:8px 0}' +
    'input{background:#192334;color:white;border:1px solid #47556b}button{background:#8bbaff;border:0;color:#10151f;cursor:pointer}' +
    'a{color:#a7caff}label{display:block;margin-top:24px}</style><main><h1>ChatGPT web</h1><p>' +
    message + '</p>' + (form ? '<form method="post" action="/chat/_auth/login">' +
    '<label for="password">Mật khẩu truy cập ChatGPT web</label>' +
    '<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>' +
    '<button>Mở ChatGPT web</button></form>' : '') +
    '<p><a href="/codex">Mở Codex</a> · <a href="/chat/_auth/session">Phiên truy cập web</a></p></main></html>';
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    // Native form POSTs need their same-origin metadata; no-referrer makes Origin null.
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

function createChatBridge({ passwordFile, upstream, sessionSeconds = 28800 }) {
  let passwordHash;
  if (passwordFile) {
    const password = readFileSync(passwordFile, 'utf8').trim();
    if (password.length < 24) throw new Error('Chat web password must contain at least 24 characters');
    passwordHash = digest(password);
  }
  const target = upstream ? upstreamURL(upstream) : null;
  const sessions = new Map();
  // Global window: do not trust spoofable forwarded-IP headers.
  const failures = [];
  const ttl = Math.max(60, Math.min(86400, Number(sessionSeconds) || 28800)) * 1000;
  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expires <= now) {
        for (const socket of session.sockets) socket.destroy();
        sessions.delete(id);
      }
    }
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
    return COOKIE + '=' + value + '; Path=/chat/; HttpOnly; SameSite=Strict; Max-Age=' + age +
      (secure ? '; Secure' : '');
  }
  function redirect(res, location, setCookie) {
    const headers = { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (setCookie) headers['set-cookie'] = setCookie;
    res.writeHead(303, headers); res.end();
  }
  async function handle(req, res, path) {
    if (!passwordHash) { unavailable(res); return; }
    if (path === '/chat/_auth/login' && req.method === 'POST') {
      if (!sameOrigin(req)) { page(res, 403, 'Yêu cầu đăng nhập không hợp lệ.'); return; }
      prune();
      if (failures.length >= 10) { page(res, 429, 'Vui lòng thử lại sau một phút.'); return; }
      const attempt = { time: Date.now() }; failures.push(attempt);
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { page(res, 413, 'Yêu cầu quá dài.'); return; }
        chunks.push(chunk);
      }
      const supplied = new URLSearchParams(Buffer.concat(chunks).toString()).get('password') || '';
      if (!timingSafeEqual(digest(supplied), passwordHash)) {
        page(res, 401, 'Mật khẩu truy cập chưa đúng.', true); return;
      }
      const index = failures.indexOf(attempt);
      if (index !== -1) failures.splice(index, 1);
      if (sessions.size >= 128) { page(res, 429, 'Đã đạt giới hạn phiên truy cập.'); return; }
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { expires: Date.now() + ttl, sockets: new Set() });
      redirect(res, '/chat/', cookie(req, id, ttl / 1000)); return;
    }
    const session = sessionFor(req);
    if (!session) {
      page(res, req.method === 'GET' && path === '/chat/' ? 200 : 401,
        'Phiên ChatGPT chạy trên máy cá nhân. Nhập mật khẩu truy cập riêng để mở giao diện từ đây.', true);
      return;
    }
    if (path === '/chat/_auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) { page(res, 403, 'Yêu cầu đăng xuất không hợp lệ.'); return; }
      for (const socket of session.sockets) socket.destroy();
      for (const [id, value] of sessions) if (value === session) sessions.delete(id);
      redirect(res, '/chat/', cookie(req, '', 0)); return;
    }
    if (path === '/chat/_auth/session' && req.method === 'GET') {
      page(res, 200, 'Bạn đã mở phiên truy cập ChatGPT web. ' +
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
    sessions.clear();
  }
  return { handle, upgrade, close };
}
module.exports = { createChatBridge };
