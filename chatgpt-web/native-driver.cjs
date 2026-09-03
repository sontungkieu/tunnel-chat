'use strict';
// Runs independently in Windows and opens an authenticated outbound loopback channel.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CDP, inputCommand } = require('./native-protocol.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let cdp, viewport = { width: 1280, height: 900 }, closing = false, pendingFrame, lastFrame = 0;
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const key of ['CHAT_WEB_NATIVE_ROOT','CHAT_WEB_BROWSER_BIN','CHAT_WEB_START_URL','CHAT_WEB_CANARY'])
  if (config[key]) process.env[key] = config[key];
const bridgeOrigin = new URL(config.origin);
if (bridgeOrigin.origin !== config.origin || bridgeOrigin.hostname !== '127.0.0.1') throw new Error('Invalid local bridge origin');
let outgoing = [], outgoingFrame;
function emit(value) {
  if (closing) return;
  if (value.event === 'frame') outgoingFrame = value;
  else if (outgoing.length < 256) outgoing.push(value);
}
async function channel(route, options = {}) {
  const response = await fetch(config.origin + route, { ...options,
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20000) });
  if (response.status === 401) closing = true;
  if (!response.ok) throw new Error('Local bridge unavailable');
  return response.json();
}
async function endpoint(profile) {
  try {
    const [port, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !browserPath.startsWith('/devtools/browser/')) return null;
    const origin = 'http://127.0.0.1:' + port;
    const response = await fetch(origin + '/json/version', { signal: AbortSignal.timeout(1500) });
    const version = await response.json();
    if (new URL(version.webSocketDebuggerUrl).pathname !== browserPath) return null;
    return origin;
  } catch { return null; }
}
async function connect() {
  if (process.platform !== 'win32') throw new Error('Native driver requires Windows Node');
  const root = path.resolve(process.env.CHAT_WEB_NATIVE_ROOT || 'D:\\dev\\codex\\tunnel-chat\\chatgpt-web\\native');
  if (!/^[D-Z]:\\/i.test(root) || root.length < 12) throw new Error('Use a dedicated browser directory on D: or another data drive');
  const profile = path.join(root, 'profile');
  const marker = path.join(root, 'tunnel-chat-native.json');
  if (fs.existsSync(profile) && !fs.existsSync(marker)) throw new Error('Refusing to use an existing unowned browser profile');
  fs.mkdirSync(profile, { recursive: true });
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ purpose: 'tunnel-chat-browser', version: 1 }));
  let origin = await endpoint(profile);
  if (!origin) {
    const browser = process.env.CHAT_WEB_BROWSER_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (!fs.existsSync(browser)) throw new Error('Browser executable is missing');
    const start = process.env.CHAT_WEB_START_URL || 'https://chatgpt.com/';
    const url = new URL(start);
    if (url.origin !== 'https://chatgpt.com' && !(url.hostname === '127.0.0.1' && process.env.CHAT_WEB_CANARY === '1'))
      throw new Error('Unsupported startup page');
    const child = spawn(browser, ['--user-data-dir=' + profile, '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--window-size=1280,960', '--app=' + start],
      { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => emit({ event: 'status', ready: false, message: 'Không mở được Chrome trên Windows.' }));
    child.unref();
    for (let i = 0; i < 60 && !origin; i++) { await delay(500); origin = await endpoint(profile); }
    if (!origin) throw new Error('Browser did not expose its local control endpoint');
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
    if (closing) return;
    closing = true;
    const message = { event: 'status', ready: false, message: 'Cửa sổ Chrome đã ngắt kết nối. Chạy lại bridge trên máy cá nhân.' };
    channel('/__driver/event', { method: 'POST', body: JSON.stringify(message) }).catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
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
    pendingFrame = { event: 'frame', data: frame.data, width: viewport.width, height: viewport.height };
  });
  await cdp.call('Page.enable');
  await metrics();
  process.stderr.write('Native viewport: ' + viewport.width + 'x' + viewport.height + '\n');
  // A local file picker cannot be forwarded as part of the web page.
  await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true });
  cdp.on('Page.fileChooserOpened', () => emit({ event: 'notice', message: 'Tải tệp qua tunnel chưa được hỗ trợ.' }));
  await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
  emit({ event: 'status', ready: true, message: 'Đã kết nối Chrome trên máy cá nhân.' });
  // Keep the newest frame; drop stale images instead of queuing them.
  setInterval(() => {
    if (pendingFrame) { emit(pendingFrame); pendingFrame = null; lastFrame = Date.now(); }
  }, 120).unref();
  // Refresh still/background pages and recover a first frame after reconnect.
  setInterval(async () => {
    if (Date.now() - lastFrame < 4000 || closing) return;
    try {
      await metrics();
      const frame = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: false });
      pendingFrame = { event: 'frame', data: frame.data, width: viewport.width, height: viewport.height };
    } catch (error) { process.stderr.write('Capture failed: ' + error.message + '\n'); }
  }, 4000).unref();
}
async function main() {
  await connect();
  let posting = false;
  const uploader = setInterval(async () => {
    if (posting || closing) return;
    const message = outgoing.length ? outgoing.shift() : outgoingFrame;
    if (!message) return;
    if (message.event === 'frame') outgoingFrame = null;
    posting = true;
    try { await channel('/__driver/event', { method: 'POST', body: JSON.stringify(message) }); }
    catch { if (message.event !== 'frame') outgoing.unshift(message); }
    finally { posting = false; }
  }, 100);
  let failures = 0;
  while (!closing) {
    let request;
    try { request = await channel('/__driver/next'); failures = 0; }
    catch {
      if (closing || ++failures >= 10) break;
      await delay(1500); continue;
    }
    if (request.type === 'shutdown') break;
    if (request.type === 'idle') continue;
    try {
      if (request.type === 'input') {
        const [method, params] = inputCommand(request.data, viewport); await cdp.call(method, params);
      } else if (request.type === 'control' && request.action === 'reload') await cdp.call('Page.reload');
      else if (request.type === 'control' && request.action === 'home') await cdp.call('Page.navigate', { url: 'https://chatgpt.com/' });
      else if (request.type === 'control' && request.action === 'viewport') {
        const { width, height } = request;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || width > 1920 || height < 360 || height > 1400)
          throw new Error('Invalid viewport');
        await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        viewport = { width, height };
      }
      else throw new Error('Unsupported browser action');
      emit({ id: request.id, ok: true });
    } catch { emit({ id: request.id, error: 'Browser action failed; check the page before retrying' }); }
  }
  closing = true; clearInterval(uploader);
  if (cdp) cdp.socket.close();
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
