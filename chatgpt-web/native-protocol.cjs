'use strict';
const { EventEmitter } = require('node:events');

class CDP extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.next = 0; this.pending = new Map();
    socket.addEventListener('message', async event => {
      let message;
      try {
        const data = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : await event.data.text();
        message = JSON.parse(data);
      } catch { this.emit('protocolError', { type: typeof event.data, length: event.data?.length }); return; }
      if (message.id) {
        const job = this.pending.get(message.id);
        if (!job) return;
        this.pending.delete(message.id); clearTimeout(job.timer);
        if (message.error) job.reject(new Error(message.error.message));
        else job.resolve(message.result || {});
      } else if (message.method) this.emit(message.method, message.params || {});
    });
    socket.addEventListener('close', () => {
      for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Browser disconnected')); }
      this.pending.clear(); this.emit('disconnected');
    });
  }
  async call(method, params = {}) {
    if (this.socket.readyState !== 1) throw new Error('Browser disconnected');
    if (this.pending.size >= 128) throw new Error('Browser is busy');
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timed out')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}
function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error('Invalid input coordinates');
  return value;
}
function inputCommand(data, viewport) {
  if (!data || typeof data !== 'object') throw new Error('Invalid input');
  if (data.kind === 'text') {
    if (typeof data.text !== 'string' || Buffer.byteLength(data.text) > 65536) throw new Error('Text is too long');
    return ['Input.insertText', { text: data.text }];
  }
  if (data.kind === 'mouse') {
    if (!['mousePressed','mouseReleased','mouseMoved','mouseWheel'].includes(data.type)) throw new Error('Invalid mouse event');
    const params = { type: data.type,
      x: number(data.x, 0, 1) * viewport.width, y: number(data.y, 0, 1) * viewport.height,
      button: ['left','right','middle','none'].includes(data.button) ? data.button : 'none',
      buttons: number(data.buttons || 0, 0, 7), modifiers: number(data.modifiers || 0, 0, 15),
      clickCount: number(data.clickCount || 0, 0, 3) };
    if (data.type === 'mouseWheel') {
      params.deltaX = number(data.deltaX || 0, -3000, 3000);
      params.deltaY = number(data.deltaY || 0, -3000, 3000);
    }
    return ['Input.dispatchMouseEvent', params];
  }
  if (data.kind === 'key') {
    if (!['keyDown','keyUp'].includes(data.type) || typeof data.key !== 'string' ||
        data.key.length > 32 || typeof data.code !== 'string' || data.code.length > 32) throw new Error('Invalid key event');
    const params = { type: data.type, key: data.key, code: data.code,
      modifiers: number(data.modifiers || 0, 0, 15),
      windowsVirtualKeyCode: number(data.keyCode || 0, 0, 255), autoRepeat: !!data.repeat };
    if (data.type === 'keyDown' && !(params.modifiers & 7)) {
      if (data.key.length === 1) params.text = data.key;
      else if (data.key === 'Enter') params.text = '\r';
    }
    return ['Input.dispatchKeyEvent', params];
  }
  throw new Error('Unsupported input');
}
module.exports = { CDP, inputCommand };
