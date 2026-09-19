'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
console.log('--- che do dien thoai (ban 2) ---');
console.log('tu bat (coarse + <1024) :', s.indexOf("matchMedia('(pointer: coarse)')") !== -1);
console.log('nut trong hang tab      :', s.indexOf('role="tablist"') !== -1);
console.log('khong con FAB noi       :', s.indexOf('dsh-mobile-fab') === -1);
console.log('anchor frame inline style:', s.indexOf('div[style*="grid-template-columns"]') !== -1);
console.log('an rail (descendant)    :', s.indexOf('[data-sidebar-collapsed] [class*="_sidebarCol"] { display: none') !== -1);
console.log('drawer 288px            :', s.indexOf('width: 288px; z-index: 40') !== -1);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
