'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
console.log('neo vao tab cuoi    :', s.indexOf("querySelector('[role=\"tab\"]:last-of-type')") !== -1);
console.log('khong con neo tablist thô:', s.indexOf('var r = tabs.getBoundingClientRect();\n      if (r.width === 0 && r.height === 0) { b.style.display') === -1);
console.log('offset 8px          :', s.indexOf('r.right + 8') !== -1);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
