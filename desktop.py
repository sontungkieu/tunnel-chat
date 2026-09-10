"""Windows desktop backend. The WSL HTTP process owns only the bridge child.

Task ownership, runtime, credentials, permissions and model stay in the desktop app.
"""
from __future__ import annotations
import atexit
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
WINDOWS_PROJECT_PATTERN = re.compile(r"^[A-Za-z]:[\\/][^\x00-\x1f]{1,500}$")
IMAGE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
IMAGE_SUFFIXES = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/bmp": ".bmp", "image/avif": ".avif",
}


def thread_id(value: str) -> str:
    value = value.strip()
    if value.startswith("codex://threads/"):
        value = value[len("codex://threads/"):].rstrip("/")
    if not UUID_PATTERN.fullmatch(value):
        raise ValueError("Paste a task ID or codex://threads/... link")
    return value.lower()


def project_path(value: object, fallback: str) -> str:
    candidate = str(value or fallback).strip().replace("/", "\\").rstrip("\\")
    if not WINDOWS_PROJECT_PATTERN.fullmatch(candidate):
        raise ValueError("Project path must be an absolute Windows path such as D:\\dev\\codex\\project")
    return candidate


def windows_path(value: str) -> str:
    if os.name == "nt":
        return str(Path(value).resolve())
    return subprocess.run(["wslpath", "-w", str(Path(value).resolve())],
                          check=True, capture_output=True, text=True, timeout=5).stdout.strip()


def local_path_from_windows(value: str) -> Path:
    """Translate a native drive path without allowing it to escape its WSL mount."""
    if os.name == "nt":
        candidate = Path(value)
        if not candidate.is_absolute():
            raise ValueError("Image path must be absolute")
        return candidate
    match = re.fullmatch(r"([A-Za-z]):[\\/](.*)", value)
    if not match:
        raise ValueError("Image path must be a Windows drive path")
    parts = match.group(2).replace("\\", "/").split("/")
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ValueError("Invalid image path")
    return Path("/mnt") / match.group(1).lower() / Path(*parts)


def prepare_state_images(server, chat_id: int, result: dict) -> dict:
    """Copy native message images into a chat-scoped cache and hide source paths."""
    messages = result.get("messages")
    if not isinstance(messages, list):
        return result
    cache_root = server.DATA_DIR / "desktop_images" / str(chat_id)
    for message in messages:
        if not isinstance(message, dict):
            continue
        raw_images = message.pop("images", [])
        if not isinstance(raw_images, list):
            continue
        images = []
        for raw_path in raw_images:
            try:
                if not isinstance(raw_path, str):
                    raise ValueError("Invalid image path")
                source = local_path_from_windows(raw_path)
                if source.is_symlink() or not source.is_file():
                    raise ValueError("Image is missing")
                details = source.stat()
                if details.st_size <= 0 or details.st_size > server.MAX_CODEX_ATTACHMENT_BYTES:
                    raise ValueError("Image exceeds size limit")
                mime_type = (mimetypes.guess_type(source.name)[0] or "").lower()
                suffix = IMAGE_SUFFIXES.get(mime_type)
                if not suffix or not server.is_image_attachment(source.name, mime_type):
                    raise ValueError("Unsupported image type")
                identity = "\0".join((str(result.get("threadId") or ""), raw_path,
                    str(details.st_size), str(details.st_mtime_ns)))
                image_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
                cache_root.mkdir(parents=True, exist_ok=True)
                destination = cache_root / f"{image_id}{suffix}"
                if not destination.is_file() or destination.stat().st_size != details.st_size:
                    temporary = cache_root / f".{image_id}-{uuid.uuid4().hex}.tmp"
                    try:
                        shutil.copyfile(source, temporary)
                        if temporary.stat().st_size != details.st_size:
                            raise ValueError("Image changed while copying")
                        os.replace(temporary, destination)
                    finally:
                        temporary.unlink(missing_ok=True)
                images.append({"id": image_id, "name": server.safe_filename(source.name),
                               "mime_type": mime_type, "size": details.st_size})
            except (OSError, ValueError):
                # Clipboard temp files can disappear between history load and projection.
                continue
        if images:
            message["images"] = images
    return result


