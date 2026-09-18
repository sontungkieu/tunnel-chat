'use strict';
const fs = require('node:fs');
const http = require('node:http');
const HOST = 'tungks2dsh.ccat.io.vn';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
const H = { host: HOST, origin: 'https://' + HOST, cookie: COOKIE };
function call(method, path, headers, body) {
  return new Promise(function (resolve, reject) {
    const r = http.request(Object.assign({ host: '127.0.0.1', port: 3090, method: method, path: path, headers: headers }, {}), function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
async function pushBlob(target, size) {
  const payload = Buffer.alloc(size, 0x20);
  const head = Buffer.from('{"type":"client-request","rpcId":"x","method":"m","payload":{}');
  head.copy(payload, 0);
  payload[payload.length - 1] = 0x7d;
  const initB = Buffer.from(JSON.stringify({ url: target, method: 'POST', headers: { 'content-type': 'application/json' }, size: size }));
  const init = JSON.parse((await call('POST', '/__dsh_bridge/blob/init', Object.assign({}, H, { 'content-type': 'application/json', 'content-length': initB.length }), initB)).text);
  if (!init.bid) return { error: 'init that bai', raw: JSON.stringify(init).slice(0, 120) };
  let seq = 0;
  for (let off = 0; off < size; off += 32768) {
    const slice = payload.slice(off, Math.min(off + 32768, size));
    const r = await call('POST', '/__dsh_bridge/blob/chunk?bid=' + init.bid + '&seq=' + seq, Object.assign({}, H, { 'content-type': 'application/octet-stream', 'content-length': slice.length }), slice);
    if (r.status !== 200) return { error: 'chunk ' + seq + ' -> ' + r.status, raw: r.text.slice(0, 120) };
    seq += 1;
  }
  const fin = await call('POST', '/__dsh_bridge/blob/finish?bid=' + init.bid, H);
  return { chunks: seq, status: fin.status, text: fin.text.slice(0, 110).replace(/\s+/g, ' ') };
}
(async function () {
  for (const size of [1024 * 1024, 4 * 1024 * 1024]) {
    const r = await pushBlob('/api/session/prompt', size);
    console.log(String(size).padStart(9) + ' B qua blob ->', JSON.stringify(r));
  }
})();
