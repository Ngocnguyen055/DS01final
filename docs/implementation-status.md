# Phiên bản và kết quả đối chiếu

Cập nhật 20/11/2026. Tài liệu dùng chung cho nhóm Nam/Hồng/Ngọc.

## Phạm vi nguồn

| Snapshot                | Phạm vi                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| main 60867fe            | Baseline GitHub tại thời điểm đối chiếu                                         |
| Nam 8677e28             | Baseline cộng 16 file/hunk B2/B4                                                |
| Working tree tích hợp   | Bản phát triển đầy đủ tại thư mục DS01, gồm phần của các thành viên và advanced |
| Bản tài liệu dùng chung | Được cập nhật trên Nam để review cùng B2/B4 vào main                            |

Đây là những snapshot khác nhau. Việc một tính năng có trong working tree không tự đưa source của tính năng đó vào commit B2/B4. Các phần mở rộng và CI/CD cần được commit/hợp nhất theo phân công.

## Kết quả kiểm tra

| Đợt                            | Kết quả                                              | Phạm vi                                                 |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| B2/B4 đã tách                  | 78 test đạt                                          | Protocol, ICE, ACK/retry/dedup/ordering và fallback     |
| Toàn bộ baseline Nam           | 118/120 test đạt                                     | Hai lỗi công cụ cũng tái hiện trên main baseline        |
| Evaluate tích hợp 20/11, 23:26 | 247/247 test, 23 file                                | Windows, Node v25.2.1                                   |
| Ma trận mục 9                  | 8 functional, 3 concurrency, 3 fault, 3 security đạt | Chọn kịch bản trong đợt evaluate                        |
| Browser cơ bản                 | 54/54 check đạt                                      | Chrome, WebRTC/IndexedDB thật, loopback                 |
| Browser advanced               | 19/19 check đạt                                      | TURN/STUN lab, E2EE, media, mailbox và DHT              |
| Browser account recovery       | 16/16 check đạt                                      | Context/origin riêng, takeover, vault, history/file     |
| Thử tải                        | 3/20/50/100 peer; 60/200/500/1000 message            | Socket.IO localhost, kiểm tra đúng đích/nguyên envelope |

Browser/load chạy trên working tree ngày 20/11 với base commit 60867fe và fingerprint riêng trong hồ sơ. Evaluate mới có base 8677e28 với working tree modified. Không gắn những kết quả này cho một clean checkout khác.

Hai test công cụ ở baseline Nam: phát hiện relay gửi nhầm socket trong load experiment; benchmark tới endpoint không hoạt động phải kết thúc hữu hạn. Các sửa đổi công cụ đã nằm trong phần tích hợp, cần đưa cùng phần N8/runtime của nhóm.

## Các cơ chế chính

- B1/B3: tài khoản/phiên, discovery, lease, mapping, validation và log.
- B2: SDP/ICE/DataChannel, giới hạn negotiation, selected route và fallback.
- B4: schema strict, ACK ràng buộc context, 3 attempt, ID bất biến, dedup, recovery và ordering.
- B5/B6: membership/OCC, fan-out/ACK từng người nhận, UI và storage tách tài khoản.
- Advanced: pool/selection/failover, replica/mailbox, E2EE, DHT/election, file/media.
- D1: workflow verify, build/publish image, manual deploy, health check và rollback image.

## Hồ sơ dùng chung

[validation-2026-11-20.json](evidence/validation-2026-11-20.json) tổng hợp từ output thật; giữ mốc thời gian, nguồn và phạm vi. [test-plan.md](test-plan.md) nêu test; [MANUAL-ACCEPTANCE.md](MANUAL-ACCEPTANCE.md) nêu thao tác; manual-results.csv dành cho biên bản từng buổi.

Trước khi chốt bản nộp: điền họ tên/MSSV/lớp/giảng viên, hợp nhất phần việc của từng người, ghi biên bản demo và tạo final tag/release. Những bước chung có cả ba thành viên tham gia.
