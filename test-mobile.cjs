'use strict';
const fs = require('node:fs');
const shim = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const i = shim.indexOf('function installMobileLayout');
console.log('co installMobileLayout:', i !== -1, '| co MOBILE_MODE:', shim.indexOf('MOBILE_MODE') !== -1);
// kiem tra CSS block can doi
const cssStart = shim.indexOf("var css = [", i);
const cssEnd = shim.indexOf("].join", cssStart);
const block = shim.slice(cssStart, cssEnd);
const open = (block.match(/\{/g) || []).length, close = (block.match(/\}/g) || []).length;
console.log('CSS: mo ngoac', open, '| dong ngoac', close, open === close ? '== CAN DOI' : 'LECH');
console.log('so selector:', (block.match(/html\[data-dsh-mobile\]/g) || []).length);
console.log('media max-width 1023:', block.indexOf('max-width: 1023px') !== -1);
console.log('an rail khi collapsed :', block.indexOf('display: none') !== -1);
console.log('drawer absolute       :', block.indexOf('position: absolute') !== -1);
console.log('nut FAB               :', shim.indexOf('dsh-mobile-fab') !== -1);
console.log('mac dinh TAT          :', shim.indexOf("localStorage.getItem('dsh.bridge.mobile') === '1'") !== -1);
