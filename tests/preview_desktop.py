"""Disposable loopback UI fixture. No real agent, user state or model calls.

Run: uv run python tests/preview_desktop.py
Open: http://127.0.0.1:18787/codex#token=preview-only
Link: 11111111-1111-4111-8111-111111111111
"""
from pathlib import Path
import sys
import tempfile
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import desktop
import server

TASK="11111111-1111-4111-8111-111111111111"
state={"threadId":TASK,"title":"Demo · kiểm thử giao diện","cwd":r"D:\dev\demo",
    "project":"demo","projectPath":r"D:\dev\demo","backend":"desktop","hostId":"local",
    "model":"simulator","status":"running","activity":"tool","activeTurnId":"demo-turn",
    "revision":1,"messages":[{"id":"welcome","role":"assistant","text":r"""## Kết quả mô phỏng

Markdown có **chữ đậm**, *chữ nghiêng*, [liên kết](https://katex.org/) và bảng:

| Thành phần | Trạng thái |
|---|---:|
| Markdown | Đạt |
| Công thức | Đạt |

Công thức inline: \(x_i=\sum_{j=1}^{n}A_{ij}v_j\).

\[
\begin{aligned}
\mathcal L(\theta) &= \mathbb E_{x\sim p}\!\left[\log q_\theta(x)\right] \\
\nabla_\theta \mathcal L &= \sum_{i=1}^{n}w_i\nabla_\theta\ell_i
\end{aligned}
\]

\[
f(x)=\begin{cases}x^2,&x\ge0\\-x,&x<0\end{cases},\qquad
A=\begin{pmatrix}1&2\\3&4\end{pmatrix}\tag{1}
\]

```python
def loss(theta):
    return sum(term(theta) for term in batch)
```"""},
        {"id":"question","role":"user","text":"Kiểm tra giao diện sáng tối và khối công cụ."},
        {"id":"tool-done","role":"tool","text":"python -m unittest discover -s tests","status":"completed"},
        {"id":"tool-live","role":"tool","text":"uv run python preview.py","status":"inProgress"}],
    "requests":[{"id":"test-approval","method":"item/commandExecution/requestApproval",
                 "params":{"command":"echo preview","availableDecisions":["accept","decline"]}}],
    "historyTruncated":False}

def fake_call(config,action,task=None,data=None,refresh=False,progress=None,timeout=None):
    if action=="stage":
        return {"windowsPath":r"D:\dev\demo\file.txt","wslPath":"/mnt/d/dev/demo/file.txt"}
    if task!=TASK:raise ValueError("This fixture accepts only "+TASK)
    if action=="state":return state
    if action=="send":
        state["messages"].append({"id":str(uuid.uuid4()),"role":"user","text":data["text"]})
        state["status"]="running";state["activeTurnId"]="demo-turn"
    elif action=="cancel":
        state["status"]="idle";state["activeTurnId"]=None
    elif action=="reply":
        state["requests"]=[]
    state["revision"]+=1
    return {"ok":True}

def main():
    with tempfile.TemporaryDirectory(prefix="tunnel-chat-preview-") as tmp:
        server.DATA_DIR=Path(tmp)
        server.DB_PATH=Path(tmp)/"chat.sqlite3"
        server.CODEX_ATTACHMENTS_DIR=Path(tmp)/"attachments"
        server.load_config=lambda:{"desktop_enabled":"1"}
        server.allowed_codex_repos=lambda:[]
        desktop.BRIDGE.call=fake_call
        server.init_db()
        httpd=server.ThreadingHTTPServer(("127.0.0.1",18787),server.ChatHandler)
        httpd.daemon_threads=True;httpd.chat_token="preview-only"
        print("Disposable preview ready on 127.0.0.1:18787",flush=True)
        try:httpd.serve_forever()
        finally:httpd.server_close()
if __name__=="__main__":main()
