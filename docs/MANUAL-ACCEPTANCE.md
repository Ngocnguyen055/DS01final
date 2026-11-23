# Hướng dẫn nghiệm thu DS01 P2P Chat

Áp dụng cho bản tích hợp. Phạm vi commit và kết quả tự động ở [implementation-status.md](implementation-status.md). Đây là hướng dẫn thao tác; kết quả từng buổi do nhóm ghi ở manual-results.csv.

## A. Chuẩn bị và quan sát

1. Cài dependency theo lockfile, chuẩn bị .env với secret riêng.
2. Dùng launcher demo của bản tích hợp, giữ terminal chạy. Mở Web và dashboard theo URL in ra.
3. Tạo A/B/C bằng ba tài khoản khác nhau, browser profile/context tách biệt.
4. Ghi Peer ID thực tế. Các ví dụ A/B/C là vai trò, không bắt buộc ID phải đúng chuỗi peer-a.
5. Bố trí laptop Wi-Fi, điện thoại 4G/5G và một peer thứ ba; cả ba dùng URL web phù hợp.
6. Dashboard xem PID/log/health. Task Manager → Details xem process; Chrome Task Manager xem renderer.
7. Chọn peer và mở Tình trạng kết nối; dùng Chi tiết tin để lấy Message ID/session/sequence.

Bản Node tích hợp mặc định giữ dữ liệu tại DS01-runtime/data. Không xóa state để chạy lại demo. Địa chỉ localhost trên điện thoại trỏ về điện thoại.

## B. Đăng ký, discovery và tài khoản

A/B/C đăng nhập, kiểm tra display name/Peer ID/presence ở cả ba màn hình. Dùng tài khoản sai mật khẩu để xác nhận không vào workspace.

Mở một lần đăng nhập account đang online: luồng thông thường phải giữ ràng buộc; luồng Chuyển phiên sang thiết bị này là thao tác tiếp quản có chủ đích. Kiểm tra phiên cũ và dữ liệu khôi phục theo authentication.md.

Dừng C, quan sát log DISCONNECT/TIMEOUT và danh sách online. Với đứt mạng im lặng, thời gian quan sát gồm lease và chu kỳ quét; không dùng một con số tức thời cho mọi failure model.

## C. DIRECT, TURN và application RELAY

### DIRECT

- Tắt Ưu tiên relay khi gửi tin.
- A chọn B và gửi một tin. Đọc mode sau khi lựa chọn kết nối hoàn tất.
- Khi có DIRECT, lấy Message ID; kiểm tra SEND/RECEIVE/ACK ở peer.
- Trên relay, lọc đúng ID và xác nhận không có FORWARD của sự kiện đó.
- B trả lời A để chứng minh hai chiều.

### TURN

- Cấu hình ICE server/policy theo lab hoặc triển khai đang dùng.
- Mở kết nối và xem selected candidate pair có candidate type relay.
- Gửi/nhận thành công trên DataChannel; phân biệt với FORWARD ở application relay.

### RELAY và fallback

- Khi đường trực tiếp lỗi/hết timeout, chờ RELAY và ACK.
- Lọc cùng Message ID tại sender, relay FORWARD và receiver.
- Để kiểm tra mất kết nối đang hoạt động: mở DIRECT trước, bấm Ngắt kênh trực tiếp, rồi gửi tiếp.
- Checkbox ép relay chỉ kiểm tra đường relay chủ đích, không phải mô phỏng NAT.

### Kiểm tra hồi quy kết nối sau bản sửa

Khởi động lại signaling/web bằng phiên bản mã nguồn mới và tải lại trang trên cả ba thiết bị. Nếu dùng launcher public, dùng URL do phiên mới in ra. Giữ nguyên dữ liệu tài khoản/lịch sử.

| Ca | Thao tác | Kết quả cần quan sát |
| --- | --- | --- |
| DIRECT bình thường | A/B dùng mạng cho phép P2P, gửi hai chiều rồi gửi gần đồng thời | Tin được xác nhận, không nhân đôi; nhãn DIRECT và log SEND/RECEIVE khớp ID; relay không FORWARD ID đó |
| Điện thoại từng bị RELAY | Giữ tắt ưu tiên relay, chọn tài khoản máy tính, bấm Thử kết nối trực tiếp rồi gửi | Sau thời gian chờ tin vẫn đến bằng RELAY nếu chưa có đường trực tiếp; nếu ICE mở trong 30 giây thì tin tiếp theo dùng DIRECT |
| Đóng kênh thật | Đang DIRECT, mở Tình trạng kết nối và bấm Ngắt kênh trực tiếp, rồi gửi tiếp | Kênh đóng thật, tin tiếp theo qua RELAY; giao diện không còn câu báo DIRECT đã thành công |
| Thử lại | Sau khi đóng kênh, bấm Thử kết nối trực tiếp, thử lại vài lần khi nút cho phép | Không treo; chỉ kết quả của phiên hiện hành có hiệu lực; mạng cho phép P2P thì có thể trở lại DIRECT |
| Gián đoạn/đổi mạng | Khi đang DIRECT, ngắt Wi-Fi ngắn hoặc đổi sang 4G, giữ tab ở trước màn hình | Khi có mạng, tin vẫn có đường RELAY; log có thể ghi DIRECT_RECOVERING/DIRECT_ICE_RESTART; DIRECT trở lại nếu kiểm tra đường mạng thành công, hoặc đóng phục hồi sau giới hạn |
| Nhóm ba peer | A/B/C cùng nhóm, B/C gửi gần đồng thời | Mỗi người nhận một bản tin, trạng thái giao tin đúng; có thể kết hợp DIRECT và RELAY theo từng cặp |

