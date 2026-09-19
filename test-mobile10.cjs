'use strict';
const fs = require('node:fs');
const s = fs.readFileSync('D:/dev/dsh/bridge/ws-shim.js', 'utf8');
const c = function (n) { return s.split(n).length - 1; };
console.log('observer tren frame (attribute):', c("attributeFilter: ['data-sidebar-collapsed', 'style']") > 0);
console.log('khong chen vao cay React       :', c('insertAdjacentElement') === 0);
console.log('chi ghi attribute khi doi      :', c("hasAttribute('data-dsh-mobile-open') !== wantOpen") > 0);
console.log('bo ghi body moi khung hinh     :', c("document.body.toggleAttribute('data-dsh-mobile-open', !collapsed)") === 0);
try { new Function(s); console.log('syntax OK'); } catch (e) { console.log('SYNTAX ERROR:', e.message); }
