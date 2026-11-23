import { MediaSession, mediaSignalSchema, type CallState } from "./media.ts";
import {
  groupCallRoomSchema,
  MAX_GROUP_CALL_PEERS,
  type GroupCallSignalContext,
  type GroupCallControl,
  type GroupCallRoom,
  type GroupCallState,
} from "./groupCallProtocol.ts";
import type { Group } from "./protocol.ts";

type Link = { session: MediaSession; state: CallState };
export class GroupMediaSession {
  private rooms = new Map<string, GroupCallRoom>();
  private latest = new Map<string, GroupCallRoom>();
  private dismissed = new Set<string>();
  private revokedGroups = new Set<string>();
  private state?: GroupCallState;
  private stream?: MediaStream;
  private context?: AudioContext;
  private links = new Map<string, Link>();
  private retries = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private opening = false;
  private generation = 0;
  private pending: { from: string; input: unknown }[] = [];
  constructor(
    private config: {
      peerId: string;
      busy: () => boolean;
      devices?: Pick<MediaDevices, "getUserMedia">;
      audioContext?: () => AudioContext;
      control: (
        input: GroupCallControl,
      ) => Promise<{ room?: GroupCallRoom; rooms?: GroupCallRoom[] }>;
      create: (
        peerId: string,
        scope: GroupCallSignalContext,
        stream: MediaStream,
        context: AudioContext,
        emit: (state: CallState) => void,
      ) => MediaSession;
      emit: (state: GroupCallState | undefined, rooms: GroupCallRoom[]) => void;
      log: (text: string) => void;
    },
  ) {}
  isActive() {
    return (
      this.opening ||
      this.state?.phase === "active" ||
      this.state?.phase === "joining"
    );
  }
  private emit() {
    if (this.state?.phase === "active")
      this.state.peers = [...this.links.values()].map((link) => link.state);
    this.config.emit(
      this.state ? { ...this.state, peers: [...this.state.peers] } : undefined,
      [...this.rooms.values()],
    );
  }
  async refresh() {
    const result = await this.config.control({ action: "list" });
    for (const room of result.rooms || []) this.update(room);
  }
  update(input: unknown) {
    const room = groupCallRoomSchema.parse(input),
      previous = this.latest.get(room.groupId);
    if (this.revokedGroups.has(room.groupId)) {
      this.rooms.delete(room.groupId);
      return;
    }
    if (previous && previous.version >= room.version) return;
    this.latest.set(room.groupId, room);
    if (room.ended) this.rooms.delete(room.groupId);
    else this.rooms.set(room.groupId, room);
    if (
      this.state?.room.roomId === room.roomId &&
      this.state.phase === "active"
    ) {
      for (const [id, link] of this.links)
        if (this.state.room.sessions[id] !== room.sessions[id]) {
          this.links.delete(id);
          clearTimeout(this.retryTimers.get(id));
          this.retryTimers.delete(id);
          this.retries.delete(id);
          void link.session.end();
          link.session.close();
        }
      this.state.room = room;
      if (!room.participants.includes(this.config.peerId))
        this.finish("ended", "Bạn đã rời hoặc mất kết nối với cuộc gọi nhóm.");
      else this.reconcile();
    } else if (
      !this.isActive() &&
      !this.opening &&
      !room.ended &&
      !this.dismissed.has(room.roomId) &&
      !room.participants.includes(this.config.peerId)
    ) {
      this.state = {
        room,
        phase: "incoming",
        peers: [],
        muted: false,
        cameraOff: false,
      };
    } else if (
      this.state?.room.roomId === room.roomId &&
      this.state.phase === "incoming"
    ) {
      if (room.ended) this.state = undefined;
      else this.state.room = room;
    }
    this.emit();
  }
  async start(groupId: string, kind: "audio" | "video") {
    const existing = this.rooms.get(groupId);
    if (existing) return this.join(existing.roomId);
    return this.enter({ action: "start", groupId, kind }, kind);
  }
  async join(roomId: string) {
    const room = [...this.rooms.values()].find(
      (room) => room.roomId === roomId,
    );
    if (!room || room.ended) throw Error("Cuộc gọi đã kết thúc.");
    if (
      !room.participants.includes(this.config.peerId) &&
      room.participants.length >= MAX_GROUP_CALL_PEERS
    )
      throw Error("Cuộc gọi đã đủ " + MAX_GROUP_CALL_PEERS + " người.");
    return this.enter({ action: "join", roomId }, room.kind);
  }
  private async enter(input: GroupCallControl, kind: "audio" | "video") {
    if (this.isActive() || this.config.busy())
      throw Error("Hãy kết thúc cuộc gọi hiện tại trước khi tham gia.");
    this.opening = true;
    const generation = ++this.generation;
    let stream: MediaStream | undefined, room: GroupCallRoom | undefined;
    try {
      this.context =
        this.config.audioContext?.() ||
        new AudioContext({ latencyHint: "interactive" });
      void this.context.resume().catch(() => {});
      const devices = this.config.devices || navigator.mediaDevices;
      if (!devices)
        throw Error("Mic và camera cần HTTPS cùng quyền của trình duyệt.");
      stream = await devices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: kind === "video",
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const result = await this.config.control(input);
      room = groupCallRoomSchema.parse(result.room);
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        void this.config
          .control({
            action: "leave",
            roomId: room.roomId,
            sessionId: room.sessions[this.config.peerId],
          })
          .catch(() => {});
        return;
      }
      if (!room.participants.includes(this.config.peerId))
        throw Error("Máy chủ chưa xác nhận tham gia cuộc gọi.");
      const latest = this.latest.get(room.groupId);
      if (latest && latest.version > room.version) room = latest;
      if (room.ended || !room.participants.includes(this.config.peerId))
        throw Error("Cuộc gọi đã kết thúc hoặc phiên tham gia đã hết hạn.");
      this.rooms.set(room.groupId, room);
      this.latest.set(room.groupId, room);
      this.dismissed.delete(room.roomId);
      this.state = {
        room,
        phase: "active",
        joinedAt: Date.now(),
        local: stream,
        peers: [],
        muted: false,
        cameraOff: false,
      };
      this.opening = false;
      this.reconcile();
      this.emit();
      await Promise.all(
        this.pending
          .splice(0)
          .map((packet) => this.receive(packet.from, packet.input)),
      );
      if (generation !== this.generation) return;
      let pending = false,
        failures = 0;
      this.heartbeat = setInterval(() => {
        if (pending || this.state?.phase !== "active") return;
        pending = true;
        void this.config
          .control({ action: "heartbeat", roomId: room!.roomId })
          .then((result) => {
            failures = 0;
            if (generation === this.generation && result.room)
              this.update(result.room);
          })
          .catch((error) => {
            if (generation === this.generation) {
              this.config.log("GROUP_CALL_HEARTBEAT " + String(error));
              if (++failures >= 2)
                this.finish(
                  "failed",
                  "Không duy trì được phiên cuộc gọi. Hãy tham gia lại.",
                );
            }
          })
          .finally(() => {
            pending = false;
          });
      }, 10000);
      this.config.log("GROUP_CALL_JOIN room=" + room.roomId + " kind=" + kind);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === this.generation) {
        this.opening = false;
        this.finish(
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (room)
        void this.config
          .control({
            action: "leave",
            roomId: room.roomId,
            sessionId: room.sessions[this.config.peerId],
          })
          .catch(() => {});
      throw error;
    }
  }
  private makeLink(peerId: string) {
    const room = this.state!.room,
      scope = {
        groupId: room.groupId,
        roomId: room.roomId,
        senderSession: room.sessions[this.config.peerId],
        receiverSession: room.sessions[peerId],
      },
      generation = this.generation;
    const link: Link = {
      state: {
        callId: scope.roomId,
        peerId,
        kind: this.state!.room.kind,
        phase: "connecting",
      },
      session: undefined!,
    };
    const session = this.config.create(
      peerId,
      scope,
      this.stream!,
      this.context!,
      (state) => {
        if (
          generation !== this.generation ||
          this.links.get(peerId) !== link ||
          this.state?.phase !== "active"
        )
          return;
        link.state = state;
        this.emit();
        if (
          ["ended", "failed"].includes(state.phase) &&
          this.config.peerId < peerId &&
          this.state.room.participants.includes(peerId)
        )
          this.retry(peerId);
      },
    );
    link.session = session;
    this.links.set(peerId, link);
    return link;
  }
  private retry(peerId: string) {
    if (this.retryTimers.has(peerId) || (this.retries.get(peerId) || 0) >= 2)
      return;
    this.retries.set(peerId, (this.retries.get(peerId) || 0) + 1);
    const generation = this.generation;
    this.retryTimers.set(
      peerId,
      setTimeout(() => {
        this.retryTimers.delete(peerId);
        if (
          generation !== this.generation ||
          this.state?.phase !== "active" ||
          !this.state.room.participants.includes(peerId)
        )
          return;
        const old = this.links.get(peerId);
        this.links.delete(peerId);
        old?.session.close();
        this.connect(peerId);
      }, 5000),
    );
  }
  private connect(peerId: string) {
    const link = this.makeLink(peerId);
    if (this.config.peerId < peerId)
      void link.session
        .start(peerId, this.state!.room.kind)
        .catch((error) =>
          this.config.log("GROUP_CALL_LINK " + peerId + " " + String(error)),
        );
  }
  private reconcile() {
    if (this.state?.phase !== "active" || !this.stream) return;
    const wanted = this.state.room.participants.filter(
      (id) => id !== this.config.peerId,
    );
    for (const [id, link] of this.links)
      if (!wanted.includes(id)) {
        this.links.delete(id);
        clearTimeout(this.retryTimers.get(id));
        this.retryTimers.delete(id);
        this.retries.delete(id);
        void link.session.end();
        link.session.close();
      }
    for (const id of wanted) if (!this.links.has(id)) this.connect(id);
  }
  async receive(from: string, input: unknown) {
    const signal = mediaSignalSchema.parse(input),
      state = this.state;
    if (this.opening && signal.group && this.pending.length < 256) {
      this.pending.push({ from, input });
      return;
    }
    if (
      state?.phase !== "active" ||
      signal.group?.roomId !== state.room.roomId ||
      signal.group.groupId !== state.room.groupId ||
      !state.room.participants.includes(from) ||
      from === this.config.peerId ||
      signal.group.senderSession !== state.room.sessions[from] ||
      signal.group.receiverSession !== state.room.sessions[this.config.peerId]
    )
      return;
    let link = this.links.get(from);
    if (
      signal.action === "offer" &&
      (!link || ["ended", "failed"].includes(link.state.phase))
    ) {
      if (link) {
        this.links.delete(from);
        link.session.close();
      }
      link = this.makeLink(from);
    }
    if (!link) return;
    await link.session.receive(from, signal);
    if (this.links.get(from) === link && link.state.phase === "incoming")
      await link.session.accept();
  }
  async receiveFrame(input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      !("senderId" in input) ||
      typeof input.senderId !== "string"
    )
      return;
    await this.links.get(input.senderId)?.session.receiveFrame(input);
  }
  mute(kind: "audio" | "video", muted: boolean) {
    this.stream
      ?.getTracks()
      .filter((track) => track.kind === kind)
      .forEach((track) => {
        track.enabled = !muted;
      });
    if (this.state) {
      if (kind === "audio") this.state.muted = muted;
      else this.state.cameraOff = muted;
      this.emit();
    }
  }
  resumeAudio() {
    void this.context?.resume().catch(() => {});
    for (const link of this.links.values()) link.session.resumeAudio();
  }
  async leave() {
    const roomId = this.state?.room.roomId;
    const sessionId = this.state?.room.sessions[this.config.peerId];
    if (roomId) this.dismissed.add(roomId);
    this.finish("ended");
    if (roomId)
      try {
        await this.config.control({ action: "leave", roomId, sessionId });
      } catch (error) {
        this.config.log("GROUP_CALL_LEAVE " + String(error));
      }
  }
  membership(group: Group) {
    if (group.archived || !group.members.includes(this.config.peerId)) {
      this.revokedGroups.add(group.id);
      this.rooms.delete(group.id);
      if (this.state?.room.groupId === group.id) {
        this.dismissed.add(this.state.room.roomId);
        this.finish("ended", "Bạn không còn quyền tham gia cuộc gọi của nhóm.");
      } else this.emit();
    } else this.revokedGroups.delete(group.id);
  }
  dismiss() {
    if (!this.isActive()) {
      if (this.state) this.dismissed.add(this.state.room.roomId);
      this.state = undefined;
      this.emit();
    }
  }
  private finish(phase: "ended" | "failed", error?: string) {
    this.generation++;
    this.opening = false;
    clearInterval(this.heartbeat);
    this.pending = [];
    if (this.state) {
      this.state.phase = phase;
      this.state.endedAt ??= Date.now();
      this.state.error = error;
    }
    const links = [...this.links.values()];
    this.links.clear();
    for (const link of links) {
      void link.session.end();
      link.session.close();
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retries.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.context?.state !== "closed")
      void this.context?.close().catch(() => {});
    this.context = undefined;
    this.emit();
  }
  offline() {
    this.finish(
      "failed",
      "Mất kết nối signaling. Kết nối lại rồi tham gia cuộc gọi.",
    );
    this.rooms.clear();
    this.latest.clear();
    this.emit();
  }
  close() {
    this.finish("ended");
    this.rooms.clear();
    this.latest.clear();
    this.state = undefined;
    this.emit();
  }
}
