'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
async function main() {
  if (process.platform !== 'win32') throw new Error('Run the launcher with Windows Node');
  const configPath = path.resolve(process.argv[2]);
  if (!/^[D-Z]:\\/i.test(configPath)) throw new Error('Runtime configuration must be on a data drive');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const state = path.dirname(configPath);
  // Windows localhost forwarding may lag behind the WSL listener during startup.
  let status;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(config.origin + '/chat/api/status', { signal: AbortSignal.timeout(1000) });
      status = await response.json(); break;
    } catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  if (!status) throw new Error('Local browser bridge is not reachable from Windows');
  if (status.ready) { console.log('Native browser helper already connected'); return; }
  execFileSync('C:\\Windows\\System32\\icacls.exe', [configPath, '/inheritance:r', '/grant:r', os.userInfo().username + ':F'], { stdio:'ignore', windowsHide:true });
  const stdout = fs.openSync(path.join(state,'driver.stdout.log'),'a');
  const stderr = fs.openSync(path.join(state,'driver.stderr.log'),'a');
  const child = spawn(process.execPath, [path.join(__dirname,'native-driver.cjs'),configPath],
    { detached:true, windowsHide:true, stdio:['ignore',stdout,stderr], cwd:state });
  child.on('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
  child.unref(); fs.closeSync(stdout); fs.closeSync(stderr);
  fs.writeFileSync(path.join(state,'driver.pid'),String(child.pid));
  console.log('Native browser helper started pid='+child.pid);
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exit(1);});
