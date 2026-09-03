(function (global) {
  "use strict";

  const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

  function encodePayload(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload || {}));
    let binary = "";
    const batchSize = 0x8000;
    for (let index = 0; index < bytes.length; index += batchSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + batchSize));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function blobToBase64Url(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const batchSize = 0x8000;
    for (let index = 0; index < bytes.length; index += batchSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + batchSize));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function createRpc(options) {
    const apiBase = options.apiBase;
    const token = options.token;
    const defaultAttempts = Math.max(1, Number(options.retryLimit || 1));
    const sanitizeError = options.sanitizeError || (value => String(value || "request failed"));

    return async function rpc(path, payload = {}, requestOptions = {}) {
      const attempts = Math.max(1, Number(requestOptions.attempts || defaultAttempts));
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let response;
        try {
          const query = new URLSearchParams({token, p: encodePayload(payload)});
          response = await fetch(`${apiBase}/${path}?${query.toString()}`, {cache: "no-store"});
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt === attempts) throw lastError;
          await sleep(Math.min(3000, 250 * (2 ** (attempt - 1))));
          continue;
        }
        if (response.ok) return await response.json();
        const errorText = sanitizeError(await response.text() || `${response.status} ${response.statusText}`);
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        lastError = new Error(errorText);
        if (!retryable || attempt === attempts) throw lastError;
        await sleep(Math.min(3000, 250 * (2 ** (attempt - 1))));
      }
      throw lastError || new Error("request failed");
    };
  }

  async function runLimited(indexes, concurrency, task) {
    let cursor = 0;
    let firstError = null;
    async function worker() {
      while (!firstError) {
        const position = cursor;
        cursor += 1;
        if (position >= indexes.length) return;
        try {
          await task(indexes[position]);
        } catch (error) {
          firstError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, indexes.length));
    await Promise.all(Array.from({length: workerCount}, () => worker()));
    if (firstError) throw firstError;
  }

  async function uploadBlob(options) {
    const blob = options.blob;
    const chunkBytes = Math.max(1, Number(options.chunkBytes));
    const concurrency = Math.max(1, Number(options.concurrency || 1));
    const retryLimit = Math.max(1, Number(options.retryLimit || 1));
    const totalChunks = Math.max(1, Math.ceil(blob.size / chunkBytes));
    const onProgress = options.onProgress || (() => {});
    const paths = options.paths;
    const start = await options.rpc(
      paths.start,
      {...(options.startPayload || {}), size: blob.size, total_chunks: totalChunks, body_encoding: "base64url"},
      {attempts: 1},
    );
    const uploadId = Number(start.upload_id);
    let status = await options.rpc(paths.status, {upload_id: uploadId}, {attempts: retryLimit});

    for (let recoveryPass = 0; recoveryPass < 2; recoveryPass += 1) {
      const missing = Array.isArray(status.missing) ? status.missing.map(Number) : [];
      if (!missing.length) break;
      let completed = totalChunks - missing.length;
      try {
        await runLimited(missing, concurrency, async chunkIndex => {
          const offset = chunkIndex * chunkBytes;
          await options.rpc(
            paths.chunk,
            {
              upload_id: uploadId,
              chunk_index: chunkIndex,
              body: await blobToBase64Url(blob.slice(offset, offset + chunkBytes)),
            },
            {attempts: retryLimit},
          );
          completed += 1;
          onProgress(completed, totalChunks);
        });
      } catch (error) {
        status = await options.rpc(paths.status, {upload_id: uploadId}, {attempts: retryLimit});
        if (recoveryPass === 1) throw error;
        continue;
      }
      status = await options.rpc(paths.status, {upload_id: uploadId}, {attempts: retryLimit});
    }

    if (Array.isArray(status.missing) && status.missing.length) {
      throw new Error(`upload incomplete: ${status.missing.length}/${totalChunks} chunks missing`);
    }
    return await options.rpc(paths.finish, {upload_id: uploadId}, {attempts: 1});
  }

  function startLiveUpdates(options) {
    let pollTimer = null;
    let source = null;
    const setPolling = milliseconds => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(options.poll, milliseconds);
    };
    setPolling(options.fastPollMs || 2500);
    if (typeof EventSource !== "undefined") {
      try {
        const query = new URLSearchParams({token: options.token});
        source = new EventSource(`/events?${query.toString()}`);
        source.onopen = () => {
          if (options.onState) options.onState("connecting");
        };
        source.onmessage = () => {
          setPolling(options.slowPollMs || 15000);
          if (options.onState) options.onState("live");
          options.onUpdate();
        };
        source.onerror = () => {
          setPolling(options.fastPollMs || 2500);
          if (options.onState) options.onState("polling");
        };
      } catch (error) {
        if (options.onState) options.onState("polling");
      }
    }
    return () => {
      if (pollTimer) clearInterval(pollTimer);
      if (source) source.close();
    };
  }

  global.RLCSDTransport = {
    createRpc,
    uploadBlob,
    startLiveUpdates,
  };
})(window);
