'use strict';
// Runs independently in Windows and opens an authenticated outbound loopback channel.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { WebSocket } = require('ws');
const { packFrame } = require('./frame-stream.cjs');
const { CDP, inputCommand } = require('./native-protocol.cjs');
const { ownedProfile, browserArgs, endpoint } = require('./native-browser.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let cdp, viewport = { width: 1280, height: 900 }, closing = false, pendingFrame, lastFrame = 0;
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const key of ['CHAT_WEB_NATIVE_ROOT','CHAT_WEB_BROWSER_BIN','CHAT_WEB_START_URL','CHAT_WEB_CANARY'])
  if (config[key]) process.env[key] = config[key];
const bridgeOrigin = new URL(config.origin);
if (bridgeOrigin.origin !== config.origin || bridgeOrigin.hostname !== '127.0.0.1') throw new Error('Invalid local bridge origin');
let channelSocket, frameTimer, sentAt = 0;
function queueFrame(frame) {
  pendingFrame = frame;
  if (!frameTimer) frameTimer = setTimeout(flushFrame, Math.max(0, 1000 / 60 - (performance.now() - sentAt)));
}
function flushFrame() {
  frameTimer = null;
  if (!pendingFrame || closing || channelSocket.readyState !== WebSocket.OPEN) return;
  if (channelSocket.bufferedAmount > 256 * 1024) { frameTimer = setTimeout(flushFrame, 17); return; }
  const frame = pendingFrame; pendingFrame = null;
  try {
    channelSocket.send(packFrame(frame), { binary:true, compress:false });
    sentAt = performance.now(); lastFrame = Date.now();
  } catch { stop(); }
}
function emit(value) {
  if (!closing && channelSocket?.readyState === WebSocket.OPEN)
    channelSocket.send(JSON.stringify(value), { compress: false });
}
function stop() {
  if (closing) return;
  closing = true; clearTimeout(frameTimer);
  channelSocket?.close(); cdp?.socket.close();
  setTimeout(() => process.exit(0), 500).unref();
}
async function connect() {
  if (process.platform !== 'win32') throw new Error('Native driver requires Windows Node');
  const { root, profile } = ownedProfile(process.env.CHAT_WEB_NATIVE_ROOT || 'D:\\dev\\codex\\tunnel-chat\\chatgpt-web\\native');
  let origin = await endpoint(profile);
  if (!origin) {
    const browser = process.env.CHAT_WEB_BROWSER_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (!fs.existsSync(browser)) throw new Error('Browser executable is missing');
    const start = process.env.CHAT_WEB_START_URL || 'https://chatgpt.com/';
    const url = new URL(start);
    if (url.origin !== 'https://chatgpt.com' && !(url.hostname === '127.0.0.1' && process.env.CHAT_WEB_CANARY === '1'))
      throw new Error('Unsupported startup page');
    const child = spawn(browser, browserArgs(profile, { start }),
      { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => emit({ event: 'status', ready: false, message: 'Không mở được Chrome trên Windows.' }));
    child.unref();
    for (let i = 0; i < 60 && !origin; i++) { await delay(500); origin = await endpoint(profile); }
    if (!origin) throw new Error('Close the manual-login Chrome window, then run bin/chat-web-start again');
  }
  const pages = await (await fetch(origin + '/json/list', { signal: AbortSignal.timeout(5000) })).json();
  const savedId = path.join(root, 'target-id.txt');
  const wanted = fs.existsSync(savedId) ? fs.readFileSync(savedId, 'utf8').trim() : '';
  const page = pages.find(p => p.type === 'page' && p.id === wanted) ||
    pages.find(p => p.type === 'page' && /^https:\/\/chatgpt\.com(?:\/|$)/.test(p.url)) ||
    (process.env.CHAT_WEB_CANARY === '1' ? pages.find(p => p.type === 'page' && p.url.startsWith('http://127.0.0.1:')) : null);
  if (!page) throw new Error('Open ChatGPT in the dedicated Chrome window, then restart the web bridge');
  fs.writeFileSync(savedId, page.id);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser connection timed out')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Browser connection failed')); }, { once: true });
  });
  cdp = new CDP(socket);
  cdp.on('protocolError', value => process.stderr.write('CDP data decode failed: ' + JSON.stringify(value) + '\n'));
  let receivedFirstFrame = false;
  cdp.on('disconnected', () => {
    emit({ event:'status', ready:false, message:'Cửa sổ Chrome đã ngắt kết nối. Bật lại bridge trên máy cá nhân.' });
    stop();
  });
  async function metrics() {
    try {
      const value = (await cdp.call('Page.getLayoutMetrics')).cssVisualViewport;
      if (value) viewport = { width: value.clientWidth, height: value.clientHeight };
    } catch {}
  }
  cdp.on('Page.frameResized', metrics);
  cdp.on('Page.frameNavigated', metrics);
  cdp.on('Page.screencastFrame', frame => {
    if (!receivedFirstFrame) { process.stderr.write('First screencast frame: ' + frame.data.length + ' bytes\n'); receivedFirstFrame = true; }
    cdp.call('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    queueFrame({ data: frame.data, width: viewport.width, height: viewport.height, capturedAt: Date.now() });
  });
  await cdp.call('Page.enable');
  await metrics();
  process.stderr.write('Native viewport: ' + viewport.width + 'x' + viewport.height + '\n');
  // A local file picker cannot be forwarded as part of the web page.
  await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true });
  cdp.on('Page.fileChooserOpened', () => emit({ event: 'notice', message: 'Tải tệp qua tunnel chưa được hỗ trợ.' }));
  await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
  emit({ event: 'status', ready: true, message: 'Đã kết nối Chrome trên máy cá nhân.' });
  let capturing = false;
  setInterval(async () => {
    if (Date.now() - lastFrame < 1000 || closing || capturing) return;
    capturing = true;
    try {
      await metrics();
      const frame = await cdp.call('Page.captureScreenshot', { format:'jpeg', quality:75, captureBeyondViewport:false });
      queueFrame({ data:frame.data, width:viewport.width, height:viewport.height, capturedAt:Date.now() });
    } catch {}
    finally { capturing = false; }
  }, 1000).unref();
}
async function execute(request) {
  if (closing) return;
  try {
    if (request.type === 'input') {
      const [method, params] = inputCommand(request.data, viewport); await cdp.call(method, params);
    } else if (request.type === 'control' && request.action === 'reload') await cdp.call('Page.reload');
    else if (request.type === 'control' && request.action === 'home') await cdp.call('Page.navigate', { url:'https://chatgpt.com/' });
    else if (request.type === 'control' && request.action === 'viewport') {
      const { width, height } = request;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || width > 1920 || height < 360 || height > 1400)
        throw new Error('Invalid viewport');
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false });
      viewport = { width, height };
    } else throw new Error('Unsupported browser action');
    emit({ id:request.id, ok:true });
  } catch { emit({ id:request.id, error:'Browser action failed; check the page before retrying' }); }
}
async function main() {
  channelSocket = new WebSocket(config.origin.replace('http:', 'ws:') + '/__driver/socket', {
    headers:{ authorization:'Bearer ' + config.token }, perMessageDeflate:false,
    handshakeTimeout:5000, maxPayload:100000,
  });
  channelSocket.on('error', () => {});
  channelSocket.on('close', stop);
  await new Promise((resolve, reject) => {
    channelSocket.once('open', resolve);
    channelSocket.once('error', () => reject(new Error('Local bridge unavailable')));
  });
  // Preserve execution order locally, without a network round trip between commands.
  let commands = Promise.resolve(), queued = 0;
  channelSocket.on('message', (data, binary) => {
    let request;
    try { if (binary || ++queued > 128) throw new Error(); request = JSON.parse(data.toString()); }
    catch { stop(); return; }
    commands = commands.then(() => execute(request)).finally(() => { queued--; });
  });
  await connect();
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
