'use strict';
const http = require('node:http');
function get(i) {
  return new Promise(function (resolve) {
    const r = http.request({ host: '127.0.0.1', port: 3091, path: '/file-' + i, method: 'GET', headers: {} }, function (res) {
      let d = ''; res.setEncoding('utf8'); res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ i: i, status: res.statusCode, cd: res.headers['content-disposition'] || '-', body: d }); });
    });
    r.on('error', function (e) { resolve({ i: i, error: e.message }); });
    r.end();
  });
}
(async function () {
  const a = await get(1);
  console.log('request 1:', JSON.stringify(a));
  await new Promise(function (r) { setTimeout(r, 300); });
  const b = await get(2);
  console.log('request 2 (bridge con song khong):', JSON.stringify(b));
})();
