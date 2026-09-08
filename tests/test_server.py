from __future__ import annotations

import base64
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import server


def encode_chunk(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


class ServerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        root = Path(self.temp_dir.name)
        self.old_paths = (server.DATA_DIR, server.DB_PATH, server.CODEX_ATTACHMENTS_DIR)
        server.DATA_DIR = root / "data"
        server.DB_PATH = server.DATA_DIR / "chat.sqlite3"
        server.CODEX_ATTACHMENTS_DIR = server.DATA_DIR / "codex_attachments"
        server.init_db()

    def tearDown(self) -> None:
        server.DATA_DIR, server.DB_PATH, server.CODEX_ATTACHMENTS_DIR = self.old_paths

    def create_chat(self, status: str = "idle", process_group: int | None = None) -> int:
        with server.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO codex_chats(
                    created_at, updated_at, title, repo_path, status, process_group
                ) VALUES (?, ?, 'test', ?, ?, ?)
                """,
                (server.now_iso(), server.now_iso(), self.temp_dir.name, status, process_group),
            )
            conn.commit()
            return int(cursor.lastrowid)

    def test_generated_env_is_portable_and_uses_quick_tunnel(self) -> None:
        env_path = Path(self.temp_dir.name) / ".env.local"
        with mock.patch.object(server, "ENV_PATH", env_path):
            server.ensure_env()
            values = server.parse_env_file(env_path)

        self.assertEqual(values["TUNNEL_MODE"], "quick")
        self.assertEqual(values["SECRETS_ENV"], "")
        self.assertEqual(values["CODEX_REPOS"], str(server.BASE_DIR))
        self.assertEqual(values["CODEX_HOME"], str(Path.home() / ".codex"))
        self.assertTrue(values["CHAT_ACCESS_TOKEN"])
        self.assertNotIn("2025.2-IT3180E-SE", env_path.read_text(encoding="utf-8"))
        self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)

    def test_default_upload_chunk_is_safe_for_restrictive_get_proxies(self) -> None:
        with mock.patch.object(server, "ENV_PATH", Path(self.temp_dir.name) / "missing.env"), \
             mock.patch.dict(server.os.environ, {}, clear=True):
            self.assertEqual(server.upload_chunk_bytes(), 2048)

    def test_queue_upload_reports_missing_chunks_and_finishes(self) -> None:
        chunk_size = server.upload_chunk_bytes()
        data = (b"traceback line\n" * 700)[: chunk_size + 321]
        total_chunks = server.expected_upload_chunks(len(data))
        upload_id = server.create_upload_session(
            "error.txt",
            len(data),
            total_chunks,
            create_fix=False,
            body_encoding="base64url",
        )

        server.add_upload_chunk(upload_id, 0, encode_chunk(data[:chunk_size]))
        status = server.get_upload_status("queue", upload_id)
        self.assertEqual(status["received"], [0])
        self.assertEqual(status["missing"], [1])

        server.add_upload_chunk(upload_id, 1, encode_chunk(data[chunk_size:]))
        message_id, request_id = server.finish_upload(upload_id)
        self.assertGreater(message_id, 0)
        self.assertIsNone(request_id)
        with self.assertRaisesRegex(ValueError, "unknown queue upload"):
            server.get_upload_status("queue", upload_id)

    def test_queue_upload_rejects_bad_shape_and_chunk_size(self) -> None:
        chunk_size = server.upload_chunk_bytes()
        with self.assertRaisesRegex(ValueError, "total_chunks mismatch"):
            server.create_upload_session("bad.txt", chunk_size + 1, 1, False, "base64url")
        upload_id = server.create_upload_session("bad.txt", chunk_size, 1, False, "base64url")
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            server.add_upload_chunk(upload_id, 0, encode_chunk(b"short"))

    def test_prompt_upload_uses_utf8_bytes_and_starts_one_turn(self) -> None:
        chat_id = self.create_chat()
        prompt = "Loi CUDA tieng Viet\n" * 500
        data = prompt.encode("utf-8")
        chunk_size = server.upload_chunk_bytes()
        total_chunks = server.expected_upload_chunks(len(data))
        upload_id = server.create_codex_prompt_upload(chat_id, len(data), total_chunks, [])
        for index in range(total_chunks):
            chunk = data[index * chunk_size : (index + 1) * chunk_size]
            server.add_codex_prompt_chunk(upload_id, index, encode_chunk(chunk))

        with mock.patch.object(server, "start_codex_turn") as start_turn:
            result_chat_id, prompt_length = server.finish_codex_prompt_upload(upload_id)

        self.assertEqual(result_chat_id, chat_id)
        self.assertEqual(prompt_length, len(prompt))
        start_turn.assert_called_once_with(chat_id, prompt, [])

    def test_cleanup_removes_expired_sessions_and_chunks(self) -> None:
        upload_id = server.create_upload_session("old.txt", 0, 1, False, "base64url")
        server.add_upload_chunk(upload_id, 0, "")
        old = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
        with server.connect() as conn:
            conn.execute("UPDATE upload_sessions SET created_at = ? WHERE id = ?", (old, upload_id))
            conn.commit()

        removed = server.cleanup_expired_uploads(ttl_seconds=60)
        self.assertEqual(removed["queue"], 1)
        with self.assertRaisesRegex(ValueError, "unknown queue upload"):
            server.get_upload_status("queue", upload_id)

    def test_codex_claim_is_atomic(self) -> None:
        chat_id = self.create_chat()
        server.claim_codex_chat(chat_id, "first")
        with self.assertRaisesRegex(ValueError, "already running"):
            server.claim_codex_chat(chat_id, "second")
        chat = server.get_codex_chat(chat_id)
        self.assertEqual(chat["status"], "running")

    def test_reconcile_marks_interrupted_runner_as_error(self) -> None:
        chat_id = self.create_chat(status="running")
        self.assertEqual(server.reconcile_codex_runs(), 1)
        chat = server.get_codex_chat(chat_id)
        self.assertEqual(chat["status"], "error")
        self.assertIn("server restart", chat["last_error"])

    def test_extracts_codex_thread_id_without_repo_fallback(self) -> None:
        thread_id = "019f091f-1868-7033-8d95-fb048f9ee043"
        self.assertEqual(server.extract_session_id({"type": "thread.started", "thread_id": thread_id}), thread_id)


if __name__ == "__main__":
    unittest.main()
