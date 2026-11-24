# Giao thức DS01 P2P Chat

## Danh tính và discovery

Peer ID hợp lệ gồm 3–32 chữ/số, dấu gạch dưới hoặc gạch nối. Luồng tài khoản có ID ổn định user_<username>; luồng kỹ thuật có proof riêng; DHT dùng định danh gắn khóa ký.

Bản tích hợp đăng ký peerId, identityProof, displayName, status và connection metadata. Signaling cung cấp peer:list, peer:lookup, presence và peer:profiles; không trả secret hoặc socket ID của peer khác. Heartbeat mặc định 10 giây, lease 30 giây, có vòng quét và cập nhật khi disconnect.

## Thiết lập WebRTC

Các event signal:send/signal:receive mang request, offer, answer và ICE. Bản tích hợp bổ sung signaling cho media. Signaling không chuyển chat body.

Peer ID nhỏ hơn điều phối offer; thao tác signaling theo peer được tuần tự hóa. Offer/answer/ICE mang `connectionId` và `revision`; request có `requestId`, được echo trong offer trả lời. Tín hiệu của phiên đã đóng, request đã xử lý hoặc revision ICE cũ bị bỏ qua. Candidate đến trước offer được giữ trong hàng đợi có giới hạn. Phần metadata này được bỏ trước khi đưa dữ liệu vào WebRTC. Signaling vẫn nhận định dạng cũ; khi peer đã gửi mã phiên, transport yêu cầu mã đó trên các offer/answer/ICE tiếp theo.

DataChannel dùng ordered=true. Lần gửi chờ DIRECT mặc định 10 giây rồi dùng RELAY, trong khi ICE được giữ tối đa 30 giây tổng cộng. Kênh mở trong khoảng này được dùng cho tin tiếp theo. `directTimeoutMs` và `directBackgroundTimeoutMs` điều chỉnh hai giới hạn trong SDK. Mất kết nối tạm thời trên kênh từng mở dùng relay trong lúc đợi 1,5 giây rồi thử ICE restart một lần, tối đa 15 giây; chỉ Peer ID nhỏ hơn tạo restart offer. Phản hồi timeout của signaling không đóng kênh đã mở; phản hồi từ chối vẫn có hiệu lực. Đóng kênh chủ động và lỗi DataChannel chuyển RELAY ngay. Cặp candidate được chọn quyết định DIRECT/TURN; cấu hình TURN không tự quyết định mode.

## Envelope

| Trường                  | Ý nghĩa                                       |
| ----------------------- | --------------------------------------------- |
| messageId               | UUID của sự kiện, giữ nguyên khi retry        |
| sessionId               | Phiên hội thoại; nhóm dùng Group ID           |
| senderId / receiverId   | Peer gửi và một peer nhận cụ thể              |
| groupId                 | UUID nhóm hoặc null/không có cho chat cá nhân |
| type                    | text, attachment, file-chunk, ack             |
| timestamp / logicalTime | Unix milliseconds và đồng hồ logic            |
| body                    | Nội dung, tối đa 4000 ký tự                   |
| mode                    | DIRECT, TURN hoặc RELAY                       |
| ackRequested            | true cho dữ liệu, false cho ACK               |
| ackFor                  | ID sự kiện được xác nhận, chỉ có ở ACK        |
| attempt                 | 1 đến 3 trong một lượt gửi                    |
| sequence                | Thứ tự theo sender và hội thoại               |
| attachments / fileChunk | Metadata file hoặc chunk có SHA-256           |

Plaintext envelope tối đa 8192 byte UTF-8 sau chuẩn hóa. Schema strict từ chối trường lạ hoặc ACK mâu thuẫn. Trạng thái giao tin là state cục bộ, không nhận một trường status từ peer để tự đánh dấu delivered.

## ACK và retry

Receiver xác thực đường gửi/quyền, kiểm tra trùng và nội dung bất biến, lưu dữ liệu rồi ACK. ACK phải khớp message/receiver/session/group/sequence. Không ACK một ACK.

Pending được đăng ký trước send để không mất ACK đến sớm. Timer 2 giây bắt đầu sau transport chấp nhận, không tính nhầm thời gian lookup/authorization. ACK đầu cuối có giá trị ngay cả khi RPC relay mất phản hồi.

Retry cùng ID giữ timestamp, logicalTime, sequence, session và nội dung. Mode/attempt có thể đổi. Receiver ACK lại bản sao hợp lệ nhưng không lưu thêm; ID trùng có nội dung khác bị từ chối.

Dedup có retention: web giữ tối đa 1000 dòng history và ledger 10000 khóa. Không cam kết exactly-once vô hạn.

## Trạng thái giao tin

| State     | Hiển thị/ý nghĩa                                   |
| --------- | -------------------------------------------------- |
| pending   | Đang chuẩn bị                                      |
| sent      | Đã gửi trên DataChannel, chờ xác nhận              |
| forwarded | Relay đã chuyển tiếp, chờ receiver ACK             |
| queued    | Mailbox nâng cao đã lưu, chờ peer nhận             |
| delivered | Peer nhận xác nhận đã lưu; không đồng nghĩa đã đọc |
| failed    | Chưa xác nhận trong ngân sách gửi                  |
| received  | Bản nhận đã lưu tại peer                           |

Queued thuộc phần mailbox tích hợp. Baseline không có mailbox báo lỗi khi receiver offline. Retry thủ công dùng lại sự kiện gốc.

## Nhóm và file

Nhóm có Group ID, ownerId, members và version. group:create/group:change kiểm tra quyền/version; owner rời nhóm chuyển quyền theo quy tắc xác định. Một sự kiện fan-out có envelope/ACK riêng từng receiver.

File chia chunk 2304 byte, tổng file tối đa 512 KiB. Receiver kiểm tra chunk/metadata/SHA-256 và chỉ ACK attachment metadata khi byte file đã được kiểm chứng. File lỗi không được hiển thị là hoàn thành.

## E2EE và replica của bản tích hợp

E2EE bọc envelope bằng AES-GCM, khóa dẫn xuất ECDH/HKDF. Outer envelope giới hạn 16384 byte, có trường routing và ciphertext; relay thấy metadata, không đọc plaintext khi chế độ này bật.

Relay journal có clock/origin/tombstone. Replica RPC dùng HMAC, timestamp và nonce; mỗi node giữ kho riêng. Mailbox xóa/hoàn tất dựa trên ACK được kiểm tra, không chỉ dựa trên RPC accepted.

## Đối chiếu log

DIRECT SEND <id> ở peer, RECEIVE/ACK ở đích và không FORWARD <id> ở application relay chứng minh đường DIRECT. RELAY SEND/FORWARD/RECEIVE cùng Message ID chứng minh đường application relay. TURN cần selected candidate type relay và DataChannel hoạt động.
