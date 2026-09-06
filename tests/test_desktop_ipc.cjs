'use strict';
const assert=require('node:assert/strict');
const net=require('node:net');
const {test}=require('node:test');
const {Decoder,frame,applyPatches,projectState,validateApprovalDecision,DesktopClient}=require('../desktop_ipc.cjs');
const ID='11111111-1111-4111-8111-111111111111';
const sample=()=>({id:ID,title:'test',cwd:'D:\\work',latestModel:'test-model',threadRuntimeStatus:{type:'idle'},
  turns:[{turnId:'turn-1',status:'completed',params:{input:[{type:'text',text:'hello'}]},
    items:[{type:'agentMessage',id:'a',text:'reply'},{type:'reasoning',text:'must not be exported'}]}],requests:[]});
test('frames survive byte fragmentation and concatenation',()=>{
  const out=[],progress=[],d=new Decoder(m=>out.push(m),p=>progress.push(p));
  const bytes=Buffer.concat([frame({a:'tiếng Việt'}),frame({b:2})]);
  for(const byte of bytes)d.push(Buffer.from([byte]));
  assert.deepEqual(out,[{a:'tiếng Việt'},{b:2}]);
  assert.ok(progress.some(p=>p.receivedBytes<p.totalBytes));
  assert.ok(progress.some(p=>p.receivedBytes===p.totalBytes));
});
test('oversized frames and invalid JSON fail closed',()=>{
  const h=Buffer.alloc(4);h.writeUInt32LE(200000000);
  assert.throws(()=>new Decoder(()=>{}).push(h),/size/);
  assert.throws(()=>new Decoder(()=>{}).push(Buffer.from([2,0,0,0,120,120])));
});
test('Immer array patches and nested updates are atomic',()=>{
  const old={items:['a','b'],status:{type:'idle'}};
  const next=applyPatches(old,[{op:'add',path:['items',1],value:'c'},
    {op:'remove',path:['items',0]},{op:'replace',path:['status','type'],value:'active'}]);
  assert.deepEqual(next,{items:['c','b'],status:{type:'active'}});
  assert.deepEqual(old,{items:['a','b'],status:{type:'idle'}});
  assert.throws(()=>applyPatches(old,[{op:'add',path:['__proto__','polluted'],value:true}]));
  assert.equal({}.polluted,undefined);
  assert.throws(()=>applyPatches(old,[{op:'replace',path:['items',8],value:'bad'}]));
});
test('canonical history is ordered and hidden reasoning is omitted',()=>{
  const s=sample();s.turnHistory={kind:'canonical',history:{islands:[{entries:[{value:'b'},{value:'a'}]}],
    entitiesByKey:{a:s.turns[0],b:{params:{input:[{type:'text',text:'first'}]},items:[]}}}};
  const view=projectState(s,3);
  assert.equal(view.messages[0].text,'first');
  assert.equal(view.messages.at(-1).text,'reply');
  assert.ok(!JSON.stringify(view).includes('must not be exported'));
  assert.equal(view.cwd,'D:\\work');
});
test('projected user messages remove app context and canonical duplicates',()=>{
  const s=sample(),wrapped=`\n<in-app-browser-context source="ambient-ui-state">\nprivate UI metadata\n</in-app-browser-context>\n\n## My request:\nhello`;
  const image='C:\\Users\\Tung\\AppData\\Local\\Temp\\clipboard.png';
  s.cwd='D:\\dev\\codex\\fallback';
  s.turns[0].params.input=[{type:'text',text:wrapped},{type:'localImage',path:image}];
  s.turns[0].params.runtimeWorkspaceRoots=['D:\\dev\\codex\\research_vdt'];
  s.turns[0].items.unshift({type:'userMessage',id:'u',content:[{type:'text',text:wrapped},{type:'localImage',path:image}]});
  const view=projectState(s,1),users=view.messages.filter(message=>message.role==='user');
  assert.deepEqual(users,[{id:'u',role:'user',text:'hello',images:[image]}]);
  assert.equal(view.project,'research_vdt');
  assert.equal(view.projectPath,'D:\\dev\\codex\\research_vdt');
});
test('image-only user messages remain visible',()=>{
  const s=sample(),image='C:\\Temp\\diagram.png';
  s.turns[0].params.input=[{type:'localImage',path:image}];
  s.turns[0].items=[];
  assert.deepEqual(projectState(s,1).messages,[
    {id:'turn-1:user',role:'user',text:'',images:[image]},
  ]);
});
test('turn activity distinguishes thinking, tools, waiting and finished states',()=>{
  const completed=sample();completed.threadRuntimeStatus={type:'active'};
  assert.equal(projectState(completed,1).status,'idle');
  assert.equal(projectState(completed,1).activity,'completed');
  const thinking=sample();thinking.turns[0].status='inProgress';
  thinking.turns[0].items.push({type:'reasoning',id:'r'});
  assert.equal(projectState(thinking,2).activity,'thinking');
  const tool=sample();tool.turns[0].status='inProgress';
  tool.turns[0].items.push({type:'commandExecution',id:'c',status:'inProgress'});
  assert.equal(projectState(tool,3).activity,'tool');
  const waiting=sample();waiting.turns[0].status='inProgress';
  waiting.requests=[{id:'q',method:'item/tool/requestUserInput',params:{questions:[]}}];
  assert.equal(projectState(waiting,4).activity,'waiting');
  const finalizing=sample();finalizing.turns[0].status='inProgress';
  finalizing.turns[0].items.push({type:'agentMessage',id:'f',text:'done',phase:'final'});
  assert.equal(projectState(finalizing,5).activity,'finalizing');
  const interrupted=sample();interrupted.turns[0].status='interrupted';
  assert.equal(projectState(interrupted,6).activity,'interrupted');
});
test('projected history stays bounded to the latest 600 messages',()=>{
  const s=sample();s.turns=Array.from({length:700},(_,i)=>({turnId:`turn-${i}`,status:'completed',
    params:{input:[{type:'text',text:`message-${i}`}]},items:[]}));
  const view=projectState(s,1);
  assert.equal(view.messages.length,600);
  assert.equal(view.messages[0].text,'message-100');
  assert.equal(view.messages.at(-1).text,'message-699');
  assert.equal(view.historyTruncated,true);
});
async function fixture(t) {
  let state=sample(),owner='owner',silent=false,denyInitialize=false;const seen=[],sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    const decoder=new Decoder(m=>{
      if(m.type==='broadcast' && m.method==='thread-stream-following-changed' && m.params.following)
        socket.write(frame({type:'broadcast',method:'thread-stream-state-changed',sourceClientId:owner,version:11,
          params:{hostId:'local',conversationId:ID,targetClientIds:['client'],
            change:{type:'snapshot',revision:1,conversationState:state}}}));
      if(m.type!=='request')return;
      seen.push(m);
      if(denyInitialize && m.method==='initialize') {
        socket.write(frame({type:'response',requestId:m.requestId,resultType:'error',error:'unsupported initialization'}));
        return;
      }
      let result={ok:true};
      if(m.method==='initialize')result={clientId:'client'};
      if(m.method==='thread-owner-discovery')result={supportsUntrustedAppInput:true};
      if(m.method==='thread-follower-load-complete-history')result={revision:1};
      if(silent && m.method==='thread-follower-start-turn')return;
      socket.write(frame({type:'response',requestId:m.requestId,method:m.method,resultType:'success',
        handledByClientId:owner,result}));
    });
    socket.on('data',c=>decoder.push(c));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const client=new DesktopClient({socketFactory:()=>net.createConnection(server.address().port,'127.0.0.1'),timeout:50});
  t.after(()=>{client.close();for(const s of sockets)s.destroy();server.close();});
  return {client,seen,setState:s=>state=s,setOwner:o=>owner=o,setSilent:()=>silent=true,setDenyInitialize:value=>denyInitialize=value};
}
test('follower sends to owner and inherits settings without overriding runtime',async t=>{
  const f=await fixture(t);
  const state=await f.client.state(ID);
  assert.equal(state.messages[1].text,'reply');
  assert.ok(f.seen.find(m=>m.method==='thread-follower-load-complete-history').timeoutMs>1000);
  await f.client.act(ID,'send',{text:'next',mode:'start'});
  const sent=f.seen.at(-1);
  assert.equal(sent.method,'thread-follower-start-turn');
  assert.equal(sent.targetClientId,'owner');
  assert.deepEqual(sent.params.turnStart,{request:{threadId:ID,input:[{type:'text',text:'next',text_elements:[]}]},
    context:{inheritThreadSettings:true}});
  assert.equal(sent.hostId,undefined);
});
test('cancel carries exact active turn; stale stop and implicit steering are rejected',async t=>{
  const f=await fixture(t),s=sample();s.threadRuntimeStatus={type:'active'};s.turns[0].status='inProgress';f.setState(s);
  await f.client.state(ID);
  await assert.rejects(f.client.act(ID,'cancel',{expectedTurnId:'old'}),/changed/);
  await assert.rejects(f.client.act(ID,'send',{text:'next',mode:'start'}),/running/);
  await f.client.act(ID,'cancel',{expectedTurnId:'turn-1'});
  assert.equal(f.seen.at(-1).version,4);
  assert.equal(f.seen.at(-1).params.expectedTurnId,'turn-1');
  assert.equal(f.seen.at(-1).params.mode,'user-stop');
  await f.client.act(ID,'send',{text:'adjust',mode:'steer',expectedTurnId:'turn-1'});
  assert.equal(f.seen.at(-1).method,'thread-follower-steer-turn');
});
test('changed owner refuses mutation instead of creating another session',async t=>{
  const f=await fixture(t);await f.client.state(ID);f.setOwner('different');
  await assert.rejects(f.client.act(ID,'send',{text:'next'}),/ownership changed/);
  assert.equal(f.seen.filter(m=>m.method==='thread-follower-start-turn').length,0);
});
test('unrelated tasks and incompatible stream versions do not contaminate state',async t=>{
  const f=await fixture(t);await f.client.state(ID);
  const event={type:'broadcast',method:'thread-stream-state-changed',sourceClientId:'owner',version:12,
    params:{hostId:'local',conversationId:'other',change:{type:'snapshot',revision:2,conversationState:sample()}}};
  f.client.receive(event);assert.equal(f.client.tasks.get(ID).state.title,'test');
  event.params.conversationId=ID;f.client.receive(event);
  assert.equal(f.client.tasks.get(ID).state,null);
  assert.match(f.client.tasks.get(ID).error,/version/);
});
test('mutation timeout is never automatically retried',async t=>{
  const f=await fixture(t);await f.client.state(ID);f.setSilent();
  await assert.rejects(f.client.act(ID,'send',{text:'next'}),/outcome unknown/);
  assert.equal(f.seen.filter(m=>m.method==='thread-follower-start-turn').length,1);
});
test('approvals must match a live pending request and stay scoped to one action',async t=>{
  const f=await fixture(t),s=sample();
  s.requests=[{id:7,method:'item/commandExecution/requestApproval',params:{turnId:'turn-1',
      availableDecisions:['accept','acceptForSession','decline','cancel']}},
    {id:'q',method:'item/tool/requestUserInput',params:{questions:[{id:'question'}]}}];f.setState(s);
  await f.client.state(ID);
  await assert.rejects(f.client.act(ID,'reply',{requestId:'missing',decision:'accept'}),/no longer pending/);
  await assert.rejects(f.client.act(ID,'reply',{requestId:7,decision:'accept',expectedTurnId:'stale'}),/turn changed/);
  await f.client.act(ID,'reply',{requestId:7,decision:'acceptForSession',expectedTurnId:'turn-1'});
  assert.deepEqual(f.seen.at(-1).params,{conversationId:ID,requestId:'7',decision:'acceptForSession'});
  await f.client.act(ID,'reply',{requestId:'q',answers:{question:'my answer'}});
  assert.deepEqual(f.seen.at(-1).params.response,{answers:{question:{answers:['my answer']}}});
});

test('structured approvals must exactly match an app-advertised decision',()=>{
  const offered={acceptWithExecpolicyAmendment:{execpolicy_amendment:['git','status']}};
  const request={params:{availableDecisions:[offered,'decline']}};
  assert.deepEqual(validateApprovalDecision(request,structuredClone(offered)),offered);
  assert.throws(()=>validateApprovalDecision(request,
    {acceptWithExecpolicyAmendment:{execpolicy_amendment:['git','push']}}),/not offered/);
  assert.throws(()=>validateApprovalDecision(request,{unexpected:{allow:true}}),/Invalid/);
  assert.throws(()=>validateApprovalDecision({params:{}},'acceptForSession'),/not offered/);
  assert.equal(validateApprovalDecision({params:{}},'accept'),'accept');
});

test('a rejected handshake closes its socket and a later connection can recover',async t=>{
  const f=await fixture(t);f.setDenyInitialize(true);
  await assert.rejects(f.client.state(ID),/unsupported initialization/);
  assert.equal(f.client.socket,null);
  f.setDenyInitialize(false);
  const state=await f.client.state(ID);
  assert.equal(state.threadId,ID);
});
