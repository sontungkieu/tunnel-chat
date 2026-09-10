/* global RLCSDTransport */
"use strict";
const $ = id => document.getElementById(id);
const token = RLCSDTransport.accessToken({promptIfMissing:false});
const rpc = RLCSDTransport.createRpc({apiBase:"/d",token,retryLimit:1});
const uploads = RLCSDTransport.createRpc({apiBase:"/c",token,retryLimit:1});
let active = Number(sessionStorage.getItem("desktopActiveChat") || 0);
let snapshot = null, busy = false, polling = false, requestKey = "", messageKey = "";
let refreshFailures = 0, refreshRetryAt = 0, refreshNotice = false;
let messageImageUrls = [], imageRenderRevision = 0, pendingMediaRevision = 0, sidebarSyncAt = 0;
let collapsedProjects = new Set(), taskReadState = {}, newProjectDraft = null, taskMenuContext = null, listedChats = [];
let pendingQuote = null, selectionCandidate = null, selectionTimer = 0;
try {collapsedProjects=new Set(JSON.parse(sessionStorage.getItem("desktopCollapsedProjects") || "[]"));} catch(_error) {}
try {
  const saved=JSON.parse(localStorage.getItem("desktopTaskReadState") || "{}");
  if(saved && !Array.isArray(saved) && typeof saved==="object")taskReadState=saved;
} catch(_error) {}
let transport = {chunkBytes:2048,concurrency:3,retryLimit:4};
let generationChat=0;
const MODEL_EFFORTS={
  "gpt-6-astra":["low","medium","high","xhigh","max","ultra"],
  "gpt-5.6-sol":["low","medium","high","xhigh","max","ultra"],
  "gpt-5.6-terra":["low","medium","high","xhigh","max","ultra"],
  "gpt-5.6-luna":["low","medium","high","xhigh","max"],
  "gpt-5.5":["low","medium","high","xhigh"],
  "gpt-5.4-mini":["low","medium","high","xhigh"],
  "gpt-5.3-codex-spark":["low","medium","high","xhigh"],
};
const ALL_EFFORTS=["low","medium","high","xhigh","max","ultra"];
const loadStages={queued:"Đang xếp yêu cầu tải",connecting:"Đang kết nối Codex Desktop",
  cached:"Đang dùng snapshot đã tải",discovering:"Đang tìm tiến trình sở hữu task",
  "opening-task":"Đang tự mở task trong app Windows","waiting-owner":"Đang chờ Codex Desktop nhận task",
  "loading-history":"Đang yêu cầu toàn bộ lịch sử",
  "receiving-history":"Đang nhận snapshot lịch sử", "waiting-snapshot":"Đang chờ snapshot",
  projecting:"Đang dựng giao diện","loading-media":"Đang tải tệp trong hội thoại",complete:"Đã tải xong"};
