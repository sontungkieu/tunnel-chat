"use strict";

const DB_NAME = "tunnel-chat-transfer-v1";
const STORE = "jobs";
let runtime = {token: "", chunkBytes: 2048, concurrency: 3, concurrencyMax: 8, retryLimit: 4, transferProtocol: "legacy"};
let processing = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, {keyPath: "id"});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = operation(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  } finally { database.close(); }
}

async function requestResult(request) {
  return await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getJob = id => transaction("readonly", store => requestResult(store.get(id)));
const putJob = job => transaction("readwrite", store => store.put(job));
const allJobs = () => transaction("readonly", store => requestResult(store.getAll()));

function encodePayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload || {}));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function blobToBase64Url(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function rpc(path, payload, attempts = runtime.retryLimit) {
  if (!runtime.token) throw new Error("waiting-auth");
  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const query = new URLSearchParams({p: encodePayload(payload)});
      const response = await fetch(`/f/${path}?${query}`, {
        cache: "no-store", headers: {"x-chat-token": runtime.token},
      });
      if (response.ok) return await response.json();
      const message = (await response.json().catch(() => null))?.error || `${response.status} ${response.statusText}`;
      const error = new Error(message);
      error.status = response.status;
      if (![408, 425, 429].includes(response.status) && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
    }
    if (attempt < attempts) await wait(Math.min(3000, 250 * (2 ** (attempt - 1))));
  }
  throw lastError || new Error("request failed");
}

async function broadcast(job) {
  const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true});
  for (const client of clients) client.postMessage({type: "tunnel-transfer-update", job});
}

async function update(job, changes) {
  Object.assign(job, changes, {updatedAt: Date.now()});
  await putJob(job);
  await broadcast({...job, blob: undefined});
}

async function runLimited(indexes, concurrency, task) {
  let cursor = 0;
  let firstError = null;
  async function worker() {
    while (!firstError) {
      const position = cursor++;
      if (position >= indexes.length) return;
      try { await task(indexes[position]); } catch (error) { firstError = error; }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, Math.max(1, indexes.length))}, worker));
  if (firstError) throw firstError;
}

function binaryQuery(path, values) {
  const query = new URLSearchParams(values);
  return `/f/${path}?${query.toString()}`;
}

async function binaryRequest(path, init = {}, attempts = runtime.retryLimit) {
  if (!runtime.token) throw new Error("waiting-auth");
  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const response = await fetch(path, {
        cache: "no-store", ...init,
        headers: {"x-chat-token": runtime.token, ...(init.headers || {})},
      });
      if (response.ok) return await response.json();
      const message = (await response.json().catch(() => null))?.error || `${response.status} ${response.statusText}`;
      const error = new Error(message); error.status = response.status;
      if (![408, 425, 429].includes(response.status) && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
    }
    if (attempt < attempts) await wait(Math.min(5000, 300 * (2 ** (attempt - 1)) + Math.random() * 150));
  }
  throw lastError || new Error("request failed");
}

async function getBinarySource(job) {
  if (job.blob) return job.blob;
  if (!job.handle) throw new Error("waiting-for-file");
  if (job.handle.queryPermission && await job.handle.queryPermission({mode: "read"}) !== "granted") throw new Error("waiting-for-file");
  const file = await job.handle.getFile();
  if (file.name !== job.name || file.size !== job.size || (job.lastModified && file.lastModified !== job.lastModified)) {
    throw new Error("waiting-for-file");
  }
  return file;
}

