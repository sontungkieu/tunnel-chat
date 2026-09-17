'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
const PIN = fs.readFileSync('D:/dev/dsh/bridge/.login-key', 'utf8').trim();

function local(method, path, headers, body) {
  return new Promise(function (resolve, reject) {
    const r = http.request({ host: '127.0.0.1', port: 3090, method: method, path: path, headers: headers }, function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function publicReq(method, path, headers, body) {
  return new Promise(function (resolve) {
    const req = https.request({ host: HOST, servername: HOST, port: 443, path: path, method: method, headers: Object.assign({ host: HOST }, headers),
      lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }, function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }); });
    });
    req.on('error', function (e) { resolve({ error: e.message }); });
    if (body) req.write(body);
    req.end();
  });
}

(async function () {
  const page = await local('GET', '/__dsh_bridge/login', {});
  console.log('LOCAL GET /login ->', page.status, '| co form:', page.body.indexOf('name="k"') !== -1);

  const badBody = 'k=XXXXXX';
  const bad = await local('POST', '/__dsh_bridge/login', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': badBody.length }, badBody);
  console.log('LOCAL POST sai PIN ->', bad.status);

  const goodBody = 'k=' + encodeURIComponent(PIN);
  const good = await local('POST', '/__dsh_bridge/login', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': goodBody.length }, goodBody);
  const sc = (good.headers['set-cookie'] || [])[0] || '';
  console.log('LOCAL POST dung PIN ->', good.status, '| location:', good.headers.location, '| set-cookie:', sc.slice(0, 40) + '...');
  const cookie = sc.split(';')[0];
  const home = await local('GET', '/', { cookie: cookie });
  console.log('LOCAL GET / voi cookie vua cap ->', home.status, '| bytes', home.body.length, '| co shim:', home.body.indexOf('ws-shim.js') !== -1);

  console.log('--- qua Cloudflare (dung nhu may cong ty) ---');
  const pubPage = await publicReq('GET', '/__dsh_bridge/login', {});
  console.log('PUBLIC GET /login ->', pubPage.status, '| co form:', pubPage.body.indexOf('name="k"') !== -1);
  const pubGood = await publicReq('POST', '/__dsh_bridge/login', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': goodBody.length }, goodBody);
  const psc = (pubGood.headers['set-cookie'] || [])[0] || '';
  console.log('PUBLIC POST dung PIN ->', pubGood.status, '| location:', pubGood.headers.location);
  console.log('  cookie:', psc.slice(0, 34) + '... | co Secure:', psc.indexOf('Secure') !== -1);
  const pCookie = psc.split(';')[0];
  const pubHome = await publicReq('GET', '/', { cookie: pCookie });
  console.log('PUBLIC GET / voi cookie ->', pubHome.status, '| bytes', pubHome.body.length);
  const pubNo = await publicReq('GET', '/', {});
  console.log('PUBLIC GET / khong cookie ->', pubNo.status);
})();
