/* global RLCSDTransport */
"use strict";
const $ = id => document.getElementById(id);
const token = RLCSDTransport.accessToken({promptIfMissing:false});
const rpc = RLCSDTransport.createRpc({apiBase:"/d",token,retryLimit:1});
const uploads = RLCSDTransport.createRpc({apiBase:"/c",token,retryLimit:1});
let active = Number(sessionStorage.getItem("desktopActiveChat") || 0);
let snapshot = null, busy = false, polling = false, requestKey = "", messageKey = "";
let transport = {chunkBytes:6144,concurrency:3,retryLimit:4};
const loadStages={queued:"Đang xếp yêu cầu tải",connecting:"Đang kết nối Codex Desktop",
  cached:"Đang dùng snapshot đã tải",discovering:"Đang tìm tiến trình sở hữu task",
  "loading-history":"Đang yêu cầu toàn bộ lịch sử",
  "receiving-history":"Đang nhận snapshot lịch sử", "waiting-snapshot":"Đang chờ snapshot",
  projecting:"Đang dựng giao diện",complete:"Đã tải xong"};
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function operationId() {
  // crypto.randomUUID is unavailable on an ordinary HTTP tunnel/LAN origin.
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
}
function notice(text="") {$("notice").textContent=text;$("notice").hidden=!text;}
function updateControls() {
  const unavailable=busy || !token;
  $("send").disabled=unavailable || !snapshot;
  $("stop").disabled=unavailable || !snapshot?.activeTurnId;
  $("thread").disabled=unavailable;
  $("linkButton").disabled=unavailable;
  $("files").disabled=unavailable;
  $("mode").disabled=unavailable;
  $("prompt").disabled=unavailable;
  $("reconnect").disabled=unavailable;
  $("logout").disabled=busy;
  document.querySelectorAll("#requests button").forEach(b=>b.disabled=busy);
  document.querySelectorAll("#taskList button").forEach(b=>b.disabled=busy);
}
function setBusy(value) {busy=value;updateControls();}
async function loadTask(payload) {
  const started=await rpc("load/start",payload,{attempts:1});
  while(true) {
    const job=await rpc("load/status",{load_id:started.load_id},{attempts:4});
    if(job.status==="complete") {notice();return job.result;}
    if(job.status==="error") throw new Error(job.error || "Không tải được task");
    const progress=job.progress || {};
    const bytes=progress.totalBytes ? ` · ${Math.round(progress.receivedBytes/1048576)}/${Math.round(progress.totalBytes/1048576)} MiB` : "";
    const percent=Number.isFinite(progress.percent) ? ` · ${progress.percent}%` : "";
    notice(`${loadStages[job.stage] || "Đang tải task"}${percent}${bytes} · ${Math.floor(job.elapsed_seconds)} giây`);
    await wait(750);
  }
}
function textElement(tag,text,className) {
  const element=document.createElement(tag);element.textContent=String(text || "");
  if(className) element.className=className;return element;
}
function renderState(state) {
  snapshot=state;
  $("title").textContent=state.title;
  $("meta").textContent=[state.model,state.cwd,"Desktop · local"].filter(Boolean).join(" · ");
  $("status").textContent=state.status==="running"?"Agent đang chạy":"Sẵn sàng";
  updateControls();
  const next=JSON.stringify(state.messages);
  if(next!==messageKey) {
    const nearBottom=$("messages").scrollHeight-$("messages").scrollTop-$("messages").clientHeight<100;
    const fragment=document.createDocumentFragment();
    for(const message of state.messages) {
      const card=textElement("article","","message "+message.role);
      card.append(textElement("div",message.role+(message.status?" · "+message.status:""),"role"),
        textElement("div",message.text));
      fragment.append(card);
    }
    if(state.historyTruncated) fragment.prepend(textElement("p","Đang hiển thị 600 mục gần nhất.","muted small"));
    $("messages").replaceChildren(fragment);
    if(nearBottom || !messageKey) $("messages").scrollTop=$("messages").scrollHeight;
    messageKey=next;
  }
  const requests=JSON.stringify(state.requests);
  if(requests!==requestKey) {renderRequests(state.requests);requestKey=requests;}
}
async function reply(request,data) {
  if (busy) return;
  setBusy(true);notice();
  try {await rpc("reply",{chat_id:active,requestId:request.id,operation_id:operationId(),...data});await refresh();}
  catch(e){notice(e.message);}finally{setBusy(false);}
}
function renderRequests(requests) {
  $("requests").replaceChildren();
  for(const request of requests) {
    const box=textElement("div","","request");
    box.append(textElement("strong","Task cần bạn trả lời"),textElement("div",request.method,"small"));
    if(["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(request.method)) {
      box.append(textElement("pre",JSON.stringify(request.params,null,2)));
      for(const [label,decision] of [["Cho phép lần này","accept"],["Từ chối","decline"]]) {
        if(request.params?.availableDecisions && !request.params.availableDecisions.includes(decision)) continue;
        const button=textElement("button",label);button.onclick=()=>reply(request,{decision});box.append(button);
      }
    } else if(request.method==="item/tool/requestUserInput") {
      const inputs={};
      for(const question of request.params.questions || []) {
        box.append(textElement("label",question.question || question.header || question.id));
        if(question.options?.length) box.append(textElement("p",question.options.map(o=>o.label+": "+(o.description || "")).join("\n"),"muted small"));
        const input=document.createElement("input");input.type=question.isSecret?"password":"text";
        inputs[question.id]=input;box.append(input);
      }
      const button=textElement("button","Gửi câu trả lời");
      button.onclick=()=>reply(request,{answers:Object.fromEntries(Object.entries(inputs).map(([id,input])=>[id,input.value]))});
      box.append(button);
    } else {
      box.append(textElement("p","Loại yêu cầu này cần trả lời trong app Windows.","muted"));
    }
    $("requests").append(box);
  }
}
async function list() {
  const data=await rpc("list");transport=data.transport;
  $("taskList").replaceChildren();
  for(const chat of data.chats) {
    const button=textElement("button",chat.title,Number(chat.id)===active?"active":"");
    button.disabled=busy;
    button.onclick=async()=>{
      if(busy) return;
      setBusy(true);notice();
      active=Number(chat.id);sessionStorage.setItem("desktopActiveChat",String(active));
      snapshot=null;messageKey="";requestKey="";$("requests").replaceChildren();$("files").value="";$("filesLabel").textContent="";
      updateControls();
      try {await list();await refresh();}
      catch(e) {notice(e.message);}
      finally {setBusy(false);}
    };
    $("taskList").append(button);
  }
  if(!data.chats.length) $("taskList").append(textElement("p","Chưa có task được kết nối.","muted"));
  if(active && !data.chats.some(c=>Number(c.id)===active)) active=0;
}
async function refresh(force=false) {
  if(!active || polling) return;
  polling=true;
  const selected=active;
  try {
    const state=(force || !snapshot)
      ? (await loadTask({chat_id:selected,refresh:force})).state
      : await rpc("state",{chat_id:selected,refresh:false});
    if(selected===active)renderState(state);
  }
  catch(e) {snapshot=null;updateControls();$("status").textContent="Mất kết nối";notice(e.message);}
  finally {polling=false;}
}
$("linkForm").onsubmit=async event=>{
  event.preventDefault();setBusy(true);notice();
  try {
    const data=await loadTask({thread:$("thread").value});
    active=data.chat_id;sessionStorage.setItem("desktopActiveChat",String(active));
    messageKey="";requestKey="";renderState(data.state);
    $("files").value="";$("filesLabel").textContent="";await list();
  }catch(e){notice(e.message);}finally{setBusy(false);}
};
$("linkButton").onclick=()=>$("linkForm").requestSubmit();
$("reconnect").onclick=async()=>{
  if(busy)return;
  setBusy(true);notice();
  try {await refresh(true);} finally {setBusy(false);}
};
$("files").onchange=()=>{
  const files=Array.from($("files").files);
  if(files.some(f=>f.size>8*1024*1024)) {$("files").value="";notice("Giới hạn mỗi file là 8 MB.");}
  $("filesLabel").textContent=Array.from($("files").files).map(f=>f.name).join(", ");
};
$("composer").onsubmit=async event=>{
  event.preventDefault();
  if(busy || !snapshot) return;
  const chatId=active, mode=$("mode").value, expectedTurnId=snapshot.activeTurnId;
  const text=$("prompt").value.trim(), files=Array.from($("files").files);
  if(!text && !files.length) return;
  if(snapshot.status==="running" && mode!=="steer"){notice("Task đang chạy. Chọn gửi chỉ dẫn hoặc chờ lượt này kết thúc.");return;}
  if(mode==="steer" && !expectedTurnId){notice("Không có lượt đang chạy để gửi chỉ dẫn.");return;}
  setBusy(true);notice();
  const operation_id=operationId();
  let submissionStarted=false;
  try {
    const attachment_ids=[];
    for(const file of files) {
      const uploaded=await RLCSDTransport.uploadBlob({rpc:uploads,blob:file,...transport,
        chunkBytes:transport.chunkBytes,paths:{start:"attachment/start",chunk:"attachment/chunk",status:"attachment/status",finish:"attachment/finish"},
        startPayload:{chat_id:chatId,filename:file.name,mime_type:file.type}});
      attachment_ids.push(uploaded.attachment.id);
    }
    const sendData={chat_id:chatId,mode,expectedTurnId,operation_id,attachment_ids};
    const promptRpc=(path,payload,options)=>{
      if(path==="prompt/finish") {submissionStarted=true;return rpc(path,{...sendData,...payload},{attempts:1});}
      return uploads(path,payload,options);
    };
    await RLCSDTransport.uploadBlob({rpc:promptRpc,blob:new Blob([text]),...transport,
      chunkBytes:transport.chunkBytes,paths:{start:"prompt/start",chunk:"prompt/chunk",status:"prompt/status",finish:"prompt/finish"},
      startPayload:{chat_id:chatId,attachment_ids}});
    $("prompt").value="";$("files").value="";$("filesLabel").textContent="";
    await refresh();
  } catch(e) {
    notice(e.message+(submissionStarted?"\nNếu kết quả gửi chưa rõ, hãy kiểm tra hội thoại trước khi gửi lại.":""));
  } finally {setBusy(false);}
};
$("prompt").onkeydown=event=>{if((event.ctrlKey || event.metaKey)&&event.key==="Enter"){event.preventDefault();$("composer").requestSubmit();}};
$("stop").onclick=async()=>{
  if(!snapshot?.activeTurnId || busy)return;
  setBusy(true);notice();
  try {await rpc("cancel",{chat_id:active,expectedTurnId:snapshot.activeTurnId,operation_id:operationId()});await refresh();}
  catch(e){notice(e.message);}finally{setBusy(false);}
};
$("logout").onclick=()=>{
  sessionStorage.removeItem("tunnelChatToken");localStorage.removeItem("fixChatToken");location.reload();
};
(async()=>{
  if(!token) {
    notice("Phiên trình duyệt này chưa có token Codex. Hãy mở lại bằng launcher Codex trên máy cá nhân hoặc dùng liên kết xác thực do launcher tạo.");
    updateControls();
    return;
  }
  try {await list();await refresh();}catch(e){notice(e.message);}
  // The bridge consumes live IPC patches; browsers poll its bounded projection.
  // No model call or history reload is performed by an ordinary poll.
  const timer=setInterval(()=>{if(!busy)refresh();},1500);
  window.addEventListener("beforeunload",()=>clearInterval(timer));
})();
