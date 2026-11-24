# DS01 P2P Chat

Repository độc lập cho bài tập Hệ thống phân tán DS01. Hệ thống gồm web peer, signaling server và application relay. Peer luôn thử WebRTC DataChannel trước; khi DIRECT không mở hoặc mất ACK, peer tự chuyển sang relay Socket.IO.

Giao diện có chat cá nhân/nhóm, trạng thái từng receiver, retry cùng Message ID, chặn peer, file theo chunk có SHA-256 và lịch sử cục bộ. Các phần nâng cao gồm pool relay với failover và chọn theo RTT/tải, mailbox offline được sao chép, E2EE, discovery DHT, bầu super-peer có relay đồng hành và gọi thoại/video WebRTC. Xem bảng phạm vi và cách demo bên dưới.

## Thành phần

```text
src/
├── web-peer/       Giao diện peer, log và localStorage
├── shared/         Protocol, PeerClient, WebRTC, ACK/retry/dedup
├── signaling/      Registration, discovery, heartbeat, SDP/ICE, nhóm
└── relay/          Xác thực, ánh xạ Peer ID và chuyển tiếp RELAY
```

- Signaling chạy độc lập ở cổng `4001`: registration, discovery, SDP/ICE, nhóm và xác thực. Cùng tiến trình có API sao lưu tài khoản `/account/vault`, `/account/backup`; API này lưu bản sao mã hóa do chủ tài khoản gửi lên, không chuyển tin nhắn tới peer khác.
- Relay chạy độc lập ở cổng `4002` và chỉ chuyển chat envelope khi mode là `RELAY`.
- Web peer chạy ở cổng Vite mặc định `5173`.
- Lịch sử web lưu trong localStorage theo Peer ID, file và khóa hoạt động trong IndexedDB. Chế độ tài khoản có thêm bản sao mã hóa để khôi phục trên thiết bị hoặc địa chỉ web mới; chế độ Peer ID/DHT giữ dữ liệu tại thiết bị.
- Demo với ID `peer-a`, `peer-b`, `peer-c` không cần MongoDB hoặc Mobile API.

## Yêu cầu

- Node.js `^20.19.0 || >=22.12.0`; dùng Node 22.12+ để chạy cả browser QA.
- npm.
- Chrome, Edge hoặc Firefox có WebRTC.

## Cài đặt

```powershell
git clone https://github.com/Ngocnguyen055/DS01.git
cd DS01
npm.cmd ci
npm.cmd run setup:env
```

Không commit `.env`. `setup:env` tạo hai secret ngẫu nhiên riêng, giữ nguyên secret hợp lệ đã cấu hình. Signaling và relay yêu cầu secret tối thiểu 32 ký tự; signaling từ chối dùng chung `JWT_SECRET` và `PEER_SECRET`. Các URL local mặc định đã trỏ tới localhost.

## Chạy local

Có thể khởi động toàn bộ bản local bằng một lệnh:

```powershell
npm.cmd run demo:local
```

Lệnh in URL web và dashboard, chạy signaling cùng hai relay thành các tiến trình riêng. Đây là bản localhost; dùng `demo:public` ở phần dưới để mở từ thiết bị khác qua Internet. Chạy lại cùng lệnh khi demo đang hoạt động sẽ in lại URL của phiên hiện tại. Muốn đổi giữa local và public, nhấn Ctrl+C ở terminal đang chạy trước.

Local, public và lệnh chạy riêng từng service dùng chung `../DS01-runtime/data/`. Với checkout `F:\Downloads\DS01`, đây là `F:\Downloads\DS01-runtime\data`; không dùng ổ C cho dữ liệu demo. `DS01_RUNTIME_DIR` đổi thư mục runtime; `DS01_DATA_DIR` tùy chọn đổi riêng nơi lưu dữ liệu lâu dài.

| Vị trí                                                 | Dữ liệu                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `data/accounts.json`                                   | Tài khoản, hash mật khẩu, phiên đăng nhập                                  |
| `data/signaling.json`, `data/signaling.json.keys.json` | Nhóm, đăng ký kỹ thuật, khóa công khai                                     |
| `data/account-data/`                                   | Khóa khôi phục được mã hóa bằng mật khẩu và bản sao lịch sử/file có mã hóa |
| `data/relay-primary.json`, `data/relay-backup.json`    | Mailbox và trạng thái từng relay                                           |
| `data/service-secrets.json`                            | Secret demo được giữ qua lần chạy nếu chưa cấu hình trong `.env`           |
| `ds01-public-demo-*/`                                  | Bản build, log và thông tin của mỗi lần chạy; không phải kho tài khoản     |
| `tmp/`, `browser-*/`                                   | Bundle tạm và kiểm thử tách biệt dữ liệu thật                              |

