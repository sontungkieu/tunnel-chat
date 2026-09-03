'use strict';
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const notice = document.getElementById('notice');
const latency = document.getElementById('latency');
const fps = document.getElementById('fps');
const context = screen.getContext('2d', { alpha:false });
let paintedFrames = 0, rateStarted = performance.now();
const buffer = new InputBuffer();
const pending = new Map();
let socket, latestFrame, painting = false, ready = false, fitted = false, nextId = 0;
let flushTimer, reconnectTimer, stopped = false, generation = 0, pingStarted = 0, pingId = 0;
function warn(text = '') { notice.textContent = text; notice.hidden = !text; }
function transmit(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function failWork() {
  const error = new Error('Kết nối đã gián đoạn. Kiểm tra trang trước khi gửi lại thao tác.');
  if (pending.size || buffer.length) warn(error.message);
  buffer.clear(error);
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject?.(error); }
  pending.clear(); clearTimeout(flushTimer); flushTimer = null;
}
function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 16); }
function flush() {
  flushTimer = null;
  if (!ready || socket?.readyState !== WebSocket.OPEN) return;
  while (buffer.length && pending.size < 8 && socket.bufferedAmount < 128 * 1024) {
    const job = buffer.shift(), id = ++nextId;
    job.timer = setTimeout(() => {
      if (pending.has(id)) { warn('Thao tác chưa được xác nhận. Kiểm tra trang trước khi thử lại.'); socket.close(); }
    }, 14000);
    pending.set(id, job); transmit({ ...job.command, id });
  }
  if (buffer.length && pending.size < 8) schedule();
}
function enqueue(command, resolve, reject) {
  if (!ready) { reject?.(new Error('Chrome chưa kết nối.')); return; }
  try { buffer.push({ command, resolve, reject }); schedule(); }
  catch (error) { reject?.(error); warn(error.message); }
}
function send(data) { enqueue({ type:'input', data }); }
function action(type, data) { return new Promise((resolve,reject) => enqueue(type === 'input' ? { type, data } : { type, ...data }, resolve,reject)); }
function clearPicture() {
  generation++; latestFrame = null; painting = false;
  context.clearRect(0, 0, screen.width, screen.height); screen.style.display = 'none';
  paintedFrames = 0; fps.textContent = ''; rateStarted = performance.now();
  document.getElementById('waiting').hidden = false;
}
async function paint() {
  if (!latestFrame || painting) return;
  const frame = latestFrame, epoch = generation, connection = socket;
  latestFrame = null; painting = true;
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([frame.bytes], { type:'image/jpeg' }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (generation !== epoch || socket !== connection) return;
    if (screen.width !== bitmap.width) screen.width = bitmap.width;
    if (screen.height !== bitmap.height) screen.height = bitmap.height;
    context.drawImage(bitmap, 0, 0); paintedFrames++;
    screen.style.display = 'block'; document.getElementById('waiting').hidden = true;
    transmit({ type:'frameAck', seq:frame.seq });
  } catch { if (socket === connection) connection.close(); }
  finally { bitmap?.close(); if (generation === epoch) { painting = false; paint(); } }
}
async function reconnect() {
  if (stopped) return;
  try {
    const response = await fetch('/chat/api/status', { cache:'no-store' });
    if (response.status === 401) {
      status.textContent = 'Phiên truy cập đã hết hạn. Mở lại /chat/ để đăng nhập.'; return;
    }
  } catch {}
  reconnectTimer = setTimeout(connect, 1500);
}
function connect() {
  if (stopped) return;
  const connection = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/chat/api/socket');
  socket = connection; connection.binaryType = 'arraybuffer';
  connection.onmessage = event => {
    if (socket !== connection) return;
    if (event.data instanceof ArrayBuffer) {
      const view = new DataView(event.data);
      if (view.byteLength < 28 || view.getUint32(0) !== 0x54434631) { connection.close(); return; }
      latestFrame = { seq:view.getUint32(4), bytes:event.data.slice(24) }; paint(); return;
    }
    let value;
    try { value = JSON.parse(event.data); } catch { connection.close(); return; }
    if (value.event === 'status') {
      ready = value.ready; status.textContent = value.message;
      if (!ready) { failWork(); clearPicture(); document.getElementById('waiting').textContent = value.message; }
      else if (!fitted) { fitted = true; fit(); }
    } else if (value.event === 'notice') warn(value.message);
    else if (value.event === 'ack') {
      const job = pending.get(value.id); if (!job) return;
      clearTimeout(job.timer); pending.delete(value.id);
      if (value.ok) job.resolve?.();
      else { const error = new Error(value.error); job.reject?.(error); warn(error.message); }
      schedule();
    } else if (value.event === 'pong' && value.id === pingId) {
      latency.textContent = 'Mạng: ' + Math.round(performance.now() - pingStarted) + ' ms';
    }
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    ready = false; fitted = false; failWork(); clearPicture(); latency.textContent = '';
    status.textContent = 'Đang kết nối lại…'; reconnect();
  };
  connection.onerror = () => { status.textContent = 'Chưa kết nối được đường truyền.'; };
}
const pingTimer = setInterval(() => {
  const now = performance.now(), rate = Math.round(paintedFrames * 1000 / (now - rateStarted));
  fps.textContent = ready ? (rate > 1 ? rate + ' FPS' : 'Hình tĩnh') : '';
  paintedFrames = 0; rateStarted = now;
  if (socket?.readyState === WebSocket.OPEN) { pingStarted = performance.now(); transmit({ type:'ping', id:++pingId }); }
}, 2000);
function modifiers(event) { return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0); }
function mouse(event, type) {
  const rect = screen.getBoundingClientRect();
  return { kind:'mouse', type,
    x:Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y:Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    button:['left','middle','right'][event.button] || 'none',
    buttons:event.buttons & 7, clickCount:Math.min(3, event.detail || 0), modifiers:modifiers(event) };
}
screen.onmousedown = event => { event.preventDefault(); screen.focus(); send(mouse(event, 'mousePressed')); };
screen.onmouseup = event => { event.preventDefault(); send(mouse(event, 'mouseReleased')); };
screen.oncontextmenu = event => event.preventDefault();
screen.onmousemove = event => send(mouse(event, 'mouseMoved'));
screen.addEventListener('wheel', event => {
  event.preventDefault();
  send({ ...mouse(event, 'mouseWheel'), button:'none', clickCount:0,
    deltaX:Math.max(-3000, Math.min(3000, event.deltaX)), deltaY:Math.max(-3000, Math.min(3000, event.deltaY)) });
}, { passive:false });
for (const type of ['keydown','keyup']) screen.addEventListener(type, event => {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return;
  if ((event.ctrlKey || event.metaKey) && ['v','V'].includes(event.key)) return;
  event.preventDefault();
  send({ kind:'key', type:type === 'keydown' ? 'keyDown' : 'keyUp',
    key:event.key, code:event.code, keyCode:event.keyCode, modifiers:modifiers(event), repeat:event.repeat });
});
screen.addEventListener('paste', event => {
  event.preventDefault(); const text = event.clipboardData.getData('text/plain');
  if (text) send({ kind:'text', text });
});
document.getElementById('insert').onclick = async () => {
  const text = document.getElementById('text'); if (!text.value) return;
  const button = document.getElementById('insert'); button.disabled = true; warn();
  try { await action('input', { kind:'text', text:text.value }); text.value = ''; screen.focus(); }
  catch (error) { warn(error.message); } finally { button.disabled = false; }
};
for (const id of ['home','reload']) document.getElementById(id).onclick = async () => {
  warn(); try { await action('control', { action:id }); } catch (error) { warn(error.message); }
};
async function fit() {
  if (!ready) return;
  const rect = document.getElementById('stage').getBoundingClientRect();
  try {
    await action('control', { action:'viewport',
      width:Math.max(640, Math.min(1920, Math.floor(rect.width))),
      height:Math.max(360, Math.min(1400, Math.floor(rect.height))) });
  } catch (error) { warn(error.message); }
}
document.getElementById('fit').onclick = fit;
window.addEventListener('beforeunload', () => {
  stopped = true; clearTimeout(reconnectTimer); clearInterval(pingTimer); failWork(); socket?.close();
});
connect();