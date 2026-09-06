/* global RLCSDTransport */
"use strict";
const $ = id => document.getElementById(id);
const token = RLCSDTransport.accessToken({promptIfMissing:false});
const rpc = RLCSDTransport.createRpc({apiBase:"/d",token,retryLimit:1});
const uploads = RLCSDTransport.createRpc({apiBase:"/c",token,retryLimit:1});
let active = Number(sessionStorage.getItem("desktopActiveChat") || 0);
let snapshot = null, busy = false, polling = false, requestKey = "", messageKey = "";
let messageImageUrls = [], imageRenderRevision = 0;
let collapsedProjects = new Set();
try {collapsedProjects=new Set(JSON.parse(sessionStorage.getItem("desktopCollapsedProjects") || "[]"));} catch(_error) {}
let transport = {chunkBytes:6144,concurrency:3,retryLimit:4};
const loadStages={queued:"Đang xếp yêu cầu tải",connecting:"Đang kết nối Codex Desktop",
  cached:"Đang dùng snapshot đã tải",discovering:"Đang tìm tiến trình sở hữu task",
  "loading-history":"Đang yêu cầu toàn bộ lịch sử",
  "receiving-history":"Đang nhận snapshot lịch sử", "waiting-snapshot":"Đang chờ snapshot",
  projecting:"Đang dựng giao diện",complete:"Đã tải xong"};
const activityLabels={thinking:"Đang suy nghĩ",tool:"Đang chạy công cụ",waiting:"Đang chờ bạn",
  finalizing:"Đang hoàn tất câu trả lời",working:"Agent đang làm việc",completed:"Đã trả lời xong",
  interrupted:"Đã dừng",failed:"Có lỗi",idle:"Sẵn sàng"};
const activityDetails={thinking:"Agent đang xử lý yêu cầu. Nội dung suy luận chi tiết được giữ trong Codex Desktop.",
  tool:"Một công cụ đang chạy. Mở khối công cụ trong hội thoại để xem lệnh và trạng thái.",
  waiting:"Task đang chờ bạn trả lời một câu hỏi hoặc yêu cầu phê duyệt.",
  finalizing:"Agent đang chuẩn bị phần trả lời cuối cùng.",working:"Agent đang tiếp tục lượt hiện tại.",
  completed:"Lượt gần nhất đã hoàn tất.",interrupted:"Lượt gần nhất đã dừng.",failed:"Lượt gần nhất gặp lỗi.",
  idle:"Task đã kết nối và sẵn sàng nhận tin nhắn."};
