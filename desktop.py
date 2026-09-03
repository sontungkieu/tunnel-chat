"""Windows desktop backend. The WSL HTTP process owns only the bridge child.

Task ownership, runtime, credentials, permissions and model stay in the desktop app.
"""
from __future__ import annotations
import atexit
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import uuid

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)


def thread_id(value: str) -> str:
    value = value.strip()
    if value.startswith("codex://threads/"):
        value = value[len("codex://threads/"):].rstrip("/")
    if not UUID_PATTERN.fullmatch(value):
        raise ValueError("Paste a task ID or codex://threads/... link")
    return value.lower()


def windows_path(value: str) -> str:
    if os.name == "nt":
        return str(Path(value).resolve())
    return subprocess.run(["wslpath", "-w", str(Path(value).resolve())],
                          check=True, capture_output=True, text=True, timeout=5).stdout.strip()


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
    return [node, windows_path(str(script))]


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

    def call(self, config, action, task=None, data=None, refresh=False):
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
            try:
                self.process.stdin.write(json.dumps({"id": request_id, "action": action,
                    "threadId": task, "data": data or {}, "refresh": refresh}, ensure_ascii=False) + "\n")
                self.process.stdin.flush()
                response = self.responses.get(timeout=40)
                if response.get("id") != request_id:
                    self.close()
                    raise ValueError("Windows bridge disconnected; refresh before resending")
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


def state(server, chat_id, refresh=False):
    chat = require_chat(server, chat_id)
    result = BRIDGE.call(server.load_config(), "state", chat["codex_session_id"], refresh=refresh)
    # Native paths are metadata here; never resolve a Windows cwd as a Linux path.
    with server.connect() as conn:
        conn.execute("""UPDATE codex_chats SET title=?,repo_path=?,status=?,updated_at=?
                      WHERE id=? AND backend='desktop'""",
                     (result["title"], result["cwd"], result["status"], server.now_iso(), chat_id))
        conn.commit()
    return result


def link(server, value):
    task = thread_id(value)
    result = BRIDGE.call(server.load_config(), "state", task, refresh=True)
    with server.connect() as conn:
        conn.execute("""INSERT OR IGNORE INTO codex_chats
            (created_at,updated_at,title,repo_path,codex_session_id,status,backend,host_id)
            VALUES (?,?,?,?,?,?,'desktop','local')""",
            (server.now_iso(),server.now_iso(),result["title"],result["cwd"],task,result["status"]))
        chat_id = conn.execute("""SELECT id FROM codex_chats
            WHERE backend='desktop' AND host_id='local' AND codex_session_id=?""",(task,)).fetchone()[0]
        conn.commit()
    return {"chat_id":chat_id,"state":result}


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
        text.append(f"\nAttached file {attachment['filename']}:\nWindows: {staged['windowsPath']}\nWSL: {staged['wslPath']}")
        if attachment["is_image"]:
            images.append(staged["windowsPath"])
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


def dispatch(server, action, data):
    if server.load_config().get("desktop_enabled") != "1":
        raise ValueError("Desktop backend is disabled. Set DESKTOP_ENABLED=1 in .env.local")
    if action == "list":
        with server.connect() as conn:
            chats=[dict(row) for row in conn.execute(
                "SELECT * FROM codex_chats WHERE backend='desktop' ORDER BY updated_at DESC")]
        return {"chats":chats,"transport":json.loads(server.client_transport_config())}
    if action == "link":
        return link(server,str(data.get("thread") or ""))
    chat_id = int(data.get("chat_id") or 0)
    require_chat(server,chat_id)
    if action == "state":
        return state(server,chat_id,bool(data.get("refresh")))
    if action in {"send","cancel","reply"}:
        return mutate(server,chat_id,action,data)
    if action == "prompt/finish":
        # Chunk uploads use the existing transport; only the final dispatch differs.
        def submit(target, prompt, attachments):
            if target != chat_id:
                raise ValueError("Prompt belongs to another task")
            mutate(server,chat_id,"send",{**data,"text":prompt,"attachment_ids":attachments})
        server.finish_codex_prompt_upload(int(data["upload_id"]), submit=submit)
        return {"ok":True}
    raise ValueError("Unknown desktop action")
