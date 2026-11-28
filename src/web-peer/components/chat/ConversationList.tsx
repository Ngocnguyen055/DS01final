import { useState } from "react";
import type { useWebPeer } from "../../hooks/useWebPeer.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { UnreadDot } from "./UnreadDot.tsx";

export function ConversationList({
  peer: p,
  onOpenPeer,
  onOpenGroup,
  onOpenDialog,
  onBack,
  onDiagnostics,
  onToggleTheme,
}: {
  peer: ReturnType<typeof useWebPeer>;
  onOpenPeer: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onOpenDialog: (kind: "group" | "peer") => void;
  onBack: () => void;
  onDiagnostics: () => void;
  onToggleTheme: () => void;
}) {
  const [search, setSearch] = useState("");
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
    <aside className="sidebar" id="conversation-sidebar">
      <a
        className="brand"
        href="#"
        aria-label="DS01 P2P Chat"
        onClick={(event) => {
          event.preventDefault();
          onBack();
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
          onClick={() => onOpenDialog("peer")}
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
        <button onClick={() => onOpenDialog("peer")} aria-label="Thêm liên hệ">
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
              onClick={() => onOpenPeer(id)}
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
          <button onClick={() => onOpenDialog("group")} aria-label="Tạo nhóm">
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
              onClick={() => onOpenGroup(group.id)}
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
        onClick={onDiagnostics}
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
          onClick={onToggleTheme}
        >
          <Icon name="moon" size={18} />
        </button>
      </div>
    </aside>
  );
}
