# dsh-bridge

Lớp đệm giữa **browser (qua Cloudflare Tunnel + proxy công ty)** và **DSH web** đang chạy ở `127.0.0.1:3080`.

## Vì sao cần

DSH web dùng 2 loại kênh:

| Kênh | Cơ chế | Qua proxy chặn stream |
|---|---|---|
| Static + `/api/*` | HTTP fetch ngắn, có `Content-Length` | ✅ đi được |
| `/api/remote.mux` | **WebSocket sống suốt phiên** (`dsh-api-gateway`: `new WebSocket(remoteStreamUrl())`, **không có fallback HTTP**) | ❌ bị chặn |

Bridge này giữ nguyên kênh thứ nhất, và bọc kênh thứ hai bằng 2 transport song song:

- **native** — pass-through WebSocket thật. Nếu proxy cho phép thì không có gì thay đổi.
- **poll** — thay bằng các HTTP request ngắn (`POST /tx`, `GET /rx`) trả về ngay, không giữ kết nối.

Chế độ `auto` (mặc định): thử native trước, bị chặn thì tự chuyển sang poll và ghi nhớ vào `localStorage`.

## Luồng

```
browser công ty
   |  HTTP ngắn (poll 600ms) + WebSocket native nếu được phép
   v
Cloudflare edge -> cloudflared (service) -> dsh-bridge 127.0.0.1:3090
                                             |  WebSocket thật qua loopback
                                             v
                                          DSH 127.0.0.1:3080
```

## Chạy

```bat
start-bridge.cmd
```

Tự chạy cùng Windows (Task Scheduler, chạy khi đăng nhập):

```powershell
powershell -ExecutionPolicy Bypass -File install-task.ps1        # cài
powershell -ExecutionPolicy Bypass -File install-task.ps1 -Remove # gỡ
```

## Trỏ tunnel về bridge

Trong Cloudflare Zero Trust -> Networks -> Tunnels -> `DSH Tungks2` -> Public Hostname,
sửa Service từ `http://127.0.0.1:3080` thành **`http://127.0.0.1:3090`**.

> Bridge phải chạy trước khi đổi, nếu không link sẽ 502.

## Kiểm tra

Từ máy công ty, mở qua chính link tunnel:

```
https://<hostname>/__dsh_bridge/diag
```

Trang đó đo 4 thứ và kết luận proxy chặn cái gì:

1. POST ngắn 2 KB — proxy có cho request nhỏ không
2. WebSocket — có mở được 101 không
3. Stream 6 giây — proxy có buffer response không (so byte đầu vs byte cuối)
4. Log + stats của bridge

Trạng thái bridge:

```
https://<hostname>/__dsh_bridge/diag/stats
```

## Chọn transport bằng tay

Thêm vào URL (ghi nhớ vào localStorage):

```
?transport=poll     luôn polling
?transport=native   luôn WebSocket thật
?transport=reset    xoá lựa chọn, quay về auto
```

Trong console browser: `__DSH_BRIDGE__.mode()` và `__DSH_BRIDGE__.effective(sock)`.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `3090` | nơi bridge lắng nghe |
| `BRIDGE_UPSTREAM_HOST` / `BRIDGE_UPSTREAM_PORT` | `127.0.0.1` / `3080` | DSH thật |
| `BRIDGE_POLL_MS` | `600` | nhịp poll của client |
| `BRIDGE_OUTBOX_HIGH` / `_LOW` | `1048576` / `262144` | ngưỡng backpressure (byte) |
| `BRIDGE_SESSION_IDLE_MS` | `60000` | dọn session polling bỏ hoang |
| `BRIDGE_MAX_FRAMES` / `_MAX_BYTES` | `200` / `524288` | trần mỗi lần trả poll |

## Backpressure

Nếu browser poll chậm hơn DSH sinh dữ liệu, bridge đệm frame vào outbox.
Khi outbox vượt `BRIDGE_OUTBOX_HIGH`, bridge gọi `ws.pause()` — TCP window đóng lại,
DSH tự dừng đẩy. Xuống dưới `BRIDGE_OUTBOX_LOW` thì `ws.resume()`. Không mất frame, không tràn RAM.

## Điểm cần biết

- Shim chỉ can thiệp URL kết thúc bằng `/api/remote.mux`; mọi WebSocket khác đi nguyên.
- Mux chỉ dùng **text frame** (server đóng socket nếu nhận binary), nên polling không cần mã hoá nhị phân.
- Bridge gửi tiếp nguyên `Host` / `Origin` / `Cookie` của browser xuống DSH. Đây là điều kiện bắt buộc:
  DSH có Host/Origin fence và cookie buộc theo authority. Đổi Host là vỡ đăng nhập.
- Bridge xin upstream `accept-encoding: identity` để chèn script vào HTML; Cloudflare vẫn nén cho browser.

## Chunked upload ảnh/file

