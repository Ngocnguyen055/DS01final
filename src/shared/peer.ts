import { io, type Socket } from "socket.io-client";
import {
  DirectTransport,
  type SignalKind,
  type SignalPacket,
} from "./directTransport.ts";
import { MessageDelivery } from "./messageDelivery.ts";
import { FileTransfer } from "./fileTransfer.ts";
import {
  DEFAULT_PEER_CONNECTION,
  groupSchema,
  peerIdSchema,
  peerDiscoverySchema,
  peerProfileSchema,
  type ChatAttachment,
  type ChatMessage,
  type DeliveryMode,
  type Group,
  type PeerDiscovery,
  type PeerProfile,
} from "./protocol.ts";
import type { PeerConfig, PeerEvent } from "./peerTypes.ts";
import {
  SecureChannel,
  publicIdentitySchema,
  canonical,
  verifyIdentity,
  type PublicIdentity,
} from "./secure.ts";
import {
  accountVaultSchema,
  rotationStatement,
  type AccountVault,
} from "./accountProtocol.ts";
import { RelaySelector } from "./relaySelection.ts";
import {
  createOverlayRecord,
  verifyOverlayRecord,
  superPeerSchema,
  type OverlayRecord,
} from "./overlayProtocol.ts";
import { signIdentity } from "./secure.ts";
import { MediaSession } from "./media.ts";
import type { MediaFrame, MediaLink } from "./mediaProtocol.ts";
import { GroupMediaSession } from "./groupMedia.ts";
import { RelayMedia } from "./relayMedia.ts";
import { SignalingTransportError } from "./signalingErrors.ts";
import type { GroupCallContext, GroupCallRoom } from "./groupCallProtocol.ts";
export type {
  ChatStore,
  DirectChatContact,
  DirectChatStore,
  MessageStatus,
  PeerConfig,
  PeerEvent,
  RTCFactory,
  StoredMessage,
} from "./peerTypes.ts";
type Ack = {
  ok: boolean;
  error?: string;
  token?: string;
  peers?: string[];
  profiles?: PeerProfile[];
  groups?: Group[];
  group?: Group;
  peer?: PeerDiscovery;
  key?: PublicIdentity;
  rotation?: {
    previousKey?: PublicIdentity;
    vault?: AccountVault;
    signature?: string;
  };
  queued?: boolean;
  expiresAt?: number;
  result?: unknown;
  load?: { nodeId: string; peers: number; pending: number };
  leader?: { peerId: string; url: string; leaseUntil: number } | null;
  room?: GroupCallRoom;
  rooms?: GroupCallRoom[];
};
export class PeerClient {
  private started = false;
  readonly peerId: string;
  private signal?: Socket;
  private relays = new Map<string, Socket>();
  private activeRelay?: string;
  private relayWaiters = new Set<() => void>();
  private signalWaiters = new Set<() => void>();
  private signalState: "connecting" | "online" | "reconnecting" | "offline" =
    "offline";
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private registrationRetryTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private signalGeneration = 0;
  private registration?: { generation: number; promise: Promise<void> };
  private cancelConnect?: (error: Error) => void;
  private files: FileTransfer;
  private peers: string[] = [];
  private groups = new Map<string, Group>();
  private groupSnapshots = new Map<string, Group>();
  private directTransport: DirectTransport;
  private delivery: MessageDelivery;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  readonly secure: SecureChannel;
  readonly media: MediaSession;
  readonly groupMedia: GroupMediaSession;
  readonly relaySelector = new RelaySelector();
  private relayToken?: string;
  private advancedTimer?: ReturnType<typeof setInterval>;
  private candidateTimer?: ReturnType<typeof setInterval>;
  private refreshingOverlay = false;
  private dhtRecord?: OverlayRecord;
  forceRelay: boolean;
  simulateMediaIceFailure: boolean;
  disconnectDirect(peerId: string) {
    peerIdSchema.parse(peerId);
    return !this.closed && this.directTransport.disconnect(peerId);
  }
  constructor(private config: PeerConfig) {
    this.peerId = config.peerId;
    this.forceRelay = !!config.forceRelay;
    this.simulateMediaIceFailure = !!config.simulateMediaIceFailure;
    this.secure = new SecureChannel(
      config.peerId,
      async (peerId) => {
        if (config.discovery === "dht") {
          const result = await this.overlayCall("dht:key", peerId);
          return (await verifyOverlayRecord(result.result, true)).identity;
        }
        await this.waitForSignaling();
        const socket = this.signal!,
          generation = this.signalGeneration;
        const response = await this.call(socket, "key:lookup", peerId);
        this.assertSignalingSession(socket, generation);
        if (!response.ok)
          throw Error(
            `${response.error || "security key unavailable"} (peer=${peerId})`,
          );
        const key = publicIdentitySchema.parse(response.key),
          pin = await config.identityStore?.getPin(peerId),
          rotation = response.rotation;
        if (
          pin &&
          canonical(pin) !== canonical(key) &&
          rotation?.signature &&
          rotation.vault &&
          rotation.previousKey &&
          canonical(pin) === canonical(rotation.previousKey)
        ) {
          const vault = accountVaultSchema.parse(rotation.vault);
          if (
            canonical(vault.publicIdentity) === canonical(key) &&
            (await verifyIdentity(
              pin,
              rotationStatement(peerId, vault),
              rotation.signature,
            ))
          )
            await config.identityStore?.putPin(peerId, key);
        }
        return key;
      },
      config.identityStore,
    );
    const mediaOptions = {
      rtc: config.rtc,
      iceServers: config.iceServers,
      policy: config.rtcPolicy,
      devices: config.mediaDevices,
      simulateIceFailure: () => this.simulateMediaIceFailure,
      prepare: async () => {
        if (config.discovery === "dht" || config.encryption) return;
        if (!this.signal?.connected) throw Error("signaling unavailable");
        const response = await this.call(
          this.signal,
          "key:publish",
          await this.secure.publicIdentity(),
        );
        if (!response.ok)
          throw Error(response.error || "cannot publish call security key");
      },
      cipher: (peerId: string, callId: string) =>
        this.secure.mediaCipher(peerId, callId),
      log: (text: string) => this.log(text),
    };
    this.media = new MediaSession({
      ...mediaOptions,
      busy: () => this.groupMedia?.isActive(),
      relay: (peerId, callId) => this.openMediaRelay(peerId, callId),
      send: (to, data) => this.sendSignal(to, "media", data),
      emit: (call) => this.emit({ kind: "call", call }),
    });
    this.groupMedia = new GroupMediaSession({
      peerId: this.peerId,
      devices: config.mediaDevices,
      busy: () => this.media.isActive(),
      control: async (input) => {
        if (config.discovery === "dht" || !this.signal?.connected)
          throw Error("Cuộc gọi nhóm cần kết nối signaling.");
        const response = await this.call(
          this.signal,
          "group-call:control",
          input,
        );
        if (!response.ok)
          throw Error(response.error || "group call unavailable");
        return response;
      },
      create: (_peerId, scope, stream, context, emit) =>
        new MediaSession({
          ...mediaOptions,
          stream: async () => stream,
          driver: (options) => new RelayMedia(options, context),
          relay: (peerId, callId) =>
            this.openMediaRelay(peerId, callId, {
              groupId: scope.groupId,
              roomId: scope.roomId,
            }),
          send: (to, data) =>
            this.sendSignal(to, "media", { ...data, group: scope }),
          emit,
        }),
      emit: (groupCall, groupCalls) =>
        this.emit({ kind: "group-call", groupCall, groupCalls }),
      log: (text) => this.log(text),
    });
    this.directTransport = new DirectTransport({
      peerId: this.peerId,
      rtc: config.rtc,
      iceServers: config.iceServers,
      timeoutMs: config.directTimeoutMs,
      backgroundTimeoutMs: config.directBackgroundTimeoutMs,
      policy: config.rtcPolicy,
      sendSignal: (to, kind, data) => this.sendSignal(to, kind, data),
      onMessage: (raw, expectedSender, route) => {
        void this.receive(raw, route, expectedSender);
      },
      onMode: (peerId, mode) => this.emit({ kind: "mode", peerId, mode }),
      log: (text) => this.log(text),
    });
    this.delivery = new MessageDelivery({
      peerId: this.peerId,
      store: config.store,
      ackTimeoutMs: config.ackTimeoutMs,
      getGroup: (groupId) => this.groups.get(groupId),
      syncProjectGroup: (projectId) => this.syncProjectGroup(projectId),
      authorizeGroup: (groupId, otherPeerId) =>
        this.authorizeGroup(groupId, otherPeerId),
      selectMode: async (receiverId) => {
        if (!this.forceRelay && this.signal?.connected) {
          try {
            if (!(await this.lookupPeer(receiverId)).online) return "RELAY";
          } catch (error) {
            this.log(`lookup failed: ${String(error)} peer=${receiverId}`);
            // A lost lookup ACK does not invalidate an established data path.
            // Explicit authorization errors must still prevent its selection.
            const ready = this.directTransport.availableMode(receiverId);
            if (!this.forceRelay && error instanceof SignalingTransportError && ready)
              return ready;
            return "RELAY";
          }
        }
        return (await this.directTransport.ensure(receiverId, this.forceRelay))
          ? this.directTransport.mode(receiverId)
          : "RELAY";
      },
      transport: (message, mode) => this.transport(message, mode),
      emit: (event) => this.emit(event),
      log: (text) => this.log(text),
      onFileChunk: (message) => this.files.receive(message),
    });
    this.files = new FileTransfer({
      store: config.store,
      sendChunk: (peerId, chunk, groupId) =>
        this.delivery.send(
          peerId,
          "",
          groupId,
          undefined,
          undefined,
          undefined,
          chunk,
        ),
      sendAttachment: (peerId, file) =>
        this.delivery.sendDirectAttachment(peerId, [file]),
      sendGroupAttachment: (groupId, file, recipients) =>
        this.delivery.sendGroup(groupId, "", [file], recipients),
      emit: (event) => this.emit(event),
    });
  }
  private emit(event: PeerEvent) {
    this.config.onEvent(event);
  }
  private log(text: string) {
    this.emit({ kind: "log", text });
  }
  private connection() {
    if (this.config.discovery === "dht" && !this.closed && this.started)
      this.signalState = [...this.relays.values()].some(
        (socket) => socket.connected,
      )
        ? "online"
        : this.signalState === "connecting"
          ? "connecting"
          : "reconnecting";
    for (const check of this.relayWaiters) check();
    for (const check of this.signalWaiters) check();
    this.emit({
      kind: "connection",
      connection: {
        signaling: this.signalState,
        relays: [...this.relays.values()].filter((socket) => socket.connected)
          .length,
        activeRelay: this.activeRelay,
      },
    });
  }
  private async waitForSignaling() {
    if (this.closed) throw new Error("peer disconnected");
    if (this.signal?.connected && this.signalState === "online") return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.signalWaiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.closed) finish(new Error("peer disconnected"));
        else if (this.signal?.connected && this.signalState === "online") finish();
      };
      const timer = setTimeout(
        () => finish(new SignalingTransportError("signaling readiness timeout")),
        this.config.connectionWaitTimeoutMs ?? 8000,
      );
      this.signalWaiters.add(check);
      check();
    });
  }
  private async waitForRelay() {
    if (this.closed) throw new Error("peer disconnected");
    if ([...this.relays.values()].some((socket) => socket.connected)) return;
    this.log("waiting for outbound relay connection");
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.relayWaiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.closed) finish(new Error("peer disconnected"));
        else if ([...this.relays.values()].some((socket) => socket.connected))
          finish();
      };
      const timer = setTimeout(
        () => finish(new Error("relay connection timeout")),
        this.config.requestTimeoutMs ?? 4000,
      );
      this.relayWaiters.add(check);
      check();
    });
  }
  getOnlinePeers() {
    return [...this.peers];
  }
  getGroups() {
    return [...this.groups.values()];
  }
  private applyGroup(raw: unknown): Group {
    const group = groupSchema.parse(raw),
      previous = this.groupSnapshots.get(group.id);
    if (previous && previous.version >= group.version) return previous;
    this.groupSnapshots.set(group.id, group);
    if (group.members.includes(this.peerId)) this.groups.set(group.id, group);
    else this.groups.delete(group.id);
    this.emit({ kind: "group", group });
    this.groupMedia.membership(group);
    return group;
  }
  async lookupPeer(peerId: string): Promise<PeerDiscovery> {
    peerIdSchema.parse(peerId);
    if (this.config.discovery === "dht") {
      const response = await this.overlayCall("dht:lookup", peerId);
      if (!response.result)
        return { peerId, online: false, lastSeen: null, connection: null };
      const record = await verifyOverlayRecord(response.result);
      return {
        peerId: record.peerId,
        online: true,
        lastSeen: record.issuedAt,
        connection: { ...DEFAULT_PEER_CONNECTION },
      };
    }
    if (!this.signal?.connected)
      throw new SignalingTransportError("signaling unavailable");
    const result = await this.call(this.signal, "peer:lookup", { peerId });
    if (!result.ok) throw new Error(result.error || "peer lookup failed");
    const peer = peerDiscoverySchema.parse(result.peer);
    if (peer.peerId !== peerId)
      throw new Error("peer lookup identity mismatch");
    return peer;
  }
  private async call(
    socket: Socket,
    event: string,
    payload: unknown,
  ): Promise<Ack> {
    if (this.closed || !socket.connected)
      throw new SignalingTransportError("connection unavailable");
    return await new Promise((resolve, reject) => {
      socket
        .timeout(this.config.requestTimeoutMs ?? 4000)
        .emit(event, payload, (error: Error | null, result: Ack) =>
          error
            ? reject(new SignalingTransportError(error.message))
            : resolve(result),
        );
    });
  }
  async connect() {
    if (this.started || this.closed)
      throw new Error("Create a new PeerClient after closing a session");
    this.started = true;
    this.closed = false;
    await this.delivery.recover();
    if (this.closed) throw new Error("peer disconnected");
    this.signalState = "connecting";
    this.connection();
    if (this.config.discovery === "dht") {
      try {
        this.dhtRecord = await createOverlayRecord(
          await this.secure.getIdentity(),
          this.config.displayName || this.peerId,
          [this.config.relayUrl, ...(this.config.relayUrls || [])],
          this.config.dhtLeaseMs,
        );
        if (this.dhtRecord.peerId !== this.peerId)
          throw Error("DHT Peer ID must be derived from the signing key");
        for (const url of this.dhtRecord.relayUrls) this.attachRelay(url);
        await this.waitForRelay();
        this.signalState = "online";
        this.connection();
        await this.refreshOverlay();
        this.advancedTimer = setInterval(() => {
          void this.refreshOverlay().catch((error) => this.log(String(error)));
        }, 5000);
        return;
      } catch (error) {
        this.close();
        throw error;
      }
    }
    this.signal = io(this.config.signalUrl, {
      autoConnect: false,
      reconnection: true,
    });
    let ready!: () => void, fail!: (error: Error) => void;
    const initial = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    this.cancelConnect = fail;
    const timer = setTimeout(() => fail(new Error("signaling timeout")), 8000);
    let registrationRetries = 0;
    const register = () => {
      const generation = this.signalGeneration;
      void this.register()
        .then(() => {
          if (this.closed || generation !== this.signalGeneration) return;
          clearTimeout(this.registrationRetryTimer);
          registrationRetries = 0;
          ready();
        })
        .catch((error) => {
          if (this.closed || generation !== this.signalGeneration) return;
          this.log(`register failed: ${String(error)}`);
          if (error instanceof SignalingTransportError) {
            this.signalState = "reconnecting";
            this.connection();
            clearTimeout(this.registrationRetryTimer);
            this.registrationRetryTimer = setTimeout(() => {
              if (
                !this.closed &&
                generation === this.signalGeneration &&
                this.signal?.connected
              )
                register();
            }, Math.min(250 * 2 ** Math.min(registrationRetries++, 4), 4000));
          } else {
            fail(error instanceof Error ? error : new Error(String(error)));
            this.close();
          }
        });
    };
    this.signal.on("connect", () => {
      this.signalGeneration++;
      clearTimeout(this.reconnectTimer);
      clearTimeout(this.registrationRetryTimer);
      registrationRetries = 0;
      this.secure.invalidatePeers();
      register();
    });
    this.signal.on("connect_error", (error) => {
      this.log(`signaling error: ${error.message}`);
      this.signalState = "reconnecting";
      this.connection();
    });
    this.signal.on("auth:expired", () => {
      this.close();
      this.emit({ kind: "auth-expired" });
    });
    this.signal.on("key:changed", (peerId: unknown) => {
      const parsed = peerIdSchema.safeParse(peerId);
      if (parsed.success) this.secure.invalidatePeer(parsed.data);
    });
    this.signal.on("presence", (raw: unknown) => {
      if (this.closed) return;
      const result = peerIdSchema.array().safeParse(raw);
      if (!result.success) {
        this.log("invalid peer presence");
        return;
      }
      this.peers = result.data;
      this.emit({ kind: "presence", peers: this.peers });
    });
    this.signal.on("peer:profiles", (raw: unknown) => {
      if (this.closed) return;
      const result = peerProfileSchema.array().safeParse(raw);
      if (!result.success) {
        this.log("invalid peer profiles");
        return;
      }
      this.peers = result.data.map((peer) => peer.peerId);
      this.emit({ kind: "presence", peers: this.peers, profiles: result.data });
    });
    this.signal.on("group:update", (raw: unknown) => {
      if (this.closed) return;
      try {
        this.applyGroup(raw);
      } catch {
        this.log("invalid group update");
      }
    });
    this.signal.on("group-call:update", (raw: unknown) => {
      if (!this.closed)
        try {
          this.groupMedia.update(raw);
        } catch {
          this.log("invalid group call roster");
        }
    });
    this.signal.on("signal:receive", (packet: SignalPacket) => {
      if (packet.kind === "media") {
        void this.receiveMedia(packet.from, packet.data);
        return;
      }
      void this.directTransport
        .receiveSignal(packet)
        .catch((error: unknown) => this.log(`signal error: ${String(error)}`));
    });
    this.signal.on("disconnect", (reason) => {
      this.signalGeneration++;
      this.registration = undefined;
      clearTimeout(this.registrationRetryTimer);
      this.groupMedia.offline();
      this.log(`signaling disconnected: ${reason}`);
      this.signalState = this.closed ? "offline" : "reconnecting";
      this.peers = [];
      this.emit({ kind: "presence", peers: [], profiles: [] });
      this.connection();
      if (!this.closed && reason === "io server disconnect") {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (!this.closed) this.signal?.connect();
        }, 1000);
      }
    });
    this.signal.connect();
    try {
      await initial;
      if (this.closed) throw new Error("peer disconnected");
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      this.cancelConnect = undefined;
    }
    this.heartbeat = setInterval(() => {
      if (this.signal?.connected) this.signal.emit("peer:heartbeat");
    }, 10000);
    this.refreshTimer = setInterval(
      () => {
        if (this.signal?.connected) register();
      },
      6 * 60 * 60 * 1000,
    );
    if (this.config.relaySelection === "latency-load")
      this.advancedTimer = setInterval(() => {
        void this.probeRelays();
      }, 15000);
  }
  private async register() {
    const socket = this.signal,
      generation = this.signalGeneration;
    if (!socket) throw new SignalingTransportError("signaling unavailable");
    this.assertSignalingSession(socket, generation);
    if (this.registration?.generation === generation)
      return this.registration.promise;
    const promise = this.registerOnce(socket, generation).finally(() => {
      if (this.registration?.promise === promise) this.registration = undefined;
    });
    this.registration = { generation, promise };
    return promise;
  }
  private assertSignalingSession(socket: Socket, generation: number) {
    if (
      this.closed ||
      !socket.connected ||
      this.signal !== socket ||
      generation !== this.signalGeneration
    )
      throw new SignalingTransportError("signaling session changed");
  }
  private async registerOnce(socket: Socket, generation: number) {
    const response = await this.call(socket, "peer:register", {
      peerId: this.peerId,
      identityProof: this.config.identityProof,
      displayName: this.config.displayName || this.peerId,
      status: "online",
      connection: DEFAULT_PEER_CONNECTION,
    });
    this.assertSignalingSession(socket, generation);
    if (!response.ok || !response.token)
      throw new Error(response.error || "registration failed");
    if (this.config.encryption) {
      const identity = await this.secure.publicIdentity();
      this.assertSignalingSession(socket, generation);
      const published = await this.call(socket, "key:publish", identity);
      this.assertSignalingSession(socket, generation);
      if (!published.ok)
        throw Error(published.error || "cannot publish security key");
      this.log("E2EE enabled: ECDH P-256 / HKDF / AES-256-GCM");
    }
    const profiles = peerProfileSchema.array().parse(response.profiles);
    this.peers = profiles.map((peer) => peer.peerId);
    const registeredGroups = groupSchema.array().parse(response.groups || []);
    this.groups.clear();
    for (const raw of registeredGroups) {
      const group = this.applyGroup(raw);
      if (group.members.includes(this.peerId)) this.groups.set(group.id, group);
    }
    this.emit({ kind: "presence", peers: this.peers, profiles });
    for (const group of this.groups.values())
      this.emit({ kind: "group", group });
    for (const socket of this.relays.values()) socket.disconnect();
    this.relays.clear();
    this.activeRelay = undefined;
    this.relayToken = response.token;
    for (const url of [
      ...new Set(
        [this.config.relayUrl, ...(this.config.relayUrls || [])].map((url) =>
          url.replace(/\/$/, ""),
        ),
      ),
    ].slice(0, 4)) {
      this.attachRelay(url);
    }
    this.signalState = "online";
    this.connection();
    void this.groupMedia
      .refresh()
      .catch((error) => this.log("group call discovery: " + String(error)));
  }
  async createGroup(members: string[], name?: string): Promise<Group> {
    if (!this.signal) throw new Error("not connected");
    const result = await this.call(this.signal, "group:create", {
      members,
      name,
    });
    if (!result.ok || !result.group)
      throw new Error(result.error || "group creation failed");
    return this.applyGroup(result.group);
  }
  async syncProjectGroup(projectId: string): Promise<Group> {
    await this.waitForSignaling();
    if (!this.signal?.connected) throw new Error("signaling unavailable");
    const result = await this.call(this.signal, "project:group", { projectId });
    if (!result.ok || !result.group)
      throw new Error(result.error || "project group access denied");
    const group = this.applyGroup(result.group);
    if (group.archived) throw new Error("project archived");
    if (group.projectId !== projectId || !group.members.includes(this.peerId))
      throw new Error("project group access denied");
    return group;
  }
  private async authorizeGroup(groupId: string, otherPeerId: string) {
    await this.waitForSignaling();
    if (!this.signal?.connected)
      throw new Error("group authorization unavailable");
    const result = await this.call(this.signal, "group:authorize", {
      groupId,
      otherPeerId,
    });
    if (!result.ok || !result.group)
      throw new Error(result.error || "group access denied");
    if (result.group.id !== groupId) throw new Error("group identity mismatch");
    const group = this.applyGroup(result.group);
    if (
      group.archived ||
      !group.members.includes(this.peerId) ||
      !group.members.includes(otherPeerId)
    )
      throw new Error("group access denied or archived");
    return group;
  }
  async changeGroup(
    groupId: string,
    memberId: string,
    action: "add" | "remove",
  ): Promise<Group> {
    if (!this.signal) throw new Error("not connected");
    const group = this.groups.get(groupId);
    if (!group) throw new Error("group unknown");
    const result = await this.call(this.signal, "group:change", {
      groupId,
      memberId,
      action,
      version: group.version,
    });
    if (!result.ok || !result.group) {
      if (result.error === "invalid group change or stale version") {
        try {
          await this.authorizeGroup(groupId, this.peerId);
        } catch {
          this.log("group refresh unavailable or membership revoked");
        }
      }
      throw new Error(result.error || "group change failed");
    }
    if (result.group.id !== groupId) throw new Error("group identity mismatch");
    return this.applyGroup(result.group);
  }
  private async sendSignal(to: string, kind: SignalKind, data: unknown) {
    if (this.config.discovery === "dht") {
      await this.overlayCall("overlay:signal", { to, kind, data });
      return;
    }
    if (!this.signal?.connected)
      throw new SignalingTransportError("signaling unavailable");
    const result = await this.call(this.signal, "signal:send", {
      to,
      kind,
      data,
    });
    if (!result.ok) throw new Error(result.error || "signal rejected");
  }
  private async transport(
    message: ChatMessage,
    mode: DeliveryMode,
  ): Promise<void | { queued: true; expiresAt?: number }> {
    const packet = { ...message, mode };

    if (packet.groupId)
      await this.authorizeGroup(packet.groupId, packet.receiverId);
    const wire =
      this.config.encryption || this.config.discovery === "dht"
        ? await this.secure.seal(packet)
        : packet;
    if (mode === "DIRECT" || mode === "TURN") {
      this.directTransport.send(packet.receiverId, wire);
      this.log(`${mode} SEND ${packet.messageId} -> ${packet.receiverId}`);
    } else {
      await this.waitForRelay();
      let failure = "relay unavailable";
      if (
        this.config.relaySelection === "latency-load" &&
        !this.relaySelector.samples.size
      )
        await this.probeRelays();
      const urls =
        this.config.relaySelection === "latency-load"
          ? this.relaySelector.rank([...this.relays.keys()], this.activeRelay)
          : [...this.relays.keys()].sort(
              (a, b) =>
                Number(b === this.activeRelay) - Number(a === this.activeRelay),
            );
      const candidates = urls.map(
        (url) => [url, this.relays.get(url)!] as const,
      );
      for (const [url, socket] of candidates) {
        if (!socket.connected) continue;
        try {
          const response = await this.call(socket, "relay:send", wire);
          if (!response.ok) {
            failure = response.error || "relay rejected";
            continue;
          }
          this.activeRelay = url;
          this.connection();
          this.log(
            `RELAY SEND ${packet.messageId} -> ${packet.receiverId} via ${url}`,
          );
          return response.queued
            ? { queued: true, expiresAt: response.expiresAt }
            : undefined;
        } catch (error) {
          failure = String(error);
          this.log(`relay failover: ${failure}`);
        }
      }
      throw new Error(failure);
    }
  }
  async send(
    receiverId: string,
    body: string,
    groupId?: string | null,
    messageId?: string,
    sequenceOverride?: number,
    attachments?: ChatAttachment[],
  ): Promise<void> {
    return this.delivery.send(
      receiverId,
      body,
      groupId,
      messageId,
      sequenceOverride,
      attachments,
    );
  }

  async sendDirect(receiverId: string, body: string): Promise<void> {
    return this.delivery.sendDirect(receiverId, body);
  }
  async sendDirectAttachment(
    receiverId: string,
    attachments: ChatAttachment[],
    caption = "",
  ): Promise<void> {
    return this.delivery.sendDirectAttachment(receiverId, attachments, caption);
  }
  async sendFile(
    receiverId: string,
    name: string,
    mime: string,
    data: Uint8Array,
  ) {
    peerIdSchema.parse(receiverId);
    if (
      receiverId === this.peerId ||
      (await this.config.store.isDirectBlocked?.(receiverId))
    )
      throw new Error("invalid or blocked recipient");
    return this.files.send(receiverId, name, mime, data);
  }
  async sendGroupFile(
    groupId: string,
    name: string,
    mime: string,
    data: Uint8Array,
  ) {
    const group = await this.authorizeGroup(groupId, this.peerId);
    if (group.archived || !group.members.includes(this.peerId))
      throw Error("Bạn không còn quyền gửi file vào nhóm.");
    return this.files.sendGroup(
      groupId,
      group.members.filter((id) => id !== this.peerId),
      name,
      mime,
      data,
    );
  }
  async retryDirect(peerId: string) {
    return this.directTransport.retry(peerId);
  }
  async retry(messageId: string, receiverId: string) {
    return this.delivery.retry(messageId, receiverId);
  }
  async sendGroup(
    groupId: string,
    body: string,
  ): Promise<Record<string, string>> {
    return this.delivery.sendGroup(groupId, body);
  }

  private async receive(
    raw: unknown,
    mode: DeliveryMode,
    expectedSender?: string,
  ) {
    try {
      const message =
        this.config.encryption || this.config.discovery === "dht"
          ? await this.secure.open(raw)
          : (raw as ChatMessage);
      await this.delivery.receive(message, mode, expectedSender);
      if (mode === "RELAY" && message && typeof message === "object") {
        const rows = await this.config.store.list();
        const accepted =
          message.type === "ack"
            ? rows.some(
                (row) =>
                  row.message.messageId === message.ackFor &&
                  row.message.receiverId === message.senderId &&
                  row.status === "delivered",
              )
            : rows.some(
                (row) =>
                  row.message.messageId === message.messageId &&
                  row.message.senderId === message.senderId &&
                  row.status === "received",
              );
        if (accepted)
          await Promise.allSettled(
            [...this.relays.values()]
              .filter((socket) => socket.connected)
              .map((socket) =>
                this.call(socket, "relay:consumed", {
                  messageId: message.messageId,
                  senderId: message.senderId,
                }),
              ),
          );
      }
    } catch (error) {
      this.log(`secure receive rejected: ${String(error)}`);
    }
  }
  private async openMediaRelay(
    peerId: string,
    callId: string,
    group?: GroupCallContext,
  ): Promise<MediaLink> {
    await this.waitForRelay();
    let stopped = false,
      refreshing = false,
      failure = "";
    const opened = new Set<Socket>(),
      input = { callId, to: peerId, ...(group ? { group } : {}) };
    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        await Promise.allSettled(
          [...this.relays.values()]
            .filter((socket) => socket.connected)
            .map(async (socket) => {
              try {
                const response = await this.call(socket, "media:open", input);
                if (stopped) {
                  if (response.ok)
                    void this.call(socket, "media:close", input).catch(
                      () => {},
                    );
                  return;
                }
                if (response.ok) opened.add(socket);
                else {
                  opened.delete(socket);
                  failure = response.error || "relay rejected the call";
                }
              } catch (error) {
                opened.delete(socket);
                failure = String(error);
              }
            }),
        );
      } finally {
        refreshing = false;
      }
    };
    await refresh();
    if (!opened.size || this.closed) {
      stopped = true;
      for (const socket of opened)
        void this.call(socket, "media:close", input).catch(() => {});
      throw Error(
        "Không mở được relay cuộc gọi. Kiểm tra cả hai thiết bị còn online và cùng mở URL Web mới nhất." +
          (failure ? " Chi tiết: " + failure : ""),
      );
    }
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return {
      send: (frame: MediaFrame) => {
        if (stopped || this.closed) return false;
        const preferred = this.activeRelay && this.relays.get(this.activeRelay);
        const socket =
          preferred && opened.has(preferred) && preferred.connected
            ? preferred
            : [...opened].find((socket) => socket.connected);
        if (
          !socket ||
          socket.io.engine.writeBuffer.length >
            (frame.kind === "audio" ? 16 : 2)
        )
          return false;
        if (frame.kind === "video") socket.volatile.emit("media:frame", frame);
        else socket.emit("media:frame", frame);
        return true;
      },
      close: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        for (const socket of opened)
          void this.call(socket, "media:close", input).catch(() => {});
        opened.clear();
      },
    };
  }
  private attachRelay(url: string) {
    url = url.replace(/\/$/, "");
    if (this.closed || this.relays.has(url)) return;
    const socket = io(url, { autoConnect: false, reconnection: true });
    if (this.config.discovery === "dht")
      socket.auth = (callback) => {
        void (async () => {
          const record = await createOverlayRecord(
            await this.secure.getIdentity(),
            this.config.displayName || this.peerId,
            [this.config.relayUrl, ...(this.config.relayUrls || [])],
            this.config.dhtLeaseMs,
          );
          const proof = {
            connectionId: socket.io.engine.id,
            issuedAt: Date.now(),
            peerId: this.peerId,
          };
          callback({
            dht: {
              record,
              proof: {
                connectionId: proof.connectionId,
                issuedAt: proof.issuedAt,
                signature: await signIdentity(
                  await this.secure.getIdentity(),
                  proof,
                ),
              },
            },
          });
        })().catch((error) => {
          this.log(String(error));
          callback({});
        });
      };
    else socket.auth = { token: this.relayToken };
    this.relays.set(url, socket);
    socket.on("relay:receive", (raw) => {
      void this.receive(raw, "RELAY");
    });
    socket.on("media:frame", (raw) => {
      void this.media.receiveFrame(raw);
      void this.groupMedia.receiveFrame(raw);
    });
    socket.on("overlay:signal", (packet: SignalPacket) => {
      if (packet.kind === "media")
        void this.receiveMedia(packet.from, packet.data);
      else
        void this.directTransport
          .receiveSignal(packet)
          .catch((error) => this.log(String(error)));
    });
    socket.on("superpeer:leader", (leader) => {
      if (leader !== null) {
        const parsed = superPeerSchema.safeParse(leader);
        if (!parsed.success || parsed.data.leaseUntil <= Date.now()) {
          this.log("invalid or expired super-peer lease");
          return;
        }
        leader = parsed.data;
      }
      this.emit({ kind: "superpeer", leader });
      if (leader && typeof leader.url === "string" && this.relays.size < 4)
        this.attachRelay(leader.url);
    });
    socket.on("connect", () => {
      if (
        !this.activeRelay ||
        (this.config.relaySelection !== "latency-load" &&
          url === this.config.relayUrl.replace(/\/$/, ""))
      )
        this.activeRelay = url;
      this.log(`relay connected ${url}`);
      this.connection();
      if (this.config.relaySelection === "latency-load")
        void this.probeRelays();
    });
    socket.on("disconnect", () => {
      if (this.activeRelay === url)
        this.activeRelay = [...this.relays].find(
          ([, socket]) => socket.connected,
        )?.[0];
      this.log(`relay disconnected ${url}`);
      this.connection();
    });
    socket.on("connect_error", (error) => {
      this.log(`relay error: ${error.message}`);
      this.connection();
    });
    socket.connect();
  }
  private async overlayCall(event: string, input: unknown) {
    let last: unknown;
    for (const socket of this.relays.values())
      if (socket.connected)
        try {
          const response = await this.call(socket, event, input);
          if (response.ok) return response;
          last = response.error;
        } catch (error) {
          last = error;
        }
    throw Error(`overlay unavailable: ${String(last)}`);
  }
  private async refreshOverlay() {
    if (this.closed || this.refreshingOverlay) return;
    this.refreshingOverlay = true;
    try {
      this.dhtRecord = await createOverlayRecord(
        await this.secure.getIdentity(),
        this.config.displayName || this.peerId,
        [this.config.relayUrl, ...(this.config.relayUrls || [])],
        this.config.dhtLeaseMs,
      );
      await this.overlayCall("dht:publish", this.dhtRecord);
      const response = await this.overlayCall("dht:list", null);
      if (!Array.isArray(response.result)) throw Error("invalid DHT peer list");
      const verified = await Promise.allSettled(
        response.result.map((value) => verifyOverlayRecord(value)),
      );
      const records = verified.flatMap((value) =>
        value.status === "fulfilled" ? [value.value] : [],
      );
      const profiles = records.map((record) => ({
        peerId: record.peerId,
        displayName: record.displayName,
        status: "online" as const,
        online: true as const,
        lastSeen: record.issuedAt,
        connection: { ...DEFAULT_PEER_CONNECTION },
      }));
      this.peers = profiles.map((profile) => profile.peerId);
      this.emit({ kind: "presence", peers: this.peers, profiles });
      if (this.config.relaySelection === "latency-load")
        await this.probeRelays();
    } finally {
      this.refreshingOverlay = false;
    }
  }
  async probeRelays() {
    await Promise.allSettled(
      [...this.relays]
        .filter(([, socket]) => socket.connected)
        .map(async ([url, socket]) => {
          const start = performance.now(),
            response = await this.call(socket, "relay:probe", null);
          if (!response.ok || !response.load) return;
          const sample = this.relaySelector.update(
            url,
            performance.now() - start,
            response.load.peers,
            response.load.pending,
          );
          this.log(
            `RELAY_SCORE ${url} rtt=${sample.rttMs.toFixed(1)}ms peers=${sample.peers} pending=${sample.pending} score=${sample.score.toFixed(1)}`,
          );
        }),
    );
    this.emit({
      kind: "relay-metrics",
      relayMetrics: [...this.relaySelector.samples.values()],
    });
  }
  setRelaySelection(policy: "priority" | "latency-load") {
    this.config.relaySelection = policy;
    if (policy === "latency-load") {
      void this.probeRelays();
      if (!this.advancedTimer)
        this.advancedTimer = setInterval(() => {
          if (this.config.relaySelection === "latency-load")
            void this.probeRelays();
        }, 15000);
    }
  }
  async volunteerSuperPeer(url: string) {
    await this.overlayCall("superpeer:offer", { url });
    clearInterval(this.candidateTimer);
    this.candidateTimer = setInterval(() => {
      void this.overlayCall("superpeer:offer", { url }).catch((error) =>
        this.log(String(error)),
      );
    }, 10000);
  }
  private async receiveMedia(from: string, data: unknown) {
    try {
      if (this.closed || (await this.config.store.isDirectBlocked?.(from)))
        return;
      if (data && typeof data === "object" && "group" in data)
        await this.groupMedia.receive(from, data);
      else await this.media.receive(from, data);
    } catch (error) {
      this.log(`media signal rejected: ${String(error)}`);
    }
  }
  close() {
    this.closed = true;
    this.signalGeneration++;
    this.registration = undefined;
    clearTimeout(this.registrationRetryTimer);
    clearInterval(this.advancedTimer);
    clearInterval(this.candidateTimer);
    this.media.close();
    this.groupMedia.close();
    this.cancelConnect?.(new Error("peer disconnected"));
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.delivery.close();
    this.directTransport.close();
    this.files.close();
    this.signal?.disconnect();
    for (const socket of this.relays.values()) socket.disconnect();
    this.relays.clear();
    this.activeRelay = undefined;
    this.signalState = "offline";
    this.peers = [];
    this.emit({ kind: "presence", peers: [], profiles: [] });
    this.connection();
  }
}
