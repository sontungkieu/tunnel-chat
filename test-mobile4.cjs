'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
console.log('khong luu trang thai mobile :', s.indexOf("localStorage.removeItem('dsh.bridge.mobile')") !== -1 && s.indexOf("setItem('dsh.bridge.mobile', '1')") === -1);
console.log('co nen mo backdrop          :', s.indexOf('dsh-mobile-backdrop') !== -1);
console.log('drawer min(288px, 78vw)     :', s.indexOf('min(288px, 78vw)') !== -1);
console.log('bam nen de dong             :', s.indexOf("d.getElementById('dsh-mobile-backdrop')") !== -1);
console.log('khong dung :has(> ...)      :', s.indexOf('div:has(> [class*="_sidebarCol"])') !== -1);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
