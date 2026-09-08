#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import html
import json
import mimetypes
import os
import re
import secrets
import signal
import shutil
import stat
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import desktop

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CODEX_ATTACHMENTS_DIR = DATA_DIR / "codex_attachments"
DB_PATH = DATA_DIR / "chat.sqlite3"
ENV_PATH = BASE_DIR / ".env.local"
DEFAULT_PORT = 8787
MAX_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_UPLOAD_CHUNK_BYTES = 2 * 1024
MIN_UPLOAD_CHUNK_BYTES = 1024
MAX_UPLOAD_CHUNK_BYTES = 32 * 1024
DEFAULT_UPLOAD_CONCURRENCY = 3
MIN_UPLOAD_CONCURRENCY = 1
MAX_UPLOAD_CONCURRENCY = 6
DEFAULT_UPLOAD_RETRY_LIMIT = 4
MIN_UPLOAD_RETRY_LIMIT = 1
MAX_UPLOAD_RETRY_LIMIT = 8
DEFAULT_UPLOAD_TTL_SECONDS = 6 * 60 * 60
MIN_UPLOAD_TTL_SECONDS = 5 * 60
MAX_UPLOAD_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_QUEUE_UPLOAD_BYTES = 4 * 1024 * 1024
MAX_CODEX_ATTACHMENT_BYTES = 8 * 1024 * 1024
MAX_CODEX_PROMPT_BYTES = 4 * 1024 * 1024
MAX_UPLOAD_CHUNKS = 8192
ATTACHMENT_PREFIX = "RLCSD_TEXT_ATTACHMENT:"
API_COMPAT_PREFIX = "/api"
API_PREFIX = "/x"
GET_RPC_PREFIX = "/g"
CODEX_RPC_PREFIX = "/c"
DEFAULT_CODEX_BIN = shutil.which("codex") or ""
DEFAULT_CODEX_REPOS = (str(BASE_DIR),)
DEFAULT_CODEX_HOME = str(Path.home() / ".codex")
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
CODEX_RUNNERS: dict[int, subprocess.Popen[str]] = {}
CODEX_RUNNERS_LOCK = threading.Lock()
CODEX_CANCELLED: set[int] = set()
EVENT_CONDITION = threading.Condition()
EVENT_REVISION = 0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def load_config() -> dict[str, str]:
    env = parse_env_file(ENV_PATH)
    merged = {**env, **os.environ}
    return {
        "host": merged.get("HOST", "127.0.0.1"),
        "port": merged.get("PORT", str(DEFAULT_PORT)),
        "chat_access_token": merged.get("CHAT_ACCESS_TOKEN", ""),
        "codex_bin": merged.get("CODEX_BIN", DEFAULT_CODEX_BIN),
        "codex_repos": merged.get("CODEX_REPOS", os.pathsep.join(DEFAULT_CODEX_REPOS)),
        "codex_home": merged.get("CODEX_HOME", DEFAULT_CODEX_HOME),
        "desktop_enabled": merged.get("DESKTOP_ENABLED", "0"),
        "desktop_node": merged.get("DESKTOP_NODE", ""),
        "desktop_staging_root": merged.get("DESKTOP_STAGING_ROOT", r"D:\dev\codex\tunnel-chat\attachments"),
        "upload_chunk_bytes": merged.get("UPLOAD_CHUNK_BYTES", str(DEFAULT_UPLOAD_CHUNK_BYTES)),
        "upload_concurrency": merged.get("UPLOAD_CONCURRENCY", str(DEFAULT_UPLOAD_CONCURRENCY)),
        "upload_retry_limit": merged.get("UPLOAD_RETRY_LIMIT", str(DEFAULT_UPLOAD_RETRY_LIMIT)),
        "upload_ttl_seconds": merged.get("UPLOAD_TTL_SECONDS", str(DEFAULT_UPLOAD_TTL_SECONDS)),
    }


def upload_chunk_bytes() -> int:
    try:
        value = int(load_config().get("upload_chunk_bytes") or DEFAULT_UPLOAD_CHUNK_BYTES)
    except ValueError:
        value = DEFAULT_UPLOAD_CHUNK_BYTES
    return max(MIN_UPLOAD_CHUNK_BYTES, min(MAX_UPLOAD_CHUNK_BYTES, value))


