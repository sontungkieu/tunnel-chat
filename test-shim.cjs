'use strict';
/* Test shim trong Node: gia lap browser, ep che do polling, chay that qua bridge. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const NodeWS = require('./node_modules/ws');

const AUTHORITY = '127.0.0.1:3090';
const secret = fs.readFileSync('C:/Users/Tung/.dsh/.credentials.yaml', 'utf8').match(/^\s*secret:\s*([A-Za-z0-9_-]{43})\s*$/m)[1];
const b64u = function (b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(AUTHORITY).digest());
const now = Date.now();
const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 };
const bodyB64 = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
const sig = b64u(crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(bodyB64).digest());
const COOKIE = name + '=v1.' + bodyB64 + '.' + sig;

globalThis.window = { location: { href: 'http://127.0.0.1:3090/?transport=poll' }, WebSocket: NodeWS };
globalThis.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
const realFetch = globalThis.fetch;
globalThis.fetch = function (url, opts) {
  const u = String(url);
  if (u.indexOf('/__dsh_bridge') === 0) {
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign({}, (opts && opts.headers) || {}, { cookie: COOKIE });
    return realFetch('http://127.0.0.1:3090' + u, o);
  }
  return realFetch(url, opts);
};

const shimSrc = fs.readFileSync('./ws-shim.js', 'utf8');
(0, eval)(shimSrc);

const WS = globalThis.window.WebSocket;
console.log('shim mode:', globalThis.window.__DSH_BRIDGE__.mode());
const sock = new WS('http://127.0.0.1:3090/api/remote.mux');
const seen = [];
sock.onopen = function () {
  console.log('SHIM: open event, readyState =', sock.readyState, '| transport =', globalThis.window.__DSH_BRIDGE__.effective(sock));
  sock.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }));
};
sock.onmessage = function (ev) { seen.push(String(ev.data).slice(0, 160)); };
sock.onerror = function (ev) { console.log('SHIM: error', ev && ev.message); };
sock.onclose = function (ev) { console.log('SHIM: close', ev && ev.code); };

setTimeout(function () {
  console.log('frames qua shim polling:', seen.length);
  for (const s of seen) console.log('  ', s);
  console.log('gui tiep 1 lenh send de kiem tra thu tu...');
  sock.send(JSON.stringify({ type: 'open', streamId: 's2', endpoint: '$events', payload: { args: {} } }));
  setTimeout(function () {
    console.log('tong frames:', seen.length);
    for (const s of seen) console.log('  ', s);
    sock.close();
    setTimeout(function () { process.exit(seen.length >= 2 ? 0 : 2); }, 500);
  }, 3000);
}, 4000);
