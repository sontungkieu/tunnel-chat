'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
console.log('an nut khi drawer mo:', s.indexOf("if (!collapsed) { b.style.display = 'none'; return; }") !== -1);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
