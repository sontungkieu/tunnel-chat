from __future__ import annotations
import base64
import http.client
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
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
        self.assertEqual(conn.execute("SELECT codex_session_id,backend,host_id,hidden FROM codex_chats").fetchone(),
                         ("old-session","cli-wsl","local",0))
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

    def test_unlink_hides_web_record_and_relink_restores_same_task(self):
        task=str(uuid.uuid4());chat=self.chat()
        with server.connect() as conn:
            conn.execute("UPDATE codex_chats SET codex_session_id=? WHERE id=?",(task,chat));conn.commit()
        self.assertEqual(desktop.unlink(server,chat),{"ok":True})
        self.assertEqual(desktop.list_chats(server),[])
        snapshot={"threadId":task,"title":"restored","cwd":r"D:\work","status":"idle","messages":[]}
        with mock.patch.object(desktop.BRIDGE,"call",return_value=snapshot):
            linked=desktop.link(server,task)
        self.assertEqual(linked["chat_id"],chat)
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT hidden FROM codex_chats WHERE id=?",(chat,)).fetchone()[0],0)

    def test_list_merges_cached_live_summaries_without_loading_history(self):
        chat=self.chat();row=server.get_codex_chat(chat);turn=str(uuid.uuid4())
        summary={row["codex_session_id"]:{"status":"running","activity":"thinking",
            "revision":17,"latestTurnId":turn}}
        with mock.patch.object(server,"load_config",return_value={"desktop_enabled":"1"}), \
             mock.patch.object(desktop.BRIDGE,"call",return_value=summary) as call:
            result=desktop.dispatch(server,"list",{})
        self.assertEqual(result["chats"][0]["activity"],"thinking")
        self.assertEqual(result["chats"][0]["latestTurnId"],turn)
        self.assertTrue(result["chats"][0]["live"])
        self.assertEqual(server.get_codex_chat(chat)["status"],"running")
        call.assert_called_once_with({"desktop_enabled":"1"},"summaries",
            data={"threadIds":[row["codex_session_id"]]},timeout=5)

    def test_background_load_reports_progress_and_result(self):
        task=str(uuid.uuid4())
        def fake_link(_server,value,progress=None):
            progress({"stage":"receiving-history","receivedBytes":50,"totalBytes":100,"percent":50})
            return {"chat_id":7,"state":{"threadId":value}}
        with mock.patch.object(desktop,"link",side_effect=fake_link):
            started=desktop.start_load(server,{"thread":"codex://threads/"+task})
            for _ in range(100):
                status=desktop.load_status({"load_id":started["load_id"]})
                if status["status"] != "loading":
                    break
                time.sleep(0.01)
        self.assertEqual(status["status"],"complete")
        self.assertEqual(status["result"]["state"]["threadId"],task)

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

    def test_task_creation_persists_project_controller_and_deduplicates(self):
        source=self.chat();child=str(uuid.uuid4());controller=str(uuid.uuid4())
        result={"threadId":child,"controllerThreadId":controller,"controllerCreated":True,
                "state":{"threadId":child,"title":"new task","cwd":r"D:\work",
                         "status":"running","messages":[]}}
        operation=str(uuid.uuid4())
        payload={"operation_id":operation,"text":"first prompt","model":"gpt-6-astra","effort":"high"}
        with mock.patch.object(desktop.BRIDGE,"call",return_value=result) as call:
            created=desktop.create_task(server,source,payload)
            repeated=desktop.create_task(server,source,payload)
        self.assertEqual(created,repeated)
        self.assertEqual(created["state"]["title"],"new task")
        self.assertEqual(desktop.project_controller(server,r"D:\work"),controller)
        self.assertEqual(server.get_codex_chat(created["chat_id"])["codex_session_id"],child)
        call.assert_called_once()

    def test_background_creation_exposes_progress_and_result(self):
        source=self.chat()
        def fake_create(_server,chat_id,data,progress=None):
            self.assertEqual(chat_id,source);self.assertEqual(data["text"],"hello")
            progress({"stage":"creating-task"})
            return {"chat_id":9,"state":{"threadId":str(uuid.uuid4())}}
        with mock.patch.object(desktop,"create_task",side_effect=fake_create):
            started=desktop.start_create(server,source,{"operation_id":str(uuid.uuid4())},"hello")
            for _ in range(100):
                status=desktop.create_status({"create_id":started["create_id"]})
                if status["status"]!="creating":
                    break
                time.sleep(0.01)
        self.assertEqual(status["status"],"complete")
        self.assertEqual(status["result"]["chat_id"],9)

    def test_chunked_first_prompt_starts_background_creation(self):
        source=self.chat();body=b"a long first prompt"
        upload=server.create_codex_prompt_upload(source,len(body),1,[])
        encoded=base64.urlsafe_b64encode(body).decode().rstrip("=")
        server.add_codex_prompt_chunk(upload,0,encoded)
        operation=str(uuid.uuid4())
        expected={"create_id":str(uuid.uuid4()),"status":"creating","stage":"queued"}
        with mock.patch.object(server,"load_config",return_value={"desktop_enabled":"1"}), \
             mock.patch.object(desktop,"start_create",return_value=expected) as start:
            result=desktop.dispatch(server,"prompt/finish",{
                "chat_id":source,"upload_id":upload,"create":True,"operation_id":operation})
        self.assertEqual(result,expected)
        start.assert_called_once()
        self.assertEqual(start.call_args.args[2]["operation_id"],operation)
        self.assertEqual(start.call_args.args[3],body.decode())

    def test_attachment_ownership_checked_before_staging(self):
        chat=self.chat()
        with mock.patch.object(desktop.BRIDGE,"call") as call:
            with self.assertRaisesRegex(ValueError,"does not belong"):
                desktop.stage_attachments(server,chat,[999])
            call.assert_not_called()

    def test_staged_image_uses_local_image_without_path_text(self):
        chat=self.chat();folder=server.CODEX_ATTACHMENTS_DIR/str(chat);folder.mkdir(parents=True)
        source=folder/"1-screen.png";source.write_bytes(b"image")
        attachment={"id":1,"filename":"screen.png","path":str(source),"is_image":1}
        staged={"windowsPath":r"D:\cache\screen.png","wslPath":"/mnt/d/cache/screen.png"}
        with mock.patch.object(server,"get_codex_attachments",return_value=[attachment]), \
             mock.patch.object(desktop.BRIDGE,"call",return_value=staged):
            text,images=desktop.stage_attachments(server,chat,[1])
        self.assertEqual(text,"")
        self.assertEqual(images,[staged["windowsPath"]])

    def test_desktop_images_are_cached_without_exposing_native_paths(self):
        chat=self.chat();other_chat=self.chat()
        source=self.root/"clipboard.png"
        source.write_bytes(b"\x89PNG\r\n\x1a\nlocal-image")
        native_path=r"C:\Users\Tung\AppData\Local\Temp\clipboard.png"
        result={"threadId":str(uuid.uuid4()),"messages":[
            {"id":"u","role":"user","text":"screenshot","images":[native_path]}]}
        with mock.patch.object(desktop,"local_path_from_windows",return_value=source):
            desktop.prepare_state_images(server,chat,result)
        self.assertNotIn(native_path,str(result))
        image=result["messages"][0]["images"][0]
        self.assertNotIn("path",image)
        self.assertRegex(image["id"],r"^[0-9a-f]{32}$")
        cached=desktop.image_file(server,chat,image["id"])
        self.assertEqual(cached["path"].read_bytes(),source.read_bytes())
        self.assertEqual(cached["mime_type"],"image/png")
        with self.assertRaisesRegex(ValueError,"unavailable"):
            desktop.image_file(server,other_chat,image["id"])

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
        chat=self.chat()
        source=self.root/"http-image.png";source.write_bytes(b"\x89PNG\r\n\x1a\nhttp-image")
        result={"threadId":str(uuid.uuid4()),"messages":[
            {"id":"u","role":"user","text":"","images":[r"C:\Temp\http-image.png"]}]}
        with mock.patch.object(desktop,"local_path_from_windows",return_value=source):
            desktop.prepare_state_images(server,chat,result)
        image_id=result["messages"][0]["images"][0]["id"]
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
            self.assertEqual(get(f"/d/image?chat_id={chat}&image_id={image_id}")[0],401)
            with mock.patch.object(server,"load_config",return_value={"desktop_enabled":"1"}):
                code,body,policy=get("/d/list",{"x-chat-token":"test-only-token"})
                self.assertEqual(code,200)
                self.assertEqual([item["id"] for item in json.loads(body)["chats"]],[chat])
                self.assertEqual(policy,"no-referrer")
                connection=http.client.HTTPConnection("127.0.0.1",httpd.server_port,timeout=5)
                connection.request("GET",f"/d/image?chat_id={chat}&image_id={image_id}",
                                   headers={"x-chat-token":"test-only-token"})
                response=connection.getresponse();image_body=response.read()
                self.assertEqual(response.status,200)
                self.assertEqual(response.getheader("content-type"),"image/png")
                self.assertTrue(response.getheader("content-disposition").startswith("inline;"))
                self.assertEqual(image_body,source.read_bytes());connection.close()
            self.assertEqual(get("/desktop")[0],302)
            self.assertEqual(get("/")[0],302)
            for path in ("/codex", "/codex/cli", "/queue"):
                self.assertEqual(get(path)[0],200)
            self.assertIn(b'href="/chat/"', get("/codex")[1])
            self.assertIn(b'type="button" id="linkButton"', get("/codex")[1])
            self.assertIn(b'id="taskContextMenu"', get("/codex")[1])
            self.assertIn(b'id="selectionAction"', get("/codex")[1])
            self.assertIn(b'id="quoteContext"', get("/codex")[1])
            self.assertIn(b'id="chatLoader"', get("/codex")[1])
            self.assertIn(b'id="chatLoaderProgress"', get("/codex")[1])
            self.assertEqual(get("/static/desktop.js")[0],200)
            self.assertEqual(get("/static/rich-text.js")[0],200)
            self.assertEqual(get("/static/selection-quote.js")[0],200)
            self.assertEqual(get("/static/vendor/katex-0.18.5.min.css")[0],200)
            self.assertEqual(get("/static/vendor/fonts/KaTeX_Main-Regular.woff2")[0],200)
            self.assertEqual(get("/static/vendor/../desktop.js")[0],404)
        finally:
            httpd.shutdown();httpd.server_close();thread.join()
if __name__=="__main__":unittest.main()
