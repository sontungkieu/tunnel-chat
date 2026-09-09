"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fakeIndexedDb(seed) {
  const records = new Map(seed.map(job => [job.id, clone(job)]));
  function transaction() {
    const tx = {pending: 0, returned: false, completed: false};
    const finish = () => {
      if (tx.returned && tx.pending === 0 && !tx.completed) {
        tx.completed = true;
        setImmediate(() => tx.oncomplete?.());
      }
    };
    const request = operation => {
      const output = {};
      tx.pending += 1;
      setImmediate(() => {
        try {
          output.result = operation();
          output.onsuccess?.();
        } catch (error) {
          output.error = error;
          output.onerror?.();
        } finally {
          tx.pending -= 1;
          finish();
        }
      });
      return output;
    };
    const store = {
      get: id => request(() => clone(records.get(id))),
      getAll: () => request(() => [...records.values()].map(clone)),
      put: job => request(() => { records.set(job.id, clone(job)); return job.id; }),
    };
    tx.objectStore = () => store;
    setImmediate(() => { tx.returned = true; finish(); });
    return tx;
  }
  const database = {
    objectStoreNames: {contains: () => true},
    transaction,
    close() {},
  };
  return {
    records,
    api: {open() {
      const request = {};
      setImmediate(() => { request.result = database; request.onsuccess?.(); });
      return request;
    }},
  };
}

function decodePayload(url) {
  const value = new URL(url, "https://example.test").searchParams.get("p");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

test("service worker persists file and note jobs then resumes them after authentication", async () => {
  const job = {
    id: "job-1", name: "sample.txt", mimeType: "text/plain", size: 10,
    directory: "notes", blob: new Blob(["abcdefghij"]), state: "queued",
    progress: 0, receivedBytes: 0, detail: "Đang chờ upload", error: "",
    result: null, uploadId: null, createdAt: 1, updatedAt: 1,
  };
  const noteText = "ghi chú Unicode ✓";
  const noteJob = {
    id: "job-2", kind: "note", name: "Ghi chú thử", title: "Ghi chú thử",
    mimeType: "text/plain;charset=utf-8", size: Buffer.byteLength(noteText), directory: "",
    blob: new Blob([noteText]), state: "queued", progress: 0, receivedBytes: 0,
    detail: "Đang chờ gửi note", error: "", result: null, uploadId: null,
    createdAt: 2, updatedAt: 2,
  };
  const database = fakeIndexedDb([job, noteJob]);
  const events = new Map();
  const clientMessages = [];
  const chunks = new Map();
  const noteChunks = new Map();
  const requests = [];
  const self = {
    clients: {
      matchAll: async () => [{postMessage: value => clientMessages.push(value)}],
      claim: async () => {},
    },
    skipWaiting: async () => {},
    addEventListener: (name, listener) => events.set(name, listener),
  };
  const context = {
    self, indexedDB: database.api, Blob, URL, URLSearchParams, TextEncoder,
    btoa, setTimeout, clearTimeout, console,
    fetch: async (url, options = {}) => {
      const payload = decodePayload(url);
      requests.push({url, options, payload});
      if (url.startsWith("/f/note/upload/start")) {
        assert.equal(payload.title, "Ghi chú thử");
        assert.equal(payload.total_chunks, Math.ceil(Buffer.byteLength(noteText) / 4));
        return Response.json({ok: true, upload_id: 8});
      }
      if (url.startsWith("/f/upload/start")) {
        assert.equal(payload.total_chunks, 3);
        return Response.json({ok: true, upload_id: 7});
      }
      if (url.startsWith("/f/note/upload/status")) {
        const indexes = Array.from({length: Math.ceil(Buffer.byteLength(noteText) / 4)}, (_, index) => index);
        return Response.json({missing: indexes.filter(index => !noteChunks.has(index))});
      }
      if (url.startsWith("/f/upload/status")) {
        return Response.json({missing: [0, 1, 2].filter(index => !chunks.has(index))});
      }
      if (url.startsWith("/f/note/upload/chunk")) {
        noteChunks.set(payload.chunk_index, Buffer.from(payload.body, "base64url"));
        return Response.json({ok: true});
      }
      if (url.startsWith("/f/upload/chunk")) {
        chunks.set(payload.chunk_index, Buffer.from(payload.body, "base64url"));
        return Response.json({ok: true});
      }
      if (url.startsWith("/f/note/upload/finish")) {
        return Response.json({note: {id: 3, title: "Ghi chú thử", size: Buffer.byteLength(noteText)}});
      }
      if (url.startsWith("/f/upload/finish")) {
        return Response.json({file: {path: "notes/sample.txt"}});
      }
      throw new Error(`unexpected request: ${url}`);
    },
    Response,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "static", "transfer-worker.js"), "utf8"),
    context,
  );
  async function send(data) {
    let pending;
    events.get("message")({data, waitUntil: promise => { pending = promise; }});
    await pending;
  }

  await send({type: "kick"});
  assert.equal(database.records.get(job.id).state, "waiting-auth");
  assert.equal(requests.length, 0);

  await send({type: "configure", config: {token: "test-secret", chunkBytes: 4, concurrency: 2, retryLimit: 1}});
  const completed = database.records.get(job.id);
  assert.equal(completed.state, "complete");
  assert.equal(completed.progress, 100);
  assert.equal(completed.blob, null);
  assert.equal(completed.result.path, "notes/sample.txt");
  assert.equal(Buffer.concat([...chunks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)).toString(), "abcdefghij");
  const completedNote = database.records.get(noteJob.id);
  assert.equal(completedNote.state, "complete");
  assert.equal(completedNote.blob, null);
  assert.equal(completedNote.result.title, "Ghi chú thử");
  assert.equal(Buffer.concat([...noteChunks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)).toString(), noteText);
  assert.ok(requests.some(request => request.url.startsWith("/f/note/upload/finish")));
  assert.ok(requests.every(request => request.options.headers["x-chat-token"] === "test-secret"));
  assert.ok(!JSON.stringify(completed).includes("test-secret"));
  assert.ok(clientMessages.some(message => message.job?.state === "complete"));
});
