'use strict';
const https = require('node:https');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
const req = https.request({ host: HOST, servername: HOST, port: 443, path: '/__dsh_bridge/ws-shim.js', method: 'GET', headers: { host: HOST },
  lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }, function (res) {
  let d = ''; res.setEncoding('utf8'); res.on('data', function (c) { d += c; });
  res.on('end', function () { console.log('shim live ->', res.statusCode, '|', d.length, 'B | backdrop:', d.indexOf('dsh-mobile-backdrop') !== -1, '| khong luu:', d.indexOf("setItem('dsh.bridge.mobile'") === -1); });
});
req.on('error', function (e) { console.log('loi:', e.message); });
req.end();
