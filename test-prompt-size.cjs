'use strict';
const fs = require('node:fs');
const http = require('node:http');
const HOST = 'tungks2dsh.ccat.io.vn';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
function send(port, size) {
  return new Promise(function (resolve) {
    const body = Buffer.alloc(size, 0x20);
    body.write('{"type":"x"}');
    const headers = { host: HOST, origin: 'https://' + HOST, cookie: COOKIE, 'content-type': 'application/json', 'content-length': size };
    const r = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: '/api/session/prompt', headers: headers }, function (res) {
      const c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { resolve({ size: size, status: res.statusCode, body: Buffer.concat(c).toString('utf8').slice(0, 90).replace(/\s+/g, ' ') }); });
    });
    r.on('error', function (e) { resolve({ size: size, error: e.message }); });
    r.end(body);
  });
}
(async function () {
  for (const size of [1024, 262144, 1048576, 4194304]) {
    console.log('DSH 3080  ' + String(size).padStart(8) + ' B ->', JSON.stringify(await send(3080, size)));
  }
  for (const size of [262144, 1048576]) {
    console.log('bridge 3090 ' + String(size).padStart(7) + ' B ->', JSON.stringify(await send(3090, size)));
  }
})();
