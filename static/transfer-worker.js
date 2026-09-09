"use strict";

const DB_NAME = "tunnel-chat-transfer-v1";
const STORE = "jobs";
let runtime = {token: "", chunkBytes: 2048, concurrency: 3, retryLimit: 4};
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

async function uploadJob(job, resetAttempts = 0) {
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
