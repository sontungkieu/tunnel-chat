'use strict';
/* Sinh icon .ico cho shortcut: nen toi + 2 chevron gradient (chunked stream). */
const fs = require('node:fs');
const zlib = require('node:zlib');

let T = null;
function crcTable() {
  if (T) return T;
  T = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); T[n] = c; }
  return T;
}
function crc32(buf) {
  const t = crcTable(); let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

function shade(u, v, size) {
  const aa = 1.9 / size;
  const bg = sdRoundRect(u, v, 0.5, 0.5, 0.475, 0.475, 0.205);
  const bgCov = clamp(0.5 - bg / aa, 0, 1);
  if (bgCov <= 0) return [0, 0, 0, 0];
  const base = lerp([17, 27, 51], [9, 14, 26], clamp(v, 0, 1));
  let col = base;
  const border = clamp(0.5 - (sdRoundRect(u, v, 0.5, 0.5, 0.475, 0.475, 0.205) + 0.012) / aa, 0, 1) - clamp(0.5 - (sdRoundRect(u, v, 0.5, 0.5, 0.462, 0.462, 0.196) + 0.006) / aa, 0, 1);
  if (border > 0) col = lerp(col, [45, 66, 102], clamp(border, 0, 1));
  const th = 0.062, hh = 0.165, wdt = 0.155;
  let best = -1;
  let which = 0;
  for (let i = 0; i < 2; i++) {
    const x0 = 0.285 + i * 0.225;
    const d1 = sdSegment(u, v, x0, 0.5 - hh, x0 + wdt, 0.5, th);
    const d2 = sdSegment(u, v, x0 + wdt, 0.5, x0, 0.5 + hh, th);
    const d = Math.min(d1, d2);
    const cov = clamp(0.5 - d / aa, 0, 1);
    if (cov > best) { best = cov; which = i; }
  }
  if (best > 0) {
    const c = lerp([56, 189, 248], [52, 211, 153], which === 0 ? 0.15 : 0.85);
    col = lerp(col, c, clamp(best, 0, 1));
  }
  return [col[0], col[1], col[2], 255 * bgCov];
}

function render(size) {
  const S = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, size);
          r += px[0] * px[3]; g += px[1] * px[3]; b += px[2] * px[3]; a += px[3];
        }
      }
      const n = S * S, A = a / n, i = (y * size + x) * 4;
      if (a > 0) { buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); }
      buf[i + 3] = Math.round(A);
    }
  }
  return buf;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
const datas = [];
let offset = 6 + 16 * sizes.length;
for (const s of sizes) {
  const png = encodePNG(render(s), s, s);
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
  datas.push(png);
}
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const ico = Buffer.concat([header].concat(entries).concat(datas));
fs.writeFileSync('D:/dev/dsh/bridge/dsh-tunnel.ico', ico);
fs.writeFileSync('D:/dev/dsh/bridge/icon-preview-256.png', encodePNG(render(256), 256, 256));
console.log('ico bytes:', ico.length, '| sizes:', sizes.join(','));
