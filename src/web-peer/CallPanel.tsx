import { useEffect, useRef, useState } from "react";
import type { CallState } from "../shared/media.ts";
import { CallWindow } from "./CallWindow.tsx";
import { Icon } from "./Icon.tsx";

export function CallPanel({
  call,
  name,
  accept,
  end,
  mute,
  resumeAudio,
  dismiss,
}: {
  call?: CallState;
  name: (id: string) => string;
  accept: () => Promise<void>;
  end: () => Promise<void>;
  mute: (kind: "audio" | "video", value: boolean) => void;
  resumeAudio: () => void;
  dismiss: () => void;
}) {
  const local = useRef<HTMLVideoElement>(null),
    remote = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null);
  const [muted, setMuted] = useState(false),
    [cameraOff, setCameraOff] = useState(false),
    [playbackBlocked, setPlaybackBlocked] = useState(false);
  useEffect(() => {
    if (local.current) {
      local.current.srcObject = call?.local || null;
      if (call?.local) void local.current.play().catch(() => {});
    }
  }, [call?.local]);
  useEffect(() => {
    const stream = call?.remote,
      player = audio.current,
      video = remote.current;
    if (video) {
      video.srcObject = stream || null;
      if (stream) void video.play().catch(() => {});
    }
    if (!player) return;
    player.srcObject = stream || null;
    let cancelled = false;
    const play = () => {
      if (stream)
        void player
          .play()
          .then(() => {
            if (!cancelled) setPlaybackBlocked(false);
          })
          .catch(() => {
            if (!cancelled) setPlaybackBlocked(true);
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
  }, [call?.remote]);
  useEffect(() => {
    setMuted(false);
    setCameraOff(false);
    setPlaybackBlocked(false);
  }, [call?.callId]);
  if (!call) return null;
  const active = !["ended", "failed"].includes(call.phase);
  const labels = {
    incoming: "Cuộc gọi đến",
    calling: "Đang gọi",
    connecting: "Đang kết nối",
    connected: "Đã kết nối",
    ended: "Đã kết thúc",
    failed: "Cuộc gọi không thành công",
  };
  const enableAudio = () => {
    resumeAudio();
    void audio.current
      ?.play()
      .then(() => setPlaybackBlocked(false))
      .catch(() => setPlaybackBlocked(true));
  };
  return (
    <CallWindow
      title={
        (call.kind === "video" ? "Video" : "Thoại") + " · " + name(call.peerId)
      }
      status={
        <>
          {labels[call.phase]}
          {call.route && " · " + call.route}
        </>
      }
      phase={call.phase}
      kind={call.kind}
    >
      <audio ref={audio} autoPlay aria-label="Âm thanh từ peer" />
      {call.kind === "audio" && (
        <div className="voice-identity">
          <span>{name(call.peerId).slice(0, 2).toUpperCase()}</span>
          <strong>{name(call.peerId)}</strong>
          <small>{labels[call.phase]}</small>
        </div>
      )}
      <div className="call-videos">
        <video
          ref={remote}
          className="remote-video"
          hidden={!!call.remoteFrame}
          autoPlay
          playsInline
          muted
          aria-label="Video từ peer"
        />
        {call.remoteFrame && (
          <img
            className="remote-video relay-video"
            src={call.remoteFrame}
            alt="Video từ peer qua relay"
          />
        )}
        <video
          ref={local}
          className="local-video"
          autoPlay
          playsInline
          muted
          aria-label="Camera của bạn"
        />
      </div>
      {call.route === "RELAY" && active && (
        <p className="call-notice">
          Cuộc gọi qua relay, có mã hóa.
          {call.kind === "video" && " Video dùng chất lượng thấp hơn."}
        </p>
      )}
      {active && (playbackBlocked || call.audioBlocked) && (
        <button className="primary-button" onClick={enableAudio}>
          Bật âm thanh cuộc gọi
        </button>
      )}
      {call.error && <p role="alert">{call.error}</p>}
      <div className="call-actions">
        {!active && (
          <button className="secondary-button" onClick={dismiss}>
            Đóng cuộc gọi
          </button>
        )}
        {call.phase === "incoming" && (
          <button className="primary-button" onClick={() => void accept()}>
            <Icon name="phone" size={16} />
            Nhận cuộc gọi
          </button>
        )}
        {active && call.phase !== "incoming" && (
          <>
            <button
              className="secondary-button"
              disabled={!call.local}
              aria-pressed={muted}
              onClick={() => {
                const next = !muted;
                setMuted(next);
                mute("audio", next);
              }}
            >
              <Icon name="mic" size={16} />
              {muted ? "Bật mic" : "Tắt mic"}
            </button>
            {call.kind === "video" && (
              <button
                className="secondary-button"
                disabled={!call.local}
                aria-pressed={cameraOff}
                onClick={() => {
                  const next = !cameraOff;
                  setCameraOff(next);
                  mute("video", next);
                }}
              >
                <Icon name="video" size={16} />
                {cameraOff ? "Bật camera" : "Tắt camera"}
              </button>
            )}
          </>
        )}
        {active && (
          <button
            className="secondary-button danger"
            onClick={() => void end()}
          >
            {call.phase === "incoming" ? "Từ chối" : "Kết thúc"}
          </button>
        )}
      </div>
    </CallWindow>
  );
}