DSH upload attachment bằng **một request body duy nhất** tới
`POST /api/session/uploadFileBinary?sessionId=...&name=...` (`content-type: application/octet-stream`),
và việc upload chạy trong một **Web Worker** dựng từ Blob (`dsh-client-file-upload`: body Blob → XMLHttpRequest,
body ReadableStream → fetch). Không sửa DSH thì không chặn được request dài đó.

Cách bridge làm:

1. `ws-shim.js` thay `window.Blob`. Khi DSH tạo Blob chứa source của worker upload
   (nhận diện bằng chuỗi `fileUploadWorker`), shim **chèn `worker-patch.js` lên đầu source đó**.
2. Trong worker, `XMLHttpRequest` (và `fetch` cho body stream) được thay bằng bản có chunking:
   body > ngưỡng thì cắt thành nhiều POST nhỏ qua bridge thay vì một request dài.
3. Bridge nhận từng mảnh vào file tạm (`%TEMP%\\dsh-bridge-<bid>.bin`), rồi **đẩy một lần** xuống DSH
   qua loopback — đoạn bridge → DSH không đi qua proxy nên không bị giới hạn.
4. Cookie/Host/Origin của browser được bridge giữ nguyên khi đẩy xuống DSH
   (worker không gửi cookie trong metadata, nên bridge lấy từ chính request `blob/init`).
   Thiếu bước này sẽ bị 401.

Giao thức nội bộ: `POST /__dsh_bridge/blob/init` → `POST /__dsh_bridge/blob/chunk?bid=&seq=` (tuần tự, có kiểm tra thứ tự)
→ `POST /__dsh_bridge/blob/finish` (trả nguyên response của DSH) → `/blob/abort` khi huỷ. Blob bỏ hoang bị dọn sau 10 phút.

Chỉnh kích thước mảnh: thêm `?chunk=8192` vào URL (ghi nhớ vào localStorage), hoặc `?chunk=reset`.
Mặc định **32768 B**, ngưỡng bắt đầu cắt **262144 B** (nhỏ hơn thì gửi thẳng như cũ).

### Đã kiểm chứng

| Phép thử | Kết quả |
|---|---|
| Blob patch (giả lập window trong Node) | `window.Blob` bị thay; Blob của worker được chèn patch, placeholder thay hết; Blob khác không bị đụng; `instanceof Blob` giữ nguyên |
| Upload 200 000 B qua bridge, 25 mảnh × 8192 B | DSH trả `ok:true`, `bytes: 200000` |
| Toàn vẹn dữ liệu | `attachmentId` của DSH = `sha256:59a1bdeb…594b` **khớp đúng SHA-256 client tự tính** |
| Route upload thật, sessionId sai | DSH trả `session/not-found` (bytes tới nơi, auth đúng) |
| Request nhỏ hơn ngưỡng | đi thẳng như cũ, không qua blob |

Script kiểm tra: `test-upload.cjs` (upload thật), `test-blobpatch.cjs` (Blob patch), `test-blob.cjs` (cả 3 nhánh).

> Lưu ý: DSH nhận `sessionId` **kèm tiền tố** `session-`, ví dụ `session-85b224fe-…`.
> Gửi thiếu tiền tố sẽ bị `session/not-found` dù session đang sống.

## Đăng nhập từ máy khác (không có DevTools)

DSH chặn mọi request bằng **cookie phiên do chính nó ký**. Browser ở máy khác chưa từng có cookie đó
nên mở link chỉ thấy `401 dsh web authentication required` — `?transport=poll` **không** phải đường xác thực.

Đường vào gọn, không cần DevTools và không phải chép URL token dài:

1. Mở `https://<hostname>/__dsh_bridge/login`
2. Nhập **mã PIN** (12 ký tự) — đang nằm ở `.login-key`
3. Bridge tự ký cookie phiên DSH cho đúng authority của hostname rồi `303` về `/`

PIN sinh tự động ở lần chạy đầu (bỏ ký tự dễ lẫn `0/O/1/I`), **giới hạn 5 lần sai / IP / phút**.
Cookie cấp ra sống **30 ngày** — cùng thời hạn DSH tự cấp, và cùng secret ký trong
`~/.dsh/.credentials.yaml` nên sống qua restart DSH.

| Việc | Cách làm |
|---|---|
| Đổi PIN | sửa `.login-key` rồi restart bridge (hoặc đặt env `BRIDGE_LOGIN_KEY=<mã>`) |
| Tắt hẳn | env `BRIDGE_LOGIN_KEY=off` |
| Đăng xuất một browser | xoá cookie `dsh-auth-*` của hostname đó |

> PIN này tương đương quyền truy cập GUI. Cách đúng vẫn là đặt **Cloudflare Access** trước hostname;
> khi đó PIN chỉ còn là lớp thứ hai. File `.login-key` là secret — đừng commit.

