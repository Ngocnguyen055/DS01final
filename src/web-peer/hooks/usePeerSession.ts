import { useEffect, useRef, useState } from "react";
import {
  PeerClient,
  peerIdSchema,
  type Group,
  type PeerEvent,
  type PeerProfile,
} from "@ds01/shared";
import { DEFAULT_ICE_SERVERS } from "../../shared/transport/iceRoute.ts";
import {
  privateCallRecord,
  groupCallRecord,
} from "../storage/callHistory.ts";
import { WebStore } from "../storage/store.ts";
import { authRequest, sessionKey, type LoginSession } from "../account/auth.ts";
import {
  createIdentity,
  decentralizedPeerId,
  fingerprint,
} from "../../shared/advancedExports.ts";
import type { CallState } from "../../shared/media/media.ts";
import type {
  GroupCallRoom,
  GroupCallState,
} from "../../shared/media/groupCallProtocol.ts";
import type { RelaySample } from "../../shared/transport/relaySelection.ts";
import { AccountSync, type AccountSyncState } from "../account/accountSync.ts";
import { useConversations } from "./useConversations.ts";

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
export function usePeerSession() {
  const [peerId, setPeerId] = useState(initialId),
    [displayName, setDisplayName] = useState(
      localStorage.getItem("ds01-display-name") || "",
    );
  const [connection, setConnection] = useState(initialConnection),
    [hasSession, setHasSession] = useState(false),
    [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState<string[]>([]),
    [profiles, setProfiles] = useState<PeerProfile[]>([]),
    [groups, setGroups] = useState<Group[]>([]);
  const [forceRelay, setForceRelay] = useState(false);
  const [modes, setModes] = useState<Record<string, string>>({}),
    [logs, setLogs] = useState<string[]>([]),
    [error, setError] = useState("");
  const [iceSummary, setIceSummary] = useState({
    stun: 0,
    turn: 0,
    policy: "all",
  });
  const [directReasons, setDirectReasons] = useState<Record<string, string>>({}),
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
  const { refresh, resetSending, resetConversations, ...conversations } =
    useConversations({
      client,
      store,
      generation,
      peerId,
      displayName,
      hasSession,
      connected: connection.signaling === "online",
      online,
      profiles,
      groups,
      setError,
      canImportHistory: () => !!accountRef.current,
      onHistoryImported: () => sync.current?.schedule(),
    });
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
    resetSending();
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
          if (event.kind === "message") {
            if (event.message) {
              try {
                store.current.markUnread(event.message);
              } catch (error) {
                log(`Không lưu được trạng thái chưa đọc: ${String(error)}`);
              }
            }
            void refresh();
          }
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
    resetConversations();
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
    setConnection(initialConnection);
    setOnline([]);
    setProfiles([]);
    setDirectReasons({});
    setGroups([]);
    setTransfers([]);
    setModes({});
    setSimulateMediaIceFailure(false);
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
  const connectDht = async () => {
    try {
      await connect(undefined, true);
    } catch (error) {
      setError(String(error));
    }
  };
  return {
    ...conversations,
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
    forceRelay,
    modes,
    iceSummary,
    directReasons,
    checkingDirect,
    logs,
    error,
    setError,
    transfers,
    connect,
    connectDht,
    disconnect,
    signalUrl,
    relayUrls: [relayUrl, ...relayUrls],
    call,
    groupCall,
    groupCalls,
    simulateMediaIceFailure,
    relayMetrics,
    relayPolicy,
    leader,
    discovery,
    encryptionEnabled: encrypted || discovery === "dht",
    securityFingerprint,
    syncState,
    syncNow: () => sync.current?.flush(),
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
  };
}
