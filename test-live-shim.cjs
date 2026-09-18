'use strict';
const https = require('node:https');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
function get(path) {
  return new Promise(function (resolve) {
    const req = https.request({ host: HOST, servername: HOST, port: 443, path: path, method: 'GET', headers: { host: HOST },
      lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }, function (res) {
      let d = ''; res.setEncoding('utf8'); res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: d }); });
    });
    req.on('error', function (e) { resolve({ error: e.message }); });
    req.end();
  });
}
(async function () {
  const s = await get('/__dsh_bridge/ws-shim.js');
  console.log('shim live ->', s.status, '|', s.body.length, 'B');
  console.log('  nguong 8192        :', s.body.indexOf('RPC_THRESHOLD = 8192') !== -1);
  console.log('  tu giam khi 413    :', s.body.indexOf('giam con') !== -1);
  try { new Function(s.body); console.log('  syntax OK'); } catch (e) { console.log('  SYNTAX ERROR:', e.message); }
  const d = await get('/__dsh_bridge/diag');
  console.log('diag ->', d.status, '| quet nhieu kich thuoc:', d.body.indexOf('Tran body POST') !== -1);
})();
