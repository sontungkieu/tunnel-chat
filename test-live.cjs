'use strict';
const fs = require('node:fs');
const https = require('node:https');
async function doh(name) {
  const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=A', { headers: { accept: 'application/dns-json' } });
  const j = await r.json();
  return (j.Answer || []).map(function (a) { return a.data; });
}
function get(host, ip, path, cookie) {
  return new Promise(function (resolve) {
    const headers = { host: host };
    if (cookie) headers.cookie = cookie;
    const req = https.request({ host: host, servername: host, port: 443, path: path, method: 'GET', headers: headers,
      lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4); } }, function (res) {
      const c = []; res.on('data', function (d) { c.push(d); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }); });
    });
    req.on('error', function (e) { resolve({ error: e.message }); });
    req.setTimeout(25000, function () { req.destroy(new Error('timeout')); });
    req.end();
  });
}
(async function () {
  const host = 'tungks2dsh.ccat.io.vn';
  const ips = await doh(host);
  console.log('DNS A:', JSON.stringify(ips));
  const ip = ips.find(function (x) { return /^[0-9.]+$/.test(x); });
  let cookie = '';
  try { cookie = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1]; } catch (e) {}
  const home = await get(host, ip, '/', cookie);
  const body = home.body ? home.body.toString('utf8') : '';
  console.log('GET / ->', home.status, home.error || '', '| bytes', body.length);
  console.log('  CO SHIM BRIDGE:', body.indexOf('__dsh_bridge/ws-shim.js') !== -1);
  console.log('  server header:', home.headers ? (home.headers.server || '-') : '-');
  const stats = await get(host, ip, '/__dsh_bridge/diag/stats', cookie);
  console.log('GET /__dsh_bridge/diag/stats ->', stats.status, stats.error || '');
  console.log('  ', stats.body ? stats.body.toString('utf8').slice(0, 320) : '');
})();
