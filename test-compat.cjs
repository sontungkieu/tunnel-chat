'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const patchSrc = fs.readFileSync('D:/dev/dsh/bridge/worker-patch.js', 'utf8');

function del(obj, key) { try { delete obj[key]; } catch (e) {} return typeof obj[key]; }
console.log('truoc khi gia lap:');
console.log('  Iterator:', del(globalThis, 'Iterator'));
console.log('  Promise.withResolvers:', del(Promise, 'withResolvers'));
console.log('  Promise.try:', del(Promise, 'try'));
console.log('  AbortSignal.any:', del(AbortSignal, 'any'));
console.log('  URL.parse:', del(URL, 'parse'));
console.log('  Array.prototype.findLast:', del(Array.prototype, 'findLast'));
console.log('  Array.prototype.at:', del(Array.prototype, 'at'));
console.log('  Object.hasOwn:', del(Object, 'hasOwn'));
console.log('  String.prototype.replaceAll:', del(String.prototype, 'replaceAll'));
console.log('  structuredClone:', del(globalThis, 'structuredClone'));

const NativeBlob = globalThis.Blob;
globalThis.window = {
  location: { href: 'https://tungks2dsh.ccat.io.vn/?transport=poll' },
  WebSocket: function () {},
  Blob: NativeBlob,
  AbortSignal: AbortSignal,
  __DSH_BRIDGE_WORKER_PATCH__: patchSrc,
};
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };
globalThis.fetch = function () { return Promise.reject(new Error('test: khong goi mang')); };

(0, eval)(shimSrc);

console.log('\nsau shim:');
console.log('  Iterator:', typeof globalThis.Iterator);
console.log('  Promise.withResolvers:', typeof Promise.withResolvers);
console.log('  Promise.try:', typeof Promise.try);
console.log('  AbortSignal.any:', typeof AbortSignal.any);
console.log('  URL.parse:', typeof URL.parse);
console.log('  Array.prototype.findLast:', typeof Array.prototype.findLast);
console.log('  Array.prototype.at:', typeof Array.prototype.at);
console.log('  Object.hasOwn:', typeof Object.hasOwn);
console.log('  String.prototype.replaceAll:', typeof String.prototype.replaceAll);
console.log('  structuredClone:', typeof structuredClone);

(async function () {
  const d = Promise.withResolvers();
  d.resolve(42);
  console.log('\nwithResolvers hoat dong:', await d.promise);
  console.log('Promise.try:', await Promise.try(function () { return 'ok'; }));
  const a = new AbortController();
  const b = new AbortController();
  const anySignal = AbortSignal.any([a.signal, b.signal]);
  a.abort('ly do A');
  console.log('AbortSignal.any aborted:', anySignal.aborted, '| reason:', anySignal.reason);
  console.log('URL.parse hop le:', URL.parse('http://x/y') !== null, '| khong hop le:', URL.parse('http://[bad') === null);
  console.log('findLast:', [1, 2, 3].findLast(function (x) { return x < 3; }), '| at(-1):', [1, 2, 3].at(-1));
  console.log('hasOwn:', Object.hasOwn({ a: 1 }, 'a'), '| replaceAll:', 'a-b-c'.replaceAll('-', '+'));
  console.log('structuredClone:', JSON.stringify(structuredClone({ x: [1, 2] })));

  const pdfSrc = 'var x=1; if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join=function(){};';
  const blob = new window.Blob([pdfSrc], { type: 'text/javascript' });
  const txt = await blob.text();
  console.log('\nBlob PDF co compat polyfill:', txt.indexOf('function platformPolyfills') !== -1 && txt.indexOf('function iteratorPolyfill') !== -1);
  const other = new window.Blob(['hello'], { type: 'text/plain' });
  console.log('Blob khac nguyen ven:', (await other.text()) === 'hello');
  process.exit(0);
})().catch(function (e) { console.log('ERR', e); process.exit(1); });