def image_file(server, chat_id: int, image_id: str) -> dict:
    require_chat(server, chat_id)
    if not IMAGE_ID_PATTERN.fullmatch(image_id):
        raise ValueError("Invalid image ID")
    cache_root = server.DATA_DIR / "desktop_images" / str(chat_id)
    matches = list(cache_root.glob(f"{image_id}.*")) if cache_root.is_dir() else []
    if len(matches) != 1:
        raise ValueError("Image is unavailable")
    image = matches[0]
    resolved_root = cache_root.resolve()
    if image.is_symlink() or not image.resolve().is_relative_to(resolved_root) or not image.is_file():
        raise ValueError("Invalid image file")
    size = image.stat().st_size
    mime_type = (mimetypes.guess_type(image.name)[0] or "").lower()
    if size <= 0 or size > server.MAX_CODEX_ATTACHMENT_BYTES or mime_type not in IMAGE_SUFFIXES:
        raise ValueError("Invalid image file")
    return {"path": image, "filename": image.name, "mime_type": mime_type}


def bridge_command(config: dict[str, str]) -> list[str]:
    node = config.get("desktop_node") or (
        shutil.which("node.exe") if os.name == "nt" else "/mnt/c/Program Files/nodejs/node.exe"
    )
    if not node:
        raise ValueError("Install Windows Node.js 18+ and set DESKTOP_NODE")
    if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", node):
        node = subprocess.run(["wslpath", "-u", node], check=True, capture_output=True,
                              text=True, timeout=5).stdout.strip()
    if not Path(node).is_file():
        raise ValueError("DESKTOP_NODE must point to an installed Windows node.exe")
    if not node.lower().endswith("node.exe"):
        raise ValueError("Desktop IPC requires Windows node.exe, not Linux node")
    script = Path(__file__).with_name("desktop_ipc.cjs")
    return [node, "--max-old-space-size=1024", windows_path(str(script))]


class Bridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.responses = queue.Queue()

    def close(self):
        with self.lock:
            process, self.process = self.process, None
            if process:
                if process.stdin:
                    process.stdin.close()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.terminate()  # Only our bridge; never the app or app-server.
                    process.wait(timeout=3)

    @staticmethod
    def _read(process, responses):
        try:
            for line in process.stdout:
                responses.put(json.loads(line))
        except (OSError, ValueError):
            pass
        finally:
            responses.put({"error": "Windows bridge disconnected"})

    def call(self, config, action, task=None, data=None, refresh=False, progress=None, timeout=40):
        with self.lock:
            if not self.process or self.process.poll() is not None:
                self.close()
                self.responses = queue.Queue()
                self.process = subprocess.Popen(
                    bridge_command(config), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                threading.Thread(target=self._read, args=(self.process, self.responses), daemon=True).start()
            request_id = str(uuid.uuid4())
            deadline = time.monotonic() + timeout
            try:
                self.process.stdin.write(json.dumps({"id": request_id, "action": action,
                    "threadId": task, "data": data or {}, "refresh": refresh}, ensure_ascii=False) + "\n")
                self.process.stdin.flush()
                while True:
                    response = self.responses.get(timeout=max(0.1, deadline - time.monotonic()))
                    if response.get("id") != request_id:
                        self.close()
                        raise ValueError("Windows bridge disconnected; refresh before resending")
                    if "progress" in response:
                        if progress:
                            progress(response["progress"])
                        continue
                    if response.get("error"):
                        raise ValueError(response["error"])
                    return response["result"]
            except (OSError, queue.Empty) as exc:
                self.close()
                raise ValueError("Bridge timed out/disconnected; outcome unknown. Refresh before resending.") from exc


BRIDGE = Bridge()
atexit.register(BRIDGE.close)


def init_schema(conn):
    columns = {row[1] for row in conn.execute("PRAGMA table_info(codex_chats)")}
    if "backend" not in columns:
        conn.execute("ALTER TABLE codex_chats ADD COLUMN backend TEXT NOT NULL DEFAULT 'cli-wsl'")
    if "host_id" not in columns:
        conn.execute("ALTER TABLE codex_chats ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'")
    if "hidden" not in columns:
        conn.execute("ALTER TABLE codex_chats ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")
    if "custom_title" not in columns:
        conn.execute("ALTER TABLE codex_chats ADD COLUMN custom_title TEXT")
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS desktop_task_owner
                 ON codex_chats(host_id, codex_session_id) WHERE backend = 'desktop'""")
    conn.execute("""CREATE TABLE IF NOT EXISTS desktop_actions (
        operation_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, action TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL)""")


def require_chat(server, chat_id):
    chat = server.get_codex_chat(chat_id)
    if chat is None or chat["backend"] != "desktop" or chat["host_id"] != "local":
        raise ValueError("Select a linked local desktop task")
    return chat


def state(server, chat_id, refresh=False, progress=None, since_revision=None):
    chat = require_chat(server, chat_id)
    bridge_data = ({"sinceRevision": since_revision}
                   if isinstance(since_revision, int) and not isinstance(since_revision, bool)
                   else None)
    result = BRIDGE.call(server.load_config(), "state", chat["codex_session_id"], refresh=refresh,
                         data=bridge_data, progress=progress, timeout=240)
    if result.get("unchanged") is True:
        return result
    prepare_state_images(server, chat_id, result)
    native_title = result["title"]
    # Native paths are metadata here; never resolve a Windows cwd as a Linux path.
    with server.connect() as conn:
        conn.execute("""UPDATE codex_chats SET title=?,repo_path=?,status=?,activity=?,updated_at=?
                      WHERE id=? AND backend='desktop'""",
                     (native_title, result["cwd"], result["status"], result.get("activity"),
                      server.now_iso(), chat_id))
        conn.commit()
    if chat["custom_title"]:
        result["title"] = str(chat["custom_title"])
    return result


def link(server, value, progress=None):
    task = thread_id(value)
    result = BRIDGE.call(server.load_config(), "state", task, refresh=True,
                         progress=progress, timeout=240)
    with server.connect() as conn:
        conn.execute("""INSERT OR IGNORE INTO codex_chats
            (created_at,updated_at,title,repo_path,codex_session_id,status,backend,host_id)
            VALUES (?,?,?,?,?,?,'desktop','local')""",
            (server.now_iso(),server.now_iso(),result["title"],result["cwd"],task,result["status"]))
        chat_id = conn.execute("""SELECT id FROM codex_chats
            WHERE backend='desktop' AND host_id='local' AND codex_session_id=?""",(task,)).fetchone()[0]
        conn.execute("UPDATE codex_chats SET hidden=0,updated_at=? WHERE id=?",
                     (server.now_iso(),chat_id))
        conn.commit()
    prepare_state_images(server, chat_id, result)
    return {"chat_id":chat_id,"state":result}


LOADS = {}
LOADS_LOCK = threading.Lock()
LOAD_TTL_SECONDS = 10 * 60


def load_view(job):
    view = {"load_id": job["load_id"], "status": job["status"], "stage": job["stage"],
            "elapsed_seconds": round(time.monotonic() - job["started"], 1)}
    if job.get("progress"):
        view["progress"] = job["progress"]
    if job["status"] == "complete":
        view["result"] = job["result"]
    elif job["status"] == "error":
        view["error"] = job["error"]
    return view


def cleanup_loads():
    cutoff = time.monotonic() - LOAD_TTL_SECONDS
    for load_id, job in list(LOADS.items()):
        if job["status"] in {"complete", "error"} and job["finished"] < cutoff:
            del LOADS[load_id]


def start_load(server, data):
    value = str(data.get("thread") or "").strip()
    chat_id = int(data.get("chat_id") or 0)
    refresh = bool(data.get("refresh"))
    if value:
        target = ("link", thread_id(value))
    else:
        require_chat(server, chat_id)
        target = ("state", chat_id)
    load_id = str(uuid.uuid4())
    job = {"load_id": load_id, "status": "loading", "stage": "queued",
           "progress": {}, "started": time.monotonic(), "finished": 0.0}
    with LOADS_LOCK:
        cleanup_loads()
        LOADS[load_id] = job

    def update_progress(update):
        with LOADS_LOCK:
            job["stage"] = str(update.get("stage") or job["stage"])
            job["progress"] = {key: update[key] for key in
                               ("receivedBytes", "totalBytes", "percent") if key in update}

    def run():
        try:
            if target[0] == "link":
                result = link(server, target[1], progress=update_progress)
            else:
                result = {"chat_id": target[1],
                          "state": state(server, target[1], refresh=refresh, progress=update_progress)}
            with LOADS_LOCK:
                job.update(status="complete", stage="complete", result=result,
                           progress={}, finished=time.monotonic())
        except Exception as exc:
            with LOADS_LOCK:
                job.update(status="error", stage="error", error=server.redact_secrets(str(exc)),
                           progress={}, finished=time.monotonic())

    threading.Thread(target=run, name=f"desktop-load-{load_id[:8]}", daemon=True).start()
    with LOADS_LOCK:
        return load_view(job)


def load_status(data):
    load_id = str(data.get("load_id") or "")
    if not UUID_PATTERN.fullmatch(load_id):
        raise ValueError("A valid load_id is required")
    with LOADS_LOCK:
        cleanup_loads()
        job = LOADS.get(load_id)
        if not job:
            raise ValueError("Load request expired or was not found")
        return load_view(job)


def stage_attachments(server, chat_id, ids):
    attachments = server.get_codex_attachments(chat_id, ids)
    if len(attachments) != len(set(ids)):
        raise ValueError("Attachment does not belong to this task")
    text, images = [], []
    config = server.load_config()
    for attachment in attachments:
        source = Path(attachment["path"])
        expected_root = (server.CODEX_ATTACHMENTS_DIR / str(chat_id)).resolve()
        if source.is_symlink() or not source.resolve().is_relative_to(expected_root):
            raise ValueError("Invalid attachment path")
        if not source.is_file() or source.stat().st_size > server.MAX_CODEX_ATTACHMENT_BYTES:
            raise ValueError("Attachment missing or exceeds size limit")
        staged = BRIDGE.call(config,"stage",data={"source":windows_path(str(source)),
            "filename":attachment["filename"],"stagingRoot":config.get("desktop_staging_root")})
        if attachment["is_image"]:
            images.append(staged["windowsPath"])
        else:
            text.append(f"\nAttached file {attachment['filename']}:\nWindows: {staged['windowsPath']}\nWSL: {staged['wslPath']}")
    return "\n".join(text), images


def mutate(server, chat_id, action, data):
    chat = require_chat(server, chat_id)
    operation_id = str(data.get("operation_id") or "")
    if not UUID_PATTERN.fullmatch(operation_id):
        raise ValueError("A unique operation_id is required")
    fingerprint = hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    with server.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        old = conn.execute("SELECT * FROM desktop_actions WHERE operation_id=?",(operation_id,)).fetchone()
        if old:
            if old["chat_id"] != chat_id or old["action"] != action or old["fingerprint"] != fingerprint:
                raise ValueError("operation_id was already used for another action")
            if old["status"] == "complete":
                return json.loads(old["result"])
            raise ValueError("Previous action is pending or uncertain; refresh the task. It will not be replayed.")
        conn.execute("INSERT INTO desktop_actions VALUES (?,?,?,?,?,?,?)",
                     (operation_id,chat_id,action,fingerprint,"pending",None,server.now_iso()))
        conn.commit()
    try:
        outgoing = dict(data)
        if action == "send":
            text = str(data.get("text") or "").strip()
            if len(text.encode()) > server.MAX_CODEX_PROMPT_BYTES:
                raise ValueError("Prompt exceeds size limit")
            extra, images = stage_attachments(server,chat_id,server.parse_id_list(data.get("attachment_ids")))
            outgoing.update(text=text+extra,images=images)
        result = BRIDGE.call(server.load_config(),action,chat["codex_session_id"],outgoing)
    except Exception:
        with server.connect() as conn:
            conn.execute("UPDATE desktop_actions SET status='uncertain' WHERE operation_id=?",(operation_id,))
            conn.commit()
        raise
    with server.connect() as conn:
        conn.execute("UPDATE desktop_actions SET status='complete',result=? WHERE operation_id=?",
                     (json.dumps(result),operation_id))
        conn.commit()
    return result



CREATE_JOBS = {}
CREATE_JOBS_LOCK = threading.Lock()
CREATE_TTL_SECONDS = 30 * 60


def create_task(server, source_chat_id: int, data: dict, progress=None) -> dict:
    source = require_chat(server, source_chat_id)
    prompt = str(data.get("text") or "").strip()
    if not prompt:
        raise ValueError("Enter the first message for the new task")
    if len(prompt.encode()) > server.MAX_CODEX_PROMPT_BYTES:
        raise ValueError("Prompt exceeds size limit")
    if server.parse_id_list(data.get("attachment_ids")):
        raise ValueError("Attach files after the new task has been created")
    operation_id = str(data.get("operation_id") or "")
    if not UUID_PATTERN.fullmatch(operation_id):
        raise ValueError("A unique operation_id is required")
    fingerprint = hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    with server.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        old = conn.execute("SELECT * FROM desktop_actions WHERE operation_id=?",(operation_id,)).fetchone()
        if old:
            if old["chat_id"] != source_chat_id or old["action"] != "create" or old["fingerprint"] != fingerprint:
                raise ValueError("operation_id was already used for another action")
            if old["status"] == "complete":
                return json.loads(old["result"])
            raise ValueError("Previous creation is pending or uncertain; inspect the Desktop task before retrying.")
        conn.execute("INSERT INTO desktop_actions VALUES (?,?,?,?,?,?,?)",
                     (operation_id,source_chat_id,"create",fingerprint,"pending",None,server.now_iso()))
        conn.commit()
    path = project_path(data.get("project_path"), source["repo_path"])
    outgoing = dict(data)
    outgoing.pop("controllerThreadId", None)
    outgoing.update(text=prompt, projectPath=path)
    def report(update):
        if progress:
            progress(update)
    try:
        result = BRIDGE.call(server.load_config(),"create",source["codex_session_id"],outgoing,
                             progress=report,timeout=600)
        task = thread_id(result["threadId"])
        state_result = result["state"]
        with server.connect() as conn:
            conn.execute("""INSERT OR IGNORE INTO codex_chats
                (created_at,updated_at,title,repo_path,codex_session_id,status,backend,host_id)
                VALUES (?,?,?,?,?,?,'desktop','local')""",
                (server.now_iso(),server.now_iso(),state_result["title"],state_result["cwd"],task,
                 state_result["status"]))
            chat_id = conn.execute("""SELECT id FROM codex_chats
                WHERE backend='desktop' AND host_id='local' AND codex_session_id=?""",(task,)).fetchone()[0]
            response={"chat_id":chat_id,"state":state_result}
            conn.execute("UPDATE desktop_actions SET status='complete',result=? WHERE operation_id=?",
                         (json.dumps(response),operation_id))
            conn.commit()
        prepare_state_images(server,chat_id,state_result)
        return response
    except Exception:
        with server.connect() as conn:
            conn.execute("UPDATE desktop_actions SET status='uncertain' WHERE operation_id=?",(operation_id,))
            conn.commit()
        raise


def create_view(job):
    view={"create_id":job["create_id"],"status":job["status"],"stage":job["stage"],
          "elapsed_seconds":round(time.monotonic()-job["started"],1)}
    if job["status"]=="complete":
        view["result"]=job["result"]
    elif job["status"]=="error":
        view["error"]=job["error"]
    return view


def cleanup_creates():
    cutoff=time.monotonic()-CREATE_TTL_SECONDS
    for create_id,job in list(CREATE_JOBS.items()):
        if job["status"] in {"complete","error"} and job["finished"]<cutoff:
            del CREATE_JOBS[create_id]


def start_create(server, source_chat_id: int, data: dict, prompt: str) -> dict:
    require_chat(server,source_chat_id)
    create_id=str(uuid.uuid4())
    job={"create_id":create_id,"status":"creating","stage":"queued",
         "started":time.monotonic(),"finished":0.0}
    with CREATE_JOBS_LOCK:
        cleanup_creates();CREATE_JOBS[create_id]=job
    def update_progress(update):
        with CREATE_JOBS_LOCK:
            job["stage"]=str((update or {}).get("stage") or job["stage"])
    def run():
        try:
            result=create_task(server,source_chat_id,{**data,"text":prompt},progress=update_progress)
            with CREATE_JOBS_LOCK:
                job.update(status="complete",stage="complete",result=result,finished=time.monotonic())
        except Exception as exc:
            with CREATE_JOBS_LOCK:
                job.update(status="error",stage="error",error=server.redact_secrets(str(exc)),
                           finished=time.monotonic())
    threading.Thread(target=run,name=f"desktop-create-{create_id[:8]}",daemon=True).start()
    with CREATE_JOBS_LOCK:
        return create_view(job)


def create_status(data):
    create_id=str(data.get("create_id") or "")
    if not UUID_PATTERN.fullmatch(create_id):
        raise ValueError("A valid create_id is required")
    with CREATE_JOBS_LOCK:
        cleanup_creates();job=CREATE_JOBS.get(create_id)
        if not job:
            raise ValueError("Creation request expired or was not found")
        return create_view(job)


def unlink(server, chat_id: int) -> dict:
    require_chat(server,chat_id)
    with server.connect() as conn:
        conn.execute("UPDATE codex_chats SET hidden=1,updated_at=? WHERE id=? AND backend='desktop'",
                     (server.now_iso(),chat_id))
        conn.commit()
    return {"ok":True}


def rename(server, chat_id: int, value: object) -> dict:
    require_chat(server, chat_id)
    title = " ".join(str(value or "").split())
    if not title:
        raise ValueError("Enter a task name")
    if len(title) > 160:
        raise ValueError("Task name is limited to 160 characters")
    with server.connect() as conn:
        conn.execute("UPDATE codex_chats SET custom_title=?,updated_at=? WHERE id=? AND backend='desktop'",
                     (title, server.now_iso(), chat_id))
        conn.commit()
    return {"ok": True, "title": title}


def list_chats(server):
    with server.connect() as conn:
        chats=[dict(row) for row in conn.execute(
            "SELECT * FROM codex_chats WHERE backend='desktop' AND hidden=0 ORDER BY updated_at DESC")]
    live={}
    if chats:
        try:
            live=BRIDGE.call(server.load_config(),"summaries",data={
                "threadIds":[chat["codex_session_id"] for chat in chats]},timeout=5)
        except ValueError:
            live={}
    updates=[]
    for chat in chats:
        if chat.get("custom_title"):
            chat["title"] = str(chat["custom_title"])
        summary=live.get(chat["codex_session_id"]) if isinstance(live,dict) else None
        if not isinstance(summary,dict):
            chat["live"]=False
            continue
        status=summary.get("status") if summary.get("status") in {"running","idle"} else chat["status"]
        activity=summary.get("activity") if isinstance(summary.get("activity"),str) else chat.get("activity")
        chat.update(status=status,activity=activity,live=True)
        if isinstance(summary.get("revision"),int): chat["revision"]=summary["revision"]
        if isinstance(summary.get("latestTurnId"),str): chat["latestTurnId"]=summary["latestTurnId"]
        updates.append((status,activity,chat["id"]))
    if updates:
        with server.connect() as conn:
            conn.executemany("""UPDATE codex_chats SET status=?,activity=?
                              WHERE id=? AND backend='desktop'""",updates)
            conn.commit()
    return chats


def dispatch(server, action, data):
    if server.load_config().get("desktop_enabled") != "1":
        raise ValueError("Desktop backend is disabled. Set DESKTOP_ENABLED=1 in .env.local")
    if action == "list":
        return {"chats":list_chats(server),"transport":json.loads(server.client_transport_config())}
    if action == "load/start":
        return start_load(server, data)
    if action == "load/status":
        return load_status(data)
    if action == "create/status":
        return create_status(data)
    if action == "link":
        return link(server,str(data.get("thread") or ""))
    chat_id = int(data.get("chat_id") or 0)
    require_chat(server,chat_id)
    if action == "state":
        return state(server,chat_id,bool(data.get("refresh")),
                     since_revision=data.get("since_revision"))
    if action == "unlink":
        return unlink(server,chat_id)
    if action == "rename":
        return rename(server,chat_id,data.get("title"))
    if action in {"send","cancel","reply"}:
        return mutate(server,chat_id,action,data)
    if action == "prompt/finish":
        # Chunk uploads use the existing transport; only the final dispatch differs.
        outcome = {}
        def submit(target, prompt, attachments):
            if target != chat_id:
                raise ValueError("Prompt belongs to another task")
            payload={**data,"text":prompt,"attachment_ids":attachments}
            if data.get("create"):
                outcome.update(start_create(server,chat_id,payload,prompt))
            else:
                mutate(server,chat_id,"send",payload)
                outcome.update(ok=True)
        server.finish_codex_prompt_upload(int(data["upload_id"]), submit=submit)
        return outcome
    raise ValueError("Unknown desktop action")
