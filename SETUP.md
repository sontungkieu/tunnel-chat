# Cài Tunnel Chat từ một bản clone mới

Hướng dẫn này dành cho Windows 10/11 chạy WSL2. Server và tunnel chạy trong
WSL; trang `/codex` nối tới các task đang mở trong ứng dụng Codex trên Windows.
Bản cài mới dùng **Cloudflare Quick Tunnel** và một địa chỉ
`https://...trycloudflare.com` tạm thời. Không cần tài khoản Cloudflare.

Nếu repository vẫn để private, tài khoản GitHub của người cài phải được cấp
quyền đọc trước khi clone.

## Yêu cầu

- Git và `curl` trong WSL.
- WSL Node.js 18+ kèm npm để chạy gateway.
- Windows Node.js 18+ tại `C:\Program Files\nodejs\node.exe` để nối ứng dụng
  Codex Desktop.
- Ứng dụng Codex trên Windows đã đăng nhập và đang mở.

`./bin/setup` tự cài `uv` và `cloudflared` vào `.tools/` của repository nếu
hai lệnh này chưa có. Script không dùng `sudo`, không tạo service hệ thống và
không cấu hình named tunnel.

## Cài và chạy

```bash
git clone https://github.com/sontungkieu/tunnel-chat.git
cd tunnel-chat
./bin/setup
./bin/doctor --desktop
./bin/start
./bin/url codex
```

Lệnh cuối in một URL có fragment `#token=...`. Mở nguyên URL đó trên máy cần
truy cập. Đây là credential của phiên Codex; không gửi vào nhóm chat, issue hay
log công khai. URL Quick Tunnel đổi sau khi tunnel được dừng và khởi động lại.

Mở task đích trong Codex Desktop trên máy cá nhân, sao chép
`codex://threads/<task-id>`, dán vào ô **Kết nối task** trên `/codex`, rồi bấm
**Kết nối**. Máy cá nhân phải còn thức, ứng dụng Codex phải chạy và WSL không
bị tắt.

Khi task xin quyền chạy lệnh hoặc sửa file, yêu cầu sẽ hiện ngay trên `/codex`.
Đọc lệnh/thay đổi rồi chọn một trong đúng các phương án do Codex Desktop cung
cấp, chẳng hạn cho phép một lần, cho phép trong phiên, từ chối hoặc hủy lượt.
Trang không tự động phê duyệt và không tự tạo quyền rộng hơn lựa chọn của app.

Các file cục bộ được tạo khi setup/chạy:

- `.env.local`: token và cấu hình riêng của máy; mode mặc định là `quick`.
- `.tools/`: bản `uv`/`cloudflared` cục bộ khi hệ thống chưa có.
- `.secrets/`, `data/`, `logs/`, `run/`: credential và trạng thái runtime.

Các đường dẫn trên đều bị Git bỏ qua. Một bản clone không chứa lịch sử chat,
cookie, token hoặc thông tin đăng nhập của máy khác.

## Dùng prompt cho GPT/Codex agent

Sau khi clone và mở thư mục repository trong Codex/ChatGPT, dán toàn bộ prompt
trong [`GPT_SETUP_PROMPT.md`](GPT_SETUP_PROMPT.md). Prompt cho phép agent cài
dependency trong phạm vi người dùng/repository, kiểm tra môi trường, bật Quick
Tunnel và lưu launcher URL mà không đưa token vào câu trả lời của agent.

## Chọn backend

- `/codex`: task của Codex Desktop trên Windows; đây là lựa chọn mặc định cho
  workflow Windows + WSL.
- `/codex/cli`: Codex CLI chạy độc lập trong WSL. Muốn dùng, đặt `CODEX_BIN` và
  bổ sung các root được phép vào `CODEX_REPOS` trong `.env.local`.
- `/chat/`: browser ChatGPT riêng. Thành phần này có profile và mật khẩu riêng;
  xem [`chatgpt-web/README.md`](chatgpt-web/README.md). Nó không cần thiết để
  dùng `/codex`.
- `/files`: kho truyền file hai chiều riêng, mặc định chỉ mở
  `D:\dev\codex\vai`. Dùng `./bin/url files` để lấy liên kết kèm access token.
  Có thể đổi `FILE_TRANSFER_ROOT` và `FILE_TRANSFER_MAX_BYTES` trong
  `.env.local`; giới hạn upload mặc định là 32 MiB mỗi file. File đã chọn được
  giữ trong hàng đợi IndexedDB và service worker tiếp tục/resume khi chuyển giữa
  `/files`, `/codex` và `/chat/`. Cùng trang có Clipboard notes: dán nội dung,
  gửi nền, mở/sao chép/tải `.txt` hoặc xóa từng note. Trình duyệt phải mở qua
  HTTPS (named/Quick Tunnel) hoặc localhost để dùng service worker.

## Vận hành

```bash
./bin/doctor
./bin/url codex
./bin/url files
./bin/stop
./bin/start
```

`./bin/doctor` chỉ báo version, mode và PID; nó không in token hay mật khẩu.
`./bin/stop` dừng server, gateway và tunnel của checkout này.

Để cập nhật source:

```bash
./bin/stop
git pull --ff-only
./bin/setup
./bin/start
```

`.env.local` và dữ liệu cục bộ được giữ lại. Sao lưu `data/chat.sqlite3` trước
khi chuyển dữ liệu quan trọng giữa máy.

## Lỗi thường gặp

- **`WSL Node.js 18+ is required`**: cài Node trong WSL, không trỏ
  `GATEWAY_NODE` tới `node.exe` của Windows.
- **`Windows Node.js is required`**: cài Node.js trên Windows theo đường dẫn
  mặc định, rồi chạy lại `./bin/setup` hoặc cập nhật `DESKTOP_NODE` và
  `DESKTOP_ENABLED=1` trong `.env.local`.
- **Không có URL `trycloudflare.com`**: xem `logs/quick-cloudflared.log`, kiểm
  tra mạng rồi chạy `./bin/quick-tunnel` lại.
- **Không kết nối được task**: giữ task đang mở trong Codex Desktop và dùng đúng
  UUID hoặc link `codex://threads/...`; sau đó bấm **Kết nối lại**.
- **Đính kèm file báo thiếu ổ dữ liệu**: đặt `DESKTOP_STAGING_ROOT` tới một thư
  mục chuyên dụng trên ổ `D:` hoặc một data drive khác.

Muốn dùng hostname cố định, cấu hình named tunnel riêng rồi đổi
`TUNNEL_MODE=persistent`. Quick Tunnel vẫn là mặc định của bản clone mới.
