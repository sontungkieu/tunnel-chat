'use strict';
const http = require('node:http');
http.createServer(function (req, res) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="báo cáo tiếng việt.pdf"',
    'content-length': 5,
  });
  res.end('hello');
}).listen(3098, '127.0.0.1', function () { console.log('upstream gia o 3098'); });
