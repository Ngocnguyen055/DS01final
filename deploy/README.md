# Triển khai thử nghiệm qua Internet

1. Cài Node.js 22.12+ (app cũng hỗ trợ 20.19+) và clone repository lên máy chủ.
2. Chạy `npm run setup:env` để tạo `.env` với hai secret ngẫu nhiên riêng, sau đó cấu hình URL triển khai.
3. Chạy `npm ci`, `npm run build:web`.
4. Chạy signaling và relay thành hai process độc lập bằng systemd, PM2 hoặc hai terminal.
5. Dùng Caddy theo `Caddyfile.example` để cấp HTTPS/WSS và phục vụ web tĩnh.
6. Mở các cổng 80/443; không cần công khai trực tiếp cổng 4001/4002 khi đã reverse proxy.

Có thể dùng một máy chủ miễn phí hoặc tunnel HTTPS cho buổi thử. Tunnel cần tạo endpoint riêng cho signaling, relay và web. Repository không tự tạo tài khoản và không khẳng định đã triển khai công khai.

TURN tùy chọn qua `VITE_ICE_SERVERS`, xem [mẫu coturn](turnserver.conf.example) và phần [TURN và media](#turn-và-media) bên dưới. Chưa có bằng chứng TURN public.

## Chạy bằng Docker Compose

Tại root repo, tạo/chuẩn bị `.env` bằng `node scripts/init-env.mjs` (không in secret, giữ secret thật đã có). Sau đó:

```powershell
docker compose --env-file .env -f deploy/compose.yml up --build -d
docker compose --env-file .env -f deploy/compose.yml logs -f signaling relay relay-backup
```

Mở `http://localhost:8080`: signaling 4001, relay 4002, backup 4003. Snapshot signaling nằm trong named volume, không xóa volume khi kiểm tra restart. Lệnh `down -v` xóa registry và quyền sở hữu ID, không dùng nó làm phép thử phục hồi.

Build VITE_* với URL máy chủ mà browser truy cập được; localhost chỉ phù hợp cùng máy. Compose lab chưa tự cấu hình TLS/public DNS. Khi dùng web container phía sau Caddy host, block web có thể `reverse_proxy 127.0.0.1:8080` thay cho static root. Caddy reverse_proxy hỗ trợ WebSocket upgrade theo [tài liệu chính thức](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Với cấu hình public, đặt NODE_ENV=production và secret ngẫu nhiên thật; server từ chối secret mẫu. Không trỏ hai signaling writer vào cùng state file. Mount/persist `.data` đúng quyền node; sao lưu registry trước khi thay đổi môi trường.

Docker đặt `DS01_DATA_DIR=/app/.data`, `DS01_RUNTIME_DIR=/app/.runtime` và chạy bằng user `node`; named volume giữ tài khoản, khóa/vault, bản sao lịch sử có mã hóa và nhóm qua redeploy. Khác với Docker, launcher Node trên máy chủ mặc định dùng `../DS01-runtime/data/`. Khi chuyển từ chạy Node sang container, dừng signaling cũ rồi nhập kho dữ liệu vào volume; cấu hình `ACCOUNT_STATE_PATH` đúng tên registry đang dùng và giữ toàn bộ `account-data/`. Không khởi động hai writer trên cùng kho. Reverse proxy cho domain signaling phải chuyển tiếp cả `/account/*`, ngoài Socket.IO và `/health`.

Docker chưa được chạy trong môi trường kiểm tra này; cần tự build/run và lưu log trước khi đánh dấu nghiệm thu Docker/WAN đạt.

## Cluster và triển khai lại

Compose hiện lưu signaling, relay chính và relay dự phòng trên ba named volume độc lập. Relay gửi dữ liệu replica qua HTTP HMAC có nonce và timestamp, không chia sẻ volume. `RELAY_CLUSTER_URLS` chứa URL canonical mà browser sử dụng; `RELAY_CLUSTER_ROUTES` chỉ ánh xạ các URL đó sang địa chỉ nội bộ khi trao đổi server-server. Hai relay phải cấu hình cùng tập URL để hash ring DHT nhất quán. HTTPS reverse proxy và secret vẫn cần được cấu hình trước khi công khai.

Với hai máy chủ thật, thay `relay`/`relay-backup` trong routes bằng địa chỉ mạng nội bộ hoặc bỏ routes để dùng URL HTTPS public. Không dùng chung file `.data/relay.json` giữa hai process. Giữ state và khóa đăng nhập khi redeploy. Cluster sao chép bất đồng bộ nên có cửa sổ mất dữ liệu giữa ghi local và replication; hai relay trên cùng host không bảo vệ khi cả host hỏng.

Để redeploy từ mã nguồn, giữ nguyên `.env`/volumes, cập nhật checkout đã được nhóm duyệt rồi chạy lại `docker compose --env-file .env -f deploy/compose.yml up --build -d --wait`. Sao lưu state trước khi đổi phiên bản có thay đổi schema. Không xóa volume để thử recovery.

Để ứng cử super-peer, đặt `SUPER_PEER_ID=user_<username>` cho relay chính hoặc `SUPER_PEER_BACKUP_ID` cho relay dự phòng, dùng đúng Peer ID hiện trên giao diện. Relay đồng hành phải có URL HTTPS public nằm trong cluster; người dùng đó đăng nhập rồi nhập URL ở `Kết nối nâng cao` và bấm ứng cử. Kiểm tra `ELECTION_CANDIDATE`, `ELECTION_RESULT` và peer-to-connection mapping trong `/health`/log. `ALLOW_LOCAL_SUPERPEERS=1` chỉ cho lab local, không chứng minh public reachability. Election dựa lease và hội tụ sau replica merge, có thể có leader tạm khác nhau khi phân vùng.

## TURN và media

Coturn chạy độc lập với application relay. Cấu hình `turnserver.conf.example`, thay realm/credentials, đặt external IP đúng nếu server ở sau NAT, giới hạn cổng UDP relay theo firewall thực tế và giới hạn quota người dùng. Cấu hình browser bằng `VITE_ICE_SERVERS`, ví dụ JSON có `stun:` và `turn:turn.example.org:3478?transport=udp` hoặc `turns:` khi đã cấu hình chứng chỉ. Mẫu cấu hình là lab với thông tin đăng nhập dùng cho một buổi demo; mọi `VITE_*` xuất hiện trong bundle browser, không đặt secret máy chủ hoặc khóa ký vào đó. TURN credentials dài hạn công khai có thể bị lạm dụng; dùng tài khoản ngắn hạn/quota khi triển khai thật. `demo:public` đọc cấu hình ICE và owner Peer ID từ `.env` hoặc biến môi trường, đồng thời tự tạo URL/secret riêng cho phiên.

Để có bằng chứng TURN, kiểm tra candidate-pair được chọn có candidate type `relay`, nhận được chat/media và đối chiếu bộ đếm application relay. `npm run test:browser:advanced` kiểm tra giao thức STUN/TURN và RTP thật trên loopback bằng process TURN lab riêng. Kết quả này không thay thế demo hai mạng Internet/NAT. Lab không tự mở firewall, cài Docker hay khẳng định có TURN public.

## Bật GitHub Actions

1. Nhóm tự commit/push các file đã kiểm tra. Workflow `DS01 CI` tự chạy trên push/PR; mở **Actions** để xem từng bước và tải Artifacts.
2. Vào **Settings → Secrets and variables → Actions → Variables**, đặt `VITE_SIGNAL_URL`, `VITE_RELAY_URL`, `VITE_RELAY_URLS` thành URL HTTPS thật cho bản web phát hành. Các URL phải khớp `PUBLIC_RELAY_URL` và `PUBLIC_RELAY_BACKUP_URL` của server.
3. Vào **Settings → Environments**, tạo `production`, cấu hình người duyệt nếu gói GitHub hỗ trợ. Thêm secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; variable `DEPLOY_PATH`, ví dụ `/opt/ds01`. Known-hosts phải lấy fingerprint qua kênh tin cậy; workflow không dùng `StrictHostKeyChecking=no`.
4. Trên server Linux đã có Docker Engine và Compose plugin, chuẩn bị thư mục deploy và `.env` với secret ngẫu nhiên, URL production đúng và quyền truy cập chỉ dành cho tài khoản vận hành. Khi GHCR private, đăng nhập registry trên server bằng token chỉ có quyền đọc package. Cấu hình Caddy HTTPS theo mẫu; repository không tự đăng ký domain hoặc cấp máy chủ.
5. Mở **Actions → DS01 manual delivery → Run workflow** ở revision muốn phát hành. CI phải qua toàn bộ mới publish image. Để thử registry trước, giữ `deploy=false`. Khi server đã chuẩn bị, chọn `deploy=true`; environment gate được áp dụng trước bước SSH.

Workflow publish app/web với tag `sha-<commit>`, gửi `compose.images.yml` và script redeploy đến server, pull image, chạy `up --wait` và kiểm tra health. Script chỉ cập nhật `current-release.env` sau khi thành công; nếu update lỗi, phục hồi image trong file đó. Nếu lần deploy đầu chưa có release trước thì cần xử lý lỗi từ log. Rollback image không đảo ngược dữ liệu hay migration; luôn sao lưu state trước thay đổi schema. Có thể redeploy một revision đã publish bằng `bash deploy-remote.sh ghcr.io/<owner>/<repo> <commit-sha>` trong thư mục server.

Pipeline cấu hình được kiểm tra YAML tại local; build/run Docker và SSH deployment chưa được chạy trên máy hiện tại vì chưa có Docker/server public. Không ghi kết quả CI/CD “đã triển khai” trước khi nhóm tự push và có Actions run thành công.
