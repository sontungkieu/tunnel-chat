const fs = require("fs");
const vm = require("vm");

global.window = global;
global.btoa = value => Buffer.from(value, "binary").toString("base64");
vm.runInThisContext(fs.readFileSync("static/shared.js", "utf8"), {filename: "static/shared.js"});

async function main() {
  const assert = require("node:assert/strict");
  let requested;
  global.fetch = async (url, options) => {
    requested = {url,options};
    return {ok:true,json:async()=>({ok:true})};
  };
  await RLCSDTransport.createRpc({apiBase:"/d",token:"test-credential"})("list");
  assert.equal(new URL(requested.url,"http://local").searchParams.has("token"),false);
  assert.equal(requested.options.headers["x-chat-token"],"test-credential");
  assert.equal(requested.options.cache,"no-store");
  const local = new Map([["fixChatToken","old"]]), session = new Map();
  global.localStorage={getItem:key=>local.get(key),removeItem:key=>local.delete(key)};
  global.sessionStorage={getItem:key=>session.get(key),setItem:(key,value)=>session.set(key,value)};
  global.location={pathname:"/desktop",search:"?view=all",hash:"#token=new"};
  let rewritten;
  global.history={replaceState:(a,b,url)=>rewritten=url};
  assert.equal(RLCSDTransport.accessToken(),"new");
  assert.equal(rewritten,"/desktop?view=all");
  assert.equal(session.get("tunnelChatToken"),"new");
  assert.equal(local.has("fixChatToken"),false);

  session.clear();
  global.location={pathname:"/codex",search:"",hash:""};
  global.prompt=()=>{throw new Error("modal prompts are unavailable")};
  assert.equal(RLCSDTransport.accessToken({promptIfMissing:false}),"");

  const received = new Set();
  const failedOnce = new Set();
  let active = 0;
  let maxActive = 0;
  const totalChunks = 5;

  async function rpc(path, payload) {
    if (path === "start") return {upload_id: 7};
    if (path === "status") {
      return {
        received: [...received],
        missing: Array.from({length: totalChunks}, (_, index) => index).filter(index => !received.has(index)),
      };
    }
    if (path === "chunk") {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      if (payload.chunk_index === 1 && !failedOnce.has(1)) {
        failedOnce.add(1);
        throw new Error("simulated transient failure");
      }
      received.add(payload.chunk_index);
      return {ok: true};
    }
    if (path === "finish") return {ok: true};
    throw new Error(`unexpected path: ${path}`);
  }

  const result = await RLCSDTransport.uploadBlob({
    rpc,
    paths: {start: "start", chunk: "chunk", status: "status", finish: "finish"},
    blob: new Blob([new Uint8Array(50)]),
    chunkBytes: 10,
    concurrency: 3,
    retryLimit: 2,
  });

  if (!result.ok) throw new Error("finish result missing");
  if (received.size !== totalChunks) throw new Error(`received ${received.size}/${totalChunks}`);
  if (maxActive < 2 || maxActive > 3) throw new Error(`unexpected concurrency: ${maxActive}`);
  console.log("shared transport recovery: ok");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
