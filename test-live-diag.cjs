'use strict';
const https = require('node:https');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
const req = https.request({ host: HOST, servername: HOST, port: 443, path: '/__dsh_bridge/diag', method: 'GET', headers: { host: HOST },
  lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }, function (res) {
  let d = ''; res.setEncoding('utf8'); res.on('data', function (c) { d += c; });
  res.on('end', function () {
    console.log('public /__dsh_bridge/diag ->', res.statusCode, '| bytes', d.length);
    console.log('  co test polling moi:', d.indexOf('poll/open') !== -1);
    console.log('  co KET LUAN:', d.indexOf('KET LUAN') !== -1);
    console.log('  co POST 2 MB:', d.indexOf('POST 2 MB') !== -1);
  });
});
req.on('error', function (e) { console.log('loi:', e.message); });
req.end();