Lần chạy đầu tự nhập tài khoản/nhóm từ `.data` cũ và các phiên public cũ, giữ nguyên hash mật khẩu. File gốc được giữ, có thêm bản sao trong `data/migration-backup/`; không cần tạo lại tài khoản. Khi trùng username nhưng khác mật khẩu, dữ liệu canonical hoặc local cũ được ưu tiên và console liệt kê tên cần kiểm tra. Không xóa `data/` khi dọn log; sao lưu cả thư mục này trước khi chuyển máy chủ. `demo:check` và `demo:public:check` sử dụng kho kiểm tra riêng.

Khi cần chạy riêng từng thành phần để phát triển, mở ba terminal tại thư mục repository.

Terminal 1:

```powershell
npm.cmd run dev:signaling
```

Terminal 2:

```powershell
npm.cmd run dev:relay
```

Terminal 3:

```powershell
npm.cmd run dev:web
```

Mở `http://localhost:5173` bằng ba browser profile riêng. Chọn **Tạo tài khoản**, tạo `alice`, `bob`, `carol` với tên hiển thị và mật khẩu tối thiểu 10 ký tự. Sau đó đăng nhập: ứng dụng tự đăng ký peer, kết nối và đưa vào chat. Peer ID lần lượt là `user_alice`, `user_bob`, `user_carol`.

F5 trong cùng tab tự khôi phục phiên. Nút **Đăng xuất** thu hồi phiên và đóng kết nối. Mỗi tài khoản có tối đa một peer online; khi chuyển máy, chọn **Chuyển phiên sang thiết bị này** để đăng xuất phiên cũ sau khi xác thực mật khẩu. Đăng nhập bằng cùng mật khẩu sẽ mở lại cùng khóa E2EE và tải bản sao lịch sử/file gần nhất. Trong **Tình trạng kết nối → Kết nối nâng cao**, chờ **Đã đồng bộ** trước khi chuyển máy hoặc có thể bấm **Đồng bộ ngay**. Mất mạng sao lưu không xóa dữ liệu cục bộ; ứng dụng hiển thị **Chờ đồng bộ** và thử lại có giãn thời gian.

Với tài khoản từ phiên bản cũ, khóa cũ không xuất được. Đăng nhập tại profile/URL cũ giúp ký xác nhận chuyển khóa; nếu không còn truy cập được thì cần xác nhận tạo khóa khôi phục một lần và peer liên hệ phải đối chiếu khóa khi được yêu cầu. Lịch sử chưa từng sao lưu vẫn ở origin/profile cũ: xuất JSON ở đó và chọn **Nhập lịch sử từ phiên bản cũ** tại giao diện mới. Không thể tự lấy dữ liệu chưa sao lưu từ một địa chỉ web khác.

Kiểm tra khôi phục tài khoản, chuyển phiên và lịch sử bằng `npm.cmd run test:browser:accounts`.

Các kịch bản bên dưới dùng ID demo `peer-a/peer-b/peer-c`: chọn **Chế độ thử nghiệm** ở cuối biểu mẫu để kết nối bằng Peer ID hoặc mở lịch sử demo cũ. Với tài khoản, thay các ID đó bằng Peer ID thực tế `user_...`. Log và checkbox relay nằm trong **Tình trạng kết nối**; quản lý nhóm trong **Thông tin hội thoại**.

## Demo nhanh

```powershell
npm.cmd run demo:public
```

Lệnh khởi động signaling, relay chính và relay dự phòng thành các tiến trình riêng, mở bốn URL HTTPS tạm và in thêm **Dashboard (this computer only)**. Mở dashboard bằng trình duyệt trên máy server để xem URL, PID và log cả hai relay; lọc theo Message ID, không cần lệnh xem process hay cổng. Web bật E2EE và chọn relay theo RTT/tải. Hai relay trao đổi snapshot qua HTTP có xác thực; mỗi relay có file state riêng trong `../DS01-runtime/`. Ctrl+C dừng phiên và các URL tạm.

