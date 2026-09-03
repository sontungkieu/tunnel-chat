'use strict';
// Shared with the browser so event coalescing and ordering have direct regression tests.
class InputBuffer {
  constructor(limit = 128) { this.limit = limit; this.items = []; }
  push(job) {
    const tail = this.items.at(-1), a = tail?.command, b = job.command;
    if (!tail?.resolve && !job.resolve && a?.type === 'input' && b?.type === 'input' &&
        a.data.kind === 'mouse' && b.data.kind === 'mouse' && a.data.type === b.data.type &&
        a.data.buttons === b.data.buttons && a.data.modifiers === b.data.modifiers) {
      if (b.data.type === 'mouseMoved') { tail.command = b; return; }
      if (b.data.type === 'mouseWheel') {
        const deltaX = a.data.deltaX + b.data.deltaX, deltaY = a.data.deltaY + b.data.deltaY;
        if (Math.abs(deltaX) <= 3000 && Math.abs(deltaY) <= 3000) {
          tail.command = { ...b, data: { ...b.data, deltaX, deltaY } }; return;
        }
      }
    }
    if (this.items.length >= this.limit) throw new Error('Hàng đợi thao tác đã đầy. Chờ kết nối ổn định rồi thử lại.');
    this.items.push(job);
  }
  shift() { return this.items.shift(); }
  clear(error) { for (const job of this.items) job.reject?.(error); this.items.length = 0; }
  get length() { return this.items.length; }
}
if (typeof module !== 'undefined') module.exports = { InputBuffer };
else globalThis.InputBuffer = InputBuffer;