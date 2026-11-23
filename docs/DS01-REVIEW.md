# Ghi nhận cải thiện DS01 P2P Chat

Bản đối chiếu cập nhật 20/11/2026, thay cho kết luận rà soát cũ. Chi tiết kết quả ở [implementation-status.md](implementation-status.md).

| Nhóm vấn đề                         | Cách xử lý trong bản phát triển                         |
| ----------------------------------- | ------------------------------------------------------- |
| Callback/input làm service thoát    | Guard handler, validation, rate budget và regression    |
| Ordering theo timestamp gây đảo tin | Sender/session sequence, logical time và merge xác định |
| Mất ràng buộc identity sau restart  | Persist registry bằng atomic snapshot                   |
| Gửi treo khi close/mất ACK          | Cancellation, bounded retry, interrupted-send recovery  |
| Trạng thái UI lệch kết nối          | Connection event và reconnect state                     |
| Metadata discovery thiếu            | Display name/status/connectivity, schema và lease       |
| Owner rời nhóm/đụng version         | Chính sách chuyển owner, OCC và state đã lưu            |
| ID trùng khác nội dung              | Kiểm tra danh tính sự kiện, không overwrite/ACK sai     |
| Nhóm gửi lại cho người đã ACK       | Pending/receipt riêng từng receiver                     |
| File thiếu/toàn vẹn sai             | Chunk bounds, SHA-256 và lưu bytes trước xác nhận       |
| State tài khoản nằm rải rác         | Canonical data root và migration có ràng buộc           |
| Đổi thiết bị/origin                 | Vault/account archive mã hóa và chuyển phiên            |
| Relay lỗi                           | Pool, timeout, failover, journal/mailbox theo cấu hình  |

## Ranh giới khi review Git

Commit B2/B4 8677e28 chỉ chứa 16 file/hunk được chọn. Tài liệu và toàn bộ working tree tích hợp có phạm vi lớn hơn. Hợp nhất phần B1/B3/N8, B5/B6, advanced và CI/CD theo người phụ trách trước khi chốt cùng một source snapshot.

Baseline Nam có 118/120 test đạt; hai lỗi công cụ tái hiện trên main baseline. Working tree tích hợp có 247/247 test đạt tại đợt evaluate 20/11. Không thay thế kết quả của snapshot này cho snapshot kia.

Các review-probes/review-invalid-input cũ ở evidence là lịch sử của lần kiểm tra trước; dữ liệu đó không được dùng làm kết luận lỗi hiện tại.
