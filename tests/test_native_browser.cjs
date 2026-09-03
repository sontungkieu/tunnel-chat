'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { browserArgs } = require('../chatgpt-web/native-browser.cjs');
const { inputCommand, CDP } = require('../chatgpt-web/native-protocol.cjs');
const { createNativeServer, Driver } = require('../chatgpt-web/native-server.cjs');

test('input whitelist maps scaled coordinates and Unicode without exposing arbitrary CDP', () => {
  const [method, args] = inputCommand({ kind:'mouse', type:'mousePressed', x:.25, y:.5,
    button:'left', buttons:1, clickCount:1 }, { width:1200,height:800 });
  assert.equal(method,'Input.dispatchMouseEvent'); assert.equal(args.x,300); assert.equal(args.y,400);
  assert.deepEqual(inputCommand({kind:'text',text:'Xin chào Việt Nam\n'},{}),
    ['Input.insertText',{text:'Xin chào Việt Nam\n'}]);
  assert.throws(() => inputCommand({method:'Runtime.evaluate',params:{expression:'bad'}},{}));
  assert.throws(() => inputCommand({kind:'mouse',type:'mouseMoved',x:Infinity,y:0},{width:1,height:1}));
  assert.throws(() => inputCommand({kind:'text',text:'x'.repeat(65537)},{}));
  assert.equal(inputCommand({kind:'key',type:'keyDown',key:'a',code:'KeyA',keyCode:65}, {})[1].text,'a');
  assert.equal(inputCommand({kind:'key',type:'keyDown',key:'a',code:'KeyA',keyCode:65,modifiers:2}, {})[1].text,undefined);
});

test('CDP correlates out-of-order replies and fails pending work on disconnect', async () => {
  class Socket extends EventTarget {
    readyState=1; sent=[];
    send(value) { this.sent.push(JSON.parse(value)); }
    message(value) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)})); }
  }
  const socket=new Socket(), cdp=new CDP(socket);
  const first=cdp.call('Page.enable'), second=cdp.call('Page.getLayoutMetrics');
  socket.message({id:2,result:{width:10}}); socket.message({id:1,result:{}});
  assert.deepEqual(await second,{width:10}); assert.deepEqual(await first,{});
  const waiting=cdp.call('Input.insertText',{text:'test'}); socket.readyState=3;
  socket.dispatchEvent(new Event('close'));
  await assert.rejects(waiting,/disconnected/);
});

test('native server streams current frames and forwards input once; blocks cross-origin writes', async t => {
  const driver=new EventEmitter();
  driver.status={ready:true,message:'test'}; driver.frame={data:'fake-test-jpeg',width:100,height:100};
  const calls=[]; driver.call=async value => calls.push(value);
  const server=createNativeServer(driver);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>{server.closeViewers();server.closeAllConnections();server.close();});
  const request=(path,options={})=>fetch(base+path,options);
  assert.equal((await request('/chat/')).status,200);
  assert.equal((await request('/__native_canary')).status,404);
  const stream=await request('/chat/api/frames');
  const reader=stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/fake-test-jpeg/);
  driver.emit('frame',{data:'new-frame',width:100,height:100});
  assert.match(new TextDecoder().decode((await reader.read()).value),/new-frame/);
  await reader.cancel();
  const input={kind:'text',text:'Một lần'};
  assert.equal((await request('/chat/api/input',{method:'POST',headers:{origin:base},
    body:JSON.stringify(input)})).status,200);
  assert.deepEqual(calls,[{type:'input',data:input}]);
  assert.equal((await request('/chat/api/input',{method:'POST',headers:{origin:'https://other.example'},
    body:JSON.stringify(input)})).status,403);
  assert.equal(calls.length,1);
});

test('private driver channel requires its own capability and delivers each command once', async t => {
  const driver = new Driver('private-test-capability');
  const server = createNativeServer(driver);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { driver.close(); server.closeViewers(); server.closeAllConnections(); server.close(); });
  assert.equal((await fetch(base + '/__driver/next')).status, 401);
  assert.equal((await fetch(base + '/__driver/event', {method:'POST', headers:{'x-chat-token':'codex-test'},body:'{}'})).status, 401);
  const headers = {authorization:'Bearer private-test-capability','content-type':'application/json'};
  await fetch(base + '/__driver/event', {method:'POST', headers,body:JSON.stringify({event:'status',ready:true,message:'test'})});
  const action = driver.call({type:'input',data:{kind:'text',text:'canary'}});
  const command = await (await fetch(base + '/__driver/next', {headers})).json();
  assert.equal(command.id, 1); assert.equal(command.data.text, 'canary'); assert.equal(driver.queue.length, 0);
  await fetch(base + '/__driver/event', {method:'POST',headers,body:JSON.stringify({id:command.id,ok:true})});
  await action;
  assert.equal(driver.pending.size, 0);
});

test('manual login uses the same owned profile without automation or an app window', () => {
  const profile = 'D:\\dedicated browser\\profile';
  const manual = browserArgs(profile, { manualLogin: true, start: 'https://unrelated.example' });
  const stream = browserArgs(profile);
  assert.ok(manual.includes('--user-data-dir=' + profile));
  assert.ok(stream.includes('--user-data-dir=' + profile));
  assert.ok(manual.includes('--new-window'));
  assert.equal(manual.at(-1), 'https://chatgpt.com/');
  assert.ok(manual.every(arg => !/debugging|automation|headless|--app=/.test(arg)));
  assert.ok(stream.includes('--remote-debugging-port=0'));
  assert.ok(stream.includes('--remote-debugging-address=127.0.0.1'));
});
