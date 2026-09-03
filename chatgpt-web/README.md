# ChatGPT web

The default backend streams one dedicated Chrome page running on Windows.
It captures the rendered page and forwards mouse, wheel and keyboard events;
it does not stream the host desktop or copy another browser's cookies.

The tab inside the ChatGPT/Codex app is not attached: that running browser has
no external DevTools endpoint. Log in once in the dedicated Chrome window on
the personal machine. The persistent profile is on D:, so the company browser
only needs this tunnel's separate access password.

## Start on the existing Windows + WSL installation

Requirements: Windows Chrome (Edge is configurable), Windows Node.js 20.14+
with WebSocket support, WSL Node.js 18+, Python and uv. No Docker or npm install.

    ./bin/chat-web-start

Set this in .env.local, then restart only the gateway:

    CHAT_WEB_UPSTREAM=http://127.0.0.1:3000
    ./bin/restart-gateway

Open /chat/ through the HTTPS tunnel and enter the password from
.secrets/chatgpt-web.password. It is separate from the OpenAI login.
Use /chat/_auth/session to end tunnel access. Gateway restart also revokes these
access sessions, while the browser login and the Codex backend remain intact.

The existing deployment keeps /codex for the app's Codex tasks, /codex/cli for
legacy CLI sessions and /queue for the manual queue. / redirects to /chat/.

## Manual sign-in if Google rejects the streaming browser

Google may reject browsers controlled by automation with "This browser or app
may not be secure". The streaming Chrome uses DevTools; sign in locally in a
normal Chrome window with streaming paused:

1. Close the dedicated Chrome window and any Google sign-in popup.
2. Run `./bin/chat-web-login`. It stops the web bridge and opens the same owned
   profile in normal Chrome, without a debugging endpoint or app-window mode.
3. Sign into ChatGPT yourself on the personal PC. Finish any Google/MFA steps
   there. Then close that Chrome window and run `./bin/chat-web-start`.

The login command does not read or transfer cookies, passwords or tokens. It
leaves the gateway, tunnel and Codex services running. It refuses to reuse a
still-running debugging browser; closing Chrome first is required to change
launch modes. Google may still require additional verification; successful
sign-in cannot be guaranteed or checked by the launcher. No detection flags or
account security settings are disabled.

See [Google's supported-browser sign-in guidance](https://support.google.com/accounts/answer/7675428?hl=en).

## Operation and settings

- Click the streamed page to use the mouse, keyboard and wheel.
- The text box below the stream reliably inserts pasted/multiline Vietnamese
  into the selected field. It does not automatically submit the ChatGPT prompt.
- The page initially adapts to the viewer's available area; use "Vừa cửa sổ"
  after resizing. Multiple viewers control the same page.
- "ChatGPT" returns the dedicated page to chatgpt.com; "Tải lại trang" reloads it.
- Keep Windows awake and the Chrome window open. Images update at up to about
  eight frames per second, with a periodic refresh for idle/background pages.
- This release supports text interaction. Audio/video calls, microphone,
  native dialogs, uploads and downloads are not forwarded. Native file pickers
  are intercepted and produce a notice instead of exposing local file paths.
- If sign-in opens a separate popup, finish it locally in Chrome on the personal
  machine. Only the selected main page is streamed.

Stop streaming with ./bin/chat-web-stop. Chrome and its profile remain open.
Start it again with ./bin/chat-web-start; it reuses that owned profile and page.
This lifecycle is separate from ./bin/start and ./bin/stop, which manage the
gateway/Codex services. No startup task or Windows service is installed.

Settings in .env.local:

    CHAT_WEB_NATIVE_PORT=3000
    CHAT_WEB_NATIVE_ROOT='D:\dev\codex\tunnel-chat\chatgpt-web\native'
    CHAT_WEB_BROWSER_BIN='C:\Program Files\Google\Chrome\Application\chrome.exe'

GATEWAY_NODE selects WSL Node. The launcher uses the existing Windows Node
installation at C:\Program Files\nodejs\node.exe.

CHAT_WEB_NATIVE_ROOT must be a dedicated directory on D:. It contains profile/,
an ownership marker, the selected target ID, private bridge-runtime.json,
driver.pid and small diagnostic logs. The runtime configuration contains an
internal capability token and is restricted to the current Windows user.
Never publish this directory or substitute a personal Chrome profile.

## Transport and isolation

    Company browser -> existing HTTPS tunnel -> gateway /chat/
        -> loopback WSL web bridge
        <- outbound loopback HTTP from a detached Windows helper
        -> loopback DevTools connection to the dedicated Chrome page

The Windows helper connects to the WSL bridge through Windows localhost
forwarding. It requires no inbound Windows/LAN listener beyond Chrome's private
loopback DevTools endpoint. The /__driver/* channel requires a separate random
capability token and is not routed by the public gateway. Only fixed page
controls and validated input events are accepted; there is no public arbitrary
DevTools command, script evaluation, cookie or file API.

Frames and input remain in memory. Diagnostics do not record page contents or
typed text. Commands are serialized and are never automatically replayed after
an uncertain outcome. Slow viewers drop old frames.

Tunnel authentication uses an expiring HttpOnly cookie scoped to /chat/.
Both HTTP streams and WebSockets close on logout/expiry. Codex credentials are
stripped before proxying browser traffic; browser cookies do not unlock Codex.
Path separation is not an origin security boundary: use separate hostnames if
untrusted scripts must be isolated.

## Validation

The native transport was checked with a real Windows Chrome canary: page
capture, clicking and inserting Vietnamese text worked through the web viewer.
The canary is disabled in production; the live target is chatgpt.com.
Protocol, input validation, private-driver authentication, gateway auth,
stream revocation and Codex regressions have automated coverage. No test sends
a model prompt or signs into an OpenAI account on behalf of the user.

For the disposable local canary only, supply CHAT_WEB_CANARY=1 and
CHAT_WEB_START_URL=http://127.0.0.1:3000/__native_canary to ./bin/chat-web-start.
Stop it and restart without those variables when finished.

## Optional Docker backend

compose.yaml remains an alternative Chromium/Selkies backend. Do not run it on
port 3000 at the same time as the native bridge. It has its own independent
profile, also requiring a separate local sign-in. Set CHAT_WEB_PROFILE_DIR
to a dedicated data directory before docker compose up; the image store also
needs free space. The native backend above does not require Docker.

References: [DevTools page capture](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[DevTools input](https://chromedevtools.github.io/devtools-protocol/tot/Input/),
[Edge protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/),
[LinuxServer Chromium](https://docs.linuxserver.io/images/docker-chromium/).
