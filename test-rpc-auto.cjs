'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');

let calls = [];
let force413 = false;
function res(o) { return { ok: o.status < 400, status: o.status, statusText: 'x', headers: { get: function () { return 'application/json'; } }, json: function () { return Promise.resolve(o.body || {}); }, text: function () { return Promise.resolve(o.text || '{}'); } }; }
globalThis.fetch = function (url, opts) {
  const u = String(url);
  calls.push(u.split('?')[0]);
  if (u.indexOf('/blob/init') !== -1) return Promise.resolve(res({ status: 200, body: { bid: 'b' } }));
  if (u.indexOf('/blob/chunk') !== -1) return Promise.resolve(res({ status: 200, body: {} }));
  if (u.indexOf('/blob/finish') !== -1) return Promise.resolve(res({ status: 200, text: '{"type":"server-response"}' }));
  if (u.indexOf('/api/') !== -1) {
    if (force413) return Promise.resolve(res({ status: 413, text: 'too big' }));
    return Promise.resolve(res({ status: 200, text: '{"ok":true}' }));
  }
  throw new Error('ngoai du kien: ' + u);
};
globalThis.window = { location: { href: 'https://tungks2dsh.ccat.io.vn/' }, WebSocket: function () {}, Blob: globalThis.Blob, fetch: globalThis.fetch, AbortSignal: AbortSignal, __DSH_BRIDGE_WORKER_PATCH__: '', matchMedia: function () { return { matches: false }; } };
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };
(0, eval)(shimSrc);

const post = function (body) { return window.fetch(new URL('/api/session/prompt', 'https://x/'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }); };
const big = 'x'.repeat(300 * 1024);

(async function () {
  console.log('=== A. mang binh thuong (khong 413) -> phai gui THANG 1 lan ===');
  calls = []; force413 = false;
  const a = await post(big);
  console.log('  status:', a.status, '| so request:', calls.length, '| chi tiet:', JSON.stringify(calls));
  console.log('  co blob khong:', calls.some(function (c) { return c.indexOf('/blob/') !== -1; }));

  console.log('=== B. proxy tra 413 -> phai tu chuyen sang cat nho ===');
  calls = []; force413 = true;
  const b = await post(big);
  const chunks = calls.filter(function (c) { return c.indexOf('/blob/chunk') !== -1; }).length;
  console.log('  status cuoi:', b.status, '| /api goi thang:', calls.filter(function (c) { return c.indexOf('/api/') !== -1; }).length, '| blob/init:', calls.filter(function (c) { return c.indexOf('/blob/init') !== -1; }).length, '| chunk:', chunks, '| finish:', calls.filter(function (c) { return c.indexOf('/blob/finish') !== -1; }).length);

  console.log('=== C. sau khi biet co tran -> cac request sau cat luon, khong thu lai ===');
  calls = [];
  const c = await post(big);
  console.log('  status:', c.status, '| /api goi thang:', calls.filter(function (x) { return x.indexOf('/api/') !== -1; }).length, '| chunk:', calls.filter(function (x) { return x.indexOf('/blob/chunk') !== -1; }).length);
})();
