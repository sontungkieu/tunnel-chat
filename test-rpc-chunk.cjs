'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const calls = [];
let chunkBytesTotal = 0;
globalThis.fetch = function (url, opts) {
  const u = String(url);
  calls.push(u.split('?')[0]);
  if (u.indexOf('/blob/init') !== -1) {
    const b = JSON.parse(opts.body);
    if (b.url.charAt(0) !== '/') throw new Error('url phai tuong doi: ' + b.url);
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ bid: 'b1' }); } });
  }
  if (u.indexOf('/blob/chunk') !== -1) {
    chunkBytesTotal += Number(opts.headers['content-length'] || 0);
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
  }
  if (u.indexOf('/blob/finish') !== -1) {
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', headers: { get: function () { return 'application/json'; } }, text: function () { return Promise.resolve('{"type":"server-response","rpcId":"x"}'); } });
  }
  throw new Error('native fetch bi goi voi ' + u);
};
globalThis.window = { location: { href: 'https://tungks2dsh.ccat.io.vn/' }, WebSocket: function () {}, Blob: globalThis.Blob, fetch: globalThis.fetch, AbortSignal: AbortSignal, __DSH_BRIDGE_WORKER_PATCH__: '' };
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };
(0, eval)(shimSrc);

(async function () {
  const big = 'x'.repeat(200 * 1024);
  // DUNG NHU DSH: new URL(...) chu khong phai string
  const r = await window.fetch(new URL('/api/session/prompt', 'https://tungks2dsh.ccat.io.vn'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: big,
  });
  const text = await r.text();
  console.log('=== dung hinh dang that (URL object) ===');
  console.log('  /blob/init  :', calls.filter(function (c) { return c.indexOf('/blob/init') !== -1; }).length);
  console.log('  /blob/chunk :', calls.filter(function (c) { return c.indexOf('/blob/chunk') !== -1; }).length);
  console.log('  /blob/finish:', calls.filter(function (c) { return c.indexOf('/blob/finish') !== -1; }).length);
  console.log('  bytes qua chunk:', chunkBytesTotal, chunkBytesTotal === big.length ? '== KHOP' : 'LECH');
  console.log('  response:', r.status, text.slice(0, 36));

  // dang string tuong doi
  calls.length = 0;
  const r2 = await window.fetch('/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  console.log('  dang string cung duoc cat:', calls.filter(function (c) { return c.indexOf('/blob/chunk') !== -1; }).length, 'chunk');

  // body nho -> native
  let native = 0;
  globalThis.fetch = function () { native++; return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{}'); } }); };
  window.fetch = globalThis.fetch;
  await window.fetch(new URL('/api/session/prompt', 'https://x/'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'nho' });
  console.log('  body nho -> native fetch:', native === 1);
})();
