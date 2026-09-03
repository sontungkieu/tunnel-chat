'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { WebSocket } = require('ws');
const { createNativeServer, Driver } = require('../chatgpt-web/native-server.cjs');
const { packFrame, unpackFrame, FrameWindow } = require('../chatgpt-web/frame-stream.cjs');
const { InputBuffer } = require('../chatgpt-web/input-buffer.js');
const { createGateway } = require('../gateway.cjs');
const JPEG = Buffer.from([255,216,255,217]);
const password = 'test-only-websocket-password-123456';
async function listen(server) { server.listen(0,'127.0.0.1'); await once(server,'listening'); return 'http://127.0.0.1:'+server.address().port; }
function client(url, options = {}) {
  const socket = new WebSocket(url.replace('http:','ws:'), { perMessageDeflate:false, ...options });
  socket.on('error', () => {});
  const messages = [], waiters = [];
  socket.on('message', (data, binary) => {
    const value = binary ? unpackFrame(data) : JSON.parse(data.toString());
    const i = waiters.findIndex(w => w.filter(value));
    if (i >= 0) { const waiter = waiters.splice(i,1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); }
    else messages.push(value);
  });
  socket.next = (filter = () => true) => {
    const i = messages.findIndex(filter); if (i >= 0) return Promise.resolve(messages.splice(i,1)[0]);
    return new Promise((resolve,reject) => {
      const entry = { filter, resolve, timer:setTimeout(() => reject(new Error('Socket message timed out')),2000) };
      waiters.push(entry);
    });
  };
  return socket;
}
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'tunnel-ws-test-'));
  const passwordFile=join(dir,'password'); writeFileSync(passwordFile,password,{mode:0o600});
  const driver = new Driver('test-private-capability');
  const server = createNativeServer(driver); const native = await listen(server);
  const gateway = createGateway({codexUpstream:native,chat:{passwordFile,upstream:native}});
  const base = await listen(gateway), sockets=[];
  t.after(async () => {
    sockets.forEach(s=>s.terminate()); server.closeViewers(); driver.close();
    gateway.closeAllConnections(); server.closeAllConnections();
    await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>server.close(r))]);
    rmSync(dir,{recursive:true,force:true});
  });
  const privateClient=()=>{const s=client(native+'/__driver/socket',{headers:{authorization:'Bearer test-private-capability'}});sockets.push(s);return s;};
  const login=await fetch(base+'/chat/_auth/login',{method:'POST',headers:{origin:base},body:new URLSearchParams({password}),redirect:'manual'});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const viewer=()=>{const s=client(base+'/chat/api/socket',{origin:base,headers:{cookie}});sockets.push(s);return s;};
  return { driver, server, native, base, cookie, privateClient, viewer };
}
async function rejected(url, options={}) {
  const socket=client(url,options);
  return new Promise((resolve,reject) => {
    socket.once('unexpected-response',(_req,res)=>{const status=res.statusCode;res.resume();socket.terminate();resolve(status);});
    socket.once('open',()=>{socket.terminate();reject(new Error('Unexpected upgrade'));});
  });
}
test('image wire format rejects malformed images and keeps binary pixels intact', () => {
  const packet=packFrame({data:JPEG,width:1200,height:800,seq:7,capturedAt:123});
  const frame=unpackFrame(packet); assert.equal(frame.seq,7); assert.equal(frame.width,1200);
  assert.deepEqual(packet.subarray(24),JPEG); assert.equal(frame.capturedAt,123);
  assert.throws(()=>unpackFrame(Buffer.from('{}')));
  assert.throws(()=>packFrame({data:Buffer.from('not-jpeg'),width:100,height:100}));
});
test('slow viewers keep two frames in flight and only the newest waiting image', () => {
  const sent=[];
  const socket={readyState:1,bufferedAmount:0,send:packet=>sent.push(unpackFrame(packet).seq)};
  const window=new FrameWindow(socket);
  for(let seq=1;seq<=100;seq++) window.offer(unpackFrame(packFrame({data:JPEG,width:100,height:100,seq})));
  assert.deepEqual(sent,[1,2]); assert.equal(window.inFlight.size,2); assert.equal(window.latest.seq,100);
  window.ack(2); assert.deepEqual(sent,[1,2,100]); assert.equal(window.inFlight.size,1);
  assert.throws(()=>window.ack(101)); assert.equal(window.stale(Date.now()+6000),true);
});
test('mouse bursts coalesce while clicks, Unicode and key order remain intact', () => {
  const q=new InputBuffer();
  const mouse=(type,x=0,deltaY=0)=>({command:{type:'input',data:{kind:'mouse',type,x,y:0,buttons:0,modifiers:0,deltaX:0,deltaY}}});
  for(let x=0;x<100;x++) q.push(mouse('mouseMoved',x/100));
  q.push(mouse('mousePressed')); q.push(mouse('mouseReleased'));
  for(let i=0;i<10;i++) q.push(mouse('mouseWheel',0,100));
  q.push({command:{type:'input',data:{kind:'text',text:'Tiếng Việt'}}});
  q.push({command:{type:'input',data:{kind:'key',type:'keyDown',key:'Enter'}}});
  q.push({command:{type:'input',data:{kind:'key',type:'keyUp',key:'Enter'}}});
  assert.equal(q.length,7); assert.equal(q.shift().command.data.x,.99);
  assert.equal(q.shift().command.data.type,'mousePressed'); assert.equal(q.shift().command.data.type,'mouseReleased');
  assert.equal(q.shift().command.data.deltaY,1000); assert.equal(q.shift().command.data.text,'Tiếng Việt');
  assert.equal(q.shift().command.data.type,'keyDown'); assert.equal(q.shift().command.data.type,'keyUp');
});
test('public images and input use authenticated WebSockets; driver capability stays private', async t => {
  const f=await fixture(t);
  assert.equal(await rejected(f.native+'/__driver/socket'),401);
  assert.equal(await rejected(f.base+'/chat/api/socket',{origin:f.base}),401);
  assert.equal(await rejected(f.base+'/chat/api/socket',{origin:'https://other.example',headers:{cookie:f.cookie}}),401);
  assert.equal(await rejected(f.base+'/chat/__driver/socket',{origin:f.base,headers:{cookie:f.cookie}}),502);
  const helper=f.privateClient(); await once(helper,'open');
  helper.send(JSON.stringify({event:'status',ready:true,message:'canary'}));
  const viewer=f.viewer(); await once(viewer,'open'); await viewer.next(m=>m.event==='status'&&m.ready);
  helper.send(packFrame({data:JPEG,width:100,height:100}));
  const frame=await viewer.next(m=>m.packet); assert.deepEqual(frame.packet.subarray(24),JPEG);
  viewer.send(JSON.stringify({type:'frameAck',seq:frame.seq}));
  viewer.send(JSON.stringify({type:'ping',id:22})); assert.equal((await viewer.next(m=>m.event==='pong')).id,22);
  viewer.send(JSON.stringify({type:'input',id:1,data:{kind:'text',text:'Xin chào Việt Nam'}}));
  const command=await helper.next(m=>m.type==='input'); assert.equal(command.data.text,'Xin chào Việt Nam');
  helper.send(JSON.stringify({id:command.id,ok:true})); assert.equal((await viewer.next(m=>m.event==='ack')).ok,true);
  const closed=once(viewer,'close');
  await fetch(f.base+'/chat/_auth/logout',{method:'POST',headers:{origin:f.base,cookie:f.cookie},redirect:'manual'});
  await closed;
  assert.equal(await rejected(f.base+'/chat/api/socket',{origin:f.base,headers:{cookie:f.cookie}}),401);
});
test('inputs pipeline before replies; a driver disconnect fails work without replay', async t => {
  const f=await fixture(t), helper=f.privateClient(); await once(helper,'open');
  helper.send(JSON.stringify({event:'status',ready:true,message:'canary'}));
  const viewer=f.viewer(); await once(viewer,'open'); await viewer.next(m=>m.event==='status'&&m.ready);
  for(let id=1;id<=8;id++) viewer.send(JSON.stringify({id,type:'input',data:{kind:'text',text:String(id)}}));
  const commands=[]; for(let i=0;i<8;i++) commands.push(await helper.next(m=>m.type==='input'));
  assert.deepEqual(commands.map(c=>c.data.text),['1','2','3','4','5','6','7','8']);
  // None has replied yet, but all eight have arrived in order at the Windows side.
  helper.terminate();
  for(let i=0;i<8;i++) assert.equal((await viewer.next(m=>m.event==='ack')).ok,false);
  assert.equal(f.driver.pending.size,0);
  const replacement=f.privateClient(); await once(replacement,'open');
  assert.equal(f.driver.pending.size,0);
  assert.equal((await fetch(f.native+'/chat/api/frames')).status,426);
});