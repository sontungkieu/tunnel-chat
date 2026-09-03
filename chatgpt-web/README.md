# ChatGPT web browser

This component streams a dedicated Chromium browser opened at chatgpt.com.
It does not reverse-proxy OpenAI HTTP requests, copy an existing browser profile,
or attach to the Codex app. Log in to ChatGPT yourself in this dedicated browser
on the personal machine. That session stays in its own persistent profile.

The public entry is /chat/; / redirects there. The main gateway forwards HTTP
and WebSocket traffic to this component. /codex remains the separate app bridge.
Browser authentication uses a separate password and an expiring HttpOnly cookie
scoped to /chat/. Codex tokens and this cookie are stripped at the opposite
upstream boundary. Logout closes active browser WebSockets; restarting the
gateway revokes all web access sessions but leaves the browser profile intact.
All tabs with the same access password control the same personal browser.

Path separation is not a browser same-origin security boundary: both pages still
share an origin. Use separate hostnames if untrusted scripts must be isolated.
The browser's remote control also allows navigation away from ChatGPT; this is a
dedicated browser session, not a URL-locked kiosk or a stream of the whole host.

## Browser setup

Requires a running Docker engine with enough image storage. On Windows, check
Docker Desktop's disk-image location and free space before downloading the image.
Use a dedicated profile on D:, outside both this repo and all Codex homes.
Do not reuse a personal Chrome profile. No host home, Codex state, Docker socket
or desktop is mounted by this configuration.

PowerShell on the personal Windows machine:

    $env:CHAT_WEB_PROFILE_DIR = 'D:/dev/codex/tunnel-chat/chatgpt-web/profile'
    New-Item -ItemType Directory -Force $env:CHAT_WEB_PROFILE_DIR
    docker compose -f '\\wsl.localhost\Ubuntu\home\tung\rlcsd-fix-chat\chatgpt-web\compose.yaml' up -d

For a Linux Docker engine, set CHAT_WEB_PROFILE_DIR to a dedicated Linux path
and run docker compose -f chatgpt-web/compose.yaml up -d from the repo.

Set CHAT_WEB_UPSTREAM=http://127.0.0.1:3000 in .env.local and restart the gateway
with ./bin/restart-gateway after verifying that address is reachable from WSL.
If Docker Desktop is used, enable its WSL integration and verify port forwarding;
do not expose the raw port on 0.0.0.0 as a workaround. If localhost forwarding is
unavailable, run the gateway on Windows with the same source, Node.js, a separate
Windows password file, and CODEX_UPSTREAM pointing to the forwarded WSL backend.
Keep the raw browser port restricted to the host.

The image is intentionally optional: a stopped/missing browser shows a clear
unavailable page after tunnel login, while Codex keeps working. Starting/stopping
this Compose project does not start, stop or modify Codex.

The official image uses the /chat/ subfolder for both assets and WebSockets.
The gateway supports WebSocket upgrades; HTTPS is supplied by the existing tunnel.
The image tag is latest because this checkout has not run an image verification
yet; record a verified digest before treating a deployment as reproducible.
Image downloads and browser login are not performed by ./bin/start.

## Access password

./bin/start creates a random password in .secrets/chatgpt-web.password with mode
0600 if it does not exist. Read that file privately on your personal machine and
type its value into /chat/. It is not an OpenAI password or a Codex token.
Set CHAT_WEB_PASSWORD_FILE to override the location; passwords must have at least
24 characters. Never put the value in a URL, repository, command argument or log.

Sessions last eight hours by default. CHAT_WEB_SESSION_SECONDS accepts 60–86400
seconds. /chat/_auth/session offers logout from the tunnel. Change the password
file and run ./bin/restart-gateway to revoke all access sessions without touching
the Codex backend or ChatGPT's browser login.

Terminal/command launching, sudo, file transfer and clipboard synchronization
are disabled in the container configuration. Browser uploads, downloads and
clipboard workflows have not been validated and are intentionally not promised.

Reference: https://docs.linuxserver.io/images/docker-chromium/