const createStages={queued:"Đang xếp yêu cầu tạo task",
  "bootstrapping-controller":"Đang chuẩn bị bộ tạo task cho project",
  "controller-ready":"Đã chuẩn bị bộ tạo task",connecting:"Đang kết nối Codex Desktop",
  discovering:"Đang tìm task điều phối","opening-task":"Đang tự mở task trong app Windows",
  "waiting-owner":"Đang chờ Codex Desktop nhận task","loading-history":"Đang tải task điều phối",
  "receiving-history":"Đang nhận dữ liệu task điều phối","waiting-snapshot":"Đang chờ Desktop",
  "waiting-controller":"Đang chờ bộ tạo task sẵn sàng",
  "creating-task":"Codex Desktop đang tạo task mới","linking-task":"Đang kết nối task mới",
  projecting:"Đang dựng giao diện",complete:"Task mới đã sẵn sàng"};
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
function formatLoaderBytes(progress) {
  const received=Number(progress?.receivedBytes),total=Number(progress?.totalBytes);
  if(!Number.isFinite(received) || !Number.isFinite(total) || total<=0)return "";
  if(total<1024)return `${Math.round(received)}/${Math.round(total)} B`;
  const unit=total>=1048576?"MiB":"KiB",scale=unit==="MiB"?1048576:1024;
  const digits=total/scale>=10?0:1;
  return `${(received/scale).toFixed(digits)}/${(total/scale).toFixed(digits)} ${unit}`;
}
function setChatLoading(visible,{stage="queued",progress={},elapsed=0,detail="",label=""}={}) {
  const loader=$("chatLoader"),bar=$("chatLoaderBar"),track=$("chatLoaderProgress");
  loader.hidden=!visible;$("messages").setAttribute("aria-busy",String(visible));
  if(!visible){track.removeAttribute("aria-valuenow");track.dataset.indeterminate="true";bar.style.width="";return;}
  $("chatLoaderStage").textContent=label || loadStages[stage] || createStages[stage] || "Đang tải hội thoại";
  const percent=Number(progress?.percent),parts=[];
  if(Number.isFinite(percent))parts.push(`${Math.max(0,Math.min(100,Math.round(percent)))}%`);
  const bytes=formatLoaderBytes(progress);if(bytes)parts.push(bytes);
  if(detail)parts.push(detail);
  if(Number.isFinite(elapsed) && elapsed>0)parts.push(`${Math.floor(elapsed)} giây`);
  $("chatLoaderMeta").textContent=parts.join(" · ") || "Đang chuẩn bị…";
  const determinate=Number.isFinite(percent);
  track.dataset.indeterminate=String(!determinate);
  if(determinate){const value=Math.max(0,Math.min(100,percent));track.setAttribute("aria-valuenow",String(Math.round(value)));bar.style.width=`${value}%`;}
  else {track.removeAttribute("aria-valuenow");bar.style.width="";}
}
function selectOption(value,label=value) {
  const option=document.createElement("option");option.value=value;option.textContent=label;return option;
}
function rebuildEffortChoices() {
  const select=$("effortSelect"),selected=select.value,model=$("modelSelect").value;
  const efforts=MODEL_EFFORTS[model] || ALL_EFFORTS;
  select.replaceChildren(selectOption("","Theo task · mặc định"),...efforts.map(value=>selectOption(value,value)));
  select.value=efforts.includes(selected)?selected:"";
}
function initializeGenerationControls() {
  $("modelSelect").replaceChildren(selectOption("","Theo task · mặc định"),
    ...Object.keys(MODEL_EFFORTS).map(value=>selectOption(value,value)));
  rebuildEffortChoices();
  $("modelSelect").onchange=()=>{rebuildEffortChoices();updateControls();};
}
function syncGenerationControls(state) {
  if(generationChat!==active) {
    generationChat=active;$("modelSelect").value="";rebuildEffortChoices();
  }
  $("modelSelect").options[0].textContent=`Theo task · ${state.model || "mặc định"}`;
  $("effortSelect").options[0].textContent=`Theo task · ${state.effort || "mặc định"}`;
}
function formatTokens(value) {
  const tokens=Number(value);if(!Number.isFinite(tokens) || tokens<0)return "—";
  if(tokens>=1000000)return `${(tokens/1000000).toFixed(tokens>=10000000?0:1).replace(/\.0$/,"")}M`;
  if(tokens>=1000)return `${(tokens/1000).toFixed(tokens>=100000?0:1).replace(/\.0$/,"")}k`;
  return String(Math.round(tokens));
}
function renderContextUsage(usage) {
  const panel=$("contextUsage");
  if(!usage || !Number.isFinite(Number(usage.usedTokens)) || !Number.isFinite(Number(usage.contextWindowTokens))) {
    panel.hidden=true;return;
  }
  const used=Math.max(0,Number(usage.usedTokens)),windowTokens=Math.max(1,Number(usage.contextWindowTokens));
  const percent=Math.max(0,Math.min(100,Number(usage.usedPercent) || used/windowTokens*100));
  const remaining=Math.max(0,Number(usage.remainingTokens));
  panel.hidden=false;panel.dataset.level=percent>=90?"critical":percent>=75?"high":"normal";
  $("contextTokens").textContent=`Context ${formatTokens(used)} / ${formatTokens(windowTokens)} · ${Math.round(percent)}% đã dùng`;
  $("contextRemaining").textContent=`Còn ${formatTokens(remaining)}`;
  $("contextBar").style.width=`${percent}%`;$("contextMeter").setAttribute("aria-valuenow",String(Math.round(percent)));
  const count=Math.max(0,Math.round(Number(usage.compactionCount) || 0));
  $("contextCompaction").textContent=usage.compacting ? "Codex đang compact context…"
    : `${count?`Đã compact ${count} lần · `:""}Mốc compact tiếp theo do Codex tự quyết định`;
  panel.title=`Context của lượt gần nhất. Tổng token lũy kế: ${formatTokens(usage.cumulativeTokens)}. Desktop IPC không công bố compact threshold.`;
}
initializeGenerationControls();
function updateControls() {
  const unavailable=busy || !token,draft=!!newProjectDraft;
  const canConfigure=!unavailable && (draft || (!!snapshot && snapshot.status!=="running" && $("mode").value==="start"));
  $("send").disabled=unavailable || (!snapshot && !draft);
  $("stop").disabled=unavailable || draft || !snapshot?.activeTurnId;
  $("thread").disabled=unavailable;
  $("linkButton").disabled=unavailable;
  $("files").disabled=unavailable || draft;
  $("mode").disabled=unavailable || draft;
  $("modelSelect").disabled=!canConfigure;
  $("effortSelect").disabled=!canConfigure;
  $("prompt").disabled=unavailable || (!snapshot && !draft);
  $("reconnect").disabled=unavailable || draft;
  $("logout").disabled=busy;
  document.getElementById("newProject").disabled=unavailable;
  document.querySelectorAll("#requests button,#requests input,#requests textarea").forEach(control=>{
    if(control.dataset.conditional) {
      const selected=control.closest(".question-other")?.querySelector('input[type="radio"]')?.checked;
      control.disabled=busy || !selected;
    } else control.disabled=busy;
  });
  document.querySelectorAll("#taskList button").forEach(b=>b.disabled=busy);
}
function setBusy(value) {busy=value;updateControls();}
async function loadTask(payload) {
  setChatLoading(true,{stage:"queued"});
  try {
    const started=await rpc("load/start",payload,{attempts:1});
    while(true) {
      const job=await rpc("load/status",{load_id:started.load_id},{attempts:4});
      if(job.status==="complete") {notice();return job.result;}
      if(job.status==="error") throw new Error(job.error || "Không tải được task");
      const progress=job.progress || {},label=loadStages[job.stage] || "Đang tải task";
      const bytes=formatLoaderBytes(progress),percent=Number.isFinite(progress.percent) ? ` · ${progress.percent}%` : "";
      notice(`${label}${percent}${bytes?` · ${bytes}`:""} · ${Math.floor(job.elapsed_seconds)} giây`);
      setChatLoading(true,{stage:job.stage,progress,elapsed:job.elapsed_seconds,label});
      await wait(750);
    }
  } catch(error) {setChatLoading(false);throw error;}
}
async function waitForCreate(createId) {
  setChatLoading(true,{stage:"queued",label:createStages.queued});
  try {
    while(true) {
      const job=await rpc("create/status",{create_id:createId},{attempts:4});
      if(job.status==="complete") {notice();return job.result;}
      if(job.status==="error") throw new Error(job.error || "Không tạo được task");
      notice(`${createStages[job.stage] || "Đang tạo task mới"} · ${Math.floor(job.elapsed_seconds)} giây`);
      setChatLoading(true,{stage:job.stage,elapsed:job.elapsed_seconds,label:createStages[job.stage] || "Đang tạo task mới"});
      await wait(750);
    }
  } catch(error) {setChatLoading(false);throw error;}
}
function renderCreateDraft() {
  snapshot=null;messageKey="";requestKey="";pendingMediaRevision=0;imageRenderRevision+=1;setChatLoading(false);releaseMessageImages();clearPendingQuote();hideSelectionAction();renderContextUsage(null);
  $("title").textContent="Task mới";
  $("meta").textContent=`Project: ${newProjectDraft.name} · ${newProjectDraft.path} · Desktop · local`;
  updateActivity("idle","Soạn yêu cầu đầu tiên");
  $("activityDetail").textContent="Task sẽ được tạo trong project này khi bạn gửi tin nhắn đầu tiên.";
  $("messages").replaceChildren(textElement("div","Nhập yêu cầu đầu tiên, chọn model và effort nếu cần, rồi bấm Gửi.","empty create-empty"));
  updateScrollLatest();
  $("requests").replaceChildren();$("files").value="";$("filesLabel").textContent="Có thể đính kèm sau khi task được tạo.";
  $("mode").value="start";generationChat=0;$("modelSelect").value="";rebuildEffortChoices();
  $("modelSelect").options[0].textContent="Mặc định của app";
  $("effortSelect").options[0].textContent="Mặc định của app";
  updateControls();$("prompt").focus();
}
function startProjectTask(group) {
  if(busy || !token)return;
  const source=group.chats.find(chat=>chat.status!=="running") || group.chats[0];
  if(!source){notice("Project này chưa có task Desktop làm điểm kết nối.");return;}
  active=Number(source.id);
  newProjectDraft={sourceChatId:active,name:group.name,path:group.path,key:group.key};
  setSidebar(false);notice();renderCreateDraft();
}
function projectNameFromPath(path) {
  return String(path || "").replace(/[\\/]+$/,"").trim().split(/[\\/]/).at(-1) || "Project mới";
}
function newProjectSource() {
  return listedChats.find(chat=>chat.status!=="running") || null;
}
function openProjectDialog() {
  if(busy || !token)return;
  if(!newProjectSource()){notice("Hãy kết nối hoặc chờ ít nhất một task Desktop rảnh để làm điểm điều phối tạo project.");return;}
  $("projectPath").value="";setSidebar(false);$("projectDialog").showModal();setTimeout(()=>$("projectPath").focus(),0);
}
$("newProject").onclick=openProjectDialog;
$("projectCancel").onclick=()=>$("projectDialog").close();
$("projectDialog").onclick=event=>{if(event.target===$("projectDialog"))$("projectDialog").close();};
$("projectForm").onsubmit=event=>{
  event.preventDefault();
  const path=$("projectPath").value.trim(),source=newProjectSource();
  if(!path || !source)return;
  active=Number(source.id);newProjectDraft={sourceChatId:active,name:projectNameFromPath(path),path,key:path.toLowerCase(),targetProjectPath:path};
  $("projectDialog").close();notice();renderCreateDraft();
};
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
function hideSelectionAction() {
  clearTimeout(selectionTimer);selectionTimer=0;selectionCandidate=null;
  const button=$("selectionAction");button.hidden=true;button.style.left="";button.style.top="";
}
function clearPendingQuote() {
  pendingQuote=null;
  $("quoteContext").hidden=true;$("quoteText").textContent="";
}
function setPendingQuote(text) {
  const normalized=window.TunnelSelectionQuote?.normalize(text) || String(text || "").trim();
  if(!normalized)return;
  pendingQuote={chatId:active,text:normalized};
  $("quoteText").textContent=normalized;$("quoteContext").hidden=false;
}
function selectionParent(node) {
  return node?.nodeType===Node.ELEMENT_NODE ? node : node?.parentElement;
}
function selectedAssistantQuote() {
  const selection=window.getSelection();
  if(!selection || selection.isCollapsed || !selection.rangeCount || !active || newProjectDraft)return null;
  const range=selection.getRangeAt(0),start=selectionParent(range.startContainer),end=selectionParent(range.endContainer);
  const card=start?.closest?.(".message.assistant"),content=start?.closest?.(".rich-text");
  if(!card || !content || !card.contains(end))return null;
  const raw=selection.toString(),text=window.TunnelSelectionQuote?.normalize(raw) || raw.trim();
  if(!text)return null;
  const rect=range.getBoundingClientRect();
  if(!rect || (!rect.width && !rect.height))return null;
  return {chatId:active,text,rect};
}
function showSelectionAction() {
  const candidate=selectedAssistantQuote();
  if(!candidate){hideSelectionAction();return;}
  selectionCandidate=candidate;
  const button=$("selectionAction");button.hidden=false;
  const box=button.getBoundingClientRect(),gap=10;
  let left=candidate.rect.left+(candidate.rect.width-box.width)/2;
  let top=candidate.rect.top-box.height-gap;
  if(top<8)top=candidate.rect.bottom+gap;
  left=Math.max(8,Math.min(left,innerWidth-box.width-8));
  top=Math.max(8,Math.min(top,innerHeight-box.height-8));
  button.style.left=`${left}px`;button.style.top=`${top}px`;
}
function scheduleSelectionAction() {
  clearTimeout(selectionTimer);selectionTimer=setTimeout(showSelectionAction,100);
}
$("messages").addEventListener("pointerup",scheduleSelectionAction);
$("messages").addEventListener("keyup",scheduleSelectionAction);
$("messages").addEventListener("scroll",()=>{hideSelectionAction();updateScrollLatest();},{passive:true});
document.addEventListener("selectionchange",scheduleSelectionAction);
$("selectionAction").onpointerdown=event=>event.preventDefault();
$("selectionAction").onclick=()=>{
  if(!selectionCandidate || selectionCandidate.chatId!==active){hideSelectionAction();return;}
  setPendingQuote(selectionCandidate.text);hideSelectionAction();
  window.getSelection()?.removeAllRanges();$("prompt").focus();
};
$("quoteRemove").onclick=()=>{clearPendingQuote();$("prompt").focus();};
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
const liveRunningActivities=new Set(["thinking","tool","working","finalizing"]);
function updateScrollLatest() {
  const messages=$("messages"),button=$("scrollLatest");
  const distance=Math.max(0,messages.scrollHeight-messages.scrollTop-messages.clientHeight);
  const visible=!!snapshot && distance>80;
  const running=visible && liveRunningActivities.has(snapshot?.activity || snapshot?.status);
  button.hidden=!visible;button.dataset.running=String(running);
  const label=running?"Agent đang trả lời · cuộn xuống cuối":"Cuộn xuống cuối hội thoại";
  button.title=label;button.setAttribute("aria-label",label);
}
$("scrollLatest").onclick=()=>{
  const messages=$("messages");
  messages.scrollTo({top:messages.scrollHeight,behavior:"smooth"});
  requestAnimationFrame(updateScrollLatest);
};
function completionMarker(chat) {
  if(chat.activity!=="completed" || !chat.latestTurnId)return "";
  let hash=2166136261;
  for(const character of String(chat.latestTurnId))hash=Math.imul(hash^character.charCodeAt(0),16777619);
  return (hash>>>0).toString(16);
}
function persistTaskReadState() {
  try {localStorage.setItem("desktopTaskReadState",JSON.stringify(taskReadState));} catch(_error) {}
}
function taskVisualState(chat,markRead=false) {
  const id=String(chat.id),marker=completionMarker(chat);
  let record=taskReadState[id],changed=false;
  if(!record || Array.isArray(record) || typeof record!=="object") {
    record={knownCompletion:"",readCompletion:""};taskReadState[id]=record;changed=true;
  }
  if(marker && record.knownCompletion!==marker){record.knownCompletion=marker;changed=true;}
  if(markRead && marker && record.readCompletion!==marker){record.readCompletion=marker;changed=true;}
  if(changed)persistTaskReadState();
  const live=chat.live===true;
  if(live && liveRunningActivities.has(chat.activity))return "running";
  if(live && chat.activity==="waiting")return "waiting";
  if(marker && record.readCompletion!==marker)return "unread";
  if(live && ["failed","interrupted"].includes(chat.activity))return "failed";
  return "idle";
}
const taskStateLabels={running:"Đang chạy",waiting:"Đang chờ bạn",unread:"Đã hoàn tất, chưa đọc",failed:"Đã dừng hoặc gặp lỗi"};
function updateTaskIndicator(chat,markRead=false,targetButton=null) {
  const button=targetButton || Array.from(document.querySelectorAll("#taskList button[data-chat-id]")).find(
    candidate=>candidate.dataset.chatId===String(chat.id));
  if(!button)return;
  const state=taskVisualState(chat,markRead),indicator=button.querySelector(".task-indicator");
  button.dataset.taskState=state;indicator.className=`task-indicator ${state}`;
  indicator.hidden=state==="idle";
  const label=taskStateLabels[state] || "";
  button.title=label ? `${chat.title} · ${label}` : chat.title;
  button.setAttribute("aria-label",label ? `${chat.title}, ${label}` : chat.title);
}
function applyTaskStatuses(chats) {
  for(const chat of chats || [])updateTaskIndicator(chat,false);
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
  syncGenerationControls(state);
  renderContextUsage(state.contextUsage);
  $("title").textContent=state.title;
  const project=state.project || (state.cwd || "").replace(/[\\/]+$/,"").split(/[\\/]/).at(-1);
  $("meta").textContent=[project?`Project: ${project}`:"Project: chưa xác định",state.model,state.cwd,"Desktop · local"].filter(Boolean).join(" · ");
  updateActivity(state.activity || state.status,
    activityLabels[state.activity] || (state.status==="running"?"Agent đang làm việc":"Sẵn sàng"));
  updateTaskIndicator({id:active,live:true,...state},true);
  updateControls();
  const next=JSON.stringify(state.messages);
  if(next!==messageKey) {
    const initialMessageRender=!messageKey;
    hideSelectionAction();
    releaseMessageImages();
    const revision=++imageRenderRevision,chatId=active;
    const nearBottom=$("messages").scrollHeight-$("messages").scrollTop-$("messages").clientHeight<100;
    const fragment=document.createDocumentFragment(),imageLoads=[];
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
          imageLoads.push(loadMessageImage(element,caption,image,chatId,revision));
        }
        card.append(gallery);
      }
      fragment.append(card);
    }
    if(state.historyTruncated) fragment.prepend(textElement("p","Đang hiển thị 600 mục gần nhất.","history-note"));
    $("messages").replaceChildren(fragment);
    if(nearBottom || !messageKey) $("messages").scrollTop=$("messages").scrollHeight;
    messageKey=next;
    if(imageLoads.length) {
      // Existing images are rebuilt when a streamed text chunk arrives. Load
      // them in the background so an old attachment cannot cover each chunk
      // with the full conversation loader.
      const blockingMediaLoad=initialMessageRender;
      pendingMediaRevision=blockingMediaLoad?revision:0;
      let loaded=0;const total=imageLoads.length;
      if(blockingMediaLoad)setChatLoading(true,{stage:"loading-media",progress:{percent:0},detail:`0/${total} tệp`});
      else setChatLoading(false);
      for(const imageLoad of imageLoads)void imageLoad.finally(()=>{
        if(revision!==imageRenderRevision)return;
        loaded+=1;
        updateScrollLatest();
        if(!blockingMediaLoad)return;
        if(pendingMediaRevision!==revision)return;
        if(loaded>=total){pendingMediaRevision=0;setChatLoading(false);return;}
        setChatLoading(true,{stage:"loading-media",progress:{percent:loaded/total*100},detail:`${loaded}/${total} tệp`});
      });
    } else {pendingMediaRevision=0;setChatLoading(false);}
  } else if(!pendingMediaRevision)setChatLoading(false);
  const requests=JSON.stringify(state.requests);
  if(requests!==requestKey) {renderRequests(state.requests);requestKey=requests;}
  updateScrollLatest();
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
      box.classList.add("question-request");
      const controls=[];
      for(const [index,question] of (request.params.questions || []).entries()) {
        const fieldset=textElement("fieldset","","question-fieldset");
        fieldset.append(textElement("legend",question.header || `Câu hỏi ${index+1}`,"question-header"),
          textElement("p",question.question || question.id,"question-prompt"));
        const options=Array.isArray(question.options) ? question.options : [];
        if(options.length) {
          const choices=textElement("div","","question-options"),name=`question-${request.id}-${index}`;
          for(const option of options) {
            const label=textElement("label","","question-option"),radio=document.createElement("input");
            radio.type="radio";radio.name=name;radio.value=option.label || "";
            const copy=textElement("span","","question-option-copy");
            copy.append(textElement("strong",option.label || "Lựa chọn"));
            if(option.description)copy.append(textElement("span",option.description,"muted small"));
            label.append(radio,copy);choices.append(label);
          }
          const allowOther=question.isOther ?? question.is_other ?? true;
          let otherRadio=null,otherInput=null;
          if(allowOther) {
            const label=textElement("label","","question-option question-other");
            otherRadio=document.createElement("input");otherRadio.type="radio";otherRadio.name=name;otherRadio.value="__other__";
            const copy=textElement("span","","question-option-copy");
            copy.append(textElement("strong","Khác"),textElement("span","Nhập câu trả lời riêng.","muted small"));
            otherInput=document.createElement(question.isSecret || question.is_secret ? "input" : "textarea");
            if(otherInput.tagName==="INPUT")otherInput.type="password";else otherInput.rows=2;
            otherInput.placeholder="Câu trả lời khác…";otherInput.disabled=true;otherInput.dataset.conditional="true";
            otherRadio.onchange=()=>{otherInput.disabled=busy || !otherRadio.checked;if(!otherInput.disabled)otherInput.focus();};
            otherInput.onfocus=()=>{otherRadio.checked=true;otherInput.disabled=busy;};
            label.append(otherRadio,copy,otherInput);choices.append(label);
          }
          fieldset.append(choices);
          controls.push({id:question.id,read:()=>{
            const selected=fieldset.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
            if(!selected)throw new Error(`Chưa trả lời: ${question.header || question.question || question.id}`);
            if(selected===otherRadio) {
              const value=otherInput.value.trim();
              if(!value)throw new Error(`Hãy nhập câu trả lời khác cho: ${question.header || question.id}`);
              return [`user_note: ${value}`];
            }
            return [selected.value];
          }});
        } else {
          const input=document.createElement(question.isSecret || question.is_secret ? "input" : "textarea");
          if(input.tagName==="INPUT")input.type="password";else input.rows=2;
          input.placeholder="Nhập câu trả lời…";fieldset.append(input);
          controls.push({id:question.id,read:()=>{
            const value=input.value.trim();
            if(!value)throw new Error(`Chưa trả lời: ${question.header || question.question || question.id}`);
            return [value];
          }});
        }
        box.append(fieldset);
      }
      const button=textElement("button","Gửi câu trả lời");button.className="question-submit";
      button.onclick=()=>{
        try {reply(request,{answers:Object.fromEntries(controls.map(control=>[control.id,control.read()]))});}
        catch(error){notice(error.message);}
      };
      box.append(button);
    } else {
      box.append(textElement("p","Loại yêu cầu này cần trả lời trong app Windows.","muted"));
    }
    $("requests").append(box);
  }
}
function taskDeepLink(chat) {
  return `codex://threads/${chat.codex_session_id}`;
}
async function copyText(value,label) {
  try {
    if(!navigator.clipboard?.writeText)throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(value);
  } catch(_error) {
    const input=document.createElement("textarea");input.value=value;input.readOnly=true;
    input.style.position="fixed";input.style.opacity="0";document.body.append(input);
    input.select();const copied=document.execCommand("copy");input.remove();
    if(!copied)throw new Error("Trình duyệt không cho phép sao chép.");
  }
  notice(`Đã sao chép ${label}.`);
}
function closeTaskMenu({restoreFocus=false}={}) {
  const menu=$("taskContextMenu"),trigger=taskMenuContext?.trigger;
  menu.hidden=true;if(trigger)trigger.setAttribute("aria-expanded","false");taskMenuContext=null;
  if(restoreFocus && trigger?.isConnected)trigger.focus();
}
function openTaskMenu(event,chat,group,trigger) {
  if(busy)return;
  event?.preventDefault();event?.stopPropagation();closeTaskMenu();
  const menu=$("taskContextMenu"),rect=trigger.getBoundingClientRect();
  taskMenuContext={chat,group,trigger};trigger.setAttribute("aria-expanded","true");menu.hidden=false;
  menu.style.left="0px";menu.style.top="0px";
  const box=menu.getBoundingClientRect();
  const requestedX=Number.isFinite(event?.clientX) && event.clientX>0 ? event.clientX : rect.right;
  const requestedY=Number.isFinite(event?.clientY) && event.clientY>0 ? event.clientY : rect.bottom;
  menu.style.left=`${Math.max(8,Math.min(requestedX,innerWidth-box.width-8))}px`;
  menu.style.top=`${Math.max(8,Math.min(requestedY,innerHeight-box.height-8))}px`;
  menu.querySelector("button")?.focus();
}
function clearSelectedTask() {
  active=0;snapshot=null;newProjectDraft=null;messageKey="";requestKey="";renderContextUsage(null);
  pendingMediaRevision=0;imageRenderRevision+=1;setChatLoading(false);
  sessionStorage.removeItem("desktopActiveChat");releaseMessageImages();clearPendingQuote();hideSelectionAction();
  $("title").textContent="Chọn một task";$("meta").textContent="";
  updateActivity("idle","Chưa kết nối");
  $("activityDetail").textContent="Kết nối một task để theo dõi hoạt động.";
  $("messages").replaceChildren(textElement("p","Chọn một task ở sidebar hoặc kết nối bằng deeplink.","empty"));
  updateScrollLatest();
  $("requests").replaceChildren();$("files").value="";$("filesLabel").textContent="";
  updateControls();
}
async function selectChat(chat,force=false) {
  if(busy)return;
  closeTaskMenu();setSidebar(false);pendingMediaRevision=0;imageRenderRevision+=1;setChatLoading(false);
  clearPendingQuote();hideSelectionAction();setBusy(true);notice();
  active=Number(chat.id);newProjectDraft=null;sessionStorage.setItem("desktopActiveChat",String(active));
  snapshot=null;messageKey="";requestKey="";renderContextUsage(null);$("requests").replaceChildren();$("files").value="";$("filesLabel").textContent="";
  updateScrollLatest();
  updateControls();
  try {await list();await refresh(force);}
  catch(e) {notice(e.message);}
  finally {setBusy(false);}
}
$("taskContextMenu").onclick=async event=>{
  const item=event.target.closest("button[data-action]"),context=taskMenuContext;
  if(!item || !context || busy)return;
  const {chat,group}=context,action=item.dataset.action;closeTaskMenu();
  try {
    if(action==="open"){location.assign(taskDeepLink(chat));return;}
    if(action==="copy-link"){await copyText(taskDeepLink(chat),"deeplink");return;}
    if(action==="copy-id"){await copyText(chat.codex_session_id,"task ID");return;}
    if(action==="rename"){
      const value=prompt("Tên task trong Tunnel Chat",chat.title);
      if(value===null || !value.trim())return;
      setBusy(true);const renamed=await rpc("rename",{chat_id:chat.id,title:value.trim()});
      chat.title=renamed.title;
      if(Number(chat.id)===active){if(snapshot)snapshot.title=renamed.title;$("title").textContent=renamed.title;}
      await list();notice("Đã đổi tên task trong Tunnel Chat.");return;
    }
    if(action==="new"){startProjectTask(group);return;}
    if(action==="reconnect"){await selectChat(chat,true);return;}
    if(action==="unlink"){
      if(!confirm(`Gỡ “${chat.title}” khỏi danh sách Tunnel Chat? Task vẫn được giữ nguyên trong Codex Desktop.`))return;
      setBusy(true);await rpc("unlink",{chat_id:chat.id});
      if(Number(chat.id)===active)clearSelectedTask();
      await list();notice("Đã gỡ liên kết. Bạn có thể dán lại deeplink bất cứ lúc nào.");
    }
  } catch(error){notice(error.message);}
  finally {if(busy)setBusy(false);}
};
$("taskContextMenu").onkeydown=event=>{
  const items=Array.from($("taskContextMenu").querySelectorAll("button:not(:disabled)"));
  const index=items.indexOf(document.activeElement);
  let next=null;
  if(event.key==="ArrowDown")next=items[(index+1+items.length)%items.length];
  else if(event.key==="ArrowUp")next=items[(index-1+items.length)%items.length];
  else if(event.key==="Home")next=items[0];
  else if(event.key==="End")next=items.at(-1);
  if(next){event.preventDefault();next.focus();}
};
document.addEventListener("pointerdown",event=>{
  if(taskMenuContext && !$("taskContextMenu").contains(event.target))closeTaskMenu();
});
document.addEventListener("keydown",event=>{
  if(event.key==="Escape" && taskMenuContext){event.preventDefault();closeTaskMenu({restoreFocus:true});}
});
window.addEventListener("resize",()=>closeTaskMenu());
window.addEventListener("resize",hideSelectionAction);
window.addEventListener("resize",updateScrollLatest);
document.addEventListener("scroll",()=>{closeTaskMenu();hideSelectionAction();},true);
async function list() {
  const data=await rpc("list");transport=data.transport;
  listedChats=Array.isArray(data.chats)?data.chats:[];
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
    const add=textElement("button","＋","project-new");add.type="button";
    add.title=`Tạo task mới trong ${group.name}`;add.setAttribute("aria-label",add.title);
    add.onclick=event=>{event.preventDefault();event.stopPropagation();startProjectTask(group);};
    summary.append(textElement("span",group.name,"project-name"),textElement("span",group.chats.length,"project-count"));
    const tasks=textElement("div","","project-tasks");
    for(const chat of group.chats) {
      const row=textElement("div","","task-row");
      const button=textElement("button","",Number(chat.id)===active?"active":"");
      button.dataset.chatId=String(chat.id);button.disabled=busy;button.title=chat.title;
      button.setAttribute("aria-haspopup","menu");button.setAttribute("aria-expanded","false");
      const taskTitle=textElement("span",chat.title,"task-title"),indicator=textElement("span","","task-indicator");
      indicator.hidden=true;indicator.setAttribute("aria-hidden","true");button.append(taskTitle,indicator);
      button.onclick=()=>selectChat(chat);
      button.oncontextmenu=event=>openTaskMenu(event,chat,group,button);
      button.onkeydown=event=>{
        if(event.key==="ContextMenu" || (event.shiftKey && event.key==="F10"))openTaskMenu(event,chat,group,button);
      };
      const more=textElement("button","⋯","task-more");more.type="button";
      more.title=`Thao tác với ${chat.title}`;more.setAttribute("aria-label",more.title);
      more.setAttribute("aria-haspopup","menu");more.setAttribute("aria-expanded","false");
      more.onclick=event=>openTaskMenu(event,chat,group,more);
      row.append(button,more);tasks.append(row);updateTaskIndicator(chat,false,button);
    }
    details.append(summary,add,tasks);
    details.ontoggle=()=>{details.open?collapsedProjects.delete(group.key):collapsedProjects.add(group.key);rememberProjectGroups();};
    $("taskList").append(details);
  }
  if(!data.chats.length) $("taskList").append(textElement("p","Chưa có task được kết nối.","muted"));
  if(active && !data.chats.some(c=>Number(c.id)===active)) active=0;
  const liveIds=new Set(data.chats.map(chat=>String(chat.id)));
  let pruned=false;
  for(const id of Object.keys(taskReadState))if(!liveIds.has(id)){delete taskReadState[id];pruned=true;}
  if(pruned)persistTaskReadState();
  sidebarSyncAt=Date.now();
}
async function syncSidebarStatuses() {
  if(Date.now()-sidebarSyncAt<3000)return;
  sidebarSyncAt=Date.now();
  try {const data=await rpc("list");applyTaskStatuses(data.chats);}
  catch(_error) {}
}
async function refresh(force=false) {
  if(!active || polling || newProjectDraft) return;
  if(!force && Date.now()<refreshRetryAt)return;
  polling=true;
  const selected=active;
  try {
    const state=(force || !snapshot)
      ? (await loadTask({chat_id:selected,refresh:force})).state
      : await rpc("state",{chat_id:selected,refresh:false,since_revision:snapshot.revision},{attempts:3});
    if(selected===active && !state.unchanged)renderState(state);
    refreshFailures=0;refreshRetryAt=0;
    if(refreshNotice){notice();refreshNotice=false;}
    await syncSidebarStatuses();
  }
  catch(e) {
    refreshFailures+=1;
    const delay=Math.min(30000,1500*(2**Math.min(refreshFailures-1,4)));
    refreshRetryAt=Date.now()+delay;refreshNotice=true;
    const raw=String(e?.message || e || "Không kết nối được");
    const detail=/no-client-found|does not support this client|owner|did not expose the task/i.test(raw)
      ? "Chưa tự kết nối được Codex Desktop trên máy cá nhân. Hãy kiểm tra app Windows vẫn đang chạy."
      : raw;
    if(!snapshot){updateControls();updateActivity("failed","Đang kết nối lại");}
    notice(`${detail}\nWeb sẽ tự thử lại sau ${Math.ceil(delay/1000)} giây.`);
  }
  finally {polling=false;}
}
$("linkForm").onsubmit=async event=>{
  event.preventDefault();pendingMediaRevision=0;imageRenderRevision+=1;setChatLoading(false);setBusy(true);notice();
  try {
    const data=await loadTask({thread:$("thread").value});
    clearPendingQuote();hideSelectionAction();
    active=data.chat_id;newProjectDraft=null;sessionStorage.setItem("desktopActiveChat",String(active));
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
  if(busy || (!snapshot && !newProjectDraft)) return;
  const draft=newProjectDraft,chatId=draft?.sourceChatId || active;
  const mode=draft ? "start" : $("mode").value,expectedTurnId=draft ? null : snapshot.activeTurnId;
  const body=$("prompt").value.trim(), files=Array.from($("files").files);
  if(!body && !files.length) return;
  const text=!draft && pendingQuote?.chatId===chatId
    ? (window.TunnelSelectionQuote?.buildPrompt(pendingQuote.text,body) || body) : body;
  if(draft && files.length){notice("Hãy tạo task trước, rồi đính kèm file ở lượt tiếp theo.");return;}
  if(!draft && snapshot.status==="running" && mode!=="steer"){notice("Task đang chạy. Chọn gửi chỉ dẫn hoặc chờ lượt này kết thúc.");return;}
  if(!draft && mode==="steer" && !expectedTurnId){notice("Không có lượt đang chạy để gửi chỉ dẫn.");return;}
  setBusy(true);notice();
  const operation_id=operationId();
  const sendStartedAt=performance.now(),elapsed=()=>Math.max(0,(performance.now()-sendStartedAt)/1000);
  const progressBytes=(blob,completed)=>Math.min(blob.size,Math.max(0,completed)*transport.chunkBytes);
  let submissionStarted=false;
  setChatLoading(true,{label:"Đang chuẩn bị gửi tin nhắn",elapsed:elapsed()});
  try {
    while(polling)await wait(50);
    setChatLoading(true,{label:"Đang chuẩn bị gửi tin nhắn",elapsed:elapsed()});
    const attachment_ids=[];
    const totalFileBytes=files.reduce((sum,file)=>sum+file.size,0);
    let sentFileBytes=0;
    for(const [fileIndex,file] of files.entries()) {
      setChatLoading(true,{label:"Đang tải tệp đính kèm",progress:{percent:totalFileBytes?sentFileBytes/totalFileBytes*100:0,
        receivedBytes:sentFileBytes,totalBytes:totalFileBytes},elapsed:elapsed(),detail:`${fileIndex+1}/${files.length} · ${file.name}`});
      const uploaded=await RLCSDTransport.uploadBlob({rpc:uploads,blob:file,...transport,
        chunkBytes:transport.chunkBytes,paths:{start:"attachment/start",chunk:"attachment/chunk",status:"attachment/status",finish:"attachment/finish"},
        startPayload:{chat_id:chatId,filename:file.name,mime_type:file.type},
        onProgress:(completed,total)=>{
          const received=sentFileBytes+progressBytes(file,completed);
          setChatLoading(true,{label:"Đang tải tệp đính kèm",progress:{percent:totalFileBytes?received/totalFileBytes*100:completed/total*100,
            receivedBytes:received,totalBytes:totalFileBytes},elapsed:elapsed(),detail:`${fileIndex+1}/${files.length} · ${file.name}`});
        }});
      attachment_ids.push(uploaded.attachment.id);
      sentFileBytes+=file.size;
    }
    const sendData={chat_id:chatId,mode,expectedTurnId,operation_id,attachment_ids};
    if(draft){sendData.create=true;if(draft.targetProjectPath)sendData.project_path=draft.targetProjectPath;}
    if(mode==="start") {
      if($("modelSelect").value)sendData.model=$("modelSelect").value;
      if($("effortSelect").value)sendData.effort=$("effortSelect").value;
    }
    const promptBlob=new Blob([text]);
    setChatLoading(true,{label:"Đang tải nội dung tin nhắn",progress:{percent:0,receivedBytes:0,totalBytes:promptBlob.size},
      elapsed:elapsed(),detail:"Đang chia nội dung thành các phần"});
    const promptRpc=(path,payload,options)=>{
      if(path==="prompt/finish") {
        submissionStarted=true;
        setChatLoading(true,{label:"Đang chuyển lượt tới Codex Desktop",elapsed:elapsed(),detail:"Đang chờ Desktop nhận tin nhắn"});
        return rpc(path,{...sendData,...payload},{attempts:1});
      }
      return uploads(path,payload,options);
    };
    const submitted=await RLCSDTransport.uploadBlob({rpc:promptRpc,blob:promptBlob,...transport,
      chunkBytes:transport.chunkBytes,paths:{start:"prompt/start",chunk:"prompt/chunk",status:"prompt/status",finish:"prompt/finish"},
      startPayload:{chat_id:chatId,attachment_ids},onProgress:(completed,total)=>{
        const received=progressBytes(promptBlob,completed);
        setChatLoading(true,{label:"Đang tải nội dung tin nhắn",progress:{percent:completed/total*100,
          receivedBytes:received,totalBytes:promptBlob.size},elapsed:elapsed(),detail:`${completed}/${total} phần`});
      }});
    if(draft) {
      const created=await waitForCreate(submitted.create_id);
      newProjectDraft=null;active=created.chat_id;sessionStorage.setItem("desktopActiveChat",String(active));
      messageKey="";requestKey="";renderState(created.state);await list();
    } else {
      setChatLoading(true,{label:"Đang đồng bộ tin nhắn vào hội thoại",elapsed:elapsed(),detail:"Đang nhận snapshot mới"});
      await refresh();
    }
    $("prompt").value="";$("files").value="";$("filesLabel").textContent="";clearPendingQuote();
  } catch(e) {
    setChatLoading(false);
    notice(e.message+(submissionStarted?"\nNếu kết quả gửi chưa rõ, hãy kiểm tra hội thoại trước khi gửi lại.":""));
  } finally {if(!pendingMediaRevision)setChatLoading(false);setBusy(false);}
};
$("prompt").onkeydown=event=>{if((event.ctrlKey || event.metaKey)&&event.key==="Enter"){event.preventDefault();$("composer").requestSubmit();}};
$("mode").onchange=updateControls;
$("stop").onclick=async()=>{
  if(!snapshot?.activeTurnId || busy)return;
  setBusy(true);notice();
  try {await rpc("cancel",{chat_id:active,expectedTurnId:snapshot.activeTurnId,operation_id:operationId()});await refresh();}
  catch(e){notice(e.message);}finally{setBusy(false);}
};
$("logout").onclick=async()=>{
  await window.TunnelTransfer?.clearAuth().catch(()=>{});
  RLCSDTransport.clearAccessToken();location.reload();
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
