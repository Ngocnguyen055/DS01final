import { fingerprint } from "../../shared/advancedExports.ts";
import { saveDownload } from "../storage/download.ts";
import { usePeerSession } from "./usePeerSession.ts";

export function useWebPeer() {
  const {
    client,
    sync,
    log,
    callStarting,
    setForceRelay,
    setCheckingDirect,
    setDirectReasons,
    setCallStarting,
    setSimulateMediaIceFailure,
    setCall,
    setRelayPolicy,
    ...peer
  } = usePeerSession();
  const {
    target,
    groupTarget,
    peerId,
    logs,
    checkingDirect,
    nameOf,
    setError,
    call,
    groupCall,
  } = peer;

  const toggleForceRelay = (value: boolean) => {
    setForceRelay(value);
    if (client.current) client.current.forceRelay = value;
  };
  const exportLogs = () =>
    saveDownload(
      `ds01-peer-log-${peerId}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
      new Blob([logs.slice().reverse().join("\n")], { type: "text/plain" }),
    );
  const disconnectDirect = () => {
    if (target && !client.current?.disconnectDirect(target))
      setError("Không có kênh trực tiếp đang hoạt động với peer này.");
  };
  const retryDirect = async () => {
    if (!target || !client.current || checkingDirect) return;
    setCheckingDirect(true);
    toggleForceRelay(false);
    try {
      const ready = await client.current.retryDirect(target);
      if (!ready) setDirectReasons((current) => ({
        ...current,
        [target]: "Kênh trực tiếp chưa sẵn sàng. Relay đang duy trì cuộc trò chuyện; xem log để biết quá trình kết nối.",
      }));
    } catch (error) {
      setError(String(error));
    } finally {
      setCheckingDirect(false);
    }
  };
  const verifyPeerKey = async () => {
    try {
      if (!client.current || !target) return;
      const key = await client.current.secure.inspectPeerIdentity(target),
        code = await fingerprint(key);
      if (
        confirm(
          `So sánh mã bảo mật này với ${nameOf(target)} qua một kênh khác:\n${code}\nChỉ xác nhận nếu hai bên thấy cùng mã. Chấp nhận khóa này?`,
        )
      ) {
        await client.current.secure.acceptPeerIdentity(target, key);
        sync.current?.schedule();
        setError("");
        log(`SECURITY_KEY_VERIFIED ${target}`);
      }
    } catch (error) {
      setError(String(error));
    }
  };
  const startCall = async (kind: "audio" | "video") => {
    setCallStarting(true);
    try {
      if (!client.current || (!target && !groupTarget))
        throw Error("Chọn cuộc trò chuyện để gọi.");
      if (groupTarget) await client.current.groupMedia.start(groupTarget, kind);
      else await client.current.media.start(target, kind);
    } catch (error) {
      setError(String(error));
    } finally {
      setCallStarting(false);
    }
  };
  const joinGroupCall = async (roomId: string) => {
    setCallStarting(true);
    try {
      await client.current?.groupMedia.join(roomId);
    } catch (error) {
      setError(String(error));
    } finally {
      setCallStarting(false);
    }
  };
  const leaveGroupCall = async () => {
    await client.current?.groupMedia.leave();
  };
  const muteGroupCall = (kind: "audio" | "video", muted: boolean) =>
    client.current?.groupMedia.mute(kind, muted);
  const resumeGroupAudio = () => client.current?.groupMedia.resumeAudio();
  const dismissGroupCall = () => client.current?.groupMedia.dismiss();
  const callBusy =
    callStarting ||
    (!!call && !["ended", "failed"].includes(call.phase)) ||
    groupCall?.phase === "active" ||
    groupCall?.phase === "joining";
  const toggleMediaIceFailure = (value: boolean) => {
    if (callBusy) return;
    setSimulateMediaIceFailure(value);
    if (client.current) client.current.simulateMediaIceFailure = value;
  };
  const acceptCall = async () => {
    try {
      await client.current?.media.accept();
    } catch (error) {
      setError(String(error));
    }
  };
  const endCall = async () => {
    await client.current?.media.end();
  };
  const muteCall = (kind: "audio" | "video", muted: boolean) =>
    client.current?.media.mute(kind, muted);
  const resumeCallAudio = () => client.current?.media.resumeAudio();
  const selectRelayPolicy = (policy: "priority" | "latency-load") => {
    setRelayPolicy(policy);
    client.current?.setRelaySelection(policy);
  };
  const volunteerSuperPeer = async (url: string) => {
    try {
      await client.current?.volunteerSuperPeer(url);
    } catch (error) {
      setError(String(error));
    }
  };
  return {
    ...peer,
    retryDirect,
    disconnectDirect,
    toggleForceRelay,
    exportLogs,
    callBusy,
    toggleMediaIceFailure,
    joinGroupCall,
    leaveGroupCall,
    muteGroupCall,
    resumeGroupAudio,
    dismissGroupCall,
    startCall,
    acceptCall,
    endCall,
    muteCall,
    resumeCallAudio,
    dismissCall: () => setCall(undefined),
    selectRelayPolicy,
    volunteerSuperPeer,
    verifyPeerKey,
  };
}
