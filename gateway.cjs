#!/usr/bin/env node
'use strict';
const http = require('node:http');
const https = require('node:https');
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
function codexAuthorizer(target) {
  const transport = target.protocol === 'https:' ? https : http;
  return token => new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const request = transport.request(target, { method:'GET', path:'/d/list', timeout:3000,
      headers:{ 'x-chat-token':token, connection:'close' } }, response => {
      response.resume(); response.once('end', () => finish(response.statusCode === 200));
    });
    request.once('timeout', () => { request.destroy(); finish(false); });
    request.once('error', () => finish(false)); request.end();
  });
}
function createGateway(options) {
  const codex = upstreamURL(options.codexUpstream);
  const chat = createChatBridge({ ...(options.chat || {}), authorizeCodex:codexAuthorizer(codex) });
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
      shortSessionSeconds: process.env.CHAT_WEB_SHORT_SESSION_SECONDS,
      ticketSeconds: process.env.CHAT_WEB_TICKET_SECONDS,
    },
  });
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1',
    () => console.log('Tunnel gateway ready'));
}
module.exports = { createGateway };
