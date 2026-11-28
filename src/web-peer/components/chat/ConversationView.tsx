import { useRef } from "react";
import { MAX_GROUP_CALL_PEERS } from "../../../shared/media/groupCallProtocol.ts";
import type { useWebPeer } from "../../hooks/useWebPeer.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { UnreadDot } from "./UnreadDot.tsx";
import { MessageList } from "./MessageList.tsx";
import { ConversationInspector } from "./ConversationInspector.tsx";

export function ConversationView({
  peer: p,
  showInspector,
  setShowInspector,
  memberText,
  setMemberText,
  onBack,
}: {
  peer: ReturnType<typeof useWebPeer>;
  showInspector: boolean;
  setShowInspector: (visible: boolean) => void;
  memberText: string;
  setMemberText: (value: string) => void;
  onBack: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
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
  return (
    <div className="chat-layout">
      <section className="chat-panel">
        <header className="chat-header">
          <button
            className="icon-button mobile-back"
            aria-label="Về danh sách"
            onClick={() => onBack()}
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
        <MessageList peer={p} />
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
        <ConversationInspector
          peer={p}
          title={title}
          group={group}
          memberText={memberText}
          setMemberText={setMemberText}
          onClose={() => setShowInspector(false)}
        />
      )}
    </div>
  );
}
