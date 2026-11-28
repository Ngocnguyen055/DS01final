import type { Group } from "@ds01/shared";
import type { useWebPeer } from "../../hooks/useWebPeer.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";

export function ConversationInspector({
  peer: p,
  title,
  group,
  memberText,
  setMemberText,
  onClose,
}: {
  peer: ReturnType<typeof useWebPeer>;
  title: string;
  group?: Group;
  memberText: string;
  setMemberText: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="inspector">
      <div className="inspector-top">
        <strong>Thông tin hội thoại</strong>
        <button
          className="icon-button"
          aria-label="Đóng thông tin"
          onClick={onClose}
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
  );
}
