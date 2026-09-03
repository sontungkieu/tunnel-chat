'use strict';
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const notice = document.getElementById('notice');
let latestFrame, painting = false, ready = false, fitted = false, queue = Promise.resolve(), queueSize = 0;
function warn(text = '') { notice.textContent = text; notice.hidden = !text; }
async function action(path, data) {
  const response = await fetch('/chat/api/' + path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401
    ? 'Phiên truy cập đã hết hạn. Mở lại /chat/ để đăng nhập.'
    : 'Thao tác chưa được xác nhận. Kiểm tra trang trước khi thử lại.');
}
function send(data) {
  if (!ready || queueSize >= 128) return;
  queueSize++;
  // Preserve key/mouse order. Never replay an ambiguous command.
  queue = queue.then(() => action('input', data)).catch(error => warn(error.message))
    .finally(() => { queueSize--; });
}
function paint() {
  if (!latestFrame || painting) return;
  const frame = latestFrame; latestFrame = null; painting = true;
  screen.onload = () => { painting = false; paint(); };
  screen.onerror = () => { painting = false; };
  screen.src = 'data:image/jpeg;base64,' + frame.data;
  screen.style.display = 'block'; document.getElementById('waiting').hidden = true;
}
const events = new EventSource('/chat/api/frames');
events.addEventListener('frame', event => { latestFrame = JSON.parse(event.data); paint(); });
events.addEventListener('status', event => {
  const value = JSON.parse(event.data); ready = value.ready; status.textContent = value.message;
  if (ready && !fitted) { fitted = true; fit(); }
});
events.addEventListener('notice', event => warn(JSON.parse(event.data).message));
events.onerror = () => { ready = false; status.textContent = 'Đang kết nối lại… Nếu phiên hết hạn, mở lại trang để đăng nhập.'; };
function modifiers(event) { return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0); }
function mouse(event, type) {
  const rect = screen.getBoundingClientRect();
  return { kind: 'mouse', type,
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    button: ['left','middle','right'][event.button] || 'none',
    buttons: event.buttons & 7, clickCount: Math.min(3, event.detail || 0), modifiers: modifiers(event) };
}
screen.onmousedown = event => { event.preventDefault(); screen.focus(); send(mouse(event, 'mousePressed')); };
screen.onmouseup = event => { event.preventDefault(); send(mouse(event, 'mouseReleased')); };
screen.oncontextmenu = event => event.preventDefault();
let lastMove = 0;
screen.onmousemove = event => {
  if (Date.now() - lastMove < 80) return;
  lastMove = Date.now(); send(mouse(event, 'mouseMoved'));
};
screen.addEventListener('wheel', event => {
  event.preventDefault();
  send({ ...mouse(event, 'mouseWheel'), button: 'none', clickCount: 0,
    deltaX: Math.max(-3000, Math.min(3000, event.deltaX)), deltaY: Math.max(-3000, Math.min(3000, event.deltaY)) });
}, { passive: false });
for (const type of ['keydown','keyup']) screen.addEventListener(type, event => {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return;
  if ((event.ctrlKey || event.metaKey) && ['v','V'].includes(event.key)) return;
  event.preventDefault();
  send({ kind: 'key', type: type === 'keydown' ? 'keyDown' : 'keyUp',
    key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event), repeat: event.repeat });
});
screen.addEventListener('paste', event => {
  event.preventDefault(); const text = event.clipboardData.getData('text/plain');
  if (text) send({ kind: 'text', text });
});
document.getElementById('insert').onclick = async () => {
  const text = document.getElementById('text');
  if (!text.value) return;
  const button = document.getElementById('insert'); button.disabled = true; warn();
  try { await queue; await action('input', { kind: 'text', text: text.value }); text.value = ''; screen.focus(); }
  catch (error) { warn(error.message); } finally { button.disabled = false; }
};
for (const id of ['home','reload']) document.getElementById(id).onclick = async () => {
  warn();
  try { await queue; await action('control', { action: id }); } catch (error) { warn(error.message); }
};
window.addEventListener('beforeunload', () => events.close());

async function fit() {
  if (!ready) return;
  const rect = document.getElementById('stage').getBoundingClientRect();
  try {
    await queue;
    await action('control', { action: 'viewport',
      width: Math.max(640, Math.min(1920, Math.floor(rect.width))),
      height: Math.max(360, Math.min(1400, Math.floor(rect.height))) });
  } catch (error) { warn(error.message); }
}
document.getElementById('fit').onclick = fit;
