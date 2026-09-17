'use strict';
const fs = require('node:fs');
const http = require('node:http');
const WebSocket = require('./node_modules/ws');

const HOST = 'tungks2dsh.ccat.io.vn';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
const BASE = { host: '127.0.0.1', port: 3090 };
const H = { host: HOST, origin: 'https://' + HOST, cookie: COOKIE };

function req(method, path, body) {
  return new Promise(function (resolve, reject) {
    const r = http.request(Object.assign({ method: method, path: path, headers: Object.assign({}, H) }, BASE), function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function postJson(path, obj) {
  return new Promise(function (resolve, reject) {
    const body = Buffer.from(JSON.stringify(obj || {}));
    const headers = Object.assign({}, H, { 'content-type': 'application/json', 'content-length': body.length });
    const r = http.request(Object.assign({ method: 'POST', path: path, headers: headers }, BASE), function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function main() {
  console.log('--- T1: GET / qua bridge (co cookie) ---');
  const page = await req('GET', '/');
  console.log('status', page.status, '| bytes', page.body.length, '| shim injected:', page.body.toString('utf8').indexOf('__dsh_bridge/ws-shim.js') !== -1);

  console.log('--- T2: WebSocket native qua bridge ---');
  const nativeResult = await new Promise(function (resolve) {
    const ws = new WebSocket('ws://127.0.0.1:3090/api/remote.mux', { headers: H, perMessageDeflate: false });
    const frames = [];
    const t = setTimeout(function () { try { ws.close(); } catch (e) {} resolve({ opened: true, frames: frames }); }, 6000);
    ws.on('open', function () {
      console.log('  WS native: OPEN (101 passed through bridge)');
      ws.send(JSON.stringify({ type: 'open', streamId: 't1', endpoint: '$events', payload: { args: {} } }));
    });
    ws.on('message', function (d) { frames.push(d.toString('utf8').slice(0, 200)); });
    ws.on('unexpected-response', function (r) { clearTimeout(t); resolve({ opened: false, status: r.statusCode }); });
    ws.on('error', function (e) { clearTimeout(t); resolve({ opened: false, error: e.message }); });
    ws.on('close', function (c) { clearTimeout(t); resolve({ opened: true, closed: c, frames: frames }); });
  });
  console.log('  ket qua:', JSON.stringify(nativeResult).slice(0, 700));

  console.log('--- T3: transport polling qua bridge ---');
  const open = await postJson('/__dsh_bridge/poll/open', {});
  console.log('  open:', open.status, open.body.slice(0, 200));
  const j = JSON.parse(open.body);
  if (!j.sid) { console.log('  KHONG CO SID -> dung'); return; }
  const sent = await postJson('/__dsh_bridge/poll/send', { sid: j.sid, frames: [JSON.stringify({ type: 'open', streamId: 'p1', endpoint: '$events', payload: { args: {} } })] });
  console.log('  send:', sent.status, sent.body.slice(0, 120));
  let cursor = j.cursor || 0;
  const got = [];
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && got.length < 3) {
    const r = await req('GET', '/__dsh_bridge/poll/recv?sid=' + j.sid + '&cursor=' + cursor);
    const rj = JSON.parse(r.body.toString('utf8'));
    cursor = rj.cursor;
    if (rj.reset) { console.log('  RESET'); break; }
    for (const f of (rj.frames || [])) got.push(f.slice(0, 200));
    if (!(rj.frames || []).length) await sleep(400);
  }
  console.log('  nhan duoc', got.length, 'frame:');
  for (const g of got) console.log('   ', g);
  await postJson('/__dsh_bridge/poll/close', { sid: j.sid });

  const stats = await req('GET', '/__dsh_bridge/diag/stats');
  console.log('--- stats ---');
  console.log(stats.body.toString('utf8').slice(0, 600));
}
main().then(function () { process.exit(0); }, function (e) { console.log('TEST ERROR', e); process.exit(1); });
