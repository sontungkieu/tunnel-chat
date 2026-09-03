# Tunnel Chat

Standalone browser chat bridge with a manual fix queue and direct Codex sessions,
accessible through a Cloudflare tunnel. Originally developed as RLCSD Fix Chat.

Source repository: [sontungkieu/tunnel-chat](https://github.com/sontungkieu/tunnel-chat)

This project is maintained independently of True Chat. The existing WSL checkout
remains at `/home/tung/rlcsd-fix-chat`, and the Python project name remains
`rlcsd-fix-chat`; importing it into Git does not move local chat data or settings.

## Setup

Requires Linux/WSL, Bash, Git, Python 3.10 or newer, and `uv`. Cloudflare access
also requires `cloudflared`; direct Codex mode requires a working native Linux
Codex executable and its configured login. Node.js 18 or newer is only needed for
the JavaScript test.

For a fresh checkout:

```bash
git clone https://github.com/sontungkieu/tunnel-chat.git
cd tunnel-chat
uv sync --frozen
uv run python server.py init-env
```

Before starting, edit the generated `.env.local` for this machine:

- `CODEX_BIN`: absolute path to an existing native Linux Codex executable. The
  original default points to a versioned VS Code extension and may no longer
  exist after an extension update. Verify the selected binary with `--version`.
- `CODEX_REPOS`: colon-separated absolute paths to the repositories the web UI
  may access. Set these explicitly on a fresh checkout.
- `CODEX_HOME`: the Codex state directory for the chosen WSL/Linux account.
- `HOST` and `PORT`: the local listening address and port.
- `CLOUDFLARED_BIN`: override the script default if cloudflared is installed
  outside `/home/tung/.local/bin/cloudflared`.

The original installation below can keep using its existing `.env.local`.

## Run

Run from the checkout root: `/home/tung/rlcsd-fix-chat` for the existing
installation, or the new `tunnel-chat` directory for a fresh clone.

```bash
./bin/start
./bin/quick-tunnel
./bin/url
```

Open the URL printed by `./bin/url` from the company machine. Paste the error,
send it, then press `Send & Fix`.

For the direct Codex mode:

```bash
./bin/url codex
```

Codex mode opens `/codex`, lets you create multiple chats, select an allowed
repo, and sends each message into a persisted Codex `exec` session for that
chat. The default allowed repos are:

```text
/home/tung/RLCSD
/home/tung/rlcsd-fix-chat
```

Change them in `.env.local` with `CODEX_REPOS`, separated by `:`.

The Codex binary is pinned with `CODEX_BIN` so the service uses the native WSL
Codex binary instead of the Windows npm wrapper.

Codex mode supports attachments:

- all files are uploaded through the same byte-blob chunk transport
- each blob chunk is base64url-encoded and sent through small GET-RPC requests,
  then reassembled server-side before type-specific handling
- queue text, Codex prompts, images, and other attachments all use the same
  client uploader
- chunk requests retry with exponential backoff and query server-side upload
  status to resend only missing chunks
- uploads run with bounded concurrency; the default is three chunk requests
- text/log/source files are saved locally and referenced in the prompt with a
  preview and file path
- images are saved locally the same way and passed to Codex with `-i`
- binary files are saved locally and referenced by path
- per-file limit is 8 MB
- normal fix queue mode uses the same chunk transport; only the final server
  action differs, creating a queue/fix request instead of a Codex attachment
- current upload chunk size defaults to 6144 bytes before base64url encoding,
  keeping the final proxied URL well below common proxy limits
- incomplete upload sessions are removed after six hours by default

Transport settings are configured in `.env.local`:

```bash
UPLOAD_CHUNK_BYTES=6144
UPLOAD_CONCURRENCY=3
UPLOAD_RETRY_LIMIT=4
UPLOAD_TTL_SECONDS=21600
```

Chunk size is clamped to 1024-32768 bytes while the transport uses GET-RPC
URLs. Concurrency is clamped to 1-6, retry count to 1-8, and upload TTL to five
minutes through seven days. Server-side limits are 4 MB for queue text and
Codex prompts, and 8 MB per Codex attachment. The server validates byte size,
chunk count, and every decoded chunk rather than trusting browser limits.

Both pages use server-sent events for prompt message/status refresh, with
polling retained as an automatic fallback for proxies that buffer or reject
event streams.

Attachments are stored under:

```text
data/codex_attachments/
```

Each Codex process runs in its own process group. Cancel stops the complete
process tree, and service startup reconciles chats left in `running` state by a
previous server process. A chat resumes only the session ID returned by its own
Codex JSON event stream; it never guesses from another recent session in the
same repo.

Both modes have a `Download zip` button. The downloaded file is named:

```text
<repo-name>-<commit6>.zip
```

The zip file is built from `git ls-files -co --exclude-standard`, so tracked
files and untracked non-ignored files are included while `.gitignore` entries
are excluded. In fix queue mode it downloads the default repo
`/home/tung/RLCSD`; in Codex mode it downloads the active chat repo, or the
repo currently selected before a chat is created.

If your Cloudflare token maps to a fixed hostname, set it once in `.env.local`:

```bash
PUBLIC_URL=https://your-host.example.com
```

## Operator

Read the oldest open fix request:

```bash
./bin/next
```

Reply with commands:

```bash
./bin/reply 1 <<'EOF'
cd /workspace/storage-shared/nlp/tungks/RLCSD-main
source .venv/bin/activate
python3 - <<'PY'
print("example")
PY
EOF
```

Stop services:

```bash
./bin/stop
```

Run the local test suite:

```bash
uv run --frozen python -m unittest discover -s tests -v
node tests/test_shared_transport.js
```

## Secrets

The named-tunnel script (`./bin/tunnel`) reads `CLOUDFLARE_TUNNEL_TOKEN`
from `SECRETS_ENV`, whose original default is:

```text
/home/tung/2025.2-IT3180E-SE/.secrets/.env
```

The token is not copied into source files or logs.

## Local state and maintenance

Keep `.env.local`, secret files, `data/`, `logs/`, and `run/` local. They are
excluded from Git along with virtual environments and caches. The SQLite chat
history and uploaded attachments remain under `data/`; a Git clone contains
source code, not a backup of this runtime state.

Run both test commands before committing behavior changes. The Python tests use
temporary databases, and the JavaScript test simulates upload retry/resume and
bounded concurrency. They do not start a public tunnel or run a live Codex turn.

## Known limitations of the initial import

- Defaults contain paths from the original WSL installation; configure them on
  each host. Repository setup does not start the server or repair a stale
  `CODEX_BIN` setting.
- The current browser clients store the chat access token in `localStorage` and
  pass it in request URLs. Those URLs are credentials and may be retained in
  browser or proxy history; header-only authentication is still pending.
- ZIP export uses Git's visible files when available. Its non-Git fallback does
  not enforce `.gitignore`, and it does not reject symlinks that lead outside the
  selected repository. ZIP hardening remains pending.
