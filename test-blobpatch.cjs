'use strict';
/* Kiem tra shim co thuc su tiem worker patch vao Blob cua DSH khong (Node gia lap window). */
const fs = require('node:fs');
const NativeBlob = globalThis.Blob;
const shimSrc = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const patchSrc = fs.readFileSync('D:/dev/dsh/bridge/worker-patch.js', 'utf8');

globalThis.window = {
  location: { href: 'https://tungks2dsh.ccat.io.vn/?transport=poll&chunk=8192' },
  WebSocket: function () {},
  Blob: NativeBlob,
  __DSH_BRIDGE_WORKER_PATCH__: patchSrc,
};
globalThis.localStorage = { _v: {}, getItem: function (k) { return this._v[k] || null; }, setItem: function (k, v) { this._v[k] = String(v); }, removeItem: function (k) { delete this._v[k]; } };
globalThis.fetch = function () { return Promise.reject(new Error('khong goi mang trong test nay')); };

(0, eval)(shimSrc);
console.log('window.Blob da bi thay:', window.Blob !== NativeBlob);
console.log('localStorage chunk =', globalThis.localStorage.getItem('dsh.bridge.chunk'));

const src = '(function fileUploadWorker(scope = self, createXhr = () => new XMLHttpRequest()) { scope.onmessage = () => {}; })()';
const blob = new window.Blob([src], { type: 'text/javascript' });
blob.text().then(function (txt) {
  console.log('blob type:', blob.type, '| instanceof Blob:', blob instanceof NativeBlob, '| window.Blob:', blob instanceof window.Blob);
  console.log('co worker patch o dau:', txt.indexOf('__PREFIX__') === 0 || txt.indexOf('worker-patch') !== -1 || txt.indexOf('BridgeXHR') !== -1);
  console.log('doan dau blob:'); console.log(txt.split('\n').slice(0, 6).join('\n'));
  console.log('... con placeholder chua thay:', txt.indexOf('__CHUNK_BYTES__') !== -1 || txt.indexOf('__PREFIX__') !== -1 ? 'CON' : 'da thay het');
  console.log('co code goc phia sau:', txt.indexOf('function fileUploadWorker') !== -1);
  const other = new window.Blob(['hello'], { type: 'text/plain' });
  return other.text().then(function (o) { console.log('blob khac khong bi chen:', o === 'hello'); });
}).then(function () { process.exit(0); }, function (e) { console.log('ERR', e); process.exit(1); });
