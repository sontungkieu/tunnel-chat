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
          const query = new URLSearchParams({p: encodePayload(payload)});
          response = await fetch(`${apiBase}/${path}?${query.toString()}`, {cache: "no-store", headers: {"x-chat-token": token}});
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

  function accessToken() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    // Migrate old links/storage once, then remove the credential from the address bar.
    let token = fragment.get("token") || query.get("token") ||
      sessionStorage.getItem("tunnelChatToken") || localStorage.getItem("fixChatToken") || "";
    localStorage.removeItem("fixChatToken");
    query.delete("token");
    fragment.delete("token");
    history.replaceState(null, "", location.pathname + (query.size ? "?" + query : "") +
      (fragment.size ? "#" + fragment : ""));
    if (!token) token = prompt("Access token") || "";
    if (token) sessionStorage.setItem("tunnelChatToken", token);
    return token;
  }

  async function download(url, token) {
    const response = await fetch(url, {headers: {"x-chat-token": token}, cache: "no-store"});
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1] || "repo.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  function startLiveUpdates(options) {
    const controller = new AbortController();
    let pollTimer = setInterval(options.poll, options.fastPollMs || 2500);
    const setPolling = ms => {clearInterval(pollTimer); pollTimer = setInterval(options.poll, ms);};
    // Fetch streams support the auth header; native EventSource does not.
    (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch("/events", {headers: {"x-chat-token": options.token},
            cache: "no-store", signal: controller.signal});
          if (!response.ok || !response.body) throw new Error("Stream unavailable");
          const reader = response.body.getReader();
          try {
            const decoder = new TextDecoder();
            let buffer = "";
            while (!controller.signal.aborted) {
              const {value, done} = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, {stream: true});
              let boundary;
              while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const event = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (event.includes("data:")) {
                  setPolling(options.slowPollMs || 15000);
                  options.onState?.("live");
                  options.onUpdate();
                }
              }
              if (buffer.length > 65536) throw new Error("Invalid event stream");
            }
          } finally { await reader.cancel().catch(() => {}); }
        } catch (error) {
          if (controller.signal.aborted) break;
        }
        setPolling(options.fastPollMs || 2500);
        options.onState?.("polling");
        await sleep(2500);
      }
    })();
    return () => {clearInterval(pollTimer); controller.abort();};
  }

  global.RLCSDTransport = {
    accessToken,
    download,
    createRpc,
    uploadBlob,
    startLiveUpdates,
  };
})(window);
