'use strict';
try {
  new Response('x', { headers: { 'content-disposition': 'attachment; filename="báo cáo.pdf"' } });
  console.log('new Response: KHONG nem');
} catch (e) { console.log('new Response NEM:', e.constructor.name, '|', e.message.slice(0, 80)); }
try {
  const h = new Headers(); h.set('content-disposition', 'attachment; filename="báo.pdf"');
  console.log('Headers.set: KHONG nem ->', h.get('content-disposition'));
} catch (e) { console.log('Headers.set NEM:', e.constructor.name, '|', e.message.slice(0, 80)); }
