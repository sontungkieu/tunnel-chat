'use strict';
// Independently implemented client for the desktop app's local follower protocol.
// Experimental: validated with app 26.901.1978.0, stream schema version 11.
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const MAX_FRAME = 128 * 1024 * 1024;
const MAX_PROJECTED_MESSAGES = 600;
const VERSIONS = {'initialize':0, 'thread-owner-discovery':1,
  'thread-follower-load-complete-history':1, 'thread-follower-start-turn':2,
  'thread-follower-steer-turn':1, 'thread-follower-interrupt-turn':4,
  'thread-follower-command-approval-decision':1, 'thread-follower-file-approval-decision':1,
  'thread-follower-submit-user-input':1};
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME) throw Error('IPC frame exceeds limit');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
class Decoder {
  constructor(onMessage, onProgress=()=>{}) {
    this.chunks=[]; this.length=0; this.expected=null;
    this.onMessage=onMessage; this.onProgress=onProgress;
  }
  take(size) {
    if (size > this.length) throw Error('Incomplete IPC frame');
    const output=Buffer.allocUnsafe(size);let offset=0;
    while(offset<size) {
      const chunk=this.chunks[0],count=Math.min(chunk.length,size-offset);
      chunk.copy(output,offset,0,count);offset+=count;this.length-=count;
      if(count===chunk.length)this.chunks.shift();else this.chunks[0]=chunk.subarray(count);
    }
    return output;
  }
  push(chunk) {
    if (!Buffer.isBuffer(chunk) || !chunk.length) return;
    this.chunks.push(chunk);this.length+=chunk.length;
    while (true) {
      if(this.expected===null) {
        if(this.length<4)return;
        const size=this.take(4).readUInt32LE();
        if(size<2 || size>MAX_FRAME)throw Error(`Unsupported IPC frame size: ${size} bytes`);
        this.expected=size;
      }
      const received=Math.min(this.length,this.expected);
      this.onProgress({receivedBytes:received,totalBytes:this.expected});
      if(this.length<this.expected)return;
      const message=JSON.parse(this.take(this.expected).toString('utf8'));
      this.expected=null;this.onMessage(message);
    }
  }
}
function applyPatches(state, patches) {
  // Work on a copy: a bad patch must not leave a partly applied state.
  let next = structuredClone(state);
  for (const patch of patches) {
    const keys = patch.path;
    if (!Array.isArray(keys) || keys.some(k => ['__proto__','prototype','constructor'].includes(String(k))))
      throw Error('Unsupported patch path');
    if (!['add','remove','replace'].includes(patch.op)) throw Error('Unsupported patch operation');
    if (!keys.length) {
      if (patch.op === 'remove') throw Error('Cannot remove root');
      next = structuredClone(patch.value); continue;
    }
    let target = next;
    for (const key of keys.slice(0,-1)) {
      if (!target || !Object.hasOwn(target,key)) throw Error('Missing patch parent');
      target = target[key];
    }
    const key = keys.at(-1);
    if (!target || typeof target !== 'object') throw Error('Invalid patch parent');
    if (Array.isArray(target)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i > target.length || (patch.op !== 'add' && i === target.length))
        throw Error('Invalid array patch');
      if (patch.op === 'add') target.splice(i,0,structuredClone(patch.value));
      else if (patch.op === 'remove') target.splice(i,1);
      else target[i] = structuredClone(patch.value);
    } else {
      if (patch.op !== 'add' && !Object.hasOwn(target,key)) throw Error('Missing patch key');
      if (patch.op === 'remove') delete target[key]; else target[key] = structuredClone(patch.value);
    }
  }
  return next;
}
function turnsOf(state) {
  const h = state.turnHistory;
  if (h?.kind === 'canonical') {
    const history = h.history;
    if (!history || !Array.isArray(history.islands)) throw Error('Unsupported desktop history schema');
    return history.islands.flatMap(island => island.entries.map(entry => history.entitiesByKey[entry.value]).filter(Boolean));
  }
  if (Array.isArray(state.turns)) return state.turns;
  throw Error('Unsupported desktop history schema');
}
function textInput(input) {
  return (Array.isArray(input) ? input : []).filter(i=>i.type==='text').map(i=>i.text || '').join('\n');
}
function projectState(state, revision) {
  if (!state || typeof state.id !== 'string') throw Error('Unsupported desktop state');
  const turns = turnsOf(state);
  const messages = [];let messageCount=0;
  const addMessage=message=>{
    messageCount+=1;
    if(messages.length===MAX_PROJECTED_MESSAGES)messages.shift();
    messages.push(message);
  };
  for (const turn of turns) {
    const user = textInput(turn.params?.input);
    if (user) addMessage({id:turn.turnId+':user',role:'user',text:user});
    for (const item of turn.items || []) {
      // Do not export reasoning, ambient context, configuration, or arbitrary tool payloads.
      if (item.type === 'agentMessage' || item.type === 'assistantMessage')
        addMessage({id:item.id,role:'assistant',text:item.text || '',phase:item.phase || ''});
      else if (item.type === 'steeringUserMessage' || item.type === 'userMessage') {
        const text = item.text || textInput(item.content || item.input);
        if (text) addMessage({id:item.id,role:'user',text});
      } else if (item.type === 'commandExecution')
        addMessage({id:item.id,role:'tool',text:String(item.command || ''),status:item.status});
      else if (item.type === 'fileChange')
        addMessage({id:item.id,role:'tool',text:'File changes',status:item.status});
    }
  }
  const active = [...turns].reverse().find(t=>t.status==='inProgress');
  const running = state.threadRuntimeStatus?.type === 'active' ||
    (!!active && state.threadRuntimeStatus?.type !== 'idle');
  return {threadId:state.id,title:state.title || state.generatedTitle || state.id,
    cwd:state.cwd || '',backend:'desktop',hostId:'local',
    model:state.latestModel || '',status:running?'running':'idle',
    activeTurnId:running ? active?.turnId || null : null,revision,
    messages,
    requests:(state.requests || []).map(r=>({id:r.id,method:r.method,params:r.params})),
    historyTruncated:messageCount>MAX_PROJECTED_MESSAGES};
}
class DesktopClient extends EventEmitter {
  constructor({socketFactory=()=>net.createConnection('\\\\.\\pipe\\codex-ipc'),timeout=15000,
    historyTimeout=180000,snapshotTimeout=30000}={}) {
    super(); this.socketFactory=socketFactory; this.timeout=timeout;
    this.historyTimeout=historyTimeout;this.snapshotTimeout=snapshotTimeout;
    this.pending=new Map(); this.tasks=new Map(); this.connecting=null; this.socket=null; this.clientId=null;
  }
  async connect() {
    if (this.clientId) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { await this.connecting; }
    catch (error) { this.disconnect(error); throw error; }
    finally { this.connecting=null; }
  }
  async open() {
    const socket=this.socketFactory(); this.socket=socket;
    const decoder=new Decoder(m=>this.receive(m),progress=>this.emit('frame-progress',progress));
    socket.on('data',c=>{try {decoder.push(c);} catch(e) {this.disconnect(e);}});
    socket.on('error',e=>{if(this.socket===socket)this.disconnect(Error('Desktop IPC unavailable: '+e.message));});
    socket.on('close',()=>{if(this.socket===socket)this.disconnect(Error('Desktop app disconnected'));});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.destroy();reject(Error('Desktop connection timed out'));},5000);
      socket.once('connect',()=>{clearTimeout(timer);resolve();});
      socket.once('error',e=>{clearTimeout(timer);reject(e);});
    });
    const response=await this.request('initialize',{clientType:'tunnel-chat'});
    if (typeof response.result?.clientId !== 'string') throw Error('Unsupported desktop handshake');
    this.clientId=response.result.clientId;
  }
  disconnect(error) {
    const socket=this.socket; this.socket=null; this.clientId=null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const {reject,timer} of this.pending.values()) {clearTimeout(timer);reject(error);}
    this.pending.clear();
    for (const task of this.tasks.values()) {task.error=error.message;task.state=null;}
    this.tasks.clear();
    this.emit('change');
  }
  send(message) {
    if (!this.socket || this.socket.destroyed) throw Error('Desktop app is disconnected');
    this.socket.write(frame(message));
  }
  request(method, params, targetClientId, timeout=this.timeout) {
    if (!(method in VERSIONS)) return Promise.reject(Error('Unsupported desktop method'));
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(requestId);
        reject(Error('Desktop request timed out; outcome unknown. Refresh before resending.'));
      },timeout+1000);
      this.pending.set(requestId,{resolve,reject,timer});
      try { this.send({type:'request',requestId,sourceClientId:this.clientId || undefined,
        version:VERSIONS[method],method,params,targetClientId,timeoutMs:timeout}); }
      catch(e) {clearTimeout(timer);this.pending.delete(requestId);reject(e);}
    });
  }
  following(id, owner, following=true) {
    this.send({type:'broadcast',sourceClientId:this.clientId,version:1,
      method:'thread-stream-following-changed',
      params:{conversationId:id,hostId:'local',following,targetClientIds:[owner]}});
  }
  receive(m) {
    if (m.type==='response') {
      const pending=this.pending.get(m.requestId); if (!pending) return;
      this.pending.delete(m.requestId);clearTimeout(pending.timer);
      if (m.resultType==='success') pending.resolve(m);
      else pending.reject(Error(String(m.error || 'Desktop rejected request')));
      return;
    }
    if (m.type==='client-discovery-request') {
      this.send({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});return;
    }
    if (m.type!=='broadcast') return;
    const p=m.params || {},task=this.tasks.get(p.conversationId);
    if (!task || p.hostId!=='local') return;
    if (m.method==='thread-stream-following-status-requested') {
      this.following(p.conversationId,task.owner);return;
    }
    if (m.method!=='thread-stream-state-changed' || m.sourceClientId!==task.owner) return;
    if (p.targetClientIds && !p.targetClientIds.includes(this.clientId)) return;
    try {
      if (m.version!==11) throw Error('Unsupported desktop stream version; update Tunnel Chat');
      const change=p.change;
      if (change.type==='snapshot') {
        if (change.conversationState?.id!==p.conversationId) throw Error('Desktop snapshot task mismatch');
        task.state=change.conversationState;
      } else if (change.type==='patches') {
        if (!task.state || change.baseRevision!==task.revision) throw Error('Desktop stream revision gap; reconnect');
        task.state=applyPatches(task.state,change.patches);
      } else throw Error('Unsupported desktop change');
      task.revision=change.revision;task.error=null;
    } catch(e) {task.state=null;task.error=e.message;}
    this.emit('change',p.conversationId);
  }
  async watch(id, refresh=false, onProgress=()=>{}) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid task ID');
    onProgress({stage:'connecting'});
    await this.connect();
    let task=this.tasks.get(id);
    if (task?.state && !refresh) {onProgress({stage:'cached'});return task;}
    if (task) this.following(id,task.owner,false);
    onProgress({stage:'discovering'});
    const discovery=await this.request('thread-owner-discovery',{hostId:'local',conversationId:id});
    const owner=discovery.handledByClientId;
    if (!owner || discovery.result?.supportsUntrustedAppInput!==true)
      throw Error('Desktop task owner does not support this client. Open the task in the Windows app.');
    task={owner,state:null,revision:0,error:null};this.tasks.set(id,task);
    this.following(id,owner);
    let lastProgress=0;
    const frameProgress=progress=>{
      if(progress.totalBytes<1024*1024)return;
      const now=Date.now();
      if(progress.receivedBytes<progress.totalBytes && now-lastProgress<200)return;
      lastProgress=now;onProgress({stage:'receiving-history',...progress,
        percent:Math.min(100,Math.floor(progress.receivedBytes*100/progress.totalBytes))});
    };
    this.on('frame-progress',frameProgress);
    try {
      onProgress({stage:'loading-history'});
      await this.request('thread-follower-load-complete-history',{conversationId:id},owner,this.historyTimeout);
      if (!task.state) {
        onProgress({stage:'waiting-snapshot'});
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{this.off('change',check);reject(Error(task.error || 'No desktop snapshot received'));},this.snapshotTimeout);
          const check=()=>{if(task.state || task.error){clearTimeout(timer);this.off('change',check);resolve();}};
          this.on('change',check);check();
        });
      }
    } finally {this.off('frame-progress',frameProgress);}
    if (!task.state) throw Error(task.error || 'Desktop snapshot unavailable');
    return task;
  }
  async state(id, refresh=false, onProgress=()=>{}) {
    const task=await this.watch(id,refresh,onProgress);onProgress({stage:'projecting'});
    return projectState(task.state,task.revision);
  }
  async act(id, action, data) {
    const task=await this.watch(id);
    // Rediscover ownership before every mutation. Never replay a mutation after failure.
    const discovery=await this.request('thread-owner-discovery',{hostId:'local',conversationId:id});
    if (discovery.handledByClientId!==task.owner || discovery.result?.supportsUntrustedAppInput!==true)
      throw Error('Desktop ownership changed. Reconnect before sending.');
    if (!task.state) throw Error('Desktop state changed; reconnect before sending.');
    const snapshot=projectState(task.state,task.revision);
    let method,params={conversationId:id};
    if (action==='send') {
      if (snapshot.status==='running' && data.mode!=='steer') throw Error('Task is running; choose steer or wait.');
      if (snapshot.status!=='running' && data.mode==='steer') throw Error('Turn finished; refresh and send a new turn.');
      if (snapshot.status==='running' && data.expectedTurnId!==snapshot.activeTurnId)
        throw Error('Active turn changed; refresh before steering.');
      const input=[{type:'text',text:String(data.text || ''),text_elements:[]}];
      if (!input[0].text.trim()) throw Error('Empty message');
      for (const image of data.images || []) {
        if (!path.win32.isAbsolute(image)) throw Error('Image must have a Windows absolute path');
        input.push({type:'localImage',path:image});
      }
      if (data.mode==='steer') {
        method='thread-follower-steer-turn';
        params={...params,input,attachments:[],restoreMessage:{id:crypto.randomUUID(),text:data.text,
          cwd:snapshot.cwd,createdAt:Date.now(),context:{prompt:data.text,addedFiles:[],fileAttachments:[],
            imageAttachments:[],ideContext:null,workspaceRoots:[snapshot.cwd]}}};
      } else {
        method='thread-follower-start-turn';
        params.turnStart={request:{threadId:id,input},context:{inheritThreadSettings:true}};
      }
    } else if (action==='cancel') {
      if (!snapshot.activeTurnId || data.expectedTurnId!==snapshot.activeTurnId) throw Error('Active turn changed; refresh before stopping.');
      method='thread-follower-interrupt-turn';
      Object.assign(params,{expectedTurnId:data.expectedTurnId,mode:'user-stop'});
    } else if (action==='reply') {
      const req=snapshot.requests.find(r=>String(r.id)===String(data.requestId));
      if (!req) throw Error('Request is no longer pending');
      params.requestId=String(req.id);
      const approval={'item/commandExecution/requestApproval':'thread-follower-command-approval-decision',
        'item/fileChange/requestApproval':'thread-follower-file-approval-decision'};
      if (approval[req.method]) {
        if (!['accept','decline'].includes(data.decision)) throw Error('Invalid approval decision');
        if (req.params?.availableDecisions && !req.params.availableDecisions.includes(data.decision))
          throw Error('Decision is not offered by the app');
        method=approval[req.method];params.decision=data.decision;
      } else if (req.method==='item/tool/requestUserInput') {
        const answers={};
        for (const question of req.params.questions || []) {
          const answer=data.answers?.[question.id];
          if (typeof answer!=='string' || !answer.trim()) throw Error('Answer every question');
          answers[question.id]={answers:[answer]};
        }
        method='thread-follower-submit-user-input';params.response={answers};
      } else throw Error('Answer this request in the desktop app.');
    } else throw Error('Unknown desktop action');
    await this.request(method,params,task.owner);
    return {ok:true};
  }
  close() { this.disconnect(Error('Bridge stopped')); }
}
function stageAttachment({source,filename,stagingRoot}) {
  if (process.platform!=='win32') throw Error('Attachment staging requires Windows');
  const root=path.win32.resolve(stagingRoot || 'D:\\dev\\codex\\tunnel-chat\\attachments');
  if (!/^[D-Z]:\\/i.test(root) || root.split('\\').length<4) throw Error('Configure a dedicated staging directory on D: or another data drive');
  if (!fs.existsSync(path.win32.parse(root).root)) throw Error('Attachment staging drive is unavailable');
  const safe=path.win32.basename(filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100) || 'attachment';
  const dir=path.win32.join(root,crypto.randomUUID());
  fs.mkdirSync(dir,{recursive:true});
  const destination=path.win32.join(dir,'file-'+safe);
  try {fs.copyFileSync(source,destination);} catch(e) {fs.rmSync(dir,{recursive:true});throw e;}
  return {windowsPath:destination,wslPath:'/mnt/'+destination[0].toLowerCase()+destination.slice(2).replace(/\\/g,'/')};
}
async function main() {
  const client=new DesktopClient();
  const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  let chain=Promise.resolve();
  lines.on('line',line=>{
    chain=chain.then(async()=>{
      let command;
      try {
        if (line.length>16*1024*1024) throw Error('Bridge command too large');
        command=JSON.parse(line);let result;
        if (command.action==='stage') result=stageAttachment(command.data);
        else if (command.action==='state') result=await client.state(command.threadId,!!command.refresh,
          progress=>process.stdout.write(JSON.stringify({id:command.id,progress})+'\n'));
        else result=await client.act(command.threadId,command.action,command.data || {});
        process.stdout.write(JSON.stringify({id:command.id,result})+'\n');
      } catch(e) {process.stdout.write(JSON.stringify({id:command?.id,error:e.message})+'\n');}
    });
  });
  lines.on('close',()=>{chain.finally(()=>{client.close();process.stdout.end();});});
}
module.exports={Decoder,frame,applyPatches,turnsOf,projectState,DesktopClient,stageAttachment};
if (require.main===module) main().catch(()=>process.exit(1));
