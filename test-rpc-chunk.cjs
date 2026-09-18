'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');

const calls = [];
let initSize = 0, chunkBytesTotal = 0;
globalThis.fetch = function (url, opts) {
  const u = String(url);
  calls.push(u.split('?')[0]);
  if (u.indexOf('/blob/init') !== -1) {
    const body = JSON.parse(opts.body);
    initSize = body.size;
    if (body.url.charAt(0) !== '/') throw new Error('bridge se tu choi url tuyet doi: ' + body.url);
    if (!body.headers['content-type']) throw new Error('thieu content-type');
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ bid: 'b1' }); } });
  }
  if (u.indexOf('/blob/chunk') !== -1) {
    chunkBytesTotal += Number(opts.headers['content-length'] || (opts.body && opts.body.size) || 0);
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
  }
  if (u.indexOf('/blob/finish') !== -1) {
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: function () { return 'application/json; charset=utf-8'; } },
      text: function () { return Promise.resolve('{"type":"server-response","rpcId":"x"}'); }
    });
  }
  throw new Error('fetch khong mong doi: ' + u);
};
globalThis.window = {
  location: { href: 'https://tungks2dsh.ccat.io.vn/' },
  WebSocket: function () {},
  Blob: globalThis.Blob,
  fetch: globalThis.fetch,
  AbortSignal: AbortSignal,
  __DSH_BRIDGE_WORKER_PATCH__: '',
};
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };

(0, eval)(shimSrc);

(async function () {
  const big = 'x'.repeat(300 * 1024);
  const r = await window.fetch('/api/session/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: big,
  });
  const text = await r.text();
  const chunks = calls.filter(function (c) { return c.indexOf('/blob/chunk') !== -1; }).length;
  console.log('--- RPC lon qua shim ---');
  console.log('  blob/init   :', calls.filter(function (c) { return c.indexOf('/blob/init') !== -1; }).length);
  console.log('  blob/chunk  :', chunks);
  console.log('  blob/finish :', calls.filter(function (c) { return c.indexOf('/blob/finish') !== -1; }).length);
  console.log('  goi thang /api/session/prompt:', calls.some(function (c) { return c.indexOf('/api/session') !== -1; }));
  console.log('  size gui    :', initSize, '== body +' + (initSize === 300 * 1024 ? ' KHOP' : ' LECH'));
  console.log('  bytes qua chunk:', chunkBytesTotal);
  console.log('  response status:', r.status, '| body:', text.slice(0, 40));

  // body nho -> phai di thang native fetch
  const small = 'y'.repeat(100);
  let direct = false;
  globalThis.fetch = function (url) { if (String(url).indexOf('/api/session/prompt') !== -1) direct = true; return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{}'); } }); };
  window.fetch = globalThis.fetch;
  await window.fetch('/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: small });
  console.log('  body nho di thang   :', direct);
})();
