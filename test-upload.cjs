'use strict';
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const HOST = 'tungks2dsh.ccat.io.vn';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
const BASE = { host: '127.0.0.1', port: 3090 };
const H = { host: HOST, origin: 'https://' + HOST, cookie: COOKIE };

function call(method, path, headers, body) {
  return new Promise(function (resolve, reject) {
    const r = http.request(Object.assign({ method: method, path: path, headers: headers }, BASE), function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  const dir = 'C:/Users/Tung/.dsh/sessions/--D-dev-dsh--';
  const subs = fs.readdirSync(dir).map(function (n) {
    var inner = fs.readdirSync(dir + '/' + n).map(function (f) { return fs.statSync(dir + '/' + n + '/' + f).mtimeMs; });
    return { n: n, t: Math.max.apply(null, inner.concat([0])) };
  }).sort(function (x, y) { return y.t - x.t; });
  const sid = subs[0].n;

  const payload = Buffer.alloc(200000);
  for (let i = 0; i < payload.length; i++) payload[i] = 32 + ((i * 7) % 90);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');

  const target = '/api/session/uploadFileBinary?sessionId=' + encodeURIComponent(sid) + '&name=bridge-chunked.txt';
  const initB = Buffer.from(JSON.stringify({ url: target, method: 'POST', headers: { 'content-type': 'application/octet-stream' }, size: payload.length }));
  const init = await call('POST', '/__dsh_bridge/blob/init', Object.assign({}, H, { 'content-type': 'application/json', 'content-length': initB.length }), initB);
  const bid = JSON.parse(init.text).bid;
  console.log('init:', init.status, 'bid', bid.slice(0, 8), '| payload', payload.length, 'B | sha256', sha.slice(0, 16));

  const CH = 8192;
  let seq = 0;
  for (let off = 0; off < payload.length; off += CH) {
    const slice = payload.slice(off, Math.min(off + CH, payload.length));
    const r = await call('POST', '/__dsh_bridge/blob/chunk?bid=' + bid + '&seq=' + seq, Object.assign({}, H, { 'content-type': 'application/octet-stream', 'content-length': slice.length }), slice);
    if (r.status !== 200) { console.log('chunk', seq, 'FAIL', r.status, r.text.slice(0, 120)); process.exit(1); }
    seq += 1;
  }
  console.log('da gui', seq, 'chunk x', CH, 'B');
  const fin = await call('POST', '/__dsh_bridge/blob/finish?bid=' + bid, H);
  console.log('finish:', fin.status);
  console.log('DSH tra ve:', fin.text.slice(0, 320));
  const j = JSON.parse(fin.text);
  console.log(j.ok ? '==> UPLOAD THANH CONG qua duong chunked' : '==> that bai');
  const st = JSON.parse((await call('GET', '/__dsh_bridge/diag/stats', H)).text);
  console.log('stats blob:', JSON.stringify(st.stats));
}
main().then(function () { process.exit(0); }, function (e) { console.log('ERR', e); process.exit(1); });
