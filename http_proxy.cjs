'use strict';
const http = require('node:http');
const https = require('node:https');

function headersWithoutHop(headers) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of (headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}
function upstreamURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid upstream origin');
  return url;
}
function proxyRequest(req, res, target, { privateChat = false, unavailable } = {}) {
  const headers = headersWithoutHop(req.headers);
  if (privateChat) {
    for (const key of Object.keys(headers)) {
      if (['cookie', 'authorization', 'x-chat-token'].includes(key) ||
          key.startsWith('x-forwarded-')) delete headers[key];
    }
  } else {
    // Chat browser sessions must never be sent to the Codex backend.
    delete headers.cookie;
  }
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: req.method, path: req.url, headers }, reply => {
    clearTimeout(timer);
    const outgoing = headersWithoutHop(reply.headers);
    if (privateChat) {
      delete outgoing['set-cookie'];
      outgoing['cache-control'] = 'no-store';
      outgoing['referrer-policy'] = 'no-referrer';
    }
    res.writeHead(reply.statusCode, outgoing);
    reply.on('error', () => res.destroy());
    reply.pipe(res);
  });
  const timer = setTimeout(() => upstream.destroy(), 30000);
  timer.unref();
  upstream.on('error', () => {
    clearTimeout(timer);
    if (res.headersSent) res.destroy();
    else if (unavailable) unavailable(res);
    else { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Codex backend unavailable'); }
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
function rejectUpgrade(socket, status = 401) {
  socket.end('HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}
function proxyUpgrade(req, socket, head, target, session) {
  const headers = headersWithoutHop(req.headers);
  for (const key of Object.keys(headers)) {
    if (['cookie', 'authorization', 'x-chat-token'].includes(key) ||
        key.startsWith('x-forwarded-')) delete headers[key];
  }
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: 'GET', path: req.url, headers });
  let peer;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(expiry);
    session.sockets.delete(socket);
    upstream.destroy();
    if (peer) peer.destroy();
    socket.destroy();
  };
  const timer = setTimeout(() => { rejectUpgrade(socket, 504); upstream.destroy(); }, 30000);
  const expiry = setTimeout(stop, Math.max(1, session.expires - Date.now()));
  timer.unref(); expiry.unref();
  session.sockets.add(socket);
  socket.on('error', stop);
  socket.on('close', stop);
  upstream.on('error', () => { if (!closed) rejectUpgrade(socket, 502); });
  upstream.on('response', () => { rejectUpgrade(socket, 502); upstream.destroy(); });
  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    clearTimeout(timer);
    peer = upstreamSocket;
    if (closed) { peer.destroy(); return; }
    const responseHeaders = headersWithoutHop(reply.headers);
    delete responseHeaders['set-cookie'];
    responseHeaders.connection = 'Upgrade';
    responseHeaders.upgrade = 'websocket';
    let response = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [key, value] of Object.entries(responseHeaders)) {
      for (const item of Array.isArray(value) ? value : [value]) response += key + ': ' + item + '\r\n';
    }
    socket.write(response + '\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) peer.write(head);
    peer.on('error', stop); peer.on('close', stop);
    socket.pipe(peer); peer.pipe(socket);
  });
  upstream.end();
}
module.exports = { upstreamURL, proxyRequest, proxyUpgrade, rejectUpgrade };