Khi một relay hoặc tunnel của relay bị dừng sau khởi tạo, script giữ web, signaling và relay còn lại chạy để peer có thể chuyển đường truyền. Lần gửi chờ DIRECT tối đa 10 giây rồi dùng RELAY; ICE được tiếp tục thử nền trong tổng thời gian tối đa 30 giây và có thể chuyển các tin tiếp theo về DIRECT khi kết nối mở. Lỗi chắc chắn hoặc đóng DataChannel chuyển RELAY sớm hơn. Kênh đã mở được giữ lại khi truy vấn signaling chỉ bị timeout; phản hồi từ chối quyền vẫn được xử lý riêng. Khi DataChannel mở, peer đợi thống kê ICE sẵn sàng rồi xác định DIRECT hoặc TURN từ cặp candidate thực sự được chọn. Nếu kênh từng hoạt động bị gián đoạn, peer dùng relay trong lúc chờ 1,5 giây, thử ICE restart một lần và giới hạn phục hồi 15 giây. Nút ngắt kênh trực tiếp vẫn đóng thật và không tự phục hồi trong lần thử đó.

Đối chiếu 12 bước bắt buộc của mục 5.10:

1. Đợi kiểm tra public endpoint hoàn tất. Tunnel làm các service trên máy chạy demo truy cập được qua Internet; URL chỉ sống trong phiên. Nếu dùng server/domain thường trực, xem cấu hình `deploy/`.
2. Mở URL **Web** trên ba thiết bị hoặc ba browser profile riêng, đăng nhập A/B/C. Tiêu đề tab hiển thị tên và Peer ID để nhận diện trong trình quản lý tác vụ của trình duyệt.
3. Xác nhận A/B/C xuất hiện online với đúng tên và ID.
4. A/B ở mạng cho phép WebRTC trực tiếp: tắt ưu tiên relay, A chọn B rồi gửi; chờ nhãn `DIRECT` và xác nhận đã nhận.
5. Mở **Tình trạng kết nối** ở A và B: lấy `DIRECT SEND`/`DIRECT RECEIVE` cùng Message ID. Trong dashboard lọc ID đó, xác nhận relay đang chạy, không có `FORWARD`; `/health` cũng có bộ đếm chuyển tiếp.
6. Cho C dùng 4G, A dùng Wi-Fi; giữ ưu tiên relay tắt. Cần quan sát DIRECT thất bại hoặc timeout rồi tin vẫn đến bằng RELAY. Khác mạng vẫn có thể kết nối DIRECT; nếu vậy chưa chứng minh trường hợp bị chặn. Cần mạng/firewall thực sự chặn đường trực tiếp hoặc VM/Docker network cô lập. Checkbox ưu tiên relay chỉ kiểm tra đường RELAY, không chứng minh NAT.
7. Đối chiếu `RELAY SEND` tại nguồn, `[relay] FORWARD` trong dashboard và `RELAY RECEIVE` tại đích với cùng Message ID; xuất log peer và giữ log server của phiên.
8. Tạo nhóm gồm A/B/C, mỗi người gửi ít nhất một tin và xác nhận các thành viên nhận đủ.
9. B/C gửi gần như đồng thời; kiểm tra A/B/C đều có đủ hai tin, không trùng; log có timestamp và ID để đối chiếu.
10. Trên Chrome của C mở trình quản lý tác vụ bằng **Shift+Esc**, chọn renderer/tab có Peer ID C rồi **Kết thúc quy trình**. Không bấm Đăng xuất. A/B phải cập nhật C offline; giữ log DISCONNECT/TIMEOUT. Dùng profile riêng để lỗi renderer C không làm dừng A/B.
11. Khi A/B đang DIRECT, A mở **Tình trạng kết nối** → **Ngắt kênh trực tiếp với B**. Thao tác đóng PeerConnection/DataChannel thật của A–B, giữ signaling/relay và các peer khác hoạt động. Để ưu tiên relay tắt rồi gửi tin tiếp: hệ thống tự fallback sang RELAY; đối chiếu log hai peer và server. Đây là kiểm tra lỗi đường trực tiếp, không phải bằng chứng NAT của bước 6.
12. Tải lại tab đã crash bằng cùng profile/thiết bị. Phiên còn hạn phải khôi phục đúng Peer ID, lịch sử cục bộ và nhóm; A/B thấy peer online lại. Nếu đã đóng tab làm mất sessionStorage thì đăng nhập lại cùng tài khoản. Để thử đổi thiết bị/profile, đợi đồng bộ xong, đăng nhập cùng tài khoản và mật khẩu tại profile mới rồi chọn chuyển phiên nếu phiên cũ vẫn online; kiểm tra lịch sử và tải file đã nhận.

