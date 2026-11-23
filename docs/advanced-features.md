# Chức năng nâng cao DS01

Mô tả cơ chế trong bản phát triển tích hợp. Bảng kết quả và phiên bản tham chiếu nằm ở [implementation-status.md](implementation-status.md).

| Chức năng 5.11    | Thành phần chính          | Cơ chế                                                 |
| ----------------- | ------------------------- | ------------------------------------------------------ |
| Nhiều relay       | PeerClient, relay         | Pool tối đa bốn URL khác nhau                          |
| Chọn relay        | relaySelection            | RTT EWMA + peer count + pending mail                   |
| Tự failover       | PeerClient                | Disconnect/RPC timeout, thử relay khác                 |
| Bầu super-peer    | RelayCluster, journal     | Owner Peer ID, endpoint, lease, merge ứng viên         |
| Replication       | cluster, journal          | HTTP xác thực, snapshot riêng, tombstone               |
| Store-and-forward | journal, MessageDelivery  | TTL, queued, ACK người nhận                            |
| E2EE              | secure, keyDirectory      | ECDH/HKDF/AES-GCM và identity pin                      |
| DHT               | overlayProtocol, cluster  | Signed record, hash ring và owner replica              |
| Truyền file       | FileTransfer              | Chunk, ACK, SHA-256, IndexedDB                         |
| STUN              | DirectTransport           | Binding và ICE candidate gathering                     |
| WebRTC/TURN       | DirectTransport, iceRoute | Selected candidate pair và route label                 |
| Thoại/video       | MediaSession, CallPanel   | Nhận cuộc gọi, RTP, mute, hangup                       |
| Load test         | load-relay, browser-smoke | Concurrency, latency, throughput, đúng socket/envelope |

## Chọn relay và failover

RTT được làm mượt theo 0,7 × giá trị cũ + 0,3 × mẫu mới. Điểm bằng RTT + 0,25 × peers + 2 × pending. Mẫu hết hạn sau 45 giây; relay hiện tại có độ ưu tiên giữ ổn định. Chiến lược Thứ tự ưu tiên dùng thứ tự URL.

Failover của pool là đổi đường truyền. Nó không tự sao chép state; mailbox/journal replica là cơ chế riêng. Replica bất đồng bộ có cửa sổ trước khi write lan sang node khác.

## Super-peer và DHT

Một browser không tự trở thành server public. Ứng viên cần relay đồng hành có owner Peer ID đúng, nằm trong cluster và endpoint hợp lệ. Tại Kết nối nâng cao → Ứng cử super-peer, người dùng gửi URL relay đồng hành. Lease loại ứng viên cũ; log ELECTION_CANDIDATE/ELECTION_RESULT giúp đối chiếu.

DHT dùng identity từ khóa ký, record có chữ ký/thời hạn và relay overlay theo hash ring. Cấu hình thành viên ring cần thống nhất. Đây là nguyên mẫu discovery phân tán, không phải Kademlia hoặc consensus Raft.

## Mailbox và E2EE

Peer offline có thể nhận queued khi mailbox được bật; không coi queued là delivered. Receipt cuối phụ thuộc ACK người nhận. Hạn lưu mặc định 24 giờ, có giới hạn dung lượng và trạng thái hết hạn.

E2EE bảo vệ plaintext; relay vẫn thấy routing metadata và ciphertext. Key pin, account vault và cơ chế thay khóa được dùng cùng luồng tài khoản. TLS bảo vệ transport, giải quyết một lớp khác.

## File, STUN/TURN và media

File tối đa 512 KiB, chunk 2304 byte, kiểm tra SHA-256 trước hoàn thành. Resume file dang dở qua restart là hướng mở rộng.

Cấu hình ICE đi qua VITE_ICE_SERVERS; VITE_ICE_POLICY điều khiển policy của bản tích hợp. TURN service và application relay độc lập. Giao diện báo TURN theo selected pair, không theo việc có URL TURN trong cấu hình.

Cuộc gọi chỉ xin quyền media ở bước người dùng chấp nhận; mute thay đổi track và hangup dừng track. Bài kiểm tra lab sử dụng STUN/TURN và audio/video RTP thật.

## Công cụ của bản tích hợp

npm run test:browser:advanced kiểm tra TURN, media, replica mailbox và DHT bằng Chrome thật. npm run test:browser:accounts kiểm tra recovery tài khoản. npm run evaluate chạy test và ma trận mục 9. Các script này được đưa cùng phần code tích hợp tương ứng.

Khi demo advanced, chọn từng chức năng, chỉ ra state trước/sau, ID sự kiện và log liên quan; không dùng số lượng tên tính năng thay cho giải thích cơ chế.