Xuất log ngay trên từng thiết bị sau lần thử. Tên file chứa Peer ID và thời điểm xuất, ví dụ `ds01-peer-log-user_phone-...txt`. Đối chiếu `DIRECT_ATTEMPT`, `DIRECT_DIAGNOSTIC`, `DIRECT_STALE_SIGNAL`, `DIRECT_ICE_RESTART` và Message ID giữa hai phía. Các lỗi ACK signaling và tín hiệu cũ có test tự động trong `tests/connection-recovery.test.ts`; không cần thao tác thủ công giả lập bằng cách tắt toàn bộ Internet.

## D. Giao tin tin cậy

| Ca              | Thực hiện                              | Kết quả cần quan sát                                   |
| --------------- | -------------------------------------- | ------------------------------------------------------ |
| Mất ACK         | Dùng fault injection/test tương ứng    | Retry cùng ID, một bản nhận                            |
| Trùng           | Phát lại bản hợp lệ                    | ACK lại, không thêm dòng history                       |
| ID xung đột     | Cùng ID, khác nội dung                 | Reject, giữ nội dung ban đầu                           |
| Sai ACK context | Đổi session/group/sequence hoặc sender | Không hoàn tất pending khác                            |
| Đảo thứ tự      | Gửi/nhận thứ tự khác với sequence      | Chuỗi sender/session được trình bày hợp lý             |
| Hết retry       | Không có tuyến/ACK hợp lệ              | Tối đa ba lần, Chưa xác nhận                           |
| Close/reload    | Đóng khi đang chờ                      | Không treo vô hạn; history phục hồi có trạng thái đúng |

Các fault ở protocol dùng test/probe được thiết kế cho việc đó; không cần giả lập bằng thao tác UI không có tác dụng lên ACK. Giữ log theo Message ID để giải thích khác biệt sent/forwarded/queued/delivered.

## E. Nhóm và đồng thời

1. A tạo nhóm có B/C. So sánh Group ID, members và version ở ba peer.
2. A gửi, kiểm tra một sự kiện với receipt riêng B/C.
3. B/C gửi gần đồng thời. Ghi mốc gửi, Message ID và sequence; mỗi receiver có một bản.
4. Hai sửa đổi cùng version: một được áp dụng, thao tác stale bị từ chối; lấy state mới trước bước tiếp.
5. Xóa C, kiểm tra quyền gửi/nhận mới; history cũ vẫn có ý nghĩa lịch sử.
6. Owner rời nhóm, quan sát owner mới theo quy tắc xác định.
7. Một member offline: giữ membership; xử lý failed hoặc queued theo cấu hình. Retry chỉ receiver thiếu ACK; người mới không tự được replay mọi tin cũ.

## F. Lỗi và phục hồi

### F1 — Peer crash/mất mạng

Trước lỗi, ghi identity và một tin đã delivered. Dừng browser task/profile thử nghiệm hoặc ngắt mạng C. Hai peer còn lại cập nhật trạng thái. Mở lại đúng profile, kiểm tra identity/history/membership và trao đổi tin mới.

### F2 — Relay dừng/không phản hồi

Ghi active relay và tin baseline. Làm relay chính dừng hoặc không trả RPC bằng công cụ thử lỗi. Nếu có backup, quan sát timeout/failover và ACK qua backup; nếu hết tuyến, sender báo chưa xác nhận. Khôi phục dịch vụ và thử tin mới/retry gốc.

### F3 — Signaling restart

Giữ nguyên kho dữ liệu và secret. Restart process signaling, quan sát reconnect, identity/group còn đúng. Một signaling restart không được làm Peer ID đổi chủ chỉ do registry RAM bị tạo lại.

### F4 — Replica/mailbox

B offline, A gửi và thấy queued. Đối chiếu journal replica, dừng primary theo kịch bản, B kết nối còn lại và ACK. Sender chỉ delivered khi receipt đúng. Ghi cả TTL/quota và phạm vi failure domain.

## G. Bảo mật và dữ liệu sai

- Token sai, hết hạn, logout hoặc sender khác subject: reject.
- Người ngoài nhóm hoặc đã bị xóa: không có quyền với message mới.
- Body/schema/size/ACK/SDP/ICE sai: reject và process tiếp tục trả health/request hợp lệ.
- Đổi ciphertext/metadata: kiểm tra xác thực thất bại.
- Replica request sai HMAC/replay: reject.
- Không chụp .env, token hoặc private key làm bằng chứng công khai.

## H. File, đồng bộ và media

Gửi file tối đa 512 KiB; đối chiếu tên/kích thước/hash và byte tải về. Thử ngắt giữa luồng, dữ liệu lỗi không thành complete.

Đổi browser/origin với cùng account: kiểm tra takeover, archive được giải mã, history/file/identity phù hợp. Backup outage giữ local; quota/archive hỏng không được âm thầm thay history tốt.

Media: người nhận chỉ xin quyền thiết bị khi chấp nhận, có remote stream, mute thay track, hangup tắt track. DHT/election giải thích record/lease, owner relay và tập cluster đang dùng.

## I. Ghi số liệu và kết thúc

Ghi PASS hoặc FAIL theo buổi chạy, người thực hiện, thiết bị/mạng, revision, Message ID, file log/ảnh và số đo. Tách receive latency Socket.IO khỏi ACK/persistence latency browser. Cùng payload, sample count/warmup và điều kiện khi so mode.

Để kết thúc, export log/history cần thiết và Ctrl+C launcher. Giữ kho dữ liệu cho buổi sau. Biên bản dùng chung do cả ba thành viên đối chiếu.