def bounded_config_int(key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(load_config().get(key) or default)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def upload_concurrency() -> int:
    return bounded_config_int(
        "upload_concurrency",
        DEFAULT_UPLOAD_CONCURRENCY,
        MIN_UPLOAD_CONCURRENCY,
        MAX_UPLOAD_CONCURRENCY,
    )


def upload_retry_limit() -> int:
    return bounded_config_int(
        "upload_retry_limit",
        DEFAULT_UPLOAD_RETRY_LIMIT,
        MIN_UPLOAD_RETRY_LIMIT,
        MAX_UPLOAD_RETRY_LIMIT,
    )


def upload_ttl_seconds() -> int:
    return bounded_config_int(
        "upload_ttl_seconds",
        DEFAULT_UPLOAD_TTL_SECONDS,
        MIN_UPLOAD_TTL_SECONDS,
        MAX_UPLOAD_TTL_SECONDS,
    )


def client_transport_config() -> str:
    return json.dumps(
        {
            "chunkBytes": upload_chunk_bytes(),
            "concurrency": upload_concurrency(),
            "retryLimit": upload_retry_limit(),
        },
        separators=(",", ":"),
    )


def notify_event() -> None:
    global EVENT_REVISION
    with EVENT_CONDITION:
        EVENT_REVISION += 1
        EVENT_CONDITION.notify_all()


def redact_secrets(text: str) -> str:
    redacted = str(text)
    token = load_config().get("chat_access_token") or ""
    if token:
        redacted = redacted.replace(token, "[redacted]")
    redacted = re.sub(
        r"(x-chat-token(?:%3A|:)(?:%20|\s)*)[A-Za-z0-9._~+/=-]+",
        r"\1[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        r"((?:[?&]|%3F|%26)token(?:=|%3D))[^&%\\s\"'<>]+",
        r"\1[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    return redacted


def normalize_api_path(path: str) -> str:
    if path.startswith(API_PREFIX + "/"):
        return API_COMPAT_PREFIX + path[len(API_PREFIX) :]
    return path


def decode_get_payload(query: dict[str, list[str]]) -> dict[str, object]:
    encoded = query.get("p", [""])[0]
    if not encoded:
        return {}
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"invalid payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    return payload


def ensure_env() -> None:
    if ENV_PATH.exists():
        return
    token = secrets.token_urlsafe(24)
    gateway_node = shutil.which("node") or ""
    cloudflared = shutil.which("cloudflared") or str(BASE_DIR / ".tools" / "cloudflared")
    desktop_node = Path("/mnt/c/Program Files/nodejs/node.exe")
    desktop_enabled = desktop_node.is_file()
    content = (
        "HOST=127.0.0.1\n"
        f"PORT={DEFAULT_PORT}\n"
        f"CHAT_ACCESS_TOKEN={token}\n"
        "TUNNEL_MODE=quick\n"
        "PUBLIC_URL=\n"
        "SECRETS_ENV=\n"
        f"CLOUDFLARED_BIN='{cloudflared}'\n"
        f"GATEWAY_NODE='{gateway_node}'\n"
        f"UPLOAD_CHUNK_BYTES={DEFAULT_UPLOAD_CHUNK_BYTES}\n"
        f"UPLOAD_CONCURRENCY={DEFAULT_UPLOAD_CONCURRENCY}\n"
        f"UPLOAD_RETRY_LIMIT={DEFAULT_UPLOAD_RETRY_LIMIT}\n"
        f"UPLOAD_TTL_SECONDS={DEFAULT_UPLOAD_TTL_SECONDS}\n"
        f"CODEX_BIN='{DEFAULT_CODEX_BIN}'\n"
        f"CODEX_REPOS='{os.pathsep.join(DEFAULT_CODEX_REPOS)}'\n"
        f"CODEX_HOME='{DEFAULT_CODEX_HOME}'\n"
        f"DESKTOP_ENABLED={'1' if desktop_enabled else '0'}\n"
        f"DESKTOP_NODE='{desktop_node if desktop_enabled else ''}'\n"
        "DESKTOP_STAGING_ROOT='D:\\dev\\codex\\tunnel-chat\\attachments'\n"
    )
    old_umask = os.umask(0o177)
    try:
        ENV_PATH.write_text(content, encoding="utf-8")
    finally:
        os.umask(old_umask)


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'message',
            request_id INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS fix_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            source_message_id INTEGER,
            log_text TEXT NOT NULL,
            answered_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS upload_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            filename TEXT NOT NULL,
            size INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL,
            create_fix INTEGER NOT NULL DEFAULT 0,
            body_encoding TEXT NOT NULL DEFAULT 'text'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS upload_chunks (
            upload_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (upload_id, chunk_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            title TEXT NOT NULL,
            repo_path TEXT NOT NULL,
            codex_session_id TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            running_pid INTEGER,
            process_group INTEGER,
            activity TEXT,
            last_error TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'message'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_prompt_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            total_chunks INTEGER NOT NULL,
            body_encoding TEXT NOT NULL DEFAULT 'text',
            attachment_ids TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_prompt_chunks (
            upload_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (upload_id, chunk_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            path TEXT NOT NULL,
            preview_text TEXT,
            is_image INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_attachment_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS codex_attachment_chunks (
            upload_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (upload_id, chunk_index)
        )
        """
    )
    try:
        conn.execute("ALTER TABLE codex_prompt_uploads ADD COLUMN attachment_ids TEXT")
    except sqlite3.OperationalError as exc:
        if "duplicate column" not in str(exc).lower():
            raise
    try:
        conn.execute("ALTER TABLE upload_sessions ADD COLUMN body_encoding TEXT NOT NULL DEFAULT 'text'")
    except sqlite3.OperationalError as exc:
        if "duplicate column" not in str(exc).lower():
            raise
    migrations = (
        "ALTER TABLE codex_prompt_uploads ADD COLUMN size INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE codex_prompt_uploads ADD COLUMN body_encoding TEXT NOT NULL DEFAULT 'text'",
        "ALTER TABLE codex_chats ADD COLUMN process_group INTEGER",
        "ALTER TABLE codex_chats ADD COLUMN activity TEXT",
    )
    for statement in migrations:
        try:
            conn.execute(statement)
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise
    desktop.init_schema(conn)
    conn.commit()
    return conn


def add_message(author: str, body: str, kind: str = "message", request_id: int | None = None) -> int:
    body = redact_secrets(body.strip())
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages(created_at, author, body, kind, request_id) VALUES (?, ?, ?, ?, ?)",
            (now_iso(), author, body, kind, request_id),
        )
        conn.commit()
        message_id = int(cur.lastrowid)
    notify_event()
    return message_id


def decode_attachment_body(body: str) -> str:
    if not body.startswith(ATTACHMENT_PREFIX):
        return body
    try:
        payload = json.loads(body[len(ATTACHMENT_PREFIX) :])
    except json.JSONDecodeError:
        return body
    filename = str(payload.get("filename") or "error.txt")
    text = str(payload.get("text") or "")
    size = payload.get("size")
    return redact_secrets(f"File: {filename}\nSize: {size} bytes\n\n{text}")


def decode_base64url_chunk(body: str) -> bytes:
    padded = body + ("=" * ((4 - len(body) % 4) % 4))
    try:
        return base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True)
    except (ValueError, UnicodeEncodeError) as exc:
        raise ValueError("chunk body is not valid base64url") from exc


def expected_upload_chunks(size: int) -> int:
    return max(1, (size + upload_chunk_bytes() - 1) // upload_chunk_bytes())


def validate_upload_shape(size: int, total_chunks: int, max_bytes: int, label: str) -> None:
    if size < 0:
        raise ValueError(f"{label} size must not be negative")
    if size > max_bytes:
        raise ValueError(f"{label} too large; limit is {max_bytes // 1024 // 1024} MB")
    if total_chunks <= 0 or total_chunks > MAX_UPLOAD_CHUNKS:
        raise ValueError(f"total_chunks must be between 1 and {MAX_UPLOAD_CHUNKS}")
    expected = expected_upload_chunks(size)
    if total_chunks != expected:
        raise ValueError(f"total_chunks mismatch: got {total_chunks}, expected {expected}")


def validate_base64url_chunk(body: str, chunk_index: int, size: int, total_chunks: int) -> None:
    if len(body) > ((upload_chunk_bytes() + 2) // 3) * 4:
        raise ValueError("encoded chunk is larger than configured upload chunk size")
    data = decode_base64url_chunk(body)
    expected_size = min(upload_chunk_bytes(), max(0, size - chunk_index * upload_chunk_bytes()))
    if total_chunks == 1 and size == 0:
        expected_size = 0
    if len(data) != expected_size:
        raise ValueError(
            f"chunk {chunk_index} size mismatch: got {len(data)} bytes, expected {expected_size}"
        )


UPLOAD_TABLES = {
    "queue": ("upload_sessions", "upload_chunks"),
    "attachment": ("codex_attachment_uploads", "codex_attachment_chunks"),
    "prompt": ("codex_prompt_uploads", "codex_prompt_chunks"),
}


def get_upload_status(kind: str, upload_id: int) -> dict[str, object]:
    tables = UPLOAD_TABLES.get(kind)
    if tables is None:
        raise ValueError(f"unknown upload kind: {kind}")
    session_table, chunk_table = tables
    with connect() as conn:
        session = conn.execute(
            f"SELECT total_chunks FROM {session_table} WHERE id = ?",
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown {kind} upload #{upload_id}")
        rows = conn.execute(
            f"SELECT chunk_index FROM {chunk_table} WHERE upload_id = ? ORDER BY chunk_index",
            (upload_id,),
        ).fetchall()
    total_chunks = int(session["total_chunks"])
    received = [int(row["chunk_index"]) for row in rows]
    received_set = set(received)
    return {
        "upload_id": upload_id,
        "total_chunks": total_chunks,
        "received": received,
        "missing": [index for index in range(total_chunks) if index not in received_set],
    }


def cleanup_expired_uploads(ttl_seconds: int | None = None) -> dict[str, int]:
    ttl = upload_ttl_seconds() if ttl_seconds is None else max(0, int(ttl_seconds))
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=ttl)).isoformat(timespec="seconds")
    removed: dict[str, int] = {}
    with connect() as conn:
        for kind, (session_table, chunk_table) in UPLOAD_TABLES.items():
            rows = conn.execute(
                f"SELECT id FROM {session_table} WHERE created_at < ?",
                (cutoff,),
            ).fetchall()
            ids = [int(row["id"]) for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(
                    f"DELETE FROM {chunk_table} WHERE upload_id IN ({placeholders})",
                    ids,
                )
                conn.execute(
                    f"DELETE FROM {session_table} WHERE id IN ({placeholders})",
                    ids,
                )
            conn.execute(
                f"DELETE FROM {chunk_table} WHERE upload_id NOT IN (SELECT id FROM {session_table})"
            )
            removed[kind] = len(ids)
        conn.commit()
    return removed


def upload_cleanup_loop() -> None:
    while True:
        time.sleep(min(15 * 60, max(60, upload_ttl_seconds() // 4)))
        try:
            cleanup_expired_uploads()
        except Exception as exc:
            sys.stderr.write(f"upload cleanup failed: {redact_secrets(str(exc))}\n")


def create_fix_request(source_message_id: int | None = None) -> int | None:
    with connect() as conn:
        if source_message_id is None:
            source = conn.execute(
                """
                SELECT id, body
                FROM messages
                WHERE author = 'client' AND lower(trim(body)) NOT IN ('fix', '/fix')
                ORDER BY id DESC
                LIMIT 1
                """
            ).fetchone()
        else:
            source = conn.execute(
                """
                SELECT id, body
                FROM messages
                WHERE id = ? AND author = 'client'
                """,
                (source_message_id,),
            ).fetchone()
        if source is None:
            add_message("system", "Chua co log nao truoc lenh fix.", "system")
            return None
        cur = conn.execute(
            """
            INSERT INTO fix_requests(created_at, status, source_message_id, log_text)
            VALUES (?, 'open', ?, ?)
            """,
            (now_iso(), int(source["id"]), decode_attachment_body(str(source["body"]))),
        )
        request_id = int(cur.lastrowid)
        conn.execute(
            "INSERT INTO messages(created_at, author, body, kind, request_id) VALUES (?, 'system', ?, 'system', ?)",
            (now_iso(), f"Da nhan fix request #{request_id}. Cho lenh tra loi tu Codex.", request_id),
        )
        conn.commit()
    notify_event()
    return request_id


def list_messages(limit: int = 200) -> list[dict[str, object]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, author, body, kind, request_id
            FROM messages
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in reversed(rows)]


def list_open_requests() -> list[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            """
            SELECT id, created_at, status, source_message_id, log_text
            FROM fix_requests
            WHERE status = 'open'
            ORDER BY id ASC
            """
        ).fetchall()


def get_request(request_id: int) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute(
            """
            SELECT id, created_at, status, source_message_id, log_text, answered_at
            FROM fix_requests
            WHERE id = ?
            """,
            (request_id,),
        ).fetchone()


def reply_request(request_id: int, body: str) -> None:
    body = body.strip()
    if not body:
        raise ValueError("empty reply")
    with connect() as conn:
        row = conn.execute("SELECT id FROM fix_requests WHERE id = ?", (request_id,)).fetchone()
        if row is None:
            raise ValueError(f"unknown request #{request_id}")
        conn.execute(
            "INSERT INTO messages(created_at, author, body, kind, request_id) VALUES (?, 'codex', ?, 'command', ?)",
            (now_iso(), body, request_id),
        )
        conn.execute(
            "UPDATE fix_requests SET status = 'answered', answered_at = ? WHERE id = ?",
            (now_iso(), request_id),
        )
        conn.commit()
    notify_event()


def create_upload_session(filename: str, size: int, total_chunks: int, create_fix: bool, body_encoding: str = "text") -> int:
    validate_upload_shape(int(size), int(total_chunks), MAX_QUEUE_UPLOAD_BYTES, "text upload")
    if body_encoding not in {"text", "base64url"}:
        raise ValueError("body_encoding must be text or base64url")
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO upload_sessions(created_at, filename, size, total_chunks, create_fix, body_encoding)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (now_iso(), filename[:240], int(size), int(total_chunks), 1 if create_fix else 0, body_encoding),
        )
        conn.commit()
        return int(cur.lastrowid)


def add_upload_chunk(upload_id: int, chunk_index: int, body: str) -> None:
    with connect() as conn:
        session = conn.execute(
            "SELECT size, total_chunks, body_encoding FROM upload_sessions WHERE id = ?",
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown upload #{upload_id}")
        total_chunks = int(session["total_chunks"])
        if chunk_index < 0 or chunk_index >= total_chunks:
            raise ValueError(f"chunk_index must be between 0 and {total_chunks - 1}")
        if str(session["body_encoding"] or "text") == "base64url":
            validate_base64url_chunk(body, chunk_index, int(session["size"]), total_chunks)
        elif len(body.encode("utf-8")) > upload_chunk_bytes() * 2:
            raise ValueError("text chunk is larger than configured upload chunk size")
        conn.execute(
            """
            INSERT OR REPLACE INTO upload_chunks(upload_id, chunk_index, body)
            VALUES (?, ?, ?)
            """,
            (upload_id, int(chunk_index), body),
        )
        conn.commit()


def finish_upload(upload_id: int) -> tuple[int, int | None]:
    create_fix_after = False
    with connect() as conn:
        session = conn.execute(
            """
            SELECT id, filename, size, total_chunks, create_fix, body_encoding
            FROM upload_sessions
            WHERE id = ?
            """,
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown upload #{upload_id}")
        chunks = conn.execute(
            """
            SELECT chunk_index, body
            FROM upload_chunks
            WHERE upload_id = ?
            ORDER BY chunk_index ASC
            """,
            (upload_id,),
        ).fetchall()
        total_chunks = int(session["total_chunks"])
        if len(chunks) != total_chunks:
            raise ValueError(f"upload #{upload_id} has {len(chunks)}/{total_chunks} chunks")
        body_encoding = str(session["body_encoding"] or "text")
        if body_encoding == "base64url":
            data = b"".join(decode_base64url_chunk(str(row["body"])) for row in chunks)
            if len(data) != int(session["size"]):
                raise ValueError(f"upload #{upload_id} size mismatch: got {len(data)} bytes, expected {int(session['size'])}")
            text = data.decode("utf-8", errors="replace").replace("\r\n", "\n")
        else:
            text = "".join(str(row["body"]) for row in chunks)
        text = redact_secrets(text)
        body = ATTACHMENT_PREFIX + json.dumps(
            {
                "filename": str(session["filename"]),
                "size": int(session["size"]),
                "text": text,
            },
            ensure_ascii=False,
        )
        cur = conn.execute(
            "INSERT INTO messages(created_at, author, body, kind, request_id) VALUES (?, 'client', ?, 'message', NULL)",
            (now_iso(), body),
        )
        message_id = int(cur.lastrowid)
        create_fix_after = bool(int(session["create_fix"]))
        conn.execute("DELETE FROM upload_chunks WHERE upload_id = ?", (upload_id,))
        conn.execute("DELETE FROM upload_sessions WHERE id = ?", (upload_id,))
        conn.commit()
    request_id = create_fix_request(message_id) if create_fix_after else None
    notify_event()
    return message_id, request_id


def allowed_codex_repos() -> list[dict[str, str]]:
    config = load_config()
    raw_paths = [*DEFAULT_CODEX_REPOS]
    raw_paths.extend(p for p in config.get("codex_repos", "").split(os.pathsep) if p.strip())
    repos: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_path in raw_paths:
        try:
            path = Path(raw_path).expanduser().resolve()
        except OSError:
            continue
        if not path.exists() or not path.is_dir():
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        repos.append({"name": path.name or key, "path": key})
    return repos


def require_allowed_repo(repo_path: str) -> str:
    try:
        resolved = str(Path(repo_path).expanduser().resolve())
    except OSError as exc:
        raise ValueError(f"invalid repo path: {repo_path}") from exc
    allowed = {repo["path"] for repo in allowed_codex_repos()}
    if resolved not in allowed:
        raise ValueError(f"repo is not allowed: {resolved}")
    return resolved


def get_codex_bin() -> str:
    codex_bin = load_config().get("codex_bin") or DEFAULT_CODEX_BIN
    if not Path(codex_bin).exists():
        raise ValueError(f"CODEX_BIN not found: {codex_bin}")
    return codex_bin


def repo_commit_short(repo_path: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "rev-parse", "--short=6", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
        commit = result.stdout.strip()
        return commit[:6] if commit else "nogit"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "nogit"


def repo_zip_filename(repo_path: str) -> str:
    repo = Path(repo_path).name or "repo"
    commit = repo_commit_short(repo_path)
    safe_repo = re.sub(r"[^A-Za-z0-9._-]+", "_", repo).strip("._") or "repo"
    return f"{safe_repo}-{commit}.zip"


def git_visible_files(repo_path: str) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "ls-files", "-co", "--exclude-standard", "-z"],
            check=True,
            capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    files = [item.decode("utf-8", errors="surrogateescape") for item in result.stdout.split(b"\0") if item]
    return [file for file in files if file and not file.startswith(".git/")]


def safe_export_file(root: Path, rel: str) -> bool:
    relative = Path(rel)
    if relative.is_absolute() or ".." in relative.parts:
        return False
    forbidden = {".git", ".secrets", "secrets", ".ssh", ".aws", ".codex",
                 "data", "logs", "run", "node_modules", "__pycache__", ".venv"}
    parts = [part.lower() for part in relative.parts]
    if any(part in forbidden or part.startswith(".env") or part.startswith(".venv") for part in parts):
        return False
    if relative.name.lower() in {"auth.json", "credentials.json", "credentials", "id_rsa", "id_ed25519"}:
        return False
    if relative.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}:
        return False
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            return False
    return path.is_file() and path.resolve().is_relative_to(root)


def open_export_file(root: Path, rel: str):
    # Open every component relative to a directory fd, refusing symlinks even if
    # the checkout changes between enumeration and reading.
    if not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("Safe ZIP export requires Linux/WSL")
    parts = Path(rel).parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(root, flags)
    try:
        for part in parts[:-1]:
            next_directory = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError("ZIP export only includes regular files")
        return os.fdopen(fd, "rb")
    finally:
        os.close(directory)


def create_repo_zip(repo_path: str) -> tuple[Path, str]:
    repo = require_allowed_repo(repo_path)
    root = Path(repo).resolve()
    check = subprocess.run(["git", "-C", repo, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True)
    if check.returncode or Path(check.stdout.strip()).resolve() != root:
        raise ValueError("ZIP export requires an allowed Git repository root")
    files = [rel for rel in git_visible_files(repo) if safe_export_file(root, rel)]
    if not files:
        raise ValueError("No exportable files in this repository")
    filename = repo_zip_filename(repo)
    fd, tmp_name = tempfile.mkstemp(prefix="tunnel-chat-repo-", suffix=".zip")
    os.close(fd)
    zip_path = Path(tmp_name)
    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for rel in files:
                if safe_export_file(root, rel):
                    with open_export_file(root, rel) as source:
                        with archive.open(f"{Path(filename).stem}/{rel}", "w") as target:
                            shutil.copyfileobj(source, target, length=1024 * 1024)
    except Exception:
        zip_path.unlink(missing_ok=True)
        raise
    return zip_path, filename


def create_codex_chat(repo_path: str, title: str | None = None) -> int:
    repo = require_allowed_repo(repo_path)
    label = title.strip() if title and title.strip() else f"{Path(repo).name} chat"
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO codex_chats(created_at, updated_at, title, repo_path, status)
            VALUES (?, ?, ?, ?, 'idle')
            """,
            (now_iso(), now_iso(), label[:120], repo),
        )
        conn.commit()
        chat_id = int(cur.lastrowid)
    add_codex_message(chat_id, "system", f"Codex session created for `{repo}`.", "system")
    return chat_id


def get_codex_chat(chat_id: int) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute(
            """
            SELECT id, created_at, updated_at, title, repo_path, codex_session_id,
                   status, running_pid, process_group, activity, last_error, backend, host_id
            FROM codex_chats
            WHERE id = ?
            """,
            (chat_id,),
        ).fetchone()


def list_codex_chats() -> list[dict[str, object]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, updated_at, title, repo_path, codex_session_id,
                   status, running_pid, process_group, activity, last_error, backend, host_id
            FROM codex_chats
            WHERE backend = 'cli-wsl'
            ORDER BY updated_at DESC, id DESC
            LIMIT 80
            """
        ).fetchall()
    return [dict(row) for row in rows]


def list_codex_messages(chat_id: int, limit: int = 200) -> list[dict[str, object]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, chat_id, created_at, author, body, kind
            FROM codex_messages
            WHERE chat_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (chat_id, limit),
        ).fetchall()
    return [dict(row) for row in reversed(rows)]


def add_codex_message(chat_id: int, author: str, body: str, kind: str = "message") -> int:
    body = redact_secrets(str(body).strip())
    if not body:
        body = "(empty)"
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO codex_messages(chat_id, created_at, author, body, kind)
            VALUES (?, ?, ?, ?, ?)
            """,
            (chat_id, now_iso(), author[:40], body, kind[:40]),
        )
        conn.execute("UPDATE codex_chats SET updated_at = ? WHERE id = ?", (now_iso(), chat_id))
        conn.commit()
        message_id = int(cur.lastrowid)
    notify_event()
    return message_id


def update_codex_chat(chat_id: int, **fields: object) -> None:
    allowed = {
        "title",
        "codex_session_id",
        "status",
        "running_pid",
        "process_group",
        "activity",
        "last_error",
    }
    assignments: list[str] = []
    values: list[object] = []
    for key, value in fields.items():
        if key not in allowed:
            continue
        assignments.append(f"{key} = ?")
        values.append(value)
    assignments.append("updated_at = ?")
    values.append(now_iso())
    values.append(chat_id)
    with connect() as conn:
        conn.execute(f"UPDATE codex_chats SET {', '.join(assignments)} WHERE id = ?", values)
        conn.commit()
    notify_event()


def claim_codex_chat(chat_id: int, display_prompt: str) -> None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        chat = conn.execute("SELECT status FROM codex_chats WHERE id = ?", (chat_id,)).fetchone()
        if chat is None:
            raise ValueError(f"unknown codex chat #{chat_id}")
        if str(chat["status"]) == "running":
            raise ValueError(f"codex chat #{chat_id} is already running")
        updated = conn.execute(
            """
            UPDATE codex_chats
            SET status = 'running', running_pid = NULL, process_group = NULL,
                activity = 'starting', last_error = NULL, updated_at = ?
            WHERE id = ? AND status != 'running'
            """,
            (now_iso(), chat_id),
        )
        if updated.rowcount != 1:
            raise ValueError(f"codex chat #{chat_id} is already running")
        conn.execute(
            """
            INSERT INTO codex_messages(chat_id, created_at, author, body, kind)
            VALUES (?, ?, 'user', ?, 'message')
            """,
            (chat_id, now_iso(), redact_secrets(display_prompt.strip()) or "(attachments only)"),
        )
        conn.commit()
    notify_event()


def parse_id_list(value: object) -> list[int]:
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    ids: list[int] = []
    for item in value:
        try:
            item_id = int(item)
        except (TypeError, ValueError):
            continue
        if item_id > 0 and item_id not in ids:
            ids.append(item_id)
    return ids


def safe_filename(filename: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(filename or "attachment").name).strip("._")
    return cleaned[:160] or "attachment"


def is_text_like_attachment(filename: str, mime_type: str) -> bool:
    if mime_type.startswith("text/"):
        return True
    return bool(re.search(r"\.(txt|log|md|json|jsonl|ya?ml|py|sh|toml|cfg|ini|csv|xml|html|css|js|ts)$", filename, re.I))


def is_image_attachment(filename: str, mime_type: str) -> bool:
    guessed = mimetypes.guess_type(filename)[0] or ""
    return mime_type.startswith("image/") or guessed.startswith("image/")


def attachment_storage_path(chat_id: int, attachment_id: int, filename: str) -> Path:
    folder = CODEX_ATTACHMENTS_DIR / str(chat_id)
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{attachment_id}-{safe_filename(filename)}"


def attachment_preview(data: bytes, filename: str, mime_type: str) -> str:
    if not is_text_like_attachment(filename, mime_type):
        return ""
    text = data[:12000].decode("utf-8", errors="replace")
    return text[:6000]


def create_codex_attachment_upload(chat_id: int, filename: str, mime_type: str, size: int, total_chunks: int) -> int:
    if get_codex_chat(chat_id) is None:
        raise ValueError(f"unknown codex chat #{chat_id}")
    validate_upload_shape(int(size), int(total_chunks), MAX_CODEX_ATTACHMENT_BYTES, "attachment")
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO codex_attachment_uploads(created_at, chat_id, filename, mime_type, size, total_chunks)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (now_iso(), chat_id, safe_filename(filename), (mime_type or "application/octet-stream")[:120], int(size), int(total_chunks)),
        )
        conn.commit()
        return int(cur.lastrowid)


def add_codex_attachment_chunk(upload_id: int, chunk_index: int, body: str) -> None:
    with connect() as conn:
        session = conn.execute(
            "SELECT size, total_chunks FROM codex_attachment_uploads WHERE id = ?",
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown codex attachment upload #{upload_id}")
        total_chunks = int(session["total_chunks"])
        if chunk_index < 0 or chunk_index >= total_chunks:
            raise ValueError(f"chunk_index must be between 0 and {total_chunks - 1}")
        validate_base64url_chunk(body, chunk_index, int(session["size"]), total_chunks)
        conn.execute(
            """
            INSERT OR REPLACE INTO codex_attachment_chunks(upload_id, chunk_index, body)
            VALUES (?, ?, ?)
            """,
            (upload_id, int(chunk_index), body),
        )
        conn.commit()


def finish_codex_attachment_upload(upload_id: int) -> dict[str, object]:
    with connect() as conn:
        session = conn.execute(
            """
            SELECT id, chat_id, filename, mime_type, size, total_chunks
            FROM codex_attachment_uploads
            WHERE id = ?
            """,
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown codex attachment upload #{upload_id}")
        chunks = conn.execute(
            """
            SELECT chunk_index, body
            FROM codex_attachment_chunks
            WHERE upload_id = ?
            ORDER BY chunk_index ASC
            """,
            (upload_id,),
        ).fetchall()
        total_chunks = int(session["total_chunks"])
        if len(chunks) != total_chunks:
            raise ValueError(f"attachment upload #{upload_id} has {len(chunks)}/{total_chunks} chunks")
        data = b"".join(decode_base64url_chunk(str(row["body"])) for row in chunks)
        expected_size = int(session["size"])
        if len(data) != expected_size:
            raise ValueError(f"attachment upload #{upload_id} size mismatch: got {len(data)} bytes, expected {expected_size}")
        chat_id = int(session["chat_id"])
        filename = str(session["filename"])
        mime_type = str(session["mime_type"] or mimetypes.guess_type(filename)[0] or "application/octet-stream")
        is_image = 1 if is_image_attachment(filename, mime_type) else 0
        preview = attachment_preview(data, filename, mime_type)
        cur = conn.execute(
            """
            INSERT INTO codex_attachments(created_at, chat_id, filename, mime_type, size, path, preview_text, is_image)
            VALUES (?, ?, ?, ?, ?, '', ?, ?)
            """,
            (now_iso(), chat_id, filename, mime_type, len(data), preview, is_image),
        )
        attachment_id = int(cur.lastrowid)
        path = attachment_storage_path(chat_id, attachment_id, filename)
        path.write_bytes(data)
        conn.execute(
            "UPDATE codex_attachments SET path = ?, size = ? WHERE id = ?",
            (str(path), len(data), attachment_id),
        )
        conn.execute("DELETE FROM codex_attachment_chunks WHERE upload_id = ?", (upload_id,))
        conn.execute("DELETE FROM codex_attachment_uploads WHERE id = ?", (upload_id,))
        conn.commit()
    return {
        "id": attachment_id,
        "chat_id": chat_id,
        "filename": filename,
        "mime_type": mime_type,
        "size": len(data),
        "path": str(path),
        "preview_text": preview,
        "is_image": bool(is_image),
    }


def get_codex_attachments(chat_id: int, attachment_ids: list[int]) -> list[dict[str, object]]:
    if not attachment_ids:
        return []
    placeholders = ",".join("?" for _ in attachment_ids)
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT id, chat_id, filename, mime_type, size, path, preview_text, is_image
            FROM codex_attachments
            WHERE chat_id = ? AND id IN ({placeholders})
            ORDER BY id ASC
            """,
            [chat_id, *attachment_ids],
        ).fetchall()
    return [dict(row) for row in rows]


def attachment_context(attachments: list[dict[str, object]]) -> str:
    if not attachments:
        return ""
    parts = ["\n\nAttached files available to inspect:"]
    for att in attachments:
        filename = str(att["filename"])
        path = str(att["path"])
        mime_type = str(att["mime_type"])
        size = int(att["size"])
        line = f"- {filename} ({mime_type}, {size} bytes): {path}"
        if bool(att["is_image"]):
            line += " [image also passed via -i]"
        parts.append(line)
        preview = str(att.get("preview_text") or "").strip()
        if preview:
            excerpt = preview[:2000]
            parts.append(f"\nPreview of {filename}:\n```text\n{excerpt}\n```")
    return "\n".join(parts)


def create_codex_prompt_upload(
    chat_id: int,
    size: int,
    total_chunks: int,
    attachment_ids: list[int] | None = None,
    body_encoding: str = "base64url",
) -> int:
    if get_codex_chat(chat_id) is None:
        raise ValueError(f"unknown codex chat #{chat_id}")
    validate_upload_shape(int(size), int(total_chunks), MAX_CODEX_PROMPT_BYTES, "prompt")
    if body_encoding != "base64url":
        raise ValueError("prompt body_encoding must be base64url")
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO codex_prompt_uploads(created_at, chat_id, size, total_chunks, body_encoding, attachment_ids)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                now_iso(),
                chat_id,
                int(size),
                int(total_chunks),
                body_encoding,
                json.dumps(attachment_ids or []),
            ),
        )
        conn.commit()
        return int(cur.lastrowid)


def add_codex_prompt_chunk(upload_id: int, chunk_index: int, body: str) -> None:
    with connect() as conn:
        session = conn.execute(
            "SELECT size, total_chunks, body_encoding FROM codex_prompt_uploads WHERE id = ?",
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown codex prompt upload #{upload_id}")
        total_chunks = int(session["total_chunks"])
        if chunk_index < 0 or chunk_index >= total_chunks:
            raise ValueError(f"chunk_index must be between 0 and {total_chunks - 1}")
        if str(session["body_encoding"] or "") != "base64url":
            raise ValueError("prompt upload must use base64url")
        validate_base64url_chunk(body, chunk_index, int(session["size"]), total_chunks)
        conn.execute(
            """
            INSERT OR REPLACE INTO codex_prompt_chunks(upload_id, chunk_index, body)
            VALUES (?, ?, ?)
            """,
            (upload_id, int(chunk_index), body),
        )
        conn.commit()


def finish_codex_prompt_upload(upload_id: int, submit=None) -> tuple[int, int]:
    with connect() as conn:
        session = conn.execute(
            """
            SELECT id, chat_id, size, total_chunks, body_encoding, attachment_ids
            FROM codex_prompt_uploads
            WHERE id = ?
            """,
            (upload_id,),
        ).fetchone()
        if session is None:
            raise ValueError(f"unknown codex prompt upload #{upload_id}")
        chunks = conn.execute(
            """
            SELECT chunk_index, body
            FROM codex_prompt_chunks
            WHERE upload_id = ?
            ORDER BY chunk_index ASC
            """,
            (upload_id,),
        ).fetchall()
        total_chunks = int(session["total_chunks"])
        if len(chunks) != total_chunks:
            raise ValueError(f"prompt upload #{upload_id} has {len(chunks)}/{total_chunks} chunks")
        if str(session["body_encoding"] or "") != "base64url":
            raise ValueError("prompt upload must use base64url")
        data = b"".join(decode_base64url_chunk(str(row["body"])) for row in chunks)
        if len(data) != int(session["size"]):
            raise ValueError(
                f"prompt upload #{upload_id} size mismatch: got {len(data)} bytes, expected {int(session['size'])}"
            )
        prompt = data.decode("utf-8", errors="replace")
        conn.execute("DELETE FROM codex_prompt_chunks WHERE upload_id = ?", (upload_id,))
        conn.execute("DELETE FROM codex_prompt_uploads WHERE id = ?", (upload_id,))
        conn.commit()
    chat_id = int(session["chat_id"])
    (submit or start_codex_turn)(chat_id, prompt, parse_id_list(session["attachment_ids"]))
    return chat_id, len(prompt)


def extract_session_id(value: object) -> str | None:
    if isinstance(value, dict):
        for key in ("session_id", "conversation_id", "rollout_id", "thread_id", "threadId"):
            candidate = value.get(key)
            if isinstance(candidate, str) and UUID_RE.fullmatch(candidate):
                return candidate
        for nested in value.values():
            found = extract_session_id(nested)
            if found:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = extract_session_id(nested)
            if found:
                return found
    return None


def codex_error_text(event: dict[str, object]) -> str | None:
    event_type = str(event.get("type") or "")
    if event_type not in {"error", "fatal", "exec_error"}:
        return None
    for key in ("message", "error", "text"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return json.dumps(event, ensure_ascii=False)


def summarize_codex_event(event: dict[str, object]) -> str:
    event_type = str(event.get("type") or "working").replace("_", " ").replace(".", " ")
    item = event.get("item") if isinstance(event.get("item"), dict) else {}
    item_type = str(item.get("type") or "").replace("_", " ").replace(".", " ")
    detail = item_type or event_type
    command = item.get("command") if isinstance(item, dict) else None
    if isinstance(command, str) and command.strip():
        detail = f"{detail}: {command.strip()[:160]}"
    return redact_secrets(detail)[:240]


def pid_looks_like_codex(pid: int) -> bool:
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", errors="ignore")
    except OSError:
        return False
    return "codex" in command.lower()


def terminate_process_group(process_group: int, proc: subprocess.Popen[str] | None = None, timeout: float = 5.0) -> None:
    if process_group <= 0:
        return
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None:
            if proc.poll() is not None:
                return
        else:
            try:
                os.killpg(process_group, 0)
            except ProcessLookupError:
                return
        time.sleep(0.1)
    try:
        os.killpg(process_group, signal.SIGKILL)
    except ProcessLookupError:
        pass


def reconcile_codex_runs() -> int:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, process_group FROM codex_chats WHERE status = 'running' AND backend = 'cli-wsl'"
        ).fetchall()
        for row in rows:
            process_group = int(row["process_group"] or 0)
            if process_group and pid_looks_like_codex(process_group):
                terminate_process_group(process_group, timeout=1.0)
            conn.execute(
                """
                UPDATE codex_chats
                SET status = 'error', running_pid = NULL, process_group = NULL,
                    activity = NULL, last_error = ?, updated_at = ?
                WHERE id = ?
                """,
                ("Codex run was interrupted by a server restart.", now_iso(), int(row["id"])),
            )
        conn.commit()
    if rows:
        notify_event()
    return len(rows)


def start_codex_turn(chat_id: int, prompt: str, attachment_ids: list[int] | None = None) -> None:
    prompt = redact_secrets(prompt.strip())
    attachment_ids = attachment_ids or []
    if not prompt and not attachment_ids:
        raise ValueError("empty prompt")
    chat = get_codex_chat(chat_id)
    if chat is None:
        raise ValueError(f"unknown codex chat #{chat_id}")
    if chat["backend"] != "cli-wsl":
        raise ValueError("Use the Desktop page for this task")
    get_codex_bin()
    if not Path(str(chat["repo_path"])).is_dir():
        raise ValueError(f"repo directory is missing: {chat['repo_path']}")
    attachments = get_codex_attachments(chat_id, attachment_ids)
    display_prompt = prompt
    if attachments:
        names = ", ".join(str(att["filename"]) for att in attachments)
        display_prompt = f"{prompt}\n\nAttachments: {names}".strip()
    claim_codex_chat(chat_id, display_prompt)
    thread = threading.Thread(target=run_codex_turn, args=(chat_id, prompt, attachment_ids), daemon=True)
    try:
        thread.start()
    except Exception:
        update_codex_chat(chat_id, status="error", activity=None, last_error="Could not start Codex runner thread.")
        raise


def run_codex_turn(chat_id: int, prompt: str, attachment_ids: list[int] | None = None) -> None:
    chat = get_codex_chat(chat_id)
    if chat is None:
        return
    repo_path = str(chat["repo_path"])
    session_id = str(chat["codex_session_id"] or "")
    attachments = get_codex_attachments(chat_id, attachment_ids or [])
    prompt_for_codex = f"{prompt}{attachment_context(attachments)}".strip()
    image_paths = [str(att["path"]) for att in attachments if bool(att["is_image"])]
    output_path = Path(tempfile.gettempdir()) / f"rlcsd-codex-last-{chat_id}-{os.getpid()}-{threading.get_ident()}.txt"
    config = load_config()
    env = os.environ.copy()
    env["CODEX_HOME"] = config.get("codex_home") or DEFAULT_CODEX_HOME
    codex_bin = get_codex_bin()
    chat_attachments_dir = CODEX_ATTACHMENTS_DIR / str(chat_id)
    chat_attachments_dir.mkdir(parents=True, exist_ok=True)
    shared_args = [
        "--skip-git-repo-check",
        "--add-dir",
        str(chat_attachments_dir.resolve()),
        "-s",
        "workspace-write",
    ]
    image_args: list[str] = []
    for image_path in image_paths:
        image_args.extend(["-i", image_path])
    if session_id:
        cmd = [
            codex_bin,
            "exec",
            "--json",
            "-C",
            repo_path,
            *shared_args,
            *image_args,
            "-o",
            str(output_path),
            "resume",
            "--all",
            session_id,
            "-",
        ]
    else:
        cmd = [
            codex_bin,
            "exec",
            "--json",
            "-C",
            repo_path,
            *shared_args,
            *image_args,
            "-o",
            str(output_path),
            "-",
        ]
    add_codex_message(chat_id, "system", f"Running Codex in `{repo_path}`.", "system")
    raw_tail: list[str] = []
    found_session_id: str | None = None
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=repo_path,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=True,
        )
        with CODEX_RUNNERS_LOCK:
            CODEX_RUNNERS[chat_id] = proc
            CODEX_CANCELLED.discard(chat_id)
        update_codex_chat(chat_id, running_pid=proc.pid, process_group=proc.pid, activity="running")
        assert proc.stdin is not None
        proc.stdin.write(prompt_for_codex)
        proc.stdin.close()
        last_activity = ""
        last_activity_at = 0.0
        if proc.stdout is not None:
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                raw_tail.append(line)
                raw_tail = raw_tail[-12:]
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                found_session_id = found_session_id or extract_session_id(event)
                error = codex_error_text(event)
                if error:
                    add_codex_message(chat_id, "system", error, "error")
                activity = summarize_codex_event(event)
                now = time.monotonic()
                if activity != last_activity and now - last_activity_at >= 0.75:
                    update_codex_chat(chat_id, activity=activity)
                    last_activity = activity
                    last_activity_at = now
        exit_code = proc.wait()
        if found_session_id:
            update_codex_chat(chat_id, codex_session_id=found_session_id)
        final_text = ""
        if output_path.exists():
            final_text = output_path.read_text(encoding="utf-8", errors="replace").strip()
        with CODEX_RUNNERS_LOCK:
            cancelled = chat_id in CODEX_CANCELLED
        if cancelled:
            update_codex_chat(
                chat_id,
                status="idle",
                running_pid=None,
                process_group=None,
                activity=None,
                last_error=None,
            )
        elif exit_code == 0:
            add_codex_message(chat_id, "codex", final_text or "(Codex finished without a final message.)", "message")
            if not session_id and not found_session_id:
                detail = "Codex completed without returning a session id; this chat cannot safely resume that turn."
                add_codex_message(chat_id, "system", detail, "error")
                update_codex_chat(
                    chat_id,
                    status="error",
                    running_pid=None,
                    process_group=None,
                    activity=None,
                    last_error=detail,
                )
            else:
                update_codex_chat(
                    chat_id,
                    status="idle",
                    running_pid=None,
                    process_group=None,
                    activity=None,
                    last_error=None,
                )
        else:
            detail = final_text or "\n".join(raw_tail[-6:]) or f"Codex exited with status {exit_code}"
            add_codex_message(chat_id, "system", detail, "error")
            update_codex_chat(
                chat_id,
                status="error",
                running_pid=None,
                process_group=None,
                activity=None,
                last_error=detail[:1000],
            )
    except Exception as exc:
        detail = f"Codex runner failed: {exc}"
        add_codex_message(chat_id, "system", detail, "error")
        update_codex_chat(
            chat_id,
            status="error",
            running_pid=None,
            process_group=None,
            activity=None,
            last_error=detail,
        )
    finally:
        with CODEX_RUNNERS_LOCK:
            CODEX_RUNNERS.pop(chat_id, None)
            CODEX_CANCELLED.discard(chat_id)
        try:
            output_path.unlink()
        except OSError:
            pass


def cancel_codex_turn(chat_id: int) -> bool:
    chat = get_codex_chat(chat_id)
    if chat is None or chat["backend"] != "cli-wsl":
        raise ValueError("Use the Desktop page to stop a desktop turn")
    with CODEX_RUNNERS_LOCK:
        proc = CODEX_RUNNERS.get(chat_id)
    if proc is None or proc.poll() is not None:
        update_codex_chat(chat_id, status="idle", running_pid=None, process_group=None, activity=None)
        return False
    with CODEX_RUNNERS_LOCK:
        CODEX_CANCELLED.add(chat_id)
    terminate_process_group(proc.pid, proc=proc)
    add_codex_message(chat_id, "system", "Codex process was terminated.", "system")
    update_codex_chat(
        chat_id,
        status="idle",
        running_pid=None,
        process_group=None,
        activity=None,
        last_error=None,
    )
    return True


def html_page() -> str:
    return r"""<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RLCSD Fix Chat</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #171a1f;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #1f6feb;
      --ok: #137333;
      --warn: #b54708;
      --code: #f2f4f7;
      --code-text: #1d2939;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1115;
        --panel: #171a21;
        --text: #f3f4f6;
        --muted: #9aa4b2;
        --line: #2b3340;
        --accent: #79a7ff;
        --ok: #74c69d;
        --warn: #fdb022;
        --code: #222833;
        --code-text: #eef2f6;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    header h1 { font-size: 16px; margin: 0; font-weight: 650; }
    header a { color: var(--accent); text-decoration: none; font-size: 13px; }
    #status { color: var(--muted); font-size: 13px; white-space: nowrap; }
    main {
      min-height: 0;
      overflow-y: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg {
      max-width: min(980px, 96%);
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px 12px;
      align-self: flex-start;
    }
    .msg.client { align-self: flex-end; border-color: color-mix(in srgb, var(--accent), var(--line) 55%); }
    .msg.codex { border-color: color-mix(in srgb, var(--ok), var(--line) 55%); }
    .msg.system { color: var(--muted); }
    .meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .badge {
      font-size: 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 7px;
      color: var(--muted);
    }
    .body {
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.45;
      font-size: 14px;
    }
    .body p { margin: 0 0 7px; }
    .body p:last-child { margin-bottom: 0; }
    .body h3,
    .body h4 {
      margin: 8px 0 6px;
      font-size: 14px;
      line-height: 1.3;
    }
    .body h3:first-child,
    .body h4:first-child { margin-top: 0; }
    .body ul,
    .body ol {
      margin: 4px 0 8px 20px;
      padding: 0;
    }
    .body li { margin: 2px 0; }
    .body blockquote {
      margin: 6px 0;
      padding: 4px 10px;
      border-left: 3px solid var(--line);
      color: var(--muted);
    }
    .body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: var(--code);
      color: var(--code-text);
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 1px 4px;
      font-size: 13px;
    }
    .body pre {
      margin: 0;
      padding: 10px;
      background: var(--code);
      color: var(--code-text);
      border: 0;
      border-radius: 0 0 7px 7px;
      overflow-x: auto;
    }
    .body pre code {
      display: block;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      white-space: pre;
      overflow-wrap: normal;
    }
    .msg.command .body {
      font-family: inherit;
      background: transparent;
      color: inherit;
      padding: 0;
      border-radius: 0;
    }
    .code-block {
      margin: 7px 0 9px;
      border: 1px solid var(--line);
      border-radius: 7px;
      overflow: hidden;
      background: var(--code);
    }
    .code-toolbar {
      min-height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 6px 4px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .code-lang {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .copy-code {
      height: 24px;
      min-width: 52px;
      padding: 0 8px;
      border-radius: 6px;
      font-size: 12px;
      background: var(--panel);
    }
    .file-card {
      width: min(560px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel), var(--code) 26%);
      overflow: hidden;
    }
    .file-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
    }
    .file-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
      font-size: 13px;
    }
    .file-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .file-action {
      height: 26px;
      padding: 0 8px;
      border-radius: 6px;
      font-size: 12px;
      background: var(--panel);
    }
    .file-preview {
      margin: 0;
      max-height: 150px;
      padding: 9px 10px;
      overflow: hidden;
      white-space: pre-wrap;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--muted);
    }
    .file-meta {
      padding: 0 10px 9px;
      color: var(--muted);
      font-size: 12px;
    }
    .pending-file {
      grid-column: 1 / -1;
      display: none;
    }
    .pending-file.ready {
      display: block;
    }
    .pending-file .file-card {
      width: 100%;
    }
    .notice {
      grid-column: 1 / -1;
      display: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .notice.show {
      display: block;
    }
    .notice.warn {
      border-color: color-mix(in srgb, var(--warn), var(--line) 55%);
      color: var(--warn);
    }
    .notice.info {
      border-color: color-mix(in srgb, var(--accent), var(--line) 55%);
      color: var(--accent);
    }
    footer {
      border-top: 1px solid var(--line);
      background: var(--panel);
      padding: 12px;
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      align-items: end;
    }
    textarea {
      width: 100%;
      min-height: 86px;
      max-height: 34vh;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: transparent;
      color: var(--text);
      font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    button {
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
      padding: 0 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.warn { color: var(--warn); }
    input[type="file"] { display: none; }
    #dropOverlay {
      position: fixed;
      inset: 10px;
      z-index: 10;
      display: none;
      place-items: center;
      border: 2px dashed var(--accent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--panel), transparent 12%);
      color: var(--accent);
      font-weight: 700;
      pointer-events: none;
    }
    body.dragging #dropOverlay { display: grid; }
    @media (max-width: 680px) {
      header { padding: 0 12px; }
      main { padding: 12px; }
      footer { grid-template-columns: 1fr; }
      button { width: 100%; }
      .msg { max-width: 100%; }
    }
  </style>
</head>
<body>
  <nav style="padding:8px 16px"><a href="/codex">Desktop app</a> · <a href="/codex/cli">WSL CLI</a> · <a href="/queue">Fix queue</a></nav>
  <header>
    <h1>RLCSD Fix Chat</h1>
    <div>
      <a href="/codex">Desktop app</a> · <a href="/codex/cli">WSL CLI</a>
      <button id="downloadRepo" type="button">Download zip</button>
      <span id="status">connecting</span>
    </div>
  </header>
  <main id="messages"></main>
  <div id="dropOverlay">Drop text file to stage</div>
  <footer>
    <textarea id="input" placeholder="Paste traceback/log here, then Send & Fix."></textarea>
    <input id="fileInput" type="file" accept=".txt,.log,.md,.json,.jsonl,.yaml,.yml,.py,.sh,.toml,.cfg,.ini,text/*">
    <button id="fileButton">File</button>
    <button class="primary" id="sendFix">Send & Fix</button>
    <div id="pendingFile" class="pending-file"></div>
    <div id="notice" class="notice"></div>
  </footer>
  <script src="/static/shared.js"></script>
  <script>
    const token = RLCSDTransport.accessToken();
    const messagesEl = document.getElementById("messages");
    const statusEl = document.getElementById("status");
    const inputEl = document.getElementById("input");
    const fileInputEl = document.getElementById("fileInput");
    const pendingFileEl = document.getElementById("pendingFile");
    const noticeEl = document.getElementById("notice");
    const sendFixEl = document.getElementById("sendFix");
    const maxTextFileBytes = 4 * 1024 * 1024;
    const inlineTextLimit = 12000;
    const transportConfig = __TRANSPORT_CONFIG__;
    const uploadChunkBytes = transportConfig.chunkBytes;
    const apiBase = "/g";
    const attachmentPrefix = "RLCSD_TEXT_ATTACHMENT:";
    let dragDepth = 0;
    const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let lastMessagesKey = "";
    let forceScrollOnNextRender = true;
    let pendingAttachment = null;
    let isSending = false;

    function showNotice(message, kind = "warn") {
      noticeEl.textContent = message;
      noticeEl.className = `notice show ${kind}`;
    }

    function clearNotice() {
      noticeEl.textContent = "";
      noticeEl.className = "notice";
    }

    function setSending(active) {
      isSending = active;
      sendFixEl.disabled = active;
      sendFixEl.textContent = active ? "Sending..." : "Send & Fix";
    }

    function escapeRegExp(source) {
      return String(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function sanitizeErrorMessage(message) {
      let text = String(message || "");
      if (token) text = text.replace(new RegExp(escapeRegExp(token), "g"), "[redacted]");
      text = text
        .replace(/(x-chat-token(?:%3A|:)(?:%20|\s)*)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
        .replace(/((?:[?&]|%3F|%26)token(?:=|%3D))[^&%\s\"'<>]+/gi, "$1[redacted]");
      if (/<!doctype|<html|<body/i.test(text)) {
        try {
          const doc = new DOMParser().parseFromString(text, "text/html");
          const title = doc.querySelector("title")?.textContent?.trim();
          const heading = doc.querySelector("h2, h1")?.textContent?.trim();
          const error = doc.querySelector("#error")?.textContent?.replace(/\s+/g, " ").trim();
          const link = doc.querySelector("#content a[href]")?.getAttribute("href");
          text = [title, heading, error, link ? `URL: ${link}` : ""].filter(Boolean).join(" | ");
        } catch (err) {
          text = text.replace(/<[^>]*>/g, " ");
        }
      }
      text = text.replace(/\s+/g, " ").trim();
      if (text.length > 1000) text = `${text.slice(0, 1000)}...`;
      return text || "request failed";
    }

    function isNearBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
    }

    function hasActiveMessageSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return false;
      return messagesEl.contains(selection.anchorNode) || messagesEl.contains(selection.focusNode);
    }

    function messagesKey(messages) {
      const last = messages[messages.length - 1];
      return `${messages.length}:${last ? `${last.id}:${last.created_at}` : "empty"}`;
    }

    function renderInline(text) {
      const codeSpans = [];
      let escaped = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
        const token = `\u0000CODE${codeSpans.length}\u0000`;
        codeSpans.push(`<code>${code}</code>`);
        return token;
      });
      escaped = escaped
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      return escaped.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)]);
    }

    function closeList(state) {
      if (!state.list) return "";
      const tag = state.list;
      state.list = "";
      return `</${tag}>`;
    }

    function renderTextBlock(text) {
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      const state = {list: ""};
      const out = [];
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line.trim()) {
          out.push(closeList(state));
          continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
          out.push(closeList(state));
          const tag = heading[1].length <= 2 ? "h3" : "h4";
          out.push(`<${tag}>${renderInline(heading[2])}</${tag}>`);
          continue;
        }
        const ul = line.match(/^\s*[-*]\s+(.+)$/);
        if (ul) {
          if (state.list !== "ul") {
            out.push(closeList(state));
            out.push("<ul>");
            state.list = "ul";
          }
          out.push(`<li>${renderInline(ul[1])}</li>`);
          continue;
        }
        const ol = line.match(/^\s*\d+\.\s+(.+)$/);
        if (ol) {
          if (state.list !== "ol") {
            out.push(closeList(state));
            out.push("<ol>");
            state.list = "ol";
          }
          out.push(`<li>${renderInline(ol[1])}</li>`);
          continue;
        }
        const quote = line.match(/^\s*>\s?(.+)$/);
        if (quote) {
          out.push(closeList(state));
          out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
          continue;
        }
        out.push(closeList(state));
        out.push(`<p>${renderInline(line)}</p>`);
      }
      out.push(closeList(state));
      return out.join("");
    }

    function renderMarkdown(source) {
      const text = String(source || "");
      const fence = /```([A-Za-z0-9_-]*)?\n?([\s\S]*?)```/g;
      let html = "";
      let lastIndex = 0;
      let match;
      while ((match = fence.exec(text)) !== null) {
        html += renderTextBlock(text.slice(lastIndex, match.index));
        const langLabel = match[1] ? escapeHtml(match[1]) : "code";
        const lang = match[1] ? ` class="language-${escapeHtml(match[1])}"` : "";
        html += `<div class="code-block"><div class="code-toolbar"><span class="code-lang">${langLabel}</span><button class="copy-code" type="button">Copy</button></div><pre><code${lang}>${escapeHtml(match[2].replace(/\n$/, ""))}</code></pre></div>`;
        lastIndex = fence.lastIndex;
      }
      html += renderTextBlock(text.slice(lastIndex));
      return html || "<p></p>";
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function makeErrorFilename() {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `error_at_${hh}h${mm}.txt`;
    }

    function makeAttachmentBody(filename, text) {
      return attachmentPrefix + JSON.stringify({
        filename,
        size: new Blob([text]).size,
        text,
      });
    }

    function parseAttachment(source) {
      if (!String(source || "").startsWith(attachmentPrefix)) return null;
      try {
        return JSON.parse(String(source).slice(attachmentPrefix.length));
      } catch (err) {
        return null;
      }
    }

    function renderFileCard(file) {
      const text = String(file.text || "");
      const preview = text.split("\n").slice(0, 8).join("\n");
      const lines = text ? text.split("\n").length : 0;
      return `
        <div class="file-card" data-filename="${escapeHtml(file.filename || "error.txt")}">
          <div class="file-card-head">
            <div class="file-name">${escapeHtml(file.filename || "error.txt")}</div>
            <div class="file-actions">
              <button class="file-action copy-file" type="button">Copy</button>
              <button class="file-action download-file" type="button">Download</button>
            </div>
          </div>
          <pre class="file-preview">${escapeHtml(preview)}</pre>
          <div class="file-meta">${formatBytes(Number(file.size || text.length))} · ${lines} lines</div>
          <template class="file-data">${escapeHtml(JSON.stringify({filename: file.filename || "error.txt", text}))}</template>
        </div>
      `;
    }

    function renderPendingFile() {
      if (!pendingAttachment) {
        pendingFileEl.classList.remove("ready");
        pendingFileEl.innerHTML = "";
        return;
      }
      const text = String(pendingAttachment.text || "");
      const preview = text.split("\n").slice(0, 6).join("\n");
      const lines = text ? text.split("\n").length : 0;
      pendingFileEl.classList.add("ready");
      pendingFileEl.innerHTML = `
        <div class="file-card">
          <div class="file-card-head">
            <div class="file-name">${escapeHtml(pendingAttachment.filename || "error.txt")}</div>
            <div class="file-actions">
              <button class="file-action clear-pending-file" type="button">Remove</button>
            </div>
          </div>
          <pre class="file-preview">${escapeHtml(preview)}</pre>
          <div class="file-meta">ready to send · ${formatBytes(Number(pendingAttachment.size || text.length))} · ${lines} lines</div>
        </div>
      `;
    }

    function renderBody(source) {
      const attachment = parseAttachment(source);
      return attachment ? renderFileCard(attachment) : renderMarkdown(source);
    }

    async function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      document.execCommand("copy");
      area.remove();
    }

    messagesEl.addEventListener("click", async (ev) => {
      const button = ev.target.closest(".copy-code");
      if (!button) return;
      const block = button.closest(".code-block");
      const code = block ? block.querySelector("pre code") : null;
      if (!code) return;
      const original = button.textContent;
      try {
        await copyText(code.textContent || "");
        button.textContent = "Copied";
      } catch (err) {
        button.textContent = "Failed";
      }
      setTimeout(() => { button.textContent = original; }, 1200);
    });

    messagesEl.addEventListener("click", async (ev) => {
      const copyButton = ev.target.closest(".copy-file");
      const downloadButton = ev.target.closest(".download-file");
      if (!copyButton && !downloadButton) return;
      const card = ev.target.closest(".file-card");
      const dataEl = card ? card.querySelector(".file-data") : null;
      if (!dataEl) return;
      const payload = JSON.parse(dataEl.textContent || "{}");
      if (copyButton) {
        const original = copyButton.textContent;
        try {
          await copyText(payload.text || "");
          copyButton.textContent = "Copied";
        } catch (err) {
          copyButton.textContent = "Failed";
        }
        setTimeout(() => { copyButton.textContent = original; }, 1200);
      }
      if (downloadButton) {
        const blob = new Blob([payload.text || ""], {type: "text/plain;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = payload.filename || "error.txt";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }
    });

    function render(messages) {
      if (hasActiveMessageSelection()) return;
      const wasNearBottom = isNearBottom();
      const previousScrollTop = messagesEl.scrollTop;
      messagesEl.innerHTML = messages.map(m => `
        <article class="msg ${escapeHtml(m.author)} ${escapeHtml(m.kind)}">
          <div class="meta">
            <strong>${escapeHtml(m.author)}</strong>
            <span>${escapeHtml(m.created_at || "")}</span>
            ${m.request_id ? `<span class="badge">#${m.request_id}</span>` : ""}
          </div>
          <div class="body">${renderBody(m.body || "")}</div>
        </article>
      `).join("");
      if (forceScrollOnNextRender || wasNearBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        messagesEl.scrollTop = previousScrollTop;
      }
      forceScrollOnNextRender = false;
    }

    async function refresh() {
      try {
        const r = await fetch(`${apiBase}/list`, {headers: {"x-chat-token": token}, cache: "no-store"});
        if (!r.ok) throw new Error(await r.text());
        const data = await r.json();
        const key = messagesKey(data.messages);
        if (key === lastMessagesKey) {
          statusEl.textContent = "online";
          return;
        }
        if (hasActiveMessageSelection()) {
          statusEl.textContent = "online · paused while selecting";
          return;
        }
        lastMessagesKey = key;
        render(data.messages);
        statusEl.textContent = "online";
      } catch (err) {
        statusEl.textContent = "offline/auth";
      }
    }

    const apiPost = RLCSDTransport.createRpc({
      apiBase,
      token,
      retryLimit: transportConfig.retryLimit,
      sanitizeError: sanitizeErrorMessage,
    });

    async function uploadTextAsFile(filename, text, options = {}) {
      const normalized = String(text || "").replace(/\r\n/g, "\n");
      const blob = new Blob([normalized], {type: "text/plain;charset=utf-8"});
      const result = await RLCSDTransport.uploadBlob({
        rpc: apiPost,
        paths: {start: "start", chunk: "chunk", status: "status", finish: "finish"},
        blob,
        chunkBytes: uploadChunkBytes,
        concurrency: transportConfig.concurrency,
        retryLimit: transportConfig.retryLimit,
        startPayload: {filename, create_fix: Boolean(options.createFix)},
        onProgress: (completed, total) => {
          statusEl.textContent = `uploading ${filename} ${completed}/${total}`;
        },
      });
      forceScrollOnNextRender = true;
      await refresh();
      clearNotice();
      return result;
    }

    async function post(body, options = {}) {
      if (isSending) return;
      clearNotice();
      setSending(true);
      const text = body.trim();
      try {
        if (pendingAttachment) {
          const fileText = text ? `${text}\n\n${pendingAttachment.text || ""}` : String(pendingAttachment.text || "");
          try {
            await uploadTextAsFile(pendingAttachment.filename || makeErrorFilename(), fileText, {createFix: Boolean(options.createFix)});
            pendingAttachment = null;
            renderPendingFile();
            inputEl.value = "";
          } catch (err) {
            showNotice(`Upload failed: ${err.message}`);
          }
          return;
        }
        if (!text && !options.createFix) return;
        const isAttachment = text.startsWith(attachmentPrefix);
        if (!isAttachment && text.length > inlineTextLimit) {
          try {
            await uploadTextAsFile(makeErrorFilename(), text, {createFix: Boolean(options.createFix)});
            inputEl.value = "";
          } catch (err) {
            showNotice(`Upload failed: ${err.message}`);
          }
          return;
        }
        const payloadBody = text;
        try {
          await apiPost("send", {author: "client", body: payloadBody, create_fix: Boolean(options.createFix)});
        } catch (err) {
          showNotice(`Send failed: ${err.message}`);
          return;
        }
        inputEl.value = "";
        forceScrollOnNextRender = true;
        await refresh();
        clearNotice();
      } finally {
        setSending(false);
      }
    }

    function isTextLikeFile(file) {
      if (file.type && file.type.startsWith("text/")) return true;
      return /\.(txt|log|md|json|jsonl|ya?ml|py|sh|toml|cfg|ini|csv)$/i.test(file.name);
    }

    async function stageTextFile(file) {
      if (!isTextLikeFile(file)) {
        showNotice(`Unsupported file type: ${file.name}`);
        return;
      }
      if (file.size > maxTextFileBytes) {
        showNotice(`File too large: ${file.name}. Limit is ${Math.round(maxTextFileBytes / 1024 / 1024)} MB.`);
        return;
      }
      const text = (await file.text()).replace(/\r\n/g, "\n");
      pendingAttachment = {filename: file.name, size: file.size, text};
      renderPendingFile();
      clearNotice();
      statusEl.textContent = `ready: ${file.name}`;
    }

    async function handleFiles(files) {
      const list = Array.from(files || []);
      if (!list.length) return;
      if (list.length > 1) {
        showNotice("Only the first text file is staged.", "info");
      }
      await stageTextFile(list[0]);
    }

    sendFixEl.onclick = () => post(inputEl.value, {createFix: true});
    document.getElementById("fileButton").onclick = () => fileInputEl.click();
    document.getElementById("downloadRepo").onclick = () => {
      RLCSDTransport.download("/download/repo", token).catch(error => showNotice(error.message));
    };
    pendingFileEl.addEventListener("click", ev => {
      if (!ev.target.closest(".clear-pending-file")) return;
      pendingAttachment = null;
      renderPendingFile();
      statusEl.textContent = "online";
    });
    fileInputEl.onchange = async () => {
      await handleFiles(fileInputEl.files);
      fileInputEl.value = "";
    };
    inputEl.addEventListener("keydown", ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") post(inputEl.value, {createFix: true});
    });
    window.addEventListener("dragenter", ev => {
      ev.preventDefault();
      dragDepth += 1;
      document.body.classList.add("dragging");
    });
    window.addEventListener("dragleave", ev => {
      ev.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) document.body.classList.remove("dragging");
    });
    window.addEventListener("dragover", ev => ev.preventDefault());
    window.addEventListener("drop", async ev => {
      ev.preventDefault();
      dragDepth = 0;
      document.body.classList.remove("dragging");
      await handleFiles(ev.dataTransfer.files);
    });
    refresh();
    const stopLiveUpdates = RLCSDTransport.startLiveUpdates({
      token,
      poll: refresh,
      onUpdate: refresh,
      onState: state => {
        if (state === "live" && !isSending) statusEl.textContent = "online · live";
      },
    });
    window.addEventListener("beforeunload", stopLiveUpdates);
  </script>
</body>
</html>
""".replace("__TRANSPORT_CONFIG__", client_transport_config())


def codex_page() -> str:
    return r"""<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RLCSD Codex Mode</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #171a1f;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #1f6feb;
      --ok: #137333;
      --warn: #b54708;
      --code: #f2f4f7;
      --code-text: #1d2939;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1115;
        --panel: #171a21;
        --text: #f3f4f6;
        --muted: #9aa4b2;
        --line: #2b3340;
        --accent: #79a7ff;
        --ok: #74c69d;
        --warn: #fdb022;
        --code: #222833;
        --code-text: #eef2f6;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: 56px 1fr;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 650; }
    header a { color: var(--accent); text-decoration: none; font-size: 13px; }
    .header-actions { display: flex; align-items: center; gap: 10px; min-width: 0; }
    #codexMode { max-width: 210px; font-weight: 650; }
    #status { color: var(--muted); font-size: 13px; white-space: nowrap; }
    .shell {
      min-height: 0;
      display: grid;
      grid-template-columns: 280px 1fr;
    }
    aside {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-right: 1px solid var(--line);
      background: var(--panel);
      padding: 12px;
    }
    .repo-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }
    select,
    textarea {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: transparent;
      color: var(--text);
      font: inherit;
    }
    select {
      min-width: 0;
      height: 38px;
      padding: 0 8px;
    }
    button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
      padding: 0 12px;
      font-weight: 650;
      cursor: pointer;
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.warn { color: var(--warn); }
    button:disabled { opacity: .55; cursor: default; }
    #chatList {
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .chat-item {
      width: 100%;
      height: auto;
      min-height: 58px;
      text-align: left;
      display: grid;
      gap: 3px;
      padding: 8px;
      border-color: var(--line);
    }
    .chat-item.active { border-color: var(--accent); }
    .chat-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .chat-meta {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .main {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .chat-head {
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 16px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 30%);
    }
    #activeTitle { font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #activeMeta { color: var(--muted); font-size: 12px; }
    #messages {
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg {
      max-width: min(980px, 96%);
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px 12px;
      align-self: flex-start;
    }
    .msg.user { align-self: flex-end; border-color: color-mix(in srgb, var(--accent), var(--line) 55%); }
    .msg.codex { border-color: color-mix(in srgb, var(--ok), var(--line) 55%); }
    .msg.system { color: var(--muted); }
    .msg.error { border-color: color-mix(in srgb, var(--warn), var(--line) 45%); color: var(--warn); }
    .meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .body {
      overflow-wrap: anywhere;
      line-height: 1.45;
      font-size: 14px;
    }
    .body p { margin: 0 0 7px; }
    .body p:last-child { margin-bottom: 0; }
    .body ul,
    .body ol { margin: 4px 0 8px 20px; padding: 0; }
    .body blockquote {
      margin: 6px 0;
      padding: 4px 10px;
      border-left: 3px solid var(--line);
      color: var(--muted);
    }
    .body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: var(--code);
      color: var(--code-text);
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 1px 4px;
    }
    .code-block {
      margin: 8px 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--code);
    }
    .code-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 4px 6px 4px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .copy-code {
      height: 24px;
      min-width: 52px;
      padding: 0 8px;
      border-radius: 6px;
      font-size: 12px;
      background: var(--panel);
    }
    pre {
      margin: 0;
      padding: 10px;
      overflow-x: auto;
      color: var(--code-text);
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
    }
    pre code { border: 0; padding: 0; background: transparent; }
    footer {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 10px;
      padding: 12px;
      border-top: 1px solid var(--line);
      background: var(--panel);
      align-items: end;
    }
    textarea {
      width: 100%;
      min-height: 88px;
      max-height: 34vh;
      resize: vertical;
      padding: 10px;
      font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    input[type="file"] { display: none; }
    .attachment-bar {
      grid-column: 1 / -1;
      display: none;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px;
    }
    .attachment-bar.show { display: grid; }
    .attachment-card {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel), var(--code) 20%);
      overflow: hidden;
    }
    .attachment-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--line);
    }
    .attachment-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 650;
    }
    .attachment-remove {
      height: 26px;
      padding: 0 8px;
      border-radius: 6px;
      font-size: 12px;
      flex-shrink: 0;
    }
    .attachment-preview {
      margin: 0;
      max-height: 112px;
      padding: 8px;
      overflow: hidden;
      color: var(--muted);
      white-space: pre-wrap;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .attachment-thumb {
      width: 100%;
      max-height: 132px;
      object-fit: contain;
      display: block;
      background: var(--code);
    }
    .attachment-meta {
      padding: 0 8px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    #notice {
      grid-column: 1 / -1;
      display: none;
      color: var(--warn);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    #notice.show { display: block; }
    @media (max-width: 760px) {
      header h1, .header-actions a { display: none; }
      header { justify-content: flex-end; }
      #codexMode { max-width: none; flex: 1; }
      .shell { grid-template-columns: 1fr; }
      aside { max-height: 210px; border-right: 0; border-bottom: 1px solid var(--line); }
      footer { grid-template-columns: 1fr; }
      button { width: 100%; }
      .msg { max-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Tunnel Chat</h1>
    <div class="header-actions">
      <select id="codexMode" aria-label="Chế độ Codex">
        <option value="/codex">ChatGPT app (Windows)</option>
        <option value="/codex/cli" selected>Codex CLI (WSL)</option>
      </select>
      <a href="/chat/">ChatGPT web</a><a href="/queue">Fix queue</a>
      <span id="status">connecting</span>
    </div>
  </header>
  <div class="shell">
    <aside>
      <div class="repo-row">
        <select id="repoSelect"></select>
        <button id="newChat">New</button>
      </div>
      <div id="chatList"></div>
    </aside>
    <section class="main">
      <div class="chat-head">
        <div>
          <div id="activeTitle">No Codex session</div>
          <div id="activeMeta">Create a session to start.</div>
        </div>
        <div>
          <button id="downloadCodexRepo">Download zip</button>
          <button class="warn" id="cancelRun">Cancel</button>
        </div>
      </div>
      <main id="messages"></main>
      <footer>
        <textarea id="input" placeholder="Send a message to the selected Codex session."></textarea>
        <input id="fileInput" type="file" multiple>
        <button id="fileButton">File</button>
        <button class="primary" id="send">Send</button>
        <button id="refresh">Refresh</button>
        <div id="attachments" class="attachment-bar"></div>
        <div id="notice"></div>
      </footer>
    </section>
  </div>
  <script src="/static/shared.js"></script>
  <script>
    const token = RLCSDTransport.accessToken();
    document.getElementById("codexMode").addEventListener("change", event => location.assign(event.target.value));
    const apiBase = "/c";
    const transportConfig = __TRANSPORT_CONFIG__;
    const uploadChunkBytes = transportConfig.chunkBytes;
    const statusEl = document.getElementById("status");
    const repoSelectEl = document.getElementById("repoSelect");
    const chatListEl = document.getElementById("chatList");
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const fileInputEl = document.getElementById("fileInput");
    const fileButtonEl = document.getElementById("fileButton");
    const attachmentsEl = document.getElementById("attachments");
    const noticeEl = document.getElementById("notice");
    const sendEl = document.getElementById("send");
    const downloadCodexRepoEl = document.getElementById("downloadCodexRepo");
    const cancelEl = document.getElementById("cancelRun");
    const activeTitleEl = document.getElementById("activeTitle");
    const activeMetaEl = document.getElementById("activeMeta");
    let chats = [];
    let activeChatId = Number(localStorage.getItem("codexActiveChatId") || "0");
    let lastMessageKey = "";
    let forceScroll = true;
    let sending = false;
    let pendingAttachments = [];
    let nextAttachmentLocalId = 1;
    const maxAttachmentBytes = 8 * 1024 * 1024;

    const escapeHtml = (s) => String(s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    function showNotice(message) {
      noticeEl.textContent = message;
      noticeEl.className = "show";
    }

    function clearNotice() {
      noticeEl.textContent = "";
      noticeEl.className = "";
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function isTextLikeFile(file) {
      if (file.type && file.type.startsWith("text/")) return true;
      return /\.(txt|log|md|json|jsonl|ya?ml|py|sh|toml|cfg|ini|csv|xml|html|css|js|ts)$/i.test(file.name);
    }

    function isImageFile(file) {
      return (file.type && file.type.startsWith("image/")) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
    }

    async function stageFiles(files) {
      clearNotice();
      const list = Array.from(files || []);
      for (const file of list) {
        if (file.size > maxAttachmentBytes) {
          showNotice(`File too large: ${file.name}. Limit is ${Math.round(maxAttachmentBytes / 1024 / 1024)} MB.`);
          continue;
        }
        const item = {
          localId: nextAttachmentLocalId++,
          file,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          preview: "",
          imageUrl: "",
        };
        if (isImageFile(file)) {
          item.imageUrl = URL.createObjectURL(file);
        } else if (isTextLikeFile(file)) {
          item.preview = (await file.text()).slice(0, 1200);
        }
        pendingAttachments.push(item);
      }
      renderAttachments();
    }

    function clearPendingAttachments() {
      for (const item of pendingAttachments) {
        if (item.imageUrl) URL.revokeObjectURL(item.imageUrl);
      }
      pendingAttachments = [];
      renderAttachments();
    }

    function renderAttachments() {
      if (!pendingAttachments.length) {
        attachmentsEl.classList.remove("show");
        attachmentsEl.innerHTML = "";
        return;
      }
      attachmentsEl.classList.add("show");
      attachmentsEl.innerHTML = pendingAttachments.map(item => {
        const preview = item.imageUrl
          ? `<img class="attachment-thumb" src="${item.imageUrl}" alt="">`
          : `<pre class="attachment-preview">${escapeHtml(item.preview || "(binary file)")}</pre>`;
        return `
          <div class="attachment-card" data-local-id="${item.localId}">
            <div class="attachment-head">
              <div class="attachment-name">${escapeHtml(item.name)}</div>
              <button class="attachment-remove" type="button">Remove</button>
            </div>
            ${preview}
            <div class="attachment-meta">${escapeHtml(item.type || "application/octet-stream")} · ${formatBytes(item.size)}</div>
          </div>
        `;
      }).join("");
    }

    const api = RLCSDTransport.createRpc({
      apiBase,
      token,
      retryLimit: transportConfig.retryLimit,
    });

    function renderInline(text) {
      const codeSpans = [];
      let escaped = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
        const token = `\u0000CODE${codeSpans.length}\u0000`;
        codeSpans.push(`<code>${code}</code>`);
        return token;
      });
      escaped = escaped
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      return escaped.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)]);
    }

    function renderTextBlock(text) {
      return String(text || "").replace(/\r\n/g, "\n").split("\n\n").map(block => {
        const trimmed = block.trim();
        if (!trimmed) return "";
        if (/^\s*[-*]\s+/m.test(trimmed)) {
          const items = trimmed.split("\n").map(line => line.replace(/^\s*[-*]\s+/, "")).filter(Boolean);
          return `<ul>${items.map(item => `<li>${renderInline(item)}</li>`).join("")}</ul>`;
        }
        if (/^\s*>\s?/m.test(trimmed)) {
          return `<blockquote>${renderInline(trimmed.replace(/^\s*>\s?/gm, ""))}</blockquote>`;
        }
        return `<p>${renderInline(trimmed).replace(/\n/g, "<br>")}</p>`;
      }).join("");
    }

    function renderMarkdown(source) {
      const text = String(source || "");
      const fence = /```([A-Za-z0-9_-]*)?\n?([\s\S]*?)```/g;
      let html = "";
      let lastIndex = 0;
      let match;
      while ((match = fence.exec(text)) !== null) {
        html += renderTextBlock(text.slice(lastIndex, match.index));
        const lang = match[1] ? escapeHtml(match[1]) : "code";
        html += `<div class="code-block"><div class="code-toolbar"><span>${lang}</span><button class="copy-code" type="button">Copy</button></div><pre><code>${escapeHtml(match[2].replace(/\n$/, ""))}</code></pre></div>`;
        lastIndex = fence.lastIndex;
      }
      html += renderTextBlock(text.slice(lastIndex));
      return html || "<p></p>";
    }

    function messageKey(messages) {
      const last = messages[messages.length - 1];
      return `${messages.length}:${last ? `${last.id}:${last.created_at}` : "empty"}`;
    }

    function isNearBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
    }

    function renderChats() {
      chatListEl.innerHTML = chats.map(chat => `
        <button class="chat-item ${Number(chat.id) === Number(activeChatId) ? "active" : ""}" data-chat-id="${chat.id}">
          <span class="chat-title">${escapeHtml(chat.title)}</span>
          <span class="chat-meta">${escapeHtml(chat.status)} · ${escapeHtml(chat.repo_path)}</span>
        </button>
      `).join("");
      const active = chats.find(chat => Number(chat.id) === Number(activeChatId));
      activeTitleEl.textContent = active ? active.title : "No Codex session";
      activeMetaEl.textContent = active
        ? `${active.status}${active.activity ? ` · ${active.activity}` : ""} · ${active.repo_path}${active.codex_session_id ? ` · ${active.codex_session_id}` : ""}`
        : "Create a session to start.";
      cancelEl.disabled = !active || active.status !== "running";
      downloadCodexRepoEl.disabled = !active && !repoSelectEl.value;
    }

    function renderMessages(messages) {
      const wasNearBottom = isNearBottom();
      messagesEl.innerHTML = messages.map(m => `
        <article class="msg ${escapeHtml(m.author)} ${escapeHtml(m.kind)}">
          <div class="meta">
            <strong>${escapeHtml(m.author)}</strong>
            <span>${escapeHtml(m.created_at || "")}</span>
          </div>
          <div class="body">${renderMarkdown(m.body || "")}</div>
        </article>
      `).join("");
      if (forceScroll || wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
      forceScroll = false;
    }

    async function loadState() {
      const data = await api("state");
      repoSelectEl.innerHTML = data.repos.map(repo => `<option value="${escapeHtml(repo.path)}">${escapeHtml(repo.name)} · ${escapeHtml(repo.path)}</option>`).join("");
      chats = data.chats || [];
      if (!activeChatId && chats.length) activeChatId = Number(chats[0].id);
      if (activeChatId && !chats.some(chat => Number(chat.id) === Number(activeChatId))) {
        activeChatId = chats.length ? Number(chats[0].id) : 0;
      }
      localStorage.setItem("codexActiveChatId", String(activeChatId || ""));
      renderChats();
      statusEl.textContent = "online";
    }

    async function loadMessages() {
      if (!activeChatId) {
        renderMessages([]);
        return;
      }
      const data = await api("messages", {chat_id: activeChatId});
      const key = messageKey(data.messages || []);
      if (key !== lastMessageKey) {
        lastMessageKey = key;
        renderMessages(data.messages || []);
      }
      if (data.chat) {
        const idx = chats.findIndex(chat => Number(chat.id) === Number(data.chat.id));
        if (idx >= 0) chats[idx] = data.chat;
        renderChats();
      }
    }

    async function refreshAll() {
      try {
        await loadState();
        await loadMessages();
      } catch (err) {
        statusEl.textContent = "offline/auth";
      }
    }

    async function createChat() {
      clearNotice();
      const repoPath = repoSelectEl.value;
      const result = await api("create", {repo_path: repoPath});
      activeChatId = Number(result.chat.id);
      localStorage.setItem("codexActiveChatId", String(activeChatId));
      lastMessageKey = "";
      forceScroll = true;
      await refreshAll();
    }

    async function uploadAttachment(item) {
      const result = await RLCSDTransport.uploadBlob({
        rpc: api,
        paths: {
          start: "attachment/start",
          chunk: "attachment/chunk",
          status: "attachment/status",
          finish: "attachment/finish",
        },
        blob: item.file,
        chunkBytes: uploadChunkBytes,
        concurrency: transportConfig.concurrency,
        retryLimit: transportConfig.retryLimit,
        startPayload: {
          chat_id: activeChatId,
          filename: item.name,
          mime_type: item.type || "application/octet-stream",
        },
        onProgress: (completed, total) => {
          statusEl.textContent = `uploading ${item.name} ${completed}/${total}`;
        },
      });
      return result.attachment.id;
    }

    async function uploadPendingAttachments() {
      const ids = [];
      for (const item of pendingAttachments) {
        ids.push(await uploadAttachment(item));
      }
      return ids;
    }

    async function sendPromptText(text, attachmentIds = []) {
      const blob = new Blob([String(text || "")], {type: "text/plain;charset=utf-8"});
      await RLCSDTransport.uploadBlob({
        rpc: api,
        paths: {
          start: "prompt/start",
          chunk: "prompt/chunk",
          status: "prompt/status",
          finish: "prompt/finish",
        },
        blob,
        chunkBytes: uploadChunkBytes,
        concurrency: transportConfig.concurrency,
        retryLimit: transportConfig.retryLimit,
        startPayload: {chat_id: activeChatId, attachment_ids: attachmentIds},
        onProgress: (completed, total) => {
          statusEl.textContent = `uploading prompt ${completed}/${total}`;
        },
      });
    }

    async function sendMessage() {
      if (sending) return;
      clearNotice();
      let text = inputEl.value.trim();
      if (!text && !pendingAttachments.length) return;
      try {
        sending = true;
        sendEl.disabled = true;
        sendEl.textContent = "Sending...";
        if (!activeChatId) await createChat();
        const attachmentIds = await uploadPendingAttachments();
        await sendPromptText(text, attachmentIds);
        inputEl.value = "";
        clearPendingAttachments();
        lastMessageKey = "";
        forceScroll = true;
        await refreshAll();
      } catch (err) {
        showNotice(err.message || String(err));
      } finally {
        sending = false;
        sendEl.disabled = false;
        sendEl.textContent = "Send";
      }
    }

    chatListEl.addEventListener("click", ev => {
      const button = ev.target.closest(".chat-item");
      if (!button) return;
      activeChatId = Number(button.dataset.chatId);
      localStorage.setItem("codexActiveChatId", String(activeChatId));
      lastMessageKey = "";
      forceScroll = true;
      refreshAll();
    });

    messagesEl.addEventListener("click", async ev => {
      const button = ev.target.closest(".copy-code");
      if (!button) return;
      const code = button.closest(".code-block")?.querySelector("pre code");
      if (!code) return;
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(code.textContent || "");
        button.textContent = "Copied";
      } catch (err) {
        button.textContent = "Failed";
      }
      setTimeout(() => { button.textContent = original; }, 1200);
    });

    attachmentsEl.addEventListener("click", ev => {
      const button = ev.target.closest(".attachment-remove");
      if (!button) return;
      const card = button.closest(".attachment-card");
      const localId = Number(card?.dataset.localId || "0");
      const item = pendingAttachments.find(entry => Number(entry.localId) === localId);
      if (item?.imageUrl) URL.revokeObjectURL(item.imageUrl);
      pendingAttachments = pendingAttachments.filter(entry => Number(entry.localId) !== localId);
      renderAttachments();
    });

    document.getElementById("newChat").onclick = () => createChat().catch(err => showNotice(err.message || String(err)));
    document.getElementById("refresh").onclick = () => refreshAll();
    downloadCodexRepoEl.onclick = () => {
      const active = chats.find(chat => Number(chat.id) === Number(activeChatId));
      const query = new URLSearchParams();
      if (active) query.set("chat_id", String(active.id));
      else query.set("repo", repoSelectEl.value);
      RLCSDTransport.download(`/download/repo?${query.toString()}`, token).catch(error => showNotice(error.message));
    };
    fileButtonEl.onclick = () => fileInputEl.click();
    fileInputEl.onchange = async () => {
      await stageFiles(fileInputEl.files);
      fileInputEl.value = "";
    };
    sendEl.onclick = () => sendMessage();
    cancelEl.onclick = async () => {
      if (!activeChatId) return;
      await api("cancel", {chat_id: activeChatId});
      await refreshAll();
    };
    inputEl.addEventListener("keydown", ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") sendMessage();
    });
    refreshAll();
    const stopLiveUpdates = RLCSDTransport.startLiveUpdates({
      token,
      poll: refreshAll,
      onUpdate: refreshAll,
      onState: state => {
        if (state === "live" && !sending) statusEl.textContent = "online · live";
      },
    });
    window.addEventListener("beforeunload", stopLiveUpdates);
  </script>
</body>
</html>
""".replace("__TRANSPORT_CONFIG__", client_transport_config())


class ChatHandler(BaseHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("referrer-policy", "no-referrer")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("x-frame-options", "DENY")
        super().end_headers()

    server_version = "RLCSDChat/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        message = redact_secrets(fmt % args)
        message = re.sub(r"token=[^\s&\"]+", "token=[redacted]", message)
        message = re.sub(r"p=[^\s&\"]+", "p=[redacted]", message)
        sys.stderr.write("%s - %s\n" % (self.address_string(), message))

    def auth_ok(self) -> bool:
        expected = self.server.chat_token  # type: ignore[attr-defined]
        if not expected:
            return False
        supplied = self.headers.get("x-chat-token", "")
        return secrets.compare_digest(str(supplied), str(expected))

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, text: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path, filename: str, content_type: str = "application/zip",
                  disposition: str = "attachment") -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(path.stat().st_size))
        self.send_header("content-disposition", f'{disposition}; filename="{filename}"')
        self.send_header("cache-control", "no-store")
        self.end_headers()
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def send_event_stream(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache, no-transform")
        self.send_header("connection", "keep-alive")
        self.send_header("x-accel-buffering", "no")
        self.end_headers()
        self.wfile.write(b":" + (b" " * 4096) + b"\nretry: 2500\n\n")
        self.wfile.flush()
        last_seen = -1
        try:
            while True:
                with EVENT_CONDITION:
                    if last_seen == EVENT_REVISION:
                        EVENT_CONDITION.wait(timeout=15)
                    revision = EVENT_REVISION
                if revision != last_seen:
                    data = f'data: {{"revision":{revision}}}\n\n'.encode("utf-8")
                    last_seen = revision
                else:
                    data = b": heartbeat\n\n"
                self.wfile.write(data)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        raw_path = parsed.path
        path = normalize_api_path(raw_path)
        if path in {"/static/shared.js", "/static/desktop.js", "/static/rich-text.js", "/static/desktop.css"}:
            static_path = BASE_DIR / "static" / Path(path).name
            data = static_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", "text/css; charset=utf-8" if path.endswith(".css") else "text/javascript; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if raw_path.startswith("/static/vendor/"):
            static_root = (BASE_DIR / "static" / "vendor").resolve()
            static_path = (static_root / raw_path.removeprefix("/static/vendor/")).resolve()
            if not static_path.is_relative_to(static_root) or not static_path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = static_path.read_bytes()
            content_type = mimetypes.guess_type(static_path.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", content_type)
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if raw_path.startswith("/d/"):
            if not self.auth_ok():
                self.send_json({"error": "unauthorized"}, HTTPStatus.UNAUTHORIZED)
                return
            try:
                if raw_path == "/d/image":
                    query = parse_qs(parsed.query)
                    image = desktop.image_file(sys.modules[__name__],
                        int(query.get("chat_id", ["0"])[0]), query.get("image_id", [""])[0])
                    self.send_file(image["path"], image["filename"], image["mime_type"], "inline")
                    return
                result = desktop.dispatch(sys.modules[__name__], raw_path[3:],
                                          decode_get_payload(parse_qs(parsed.query)))
                self.send_json(result)
            except Exception as exc:
                self.send_json({"error": redact_secrets(str(exc))}, HTTPStatus.BAD_REQUEST)
            return
        if path in {"/", "/desktop", "/desktop/", "/codex/", "/chat"}:
            target = "/chat/#" if path in {"/", "/chat"} else "/codex"
            self.send_response(HTTPStatus.FOUND)
            self.send_header("location", target)
            self.send_header("content-length", "0")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            return
        if path == "/codex":
            data = (BASE_DIR / "static" / "desktop.html").read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/queue":
            data = html_page().encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/download/repo":
            if not self.auth_ok():
                self.send_text("unauthorized", HTTPStatus.UNAUTHORIZED)
                return
            query = parse_qs(parsed.query)
            repo_path = ""
            chat_id_raw = query.get("chat_id", [""])[0]
            if chat_id_raw:
                chat = get_codex_chat(int(chat_id_raw))
                if chat is None:
                    self.send_text(f"unknown codex chat #{chat_id_raw}", HTTPStatus.NOT_FOUND)
                    return
                repo_path = str(chat["repo_path"])
            elif query.get("repo", [""])[0]:
                repo_path = query.get("repo", [""])[0]
            else:
                repos = allowed_codex_repos()
                repo_path = repos[0]["path"] if repos else ""
            try:
                zip_path, filename = create_repo_zip(repo_path)
                try:
                    self.send_file(zip_path, filename)
                finally:
                    try:
                        zip_path.unlink()
                    except OSError:
                        pass
            except Exception as exc:
                self.send_text(f"zip failed: {exc}", HTTPStatus.BAD_REQUEST)
            return
        if path == "/events":
            if not self.auth_ok():
                self.send_text("unauthorized", HTTPStatus.UNAUTHORIZED)
                return
            self.send_event_stream()
            return
        if path == "/codex/cli":
            data = codex_page().encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if raw_path.startswith(CODEX_RPC_PREFIX + "/"):
            if not self.auth_ok():
                self.send_text("unauthorized", HTTPStatus.UNAUTHORIZED)
                return
            try:
                payload = decode_get_payload(parse_qs(parsed.query))
                codex_path = raw_path[len(CODEX_RPC_PREFIX) :]
                if codex_path == "/state":
                    chats = list_codex_chats()
                    self.send_json(
                        {
                            "repos": allowed_codex_repos(),
                            "chats": chats,
                            "default_repo": allowed_codex_repos()[0]["path"] if allowed_codex_repos() else "",
                        }
                    )
                    return
                if codex_path == "/create":
                    chat_id = create_codex_chat(str(payload.get("repo_path") or ""))
                    chat = get_codex_chat(chat_id)
                    self.send_json({"ok": True, "chat": dict(chat) if chat else None})
                    return
                if codex_path == "/messages":
                    chat_id = int(payload.get("chat_id") or 0)
                    chat = get_codex_chat(chat_id)
                    if chat is None:
                        self.send_json({"error": f"unknown codex chat #{chat_id}"}, HTTPStatus.NOT_FOUND)
                        return
                    self.send_json({"chat": dict(chat), "messages": list_codex_messages(chat_id)})
                    return
                if codex_path == "/send":
                    chat_id = int(payload.get("chat_id") or 0)
                    start_codex_turn(chat_id, str(payload.get("body") or ""), parse_id_list(payload.get("attachment_ids")))
                    self.send_json({"ok": True})
                    return
                if codex_path == "/prompt/start":
                    upload_id = create_codex_prompt_upload(
                        int(payload.get("chat_id") or 0),
                        int(payload.get("size") or 0),
                        int(payload.get("total_chunks") or 0),
                        parse_id_list(payload.get("attachment_ids")),
                        str(payload.get("body_encoding") or "base64url"),
                    )
                    self.send_json({"ok": True, "upload_id": upload_id})
                    return
                if codex_path == "/prompt/chunk":
                    add_codex_prompt_chunk(
                        int(payload.get("upload_id") or 0),
                        int(payload.get("chunk_index") or 0),
                        str(payload.get("body") or ""),
                    )
                    self.send_json({"ok": True})
                    return
                if codex_path == "/prompt/finish":
                    chat_id, length = finish_codex_prompt_upload(int(payload.get("upload_id") or 0))
                    self.send_json({"ok": True, "chat_id": chat_id, "length": length})
                    return
                if codex_path == "/prompt/status":
                    self.send_json(get_upload_status("prompt", int(payload.get("upload_id") or 0)))
                    return
                if codex_path == "/attachment/start":
                    upload_id = create_codex_attachment_upload(
                        int(payload.get("chat_id") or 0),
                        str(payload.get("filename") or "attachment"),
                        str(payload.get("mime_type") or "application/octet-stream"),
                        int(payload.get("size") or 0),
                        int(payload.get("total_chunks") or 0),
                    )
                    self.send_json({"ok": True, "upload_id": upload_id})
                    return
                if codex_path == "/attachment/chunk":
                    add_codex_attachment_chunk(
                        int(payload.get("upload_id") or 0),
                        int(payload.get("chunk_index") or 0),
                        str(payload.get("body") or ""),
                    )
                    self.send_json({"ok": True})
                    return
                if codex_path == "/attachment/finish":
                    attachment = finish_codex_attachment_upload(int(payload.get("upload_id") or 0))
                    self.send_json({"ok": True, "attachment": attachment})
                    return
                if codex_path == "/attachment/status":
                    self.send_json(get_upload_status("attachment", int(payload.get("upload_id") or 0)))
                    return
                if codex_path == "/cancel":
                    stopped = cancel_codex_turn(int(payload.get("chat_id") or 0))
                    self.send_json({"ok": True, "stopped": stopped})
                    return
            except Exception as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self.send_text("not found", HTTPStatus.NOT_FOUND)
            return
        if raw_path.startswith(GET_RPC_PREFIX + "/"):
            if not self.auth_ok():
                self.send_text("unauthorized", HTTPStatus.UNAUTHORIZED)
                return
            rpc_path = API_COMPAT_PREFIX + raw_path[len(GET_RPC_PREFIX) :]
            try:
                payload = decode_get_payload(parse_qs(parsed.query))
                if rpc_path in {"/api/messages", "/api/list"}:
                    self.send_json({"messages": list_messages()})
                    return
                if rpc_path in {"/api/messages/send", "/api/send"}:
                    body = str(payload.get("body", ""))
                    message_id = add_message("client", body)
                    request_id = None
                    create_fix = bool(payload.get("create_fix")) or body.strip().lower() in {"fix", "/fix"}
                    if create_fix:
                        request_id = create_fix_request(None if body.strip().lower() in {"fix", "/fix"} else message_id)
                    self.send_json({"ok": True, "message_id": message_id, "request_id": request_id})
                    return
                if rpc_path in {"/api/uploads/start", "/api/start"}:
                    upload_id = create_upload_session(
                        str(payload.get("filename") or "error.txt"),
                        int(payload.get("size") or 0),
                        int(payload.get("total_chunks") or 0),
                        bool(payload.get("create_fix")),
                        str(payload.get("body_encoding") or "text"),
                    )
                    self.send_json({"ok": True, "upload_id": upload_id})
                    return
                if rpc_path in {"/api/uploads/chunk", "/api/chunk"}:
                    add_upload_chunk(
                        int(payload.get("upload_id")),
                        int(payload.get("chunk_index")),
                        str(payload.get("body") or ""),
                    )
                    self.send_json({"ok": True})
                    return
                if rpc_path in {"/api/uploads/finish", "/api/finish"}:
                    message_id, request_id = finish_upload(int(payload.get("upload_id")))
                    self.send_json({"ok": True, "message_id": message_id, "request_id": request_id})
                    return
                if rpc_path in {"/api/uploads/status", "/api/status"}:
                    self.send_json(get_upload_status("queue", int(payload.get("upload_id") or 0)))
                    return
            except Exception as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self.send_text("not found", HTTPStatus.NOT_FOUND)
            return
        if path == "/api/messages":
            if not self.auth_ok():
                self.send_text("unauthorized", HTTPStatus.UNAUTHORIZED)
                return
            self.send_json({"messages": list_messages()})
            return
        self.send_text("not found", HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = normalize_api_path(urlparse(self.path).path)
        if not self.auth_ok():
            self.send_text("unauthorized", HTTPStatus.UNAUTHORIZED)
            return
        length = int(self.headers.get("content-length", "0"))
        if length > MAX_BODY_BYTES:
            self.send_text("payload too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if path == "/api/uploads/start":
            upload_id = create_upload_session(
                str(payload.get("filename") or "error.txt"),
                int(payload.get("size") or 0),
                int(payload.get("total_chunks") or 0),
                bool(payload.get("create_fix")),
                str(payload.get("body_encoding") or "text"),
            )
            self.send_json({"ok": True, "upload_id": upload_id})
            return
        if path == "/api/uploads/chunk":
            add_upload_chunk(
                int(payload.get("upload_id")),
                int(payload.get("chunk_index")),
                str(payload.get("body") or ""),
            )
            self.send_json({"ok": True})
            return
        if path == "/api/uploads/finish":
            message_id, request_id = finish_upload(int(payload.get("upload_id")))
            self.send_json({"ok": True, "message_id": message_id, "request_id": request_id})
            return
        if path != "/api/messages":
            self.send_text("not found", HTTPStatus.NOT_FOUND)
            return
        author = str(payload.get("author") or "client").strip()[:40]
        body = str(payload.get("body") or "")
        create_fix = bool(payload.get("create_fix"))
        body_is_fix = body.strip().lower() in {"fix", "/fix"}
        if body_is_fix:
            create_fix = True
            body = ""
        if not body.strip() and not create_fix:
            self.send_text("empty body", HTTPStatus.BAD_REQUEST)
            return
        message_id = None
        if body.strip():
            message_id = add_message(author, body)
        request_id = None
        if create_fix:
            request_id = create_fix_request(message_id)
        self.send_json({"ok": True, "message_id": message_id, "request_id": request_id})


def serve() -> None:
    ensure_env()
    init_db()
    config = load_config()
    port = int(config["port"])
    server = ThreadingHTTPServer((config["host"], port), ChatHandler)
    server.daemon_threads = True
    server.chat_token = config["chat_access_token"]  # type: ignore[attr-defined]
    if not server.chat_token:  # type: ignore[attr-defined]
        raise RuntimeError("CHAT_ACCESS_TOKEN is missing")
    cleanup_expired_uploads()
    reconcile_codex_runs()
    threading.Thread(target=upload_cleanup_loop, name="upload-cleanup", daemon=True).start()
    print(f"serving http://{config['host']}:{port}", flush=True)
    server.serve_forever()


def init_db() -> None:
    with connect():
        pass


def cmd_init_env(_: argparse.Namespace) -> None:
    ensure_env()
    init_db()
    print(f"initialized {BASE_DIR}")


def cmd_next(_: argparse.Namespace) -> None:
    rows = list_open_requests()
    if not rows:
        print("No open fix requests.")
        return
    row = rows[0]
    print(f"Fix request #{row['id']} created_at={row['created_at']} source_message_id={row['source_message_id']}")
    print()
    print(row["log_text"])


def cmd_show(args: argparse.Namespace) -> None:
    row = get_request(args.request_id)
    if row is None:
        raise SystemExit(f"unknown request #{args.request_id}")
    print(f"Fix request #{row['id']} status={row['status']} created_at={row['created_at']}")
    print()
    print(row["log_text"])


def cmd_reply(args: argparse.Namespace) -> None:
    body = sys.stdin.read() if args.stdin else " ".join(args.text)
    reply_request(args.request_id, body)
    print(f"replied to #{args.request_id}")


def cmd_send(args: argparse.Namespace) -> None:
    body = sys.stdin.read() if args.stdin else " ".join(args.text)
    add_message("codex", body, "command")
    print("sent")


def cmd_user(args: argparse.Namespace) -> None:
    body = sys.stdin.read() if args.stdin else " ".join(args.text)
    add_message("user", body, "message")
    print("sent")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="RLCSD fix chat bridge")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("serve").set_defaults(func=lambda _: serve())
    sub.add_parser("init-env").set_defaults(func=cmd_init_env)
    sub.add_parser("next").set_defaults(func=cmd_next)
    show = sub.add_parser("show")
    show.add_argument("request_id", type=int)
    show.set_defaults(func=cmd_show)
    reply = sub.add_parser("reply")
    reply.add_argument("request_id", type=int)
    reply.add_argument("text", nargs="*")
    reply.add_argument("--stdin", action="store_true")
    reply.set_defaults(func=cmd_reply)
    send = sub.add_parser("send")
    send.add_argument("text", nargs="*")
    send.add_argument("--stdin", action="store_true")
    send.set_defaults(func=cmd_send)
    user = sub.add_parser("user")
    user.add_argument("text", nargs="*")
    user.add_argument("--stdin", action="store_true")
    user.set_defaults(func=cmd_user)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        serve()
        return
    args.func(args)


if __name__ == "__main__":
    main()
