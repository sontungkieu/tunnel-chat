'use strict';
const http = require('node:http');
const s = http.createServer(function (req, res) {
  try {
    res.writeHead(200, { 'content-disposition': 'attachment; filename="báo cáo tiếng việt.pdf"' });
    res.end('ok');
  } catch (e) {
    console.log('writeHead NEM LOI:', e.code, '|', e.message.slice(0, 90));
    res.destroy();
  }
});
s.listen(0, '127.0.0.1', function () {
  const port = s.address().port;
  http.get({ host: '127.0.0.1', port: port, path: '/' }, function (res) { res.resume(); res.on('end', function () { s.close(); }); })
    .on('error', function (e) { console.log('client loi:', e.message); s.close(); });
  setTimeout(function () { console.log('(neu khong thay dong NAO o tren thi writeHead khong nem)'); process.exit(0); }, 800);
});
