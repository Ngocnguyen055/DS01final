# Hồ sơ kiểm tra DS01

Các file ở đây gắn với lần chạy và phạm vi cụ thể, không phải một bảng PASS chung cho mọi revision.

## Hồ sơ ngày 20/11/2026

validation-2026-11-20.json tổng hợp từ evaluate, browser cơ bản/advanced/account recovery và load/latency. File giữ nguồn, mốc thời gian, commit/fingerprint có sẵn và định nghĩa phép đo. Số liệu working tree tích hợp khác baseline Nam đã tách.

Các nguồn chạy gốc được giữ trên ổ F trong runtime. Hồ sơ tổng hợp không xuất account registry, token, session secret, private key hoặc ciphertext backup người dùng.

## Hồ sơ cũ

benchmark.txt, unit-tests.json, load-relay.json, browser-smoke.json, review-*.json và ảnh UI trước đây là lịch sử của chính lần chạy ghi trong file. Một screenshot hoặc JSON cũ không tự đổi thành bằng chứng của source mới.

## Mỗi biên bản mới

Ghi ngày/múi giờ, revision và working-tree state, môi trường, topology, thao tác, kết quả, Message ID và log liên quan. Với performance, nêu payload, concurrency, warmup/sample count và điểm bắt đầu/kết thúc latency.

manual-results.csv ở thư mục docs là mẫu ghi nhận buổi nghiệm thu; ô kết quả do nhóm điền theo quan sát thực tế.