async function digestChunk(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodeMissingRanges(value) {
  if (!value) return [];
  const result = [];
  for (const item of String(value).split(",").filter(Boolean)) {
    const parts = item.split("-").map(Number);
    if (parts.length === 1 && Number.isInteger(parts[0])) result.push(parts[0]);
    else if (parts.length === 2 && Number.isInteger(parts[0]) && Number.isInteger(parts[1])) {
      for (let index = parts[0]; index <= parts[1]; index += 1) result.push(index);
    }
  }
  return result;
}

async function uploadBinaryJob(job) {
  const source = await getBinarySource(job);
  const chunkBytes = Number(job.chunkBytes || runtime.chunkBytes || 8 * 1024 * 1024);
  const totalChunks = Math.max(1, Math.ceil(job.size / chunkBytes));
  try {
    if (!job.uploadId || job.protocol !== "binary-v2") {
      const started = await binaryRequest("/f/upload/start-binary", {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({directory: job.directory, filename: job.name, mime_type: job.mimeType, size: job.size}),
      }, 1);
      job.uploadId = Number(started.upload_id); job.nonce = String(started.nonce);
      job.protocol = "binary-v2"; job.chunkBytes = Number(started.chunk_bytes || chunkBytes);
      job.totalChunks = Number(started.total_chunks ?? totalChunks);
      await putJob(job);
    }
    const status = await binaryRequest(binaryQuery("upload/status-binary", {upload_id: job.uploadId, nonce: job.nonce}));
    const missing = Array.isArray(status.missing) ? status.missing.map(Number) : decodeMissingRanges(status.missing_ranges);
    const startedAt = Date.now();
    let completedBytes = Number(status.received_bytes || 0);
    const resumedBytes = completedBytes;
    let laneCount = Math.max(1, Math.min(Number(runtime.concurrency || 4), Number(runtime.concurrencyMax || 8)));
    await update(job, {state: "uploading", error: "", protocol: "binary-v2", progress: job.size ? completedBytes / job.size * 100 : 0,
      receivedBytes: completedBytes, laneCount, detail: "Đang truyền binary-v2"});
    let cursor = 0;
    let firstError = null;
    let progressUpdatedAt = 0;
    let progressChain = Promise.resolve();
    function reportProgress(force = false) {
      const now = Date.now();
      if (!force && now - progressUpdatedAt < 250) return;
      progressUpdatedAt = now;
      const bytes = completedBytes;
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const speed = Math.max(0, bytes - resumedBytes) / elapsed;
      progressChain = progressChain.then(() => update(job, {
        progress: job.size ? bytes / job.size * 100 : 100, receivedBytes: bytes,
        speedBytesPerSecond: speed, etaSeconds: speed ? Math.max(0, (job.size - bytes) / speed) : null,
        laneCount, detail: `${laneCount} luồng · ${Math.round(bytes / Math.max(1, job.size) * 100)}%`,
      }));
    }
    async function lane() {
      while (!firstError) {
        const position = cursor++;
        if (position >= missing.length) return;
        const chunkIndex = missing[position];
        try {
          const start = chunkIndex * Number(job.chunkBytes);
          const end = Math.min(job.size, start + Number(job.chunkBytes));
          const buffer = await source.slice(start, end).arrayBuffer();
          const hash = await digestChunk(buffer);
          const chunkPath = binaryQuery("upload/chunk-binary", {
            upload_id: job.uploadId, nonce: job.nonce, chunk_index: chunkIndex,
          });
          const chunkInit = {body: buffer, headers: {
            "content-type": "application/octet-stream", "content-range": `bytes ${start}-${end - 1}/${job.size}`,
            "x-chunk-sha256": hash,
          }};
          try {
            await binaryRequest(chunkPath, {method: "PUT", ...chunkInit});
          } catch (error) {
            if (error.status !== 403 && error.status !== 405) throw error;
            await binaryRequest(chunkPath, {method: "POST", ...chunkInit});
          }
          completedBytes += buffer.byteLength;
          reportProgress(completedBytes >= job.size);
        } catch (error) { firstError = error; }
      }
    }
    await Promise.all(Array.from({length: laneCount}, lane));
    await progressChain;
    if (firstError) throw firstError;
    await update(job, {state: "finishing", progress: 100, detail: "Đang kiểm tra và hoàn tất trên máy cá nhân"});
    const finished = await binaryRequest("/f/upload/finish-binary", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({upload_id: job.uploadId, nonce: job.nonce, sha256: "server"}),
    }, 1);
    await update(job, {state: "complete", progress: 100, receivedBytes: job.size, result: finished.file,
      detail: finished.file?.path || job.name, blob: null, handle: null});
    return true;
  } catch (error) {
    if (error.status === 404 || error.status === 405 || /waiting-for-file/.test(error.message)) {
      if (error.status === 404 || error.status === 405) { job.protocol = "legacy"; await putJob(job); return await uploadLegacyJob(job); }
      await update(job, {state: "waiting-file", detail: "Chọn lại đúng file để tiếp tục", error: ""});
      return false;
    }
    if (error.message === "cancelled") return true;
    if (error.message === "waiting-auth" || error.status === 401) {
      runtime.token = ""; await update(job, {state: "waiting-auth", detail: "Mở lại trang đã xác thực để tiếp tục"}); return false;
    }
    await update(job, {state: "failed", error: String(error.message || error), detail: "Upload gặp lỗi"});
    return true;
  }
}

async function uploadJob(job) {
  if (job.kind === "file" && runtime.transferProtocol === "binary-v2" && job.protocol !== "legacy") {
    await update(job, {state: "uploading", error: "", detail: "Đang chuẩn bị upload binary-v2"});
    return await uploadBinaryJob(job);
  }
  return await uploadLegacyJob(job);
}

