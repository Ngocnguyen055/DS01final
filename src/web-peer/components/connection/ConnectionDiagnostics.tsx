import { useRef, useState } from "react";
import type { useWebPeer } from "../../hooks/useWebPeer.ts";
import { Icon } from "../Icon.tsx";
import { AdvancedPanel } from "./AdvancedPanel.tsx";

export const connectionLabel = {
  offline: "Chưa kết nối",
  connecting: "Đang kết nối",
  reconnecting: "Đang kết nối lại",
  online: "Đang trực tuyến",
};
function PeerLog({ logs, onExport }: { logs: string[]; onExport: () => void }) {
  const [pausedLogs, setPausedLogs] = useState<string[] | null>(null);
  const logPane = useRef<HTMLPreElement>(null);
  const visibleLogs = pausedLogs ?? logs;
  const togglePause = () => {
    if (pausedLogs === null) {
      setPausedLogs(logs);
    } else {
      if (logPane.current) logPane.current.scrollTop = 0;
      setPausedLogs(null);
    }
  };
  return (
    <>
      <div className="log-heading">
        <strong>Nhật ký peer</strong>
        <div className="log-actions">
          <button
            className="secondary-button small"
            aria-controls="peer-log"
            onClick={togglePause}
          >
            {pausedLogs === null ? "Tạm dừng log" : "Tiếp tục cập nhật"}
          </button>
          <button className="secondary-button small" onClick={onExport}>
            <Icon name="download" size={15} /> Xuất log
          </button>
        </div>
      </div>
      <pre
        id="peer-log"
        className="log-console"
        ref={logPane}
        tabIndex={0}
        aria-label="Nội dung nhật ký peer"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop > 0 && pausedLogs === null)
            setPausedLogs(logs);
        }}
      >
        {visibleLogs.length
          ? visibleLogs.join("\n")
          : "Chưa có sự kiện. Kết nối để bắt đầu quan sát."}
      </pre>
    </>
  );
}

export function ConnectionDiagnostics({
  peer: p,
  onClose,
}: {
  peer: ReturnType<typeof useWebPeer>;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop diagnostics-backdrop"
      onClick={onClose}
    >
      <section
        className="diagnostics"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="inspector-top">
          <div>
            <span className="eyebrow">THÔNG TIN KẾT NỐI</span>
            <h2 id="diagnostics-title">Tình trạng kết nối</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Đóng chẩn đoán"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="diagnostic-cards">
          <div>
            <Icon name="signal" />
            <span>{p.discovery === "dht" ? "DHT" : "Signaling"}</span>
            <strong>{connectionLabel[p.connection.signaling]}</strong>
            <small>
              {p.discovery === "dht"
                ? p.relayUrls.join(" · ")
                : p.signalUrl}
            </small>
          </div>
          <div>
            <Icon name="link" />
            <span>Relay</span>
            <strong>
              {p.connection.relays}/{p.relayUrls.length} kết nối
            </strong>
            <small>
              {p.connection.activeRelay || "Chưa có đường relay"}
            </small>
          </div>
        </div>
        <p className="diagnostic-note">
          WebRTC: {p.iceSummary.stun} địa chỉ STUN ·{" "}
          {p.iceSummary.turn
            ? p.iceSummary.turn + " địa chỉ TURN"
            : "Chưa cấu hình TURN"}{" "}
          ·{" "}
          {p.iceSummary.policy === "relay"
            ? "Chỉ cho phép TURN"
            : "Cho phép kết nối trực tiếp"}
          . VPN hoặc tường lửa có thể chặn WebRTC dù web vẫn truy cập được.
          Cloudflare Tunnel phục vụ web và relay, không thay thế TURN.
        </p>
        <label className="toggle-setting">
          <span>
            <strong>Ưu tiên relay khi gửi tin</strong>
            <small>
              Dùng để kiểm tra đường truyền; không mô phỏng NAT.
            </small>
          </span>
          <input
            type="checkbox"
            checked={p.forceRelay}
            onChange={(event) => p.toggleForceRelay(event.target.checked)}
          />
        </label>
        {p.target && (
          <div className="connection-action">
            <button
              className="secondary-button"
              disabled={p.checkingDirect || !p.online.includes(p.target)}
              onClick={() => void p.retryDirect()}
            >
              {p.checkingDirect
                ? "Đang thử WebRTC…"
                : "Thử kết nối trực tiếp"}
            </button>
            <button
              className="secondary-button"
              aria-label="Ngắt kênh trực tiếp"
              disabled={!["DIRECT", "TURN"].includes(p.modes[p.target])}
              onClick={p.disconnectDirect}
            >
              Ngắt kênh trực tiếp với {p.nameOf(p.target)}
            </button>
            <p className="diagnostic-note">
              Đóng DataChannel thật để kiểm tra tự chuyển relay. Thao tác
              này không mô phỏng NAT.
            </p>
          </div>
        )}
        <AdvancedPanel peer={p} />
        <PeerLog key={p.peerId} logs={p.logs} onExport={p.exportLogs} />
        <p className="diagnostic-note">
          DIRECT: DataChannel giữa các peer. TURN: DataChannel qua máy chủ
          TURN. RELAY: chuyển tiếp qua server ứng dụng. Đã chuyển tiếp:
          relay đã gửi sang kết nối đích. Đã nhận: peer đích xác nhận đã lưu
          tin, chưa có nghĩa đã đọc. Mỗi lần gửi thử tối đa 3 lần. Chưa xác
          nhận có thể do mất ACK; thử gửi lại giữ cùng ID để tránh trùng.
        </p>
      </section>
    </div>
  );
}
