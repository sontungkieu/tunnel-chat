'use strict';
const fs = require('node:fs');
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const patchSrc = fs.readFileSync('D:/dev/dsh/bridge/worker-patch.js', 'utf8');

// Thu xoa Iterator toan cuc de gia lap browser cu
const had = typeof globalThis.Iterator !== 'undefined';
try { delete globalThis.Iterator; } catch (e) { console.log('delete loi:', e.message); }
const gone = typeof globalThis.Iterator === 'undefined';
console.log('Node ban dau co Iterator:', had, '| xoa duoc:', gone);
if (!gone) { console.log('KHONG gia lap duoc browser cu trong Node -> bo qua phan nay'); process.exit(0); }

const NativeBlob = globalThis.Blob;
globalThis.window = {
  location: { href: 'https://tungks2dsh.ccat.io.vn/?transport=poll' },
  WebSocket: function () {},
  Blob: NativeBlob,
  __DSH_BRIDGE_WORKER_PATCH__: patchSrc,
};
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };
globalThis.fetch = function () { return Promise.reject(new Error('test: khong goi mang')); };

(0, eval)(shimSrc);

console.log('Sau shim, typeof Iterator =', typeof globalThis.Iterator);
const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
console.log('Iterator.prototype === %IteratorPrototype%:', globalThis.Iterator.prototype === proto);

// chay dung doan code PDF.js
if (typeof Iterator.prototype.join !== 'function') Iterator.prototype.join = function (separator) { return [...this].join(separator); };
console.log('join:', [1, 2, 3].values().join('-'));
console.log('map/toArray:', JSON.stringify([1, 2, 3].values().map(function (x) { return x * 2; }).toArray()));
console.log('filter/take:', JSON.stringify([1, 2, 3, 4, 5].values().filter(function (x) { return x % 2 === 1; }).take(2).toArray()));
console.log('reduce:', [1, 2, 3].values().reduce(function (a, b) { return a + b; }, 0));

// Blob worker PDF co duoc tiem polyfill khong
const pdfSrc = 'var x=1; if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join=function(){};';
const b = new window.Blob([pdfSrc], { type: 'text/javascript' });
b.text().then(function (txt) {
  console.log('Blob PDF co polyfill:', txt.indexOf('Iterator') !== -1 && txt.indexOf('function iteratorPolyfill') !== -1);
  const other = new window.Blob(['hello'], { type: 'text/plain' });
  return other.text().then(function (o) { console.log('Blob khac nguyen ven:', o === 'hello'); });
}).then(function () { process.exit(0); }, function (e) { console.log('ERR', e); process.exit(1); });
