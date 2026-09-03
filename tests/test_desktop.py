from __future__ import annotations
import base64
import http.client
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import uuid
import zipfile
import desktop
import server


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patchers = [
            mock.patch.object(server,"DATA_DIR",self.root/"data"),
            mock.patch.object(server,"DB_PATH",self.root/"data"/"chat.sqlite3"),
            mock.patch.object(server,"CODEX_ATTACHMENTS_DIR",self.root/"data"/"codex_attachments"),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        server.init_db()

    def chat(self, backend="desktop", status="idle"):
        with server.connect() as conn:
            cursor=conn.execute("""INSERT INTO codex_chats
                (created_at,updated_at,title,repo_path,codex_session_id,status,backend)
                VALUES (?,?,?,?,?,?,?)""",
                (server.now_iso(),server.now_iso(),"test",r"D:\work",str(uuid.uuid4()),status,backend))
            conn.commit()
            return cursor.lastrowid

    def test_legacy_schema_migrates_without_changing_history(self):
        conn=sqlite3.connect(":memory:")
        conn.execute("""CREATE TABLE codex_chats (id INTEGER PRIMARY KEY,
                     codex_session_id TEXT,title TEXT)""")
        conn.execute("INSERT INTO codex_chats VALUES (1,'old-session','old chat')")
        desktop.init_schema(conn)
        desktop.init_schema(conn)
        self.assertEqual(conn.execute("SELECT codex_session_id,backend,host_id FROM codex_chats").fetchone(),
                         ("old-session","cli-wsl","local"))
        conn.close()

    def test_desktop_never_runs_legacy_cli_or_process_cleanup(self):
        chat=self.chat(status="running")
        with mock.patch.object(server,"get_codex_bin") as binary, mock.patch.object(server,"terminate_process_group") as kill:
            with self.assertRaisesRegex(ValueError,"Desktop page"):
                server.start_codex_turn(chat,"hello")
            with self.assertRaisesRegex(ValueError,"Desktop page"):
                server.cancel_codex_turn(chat)
            self.assertEqual(server.reconcile_codex_runs(),0)
            binary.assert_not_called();kill.assert_not_called()
        self.assertEqual(server.list_codex_chats(),[])

    def test_link_is_idempotent_and_preserves_native_path(self):
        task=str(uuid.uuid4())
        snapshot={"title":"native","cwd":r"D:\dev\work","status":"idle"}
        with mock.patch.object(desktop.BRIDGE,"call",return_value=snapshot):
            first=desktop.link(server,"codex://threads/"+task)
            second=desktop.link(server,task)
        self.assertEqual(first["chat_id"],second["chat_id"])
        self.assertEqual(server.get_codex_chat(first["chat_id"])["repo_path"],r"D:\dev\work")

    def test_mutation_deduplicates_and_rejects_reused_id(self):
        chat=self.chat();operation=str(uuid.uuid4())
        data={"operation_id":operation,"expectedTurnId":"turn"}
        with mock.patch.object(desktop.BRIDGE,"call",return_value={"ok":True}) as call:
            self.assertEqual(desktop.mutate(server,chat,"cancel",data),{"ok":True})
            self.assertEqual(desktop.mutate(server,chat,"cancel",data),{"ok":True})
            call.assert_called_once()
            with self.assertRaisesRegex(ValueError,"another action"):
                desktop.mutate(server,chat,"cancel",{**data,"expectedTurnId":"other"})

    def test_uncertain_mutation_is_not_replayed(self):
        chat=self.chat();data={"operation_id":str(uuid.uuid4()),"expectedTurnId":"turn"}
        with mock.patch.object(desktop.BRIDGE,"call",side_effect=ValueError("timeout")) as call:
            with self.assertRaisesRegex(ValueError,"timeout"):desktop.mutate(server,chat,"cancel",data)
            with self.assertRaisesRegex(ValueError,"uncertain"):desktop.mutate(server,chat,"cancel",data)
            call.assert_called_once()

    def test_attachment_ownership_checked_before_staging(self):
        chat=self.chat()
        with mock.patch.object(desktop.BRIDGE,"call") as call:
            with self.assertRaisesRegex(ValueError,"does not belong"):
                desktop.stage_attachments(server,chat,[999])
            call.assert_not_called()

    def test_native_path_and_linux_node_are_not_silently_mixed(self):
        with self.assertRaisesRegex(ValueError,"task ID"):
            desktop.thread_id("../../config")
        with tempfile.NamedTemporaryFile() as binary:
            with self.assertRaisesRegex(ValueError,"Windows node"):
                desktop.bridge_command({"desktop_node":binary.name})

    def test_zip_denies_tracked_secrets_ignored_files_and_symlinks(self):
        repo=self.root/"repo";repo.mkdir()
        subprocess.run(["git","init","-q",str(repo)],check=True)
        (repo/"ok.txt").write_text("export")
        (repo/".gitignore").write_text("ignored.txt\n")
        (repo/"ignored.txt").write_text("private")
        (repo/".env.local").write_text("secret")
        (repo/"data").mkdir();(repo/"data"/"history.txt").write_text("private")
        outside=self.root/"outside";outside.write_text("private")
        (repo/"leak").symlink_to(outside)
        (repo/"folder").symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(OSError):
            server.open_export_file(repo, "leak")
        with self.assertRaises(OSError):
            server.open_export_file(repo, "folder/outside")
        subprocess.run(["git","-C",str(repo),"add","."],check=True)
        with mock.patch.object(server,"require_allowed_repo",return_value=str(repo)):
            archive,_=server.create_repo_zip(str(repo))
        self.addCleanup(lambda: archive.unlink(missing_ok=True))
        with zipfile.ZipFile(archive) as zipped:
            names=[name.split("/",1)[1] for name in zipped.namelist()]
        self.assertEqual(sorted(names),[".gitignore","ok.txt"])
        with mock.patch.object(server,"require_allowed_repo",return_value=str(self.root)):
            with self.assertRaisesRegex(ValueError,"Git repository"):
                server.create_repo_zip(str(self.root))

    def test_http_header_auth_and_no_public_data(self):
        httpd=server.ThreadingHTTPServer(("127.0.0.1",0),server.ChatHandler)
        httpd.daemon_threads=True;httpd.chat_token="test-only-token"
        thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        try:
            def get(path,headers=None):
                connection=http.client.HTTPConnection("127.0.0.1",httpd.server_port,timeout=5)
                connection.request("GET",path,headers=headers or {})
                response=connection.getresponse();body=response.read()
                result=(response.status,body,response.getheader("referrer-policy"))
                connection.close();return result
            self.assertEqual(get("/c/state?token=test-only-token")[0],401)
            self.assertEqual(get("/d/list")[0],401)
            with mock.patch.object(server,"load_config",return_value={"desktop_enabled":"1"}):
                code,body,policy=get("/d/list",{"x-chat-token":"test-only-token"})
                self.assertEqual(code,200);self.assertEqual(json.loads(body)["chats"],[])
                self.assertEqual(policy,"no-referrer")
            self.assertEqual(get("/desktop")[0],200)
            self.assertEqual(get("/static/desktop.js")[0],200)
        finally:
            httpd.shutdown();httpd.server_close();thread.join()
if __name__=="__main__":unittest.main()
