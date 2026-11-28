import { useEffect, useState, type FormEvent } from "react";
import { useWebPeer } from "./hooks/useWebPeer.ts";
import { AuthPanel } from "./components/auth/AuthPanel.tsx";
import { CallPanel } from "./components/calls/CallPanel.tsx";
import { GroupCallPanel } from "./components/calls/GroupCallPanel.tsx";
import {
  ConnectionDiagnostics,
  connectionLabel,
} from "./components/connection/ConnectionDiagnostics.tsx";
import { ConversationList } from "./components/chat/ConversationList.tsx";
import { ConversationView } from "./components/chat/ConversationView.tsx";
import { UnreadDot } from "./components/chat/UnreadDot.tsx";
import { Icon } from "./components/Icon.tsx";

export function App() {
  const p = useWebPeer();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [sidebarWidth, setSidebarWidth] = useState(300);
  const [showInspector, setShowInspector] = useState(false),
    [showDiagnostics, setShowDiagnostics] = useState(false),
    [dialog, setDialog] = useState<"group" | "peer" | null>(null),
    [mobileChat, setMobileChat] = useState(false);
  const [groupName, setGroupName] = useState(""),
    [memberText, setMemberText] = useState(""),
    [dialogError, setDialogError] = useState(""),
    [theme, setTheme] = useState(localStorage.getItem("ds01-theme") || "light");
  const activeConversation = p.groupTarget
    ? `group:${p.groupTarget}`
    : p.target
      ? `peer:${p.target}`
      : "";
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 760px)");
    const markRead = () => {
      if (
        p.hasSession &&
        activeConversation &&
        !document.hidden &&
        (!mobile.matches || mobileChat) &&
        !dialog &&
        !showDiagnostics
      )
        p.markConversationRead(activeConversation);
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    window.addEventListener("focus", markRead);
    mobile.addEventListener("change", markRead);
    return () => {
      document.removeEventListener("visibilitychange", markRead);
      window.removeEventListener("focus", markRead);
      mobile.removeEventListener("change", markRead);
    };
  }, [
    p.hasSession,
    p.markConversationRead,
    p.unreadConversations,
    activeConversation,
    mobileChat,
    dialog,
    showDiagnostics,
  ]);
  useEffect(() => {
    if (!dialog && !showDiagnostics) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!modal) return;
    const items = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      ).filter((item) => item.getClientRects().length > 0);
    if (!modal.contains(document.activeElement)) items()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = items();
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    modal.addEventListener("keydown", trap);
    return () => {
      modal.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [dialog, showDiagnostics]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ds01-theme", theme);
  }, [theme]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDialog(null);
        setShowDiagnostics(false);
        setShowInspector(false);
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);
  const selected = !!(p.target || p.groupTarget);
  const openPeer = (id: string) => {
    p.setTarget(id);
    p.setGroupTarget("");
    setMobileChat(true);
  };
  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    setDialogError("");
    try {
      if (dialog === "group")
        await p.createGroup(groupName.trim() || "Nhóm mới", memberText);
      else await p.openPeer(memberText.trim());
      setDialog(null);
      setGroupName("");
      setMemberText("");
      setMobileChat(true);
    } catch (error) {
      setDialogError(String(error));
    }
  };
  const openDialog = (value: "group" | "peer") => {
    if (value === "group" && p.discovery === "dht") {
      p.setError(
        "Chế độ DHT thử nghiệm hỗ trợ hội thoại cá nhân; đăng nhập tài khoản để dùng nhóm.",
      );
      return;
    }
    setDialog(value);
    setMemberText("");
    setGroupName("");
    setDialogError("");
  };
  return (
    <div
      className={`workspace ${p.hasSession ? "is-connected" : "is-signed-out"} ${mobileChat ? "mobile-chat" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": sidebarWidth + "px" } as React.CSSProperties}
    >
      <ConversationList
        peer={p}
        onOpenPeer={openPeer}
        onOpenGroup={(id) => {
          p.setGroupTarget(id);
          p.setTarget("");
          setMobileChat(true);
        }}
        onOpenDialog={openDialog}
        onBack={() => setMobileChat(false)}
        onDiagnostics={() => setShowDiagnostics(true)}
        onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
      />
      {p.hasSession && !sidebarCollapsed && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Đổi độ rộng thanh bên"
          aria-orientation="vertical"
          aria-valuenow={sidebarWidth}
          aria-valuemin={240}
          aria-valuemax={440}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setSidebarWidth((width) =>
                Math.max(
                  240,
                  Math.min(
                    440,
                    width + (event.key === "ArrowRight" ? 20 : -20),
                  ),
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              setSidebarWidth(Math.max(240, Math.min(440, event.clientX)));
          }}
        />
      )}
      <main className="main-panel">
        <header className="topbar">
          {p.hasSession && (
            <button
              className="icon-button sidebar-toggle"
              aria-label={
                sidebarCollapsed ? "Mở thanh bên" : "Thu gọn thanh bên"
              }
              aria-expanded={!sidebarCollapsed}
              aria-controls="conversation-sidebar"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Icon name="sidebar" size={18} />
              {p.unreadConversations.length > 0 && <UnreadDot />}
            </button>
          )}
          <div className="breadcrumb">
            <span>DS01 P2P Chat</span>
            <span>/</span>
            <strong>Tin nhắn</strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection-pill ${p.connected ? "is-online" : ""}`}
            >
              <i />
              {connectionLabel[p.connection.signaling]}
            </span>
            {p.hasSession && (
              <button
                className="icon-button"
                aria-label="Đăng xuất"
                disabled={p.authBusy}
                onClick={() => void p.disconnect()}
              >
                <Icon name="logout" size={18} />
              </button>
            )}
          </div>
        </header>
        {p.error && (
          <div className="error-banner" role="alert">
            <Icon name="info" size={18} />
            <span>{p.error}</span>
            <button
              className="icon-button"
              aria-label="Đóng thông báo"
              onClick={() => p.setError("")}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {!p.hasSession && (
          <section className="welcome">
            <div className="welcome-intro">
              <h2>DS01 P2P Chat</h2>
              <p>Trò chuyện cá nhân và nhóm, gọi thoại hoặc video, gửi file.</p>
              <p className="welcome-note">
                {p.encryptionEnabled
                  ? "Tin nhắn và file được mã hóa đầu cuối."
                  : "Mã hóa đầu cuối đang tắt."}
              </p>
            </div>
            <AuthPanel peer={p} />
          </section>
        )}
        {p.hasSession && !selected && (
          <section className="empty-chat">
            <div className="empty-art">
              <Icon name="chat" size={36} />
            </div>
            <h2>Chọn một cuộc trò chuyện</h2>
            <p>
              Chọn một người hoặc nhóm trong danh sách, hoặc mở hội thoại mới.
            </p>
            <div className="empty-actions">
              <button
                className="primary-button"
                onClick={() => openDialog("peer")}
              >
                <Icon name="plus" /> Hội thoại mới
              </button>
              <button
                className="secondary-button"
                onClick={() => openDialog("group")}
              >
                <Icon name="users" /> Tạo nhóm
              </button>
            </div>
            <div className="network-summary">
              <span>
                <b>{p.online.filter((id) => id !== p.peerId).length}</b> người
                trực tuyến
              </span>
              <span>
                <b>{p.connection.relays}</b> relay kết nối
              </span>
              <span>
                <b>{p.groups.length}</b> nhóm
              </span>
            </div>
          </section>
        )}
        {p.hasSession && selected && (
          <ConversationView
            peer={p}
            showInspector={showInspector}
            setShowInspector={setShowInspector}
            memberText={memberText}
            setMemberText={setMemberText}
            onBack={() => setMobileChat(false)}
          />
        )}
        <footer className="app-footer">
          <span>DS01 P2P Chat</span>
          <button onClick={() => setShowDiagnostics(true)}>
            Xem kết nối <Icon name="signal" size={13} />
          </button>
        </footer>
      </main>
      {(!p.call || ["ended", "failed"].includes(p.call.phase)) && (
        <GroupCallPanel
          call={p.groupCall}
          title={
            p.groups.find((group) => group.id === p.groupCall?.room.groupId)
              ?.name || "Cuộc gọi nhóm"
          }
          name={p.nameOf}
          join={p.joinGroupCall}
          leave={p.leaveGroupCall}
          mute={p.muteGroupCall}
          resumeAudio={p.resumeGroupAudio}
          dismiss={p.dismissGroupCall}
          busy={p.callBusy}
        />
      )}
      {(!p.groupCall ||
        (p.call && !["ended", "failed"].includes(p.call.phase))) && (
        <CallPanel
          call={p.call}
          name={p.nameOf}
          accept={p.acceptCall}
          end={p.endCall}
          mute={p.muteCall}
          resumeAudio={p.resumeCallAudio}
          dismiss={p.dismissCall}
        />
      )}
      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              aria-label="Đóng"
              onClick={() => setDialog(null)}
            >
              <Icon name="close" />
            </button>
            <span className="form-icon">
              <Icon name={dialog === "group" ? "users" : "chat"} size={24} />
            </span>
            <h2 id="dialog-title">
              {dialog === "group" ? "Tạo nhóm" : "Hội thoại mới"}
            </h2>
            <p>
              {dialog === "group"
                ? "Mời các peer bằng ID. Bạn sẽ là chủ nhóm."
                : "Nhập Peer ID để mở hội thoại, kể cả khi peer đang offline."}
            </p>
            <form onSubmit={(event) => void submitDialog(event)}>
              {dialog === "group" && (
                <label>
                  Tên nhóm
                  <input
                    autoFocus
                    required
                    maxLength={80}
                    placeholder="Ví dụ: Nhóm Hệ thống phân tán"
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                  />
                </label>
              )}
              <label>
                {dialog === "group" ? "Peer ID thành viên" : "Peer ID"}
                <input
                  autoFocus={dialog === "peer"}
                  required
                  placeholder={dialog === "group" ? "peer-b, peer-c" : "peer-b"}
                  value={memberText}
                  onChange={(event) => setMemberText(event.target.value)}
                />
              </label>
              {dialogError && (
                <p className="form-error" role="alert">
                  {dialogError}
                </p>
              )}
              <button className="primary-button">
                {dialog === "group" ? "Tạo nhóm" : "Mở hội thoại"}
                <Icon name="plus" size={18} />
              </button>
            </form>
          </section>
        </div>
      )}
      {showDiagnostics && (
        <ConnectionDiagnostics
          peer={p}
          onClose={() => setShowDiagnostics(false)}
        />
      )}
    </div>
  );
}
