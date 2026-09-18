'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
const PIN = fs.readFileSync('D:/dev/dsh/bridge/.login-key', 'utf8').trim();
const OLD = process.env.DSH_BRIDGE_OLD_PIN || '';
function local(method, path) {
  return new Promise(function (resolve, reject) {
    const r = http.request({ host: '127.0.0.1', port: 3090, method: method, path: path }, function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }); });
    });
    r.on('error', reject); r.end();
  });
}
function pub(method, path, headers) {
  return new Promise(function (resolve) {
    const req = https.request({ host: HOST, servername: HOST, port: 443, path: path, method: method, headers: Object.assign({ host: HOST }, headers || {}),
      lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }, function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }); });
    });
    req.on('error', function (e) { resolve({ error: e.message }); });
    req.end();
  });
}
(async function () {
  console.log('=== LO HONG /ticket da dong chua (goi tu ngoai) ===');
  const a = await pub('GET', '/__dsh_bridge/ticket?host=' + HOST);
  console.log('/ticket KHONG key       ->', a.status, '(phai 403)');
  const b = await pub('GET', '/__dsh_bridge/ticket?k=SAIBET&host=' + HOST);
  console.log('/ticket key sai         ->', b.status, '(phai 403)');
  const c = await pub('GET', '/__dsh_bridge/ticket?k=' + PIN + '&host=' + HOST);
  const cj = JSON.parse(c.body);
  console.log('/ticket key dung        ->', c.status, '| ttl', cj.ttlSeconds + 's');
  console.log('=== ticket dung mot lan ===');
  const t1 = await pub('GET', '/__dsh_bridge/login?t=' + cj.ticket);
  const tc = ((t1.headers['set-cookie'] || [])[0] || '').split(';')[0];
  console.log('lan 1                   ->', t1.status, '(phai 303)');
  const home = await pub('GET', '/', { cookie: tc });
  console.log('GET / voi cookie do     ->', home.status, '| bytes', home.body.length);
  const t2 = await pub('GET', '/__dsh_bridge/login?t=' + cj.ticket);
  console.log('lan 2 (dung lai)        ->', t2.status, '(phai 403)');
  console.log('=== link co key ===');
  const k1 = await pub('GET', '/__dsh_bridge/login?k=' + PIN);
  console.log('login?k=PIN moi         ->', k1.status, '| Secure:', (((k1.headers['set-cookie'] || [])[0] || '')).indexOf('Secure') !== -1);
  if (OLD) {
    const k2 = await pub('GET', '/__dsh_bridge/login?k=' + OLD);
    console.log('login?k=PIN cu          ->', k2.status, '(phai 403 - da xoay)');
  } else {
    console.log('login?k=PIN cu          -> bo qua (dat env DSH_BRIDGE_OLD_PIN de kiem tra)');
  }
  console.log('=== form + local ===');
  const g = await local('GET', '/__dsh_bridge/login');
  console.log('form (local)            ->', g.status, '| co goi y ticket:', g.body.indexOf('/ticket') !== -1);
  const l1 = await local('GET', '/__dsh_bridge/login?k=' + PIN);
  console.log('login?k=PIN (local)     ->', l1.status);
  const no = await pub('GET', '/');
  console.log('GET / khong cookie      ->', no.status);
})();