async function uploadLegacyJob(job, resetAttempts = 0) {
  if (!runtime.token) { await update(job, {state: "waiting-auth", detail: "Đang chờ access token"}); return false; }
  try {
    await update(job, {state: "uploading", error: "", detail: "Đang chuẩn bị upload"});
    const totalChunks = Math.max(1, Math.ceil(job.size / runtime.chunkBytes));
    const isNote = job.kind === "note";
    const uploadPath = isNote ? "note/upload" : "upload";
    if (!job.uploadId) {
      const started = await rpc(`${uploadPath}/start`, isNote ? {
        title: job.title, size: job.size, total_chunks: totalChunks, body_encoding: "base64url",
      } : {
        directory: job.directory, filename: job.name, mime_type: job.mimeType,
        size: job.size, total_chunks: totalChunks, body_encoding: "base64url",
      }, 1);
      job.uploadId = Number(started.upload_id);
      await putJob(job);
    }
    let status;
    try { status = await rpc(`${uploadPath}/status`, {upload_id: job.uploadId}); }
    catch (error) {
      if (/unknown (?:file|note) upload/i.test(error.message)) {
        if (resetAttempts >= 1) throw error;
        job.uploadId = null; await putJob(job); return await uploadJob(job, resetAttempts + 1);
      }
      throw error;
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const missing = Array.isArray(status.missing) ? status.missing.map(Number) : [];
      if (!missing.length) break;
      let completed = totalChunks - missing.length;
      let progressChain = Promise.resolve();
      await runLimited(missing, Math.max(1, runtime.concurrency), async chunkIndex => {
        const latest = await getJob(job.id);
        if (!latest || latest.state === "cancelled") throw new Error("cancelled");
        const offset = chunkIndex * runtime.chunkBytes;
        await rpc(`${uploadPath}/chunk`, {
          upload_id: job.uploadId, chunk_index: chunkIndex,
          body: await blobToBase64Url(job.blob.slice(offset, offset + runtime.chunkBytes)),
        });
        const afterChunk = await getJob(job.id);
        if (!afterChunk || afterChunk.state === "cancelled") throw new Error("cancelled");
        completed += 1;
        const receivedBytes = Math.min(job.size, completed * runtime.chunkBytes);
        const progressSnapshot = completed;
        progressChain = progressChain.then(() => update(job, {progress: progressSnapshot / totalChunks * 100, receivedBytes,
          detail: `${progressSnapshot}/${totalChunks} phần`}));
        await progressChain;
      });
      status = await rpc(`${uploadPath}/status`, {upload_id: job.uploadId});
    }
    if (status.missing?.length) throw new Error(`Upload còn thiếu ${status.missing.length} phần`);
    const latest = await getJob(job.id);
    if (!latest || latest.state === "cancelled") return true;
    await update(job, {state: "finishing", progress: 100, detail: "Đang hoàn tất trên máy cá nhân"});
    const finished = await rpc(`${uploadPath}/finish`, {upload_id: job.uploadId}, 1);
    const result = isNote ? finished.note : finished.file;
    await update(job, {state: "complete", progress: 100, receivedBytes: job.size,
      result, detail: result?.path || result?.title || job.name, blob: null});
    return true;
  } catch (error) {
    if (error.message === "cancelled") return true;
    if (error.message === "waiting-auth" || error.status === 401) {
      runtime.token = "";
      await update(job, {state: "waiting-auth", detail: "Mở lại trang đã xác thực để tiếp tục"});
      return false;
    }
    await update(job, {state: "failed", error: String(error.message || error), detail: "Upload gặp lỗi"});
    return true;
  }
}

async function processQueue() {
  if (processing) return processing;
  processing = (async () => {
    try {
      while (true) {
        const jobs = (await allJobs()).filter(job => ["queued", "uploading", "finishing", "waiting-auth"].includes(job.state))
          .sort((a, b) => a.createdAt - b.createdAt);
        if (!jobs.length) break;
        if (!runtime.token) {
          for (const job of jobs) if (job.state !== "waiting-auth") {
            await update(job, {state: "waiting-auth", detail: "Đang chờ access token"});
          }
          break;
        }
        const shouldContinue = await uploadJob(jobs[0]);
        if (!shouldContinue) break;
      }
    } finally { processing = null; }
  })();
  return processing;
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  event.waitUntil((async () => {
    const message = event.data || {};
    if (message.type === "configure") {
      runtime = {...runtime, ...message.config, token: String(message.config?.token || runtime.token || "")};
    } else if (message.type === "clear-auth") {
      runtime.token = "";
    } else if (message.type === "cancel") {
      const job = await getJob(message.id);
      if (job && !["complete", "cancelled"].includes(job.state)) await update(job, {state: "cancelled", detail: "Đã hủy"});
    } else if (message.type === "retry") {
      const job = await getJob(message.id);
      if (job && ["failed", "waiting-auth", "cancelled"].includes(job.state)) await update(job, {state: "queued", error: "", detail: "Đang chờ upload"});
    } else if (message.type === "kick") {
      // The queue is already persisted by the page.
    }
    await processQueue();
  })());
});
