# Ma trận kiểm thử và đánh giá

Tài liệu mô tả mục tiêu, bất biến và cách kiểm tra. Kết quả của các đợt đã chạy nằm ở [implementation-status.md](implementation-status.md) và hồ sơ validation; bảng kế hoạch không tự được tính thành một lần chạy.

## Mục 9: bộ kịch bản tối thiểu

| ID  | Loại           | Thao tác                       | Bất biến/tiêu chí                            |
| --- | -------------- | ------------------------------ | -------------------------------------------- |
| F1  | Functional     | A/B/C đăng ký và discovery     | ID riêng, metadata đúng, không lộ secret     |
| F2  | Functional     | A lookup B                     | Đúng online/connectivity và quyền truy cập   |
| F3  | Functional     | Chat DIRECT                    | ACK, cùng ID, relay không FORWARD            |
| F4  | Functional     | Kết nối trực tiếp lỗi          | Tự dùng RELAY và nhận ACK                    |
| F5  | Functional     | Tạo nhóm A/B/C                 | Fan-out tới từng thành viên                  |
| F6  | Functional     | Thêm/xóa member                | Version và quyền cùng cập nhật               |
| F7  | Functional     | Reload peer                    | Giữ identity/history phù hợp                 |
| F8  | Functional     | Gửi file                       | Đúng byte/hash và trạng thái                 |
| C1  | Concurrency    | Hai change cùng version        | Một kết quả hợp lệ, stale bị từ chối         |
| C2  | Concurrency    | B/C gửi gần đồng thời          | Không mất/trùng, sequence theo sender        |
| E1  | Fault/recovery | Peer mất kết nối rồi trở lại   | Presence, reconnect, giữ history             |
| E2  | Fault/recovery | Relay dừng/không trả RPC       | Timeout, failover hoặc failed có giới hạn    |
| S1  | Security       | Token khác sender              | Reject, không FORWARD                        |
| S2  | Invalid data   | Payload/ID/size/ACK sai        | Reject, process còn hoạt động                |
| P1  | Performance    | Nhiều peer/concurrent messages | Throughput, latency, success, trùng/sai đích |

## B4 và các tình huống biên

- Mất data/mất ACK: retry cùng ID, tối đa 3 lần; một bản nhận.
- ACK sai session/group/sequence/sender/receiver/ackFor: không hoàn tất pending khác.
- Hai sự kiện đồng thời dùng cùng ID: không tạo hai nội dung cho một sự kiện.
- Receive đang lưu chậm: ACK của chiều gửi vẫn được xử lý.
- Timestamp lùi/arrival đảo thứ tự: chuỗi sender/session vẫn đúng sequence.
- Quota/storage lỗi: không ACK như đã lưu thành công; retry không làm trùng.
- Close/reload khi pending: lời gọi kết thúc và lịch sử phục hồi thành trạng thái có ý nghĩa.

## Các tầng kiểm tra

Unit/integration kiểm tra schema, consistency và Socket.IO/HTTP server thật. RTC giả ở một số test chỉ dùng để chủ động gây timeout/lỗi.

Browser kiểm tra Chrome thật, WebRTC, IndexedDB và UI. Bộ nâng cao có STUN/TURN lab, E2EE/media, DHT và account recovery.

Thí nghiệm hiệu năng localhost tách hai phép đo: nhận envelope Socket.IO và ACK/persistence trong Chrome. Không so trực tiếp latency của hai định nghĩa khác nhau.

## Lệnh

Bộ lệnh nền: npm run typecheck, npm run lint, npm test, npm run build:web.

Bản tích hợp có npm run evaluate, npm run test:browser, npm run test:browser:advanced và npm run test:browser:accounts. Các script/dependency tương ứng cần được hợp nhất cùng source của chúng.

Mỗi hồ sơ ghi thời gian, source snapshot, môi trường, input, kết quả và bất biến. manual-results.csv giữ ô kết quả để người thực hiện ghi PASS/FAIL cùng bằng chứng của buổi chạy.
