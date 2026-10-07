/*
 * worker-patch.js - duoc tiem vao dau Worker upload cua DSH.
 *
 * DSH upload attachment bang XMLHttpRequest (body la Blob) hoac fetch (body la
 * ReadableStream) trong mot Web Worker dung tu Blob. Proxy cong ty cat cac lan
 * truyen dai -> o day cat thanh nhieu POST nho qua dsh-bridge.
 *
 * Cac placeholder __PREFIX__ / __CHUNK_BYTES__ / __THRESHOLD_BYTES__ duoc
 * ws-shim.js thay bang gia tri thuc truoc khi tiem.
 */
(function () {
  'use strict';
  var PREFIX = '__PREFIX__';
  /* Worker duoc tao tu blob: URL. Trong blob worker, URL TUONG DOI khong
     phan giai duoc: fetch('/x') nem "Failed to parse URL" ngay tai cho, nen
     request khong bao gio cham toi bridge. Phai dung URL tuyet doi. */
  var ORIGIN = '__ORIGIN__';
  if (!/^https?:\/\//.test(ORIGIN)) {
    try {
      var fallbackOrigin = self.location && self.location.origin;
      if (fallbackOrigin && /^https?:\/\//.test(fallbackOrigin)) ORIGIN = fallbackOrigin;
    } catch (e) {}
  }
  function bridgeUrl(path) { return ORIGIN + PREFIX + path; }
  var CHUNK = __CHUNK_BYTES__;
  var THRESHOLD = __THRESHOLD_BYTES__;
  var UPLOAD_PATH = '/api/session/uploadFileBinary';
  var MAX_BUFFER = 256 * 1024 * 1024;

  function isUploadUrl(url) {
    try { return String(url).indexOf(UPLOAD_PATH) !== -1; } catch (e) { return false; }
  }

  /* Bao loi that su tu trong worker ve bridge (worker khong dung chung
     console voi trang). */
  function reportWorker(kind, data) {
    try {
      fetch(bridgeUrl('/clientlog'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind, data: data, from: 'upload-worker', origin: ORIGIN }),
        credentials: 'same-origin',
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function postJson(path, obj) {
    return fetch(bridgeUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obj),
      credentials: 'same-origin'
    }).then(function (r) {
      if (r.ok) return r.json().catch(function () { return {}; });
      /* init that bai: phan biet proxy chen HTML voi loi JSON tu bridge. */
      return r.text().then(function (t) {
        var ct = '';
        try { ct = String(r.headers.get('content-type') || ''); } catch (e) {}
        var isProxy = ct.toLowerCase().indexOf('application/json') === -1;
        var snippet = String(t || '').replace(/\s+/g, ' ').slice(0, 160);
        throw new Error((isProxy ? 'proxy-block HTTP ' : 'HTTP ') + r.status + ' ' + snippet);
      }, function () { throw new Error('HTTP ' + r.status); });
    });
  }

  function sendChunked(url, method, headers, blob, onProgress) {
    return postJson('/blob/init', { url: url, method: method, headers: headers, size: blob.size }).then(function (init) {
      var bid = init.bid;
      var seq = 0;
      var offset = 0;
      var fallbackReported = false;
      var shrinkReported = false;
      /* Proxy chen trang HTML (Squid) thay vi de bridge tra JSON. Nhan dien
         de phan biet voi loi that tu bridge (luon JSON) -> loi bridge thi
         fail nhanh, loi proxy thi doi dang / co manh / thu lai. */
      function proxyBlocked(r) {
        if (!r || r.ok) return false;
        var ct = '';
        try { ct = String(r.headers.get('content-type') || ''); } catch (e) {}
        return ct.toLowerCase().indexOf('application/json') === -1;
      }
      function next() {
        if (offset >= blob.size) return Promise.resolve();
        var thisSeq = seq;

        function raw(sl) {
          return fetch(bridgeUrl('/blob/chunk?bid=' + encodeURIComponent(bid) + '&seq=' + thisSeq), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: sl,
            credentials: 'same-origin'
          });
        }
        /* Nhieu proxy cong ty chan POST nhi phan (application/octet-stream),
           tra 413 hoac cat ket noi. Khi manh raw that bai, gui lai chinh manh
           do dang JSON base64 - trong nhu mot loi goi API binh thuong. */
        function asBase64(sl) {
          return sl.arrayBuffer().then(function (buf) {
            var u8 = new Uint8Array(buf);
            var s = '';
            for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
            var b64;
            try { b64 = btoa(s); } catch (e) { throw new Error('base64 encode failed'); }
            return fetch(bridgeUrl('/blob/chunk?bid=' + encodeURIComponent(bid) + '&seq=' + thisSeq + '&enc=b64'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ b64: b64 }),
              credentials: 'same-origin'
            });
          });
        }

        /* Thu base64 truoc (JSON nho qua duoc proxy); raw chi la du phong
           khi base64 bi chan. Het dang thi co manh nho dan. */
        function attempt(size, tries, rawTried) {
          var useB64 = !rawTried;
          var sl = blob.slice(offset, offset + size);
          return (useB64 ? asBase64(sl) : raw(sl)).then(function (r) {
            if (r.ok) {
              offset += sl.size;
              seq += 1;
              if (onProgress) { try { onProgress(offset, blob.size); } catch (e) {} }
              return next();
            }
            /* Loi JSON tu bridge (vd 409 lech seq) thi doi dang/co manh vo ich. */
            if (!proxyBlocked(r)) throw new Error('blob chunk ' + thisSeq + ' -> HTTP ' + r.status);
            if (useB64 && !rawTried) {
              if (!fallbackReported) {
                fallbackReported = true;
                reportWorker('worker-chunk-fallback', {
                  seq: thisSeq, size: sl.size, http: r.status
                });
              }
              return attempt(sl.size, tries, true);
            }
            if (tries < 10 && sl.size > 1024) {
              var smaller = Math.max(1024, Math.floor(sl.size / 2));
              if (!shrinkReported) {
                shrinkReported = true;
                reportWorker('worker-chunk-shrink', {
                  seq: thisSeq, from: sl.size, to: smaller, http: r.status
                });
              }
              return attempt(smaller, tries + 1, false);
            }
            throw new Error('blob chunk ' + thisSeq + ' -> HTTP ' + r.status);
          }, function (err) {
            if (useB64 && !rawTried) {
              if (!fallbackReported) {
                fallbackReported = true;
                reportWorker('worker-chunk-fallback', {
                  seq: thisSeq, size: sl.size, message: String((err && err.message) || err)
                });
              }
              return attempt(sl.size, tries, true);
            }
            if (tries < 10 && sl.size > 1024) {
              var smaller = Math.max(1024, Math.floor(sl.size / 2));
              if (!shrinkReported) {
                shrinkReported = true;
                reportWorker('worker-chunk-shrink', {
                  seq: thisSeq, from: sl.size, to: smaller, message: String((err && err.message) || err)
                });
              }
              return attempt(smaller, tries + 1, false);
            }
            throw err;
          });
        }
        return attempt(Math.min(CHUNK, blob.size - offset), 0, false);
      }
      return next().then(function () {
        return fetch(bridgeUrl('/blob/finish?bid=' + encodeURIComponent(bid)), { method: 'POST', credentials: 'same-origin' });
      }).then(function (r) {
        return r.text().then(function (text) { return { status: r.status, body: text }; });
      }, function (e) {
        reportWorker('worker-chunk-failed', {
          message: String((e && e.message) || e),
          url: url,
          size: blob.size
        });
        try { fetch(bridgeUrl('/blob/abort?bid=' + encodeURIComponent(bid)), { method: 'POST', credentials: 'same-origin' }); } catch (e2) {}
        throw e;
      });
    }, function (e) {
      reportWorker('worker-blob-init-failed', {
        name: e && e.name,
        message: String((e && e.message) || e),
        origin: ORIGIN,
        prefix: PREFIX,
        chunk: CHUNK,
        stack: e && e.stack ? String(e.stack).slice(0, 500) : ''
      });
      throw e;
    });
  }

  /* ---- XMLHttpRequest gia cho body Blob ---- */
  var NativeXHR = self.XMLHttpRequest;
  function BridgeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.responseText = '';
    this.response = '';
    this.withCredentials = false;
    this.timeout = 0;
    this.upload = {};
    this.onload = null;
    this.onerror = null;
    this.onabort = null;
    this.onprogress = null;
  }
  BridgeXHR.prototype.open = function (method, url) {
    this._method = method || 'POST';
    this._url = url;
    this.readyState = 1;
  };
  BridgeXHR.prototype.setRequestHeader = function (name, value) {
    if (!this._headers) this._headers = {};
    this._headers[String(name).toLowerCase()] = String(value);
  };
  BridgeXHR.prototype.send = function (body) {
    var xhr = this;
    var size = body && typeof body.size === 'number' ? body.size : -1;
    var isUp = isUploadUrl(this._url);
    /* Moi upload di qua chunked, ke ca file nho: proxy chan ca POST truc
       tiep nho (403 policy theo URL/content-type), chi tha JSON nho va
       blob/* cua bridge. Chi giu duong native cho URL khong phai upload
       hoac body khong slice duoc. THRESHOLD khong con tac dung. */
    if (!isUp || size < 0) {
      var native = new NativeXHR();
      native.open(this._method, this._url);
      native.withCredentials = this.withCredentials;
      if (this._headers) {
        for (var k in this._headers) { try { native.setRequestHeader(k, this._headers[k]); } catch (e) {} }
      }
      native.upload.onprogress = function (p) { if (xhr.upload.onprogress) xhr.upload.onprogress(p); };
      native.onload = function () {
        xhr.status = native.status; xhr.statusText = native.statusText;
        xhr.responseText = native.responseText; xhr.response = native.response;
        xhr.readyState = 4;
        if (xhr.onload) xhr.onload();
      };
      native.onerror = function () { xhr.status = 0; if (xhr.onerror) xhr.onerror(); };
      native.onabort = function () { if (xhr.onabort) xhr.onabort(); };
      native.send(body);
      return;
    }
    try { reportWorker('worker-upload-start', { size: size, via: 'chunked' }); } catch (e) {}
    sendChunked(this._url, this._method, this._headers || {}, body, function (loaded, total) {
      if (xhr.upload.onprogress) xhr.upload.onprogress({ lengthComputable: true, loaded: loaded, total: total });
    }).then(function (res) {
      xhr.status = res.status;
      xhr.responseText = res.body;
      xhr.response = res.body;
      xhr.readyState = 4;
      if (xhr.onload) xhr.onload();
    }, function (e) {
      xhr.status = 0;
      if (xhr.onerror) xhr.onerror(e);
    });
  };
  BridgeXHR.prototype.abort = function () { if (this.onabort) this.onabort(); };
  try { self.XMLHttpRequest = BridgeXHR; } catch (e) {}

  /* ---- fetch cho body ReadableStream ---- */
  var nativeFetch = self.fetch ? self.fetch.bind(self) : null;
  if (nativeFetch) {
    self.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : ((input && input.url) || '');
      var body = init && init.body;
      if (isUploadUrl(url) && body && typeof body.getReader === 'function') {
        return new Promise(function (resolve, reject) {
          var parts = [];
          var total = 0;
          var reader = body.getReader();
          function pump() {
            reader.read().then(function (c) {
              if (c.done) {
                var blob;
                try { blob = new Blob(parts); } catch (e) { reject(e); return; }
                sendChunked(url, (init && init.method) || 'POST', init.headers || {}, blob, null).then(function (res) {
                  resolve(new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8' } }));
                }, reject);
                return;
              }
              total += (c.value && c.value.byteLength) || 0;
              if (total > MAX_BUFFER) { reject(new Error('dsh-bridge: body qua lon de chunk trong worker')); return; }
              parts.push(c.value);
              pump();
            }, reject);
          }
          pump();
        });
      }
      return nativeFetch(input, init);
    };
  }
})();
