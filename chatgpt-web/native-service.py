"""Start/stop the optional native browser bridge without touching Codex."""
from pathlib import Path
import json
import os
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


def launch_windows(config_path):
    script = subprocess.check_output(["wslpath", "-w", str(ROOT / "chatgpt-web/native-launcher.cjs")], text=True).strip()
    windows_config = subprocess.check_output(["wslpath", "-w", str(config_path)], text=True).strip()
    subprocess.run(["/mnt/c/Program Files/nodejs/node.exe", script, windows_config], check=True)


def main():
    config = {**server.parse_env_file(server.ENV_PATH), **os.environ}
    pid_file = ROOT / "run/chat-web-native.pid"
    state_root = config.get("CHAT_WEB_NATIVE_ROOT", r"D:\dev\codex\tunnel-chat\chatgpt-web\native")
    linux_root = Path(subprocess.check_output(["wslpath", "-u", state_root], text=True).strip())
    config_path = linux_root / "bridge-runtime.json"
    pid = None
    if pid_file.exists():
        candidate = int(pid_file.read_text())
        proc = Path("/proc") / str(candidate)
        if proc.exists() and (proc / "cmdline").read_bytes():
            args = (proc / "cmdline").read_bytes().decode().split("\0")
            if (proc / "cwd").resolve() != ROOT or str(ROOT / "chatgpt-web/native-server.cjs") not in args:
                raise RuntimeError("PID does not belong to this checkout's native browser bridge")
            pid = candidate
    action = sys.argv[1:]
    if action not in (["start"], ["stop"], ["login"]):
        raise RuntimeError("Usage: native-service.py start|stop|login")
    if action in (["stop"], ["login"]):
        if pid:
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                proc = Path("/proc") / str(pid)
                if not proc.exists() or not (proc / "cmdline").read_bytes():
                    break
                time.sleep(.1)
            else:
                raise RuntimeError("Native browser bridge did not stop")
        pid_file.unlink(missing_ok=True)
        print("Browser streaming stopped; Chrome and its login remain open.", flush=True)
        if action == ["login"]:
            script = subprocess.check_output([
                "wslpath", "-w", str(ROOT / "chatgpt-web/native-login.cjs")
            ], text=True).strip()
            browser = config.get("CHAT_WEB_BROWSER_BIN", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            raise SystemExit(subprocess.call(["/mnt/c/Program Files/nodejs/node.exe", script, state_root, browser]))
        return
    if pid:
        launch_windows(config_path)
        print(f"Native browser bridge already running pid={pid}")
        return
    node = config.get("GATEWAY_NODE")
    if not node:
        raise RuntimeError("Set GATEWAY_NODE to native WSL Node.js")
    port = int(config.get("CHAT_WEB_NATIVE_PORT", "3000"))
    if not 1 <= port <= 65535 or not str(linux_root).startswith("/mnt/d/"):
        raise RuntimeError("Configure a valid local port and a dedicated browser directory on D:")
    linux_root.mkdir(parents=True, exist_ok=True)
    runtime = {
        "origin": f"http://127.0.0.1:{port}", "token": secrets.token_urlsafe(32),
        "CHAT_WEB_NATIVE_ROOT": state_root,
        "CHAT_WEB_BROWSER_BIN": config.get("CHAT_WEB_BROWSER_BIN", r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    }
    for name in ("CHAT_WEB_CANARY", "CHAT_WEB_START_URL"):
        if name in os.environ:
            runtime[name] = os.environ[name]
    config_path.write_text(json.dumps(runtime))
    env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "LANG"}}
    env.update({"CHAT_WEB_NATIVE_CONFIG": str(config_path), "CHAT_WEB_NATIVE_PORT": str(port)})
    if runtime.get("CHAT_WEB_CANARY"):
        env["CHAT_WEB_CANARY"] = runtime["CHAT_WEB_CANARY"]
    for name in ("run", "logs"):
        (ROOT / name).mkdir(exist_ok=True)
    with (ROOT / "logs/chat-web-native.log").open("a") as log:
        child = subprocess.Popen([node, str(ROOT / "chatgpt-web/native-server.cjs")], cwd=ROOT,
                                 env=env, stdin=subprocess.DEVNULL, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(.7)
    if child.poll() is not None:
        raise RuntimeError("Native web bridge failed; inspect logs/chat-web-native.log")
    pid_file.write_text(str(child.pid))
    launch_windows(config_path)
    print(f"Native browser bridge started pid={child.pid}; data stays on D:.")


if __name__ == "__main__":
    main()
