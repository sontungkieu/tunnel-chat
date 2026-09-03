#!/usr/bin/env node
'use strict';
const http = require('node:http');
const { upstreamURL, proxyRequest, rejectUpgrade } = require('./http_proxy.cjs');
const { createChatBridge } = require('./chatgpt-web/bridge.cjs');

function requestPath(req) {
  if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
    throw new Error('Invalid request path');
  }
  const url = new URL(req.url, 'http://localhost');
  req.url = url.pathname + url.search;
  return url.pathname;
}
function createGateway(options) {
  const codex = upstreamURL(options.codexUpstream);
  const chat = createChatBridge(options.chat || {});
  const server = http.createServer((req, res) => {
    let path;
    try { path = requestPath(req); } catch { res.writeHead(400); res.end(); return; }
    if (path === '/' || path === '/chat') {
      res.writeHead(302, { location: '/chat/#', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(); return;
    }
    if (path.startsWith('/chat/')) {
      chat.handle(req, res, path).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Chat web request failed');
      });
      return;
    }
    proxyRequest(req, res, codex);
  });
  server.on('upgrade', (req, socket, head) => {
    let path;
    try { path = requestPath(req); } catch { rejectUpgrade(socket, 400); return; }
    if (!path.startsWith('/chat/') || path.startsWith('/chat/_auth/')) {
      rejectUpgrade(socket, 404); return;
    }
    chat.upgrade(req, socket, head);
  });
  server.on('close', chat.close);
  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400));
  return server;
}
if (require.main === module) {
  const server = createGateway({
    codexUpstream: process.env.CODEX_UPSTREAM,
    chat: {
      passwordFile: process.env.CHAT_WEB_PASSWORD_FILE,
      upstream: process.env.CHAT_WEB_UPSTREAM,
      sessionSeconds: process.env.CHAT_WEB_SESSION_SECONDS,
    },
  });
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1',
    () => console.log('Tunnel gateway ready'));
}
module.exports = { createGateway };
