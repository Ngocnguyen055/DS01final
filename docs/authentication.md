# Tài khoản, phiên và dữ liệu

Tài liệu cho bản phát triển tích hợp ngày 20/11/2026; các extension cần đi cùng source/dependency của chúng khi hợp nhất.

## Tài khoản và Peer ID

Người dùng tạo tài khoản hoặc đăng nhập; tên đăng nhập được chuẩn hóa và gắn Peer ID ổn định dạng user_<username>. Sau xác thực, web tự đăng ký peer. Display name dùng để hiển thị, không thay định danh.

Mật khẩu được băm scrypt với salt riêng. Server lưu hash mật khẩu và hash token phiên. Phiên mặc định 12 giờ; logout thu hồi phiên. Relay kiểm tra token/subject và hiệu lực phiên qua giao tiếp dịch vụ, không đọc chung file tài khoản để trao đổi state.

Một tài khoản có ràng buộc phiên online. Ở màn hình đăng nhập, Chuyển phiên sang thiết bị này dùng cho tiếp quản có chủ đích; phiên cũ bị thu hồi/ngắt theo luồng tài khoản.

## Dữ liệu nằm ở đâu?

| Dữ liệu                      | Vị trí                                       |
| ---------------------------- | -------------------------------------------- |
| Tài khoản và hash phiên      | Kho dữ liệu signaling                        |
| Membership/identity registry | Snapshot signaling                           |
| Journal/mailbox              | Kho riêng của mỗi relay                      |
| Lịch sử, receipt và contacts | localStorage theo tài khoản/origin           |
| File và khóa đang dùng       | IndexedDB                                    |
| Bản sao tài khoản            | Archive được mã hóa trước khi gửi lên server |

Launcher Node của bản tích hợp mặc định dùng DS01-runtime/data; DS01_DATA_DIR chỉ định nơi khác. Không lấy thư mục source, tài khoản browser và thư mục runtime làm ba nguồn tài khoản độc lập. Docker dùng volume theo cấu hình.

.env cấu hình dịch vụ và URL, không phải danh sách username/password để đăng nhập. Giữ đúng kho dữ liệu và secret qua restart/redeploy để tài khoản cũ tiếp tục dùng được.

## Thiết bị mới và địa chỉ web mới

Browser mới/origin mới bắt đầu với storage riêng. Bản tích hợp mở vault tài khoản bằng thông tin đăng nhập, khôi phục identity, history/file đã backup và tiếp tục E2EE. Khóa đang dùng trong browser không cho xuất trực tiếp; dữ liệu khôi phục được bảo vệ trong vault.

Một account có thể giữ nguyên Peer ID khi đổi thiết bị. Nhưng dữ liệu chỉ tồn tại trên browser cũ cần được đồng bộ hoặc xuất/nhập trước. Kết nối cùng một signaling không tự biến mọi localStorage thành storage chung.

Trong Tình trạng kết nối → Kết nối nâng cao, theo dõi Đồng bộ dữ liệu và dùng Đồng bộ ngay khi cần. Nhập lịch sử từ phiên bản cũ nhận JSON xuất từ origin/thiết bị cũ; không nhập file của tài khoản khác.

## Gián đoạn và khôi phục

Backup outage giữ dữ liệu local và báo trạng thái chờ; khi kết nối trở lại, sync tiếp tục. Archive file được kiểm tra kích thước/hash trước khi áp dụng; lỗi quota có rollback cho dữ liệu cần ghi.

Đăng xuất che dữ liệu khỏi workspace và thu hồi phiên. Việc xóa storage browser là thao tác khác với logout. Không xóa registry/volume để thử đăng nhập lại.

Các giới hạn cần giải thích: server vẫn giữ metadata account, E2EE không giấu routing, mất thông tin mở vault có thể ảnh hưởng khả năng khôi phục, và thiết bị bị kiểm soát có thể đọc dữ liệu sau giải mã.

## Bộ kiểm tra

accounts, account-recovery, discovery, security và browser-account-recovery kiểm tra mật khẩu sai, trùng tên, session revoke, takeover, archive mã hóa, đổi origin, restart và quota. Xem hồ sơ validation ngày 20/11/2026 cho số liệu của từng bộ.
