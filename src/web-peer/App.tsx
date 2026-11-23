import { useEffect, useRef, useState, type FormEvent } from "react";
import type { StoredMessage } from "@ds01/shared";
import { useWebPeer } from "./useWebPeer.ts";
import { AuthPanel } from "./AuthPanel.tsx";
import { CallPanel } from "./CallPanel.tsx";
import { GroupCallPanel } from "./GroupCallPanel.tsx";
import type { CallRecord } from "./callHistory.ts";
import { chatTimeline } from "./chatTimeline.ts";
import { MAX_GROUP_CALL_PEERS } from "../shared/groupCallProtocol.ts";
import { AdvancedPanel } from "./AdvancedPanel.tsx";
import { Icon } from "./Icon.tsx";
function UnreadDot() {
  return (
    <span
      className="unread-dot"
      role="img"
      aria-label="Có tin nhắn chưa đọc"
      title="Có tin nhắn chưa đọc"
    />
  );
}
function Avatar({
  name,
  online,
  group = false,
}: {
  name: string;
  online?: boolean;
  group?: boolean;
}) {
  const words = name.trim().split(/\s+/);
  const initials =
    words.length > 1
      ? `${words[0][0] || ""}${words.at(-1)?.[0] || ""}`
      : name.slice(0, 2);
  return (
    <span className={`avatar ${group ? "group-avatar" : ""}`}>
      {group ? <Icon name="users" /> : initials.toLocaleUpperCase()}
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
const statusLabel: Record<string, string> = {
  pending: "Đang chuẩn bị",
  queued: "Relay đã lưu · chờ peer online",
  sent: "Đã gửi · chờ xác nhận",
  forwarded: "Đã chuyển tiếp · chờ xác nhận",
  delivered: "Đã nhận",
  failed: "Chưa xác nhận",
  received: "Đã nhận",
};
const connectionLabel = {
  offline: "Chưa kết nối",
  connecting: "Đang kết nối",
  reconnecting: "Đang kết nối lại",
  online: "Đang trực tuyến",
};
const routeLabel = (row: StoredMessage) =>
  row.status === "pending" ? "Đang chọn đường" : row.message.mode;
const clock = (time: number) =>
  new Date(time).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
function CallHistoryEntry({ call }: { call: CallRecord }) {
  const labels = {
    ongoing: "Đang diễn ra",
    completed: "Đã kết thúc",
    missed: "Cuộc gọi nhỡ",
    unanswered: "Không trả lời",
    failed: "Không kết nối được",
    interrupted: "Bị gián đoạn khi rời trang",
  };
  const seconds =
    call.outcome === "completed" && call.connectedAt && call.endedAt
      ? Math.max(0, Math.floor((call.endedAt - call.connectedAt) / 1000))
      : undefined;
  return (
    <article
      className={"call-history-entry " + call.outcome}
      aria-label="Lịch sử cuộc gọi"
    >
      <Icon name={call.kind === "video" ? "video" : "phone"} size={20} />
      <div>
        <strong>
          {call.direction === "group"
            ? "Cuộc gọi nhóm"
            : call.direction === "outgoing"
              ? "Cuộc gọi đi"
              : "Cuộc gọi đến"}{" "}
          · {call.kind === "video" ? "Video" : "Thoại"}
        </strong>
        <small>
          {labels[call.outcome]}
          {seconds !== undefined &&
            ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
          {call.route && " · " + call.route}
        </small>
      </div>
      <time dateTime={new Date(call.startedAt).toISOString()}>
        {new Date(call.startedAt).toLocaleDateString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
        })}{" "}
        {clock(call.startedAt)}
      </time>
    </article>
  );
}
export function App() {
  const p = useWebPeer();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [sidebarWidth, setSidebarWidth] = useState(300);
  const [search, setSearch] = useState(""),
    [showInspector, setShowInspector] = useState(false),
    [showDiagnostics, setShowDiagnostics] = useState(false),
    [dialog, setDialog] = useState<"group" | "peer" | null>(null),
    [mobileChat, setMobileChat] = useState(false);
  const [groupName, setGroupName] = useState(""),
    [memberText, setMemberText] = useState(""),
    [dialogError, setDialogError] = useState(""),
    [theme, setTheme] = useState(localStorage.getItem("ds01-theme") || "light");
  const end = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null);
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
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]",
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
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [p.visible.length, p.calls.length, p.target, p.groupTarget]);
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
  const group = p.groups.find((group) => group.id === p.groupTarget),
    selected = !!(p.target || p.groupTarget),
    title =
      group?.name ||
      (p.groupTarget
        ? `Nhóm ${p.groupTarget.slice(0, 8)}`
        : p.nameOf(p.target));
  const canWrite =
    p.hasSession &&
    selected &&
    !p.blocked.includes(p.target) &&
    (!p.groupTarget ||
      (!!group?.members.includes(p.peerId) && !group.archived));
  const groupRoom = p.groupCalls.find((room) => room.groupId === p.groupTarget);
  const openPeer = (id: string) => {
    p.setTarget(id);
    p.setGroupTarget("");
    setMobileChat(true);
  };
  const bubbles: {
    rows: StoredMessage[];
    key: string;
  }[] = [];
  for (const row of p.visible) {
    const key = `${row.message.senderId}:${row.message.messageId}`;
    const prior = bubbles.find((bubble) => bubble.key === key);
    if (prior) prior.rows.push(row);
    else bubbles.push({ key, rows: [row] });
  }
  const timeline = chatTimeline(
    bubbles,
    p.calls.filter((call) =>
      p.groupTarget ? call.groupId === p.groupTarget : call.peerId === p.target,
    ),
  );
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
  const preview = (id: string) => {
    const last = p.messages
      .filter(
        (row) =>
          !row.message.groupId &&
          (row.message.senderId === id || row.message.receiverId === id),
      )
      .at(-1);
    return last?.message.type === "attachment"
      ? "File đính kèm"
      : last?.message.body ||
          (p.online.includes(id) ? "Đang trực tuyến" : "Chưa có tin nhắn");
  };
  return (
    <div
      className={`workspace ${p.hasSession ? "is-connected" : "is-signed-out"} ${mobileChat ? "mobile-chat" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": sidebarWidth + "px" } as React.CSSProperties}
    >
      <aside className="sidebar" id="conversation-sidebar">
        <a
          className="brand"
          href="#"
          aria-label="DS01 P2P Chat"
          onClick={(event) => {
            event.preventDefault();
            setMobileChat(false);
          }}
        >
          <span className="brand-mark">
            <Icon name="chat" size={18} />
          </span>
          <span>DS01</span>
          <span className="edition">P2P Chat</span>
        </a>
        <div className="sidebar-heading">
          <div>
            <h1>Cuộc trò chuyện</h1>
          </div>
          <button
            className="icon-button filled"
            aria-label="Mở hội thoại mới"
            onClick={() => openDialog("peer")}
          >
            <Icon name="plus" />
          </button>
        </div>
        <label className="search">
          <Icon name="search" size={18} />
          <input
            aria-label="Tìm hội thoại"
            placeholder="Tìm người hoặc nhóm…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="list-heading">
          <span>
            TIN NHẮN <b>{p.knownPeers.length}</b>
          </span>
          <button onClick={() => openDialog("peer")} aria-label="Thêm liên hệ">
            <Icon name="plus" size={16} />
          </button>
        </div>
        <nav className="conversation-list" aria-label="Danh sách hội thoại">
          {p.knownPeers
            .filter((id) =>
              `${id} ${p.nameOf(id)}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((id) => (
              <button
                key={id}
                aria-pressed={p.target === id && !p.groupTarget}
                className={`conversation ${p.target === id && !p.groupTarget ? "selected" : ""}`}
                onClick={() => openPeer(id)}
              >
                <Avatar name={p.nameOf(id)} online={p.online.includes(id)} />
                <span className="conversation-copy">
                  <strong>{p.nameOf(id)}</strong>
                  <small>{preview(id)}</small>
                </span>
                {p.blocked.includes(id) ? (
                  <Icon name="shield" size={15} />
                ) : p.modes[id] === "DIRECT" ? (
                  <span className="tiny-direct" title="Kết nối trực tiếp" />
                ) : null}
                {p.unreadConversations.includes(`peer:${id}`) && <UnreadDot />}
              </button>
            ))}
          {!p.knownPeers.length && (
            <p className="sidebar-empty">
              Chưa có cuộc trò chuyện.
              <br />
              Thêm liên hệ bằng Peer ID.
            </p>
          )}
          <div className="list-heading groups-heading">
            <span>
              NHÓM <b>{p.groups.length}</b>
            </span>
            <button onClick={() => openDialog("group")} aria-label="Tạo nhóm">
              <Icon name="plus" size={16} />
            </button>
          </div>
          {p.groups
            .filter((group) =>
              `${group.name || ""} ${group.id}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((group) => (
              <button
                key={group.id}
                aria-pressed={p.groupTarget === group.id}
                className={`conversation ${p.groupTarget === group.id ? "selected" : ""}`}
                onClick={() => {
                  p.setGroupTarget(group.id);
                  p.setTarget("");
                  setMobileChat(true);
                }}
              >
                <Avatar name="" group />
                <span className="conversation-copy">
                  <strong>
                    {group.name || `Nhóm ${group.id.slice(0, 8)}`}
                  </strong>
                  <small>
                    {group.members.includes(p.peerId)
                      ? `${group.members.length} thành viên`
                      : "Bạn đã rời nhóm"}
                  </small>
                </span>
                {p.unreadConversations.includes(`group:${group.id}`) && (
                  <UnreadDot />
                )}
              </button>
            ))}
        </nav>
        <button
          className="diagnostics-link"
          onClick={() => setShowDiagnostics(true)}
        >
          <Icon name="signal" size={18} />
          <span>Tình trạng kết nối</span>
          <span className={`status-dot ${p.connected ? "live" : ""}`} />
        </button>
        <div className={`self-profile ${p.hasSession ? "" : "guest-profile"}`}>
          {p.hasSession && (
            <>
              <Avatar name={p.displayName} online={p.connected} />
              <span>
                <strong>{p.displayName}</strong>
                <small>{p.peerId}</small>
              </span>
            </>
          )}
          <button
            className="icon-button"
            aria-label="Đổi giao diện sáng tối"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            <Icon name="moon" size={18} />
          </button>
        </div>
      </aside>
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
          <div className="chat-layout">
            <section className="chat-panel">
              <header className="chat-header">
                <button
                  className="icon-button mobile-back"
                  aria-label="Về danh sách"
                  onClick={() => setMobileChat(false)}
                >
                  <Icon name="arrow" />
                  {p.unreadConversations.length > 0 && <UnreadDot />}
                </button>
                <Avatar
                  name={title}
                  group={!!p.groupTarget}
                  online={
                    p.groupTarget ? undefined : p.online.includes(p.target)
                  }
                />
                <div className="chat-title">
                  <h2>{title}</h2>
                  <span>
                    {p.groupTarget
                      ? `${group?.members.length || 0} thành viên`
                      : p.online.includes(p.target)
                        ? "Đang trực tuyến"
                        : "Ngoại tuyến"}
                    {p.target && p.modes[p.target] && (
                      <b
                        className={`mode-label ${p.modes[p.target] === "DIRECT" ? "direct" : ""}`}
                      >
                        {p.modes[p.target]}
                      </b>
                    )}
                  </span>
                </div>
                <span className="call-buttons">
                  <button
                    className="icon-button"
                    aria-label={p.groupTarget ? "Gọi thoại nhóm" : "Gọi thoại"}
                    title={p.groupTarget ? "Gọi thoại nhóm" : "Gọi thoại"}
                    disabled={
                      p.callBusy ||
                      !p.connected ||
                      !canWrite ||
                      !!groupRoom ||
                      (!!p.target && !p.online.includes(p.target))
                    }
                    onClick={() => void p.startCall("audio")}
                  >
                    <Icon name="phone" />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={p.groupTarget ? "Gọi video nhóm" : "Gọi video"}
                    title={p.groupTarget ? "Gọi video nhóm" : "Gọi video"}
                    disabled={
                      p.callBusy ||
                      !p.connected ||
                      !canWrite ||
                      !!groupRoom ||
                      (!!p.target && !p.online.includes(p.target))
                    }
                    onClick={() => void p.startCall("video")}
                  >
                    <Icon name="video" />
                  </button>
                </span>
                <button
                  className={`icon-button ${showInspector ? "active" : ""}`}
                  aria-label="Thông tin hội thoại"
                  onClick={() => setShowInspector(!showInspector)}
                >
                  <Icon name="info" />
                </button>
              </header>
              {groupRoom && (
                <div className="group-call-banner">
                  <span>
                    {groupRoom.kind === "video"
                      ? "Cuộc gọi video"
                      : "Cuộc gọi thoại"}{" "}
                    đang diễn ra · {groupRoom.participants.length} người
                  </span>
                  <button
                    className="secondary-button small"
                    disabled={
                      p.callBusy ||
                      groupRoom.participants.length >= MAX_GROUP_CALL_PEERS
                    }
                    onClick={() => void p.joinGroupCall(groupRoom.roomId)}
                  >
                    {p.groupCall?.room.roomId === groupRoom.roomId &&
                    p.groupCall.phase === "active"
                      ? "Đang tham gia"
                      : groupRoom.participants.length >= MAX_GROUP_CALL_PEERS
                        ? "Đã đủ người"
                        : "Tham gia"}
                  </button>
                </div>
              )}
              {p.blocked.includes(p.target) && (
                <div className="notice">
                  Bạn đang chặn peer này.{" "}
                  <button onClick={() => void p.toggleBlock()}>Bỏ chặn</button>
                </div>
              )}
              {p.target && p.modes[p.target] === "RELAY" && (
                <div className="route-explanation">
                  <span>
                    {p.forceRelay
                      ? "Bạn đang bật chế độ ưu tiên relay."
                      : p.directReasons[p.target] ||
                        "WebRTC chưa thiết lập được đường trực tiếp. Tin nhắn vẫn được chuyển qua relay mã hóa."}
                  </span>
                  <button
                    className="secondary-button small"
                    disabled={p.checkingDirect || !p.online.includes(p.target)}
                    onClick={() => void p.retryDirect()}
                  >
                    {p.checkingDirect
                      ? "Đang thử WebRTC…"
                      : "Thử kết nối trực tiếp"}
                  </button>
                </div>
              )}
              <div className="messages" role="log" aria-label="Tin nhắn">
                <div className="conversation-start">
                  <span className="day-divider">Lịch sử hội thoại</span>
                </div>
                {timeline.map((entry) => {
                  if (entry.type === "call")
                    return (
                      <CallHistoryEntry
                        key={"call-" + entry.call.id}
                        call={entry.call}
                      />
                    );
                  const { rows, key } = entry.bubble,
                    index = bubbles.indexOf(entry.bubble);
                  const row = rows[0],
                    m = row.message,
                    mine = m.senderId === p.peerId,
                    delivered = rows.filter(
                      (row) => row.status === "delivered",
                    ).length,
                    failed = rows.filter((row) => row.status === "failed");
                  const state = !mine
                    ? row.status
                    : failed.length
                      ? "failed"
                      : delivered === rows.length
                        ? "delivered"
                        : rows.some((item) => item.status === "pending")
                          ? "pending"
                          : rows.some((item) => item.status === "queued")
                            ? "queued"
                            : rows.some((item) => item.status === "forwarded")
                              ? "forwarded"
                              : "sent";
                  const previous = index
                    ? new Date(
                        bubbles[index - 1].rows[0].message.timestamp,
                      ).toDateString()
                    : "";
                  return (
                    <div key={key}>
                      {new Date(m.timestamp).toDateString() !== previous && (
                        <div className="date-separator">
                          <span>
                            {new Date(m.timestamp).toLocaleDateString("vi-VN", {
                              day: "numeric",
                              month: "long",
                            })}
                          </span>
                        </div>
                      )}
                      <article className={`message-row ${mine ? "mine" : ""}`}>
                        {!mine && <Avatar name={p.nameOf(m.senderId)} />}
                        <div className="message-stack">
                          {!mine && p.groupTarget && (
                            <span className="sender-name">
                              {p.nameOf(m.senderId)}
                            </span>
                          )}
                          <div className="bubble">
                            {m.body && <p>{m.body}</p>}
                            {m.attachments?.map((file) => (
                              <button
                                className="attachment"
                                key={file.id}
                                onClick={() => void p.downloadFile(file)}
                              >
                                <span className="file-symbol">
                                  <Icon name="file" size={24} />
                                </span>
                                <span>
                                  <strong>{file.name}</strong>
                                  <small>
                                    {(file.size / 1024).toFixed(1)} KiB · Tải về
                                  </small>
                                </span>
                                <Icon name="download" size={18} />
                              </button>
                            ))}
                          </div>
                          <div
                            className={`message-meta ${state === "failed" ? "failed" : ""}`}
                          >
                            <time>{clock(m.timestamp)}</time>
                            <span className="route-tag">
                              {[...new Set(rows.map(routeLabel))].join(" / ")}
                            </span>
                            {mine && (
                              <>
                                <Icon
                                  name={
                                    state === "delivered"
                                      ? "check"
                                      : state === "failed"
                                        ? "info"
                                        : "dots"
                                  }
                                  size={13}
                                />
                                <span>
                                  {rows.length > 1
                                    ? `${delivered}/${rows.length} đã nhận`
                                    : statusLabel[state]}
                                </span>
                              </>
                            )}
                            <details>
                              <summary>Chi tiết</summary>
                              <div className="message-details">
                                <span>ID: {m.messageId}</span>
                                <span>
                                  Sequence: {m.sequence} · Session:{" "}
                                  {m.sessionId}
                                </span>
                                <span>Lamport: {m.logicalTime ?? "—"}</span>
                                {rows.map((item) => (
                                  <span key={item.message.receiverId}>
                                    {item.message.receiverId}:{" "}
                                    {statusLabel[item.status]} ·{" "}
                                    {routeLabel(item)}
                                  </span>
                                ))}
                              </div>
                            </details>
                          </div>
                          {mine && failed.length > 0 && m.type === "text" && (
                            <button
                              className="retry-link"
                              disabled={p.sending}
                              onClick={() =>
                                void Promise.all(
                                  failed.map((item) => p.retry(item)),
                                )
                              }
                            >
                              <Icon name="refresh" size={13} /> Thử gửi lại
                            </button>
                          )}
                        </div>
                      </article>
                    </div>
                  );
                })}
                <div ref={end} />
              </div>
              <div className="composer-area">
                {p.transfers
                  .filter((item) =>
                    p.groupTarget
                      ? group?.members.includes(item.peerId)
                      : item.peerId === p.target,
                  )
                  .slice(-2)
                  .map((item) => (
                    <div
                      className={`transfer-row ${item.status}`}
                      key={item.id + item.peerId}
                    >
                      <Icon name="file" size={16} />
                      <span>
                        {item.name}
                        {p.groupTarget && (
                          <small> · {p.nameOf(item.peerId)}</small>
                        )}
                      </span>
                      <small>
                        {item.status === "complete"
                          ? "Hoàn tất"
                          : item.status === "failed"
                            ? "Gửi file thất bại"
                            : `${item.progress}%`}
                      </small>
                      <progress value={item.progress} max={100} />
                    </div>
                  ))}
                <form
                  className="composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void p.send();
                  }}
                >
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void p.sendFile(file);
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Gửi file tối đa 20 MiB"
                    title="File tối đa 20 MiB. Người nhận cần trực tuyến."
                    disabled={!canWrite || p.sending}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Icon name="plus" />
                  </button>
                  <textarea
                    aria-label="Nội dung tin nhắn"
                    rows={1}
                    value={p.body}
                    onChange={(event) => p.setBody(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (canWrite) void p.send();
                      }
                    }}
                    placeholder={
                      !canWrite
                        ? "Kết nối hoặc chọn hội thoại hợp lệ để gửi…"
                        : `Viết tin nhắn cho ${title}…`
                    }
                    disabled={!canWrite}
                  />
                  <button
                    type="submit"
                    className="send-button"
                    aria-label="Gửi tin nhắn"
                    disabled={!canWrite || p.sending || !p.body.trim()}
                  >
                    <Icon name={p.sending ? "refresh" : "send"} size={19} />
                  </button>
                </form>
                <div className="composer-note">
                  <span>Enter để gửi · File ≤ 20 MiB</span>
                  <span>
                    <i />
                    {p.forceRelay
                      ? "Ưu tiên relay"
                      : "Ưu tiên kết nối trực tiếp"}
                  </span>
                </div>
              </div>
            </section>
            {showInspector && (
              <aside className="inspector">
                <div className="inspector-top">
                  <strong>Thông tin hội thoại</strong>
                  <button
                    className="icon-button"
                    aria-label="Đóng thông tin"
                    onClick={() => setShowInspector(false)}
                  >
                    <Icon name="close" size={17} />
                  </button>
                </div>
                <div className="inspector-profile">
                  <Avatar name={title} group={!!p.groupTarget} />
                  <h3>{title}</h3>
                  <span>
                    {p.groupTarget ? "Trò chuyện nhóm" : "Hội thoại cá nhân"}
                  </span>
                </div>
                <div className="info-block">
                  <span className="eyebrow">
                    {p.groupTarget ? "THÀNH VIÊN" : "PEER ID"}
                  </span>
                  {p.groupTarget ? (
                    group?.members.map((id) => (
                      <div className="member" key={id}>
                        <Avatar
                          name={p.nameOf(id)}
                          online={p.online.includes(id)}
                        />
                        <span>
                          <strong>{p.nameOf(id)}</strong>
                          <small>
                            {id === group.ownerId ? "Chủ nhóm" : id}
                          </small>
                        </span>
                        {(group.ownerId === p.peerId || id === p.peerId) && (
                          <button
                            className="icon-button"
                            aria-label={`Xóa ${id} khỏi nhóm`}
                            onClick={() => void p.changeGroup(id, "remove")}
                          >
                            <Icon name="close" size={15} />
                          </button>
                        )}
                      </div>
                    ))
                  ) : (
                    <code>{p.target}</code>
                  )}
                  {p.groupTarget && group?.ownerId === p.peerId && (
                    <form
                      className="add-member"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void p.changeGroup(memberText.trim(), "add");
                        setMemberText("");
                      }}
                    >
                      <input
                        aria-label="Peer ID thành viên mới"
                        placeholder="Peer ID mới"
                        value={memberText}
                        onChange={(event) => setMemberText(event.target.value)}
                        required
                      />
                      <button
                        className="icon-button filled"
                        aria-label="Thêm thành viên"
                      >
                        <Icon name="plus" size={18} />
                      </button>
                    </form>
                  )}
                </div>
                <div className="info-block">
                  {p.groupTarget && (
                    <details className="group-delivery">
                      <summary>Thành viên ngoại tuyến</summary>
                      <p>
                        Thành viên ngoại tuyến vẫn ở trong nhóm. Bạn có thể thử
                        gửi lại tin chưa xác nhận khi họ kết nối. Nếu relay bật
                        mailbox, tin có trạng thái “Relay đã lưu” được giữ tối
                        đa 24 giờ để chờ người nhận. Thành viên mới không nhận
                        lại lịch sử cũ.
                      </p>
                    </details>
                  )}
                  <p className="file-storage-note">
                    File tối đa 20 MiB, gửi khi người nhận trực tuyến. Bản sao
                    tài khoản chứa tối đa 8 MiB dữ liệu file; file lớn được giữ
                    trên thiết bị đã gửi hoặc nhận.
                  </p>
                  <span className="eyebrow">TIỆN ÍCH</span>
                  <button className="utility-button" onClick={p.exportHistory}>
                    <Icon name="download" size={17} /> Xuất lịch sử hội thoại
                  </button>
                  {!p.groupTarget && (
                    <>
                      <button
                        className="utility-button"
                        onClick={() => void p.toggleBlock()}
                      >
                        <Icon name="shield" size={17} />
                        {p.blocked.includes(p.target)
                          ? "Bỏ chặn peer"
                          : "Chặn tin nhắn cá nhân"}
                      </button>
                      <button
                        className="utility-button danger"
                        onClick={() => {
                          if (
                            confirm("Xóa lịch sử hội thoại trên thiết bị này?")
                          )
                            void p.deleteHistory();
                        }}
                      >
                        <Icon name="close" size={17} /> Xóa lịch sử cục bộ
                      </button>
                    </>
                  )}
                </div>
                <div className="privacy-note">
                  <Icon name="shield" size={18} />
                  <p>
                    {p.encryptionEnabled
                      ? "Lịch sử lưu cục bộ. Nội dung chat và file được mã hóa đầu cuối; relay vẫn thấy metadata định tuyến."
                      : "Lịch sử lưu cục bộ. Chế độ tương thích chưa bật mã hóa đầu cuối."}
                  </p>
                </div>
              </aside>
            )}
          </div>
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
        <div
          className="modal-backdrop diagnostics-backdrop"
          onClick={() => setShowDiagnostics(false)}
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
                onClick={() => setShowDiagnostics(false)}
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
            <div className="log-heading">
              <strong>Nhật ký peer</strong>
              <button className="secondary-button small" onClick={p.exportLogs}>
                <Icon name="download" size={15} /> Xuất log
              </button>
            </div>
            <pre className="log-console">
              {p.logs.length
                ? p.logs.join("\n")
                : "Chưa có sự kiện. Kết nối để bắt đầu quan sát."}
            </pre>
            <p className="diagnostic-note">
              DIRECT: DataChannel giữa các peer. TURN: DataChannel qua máy chủ
              TURN. RELAY: chuyển tiếp qua server ứng dụng. Đã chuyển tiếp:
              relay đã gửi sang kết nối đích. Đã nhận: peer đích xác nhận đã lưu
              tin, chưa có nghĩa đã đọc. Mỗi lần gửi thử tối đa 3 lần. Chưa xác
              nhận có thể do mất ACK; thử gửi lại giữ cùng ID để tránh trùng.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
