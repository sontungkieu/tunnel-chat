'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');

let opens = 0, sends = 0, recvs = 0, closes = 0;
function jsonRes(o) { return { ok: true, status: 200, json: function () { return Promise.resolve(o); } }; }
globalThis.fetch = function (url, opts) {
  const u = String(url);
  if (u.indexOf('/poll/open') !== -1) { opens++; return Promise.resolve(jsonRes({ sid: 'sess' + opens, cursor: 0, pollMs: 600 })); }
  if (u.indexOf('/poll/send') !== -1) { sends++; return Promise.resolve(jsonRes({ ok: true })); }
  if (u.indexOf('/poll/recv') !== -1) { recvs++; return Promise.resolve(jsonRes({ cursor: 0, frames: [], more: false, closed: false })); }
  if (u.indexOf('/poll/close') !== -1) { closes++; return Promise.resolve(jsonRes({ ok: true })); }
  return Promise.reject(new Error('unexpected ' + u));
};

function FakeNative(url) {
  const self = this;
  this._l = {};
  this.addEventListener = function (t, fn) { (self._l[t] = self._l[t] || []).push(fn); };
  this.removeEventListener = function (t, fn) { if (self._l[t]) self._l[t] = self._l[t].filter(function (f) { return f !== fn; }); };
  this.close = function () { setTimeout(function () { (self._l.close || []).slice().forEach(function (fn) { fn({ code: 1006 }); }); }, 0); };
  setTimeout(function () {
    (self._l.error || []).slice().forEach(function (fn) { fn({}); });
    setTimeout(function () { (self._l.close || []).slice().forEach(function (fn) { fn({ code: 1006 }); }); }, 5);
  }, 5);
}
globalThis.window = {
  location: { href: 'https://tungks2dsh.ccat.io.vn/?transport=auto' },
  WebSocket: FakeNative,
  Blob: globalThis.Blob,
  AbortSignal: AbortSignal,
  __DSH_BRIDGE_WORKER_PATCH__: '',
};
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };

(0, eval)(shimSrc);
const S = window.WebSocket;
const events = [];
const s1 = new S('https://tungks2dsh.ccat.io.vn/api/remote.mux');
s1.onopen = function () { events.push('open'); };
s1.onclose = function (ev) { events.push('close:' + (ev && ev.code)); };
s1.onerror = function () { events.push('error'); };

setTimeout(function () {
  console.log('--- socket 1 (native loi ngay, gia lap proxy chan) ---');
  console.log('  /poll/open   =', opens, '(phai la 1)');
  console.log('  events       =', JSON.stringify(events), '(khong duoc co close sau open)');
  console.log('  transport    =', window.__DSH_BRIDGE__.effective(s1));
  console.log('  mode in mem  =', window.__DSH_BRIDGE__.mode());
  console.log('  localStorage =', localStorage.getItem('dsh.bridge.transport'));

  const before = opens;
  const ev2 = [];
  const s2 = new S('https://tungks2dsh.ccat.io.vn/api/remote.mux');
  s2.onopen = function () { ev2.push('open'); };
  s2.onclose = function (ev) { ev2.push('close:' + (ev && ev.code)); };
  setTimeout(function () {
    console.log('--- socket 2 (sau fallback) ---');
    console.log('  /poll/open tang them =', opens - before, '(phai la 1)');
    console.log('  events =', JSON.stringify(ev2), '| transport =', window.__DSH_BRIDGE__.effective(s2));
    console.log('  recv calls =', recvs, '| close calls =', closes);
    process.exit(0);
  }, 500);
}, 700);