## Vá tương thích browser cũ (polyfill)

Bridge tiêm một gói polyfill chạy **trước** mọi bundle của DSH. Danh sách dưới đây lấy từ việc quét
chính các `lib/client.js` của DSH để tìm API hiện đại, không phải đoán:

| API | Cần browser | Thực tế |
|---|---|---|
| `Iterator` + helpers | Chrome/Edge 122, Firefox 131 | PDF.js trong plugin `documentpreview` gọi thẳng global |
| `Promise.withResolvers` | Chrome/Edge 119 | lỗi ở `index.html` dòng 44 |
| `AbortSignal.any` | Chrome/Edge 116 | lỗi trong `api-gateway` → đứt control stream, lặp reconnect |
| `Promise.try` | Chrome/Edge 128 | |
| `URL.parse` | Chrome/Edge 126 | |
| `Array.prototype.findLast / findLastIndex / at` | ≤ 97 | phòng xa |
| `Object.hasOwn`, `String.prototype.replaceAll`, `structuredClone` | ≤ 98 | phòng xa |

Polyfill chỉ chạy khi API vắng mặt, và **cùng gói đó được tiêm vào worker PDF** qua lớp bọc `window.Blob`.
Browser đang dùng ở công ty thiếu cả `AbortSignal.any` lẫn `Promise.withResolvers` → tức là
**cũ hơn Chrome/Edge 116 (8/2023)**.

### Vá `Iterator is not defined`

Plugin `dsh-client-ui-sidebar-documentpreview` nhúng PDF.js, và PDF.js gọi thẳng global **Iterator**
(ES2025) mà không kiểm tra tồn tại — trong bundle tại dòng 3394:

```js
if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join = ...
```

Browser chưa có Iterator (Chrome/Edge < 122, Firefox < 131) ném `ReferenceError: Iterator is not defined`
→ cả bundle không import được → GUI báo **"Failed to load plugins … documentpreview"**.
Cùng đoạn đó còn nằm trong worker PDF (chuỗi nhúng), nên worker cũng chết theo.

`ws-shim.js` nay polyfill `Iterator` trước khi bundle DSH chạy:
`map / filter / take / drop / flatMap / toArray / forEach / some / every / find / reduce / join`,
`Iterator.from`, `Iterator.of`; `Iterator.prototype` trỏ đúng vào `%IteratorPrototype%` thật nên
đoạn polyfill của PDF.js chạy được. Cùng polyfill đó được tiêm vào **worker PDF** qua lớp bọc `window.Blob`.
Polyfill chỉ chạy khi `Iterator` vắng mặt → browser mới không bị ảnh hưởng.

> Chỉ áp dụng cho lưu lượng đi qua bridge (link tunnel). Vào thẳng `http://127.0.0.1:3080` bằng browser cũ
> thì polyfill không tới được — phải nâng cấp browser.
>
> Polyfill là giải pháp tạm: mỗi lần DSH dùng thêm API mới sẽ lại phải vá tiếp. Cách bền là
> cập nhật browser (hoặc dùng bản Chrome/Edge portable mới) cho máy công ty.

## Kết quả chẩn đoán tại công ty (2026-09-17)

Chạy `/__dsh_bridge/diag` từ máy công ty, qua chính link tunnel:

| Phép thử | Kết quả | Kết luận |
|---|---|---|
| POST ngắn 2 KB | 449 ms | đi được |
| **WebSocket** | lỗi sau 1 480 ms | **bị chặn** |
| Stream 6 s | byte đầu 394 ms, hết 6 264 ms | **không buffer** — proxy cho response dài sống |

Chính sách thật của proxy: **chặn protocol upgrade / kết nối dài, nhưng KHÔNG buffer response.**
DSH không dùng SSE cho phiên chat — kênh realtime duy nhất là WebSocket `/api/remote.mux` —
nên đường đi đúng là **transport polling**: shim tự chuyển ngay sau lần lỗi WebSocket đầu tiên
và ghi nhớ vào `localStorage`, các lần load sau vào thẳng polling.

Bằng chứng phía server lúc đó: `wsNative: 1`, `wsNativeBytes: 284` — bridge **đã** nhận upgrade và
chuyển 101 về, tức lỗi nằm ở proxy chứ không phải DSH hay Cloudflare.

Ba thứ được thêm vào trang chẩn đoán để lần sau đo được ngay tại công ty:

- **Transport polling (đường fallback)** — mở session thật, gửi lệnh `$events`, chờ frame `ready`.
  Đây là bằng chứng trực tiếp rằng GUI sẽ chạy được ở công ty.
- **POST 2 MB** — đo trần kích thước body, để biết lớp chunking upload có thật sự cần hay không.
- Dòng **KẾT LUẬN** tự tổng hợp: WebSocket chạy → dùng native; WebSocket chặn + polling chạy → cứ mở GUI.

