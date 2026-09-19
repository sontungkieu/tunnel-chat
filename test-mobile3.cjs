'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
console.log('--- an toan (ban 3) ---');
console.log('mac dinh TAT (chi ?mobile=1):', s.indexOf("localStorage.getItem('dsh.bridge.mobile') === '1'") !== -1 && s.indexOf('pointer: coarse') === -1);
console.log('KHONG chen vao cay React   :', s.indexOf('insertAdjacentElement') === -1);
console.log('KHONG MutationObserver     :', s.indexOf('MutationObserver') === -1);
console.log('nut rieng ngoai root       :', s.indexOf('document.body.appendChild(b)') !== -1);
console.log('dat theo toa do hang tab   :', s.indexOf('getBoundingClientRect()') !== -1);
console.log('CSS van con (chi khi bat)  :', s.indexOf('grid-template-columns"] { grid-template-columns') !== -1);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
