'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { ownedProfile, browserArgs, endpoint } = require('./native-browser.cjs');

async function main() {
  if (process.platform !== 'win32') throw new Error('Run the login launcher with Windows Node');
  const { profile } = ownedProfile(process.argv[2]);
  const browser = process.argv[3];
  if (!browser || !fs.existsSync(browser)) throw new Error('Browser executable is missing');
  if (await endpoint(profile)) {
    throw new Error('Close the dedicated Chrome window (including the Google error window), then run bin/chat-web-login again. Streaming is paused.');
  }
  const child = spawn(browser, browserArgs(profile, { manualLogin: true }),
    { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  console.log('Normal Chrome opened for manual sign-in on this PC. Streaming stays paused.');
  console.log('After signing into ChatGPT, close this Chrome window and run bin/chat-web-start.');
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
