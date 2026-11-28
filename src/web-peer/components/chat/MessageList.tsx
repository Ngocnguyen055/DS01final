import { useEffect, useRef } from "react";
import type { StoredMessage } from "@ds01/shared";
import type { CallRecord } from "../../storage/callHistory.ts";
import { chatTimeline } from "./chatTimeline.ts";
import type { useWebPeer } from "../../hooks/useWebPeer.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";

const statusLabel: Record<string, string> = {
  pending: "Đang chuẩn bị",
  queued: "Relay đã lưu · chờ peer online",
  sent: "Đã gửi · chờ xác nhận",
  forwarded: "Đã chuyển tiếp · chờ xác nhận",
  delivered: "Đã nhận",
  failed: "Chưa xác nhận",
  received: "Đã nhận",
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

export function MessageList({
  peer: p,
}: {
  peer: ReturnType<typeof useWebPeer>;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [p.visible.length, p.calls.length, p.target, p.groupTarget]);
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
  return (
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
  );
}
