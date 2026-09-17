'use strict';
const fs = require('node:fs');
const WebSocket = require('./node_modules/ws');
const HOST = 'tungks2dsh.ccat.io.vn';
const IP = '104.21.40.57';
const COOKIE = fs.readFileSync('D:/dev/dsh/.dsh-cookie.txt', 'utf8').match(/document\.cookie="([^;]+)/)[1];
const ws = new WebSocket('wss://' + HOST + '/api/remote.mux', {
  headers: { host: HOST, origin: 'https://' + HOST, cookie: COOKIE },
  perMessageDeflate: false,
  servername: HOST,
  lookup: function (h, o, cb) { return (o && o.all) ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); },
});
const frames = [];
let done = false;
function finish(msg) { if (done) return; done = true; console.log(msg); for (const f of frames) console.log('  ', f); try { ws.close(); } catch (e) {} process.exit(0); }
ws.on('open', function () {
  console.log('WS qua Cloudflare: OPEN (101)');
  ws.send(JSON.stringify({ type: 'open', streamId: 'live1', endpoint: '$events', payload: { args: {} } }));
});
ws.on('message', function (d) { frames.push(d.toString('utf8').slice(0, 190)); });
ws.on('unexpected-response', function (r) { finish('bi tu choi: HTTP ' + r.statusCode); });
ws.on('error', function (e) { finish('loi: ' + e.message); });
ws.on('close', function (c) { finish('close ' + c); });
setTimeout(function () { finish('frames nhan duoc: ' + frames.length); }, 6000);
