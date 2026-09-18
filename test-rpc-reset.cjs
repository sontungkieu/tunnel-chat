'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
let resets = 0, okChunks = 0, delivered = 0, maxTry = 0;
function res(o) { return { ok: o.status < 400, status: o.status, statusText: 'x', headers: { get: function () { return 'application/json'; } }, json: function () { return Promise.resolve(o.body || {}); }, text: function () { return Promise.resolve(o.text || '{}'); } }; }
globalThis.fetch = function (url, opts) {
  const u = String(url);
  if (u.indexOf('/blob/init') !== -1) return Promise.resolve(res({ status: 200, body: { bid: 'b' } }));
  if (u.indexOf('/blob/chunk') !== -1) {
    const n = opts.body && opts.body.size ? opts.body.size : 0;
    if (n > maxTry) maxTry = n;
    if (n > 8192) { resets++; return Promise.reject(new TypeError('Failed to fetch')); }  // gia lap proxy reset
    okChunks++; delivered += n;
    return Promise.resolve(res({ status: 200, body: { ok: true } }));
  }
  if (u.indexOf('/blob/finish') !== -1) return Promise.resolve(res({ status: 200, text: '{"type":"server-response"}' }));
  throw new Error('ngoai du kien');
};
globalThis.window = { location: { href: 'https://x/' }, WebSocket: function () {}, Blob: globalThis.Blob, fetch: globalThis.fetch, AbortSignal: AbortSignal, __DSH_BRIDGE_WORKER_PATCH__: '' };
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };
(0, eval)(shimSrc);
(async function () {
  const body = 'z'.repeat(100 * 1024);
  const r = await window.fetch(new URL('/api/session/prompt', 'https://x/'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: body });
  console.log('=== gia lap proxy RESET khi > 8 KB ===');
  console.log('  so lan bi reset  :', resets);
  console.log('  manh lon nhat thu:', maxTry, 'B');
  console.log('  chunk thanh cong :', okChunks, '| bytes:', delivered, delivered === body.length ? '== KHOP' : 'LECH');
  console.log('  response status  :', r.status);
})();
