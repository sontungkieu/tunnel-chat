'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const c = function (n) { return s.split(n).length - 1; };
console.log('khai bao cot sidebar   :', c('grid-column: 1 / 2') > 0);
console.log('khai bao cot center    :', c('grid-column: 2 / 3') > 0);
console.log('khai bao cot rightbar  :', c('grid-column: 3 / 4') > 0);
console.log('an rail khi thu gon    :', c('[data-sidebar-collapsed] [class*="_sidebarCol"] { display: none') > 0);
console.log('backdrop               :', c('dsh-mobile-backdrop') >= 3);
console.log('khong insert vao React :', c('insertAdjacentElement') === 0);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
