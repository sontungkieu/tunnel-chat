'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { createGateway } = require('../gateway.cjs');
const { proxyUpgrade } = require('../http_proxy.cjs');
const PASSWORD = 'test-only-browser-password-1234567890';

async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  server.testClose = () => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
function request(base, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
function upgrade(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { headers: {
      connection: 'Upgrade', upgrade: 'websocket', origin: base,
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers,
    } });
    req.on('upgrade', (res, socket, head) => {
      socket.on('error', () => {});
      resolve({ status: res.statusCode, socket, head });
    });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject); req.end();
  });
}
async function fixture(t, browserEnabled = true) {
  const temp = mkdtempSync(join(tmpdir(), 'tunnel-gateway-test-'));
  const passwordFile = join(temp, 'password'); writeFileSync(passwordFile, PASSWORD, { mode: 0o600 });
  const seen = { codex: [], browser: [], upgrades: [] };
  const codex = http.createServer((req, res) => {
    seen.codex.push(req.headers);
    const okay = req.url.startsWith('/d/') ? req.headers['x-chat-token'] === 'codex-test-token' : true;
    res.writeHead(okay ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, okay }));
  });
  const browser = http.createServer((req, res) => {
    seen.browser.push(req.headers);
    if (req.url === '/chat/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'bad=upstream; Path=/' });
      res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  browser.on('upgrade', (req, socket, head) => {
    seen.upgrades.push(req.headers);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] +
      '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\nhello');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
    socket.on('error', () => {});
  });
  const codexURL = await listen(codex);
  const browserURL = await listen(browser);
  const gateway = createGateway({ codexUpstream: codexURL,
    chat: { passwordFile, upstream: browserEnabled ? browserURL : '', sessionSeconds: 60 } });
  const base = await listen(gateway);
  t.after(async () => {
    await gateway.testClose(); await codex.testClose(); await browser.testClose();
    rmSync(temp, { recursive: true, force: true });
  });
  const login = async (password = PASSWORD, extra = {}) => request(base, '/chat/_auth/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body: new URLSearchParams({ password }).toString(),
  });
  const cookie = async () => (await login()).headers['set-cookie'][0].split(';')[0];
  return { base, seen, cookie, login, browserURL };
}

test('root routes to ChatGPT, separate auth gates and credential stripping in both directions', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/chat']) {
    const res = await request(f.base, path);
    assert.equal(res.status, 302); assert.equal(res.headers.location, '/chat/#');
  }
  const noAuth = await request(f.base, '/chat/', { headers: { 'x-chat-token': 'codex-test-token' } });
  assert.match(noAuth.body, /Mật khẩu/); assert.equal(f.seen.browser.length, 0);
  assert.equal((await request(f.base, '/chat/ws')).status, 401);
  const login = await f.login();
  assert.equal(login.status, 303);
  assert.match(login.headers['set-cookie'][0], /Path=\/chat\/; HttpOnly; SameSite=Strict/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const chat = await request(f.base, '/chat/assets/main.js?x=1', {
    headers: { cookie, authorization: 'should-not-forward', 'x-chat-token': 'codex-test-token' },
  });
  assert.equal(chat.status, 200);
  assert.equal(JSON.parse(chat.body).path, '/chat/assets/main.js?x=1');
  assert.equal(chat.headers['set-cookie'], undefined);
  for (const key of ['cookie', 'authorization', 'x-chat-token']) assert.equal(f.seen.browser[0][key], undefined);
  const codex = await request(f.base, '/d/state', { headers: { cookie } });
  assert.equal(codex.status, 401); assert.equal(f.seen.codex[0].cookie, undefined);
  assert.equal((await request(f.base, '/d/state', {
    headers: { cookie, 'x-chat-token': 'codex-test-token' },
  })).status, 200);
});