const toolStatusLabels={inprogress:"Đang chạy",completed:"Hoàn tất",failed:"Thất bại",declined:"Đã từ chối",
  cancelled:"Đã dừng",canceled:"Đã dừng",interrupted:"Đã dừng"};
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function applyTheme(theme) {
  const selected=theme==="light"?"light":"dark";
  document.documentElement.dataset.theme=selected;
  localStorage.setItem("tunnelChatTheme",selected);
  $("themeIcon").textContent=selected==="dark"?"☀":"☾";
  $("themeToggle").title=selected==="dark"?"Chuyển sang giao diện sáng":"Chuyển sang giao diện tối";
  $("themeToggle").setAttribute("aria-label",$("themeToggle").title);
}
applyTheme(document.documentElement.dataset.theme || "dark");
$("themeToggle").onclick=()=>applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark");
$("codexMode").onchange=event=>location.assign(event.target.value);
const mobileLayout=matchMedia("(max-width: 760px), (max-height: 520px) and (max-width: 960px)");
function setSidebar(open) {
  const wasOpen=document.body.classList.contains("sidebar-open");
  const compact=mobileLayout.matches,sidebar=$("sidebar");
  document.body.classList.toggle("sidebar-open",open);
  $("sidebarToggle").setAttribute("aria-expanded",String(open));
  document.querySelector("main").inert=open && compact;
  sidebar.inert=compact && !open;
  if(compact && !open)sidebar.setAttribute("aria-hidden","true");else sidebar.removeAttribute("aria-hidden");
  if(open)$("sidebarClose").focus();
  else if(wasOpen && compact)$("sidebarToggle").focus();
}
$("sidebarToggle").onclick=()=>setSidebar(!document.body.classList.contains("sidebar-open"));
$("sidebarClose").onclick=()=>setSidebar(false);
$("sidebarBackdrop").onclick=()=>setSidebar(false);
document.addEventListener("keydown",event=>{if(event.key==="Escape")setSidebar(false);});
mobileLayout.addEventListener?.("change",event=>{if(!event.matches)setSidebar(false);});
setSidebar(false);
if(mobileLayout.matches)$("activityPanel").open=false;
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
function enhanceRichText(content) {
  content.querySelectorAll("a").forEach(link=>{link.target="_blank";link.rel="noopener noreferrer";});
  content.querySelectorAll("img").forEach(image=>{image.loading="lazy";image.referrerPolicy="no-referrer";});
  content.querySelectorAll("pre").forEach(pre=>{
    const code=pre.querySelector("code");
    if(!code || pre.parentElement?.classList.contains("code-block"))return;
    const language=Array.from(code.classList).find(name=>name.startsWith("language-"))?.slice(9) || "text";
    const block=textElement("div","","code-block"),toolbar=textElement("div","","code-toolbar");
    const copy=textElement("button","Sao chép","copy-code");copy.type="button";
    copy.onclick=async()=>{
      try {await navigator.clipboard.writeText(code.textContent || "");copy.textContent="Đã chép";}
      catch(_error) {copy.textContent="Không chép được";}
      setTimeout(()=>{if(copy.isConnected)copy.textContent="Sao chép";},1400);
    };
    toolbar.append(textElement("span",language),copy);
    pre.replaceWith(block);block.append(toolbar,pre);
  });
}
function richTextElement(source) {
  const content=textElement("div","","rich-text");
  try {
    const rendered=window.TunnelRichText?.renderMarkdown(source);
    if(rendered===null || rendered===undefined)throw new Error("rich text renderer unavailable");
    // Raw source HTML is disabled in TunnelRichText; generated markup comes from markdown-it and KaTeX.
    content.innerHTML=rendered;enhanceRichText(content);
  } catch(_error) {content.textContent=String(source || "");content.classList.add("rich-text-fallback");}
  return content;
}
function projectForChat(chat) {
  const path=String(chat.repo_path || "").replace(/[\\/]+$/,"");
  return {key:path.toLocaleLowerCase() || "__unknown__",
    name:path.split(/[\\/]/).filter(Boolean).at(-1) || "Chưa xác định",path};
}
function rememberProjectGroups() {
  sessionStorage.setItem("desktopCollapsedProjects",JSON.stringify(Array.from(collapsedProjects)));
}
function releaseMessageImages() {
  for(const url of messageImageUrls) URL.revokeObjectURL(url);
  messageImageUrls=[];
}
async function loadMessageImage(element,caption,image,chatId,revision) {
  try {
    const query=new URLSearchParams({chat_id:String(chatId),image_id:String(image.id || "")});
    const response=await fetch(`/d/image?${query}`,{cache:"no-store",headers:{"x-chat-token":token}});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const url=URL.createObjectURL(await response.blob());
    if(revision!==imageRenderRevision || !element.isConnected) {URL.revokeObjectURL(url);return;}
    element.src=url;messageImageUrls.push(url);
  } catch(_error) {
    if(revision===imageRenderRevision && caption.isConnected)caption.textContent=`${image.name || "Ảnh"} · không tải được`;
  }
}
function updateActivity(activity,label) {
  const panel=$("activityPanel"),next=activity || "idle";
  panel.dataset.activity=next;
  $("status").textContent=label || activityLabels[next] || "Sẵn sàng";
  $("activityDetail").textContent=activityDetails[next] || activityDetails.idle;
}
function toolCard(message) {
  const status=String(message.status || "").toLowerCase();
  const details=textElement("details","","message tool");details.dataset.status=status || "unknown";
  details.open=!["completed","declined","cancelled","canceled","interrupted"].includes(status);
  const summary=document.createElement("summary"),icon=textElement("span",">_","tool-icon");
  const heading=textElement("span","","tool-heading");
  const preview=String(message.text || "").replace(/\s+/g," ").trim();
  heading.append(textElement("span",status==="inprogress"?"Công cụ đang chạy":"Hoạt động công cụ","tool-title"),
    textElement("span",preview || "Không có chi tiết","tool-preview"));
  summary.append(icon,heading,textElement("span",toolStatusLabels[status] || status || "Chi tiết","tool-status"));
  details.append(summary,textElement("pre",message.text || "Không có nội dung bổ sung."));
  return details;
}
function renderState(state) {
  snapshot=state;
  $("title").textContent=state.title;
  const project=state.project || (state.cwd || "").replace(/[\\/]+$/,"").split(/[\\/]/).at(-1);
  $("meta").textContent=[project?`Project: ${project}`:"Project: chưa xác định",state.model,state.cwd,"Desktop · local"].filter(Boolean).join(" · ");
  updateActivity(state.activity || state.status,
    activityLabels[state.activity] || (state.status==="running"?"Agent đang làm việc":"Sẵn sàng"));
  updateControls();
  const next=JSON.stringify(state.messages);
  if(next!==messageKey) {
    releaseMessageImages();
    const revision=++imageRenderRevision,chatId=active;
    const nearBottom=$("messages").scrollHeight-$("messages").scrollTop-$("messages").clientHeight<100;
    const fragment=document.createDocumentFragment();
    for(const message of state.messages) {
      if(message.role==="tool") {fragment.append(toolCard(message));continue;}
      const card=textElement("article","","message "+message.role);
      card.append(textElement("div",message.role==="user"?"Bạn":"Codex","role"));
      if(message.text)card.append(richTextElement(message.text));
      if(Array.isArray(message.images) && message.images.length) {
        const gallery=textElement("div","","message-images");
        for(const image of message.images) {
          const figure=document.createElement("figure"),element=document.createElement("img");
          element.className="message-image";element.loading="lazy";element.alt=image.name || "Ảnh đính kèm";
          const caption=textElement("figcaption",image.name || "Ảnh đính kèm");
          figure.append(element,caption);gallery.append(figure);
          void loadMessageImage(element,caption,image,chatId,revision);
        }
        card.append(gallery);
      }
      fragment.append(card);
    }
    if(state.historyTruncated) fragment.prepend(textElement("p","Đang hiển thị 600 mục gần nhất.","history-note"));
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
function approvalDecisionKind(decision) {
  if(typeof decision==="string" && ["accept","acceptForSession","decline","cancel"].includes(decision))return decision;
  if(!decision || Array.isArray(decision) || typeof decision!=="object")return "";
  const keys=Object.keys(decision);
  return keys.length===1 && ["acceptWithExecpolicyAmendment","applyNetworkPolicyAmendment"].includes(keys[0])
    && decision[keys[0]] && typeof decision[keys[0]]==="object" ? keys[0] : "";
}
const approvalLabels={accept:"Cho phép lần này",acceptForSession:"Cho phép trong phiên",
  decline:"Từ chối, tiếp tục",cancel:"Hủy lượt",
  acceptWithExecpolicyAmendment:"Cho phép và nhớ tiền tố lệnh",
  applyNetworkPolicyAmendment:"Cho phép host theo quy tắc"};
const approvalNotes={accept:"Chỉ áp dụng cho yêu cầu này.",
  acceptForSession:"Codex có thể tái dùng quyền tương ứng đến hết phiên hiện tại.",
  decline:"Không thực hiện hành động này; task có thể tiếp tục theo cách khác.",
  cancel:"Dừng lượt hiện tại.",
  acceptWithExecpolicyAmendment:"Cho phép và lưu đúng quy tắc lệnh do Codex Desktop đề xuất.",
  applyNetworkPolicyAmendment:"Cho phép và lưu đúng quy tắc mạng do Codex Desktop đề xuất."};
function approvalSummary(request) {
  const params=request.params || {},lines=[];
  const command=params.command || params.cmd;
  if(command)lines.push(`Lệnh: ${Array.isArray(command)?command.join(" "):command}`);
  if(params.cwd)lines.push(`Thư mục: ${params.cwd}`);
  if(params.reason)lines.push(`Lý do: ${params.reason}`);
  if(params.host)lines.push(`Host: ${params.host}`);
  if(params.networkApprovalContext?.host)lines.push(`Host: ${params.networkApprovalContext.host}`);
  if(params.changes)lines.push(`Thay đổi file: ${typeof params.changes==="string"?params.changes:JSON.stringify(params.changes,null,2)}`);
  return lines.join("\n") || "Codex Desktop yêu cầu bạn quyết định trước khi tiếp tục.";
}
function renderRequests(requests) {
  $("requests").replaceChildren();
  for(const request of requests) {
    const box=textElement("div","","request");
    box.append(textElement("strong","Task cần bạn trả lời"),textElement("div",request.method,"small muted"));
    if(["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(request.method)) {
      const type=request.params?.kind==="writeStdin"?"Yêu cầu gửi dữ liệu vào terminal"
        :request.method.includes("commandExecution")?"Yêu cầu chạy lệnh":"Yêu cầu sửa file";
      box.append(textElement("div",type,"approval-title"),textElement("pre",approvalSummary(request),"approval-summary"));
      const details=document.createElement("details"),summary=document.createElement("summary");
      summary.textContent="Xem dữ liệu đầy đủ";
      details.append(summary,textElement("pre",JSON.stringify(request.params,null,2)));box.append(details);
      const offered=Array.isArray(request.params?.availableDecisions)
        ? request.params.availableDecisions : ["accept","decline"];
      const actions=textElement("div","","approval-actions");
      for(const decision of offered) {
        const kind=approvalDecisionKind(decision);if(!kind)continue;
        const choice=textElement("div","","approval-choice"),button=textElement("button",approvalLabels[kind] || kind);
        if(["decline","cancel"].includes(kind))button.classList.add("danger");
        else if(kind!=="accept")button.classList.add("secondary");
        button.onclick=()=>reply(request,{decision,expectedTurnId:request.params?.turnId || snapshot?.activeTurnId || null});
        choice.append(button,textElement("span",approvalNotes[kind] || "","approval-choice-note"));actions.append(choice);
      }
      if(!actions.children.length)actions.append(textElement("p","Codex Desktop chưa cung cấp lựa chọn có thể gửi từ web.","muted"));
      box.append(actions);
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
  const groups=new Map();
  for(const chat of data.chats) {
    const project=projectForChat(chat);
    if(!groups.has(project.key))groups.set(project.key,{...project,chats:[]});
    groups.get(project.key).chats.push(chat);
  }
  const ordered=Array.from(groups.values()).sort((a,b)=>a.name.localeCompare(b.name,"vi",{sensitivity:"base"}));
  for(const group of ordered) {
    const details=textElement("details","","project-group");
    details.open=!collapsedProjects.has(group.key);
    const summary=document.createElement("summary");summary.title=group.path || "Project chưa xác định";
    summary.append(textElement("span",group.name,"project-name"),textElement("span",group.chats.length,"project-count"));
    const tasks=textElement("div","","project-tasks");
    for(const chat of group.chats) {
      const button=textElement("button",chat.title,Number(chat.id)===active?"active":"");
      button.disabled=busy;button.title=chat.title;
      button.onclick=async()=>{
        if(busy) return;
        setSidebar(false);
        setBusy(true);notice();
        active=Number(chat.id);sessionStorage.setItem("desktopActiveChat",String(active));
        snapshot=null;messageKey="";requestKey="";$("requests").replaceChildren();$("files").value="";$("filesLabel").textContent="";
        updateControls();
        try {await list();await refresh();}
        catch(e) {notice(e.message);}
        finally {setBusy(false);}
      };
      tasks.append(button);
    }
    details.append(summary,tasks);
    details.ontoggle=()=>{details.open?collapsedProjects.delete(group.key):collapsedProjects.add(group.key);rememberProjectGroups();};
    $("taskList").append(details);
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
  catch(e) {snapshot=null;updateControls();updateActivity("failed","Mất kết nối");notice(e.message);}
  finally {polling=false;}
}
$("linkForm").onsubmit=async event=>{
  event.preventDefault();setBusy(true);notice();
  try {
    const data=await loadTask({thread:$("thread").value});
    active=data.chat_id;sessionStorage.setItem("desktopActiveChat",String(active));
    messageKey="";requestKey="";renderState(data.state);
    $("files").value="";$("filesLabel").textContent="";await list();setSidebar(false);
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
  window.addEventListener("beforeunload",()=>{clearInterval(timer);releaseMessageImages();});
})();
