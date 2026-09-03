"""Local startup for the shared gateway and the independent Codex backend."""
from __future__ import annotations

import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import server

ROOT = Path(__file__).resolve().parent


def running(name: str) -> int | None:
    path = ROOT / "run" / f"{name}.pid"
    if not path.exists():
        return None
    pid = int(path.read_text().strip())
    proc = Path("/proc") / str(pid)
    if not proc.exists():
        return None
    expected = "server.py" if name == "server" else str(ROOT / "gateway.cjs")
    args = (proc / "cmdline").read_bytes().decode().split("\0")
    if (proc / "cwd").resolve() != ROOT or expected not in args:
        raise RuntimeError(f"PID file for {name} does not match this checkout; inspect it before continuing")
    return pid


def launch(name: str, args: list[str], env: dict[str, str]) -> int:
    with (ROOT / "logs" / f"{name}.log").open("a") as log:
        child = subprocess.Popen(args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(0.5)
    if child.poll() is not None:
        raise RuntimeError(f"{name} failed to start; inspect logs/{name}.log")
    (ROOT / "run" / f"{name}.pid").write_text(str(child.pid))
    return child.pid


def main() -> None:
    config = {**server.parse_env_file(server.ENV_PATH), **os.environ}
    port = int(config.get("PORT", str(server.DEFAULT_PORT)))
    backend_port = int(config.get("CODEX_PORT", str(port + 1)))
    if not (1 <= port <= 65535 and 1 <= backend_port <= 65535) or port == backend_port:
        raise ValueError("PORT and CODEX_PORT must be different valid ports")
    for name in ("run", "logs", ".secrets"):
        (ROOT / name).mkdir(exist_ok=True)
    node = config.get("GATEWAY_NODE") or shutil.which("node")
    if not node or node.endswith(".exe"):
        raise RuntimeError("Set GATEWAY_NODE to a native WSL Node.js 18+ executable")
    password = Path(config.get("CHAT_WEB_PASSWORD_FILE", str(ROOT / ".secrets/chatgpt-web.password")))
    if not password.is_absolute():
        password = ROOT / password
    if not password.exists():
        if "CHAT_WEB_PASSWORD_FILE" in config:
            raise RuntimeError("Configured CHAT_WEB_PASSWORD_FILE does not exist")
        fd = os.open(password, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(secrets.token_urlsafe(32) + "\n")

    backend = running("server")
    if backend:
        raw_env = (Path("/proc") / str(backend) / "environ").read_bytes().split(b"\0")
        if ("PORT=" + str(backend_port)).encode() not in raw_env:
            raise RuntimeError("Existing server uses the old port. Restart it once to enable the gateway.")
    if sys.argv[1:] == ["restart-gateway"]:
        gateway = running("gateway")
        if gateway:
            os.kill(gateway, signal.SIGTERM)
            for _ in range(50):
                proc = Path("/proc") / str(gateway)
                if not proc.exists() or not (proc / "cmdline").read_bytes():
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Gateway did not stop")
            (ROOT / "run/gateway.pid").unlink(missing_ok=True)
        if not backend:
            raise RuntimeError("Start the Codex backend with ./bin/start first")
    started_backend = False
    if not backend:
        child_env = {**config, "HOST": "127.0.0.1", "PORT": str(backend_port)}
        backend = launch("server", [sys.executable, "server.py", "serve"], child_env)
        started_backend = True
    try:
        gateway = running("gateway")
        if not gateway:
            # Only forward gateway settings, never Codex tokens or runtime configuration.
            gateway_env = {key: value for key, value in os.environ.items()
                           if key in {"PATH", "HOME", "LANG", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"}}
            gateway_env.update({
                "HOST": config.get("HOST", "127.0.0.1"), "PORT": str(port),
                "CODEX_UPSTREAM": f"http://127.0.0.1:{backend_port}",
                "CHAT_WEB_PASSWORD_FILE": str(password),
                "CHAT_WEB_UPSTREAM": config.get("CHAT_WEB_UPSTREAM", ""),
                "CHAT_WEB_SESSION_SECONDS": config.get("CHAT_WEB_SESSION_SECONDS", "28800"),
            })
            gateway = launch("gateway", [node, str(ROOT / "gateway.cjs")], gateway_env)
    except Exception:
        if started_backend:
            os.kill(backend, signal.SIGTERM)
            (ROOT / "run/server.pid").unlink(missing_ok=True)
        raise
    print(f"Gateway pid={gateway}; Codex backend pid={backend}")
    print(f"Local URL: http://{config.get('HOST', '127.0.0.1')}:{port}/")
    print("ChatGPT web: ./bin/url chat ; Codex: ./bin/url codex")


if __name__ == "__main__":
    main()
