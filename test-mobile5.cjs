'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const count = function (needle) { return s.split(needle).length - 1; };
console.log('--- kiem tra lai cho dung ---');
console.log("setItem mobile '1' (phai = 0):", count("setItem('dsh.bridge.mobile', '1')"));
console.log("removeItem mobile  (phai > 0):", count("removeItem('dsh.bridge.mobile')"));
console.log("ensureBackdrop     (phai > 0):", count('ensureBackdrop'));
console.log("backdrop click dong(phai > 0):", count("addEventListener('click', function () {\n        var t = railToggle();"));
console.log("insertAdjacentElement (=0)   :", count('insertAdjacentElement'));
console.log("MutationObserver (=0)        :", count('MutationObserver'));
console.log("body.appendChild(b) (>0)     :", count('document.body.appendChild(b)'));
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
