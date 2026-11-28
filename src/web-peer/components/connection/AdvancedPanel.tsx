import { useState } from "react";
import type { useWebPeer } from "../../hooks/useWebPeer.ts";

export function AdvancedPanel({
  peer: p,
}: {
  peer: ReturnType<typeof useWebPeer>;
}) {
  const [candidate, setCandidate] = useState("");
  return (
    <section className="advanced-panel">
      <h3>Kết nối nâng cao</h3>
      <label className="toggle-setting">
        <span>
          <strong>Kiểm tra cuộc gọi qua relay</strong>
          <small>
            Mô phỏng chặn WebRTC cho cuộc gọi mới: chuyển RELAY sau khoảng 8
            giây kể từ khi nhận. Chỉ đổi khi đã kết thúc cuộc gọi.
          </small>
        </span>
        <input
          type="checkbox"
          aria-label="Kiểm tra cuộc gọi qua relay"
          checked={p.simulateMediaIceFailure}
          disabled={p.callBusy}
          onChange={(event) => p.toggleMediaIceFailure(event.target.checked)}
        />
      </label>
      <dl className="connection-properties">
        {p.accountSession && (
          <div>
            <dt>Đồng bộ dữ liệu</dt>
            <dd>
              <strong>
                {p.syncState?.phase === "synced"
                  ? "Đã đồng bộ"
                  : p.syncState?.phase === "waiting"
                    ? "Chờ đồng bộ"
                    : "Đang đồng bộ…"}
              </strong>
              {p.syncState?.detail ||
                "Lịch sử và file được mã hóa trước khi sao lưu."}
              <button
                className="secondary-button small"
                onClick={() => void p.syncNow()}
              >
                Đồng bộ ngay
              </button>
            </dd>
          </div>
        )}
        <div>
          <dt>Mã hóa</dt>
          <dd>
            <strong>
              {p.encryptionEnabled ? "E2EE đang bật" : "E2EE chưa bật"}
            </strong>
            {p.encryptionEnabled
              ? "Mã hóa chat và file trước khi gửi."
              : "Chat và file chưa được mã hóa đầu cuối."}
          </dd>
        </div>
        <div>
          <dt>Khám phá peer</dt>
          <dd>
            {p.discovery === "dht"
              ? "DHT · định danh bằng khóa ký"
              : "Signaling"}
          </dd>
        </div>
        <div>
          <dt>Super-peer</dt>
          <dd>
            {p.leader
              ? `${p.leader.peerId} · ${p.leader.url}`
              : "Chưa có ứng viên còn hiệu lực"}
          </dd>
        </div>
      </dl>
      {p.securityFingerprint && (
        <details className="technical-details">
          <summary>
            Dấu vân tay khóa {p.accountSession ? "tài khoản" : "thiết bị"}
          </summary>
          <code>{p.securityFingerprint}</code>
          <p>
            {p.accountSession
              ? "Khóa khôi phục lưu trên máy chủ dưới dạng mã hóa bằng mật khẩu. Khóa đang dùng trong trình duyệt không thể xuất."
              : "Khóa riêng DHT lưu trên thiết bị này."}{" "}
            Relay vẫn thấy thông tin định tuyến.
          </p>
          {p.target && (
            <button
              className="secondary-button"
              onClick={() => void p.verifyPeerKey()}
            >
              Xác minh khóa của peer đang chọn
            </button>
          )}
        </details>
      )}
      {p.accountSession && (
        <details className="technical-details">
          <summary>Nhập lịch sử từ phiên bản cũ</summary>
          <p>
            Chọn file JSON đã xuất từ thiết bị hoặc địa chỉ web cũ. Dữ liệu chưa
            từng sao lưu cần nhập một lần.
          </p>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Nhập lịch sử cũ"
            onChange={(event) => {
              void p.importHistory(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </details>
      )}
      <label>
        Chiến lược chọn relay
        <select
          aria-label="Chiến lược chọn relay"
          value={p.relayPolicy}
          onChange={(event) =>
            p.selectRelayPolicy(
              event.target.value as "priority" | "latency-load",
            )
          }
        >
          <option value="latency-load">Độ trễ và tải</option>
          <option value="priority">Thứ tự ưu tiên</option>
        </select>
      </label>
      {p.relayMetrics.length > 0 && (
        <details className="technical-details">
          <summary>Số đo relay ({p.relayMetrics.length})</summary>
          {p.relayMetrics.map((sample) => (
            <div className="relay-sample" key={sample.url}>
              <small>{sample.url}</small>
              <span>
                RTT {sample.rttMs.toFixed(1)} ms · {sample.peers} kết nối ·{" "}
                {sample.pending} tin chờ · điểm {sample.score.toFixed(1)}
              </span>
            </div>
          ))}
        </details>
      )}
      <details className="technical-details">
        <summary>Ứng cử super-peer</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void p.volunteerSuperPeer(candidate);
          }}
        >
          <label>
            URL relay đồng hành
            <input
              type="url"
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              placeholder="https://relay.example.org"
              required
            />
          </label>
          <button className="secondary-button">Gửi ứng cử</button>
        </form>
        <p className="diagnostic-note">
          Cần chạy relay riêng có HTTPS public, thuộc cluster và có owner là
          Peer ID của bạn. Máy chủ sẽ kiểm tra khả năng truy cập trước khi nhận
          ứng cử.
        </p>
      </details>
    </section>
  );
}
