'use strict';
const fs = require('node:fs');
const path = require('node:path');

function ownedProfile(root) {
  root = path.resolve(root);
  if (!/^[D-Z]:\\/i.test(root) || root.length < 12)
    throw new Error('Use a dedicated browser directory on D: or another data drive');
  const profile = path.join(root, 'profile');
  const marker = path.join(root, 'tunnel-chat-native.json');
  if (fs.existsSync(profile) && !fs.existsSync(marker))
    throw new Error('Refusing to use an existing unowned browser profile');
  fs.mkdirSync(profile, { recursive: true });
  if (!fs.existsSync(marker))
    fs.writeFileSync(marker, JSON.stringify({ purpose: 'tunnel-chat-browser', version: 1 }));
  return { root, profile };
}

function browserArgs(profile, { manualLogin = false, start = 'https://chatgpt.com/' } = {}) {
  const common = ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check'];
  // Local human sign-in has no automation connection and uses a normal Chrome window.
  if (manualLogin) return [...common, '--new-window', 'https://chatgpt.com/'];
  return [...common, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-size=1280,960', '--app=' + start];
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
module.exports = { ownedProfile, browserArgs, endpoint };
