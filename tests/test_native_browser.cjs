'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browserArgs } = require('../chatgpt-web/native-browser.cjs');
const { inputCommand, CDP } = require('../chatgpt-web/native-protocol.cjs');

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