Để kiểm tra tự động URL public rồi dừng toàn bộ dịch vụ/tunnel:

```powershell
npm.cmd run demo:public:check
```

Lệnh này xác nhận endpoint và Socket.IO qua HTTPS public, chưa chứng minh ba mạng, NAT hay DIRECT. Tránh gán kết quả local hoặc checkbox relay thành bằng chứng WAN.

## Kiểm tra tự động

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build:web
npm.cmd run test:browser
npm.cmd run test:browser:accounts
```

Bộ test kiểm tra protocol, ba peer, Peer ID trùng, heartbeat/discovery, group version conflict, relay routing, sender giả, body quá kích thước, ACK, retry, chống trùng và fallback bằng DataChannel mô phỏng không mở.

Vitest kiểm tra protocol/integration/hồi quy. `test:browser` dùng ba browser context, WebRTC thật, file/IndexedDB, crash renderer peer, phá DIRECT, restart signaling và failover relay trên các process local riêng. Script in thư mục bằng chứng dưới `../DS01-runtime/browser-smoke-*`: ảnh, log server đầy đủ, `path-proof.json`, `mandatory-scenarios.json`, độ trễ và ma trận tải. Báo cáo ghi rõ kịch bản nào chỉ được kiểm chứng local và kịch bản Internet/NAT còn thiếu. Cần Chromium đã cài (có thể đặt `CHROME_PATH`); script chỉ dùng profile/dịch vụ tạm. Internet/NAT vẫn cần chạy trên hai mạng hoặc mạng mô phỏng cô lập theo đề và lưu bằng chứng riêng.

## Đo relay

Khởi động signaling và relay rồi chạy:

```powershell
npm.cmd run benchmark:relay
```

Script gửi 100 envelope RELAY tuần tự và in `p50`, `p95`, `max`. Ghi rõ máy, mạng, ngày giờ và commit khi dùng kết quả trong báo cáo.

Đo tải nhiều peer: `npm.cmd run load:relay -- --peers 20 --messages 10 --concurrency 8`. Phép đo headless này không đo ACK ứng dụng hoặc WebRTC.

## Triển khai Internet

1. Chạy signaling và relay thành hai process riêng.
2. Dùng HTTPS/WSS reverse proxy theo [deploy/Caddyfile.example](deploy/Caddyfile.example).
3. Điền URL công khai vào `.env` trước khi build web:

```env
VITE_SIGNAL_URL=https://signal.example.org
VITE_RELAY_URL=https://relay.example.org
PUBLIC_SIGNAL_URL=https://signal.example.org
PUBLIC_RELAY_URL=https://relay.example.org
```

4. Chạy `npm.cmd run build:web` và phục vụ `src/web-peer/dist`.
5. Dùng ít nhất hai mạng, ví dụ Wi-Fi và 4G, để kiểm tra NAT và fallback thực tế.

## Giới hạn đã xác định

- STUN mặc định là `stun:stun.l.google.com:19302`. Dùng `VITE_ICE_SERVERS` để chỉ định danh sách STUN/TURN khác. Có mẫu coturn, chưa xác minh một TURN public. Nếu cặp ICE được chọn dùng relay candidate, giao diện ghi `TURN`.
- Relay Socket.IO là relay tầng ứng dụng, không phải TURN.
- Mailbox lưu tối đa 500 envelope chưa xác nhận trên mỗi relay, TTL 24 giờ. File chunk không được giữ cho peer offline. Trạng thái `queued` chỉ xác nhận relay đã lưu bền vững, chưa phải người nhận đã nhận. Hết hạn mà chưa có ACK thì peer báo chưa xác nhận, ghi `DELIVERY_ERROR` và cho retry cùng ID; deadline được lưu qua reload. ACK hợp lệ đến muộn vẫn có thể xác nhận tin.
- CLI signaling mặc định lưu trạng thái trong `../DS01-runtime/data/`. Launcher khóa kho trạng thái để tránh hai signaling writer, tự nhận biết khóa của PID đã dừng. Chưa có replication/failover signaling; Docker giữ dữ liệu trong volume riêng `/app/.data`.
- Có failover tối đa bốn application relay. Mailbox và lease ứng viên được sao chép bất đồng bộ qua HTTP HMAC, không dùng chung file/volume. ACK tombstone thắng bản mail cũ khi merge. Tin mới chỉ được một relay ghi nhận có thể mất nếu relay đó hỏng trước khi sao chép; đây không phải quorum hay đồng thuận mạnh.
- Sequence/session được khôi phục, kết hợp logical time và merge thứ tự theo sender; không total order toàn hệ thống.
- Giữ 1000 dòng lịch sử và 10000 khóa dedup mỗi peer. File cá nhân và nhóm tối đa 20 MiB, lưu IndexedDB; người nhận cần trực tuyến. Chưa resume file qua restart. Bản sao tài khoản có ngân sách tối đa 8 MiB dữ liệu file; file lớn vẫn nằm trên thiết bị đã gửi hoặc nhận.
- Web mặc định E2EE: ECDH P-256, HKDF, AES-256-GCM và HMAC cho danh tính sự kiện. Nội dung text, file, ACK được mã hóa; relay vẫn thấy thông tin định tuyến. Khóa đang dùng không extract được, lưu trong IndexedDB. Chế độ tài khoản giữ thêm vault mã hóa bằng mật khẩu với PBKDF2-SHA256 600.000 vòng, AES-GCM và khóa đồng bộ riêng; server không giữ mật khẩu/khóa riêng dạng rõ. Bản sao tối đa 16 MiB trước mã hóa, gồm tối đa 1000 dòng và file tham chiếu còn có trên thiết bị. Đồng bộ dùng version để chống ghi đè bản mới, merge theo Message ID và tombstone xóa tin. Không có khôi phục mật khẩu, đồng bộ nhiều thiết bị online đồng thời hay replication cho kho tài khoản; mất mật khẩu và mọi bản khóa đang dùng sẽ mất khả năng mở vault. Xác minh khóa lần đầu vẫn cần tin cậy signaling hoặc đối chiếu ngoài kênh.
- Adapter nhóm dự án và block tài khoản được giữ để mở rộng, nhưng cần Mobile API bên ngoài khi dùng Peer ID tài khoản Mongo 24 ký tự hex.

## Phạm vi nâng cao 5.11 và cách kiểm chứng

| Tính năng            | Hiện thực và cách kiểm chứng                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nhiều relay          | Hai relay độc lập trong `demo:public` và Compose; xem hai PID, hai `/health` và log trên dashboard.                                                                                                                                                                                                                                                                                                                                             |
| Chọn theo độ trễ/tải | `Tình trạng kết nối` → `Kết nối nâng cao`: RTT EWMA, số kết nối, số tin chờ và điểm chọn. Điểm = RTT + 0,25 × kết nối + 2 × tin chờ; ưu tiên relay hiện tại 10% để giảm dao động.                                                                                                                                                                                                                                                               |
| Failover             | Giữ peer nối cả hai relay, dừng relay chính bằng trình quản lý tiến trình rồi gửi tiếp. Log có relay mới và ACK từ receiver. `test:browser` cũng kiểm tra tình huống này.                                                                                                                                                                                                                                                                       |
| Bầu super-peer       | Peer chạy một relay đồng hành có `SUPER_PEER_ID` trùng Peer ID, URL HTTPS nằm trong cluster. Nhập URL ở bảng nâng cao và ứng cử. Cluster thực hiện HTTP probe có nonce, kiểm tra chủ sở hữu rồi bầu Peer ID lớn nhất theo thứ tự ký tự trong các lease còn hạn. Lease 45 giây, SDK gia hạn 10 giây. Có thể có leader tạm khác nhau khi phân vùng; không phải Raft. Tab trình duyệt riêng lẻ không mở cổng server.                               |
| Replication          | Hai snapshot độc lập; chu kỳ pull mặc định 2 giây, Lamport/version và delete-wins cho mailbox. Chờ log `REPLICA_MERGE` trước khi dừng relay để chứng minh bản sao đã nhận tin.                                                                                                                                                                                                                                                                  |
| Store-and-forward    | A/B đã công bố khóa; đóng B, A gửi và thấy `Relay đã lưu`. B trở lại cùng profile, nhận đúng một bản, A chuyển `Đã nhận` sau ACK. Có test A cũng restart và relay chính hỏng sau replication.                                                                                                                                                                                                                                                   |
| E2EE                 | Xem fingerprint thiết bị trong bảng nâng cao. Relay chỉ chuyển `sealed`; snapshot không có nội dung chat/file. Khóa tài khoản được ghim tại signaling và từng peer. SDK cho phép plaintext khi `encryption:false` để chạy benchmark tương thích; web dùng E2EE mặc định.                                                                                                                                                                        |
| DHT                  | Đăng xuất → `Chế độ thử nghiệm` → nhập tên → `Kết nối bằng DHT`. ID tự dẫn xuất từ khóa ký. Hai replica theo consistent-hash ring chứa bản đăng ký ký số; có thể dừng signaling và vẫn discovery/chat/file/gọi. DHT là prototype với danh sách relay cấu hình sẵn, không phải Kademlia; chưa có nhóm hoặc tài khoản trong chế độ này. Lease online 60 giây; khóa ký được giữ thêm hai ngày để mở mail offline.                                  |
| File                 | Nút `+` trong chat cá nhân hoặc nhóm, tối đa 20 MiB. Chunk có ACK, giới hạn bộ nhớ, SHA-256 và lưu IndexedDB; E2EE áp dụng cả bytes và metadata file bên trong envelope. Theo dõi kết quả riêng từng người nhận; chưa resume qua restart hoặc gửi chunk cho peer offline.                                                                                                                                                                       |
| STUN                 | Cấu hình `VITE_ICE_SERVERS`; ICE tự thu thập và thử candidate. STUN không bảo đảm vượt mọi NAT. Lab kiểm tra binding request thật; cần hai mạng để kết luận NAT Internet.                                                                                                                                                                                                                                                                       |
| WebRTC/TURN          | DataChannel ưu tiên kết nối trực tiếp; candidate được chọn có `relay` thì hiển thị `TURN`. TURN khác application relay Socket.IO. `test:browser:advanced` buộc TURN UDP thật trên loopback và kiểm tra `/health` của application relay không tăng FORWARD.                                                                                                                                                                                      |
| Thoại/video          | Chat cá nhân và nhóm có gọi thoại/video; chỉ thu mic/camera sau thao tác chấp nhận hoặc chủ động tham gia. WebRTC dùng DIRECT/TURN; khi ICE thất bại, có fallback media mã hóa qua application relay bằng frame ứng dụng riêng, không phải chuyển tiếp RTP. Có mute, tắt camera, từ chối, kết thúc, timeout và dọn media tracks. Ngoài localhost cần HTTPS và quyền thiết bị. Kiểm chứng bằng `test:browser:advanced` và `test:browser:groups`. |
| Tải nhiều peer       | `test:browser` chạy ma trận 3/20/50/100 peer; `load:relay` cho phép 3–100 peer, tối đa 50 worker. Kiểm tra đúng receiver, envelope nguyên vẹn, throughput, p50/p95, tỷ lệ thành công và bytes payload. Đây là tải Socket.IO headless, không đo chi phí browser/E2EE/ACK lưu lịch sử.                                                                                                                                                            |

Để chạy lab nâng cao bằng Chrome thật, dùng `npm.cmd run test:browser:advanced`. Lab tạo STUN/TURN riêng chỉ ở loopback, thông tin đăng nhập ngẫu nhiên và camera/mic giả; không cần cấp quyền thiết bị thật. Cờ cho phép loopback ICE chỉ dùng trong kiểm thử. Mẫu coturn trong `deploy/` dành cho cấu hình máy chủ thật, không dùng node-turn lab làm TURN public.

## Kiểm thử và đánh giá mục 9

```powershell
npm.cmd run evaluate
npm.cmd run test:browser
npm.cmd run test:browser:advanced
```

`evaluate` chạy toàn bộ Vitest, ánh xạ tên ca kiểm thử vào nhóm yêu cầu và thất bại nếu dưới 8 functional, 2 concurrency, 2 fault/recovery hoặc 2 security. Ma trận hiện ánh xạ 8/3/3/3 ca; không coi số lượng test là bằng chứng mọi điều kiện WAN đã đạt. Kết quả JSON và log nằm ngoài repository ở `../DS01-runtime/evaluation-*`.

Các xung đột được kiểm tra gồm đăng ký cùng Peer ID, gửi hai chiều/gửi nhóm gần đồng thời, ID trùng nội dung khác và merge replica trái thứ tự. Phục hồi gồm storage failure, DIRECT hỏng, relay không trả lời/dừng, peer crash/restart, signaling restart và offline mailbox. Bảo mật gồm giả sender/token, quyền nhóm bị thu hồi, format/kích thước, ciphertext bị sửa, khóa thay đổi và replay HTTP cluster.

`test:browser` ghi độ trễ có application ACK, thời gian phát hiện offline/chuyển relay, file có SHA-256 và ma trận tải. `test:browser:advanced` lưu candidate-pair, RTP audio/video, thời gian nhận qua TURN và khôi phục mailbox. Các số đo được tạo mỗi lần chạy, không lấy số liệu ví dụ làm kết quả thực nghiệm. Phân biệt localhost, URL public truy cập được và giao tiếp giữa hai mạng/NAT thực tế khi báo cáo.

## Bàn giao mục 10

Repository hiện có `README.md`, `src/`, `deploy/`, `tests/`, `scripts/` và `.env.example`. Báo cáo (`.docx`/`.pdf`) và slide sẽ được bổ sung vào `docs/` sau; thư mục này chỉ dành cho hai loại tài liệu nộp môn học.

| GitHub thành viên xuất hiện trong lịch sử local | Họ tên / MSSV                       | Phần việc thực tế                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namtran205                                      | Nam — bổ sung họ tên đầy đủ / MSSV  | B2: WebRTC, NAT, STUN/TURN; B4: giao thức, ACK/retry/dedup, thứ tự tin; N2: replication và mailbox; N3: bầu super-peer; N7: thoại/video; D1: triển khai, Docker và CI/CD. |
| Ngocnguyen055                                   | Ngọc — bổ sung họ tên đầy đủ / MSSV | B5: chat nhóm, membership/OCC; B6: giao diện và lịch sử cục bộ; N4: E2EE và quản lý khóa; N5: DHT discovery; biên tập báo cáo chung.                                      |
| hong0110                                        | Hồng — bổ sung họ tên đầy đủ / MSSV | B1: signaling, discovery, tài khoản; B3: relay và định tuyến an toàn; N1: đa relay, lựa chọn và failover; N6: truyền file; N8: workload và đo hiệu năng.                  |

Phân công trên theo bảng công việc của nhóm. Cả ba cùng thực hiện C1 (phân tích, thiết kế), C2 (tích hợp, kiểm thử, demo) và C3 (viết phần kỹ thuật, chuẩn bị trình bày); Ngọc biên tập báo cáo. Phân công không thay thế kết quả nghiệm thu: WAN/NAT, Docker/server, Actions và báo cáo còn cần kiểm chứng hoặc hoàn thiện như các giới hạn nêu trên.

Nhóm cần bổ sung họ tên đầy đủ/MSSV; mỗi người commit bằng Git identity của mình và kiểm tra email liên kết GitHub. Tag/release cuối như `v1.0.0` chỉ tạo sau nghiệm thu. Nếu repo private, chủ repo vào **Settings → Collaborators** để mời tài khoản giảng viên. Kiểm tra lại lịch sử và tag trên GitHub sau khi push.

## CI/CD

`.github/workflows/ci.yml` chạy khi push/PR hoặc chạy thủ công: `npm ci` → typecheck/lint → ma trận Vitest → build/audit → Chrome regression/load → Chrome TURN/media → build hai Docker target. Báo cáo và log được đưa lên Actions Artifacts; không upload profile browser hoặc file state/secret. Actions được ghim SHA và Dependabot kiểm tra cập nhật.

`.github/workflows/delivery.yml` chỉ chạy qua **Actions → DS01 manual delivery → Run workflow**. Sau CI thành công, workflow phát hành image `ghcr.io/<owner>/<repo>/app:sha-<commit>` và `web:sha-<commit>`. Bật lựa chọn `deploy` mới chạy bước SSH đến server đã cấu hình, dùng environment `production`, kiểm tra health và khôi phục image trước nếu cập nhật thất bại. Thiết lập người duyệt environment trong GitHub nếu gói tài khoản hỗ trợ. Đây là cấu hình sẵn; chưa có lần chạy Actions/deploy thật cho các thay đổi chưa push.

Hướng dẫn cấu hình biến, secrets, server và triển khai lại: [deploy/README.md](deploy/README.md). Tham chiếu cơ chế registry/token: [GitHub — Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
