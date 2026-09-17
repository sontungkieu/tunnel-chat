'use strict';
const fs = require('node:fs');
const https = require('node:https');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
const cookie = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
function call(path, withCookie) {
  return new Promise(function (resolve) {
    const headers = { host: HOST };
    if (withCookie) headers.cookie = cookie;
    const r = https.request({ host: HOST, servername: HOST, port: 443, path: path, method: 'GET', headers: headers,
      lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }, function (res) {
      let d = ''; res.setEncoding('utf8'); res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, len: d.length, head: d.slice(0, 70).replace(/\s+/g, ' '), setCookie: (res.headers['set-cookie'] || []).length }); });
    });
    r.on('error', function (e) { resolve({ error: e.message }); });
    r.end();
  });
}
(async function () {
  console.log('GET / khong cookie:', JSON.stringify(await call('/', false)));
  console.log('GET / co cookie   :', JSON.stringify(await call('/', true)));
  console.log('cookie name:', cookie.split('=')[0]);
})();
