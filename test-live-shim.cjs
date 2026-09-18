'use strict';
const https = require('node:https');
const http = require('node:http');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
function get(proto, path, opts) {
  return new Promise(function (resolve) {
    const mod = proto === 'https' ? https : http;
    const o = proto === 'https'
      ? { host: HOST, servername: HOST, port: 443, path: path, method: 'GET', headers: { host: HOST }, lookup: function (h, x, cb) { return (x && x.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); } }
      : { host: '127.0.0.1', port: 3090, path: path, method: 'GET', headers: {} };
    const req = mod.request(o, function (res) {
      let d = ''; res.setEncoding('utf8'); res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: d }); });
    });
    req.on('error', function (e) { resolve({ error: e.message }); });
    req.end();
  });
}
(async function () {
  const s = await get('https', '/__dsh_bridge/ws-shim.js');
  console.log('shim live ->', s.status, '|', s.body.length, 'B');
  console.log('  co RPC chunking     :', s.body.indexOf('installRpcChunking') !== -1);
  console.log('  co nguong rpcchunk  :', s.body.indexOf('rpcchunk') !== -1);
  try { new Function(s.body); console.log('  syntax OK'); } catch (e) { console.log('  SYNTAX ERROR:', e.message); }
  await get('http', '/__dsh_bridge/diag/stats');
})();
