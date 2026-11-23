import { useEffect, useRef, useState } from "react";
import type { CallState } from "../shared/media.ts";
import {
  MAX_GROUP_CALL_PEERS,
  type GroupCallState,
} from "../shared/groupCallProtocol.ts";
import { CallWindow } from "./CallWindow.tsx";
import { Icon } from "./Icon.tsx";

function Participant({
  call,
  name,
  local = false,
  resume,
}: {
  call: Pick<
    CallState,
    "remote" | "remoteFrame" | "phase" | "route" | "audioBlocked"
  >;
  name: string;
  local?: boolean;
  resume: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const stream = call.remote,
      picture = video.current,
      player = audio.current;
    if (picture) {
      picture.srcObject = stream || null;
      if (stream) void picture.play().catch(() => {});
    }
    if (!player || local) return;
    player.srcObject = stream || null;
    let cancelled = false;
    const play = () => {
      if (stream)
        void player
          .play()
          .then(() => {
            if (!cancelled) setBlocked(false);
          })
          .catch(() => {
            if (!cancelled) setBlocked(true);
          });
    };
    play();
    stream?.addEventListener("addtrack", play);
    return () => {
      cancelled = true;
      stream?.removeEventListener("addtrack", play);
      player.pause();
      player.srcObject = null;
    };
  }, [call.remote, local]);
  const labels = {
    incoming: "Đang tham gia",
    calling: "Đang gọi",
    connecting: "Đang kết nối",
    connected: "Đã kết nối",
    ended: "Đã ngắt kết nối",
    failed: "Chưa kết nối được",
  };
  return (
    <div
      className="group-call-tile"
      data-phase={call.phase}
      data-local={local ? "true" : "false"}
    >
      {!local && (
        <audio ref={audio} autoPlay aria-label={"Âm thanh của " + name} />
      )}
      <div className="group-call-picture">
        <video
          ref={video}
          muted
          playsInline
          autoPlay
          hidden={!!call.remoteFrame}
          aria-label={local ? "Camera của bạn" : "Video của " + name}
        />
        {call.remoteFrame && (
          <img
            src={call.remoteFrame}
            alt={"Video của " + name + " qua relay"}
          />
        )}
        {!call.remote && (
          <span className="group-call-placeholder">
            <Icon name="users" size={26} />
          </span>
        )}
      </div>
      <div className="group-call-caption">
        <strong>{local ? "Bạn" : name}</strong>
        <small>
          {local ? "Thiết bị của bạn" : call.route || labels[call.phase]}
        </small>
      </div>
      {!local && (blocked || call.audioBlocked) && (
        <button
          className="secondary-button small"
          onClick={() => {
            resume();
            void audio.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => setBlocked(true));
          }}
        >
          Nghe âm thanh
        </button>
      )}
    </div>
  );
}
export function GroupCallPanel({
  call,
  title,
  name,
  join,
  leave,
  mute,
  resumeAudio,
  dismiss,
  busy,
}: {
  call?: GroupCallState;
  title: string;
  name: (id: string) => string;
  join: (roomId: string) => Promise<void>;
  leave: () => Promise<void>;
  mute: (kind: "audio" | "video", muted: boolean) => void;
  resumeAudio: () => void;
  dismiss: () => void;
  busy: boolean;
}) {
  if (!call) return null;
  const active = call.phase === "active",
    incoming = call.phase === "incoming";
  return (
    <CallWindow
      group
      title={
        (call.room.kind === "video" ? "Video nhóm" : "Thoại nhóm") +
        " · " +
        title
      }
      status={
        incoming
          ? "Cuộc gọi đang diễn ra"
          : active
            ? call.room.participants.length + " người tham gia"
            : call.phase === "failed"
              ? "Mất kết nối"
              : "Đã rời cuộc gọi"
      }
      phase={call.phase}
      kind={call.room.kind}
    >
      {incoming && (
        <p className="call-notice">
          {name(call.room.startedBy)} đã bắt đầu cuộc gọi.{" "}
          {call.room.participants.length} người đang tham gia.
          {call.room.participants.length >= MAX_GROUP_CALL_PEERS &&
            " Cuộc gọi đã đủ người."}
        </p>
      )}
      {active && (
        <div className="group-call-grid">
          <Participant
            call={{ remote: call.local, phase: "connected" }}
            local
            name="Bạn"
            resume={resumeAudio}
          />
          {call.peers.map((peer) => (
            <Participant
              key={peer.peerId}
              call={peer}
              name={name(peer.peerId)}
              resume={resumeAudio}
            />
          ))}
        </div>
      )}
      {active && call.peers.some((peer) => peer.route === "RELAY") && (
        <p className="call-notice">
          Có kết nối qua relay, có mã hóa.
          {call.room.kind === "video" && " Video dùng chất lượng thấp hơn."}
        </p>
      )}
      {active && !call.peers.length && (
        <p className="call-notice">
          Đang chờ thành viên tham gia. Tối đa {MAX_GROUP_CALL_PEERS} người
          trong một cuộc gọi.
        </p>
      )}
      {call.error && <p role="alert">{call.error}</p>}
      <div className="call-actions">
        {incoming && (
          <button
            className="primary-button"
            disabled={
              busy || call.room.participants.length >= MAX_GROUP_CALL_PEERS
            }
            onClick={() => void join(call.room.roomId)}
          >
            <Icon
              name={call.room.kind === "video" ? "video" : "phone"}
              size={16}
            />
            Tham gia
          </button>
        )}
        {active && (
          <>
            <button
              className="secondary-button"
              aria-pressed={call.muted}
              onClick={() => mute("audio", !call.muted)}
            >
              <Icon name="mic" size={16} />
              {call.muted ? "Bật mic" : "Tắt mic"}
            </button>
            {call.room.kind === "video" && (
              <button
                className="secondary-button"
                aria-pressed={call.cameraOff}
                onClick={() => mute("video", !call.cameraOff)}
              >
                <Icon name="video" size={16} />
                {call.cameraOff ? "Bật camera" : "Tắt camera"}
              </button>
            )}
            <button
              className="secondary-button danger"
              onClick={() => void leave()}
            >
              Rời cuộc gọi
            </button>
          </>
        )}
        {!active && (
          <button className="secondary-button" onClick={dismiss}>
            {incoming ? "Để sau" : "Đóng"}
          </button>
        )}
      </div>
    </CallWindow>
  );
}
