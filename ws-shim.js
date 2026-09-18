/*
 * ws-shim.js - tiem vao trang DSH boi dsh-bridge, chay TRUOC bundle cua DSH.
 *
 * DSH mo WebSocket toi /api/remote.mux va khong co fallback HTTP. Shim nay
 * thay window.WebSocket bang lop:
 *   - auto   : thu WebSocket that truoc; neu bi chan -> tu chuyen sang polling
 *   - native : luon dung WebSocket that
 *   - poll   : luon dung polling (request ngan, khong ket noi dai)
 *
 * Chon che do: ?transport=poll tren URL, hoac localStorage 'dsh.bridge.transport'.
 * Chi can thiep URL ket thuc bang /api/remote.mux; moi WebSocket khac di nguyen.
 */
(function () {
  'use strict';

  var NativeWS = window.WebSocket;
  function bootLog() {
    try { console.info.apply(console, ['[dsh-bridge]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  /* ---- Polyfill API nen tang ma DSH client dung nhung browser cu con thieu ----
     Do duoc tu thuc te: browser cong ty thieu AbortSignal.any (Chrome 116) va
     Promise.withResolvers (Chrome 119), keo theo "control stream failed" va
     vong lap reconnect. Ham nay SELF-CONTAINED vi con duoc stringify de tiem
     vao Worker PDF. Moi polyfill chi chay khi API vang mat. */
  function platformPolyfills() {
    var g = globalThis;
    if (typeof Promise.withResolvers !== 'function') {
      Promise.withResolvers = function () {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      };
    }
    if (typeof Promise.try !== 'function') {
      Promise.try = function (fn) {
        var args = Array.prototype.slice.call(arguments, 1);
        return new Promise(function (resolve) { resolve(fn.apply(void 0, args)); });
      };
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
      AbortSignal.any = function (signals) {
        var controller = new AbortController();
        var list = Array.prototype.slice.call(signals || []);
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].aborted) { controller.abort(list[i].reason); return controller.signal; }
        }
        for (var j = 0; j < list.length; j++) {
          (function (sig) {
            if (!sig) return;
            sig.addEventListener('abort', function () { controller.abort(sig.reason); }, { once: true });
          })(list[j]);
        }
        return controller.signal;
      };
    }
    if (typeof URL !== 'undefined' && typeof URL.parse !== 'function') {
      URL.parse = function (url, base) { try { return new URL(url, base); } catch (e) { return null; } };
    }
    if (typeof Array.prototype.findLast !== 'function') {
      Array.prototype.findLast = function (fn, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) { if (fn.call(thisArg, this[i], i, this)) return this[i]; }
        return void 0;
      };
    }
    if (typeof Array.prototype.findLastIndex !== 'function') {
      Array.prototype.findLastIndex = function (fn, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) { if (fn.call(thisArg, this[i], i, this)) return i; }
        return -1;
      };
    }
    if (typeof Array.prototype.at !== 'function') {
      Array.prototype.at = function (n) {
        n = Math.trunc(n) || 0;
        if (n < 0) n += this.length;
        return (n < 0 || n >= this.length) ? void 0 : this[n];
      };
    }
    if (typeof String.prototype.at !== 'function') {
      String.prototype.at = function (n) {
        n = Math.trunc(n) || 0;
        if (n < 0) n += this.length;
        return (n < 0 || n >= this.length) ? void 0 : this.charAt(n);
      };
    }
    if (typeof Object.hasOwn !== 'function') {
      Object.hasOwn = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
    }
    if (typeof String.prototype.replaceAll !== 'function') {
      String.prototype.replaceAll = function (search, replacement) {
        if (Object.prototype.toString.call(search) === '[object RegExp]') {
          if (!search.global) throw new TypeError('replaceAll requires a global RegExp');
          return String.prototype.replace.call(this, search, replacement);
        }
        var needle = String(search);
        return String.prototype.split.call(this, needle).join(
          typeof replacement === 'function' ? replacement(needle) : String(replacement)
        );
      };
    }
    if (typeof g.structuredClone !== 'function') {
      g.structuredClone = function (value) { return value === void 0 ? value : JSON.parse(JSON.stringify(value)); };
    }
  }
  var COMPAT_SRC = '(' + platformPolyfills.toString() + ')();' + '(' + iteratorPolyfill.toString() + ')();';
  try { platformPolyfills(); iteratorPolyfill(); } catch (e) { bootLog('compat loi: ' + (e && e.message)); }
  if (!NativeWS) return;

  var PREFIX = '/__dsh_bridge';
  var MUX_SUFFIX = '/api/remote.mux';
  var LS_KEY = 'dsh.bridge.transport';
  var POLL_MS = 600;
  var NATIVE_PROBE_MS = 5000;

  function log() {
    try { console.info.apply(console, ['[dsh-bridge]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  function qs(name) {
    try { return new URL(window.location.href).searchParams.get(name); } catch (e) { return null; }
  }
  function readMode() {
    var q = qs('transport');
    if (q === 'reset') { try { localStorage.removeItem(LS_KEY); } catch (e) {} return null; }
    if (q === 'auto' || q === 'native' || q === 'poll') {
      try { localStorage.setItem(LS_KEY, q); } catch (e) {}
      return q;
    }
    try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
  }
  function writeMode(m) {
    try { localStorage.setItem(LS_KEY, m); } catch (e) {}
  }
  function isMuxUrl(url) {
    try { return new URL(String(url), window.location.href).pathname.slice(-MUX_SUFFIX.length) === MUX_SUFFIX; }
    catch (e) { return String(url).indexOf(MUX_SUFFIX) !== -1; }
  }
  function post(path, obj) {
    return fetch(PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obj || {}),
      cache: 'no-store',
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var mode = readMode() || 'auto';
  var abnormalCloses = 0;

  /* ---- upload chunking: tiem lop cat nho vao Worker upload cua DSH ---- */
  var chunkBytes = (function () {
    var q = qs('chunk');
    if (q === 'reset') { try { localStorage.removeItem('dsh.bridge.chunk'); } catch (e) {} return 0; }
    if (q && /^[0-9]+$/.test(q)) { var v = Number(q); try { localStorage.setItem('dsh.bridge.chunk', String(v)); } catch (e) {} return v; }
    try { return Number(localStorage.getItem('dsh.bridge.chunk')) || 0; } catch (e) { return 0; }
  })();
  if (!chunkBytes || chunkBytes < 1024) chunkBytes = 32768;
  if (chunkBytes > 1048576) chunkBytes = 1048576;
  var thresholdBytes = 262144;

  /* ---- polyfill Iterator (ES2025) cho browser cu ----
     plugin documentpreview nhung PDF.js dung thang global Iterator:
       if (typeof Iterator.prototype.join !== "function") ...
     Browser thieu Iterator (Chrome/Edge < 122, Firefox < 131) nem
     "ReferenceError: Iterator is not defined" -> ca plugin khong import duoc.
     Polyfill nay chi chay khi Iterator vang mat, nen browser moi khong bi anh huong. */
  function iteratorPolyfill() {
    var g = globalThis;
    if (typeof g.Iterator !== 'undefined') return;
    var proto;
    try { proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); } catch (e) { return; }
    if (!proto) return;
    function def(name, fn) {
      try {
        if (typeof proto[name] !== 'function') Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
      } catch (e) {}
    }
    def('map', function (fn) { var src = this; return (function* () { var i = 0; for (var v of src) yield fn(v, i++); })(); });
    def('filter', function (fn) { var src = this; return (function* () { var i = 0; for (var v of src) if (fn(v, i++)) yield v; })(); });
    def('take', function (n) { var src = this; return (function* () { var i = 0; for (var v of src) { if (i++ >= n) return; yield v; } })(); });
    def('drop', function (n) { var src = this; return (function* () { var i = 0; for (var v of src) { if (i++ >= n) yield v; } })(); });
    def('flatMap', function (fn) { var src = this; return (function* () { var i = 0; for (var v of src) { var r = fn(v, i++); for (var x of r) yield x; } })(); });
    def('toArray', function () { return Array.from(this); });
    def('forEach', function (fn) { var i = 0; for (var v of this) fn(v, i++); });
    def('some', function (fn) { var i = 0; for (var v of this) { if (fn(v, i++)) return true; } return false; });
    def('every', function (fn) { var i = 0; for (var v of this) { if (!fn(v, i++)) return false; } return true; });
    def('find', function (fn) { var i = 0; for (var v of this) { if (fn(v, i++)) return v; } return void 0; });
    def('reduce', function (fn, init) {
      var acc = init;
      var first = arguments.length < 2;
      var i = 0;
      for (var v of this) { if (first) { acc = v; first = false; continue; } acc = fn(acc, v, i++); }
      return acc;
    });
    def('join', function (sep) { return Array.from(this).join(sep === void 0 ? ',' : sep); });
    var Iter = {};
    Object.defineProperty(Iter, 'prototype', { value: proto, enumerable: false, configurable: false, writable: false });
    Iter.from = function (value) {
      if (value === null || value === void 0) throw new TypeError('Iterator.from requires an iterable');
      if (typeof value.next === 'function') return value;
      return value[Symbol.iterator]();
    };
    Iter.of = function () { return Array.prototype[Symbol.iterator].call(arguments); };
    Object.defineProperty(g, 'Iterator', { value: Iter, writable: true, configurable: true });
  }
  log('compat: Iterator=' + (typeof window.Iterator) + ', withResolvers=' + (typeof Promise.withResolvers) + ', AbortSignal.any=' + (typeof (window.AbortSignal && AbortSignal.any)) + ', URL.parse=' + (typeof URL.parse));


  (function installUploadChunking() {
    var NativeBlob = window.Blob;
    var patch = window.__DSH_BRIDGE_WORKER_PATCH__;
    if (!NativeBlob || typeof patch !== 'string' || patch.length === 0) {
      log('khong co worker patch -> upload giu nguyen');
      return;
    }
    function PatchedBlob(parts, options) {
      try {
        if (Array.isArray(parts) && parts.length === 1 && typeof parts[0] === 'string') {
          var text = parts[0];
          if (text.indexOf('fileUploadWorker') !== -1) {
            var src = patch.split('__PREFIX__').join(PREFIX).split('__CHUNK_BYTES__').join(String(chunkBytes)).split('__THRESHOLD_BYTES__').join(String(thresholdBytes));
            log('tiem lop chunking vao worker upload (chunk ' + chunkBytes + 'B, nguong ' + thresholdBytes + 'B)');
            parts = [src + ';' + text];
          } else if (text.indexOf('Iterator.prototype.join') !== -1) {
            log('tiem compat polyfill vao worker PDF');
            parts = [COMPAT_SRC + ';' + text];
          }
        }
      } catch (e) { log('loi tiem worker patch:', e && e.message); }
      return new NativeBlob(parts, options);
    }
    PatchedBlob.prototype = NativeBlob.prototype;
    try { Object.setPrototypeOf(PatchedBlob, NativeBlob); } catch (e) {}
    window.Blob = PatchedBlob;
  })();

  /* ---- RPC lon: cat thanh nhieu POST nho (proxy cong ty gioi han body) ----
     Proxy cong ty co the tra 413 cho POST qua lon (thuong gap khi dan anh vao
     o chat: anh duoc base64 ngay trong /api/session/prompt). Shim chan fetch
     cua trang va day body qua giao thuc blob cua bridge. */
  var RPC_THRESHOLD = (function () {
    var q = qs('rpcchunk');
    if (q === 'reset') { try { localStorage.removeItem('dsh.bridge.rpcsize'); } catch (e) {} return 0; }
    if (q && /^[0-9]+$/.test(q)) { var v = Number(q); try { localStorage.setItem('dsh.bridge.rpcsize', String(v)); } catch (e) {} return v; }
    try { return Number(localStorage.getItem('dsh.bridge.rpcsize')) || 0; } catch (e) { return 0; }
  })();
  if (!RPC_THRESHOLD || RPC_THRESHOLD < 2048) RPC_THRESHOLD = 8192;
  if (RPC_THRESHOLD > 64 * 1024 * 1024) RPC_THRESHOLD = 64 * 1024 * 1024;

  /* Manh gui RPC: bat dau 16 KB roi TU GIAM khi bi 413 (proxy moi noi khac nhau,
     va khong biet truoc tran). Giam den 4 KB, ghi nho cho lan sau. */
  var RPC_CHUNK_KEY = 'dsh.bridge.rpcchunk';
  var RPC_CHUNK = (function () {
    try { var v = Number(localStorage.getItem(RPC_CHUNK_KEY)) || 0; if (v >= 4096 && v <= 1048576) return v; } catch (e) {}
    return 16384;
  })();

  function chunkedRpc(path, headers, body, bytes) {
    var chunkSize = RPC_CHUNK;
    return post('/blob/init', { url: path, method: 'POST', headers: headers, size: bytes }).then(function (j) {
      var bid = j.bid;
      var blob = new Blob([body]);
      var seq = 0;
      var off = 0;
      function sendOne() {
        if (off >= bytes) return Promise.resolve();
        var slice = blob.slice(off, Math.min(off + chunkSize, bytes));
        var thisSeq = seq;
        return fetch(PREFIX + '/blob/chunk?bid=' + encodeURIComponent(bid) + '&seq=' + thisSeq, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: slice,
          credentials: 'same-origin'
        }).then(function (r) {
          if (r.status === 413 && chunkSize > 4096) {
            chunkSize = Math.max(4096, Math.floor(chunkSize / 2));
            RPC_CHUNK = chunkSize;
            try { localStorage.setItem(RPC_CHUNK_KEY, String(chunkSize)); } catch (e) {}
            log('manh ' + (chunkSize * 2) + 'B bi 413 -> giam con ' + chunkSize + 'B, gui lai');
            return sendOne();
          }
          if (!r.ok) throw new Error('dsh-bridge: rpc chunk ' + thisSeq + ' -> HTTP ' + r.status);
          off += slice.size;
          seq += 1;
          return sendOne();
        });
      }
      return sendOne().then(function () {
        return fetch(PREFIX + '/blob/finish?bid=' + encodeURIComponent(bid), { method: 'POST', credentials: 'same-origin' });
      }).then(function (r) {
        return r.text().then(function (text) {
          return new Response(text, {
            status: r.status,
            statusText: r.statusText,
            headers: { 'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8' }
          });
        });
      });
    });
  }

  (function installRpcChunking() {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function') return;
    window.fetch = function (input, init) {
      try {
        var raw = '';
        if (typeof input === 'string') raw = input;
        else if (input && typeof input.href === 'string') raw = input.href;
        else if (input && typeof input.url === 'string') raw = input.url;
        if (raw && raw.indexOf('/api/') !== -1 && init && init.method === 'POST' && typeof init.body === 'string') {
          var bytes = new Blob([init.body]).size;
          if (bytes > RPC_THRESHOLD) {
            var u = new URL(raw, window.location.href);
            var hdrs = {};
            var h = init.headers;
            if (h && typeof h.forEach === 'function') h.forEach(function (v, k) { hdrs[String(k).toLowerCase()] = String(v); });
            else if (h) { for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) hdrs[String(k).toLowerCase()] = String(h[k]); } }
            log('RPC ' + bytes + 'B > nguong ' + RPC_THRESHOLD + 'B -> cat nho: ' + u.pathname);
            return chunkedRpc(u.pathname + u.search, hdrs, init.body, bytes);
          }
        }
      } catch (e) { log('rpc chunk check loi: ' + (e && e.message)); }
      return nativeFetch.apply(this, arguments);
    };
    log('RPC chunking: nguong ' + RPC_THRESHOLD + 'B, manh dau ' + RPC_CHUNK + 'B, tu giam khi 413 (doi bang ?rpcchunk=)');
  })();

  function BridgeSocket(url, protocols) {
    if (!isMuxUrl(url)) return new NativeWS(url, protocols);
    var self = this;
    this.url = String(url);
    this.protocols = protocols;
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._l = { open: [], message: [], close: [], error: [] };
    this._sid = null;
    this._cursor = 0;
    this._timer = null;
    this._tx = Promise.resolve();
    this._dead = false;
    this._fellBack = false;
    this._pollStarted = false;
    this._nativeHandlers = null;
    this._closeEmitted = false;
    this._opened = false;
    this._messages = 0;
    this._transport = mode;

    if (mode === 'poll') this._startPoll();
    else this._startNative(mode === 'auto');
  }

  BridgeSocket.CONNECTING = 0;
  BridgeSocket.OPEN = 1;
  BridgeSocket.CLOSING = 2;
  BridgeSocket.CLOSED = 3;
  BridgeSocket.prototype.CONNECTING = 0;
  BridgeSocket.prototype.OPEN = 1;
  BridgeSocket.prototype.CLOSING = 2;
  BridgeSocket.prototype.CLOSED = 3;

  BridgeSocket.prototype.addEventListener = function (type, fn) {
    if (this._l[type] && fn) this._l[type].push(fn);
  };
  BridgeSocket.prototype.removeEventListener = function (type, fn) {
    var a = this._l[type];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i !== -1) a.splice(i, 1);
  };
  BridgeSocket.prototype.dispatchEvent = function (ev) { this._emit(ev && ev.type, ev); };
  BridgeSocket.prototype._emit = function (type, ev) {
    if (type === 'open' && this._opened) return;
    if (type === 'open') this._opened = true;
    if (type === 'close') {
      if (this._closeEmitted) return;
      this._closeEmitted = true;
    }
    if (type === 'message') this._messages += 1;
    ev = ev || {};
    if (typeof ev.type !== 'string') ev = { type: type, data: ev.data, code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
    var handler = this['on' + type];
    if (typeof handler === 'function') { try { handler.call(this, ev); } catch (e) { log(type + ' handler threw', e); } }
    var list = this._l[type] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(this, ev); } catch (e) { log(type + ' listener threw', e); }
    }
  };

  /* ---------------- native transport ---------------- */

  BridgeSocket.prototype._detachNative = function () {
    var ws = this._native;
    var h = this._nativeHandlers;
    this._native = null;
    this._nativeHandlers = null;
    if (!ws) return ws;
    if (h) {
      try {
        ws.removeEventListener('open', h.open);
        ws.removeEventListener('message', h.message);
        ws.removeEventListener('close', h.close);
        ws.removeEventListener('error', h.error);
      } catch (e) {}
    }
    return ws;
  };

  BridgeSocket.prototype._startNative = function (allowFallback) {
    var self = this;
    var ws;
    try {
      ws = new NativeWS(this.url, this.protocols);
    } catch (e) {
      return this._fallbackToPoll('native constructor threw: ' + (e && e.message));
    }
    this._native = ws;
    var probe = setTimeout(function () {
      if (!self._opened && !self._dead) self._fallbackToPoll('native open timeout');
    }, NATIVE_PROBE_MS);
    var h = {
      open: function () {
        clearTimeout(probe);
        self._nativeOpenedAt = Date.now();
        self._transport = 'native';
        self.readyState = 1;
        self._emit('open', {});
      },
      message: function (ev) { self._emit('message', { data: ev.data }); },
      close: function (ev) {
        clearTimeout(probe);
        if (!self._opened) {
          if (allowFallback) { self._fallbackToPoll('native dong truoc khi mo (code ' + ev.code + ')'); return; }
          self._detachNative();
          self.readyState = 3;
          self._emit('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
          return;
        }
        if (ev.code === 1006 || ev.code === 0 || ev.code === undefined) {
          abnormalCloses += 1;
          if (self._messages === 0 || abnormalCloses >= 2) {
            if (mode === 'auto') { mode = 'poll'; writeMode('poll'); log('WebSocket native bi cat bat thuong -> cac socket sau dung polling'); }
          }
        }
        self._detachNative();
        self.readyState = 3;
        self._emit('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      },
      error: function () {
        clearTimeout(probe);
        if (!self._opened && allowFallback) self._fallbackToPoll('native loi truoc khi mo');
        else self._emit('error', { message: 'native websocket error' });
      }
    };
    this._nativeHandlers = h;
    ws.addEventListener('open', h.open);
    ws.addEventListener('message', h.message);
    ws.addEventListener('close', h.close);
    ws.addEventListener('error', h.error);
  };

  BridgeSocket.prototype._fallbackToPoll = function (why) {
    if (this._fellBack || this._opened || this._dead) return;
    this._fellBack = true;
    log('chuyen sang polling:', why);
    if (mode === 'auto') { mode = 'poll'; writeMode('poll'); }
    this._transport = 'poll';
    var ws = this._detachNative();
    try { if (ws) ws.close(); } catch (e) {}
    this._startPoll();
  };

  /* ---------------- polling transport ---------------- */

  BridgeSocket.prototype._startPoll = function () {
    if (this._pollStarted) return;
    this._pollStarted = true;
    var self = this;
    log('mo polling session toi', this.url);
    post('/poll/open', {}).then(function (j) {
      if (self._dead) { post('/poll/close', { sid: j.sid }).catch(function () {}); return; }
      self._sid = j.sid;
      self._cursor = j.cursor || 0;
      self._pollMs = Number(j.pollMs) || POLL_MS;
      self.readyState = 1;
      self._emit('open', {});
      self._loop();
    }).catch(function (e) {
      self._fail(e);
    });
  };

  BridgeSocket.prototype._loop = function () {
    var self = this;
    if (this._dead || this.readyState !== 1) return;
    fetch(PREFIX + '/poll/recv?sid=' + encodeURIComponent(this._sid) + '&cursor=' + this._cursor, {
      cache: 'no-store',
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    }).then(function (j) {
      if (self._dead) return;
      if (j.reset) { self._fail(new Error('bridge: outbox reset')); return; }
      self._cursor = j.cursor;
      var frames = j.frames || [];
      for (var i = 0; i < frames.length; i++) self._emit('message', { data: frames[i] });
      if (j.closed && frames.length === 0) { self._fail(new Error('bridge: upstream closed')); return; }
      var delay = j.more ? 0 : self._pollMs;
      self._timer = setTimeout(function () { self._loop(); }, delay);
    }).catch(function (e) {
      self._fail(e);
    });
  };

  BridgeSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new Error('dsh-bridge: socket chua mo');
    if (this._transport === 'native' && this._native) { this._native.send(data); return; }
    if (typeof data !== 'string') throw new Error('dsh-bridge: polling chi ho tro text frame');
    var self = this;
    this.bufferedAmount += data.length;
    this._tx = this._tx.then(function () {
      return post('/poll/send', { sid: self._sid, frames: [data] });
    }).then(function () {
      self.bufferedAmount = Math.max(0, self.bufferedAmount - data.length);
    }, function (e) {
      self.bufferedAmount = Math.max(0, self.bufferedAmount - data.length);
      self._fail(e);
    });
  };

  BridgeSocket.prototype.close = function (code, reason) {
    var self = this;
    if (this.readyState === 3) return;
    this.readyState = 2;
    this._dead = true;
    if (this._timer) clearTimeout(this._timer);
    var sid = this._sid;
    var native = this._native;
    var finish = function () {
      self.readyState = 3;
      self._emit('close', { code: code || 1000, reason: reason || '', wasClean: true });
    };
    if (native) { this._detachNative(); try { native.close(code, reason); } catch (e) {} finish(); return; }
    if (sid) { post('/poll/close', { sid: sid }).then(finish, finish); return; }
    finish();
  };

  BridgeSocket.prototype._fail = function (e) {
    if (this._closeEmitted) return;
    this._dead = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._sid) { var deadSid = this._sid; this._sid = null; try { post('/poll/close', { sid: deadSid }); } catch (e2) {} }
    this._emit('error', { message: String((e && e.message) || e) });
    this.readyState = 3;
    this._emit('close', { code: 1006, reason: 'bridge transport failure', wasClean: false });
  };

  window.WebSocket = BridgeSocket;
  window.__DSH_BRIDGE__ = {
    version: 1,
    mode: function () { return mode; },
    effective: function (sock) { return sock && sock._transport; },
    setMode: function (m) { writeMode(m); window.location.reload(); },
    sessions: function () { return { mode: mode, pollMs: POLL_MS, native: NativeWS ? 'available' : 'none' }; }
  };
  log('shim active, mode =', mode, '| doi che do: them ?transport=native hoac ?transport=poll vao URL');
})();
