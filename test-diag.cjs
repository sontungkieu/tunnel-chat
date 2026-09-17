'use strict';
const fs = require('node:fs');
const http = require('node:http');
const HOST = 'tungks2dsh.ccat.io.vn';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
const BASE = { host: '127.0.0.1', port: 3090 };
const H = { host: HOST, origin: 'https://' + HOST, cookie: COOKIE };
function req(method, path, headers, body) {
  return new Promise(function (resolve, reject) {
    const r = http.request(Object.assign({ method: method, path: path, headers: headers || H }, BASE), function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, buf: Buffer.concat(c) }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function postJson(path, obj) {
  const b = Buffer.from(JSON.stringify(obj || {}));
  return req('POST', path, Object.assign({}, H, { 'content-type': 'application/json', 'content-length': b.length }), b);
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
(async function () {
  const diag = await req('GET', '/__dsh_bridge/diag');
  const html = diag.buf.toString('utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  console.log('diag status', diag.status, '| bytes', html.length);
  try { new Function(m[1]); console.log('inline script: SYNTAX OK,', m[1].split('\n').length, 'dong'); } catch (e) { console.log('inline SYNTAX ERROR:', e.message); }
  console.log('co test polling:', html.indexOf('poll/open') !== -1, '| co KET LUAN:', html.indexOf('KET LUAN') !== -1);
  const big = Buffer.alloc(2 * 1024 * 1024, 120);
  const t = Date.now();
  const echo = await req('POST', '/__dsh_bridge/diag/echo', Object.assign({}, H, { 'content-length': big.length }), big);
  console.log('POST 2 MB ->', echo.status, echo.buf.toString('utf8').slice(0, 80), '|', (Date.now() - t) + 'ms');
  const open = JSON.parse((await postJson('/__dsh_bridge/poll/open', {})).buf.toString('utf8'));
  console.log('poll open ->', JSON.stringify(open).slice(0, 110));
  const msg = JSON.stringify({ type: 'open', streamId: 'diag1', endpoint: '$events', payload: { args: {} } });
  console.log('poll send ->', (await postJson('/__dsh_bridge/poll/send', { sid: open.sid, frames: [msg] })).status);
  let cursor = open.cursor, ready = null, tries = 0;
  while (tries++ < 15 && !ready) {
    const r = JSON.parse((await req('GET', '/__dsh_bridge/poll/recv?sid=' + open.sid + '&cursor=' + cursor)).buf.toString('utf8'));
    cursor = r.cursor;
    for (const f of (r.frames || [])) if (f.indexOf('ready') !== -1) ready = f;
    if (!(r.frames || []).length) await sleep(300);
  }
  console.log('poll recv ready ->', ready ? 'CO: ' + ready.slice(0, 110) : 'KHONG');
  await postJson('/__dsh_bridge/poll/close', { sid: open.sid });
  const st = JSON.parse((await req('GET', '/__dsh_bridge/diag/stats')).buf.toString('utf8'));
  console.log('stats:', JSON.stringify(st.stats));
})();
