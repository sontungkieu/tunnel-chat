'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
console.log('tu bat (coarse+hep) :', s.indexOf("matchMedia('(pointer: coarse)')") !== -1);
console.log('nho lua chon 0/1    :', s.indexOf("setItem('dsh.bridge.mobile', '0')") !== -1 && s.indexOf("setItem('dsh.bridge.mobile', '1')") !== -1);
console.log('van an toan        :', s.indexOf('insertAdjacentElement') === 0 || s.indexOf('insertAdjacentElement') === -1);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
