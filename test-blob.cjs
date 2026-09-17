'use strict';
const fs = require('node:fs');
const http = require('node:http');

const HOST = 'tungks2dsh.ccat.io.vn';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
const BASE = { host: '127.0.0.1', port: 3090 };
const H = { host: HOST, origin: 'https://' + HOST, cookie: COOKIE };

function call(method, path, headers, body) {
  return new Promise(function (resolve, reject) {
    const r = http.request(Object.assign({ method: method, path: path, headers: headers }, BASE), function (res) {
      const c = [];
      res.on('data', function (d) { c.push(d); });
      res.on('end', function () { resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function json(method, path, obj) {
  const b = Buffer.from(JSON.stringify(obj || {}));
  return call(method, path, Object.assign({}, H, { 'content-type': 'application/json', 'content-length': b.length }), b);
}

async function uploadChunked(target, contentType, payload, chunkSize) {
  const init = await json('POST', '/__dsh_bridge/blob/init', {
    url: target, method: 'POST',
    headers: { 'content-type': contentType },
    size: payload.length,
  });
  if (init.status !== 200) return { stage: 'init', status: init.status, text: init.text };
  const bid = JSON.parse(init.text).bid;
  let seq = 0;
  for (let off = 0; off < payload.length; off += chunkSize) {
    const slice = payload.slice(off, Math.min(off + chunkSize, payload.length));
    const r = await call('POST', '/__dsh_bridge/blob/chunk?bid=' + encodeURIComponent(bid) + '&seq=' + seq,
      Object.assign({}, H, { 'content-type': 'application/octet-stream', 'content-length': slice.length }), slice);
    if (r.status !== 200) return { stage: 'chunk ' + seq, status: r.status, text: r.text };
    seq += 1;
  }
  const fin = await call('POST', '/__dsh_bridge/blob/finish?bid=' + encodeURIComponent(bid), H);
  return { stage: 'finish', chunks: seq, status: fin.status, text: fin.text };
}

async function main() {
  console.log('--- A: giao thuc blob, dich la RPC JSON cua DSH ---');
  const a = await uploadChunked('/api/agentPresets/list', 'application/json', Buffer.from('{}'), 1024);
  console.log('  ', JSON.stringify(a).slice(0, 300));

  console.log('--- B: route upload that, sessionId gia ---');
  const b = await uploadChunked('/api/session/uploadFileBinary?sessionId=00000000-0000-0000-0000-000000000000&name=x.txt',
    'application/octet-stream', Buffer.from('hello bridge'), 4);
  console.log('  ', JSON.stringify(b).slice(0, 300));

  console.log('--- C: route upload that, sessionId that, payload 200 KB / chunk 8 KB ---');
  const dir = 'C:/Users/Tung/.dsh/sessions/--D-dev-dsh--';
  const subs = fs.readdirSync(dir).map(function (n) {
    var inner = fs.readdirSync(dir + '/' + n).map(function (f) { return fs.statSync(dir + '/' + n + '/' + f).mtimeMs; });
    return { n: n, t: Math.max.apply(null, inner.concat([0])) };
  }).sort(function (x, y) { return y.t - x.t; });
  const sid = subs[0].n.replace('session-', '');
  console.log('   session id:', sid, '(' + subs.length + ' session)');
  const payload = Buffer.alloc(200000);
  for (let i = 0; i < payload.length; i++) payload[i] = 65 + (i % 26);
  const c = await uploadChunked('/api/session/uploadFileBinary?sessionId=' + encodeURIComponent(sid) + '&name=bridge-chunk-test.txt',
    'application/octet-stream', payload, 8192);
  console.log('  ', JSON.stringify(c).slice(0, 400));

  const st = await call('GET', '/__dsh_bridge/diag/stats', H);
  console.log('--- stats ---');
  console.log(st.text.slice(0, 400));
}
main().then(function () { process.exit(0); }, function (e) { console.log('ERR', e); process.exit(1); });
