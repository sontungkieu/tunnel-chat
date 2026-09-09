# Prompt bật Tunnel Chat bằng GPT/Codex

Dán nguyên khối dưới đây vào một Codex/ChatGPT agent đang mở tại thư mục vừa
clone. Agent cần có quyền chạy lệnh trong WSL và Windows.

```text
Hãy cài và khởi chạy Tunnel Chat trong repository hiện tại cho workflow Codex
Desktop trên Windows + WSL. Làm việc đến khi có bằng chứng server, gateway và
Cloudflare Quick Tunnel đều chạy được.

Bạn được phép cài dependency ở user scope hoặc bên trong repository, chạy
./bin/setup, sửa .env.local theo môi trường thực tế, khởi động/dừng các process
do repository này quản lý và chạy smoke test. Không dùng sudo hoặc cài package
toàn hệ thống nếu chưa hỏi tôi. Không tạo named/persistent tunnel, không thay đổi
Cloudflare DNS và không commit/push thay đổi cục bộ.

Thực hiện theo thứ tự:

1. Xác nhận đang ở root của tunnel-chat và đọc SETUP.md, README.md cùng các
   script liên quan trước khi sửa cấu hình.
2. Chạy ./bin/setup. Script được phép cài uv và cloudflared vào .tools/ của repo.
   Nếu thiếu WSL Node.js 18+/npm, cài bằng trình quản lý user-level đang có; nếu
   thiếu Windows Node.js thì báo đúng blocker và lệnh cài, không giả vờ Desktop
   bridge đã sẵn sàng.
3. Chạy ./bin/doctor --desktop. Với bản cài mới, bảo đảm .env.local có
   TUNNEL_MODE=quick, DESKTOP_ENABLED=1, DESKTOP_NODE trỏ tới Windows node.exe,
   GATEWAY_NODE trỏ tới Node Linux/WSL và không còn đường dẫn của máy người khác.
   Đặt FILE_TRANSFER_ROOT tới một thư mục dữ liệu riêng phù hợp; mặc định Windows
   là D:\dev\codex\vai. Tạo backup trước khi sửa một .env.local đã có nội dung.
4. Giữ ứng dụng Codex Desktop trên Windows đang mở rồi chạy ./bin/start. Chờ
   Quick Tunnel cấp URL; không đổi sang named tunnel khi Quick Tunnel hoạt động.
5. Kiểm tra HTTP local tại http://127.0.0.1:8787/codex, PID bằng ./bin/doctor,
   file run/quick-cloudflared.url và khả năng truy cập public /codex. Không gửi
   model prompt và không thay đổi task chỉ để smoke test.
6. Tạo launcher bằng các lệnh `./bin/url codex > run/codex-url.txt` và
   `./bin/url files > run/files-url.txt`. Không cat các file này trong tool output
   và không đưa CHAT_ACCESS_TOKEN hoặc URL có #token vào câu trả lời. Nếu clip.exe
   có sẵn, copy launcher Codex vào Windows clipboard; nếu không, chỉ cho tôi biết
   đường dẫn tuyệt đối tới hai file launcher để tôi tự mở.
7. Nói rõ Quick Tunnel URL sẽ đổi sau khi restart. Hướng dẫn tôi mở launcher URL,
   mở task đích trong Codex Desktop, dán codex://threads/<task-id> vào trang và
   bấm Kết nối.

Khi kết thúc, báo ngắn gọn version đã kiểm tra, ba process đang chạy, public
origin không chứa token, đường dẫn file launcher và mọi giới hạn còn lại. Không
in nội dung .env.local, file password, token, cookie hay secret.
```
