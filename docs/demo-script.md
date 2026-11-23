# Kịch bản trình diễn DS01 P2P Chat

Dùng cùng [MANUAL-ACCEPTANCE.md](MANUAL-ACCEPTANCE.md). Chuẩn bị ba tài khoản A/B/C và ghi Peer ID thực tế trên giao diện. Không dùng cùng account cho ba peer.

## Chuẩn bị

Với bản tích hợp, chạy npm.cmd run demo:public khi cần URL công khai, hoặc npm.cmd run demo:local cho lab. Giữ terminal launcher mở. Mở dashboard được in ra để xem URL, PID, health và log từng service. Các lệnh launcher cần source/scripts tương ứng của bản tích hợp.

Cách chạy nền dùng ba terminal riêng: npm.cmd run dev:signaling, npm.cmd run dev:relay và npm.cmd run dev:web. Chỉ chạy dev:web không tự khởi động hai service còn lại.

Laptop dùng Wi-Fi; điện thoại tắt Wi-Fi và dùng 4G/5G. Trên cả hai, mở cùng URL HTTPS của Web do phiên demo in ra. Peer C dùng thiết bị hoặc profile/browser context tách biệt. Không nhập localhost trên điện thoại để truy cập server laptop.

## 1. Giới thiệu và kiến trúc — 3 đến 5 phút

- Ngọc mở giao diện, giới thiệu ba peer và history cục bộ.
- Hồng chỉ signaling/relay trên dashboard: PID, URL, role và log.
- Nam giải thích DIRECT/TURN/RELAY, Message ID và ACK.

Trong Task Manager → Details, chỉ các Node process của dịch vụ. Chrome Task Manager (Shift+Esc) cho thấy browser task/renderer. Bộ nhớ hiển thị là phần hệ điều hành cấp cho process; thông điệp đi qua mạng, không truyền bằng vùng nhớ chung.

## 2. Demo cốt lõi — 7 đến 10 phút

1. A/B/C đăng nhập. Đối chiếu tên, Peer ID và danh sách online.
2. A chọn B, để tắt Ưu tiên relay khi gửi tin, gửi một nội dung dễ nhận.
3. Mở Chi tiết tin và Tình trạng kết nối. Nếu selected route là DIRECT, đối chiếu SEND/RECEIVE/ACK cùng ID và relay không FORWARD ID đó.
4. Mở dashboard, lọc Message ID để giải thích đường truyền. TURN có selected relay candidate; RELAY có FORWARD của application relay.
5. Với một kết nối DIRECT đang mở, Nam bấm Ngắt kênh trực tiếp. Gửi tin tiếp và chỉ ra fallback RELAY cùng ACK.
6. A tạo nhóm, thêm B/C. Hồng và Ngọc kiểm tra membership/version, ba peer trao đổi.
7. B/C gửi gần đồng thời. Đối chiếu Message ID, sequence và receipt theo từng người nhận.
8. Dừng đột ngột C bằng đóng browser task của profile thử nghiệm. A/B quan sát offline theo disconnect/lease.
9. Mở lại C trên đúng profile, kiểm tra identity/history/group và gửi tin mới.
10. Hồng minh họa relay chính dừng: nếu còn tuyến dự phòng, chỉ ra active relay đổi; nếu hết tuyến, chỉ ra Chưa xác nhận và retry có giới hạn.

Ngọc theo dõi dữ liệu/UI, Nam giải thích delivery, Hồng đối chiếu server log. Cả ba tham gia thay vì một người thao tác toàn bộ.

## 3. Demo nâng cao theo thời lượng

- File: gửi file dưới 512 KiB, tải về và đối chiếu hash/byte.
- E2EE: mở Kết nối nâng cao, trạng thái mã hóa; dùng log/probe phù hợp để quan sát ciphertext, không in khóa.
- Mailbox: B offline, A thấy queued; B trở lại, sender chuyển delivered khi có ACK.
- Relay selection: chuyển chiến lược Độ trễ và tải/Thứ tự ưu tiên, xem số đo.
- Super-peer: ứng cử URL relay đồng hành đúng owner, đối chiếu lease/election log.
- DHT: dùng chế độ kỹ thuật DHT với identity khóa ký, discovery qua relay overlay.
- TURN/media: selected candidate relay, nhận cuộc gọi, mute và hangup.
- CI/CD: Nam mở workflow/run tương ứng và giải thích verify → build/publish → deploy/health/rollback.
- Load test: Hồng mở bảng kết quả, định nghĩa latency/throughput và môi trường đo.

## 4. Ghi nhận kết quả

Mỗi tình huống lưu thời gian, topology/mạng, source revision, Message ID, log peer/relay và kết quả. Dùng manual-results.csv; số đo của buổi chạy được ghi tại đúng dòng.

URL tunnel thay theo phiên. Giữ đúng kho dữ liệu để tài khoản tồn tại qua restart. Dừng phiên bằng Ctrl+C khi kết thúc; không xóa registry/volume để thử phục hồi.