test('login rejects cross-origin, wrong password, oversized input and rate limits failures', async t => {
  const f = await fixture(t);
  assert.equal((await f.login(PASSWORD, { origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await f.login('x'.repeat(5000))).status, 413);
  for (let i = 0; i < 9; i++) assert.equal((await f.login('wrong')).status, 401);
  assert.equal((await f.login()).status, 429);
  assert.equal(f.seen.browser.length, 0);
});

test('public sessions use Secure cookie and expire without unlocking Codex', async t => {
  const f = await fixture(t);
  const publicLogin = await f.login(PASSWORD, { host: 'company.example', origin: 'https://company.example' });
  assert.match(publicLogin.headers['set-cookie'][0], /; Secure/);
  const cookie = await f.cookie();
  const now = Date.now;
  Date.now = () => now() + 61000;
  try {
    assert.equal((await request(f.base, '/chat/asset', { headers: { cookie } })).status, 401);
  } finally { Date.now = now; }
  assert.equal((await request(f.base, '/codex')).status, 200);
});

test('HTTP POST reaches only browser upstream and browser outage leaves Codex working', async t => {
  const f = await fixture(t, false);
  const cookie = await f.cookie();
  const unavailable = await request(f.base, '/chat/', { headers: { cookie } });
  assert.equal(unavailable.status, 503); assert.match(unavailable.body, /chưa chạy/);
  assert.equal((await request(f.base, '/codex')).status, 200);
  const active = await fixture(t);
  const activeCookie = await active.cookie();
  const result = await request(active.base, '/chat/input', { method: 'POST',
    headers: { cookie: activeCookie, origin: active.base }, body: 'Vietnamese: Xin chào' });
  assert.equal(JSON.parse(result.body).body, 'Vietnamese: Xin chào');
  assert.equal(active.seen.codex.length, 0);
});

test('WebSockets require browser auth and origin; duplex traffic works and logout closes sockets', async t => {
  const f = await fixture(t);
  assert.equal((await upgrade(f.base, '/chat/ws', { 'x-chat-token': 'codex-test-token' })).status, 401);
  const cookie = await f.cookie();
  assert.equal((await upgrade(f.base, '/chat/ws', { cookie, origin: 'https://unrelated.example' })).status, 401);
  assert.equal((await upgrade(f.base, '/d/state', { cookie })).status, 404);
  const ws = await upgrade(f.base, '/chat/ws', { cookie, 'x-chat-token': 'secret-codex' });
  assert.equal(ws.status, 101);
  if (!ws.head.length) ws.head = (await once(ws.socket, 'data'))[0];
  assert.equal(ws.head.toString(), 'hello');
  const reply = once(ws.socket, 'data');
  ws.socket.write(Buffer.from([0, 255, 127, 42]));
  assert.deepEqual((await reply)[0], Buffer.from([0, 255, 127, 42]));
  assert.equal(f.seen.upgrades[0].cookie, undefined);
  assert.equal(f.seen.upgrades[0]['x-chat-token'], undefined);
  const ended = once(ws.socket, 'close');
  await request(f.base, '/chat/_auth/logout', { method: 'POST', headers: { cookie, origin: f.base } });
  await ended;
  assert.equal((await upgrade(f.base, '/chat/ws', { cookie })).status, 401);
});

test('open WebSocket is closed when its access session expires', async t => {
  const f = await fixture(t);
  const sessions = { expires: Date.now() + 250, sockets: new Set() };
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, new URL(f.browserURL), sessions));
  const url = await listen(front);
  t.after(() => front.testClose());
  const ws = await upgrade(url, '/chat/ws');
  assert.equal(ws.status, 101);
  ws.socket.resume();
  await once(ws.socket, 'close');
  assert.equal(sessions.sockets.size, 0);
});

test('logout also closes authenticated HTTP image streams', async t => {
  const f = await fixture(t); const cookie = await f.cookie();
  const stream = await new Promise((resolve,reject) => {
    http.get(f.base + '/chat/live', {headers:{cookie}}, resolve).on('error', reject);
  });
  stream.on('error', () => {});
  await once(stream, 'data');
  const closed = new Promise(resolve => stream.once('close', resolve));
  await request(f.base, '/chat/_auth/logout', { method:'POST', headers:{cookie,origin:f.base} });
  await closed;
  assert.equal((await request(f.base, '/chat/live', {headers:{cookie}})).status, 401);
});
