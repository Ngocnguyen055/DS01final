import { useCallback, useEffect, useRef, useState } from "react";
import {
  PeerClient,
  isDirectMessageBetween,
  peerIdSchema,
  type Group,
  type StoredMessage,
  type PeerEvent,
  type PeerProfile,
  type ChatAttachment,
  type DirectChatContact,
} from "@ds01/shared";
import { DEFAULT_ICE_SERVERS } from "../shared/iceRoute.ts";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../shared/protocol.ts";
import {
  privateCallRecord,
  groupCallRecord,
  type CallRecord,
} from "./callHistory.ts";
import { WebStore } from "./store.ts";
import { authRequest, sessionKey, type LoginSession } from "./auth.ts";
import {
  createIdentity,
  decentralizedPeerId,
  fingerprint,
} from "../shared/advancedExports.ts";
import type { CallState } from "../shared/media.ts";
import type {
  GroupCallRoom,
  GroupCallState,
} from "../shared/groupCallProtocol.ts";
import type { RelaySample } from "../shared/relaySelection.ts";
import { AccountSync, type AccountSyncState } from "./accountSync.ts";
const signalUrl = import.meta.env.VITE_SIGNAL_URL || "http://localhost:4001";
const relayUrl = import.meta.env.VITE_RELAY_URL || "http://localhost:4002";
const relayUrls = String(import.meta.env.VITE_RELAY_URLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const encrypted = import.meta.env.VITE_E2EE !== "0";
const initialId = localStorage.getItem("ds01-peer-id") || "";
const initialConnection: NonNullable<PeerEvent["connection"]> = {
  signaling: "offline",
  relays: 0,
};
function secretFor(id: string) {
  const key = `ds01-peer-secret-${id}`;
  const previous =
    localStorage.getItem(key) ||
    (localStorage.getItem("ds01-peer-id") === id
      ? localStorage.getItem("ds01-peer-secret")
      : null);
  const secret = previous || crypto.randomUUID() + crypto.randomUUID();
  localStorage.setItem(key, secret);
  return secret;
}
export function saveDownload(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function useWebPeer() {
  const [peerId, setPeerId] = useState(initialId),
    [displayName, setDisplayName] = useState(
      localStorage.getItem("ds01-display-name") || "",
    );
  const [connection, setConnection] = useState(initialConnection),
    [hasSession, setHasSession] = useState(false),
    [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState<string[]>([]),
    [profiles, setProfiles] = useState<PeerProfile[]>([]),
    [contacts, setContacts] = useState<DirectChatContact[]>([]),
    [groups, setGroups] = useState<Group[]>([]);
  const [target, setTarget] = useState(""),
    [groupTarget, setGroupTarget] = useState(""),
    [body, setBodyValue] = useState(""),
    [forceRelay, setForceRelay] = useState(false);
  const [modes, setModes] = useState<Record<string, string>>({}),
    [messages, setMessages] = useState<StoredMessage[]>([]),
    [logs, setLogs] = useState<string[]>([]),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [blocked, setBlocked] = useState<string[]>([]);
  const [iceSummary, setIceSummary] = useState({
    stun: 0,
    turn: 0,
    policy: "all",
  });
  const [calls, setCalls] = useState<CallRecord[]>([]),
    [directReasons, setDirectReasons] = useState<Record<string, string>>({}),
    [checkingDirect, setCheckingDirect] = useState(false);
  const [transfers, setTransfers] = useState<
    NonNullable<PeerEvent["transfer"]>[]
  >([]);
  const [accountSession, setAccountSession] = useState<LoginSession | null>(
      null,
    ),
    [authBusy, setAuthBusy] = useState(!!sessionStorage.getItem(sessionKey));
  const [call, setCall] = useState<CallState>(),
    [relayMetrics, setRelayMetrics] = useState<RelaySample[]>([]),
    [leader, setLeader] = useState<PeerEvent["leader"]>();
  const [groupCall, setGroupCall] = useState<GroupCallState>(),
    [groupCalls, setGroupCalls] = useState<GroupCallRoom[]>([]),
    [callStarting, setCallStarting] = useState(false);
  const [simulateMediaIceFailure, setSimulateMediaIceFailure] = useState(false);
  const [discovery, setDiscovery] = useState<"signaling" | "dht">("signaling"),
    [securityFingerprint, setSecurityFingerprint] = useState("");
  const [relayPolicy, setRelayPolicy] = useState<"priority" | "latency-load">(
    import.meta.env.VITE_RELAY_SELECTION === "priority"
      ? "priority"
      : "latency-load",
  );
  useEffect(() => {
    document.title = hasSession
      ? `DS01 P2P Chat · ${displayName} (${peerId})`
      : "DS01 P2P Chat";
  }, [hasSession, displayName, peerId]);
  const accountRef = useRef<LoginSession | null>(null);
  const sync = useRef<AccountSync | null>(null);
  const syncOpening = useRef<AbortController | null>(null);
  const [syncState, setSyncState] = useState<AccountSyncState>();
  const client = useRef<PeerClient | null>(null),
    store = useRef(new WebStore(initialId)),
    generation = useRef(0);
  const draftRevision = useRef(0);
  const pendingSends = useRef(0);
  const beginSending = () => {
    pendingSends.current++;
    setSending(true);
    return generation.current;
  };
  const finishSending = (version: number) => {
    if (generation.current !== version) return;
    pendingSends.current = Math.max(0, pendingSends.current - 1);
    setSending(pendingSends.current > 0);
    void refresh();
  };
  const setBody = (value: string) => {
    draftRevision.current++;
    setBodyValue(value);
  };
  const refresh = useCallback(async () => {
    const active = store.current;
    try {
      const [rows, savedContacts, blockedPeers] = await Promise.all([
        active.list(),
        active.listDirectContacts(),
        active.listDirectBlocked(),
      ]);
      if (active !== store.current) return;
      setMessages(rows);
      setCalls(active.listCalls());
      setContacts(savedContacts);
      setBlocked(blockedPeers);
    } catch (error) {
      setError(String(error));
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const saved = sessionStorage.getItem(sessionKey);
    if (!saved && sessionStorage.getItem("ds01-dht-active"))
      void connect(undefined, true).catch((error) => setError(String(error)));
    if (saved)
      void (async () => {
        try {
          const token: unknown = JSON.parse(saved).token;
          const response = await authRequest(signalUrl, "auth:session", {
            token,
          });
          if (
            !disposed &&
            typeof token === "string" &&
            response.account &&
            response.expiresAt
          )
            await connect({
              account: response.account,
              token,
              expiresAt: response.expiresAt,
            });
        } catch (error) {
          if (!disposed) {
            sessionStorage.removeItem(sessionKey);
            setError(String(error));
          }
        } finally {
          if (!disposed) setAuthBusy(false);
        }
      })();
    return () => {
      disposed = true;
      generation.current++;
      client.current?.close();
      syncOpening.current?.abort();
      sync.current?.close();
    };
  }, []);
  const log = (text: string) =>
    setLogs((current) =>
      [`${new Date().toISOString()} ${text}`, ...current].slice(0, 250),
    );
  const connect = async (
    identity?: LoginSession,
    decentralized = false,
    password?: string,
  ) => {
    const session = decentralized ? undefined : identity || accountRef.current;
    let activeId = session?.account.peerId || peerId;
    const activeName = session?.account.displayName || displayName;
    let securityStore: WebStore | undefined;
    if (decentralized) {
      securityStore = new WebStore("decentralized-device");
      let device = await securityStore.getIdentity();
      if (!device) {
        device = await createIdentity();
        await securityStore.putIdentity(device);
      }
      activeId = await decentralizedPeerId(device);
      setPeerId(activeId);
    }
    setDiscovery(decentralized ? "dht" : "signaling");
    if (session) {
      accountRef.current = session;
      setAccountSession(session);
      setPeerId(activeId);
      setDisplayName(activeName);
      sessionStorage.setItem(sessionKey, JSON.stringify(session));
    }
    setError("");
    setConnecting(true);
    const version = ++generation.current;
    pendingSends.current = 0;
    setSending(false);
    client.current?.close();
    client.current = null;
    sync.current?.close();
    sync.current = null;
    setSyncState(undefined);
    syncOpening.current?.abort();
    const syncController = new AbortController();
    syncOpening.current = syncController;
    setConnection({ ...initialConnection, signaling: "connecting" });
    setOnline([]);
    setProfiles([]);
    setModes({});
    setTransfers([]);
    try {
      peerIdSchema.parse(activeId);
      if (!activeName.trim() || activeName.trim().length > 80)
        throw new Error("Nhập tên hiển thị từ 1 đến 80 ký tự");
      const iceServers: RTCIceServer[] | undefined = import.meta.env
        .VITE_ICE_SERVERS
        ? JSON.parse(import.meta.env.VITE_ICE_SERVERS)
        : undefined;
      if (
        iceServers &&
        (!Array.isArray(iceServers) ||
          iceServers.some((server) => !server?.urls))
      )
        throw new Error("Cấu hình ICE servers không hợp lệ");
      const urls = (iceServers || DEFAULT_ICE_SERVERS).flatMap((server) =>
        [server.urls].flat(),
      );
      setIceSummary({
        stun: urls.filter((url) => /^stuns?:/.test(url)).length,
        turn: urls.filter((url) => /^turns?:/.test(url)).length,
        policy: import.meta.env.VITE_ICE_POLICY === "relay" ? "relay" : "all",
      });
      store.current = new WebStore(activeId, () => sync.current?.schedule());
      if (session) {
        const accountSync = await AccountSync.open(
          signalUrl,
          session,
          store.current,
          password,
          () =>
            confirm(
              "Tài khoản này đang dùng khóa của phiên bản cũ và chưa có bản sao khóa. Tạo khóa khôi phục cho thiết bị này? Tin đang chờ gửi bằng khóa cũ có thể cần người gửi thử lại. Lịch sử chưa sao lưu vẫn nằm trên thiết bị cũ.",
            ),
          (state) => {
            if (generation.current === version) setSyncState(state);
          },
          () => {
            if (generation.current === version) void refresh();
          },
          syncController.signal,
        );
        if (generation.current !== version) {
          accountSync.close();
          return;
        }
        sync.current = accountSync;
      }
      store.current.recoverCalls();
      await refresh();
      const peer = new PeerClient({
        peerId: activeId,
        displayName: activeName.trim(),
        identityProof: session?.token || secretFor(activeId),
        signalUrl,
        relayUrl,
        relayUrls,
        iceServers,
        rtc: RTCPeerConnection,
        store: store.current,
        forceRelay,
        simulateMediaIceFailure,
        encryption: encrypted || decentralized,
        identityStore: securityStore || store.current,
        discovery: decentralized ? "dht" : "signaling",
        relaySelection: relayPolicy,
        rtcPolicy:
          import.meta.env.VITE_ICE_POLICY === "relay" ? "relay" : "all",
        onEvent: (event) => {
          if (generation.current !== version) return;
          if (event.kind === "call") {
            setCall(event.call);
            const record = event.call && privateCallRecord(event.call);
            if (record && store.current.putCall(record)) void refresh();
          }
          if (event.kind === "group-call") {
            const record = event.groupCall && groupCallRecord(event.groupCall);
            if (record && store.current.putCall(record)) void refresh();
            setGroupCall(event.groupCall);
            setGroupCalls(event.groupCalls || []);
          }
          if (event.kind === "relay-metrics")
            setRelayMetrics(event.relayMetrics || []);
          if (event.kind === "superpeer") setLeader(event.leader);
          if (event.kind === "auth-expired") {
            resetSession();
            setError(
              "Phiên đăng nhập đã hết hạn hoặc đã đăng xuất. Hãy đăng nhập lại.",
            );
            return;
          }
          if (event.kind === "connection" && event.connection) {
            setConnection(event.connection);
            if (event.connection.signaling === "online")
              setGroups(peer.getGroups());
          }
          if (event.kind === "presence") {
            if (event.peers) setOnline(event.peers);
            if (event.profiles) {
              setProfiles(event.profiles);
              for (const profile of event.profiles)
                if (profile.peerId !== activeId)
                  void store.current
                    .saveDirectContact({
                      peerId: profile.peerId,
                      name: profile.displayName,
                      email: "",
                      updatedAt: Date.now(),
                    })
                    .then(refresh)
                    .catch((error) => setError(String(error)));
            }
          }
          if (event.kind === "group" && event.group) {
            setGroups((current) => [
              ...current.filter((group) => group.id !== event.group!.id),
              event.group!,
            ]);
            try {
              const key = `ds01-group-names-${activeId}`;
              const names = JSON.parse(localStorage.getItem(key) || "{}");
              names[event.group.id] =
                event.group.name || `Nhóm ${event.group.id.slice(0, 8)}`;
              localStorage.setItem(key, JSON.stringify(names));
              sync.current?.schedule();
            } catch (error) {
              setError(String(error));
            }
          }
          if (event.kind === "mode" && event.peerId) {
            setModes((current) => ({
              ...current,
              [event.peerId!]: event.mode!,
            }));
            setDirectReasons((current) => ({
              ...current,
              [event.peerId!]: event.mode === "RELAY"
                ? "Tin nhắn đang đi qua relay. Kênh trực tiếp chưa sẵn sàng hoặc đang phục hồi."
                : event.mode === "TURN"
                  ? "Đã thiết lập WebRTC qua TURN."
                  : "Đã thiết lập đường DIRECT.",
            }));
          }
          if (event.kind === "message") void refresh();
          if (event.kind === "log") {
            log(`[${activeId}] ${event.text}`);
            const text = event.text || "",
              failed = text.match(/DIRECT (?:timeout|failed) ([a-zA-Z0-9_-]+)/);
            if (failed)
              setDirectReasons((current) => ({
                ...current,
                [failed[1]]:
                  "WebRTC chưa kết nối được trong thời gian chờ. Relay đang duy trì cuộc trò chuyện; xem log để xác định bước bị dừng.",
              }));
          }
          if (event.kind === "transfer" && event.transfer)
            setTransfers((current) =>
              [
                ...current.filter(
                  (item) =>
                    item.id !== event.transfer!.id ||
                    item.peerId !== event.transfer!.peerId,
                ),
                event.transfer!,
              ].slice(-8),
            );
        },
      });
      client.current = peer;
      await peer.connect();
      if (generation.current !== version) return;
      setHasSession(true);
      if (decentralized) sessionStorage.setItem("ds01-dht-active", "true");
      setSecurityFingerprint(
        await fingerprint(await peer.secure.publicIdentity()),
      );
      localStorage.setItem("ds01-peer-id", activeId);
      localStorage.setItem("ds01-display-name", activeName.trim());
      setGroups(peer.getGroups());
      void refresh();
    } catch (error) {
      if (generation.current === version) {
        client.current?.close();
        client.current = null;
        sync.current?.close();
        sync.current = null;
        accountRef.current = null;
        setAccountSession(null);
        sessionStorage.removeItem(sessionKey);
        setHasSession(false);
        setConnection(initialConnection);
        setError(String(error));
      }
    } finally {
      if (generation.current === version) setConnecting(false);
    }
  };
  const resetSession = () => {
    client.current?.close();
    client.current = null;
    generation.current++;
    sync.current?.close();
    sync.current = null;
    setSyncState(undefined);
    syncOpening.current?.abort();
    syncOpening.current = null;
    pendingSends.current = 0;
    accountRef.current = null;
    setAccountSession(null);
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem("ds01-dht-active");
    setCall(undefined);
    setGroupCall(undefined);
    setGroupCalls([]);
    setCallStarting(false);
    setRelayMetrics([]);
    setLeader(null);
    setSecurityFingerprint("");
    setHasSession(false);
    setConnecting(false);
    setSending(false);
    setConnection(initialConnection);
    setOnline([]);
    setProfiles([]);
    setMessages([]);
    setCalls([]);
    setDirectReasons({});
    setContacts([]);
    setGroups([]);
    setBlocked([]);
    setTransfers([]);
    setModes({});
    setSimulateMediaIceFailure(false);
    setTarget("");
    setGroupTarget("");
    setBody("");
    setLogs([]);
    setPeerId("");
    setDisplayName("");
    store.current = new WebStore("");
  };
  const disconnect = async () => {
    setAuthBusy(true);
    try {
      if (client.current?.media.isActive()) await client.current.media.end();
      if (client.current?.groupMedia.isActive())
        await client.current.groupMedia.leave();
      await sync.current?.flush();
      if (accountRef.current)
        await authRequest(signalUrl, "auth:logout", {
          token: accountRef.current.token,
        });
      resetSession();
      setError("");
    } catch (error) {
      setError(
        `Chưa đăng xuất được trên máy chủ. Hãy thử lại khi có mạng. ${String(error)}`,
      );
    } finally {
      setAuthBusy(false);
    }
  };
  const authenticate = async (
    mode: "login" | "register",
    username: string,
    password: string,
    name: string,
    takeover = false,
  ) => {
    setAuthBusy(true);
    setError("");
    try {
      const response = await authRequest(signalUrl, `auth:${mode}`, {
        username,
        password,
        ...(mode === "register" ? { displayName: name } : { takeover }),
      });
      if (
        mode === "login" &&
        response.account &&
        response.token &&
        response.expiresAt
      )
        await connect(
          {
            account: response.account,
            token: response.token,
            expiresAt: response.expiresAt,
          },
          false,
          password,
        );
      return mode === "register";
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      setAuthBusy(false);
    }
  };
  useEffect(() => {
    if (!accountSession) return;
    const timer = setTimeout(
      () => {
        resetSession();
        setError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.");
      },
      Math.max(0, accountSession.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [accountSession]);
  const send = async () => {
    if (pendingSends.current || !body.trim()) return;
    const text = body;
    const revision = draftRevision.current,
      version = generation.current;
    setError("");
    beginSending();
    try {
      if (!client.current || !hasSession)
        throw new Error("Hãy kết nối trước khi gửi");
      if (groupTarget) {
        const result = await client.current.sendGroup(groupTarget, text);
        const failed = Object.entries(result).filter(
          ([, status]) => status === "rejected",
        );
        if (failed.length && generation.current === version)
          setError(
            `Chưa giao được tới: ${failed.map(([id]) => id).join(", ")}`,
          );
      } else await client.current.sendDirect(target, text);
      if (generation.current === version && draftRevision.current === revision)
        setBody("");
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      finishSending(version);
    }
  };
  const createGroup = async (name: string, members: string) => {
    if (!client.current) throw new Error("Hãy kết nối trước");
    const group = await client.current.createGroup(
      members
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      name,
    );
    setGroupTarget(group.id);
    setTarget("");
    return group;
  };
  const changeGroup = async (memberId: string, action: "add" | "remove") => {
    try {
      if (!client.current) throw new Error("Hãy kết nối trước");
      await client.current.changeGroup(groupTarget, memberId, action);
    } catch (error) {
      setError(String(error));
    }
  };
  const openPeer = async (id: string) => {
    peerIdSchema.parse(id);
    if (id === peerId) throw new Error("Chọn một peer khác");
    if (client.current && connection.signaling === "online")
      await client.current.lookupPeer(id);
    await store.current.saveDirectContact({
      peerId: id,
      name:
        profiles.find((profile) => profile.peerId === id)?.displayName ||
        contacts.find((contact) => contact.peerId === id)?.name ||
        id,
      email: "",
      updatedAt: Date.now(),
    });
    setTarget(id);
    setGroupTarget("");
    await refresh();
  };
  const toggleForceRelay = (value: boolean) => {
    setForceRelay(value);
    if (client.current) client.current.forceRelay = value;
  };
  const retry = async (row: StoredMessage) => {
    const version = beginSending();
    try {
      if (!client.current) throw new Error("Hãy kết nối trước");
      await client.current.retry(row.message.messageId, row.message.receiverId);
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      finishSending(version);
    }
  };
  const sendFile = async (file: File) => {
    const version = beginSending();
    try {
      if (!client.current || (!target && !groupTarget))
        throw new Error("Chọn cuộc trò chuyện để gửi file");
      setError("");
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES)
        throw new Error("File tối đa 20 MiB");
      const data = new Uint8Array(await file.arrayBuffer());
      if (groupTarget)
        await client.current.sendGroupFile(
          groupTarget,
          file.name,
          file.type,
          data,
        );
      else await client.current.sendFile(target, file.name, file.type, data);
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      finishSending(version);
    }
  };
  const downloadFile = async (file: ChatAttachment) => {
    try {
      const saved = await store.current.getFile(file.id);
      if (!saved)
        throw new Error(
          "File chưa có trên thiết bị này. Bản sao tài khoản chỉ chứa tối đa 8 MiB file; hãy tải ở thiết bị đã nhận hoặc nhờ người gửi gửi lại.",
        );
      saveDownload(
        file.name,
        new Blob([new Uint8Array(saved.data).buffer], {
          type: "application/octet-stream",
        }),
      );
    } catch (error) {
      setError(String(error));
    }
  };
  const toggleBlock = async () => {
    if (!target) return;
    try {
      await store.current.setDirectBlocked(target, !blocked.includes(target));
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };
  const deleteHistory = async () => {
    if (!target) return;
    try {
      await store.current.deleteDirect(target);
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };
  const visible = messages.filter((row) =>
    groupTarget
      ? row.message.groupId === groupTarget
      : isDirectMessageBetween(row.message, peerId, target),
  );
  const exportHistory = async () => {
    try {
      const snapshot = await store.current.snapshot();
      saveDownload(
        `ds01-${groupTarget || target || peerId}.json`,
        new Blob(
          [
            JSON.stringify(
              {
                ...snapshot,
                rows: visible,
                calls: calls.filter((call) =>
                  groupTarget
                    ? call.groupId === groupTarget
                    : call.peerId === target,
                ),
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
    } catch (error) {
      setError(String(error));
    }
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
  const connectDht = async () => {
    try {
      await connect(undefined, true);
    } catch (error) {
      setError(String(error));
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
  const importHistory = async (file?: File) => {
    if (!file || !accountRef.current) return;
    try {
      if (file.size > 16 * 1024 * 1024)
        throw Error("File lịch sử vượt 16 MiB.");
      const value: unknown = JSON.parse(await file.text());
      const current = await store.current.snapshot();
      await store.current.restore(
        Array.isArray(value) ? { ...current, rows: value } : value,
      );
      await refresh();
      sync.current?.schedule();
    } catch (error) {
      setError(`Không nhập được lịch sử: ${String(error)}`);
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
  const knownPeers = [
    ...new Set([
      ...online,
      ...contacts.map((contact) => contact.peerId),
      ...messages.flatMap((row) =>
        row.message.groupId
          ? []
          : [row.message.senderId, row.message.receiverId],
      ),
    ]),
  ].filter((id) => id !== peerId);
  const nameOf = (id: string) =>
    profiles.find((profile) => profile.peerId === id)?.displayName ||
    contacts.find((contact) => contact.peerId === id)?.name ||
    (id === peerId ? displayName : id);
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(
      localStorage.getItem(`ds01-group-names-${peerId}`) || "{}",
    );
  } catch {}
  const historyGroups = [
    ...new Set(
      messages
        .map((row) => row.message.groupId)
        .filter((id): id is string => !!id),
    ),
  ]
    .filter((id) => !groups.some((group) => group.id === id))
    .map(
      (id) =>
        ({
          id,
          name: names[id] || `Nhóm ${id.slice(0, 8)}`,
          ownerId: peerId,
          members: [],
          version: 0,
          archived: true,
        }) as Group,
    );
  return {
    peerId,
    setPeerId,
    displayName,
    setDisplayName,
    accountSession,
    authBusy,
    authenticate,
    connection,
    hasSession,
    connecting,
    connected: connection.signaling === "online",
    online,
    groups: [...groups, ...historyGroups],
    target,
    setTarget,
    groupTarget,
    setGroupTarget,
    body,
    setBody,
    forceRelay,
    modes,
    iceSummary,
    directReasons,
    checkingDirect,
    retryDirect,
    calls,
    messages,
    visible,
    logs,
    error,
    setError,
    sending,
    blocked,
    transfers,
    knownPeers,
    nameOf,
    connect,
    connectDht,
    disconnect,
    disconnectDirect,
    send,
    createGroup,
    changeGroup,
    openPeer,
    toggleForceRelay,
    retry,
    sendFile,
    downloadFile,
    toggleBlock,
    deleteHistory,
    exportHistory,
    exportLogs,
    signalUrl,
    relayUrls: [relayUrl, ...relayUrls],
    call,
    groupCall,
    groupCalls,
    callBusy,
    simulateMediaIceFailure,
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
    relayMetrics,
    relayPolicy,
    selectRelayPolicy,
    leader,
    volunteerSuperPeer,
    discovery,
    encryptionEnabled: encrypted || discovery === "dht",
    securityFingerprint,
    syncState,
    importHistory,
    verifyPeerKey,
    syncNow: () => sync.current?.flush(),
  };
}
