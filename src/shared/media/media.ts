import { z } from "zod";
import type { RTCFactory } from "../peerTypes.ts";
import { randomUUID } from "../uuid.ts";
import { inspectIceRoute, DEFAULT_ICE_SERVERS } from "../transport/iceRoute.ts";
import { RelayMedia } from "./relayMedia.ts";
import {
  mediaFrameSchema,
  type MediaCipher,
  type MediaLink,
} from "./mediaProtocol.ts";
import { groupCallSignalContextSchema } from "./groupCallProtocol.ts";

const candidate = z
  .object({
    candidate: z.string().max(4000),
    sdpMid: z.string().max(256).nullish(),
    sdpMLineIndex: z.number().int().min(0).max(65535).nullish(),
    usernameFragment: z.string().max(256).nullish(),
  })
  .strict();
const envelope = {
  callId: z.string().uuid(),
  group: groupCallSignalContextSchema.optional(),
};
export const mediaSignalSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...envelope,
      action: z.literal("offer"),
      kind: z.enum(["audio", "video"]),
      sdp: z.string().min(1).max(12000),
      relay: z.literal(1).optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      action: z.literal("answer"),
      sdp: z.string().min(1).max(12000),
      relay: z.literal(1).optional(),
    })
    .strict(),
  z.object({ ...envelope, action: z.literal("ice"), candidate }).strict(),
  z
    .object({
      ...envelope,
      action: z.enum(["end", "reject", "relay-request", "relay-ready"]),
    })
    .strict(),
]);
export type MediaSignal = z.infer<typeof mediaSignalSchema>;
export type CallState = {
  callId: string;
  peerId: string;
  kind: "audio" | "video";
  phase:
    "incoming" | "calling" | "connecting" | "connected" | "ended" | "failed";
  local?: MediaStream;
  remote?: MediaStream;
  remoteFrame?: string;
  route?: "DIRECT" | "TURN" | "RELAY";
  audioBlocked?: boolean;
  error?: string;
  startedAt?: number;
  connectedAt?: number;
  endedAt?: number;
  direction?: "incoming" | "outgoing";
};
type RelayDriver = Pick<
  RelayMedia,
  "unlock" | "prepare" | "start" | "receive" | "close"
>;
export class MediaSession {
  private state?: CallState;
  private pc?: RTCPeerConnection;
  private offer?: string;
  private candidates: RTCIceCandidateInit[] = [];
  private outgoing: MediaSignal[] = [];
  private announced = false;
  private timer?: ReturnType<typeof setTimeout>;
  private fallbackTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private lastSent = 0;
  private generation = 0;
  private accepted = false;
  private peerRelay = false;
  private relayRequested = false;
  private fallback?: Promise<void>;
  private driver?: RelayDriver;
  private link?: MediaLink;
  private cipher?: MediaCipher;
  private sequence = { audio: 0, video: 0 };
  private received = { audio: -1, video: -1 };
  private decrypting = 0;
  private audioFrames: Promise<void> = Promise.resolve();
  private videoFrames = 0;
  private signals: Promise<void> = Promise.resolve();
  constructor(
    private config: {
      rtc: RTCFactory;
      iceServers?: RTCIceServer[];
      policy?: RTCIceTransportPolicy;
      devices?: Pick<MediaDevices, "getUserMedia">;
      relay?: (peerId: string, callId: string) => Promise<MediaLink>;
      cipher?: (peerId: string, callId: string) => Promise<MediaCipher>;
      prepare?: () => Promise<void>;
      stream?: () => Promise<MediaStream>;
      busy?: () => boolean;
      simulateIceFailure?: () => boolean;
      fallbackMs?: number;
      disconnectGraceMs?: number;
      driver?: (
        options: ConstructorParameters<typeof RelayMedia>[0],
      ) => RelayDriver;
      send: (to: string, signal: MediaSignal) => Promise<void>;
      emit: (state: CallState) => void;
      log: (value: string) => void;
    },
  ) {}
  private emit() {
    if (this.state) {
      if (this.state.phase === "connected")
        this.state.connectedAt ??= Date.now();
      this.config.emit({ ...this.state });
    }
  }
  private active() {
    return this.state && !["ended", "failed"].includes(this.state.phase);
  }
  isActive() {
    return !!this.active();
  }
  private current(generation: number) {
    return generation === this.generation && !!this.active();
  }
  private deadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.end(
        "Cuộc gọi hết thời gian chờ. Kiểm tra kết nối của hai thiết bị rồi gọi lại.",
      );
    }, 30000);
  }
  private createDriver() {
    this.driver = (
      this.config.driver || ((options) => new RelayMedia(options))
    )({
      send: async (kind, data) => {
        const generation = this.generation,
          frame = await this.cipher?.seal(kind, this.sequence[kind]++, data);
        if (frame && this.current(generation) && this.link?.send(frame))
          this.lastSent = Date.now();
      },
      remote: (stream, frame) => {
        if (this.active()) {
          this.state!.remote = stream;
          this.state!.remoteFrame = frame;
          this.emit();
        }
      },
      error: (error) => this.config.log("CALL_MEDIA " + String(error)),
      playback: (blocked) => {
        if (this.active()) {
          this.state!.audioBlocked = blocked;
          this.emit();
        }
      },
    });
    this.driver.unlock();
  }
  resumeAudio() {
    this.driver?.unlock();
  }
  private scheduleFallback() {
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => {
      if (this.active() && this.state?.phase !== "connected")
        void this.switchToRelay(true);
    }, this.config.fallbackMs ?? 8000);
  }
  private async capture() {
    const state = this.state!,
      generation = this.generation,
      devices = this.config.devices || globalThis.navigator?.mediaDevices;
    if (!devices && !this.config.stream)
      throw Error(
        "Mic và camera cần HTTPS cùng quyền truy cập của trình duyệt.",
      );
    const stream = this.config.stream
      ? await this.config.stream()
      : await devices!.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: state.kind === "video",
        });
    if (!this.current(generation)) {
      if (!this.config.stream)
        stream.getTracks().forEach((track) => track.stop());
      throw Error("call cancelled");
    }
    state.local = stream;
    const blocked = this.config.simulateIceFailure?.() === true;
    const pc = (this.pc = new this.config.rtc(
      blocked
        ? { iceServers: [], iceTransportPolicy: "relay" }
        : {
            iceServers: this.config.iceServers || DEFAULT_ICE_SERVERS,
            iceTransportPolicy: this.config.policy || "all",
          },
    ));
    if (blocked)
      this.config.log("CALL_ICE_BLOCKED " + state.callId + " simulation=1");
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    this.announced = false;
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.pc !== pc || !this.active()) return;
      const value = candidate.safeParse(event.candidate.toJSON());
      if (!value.success) return;
      const signal: MediaSignal = {
        action: "ice",
        callId: state.callId,
        candidate: value.data,
      };
      if (!this.announced) {
        if (this.outgoing.length < 128) this.outgoing.push(signal);
        return;
      }
      void this.config
        .send(state.peerId, signal)
        .catch((error) =>
          this.config.log("media ICE failed: " + String(error)),
        );
    };
    pc.ontrack = (event) => {
      if (this.pc !== pc || !this.active()) return;
      state.remote ??= new MediaStream();
      if (
        !state.remote.getTracks().some((track) => track.id === event.track.id)
      )
        state.remote.addTrack(event.track);
      this.emit();
    };
    pc.onicecandidateerror = (event) =>
      this.config.log(
        "CALL_ICE_ERROR " + state.callId + " code=" + event.errorCode,
      );
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || !this.active()) return;
      this.config.log(
        "CALL_ICE " + state.callId + " state=" + pc.connectionState,
      );
      if (pc.connectionState === "connected") {
        state.phase = "connected";
        clearTimeout(this.timer);
        clearTimeout(this.fallbackTimer);
        clearTimeout(this.disconnectTimer);
        void inspectIceRoute(pc, () => this.pc === pc && !!this.active())
          .then((route) => {
            if (this.pc !== pc || !this.active()) return;
            if (route) {
              state.route = route.mode;
              this.config.log(
                "CALL_ROUTE " + state.callId + " mode=" + route.mode,
              );
            }
            this.emit();
          })
          .catch(() => {});
        this.config.log(
          "CALL_CONNECTED " + state.callId + " peer=" + state.peerId,
        );
        this.emit();
      }
      if (pc.connectionState === "failed") void this.switchToRelay(true);
      if (pc.connectionState === "disconnected") {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc === pc && pc.connectionState !== "connected")
            void this.switchToRelay(true);
        }, this.config.disconnectGraceMs ?? 3000);
      }
    };
    this.emit();
    return pc;
  }
  async start(peerId: string, kind: "audio" | "video") {
    if (this.active() || this.config.busy?.())
      throw Error("Bạn đang tham gia cuộc gọi khác.");
    this.dispose();
    this.generation++;
    const generation = this.generation;
    this.state = {
      callId: randomUUID(),
      peerId,
      kind,
      phase: "calling",
      startedAt: Date.now(),
      direction: "outgoing",
    };
    this.emit();
    this.deadline();
    this.createDriver();
    try {
      await this.config.prepare?.();
      if (!this.current(generation)) return;
      const pc = await this.capture(),
        offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.pc !== pc || !this.current(generation)) return;
      await this.config.send(peerId, {
        action: "offer",
        callId: this.state.callId,
        kind,
        sdp: offer.sdp!,
        ...(this.config.relay ? { relay: 1 as const } : {}),
      });
      await this.flushCandidates(pc);
    } catch (error) {
      if (this.current(generation)) await this.end(this.errorText(error));
      throw error;
    }
  }
  async accept() {
    if (this.state?.phase !== "incoming" || !this.offer)
      throw Error("no incoming call");
    const state = this.state,
      generation = this.generation;
    state.phase = "connecting";
    this.accepted = true;
    this.emit();
    this.createDriver();
    this.deadline();
    try {
      await this.config.prepare?.();
      if (!this.current(generation)) return;
      const pc = await this.capture();
      await pc.setRemoteDescription({ type: "offer", sdp: this.offer });
      for (const value of this.candidates.splice(0))
        await pc.addIceCandidate(value);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.pc === pc && this.current(generation)) {
        await this.config.send(state.peerId, {
          action: "answer",
          callId: state.callId,
          sdp: answer.sdp!,
          ...(this.config.relay ? { relay: 1 as const } : {}),
        });
        await this.flushCandidates(pc);
        this.scheduleFallback();
        if (this.relayRequested) await this.switchToRelay(false);
      }
    } catch (error) {
      if (this.current(generation)) await this.end(this.errorText(error));
      throw error;
    }
  }
  receive(from: string, input: unknown) {
    const task = this.signals.then(() => this.handleSignal(from, input));
    this.signals = task.catch(() => {});
    return task;
  }
  private async handleSignal(from: string, input: unknown) {
    const signal = mediaSignalSchema.parse(input);
    if (signal.action === "offer") {
      if (
        this.active() &&
        this.state?.peerId === from &&
        this.state.callId === signal.callId
      )
        return;
      if (this.active() || this.config.busy?.()) {
        await this.config.send(from, {
          action: "reject",
          callId: signal.callId,
        });
        return;
      }
      this.dispose();
      this.generation++;
      this.offer = signal.sdp;
      this.peerRelay = signal.relay === 1;
      this.state = {
        callId: signal.callId,
        peerId: from,
        kind: signal.kind,
        phase: "incoming",
        startedAt: Date.now(),
        direction: "incoming",
      };
      this.emit();
      this.deadline();
      return;
    }
    if (
      !this.active() ||
      this.state?.peerId !== from ||
      this.state.callId !== signal.callId
    )
      return;
    if (signal.action === "end" || signal.action === "reject") {
      this.dispose(
        signal.action === "reject"
          ? "Peer đang bận hoặc đã từ chối cuộc gọi."
          : undefined,
      );
      return;
    }
    if (signal.action === "relay-request" || signal.action === "relay-ready") {
      if (!this.accepted) return;
      if (!this.state.local) {
        this.relayRequested = true;
        return;
      }
      await this.switchToRelay(
        signal.action === "relay-ready" ? undefined : false,
      );
      if (this.active() && this.link) this.driver?.start();
      return;
    }
    if (signal.action === "answer") {
      if (!this.pc || this.accepted) return;
      const pc = this.pc,
        generation = this.generation;
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      for (const value of this.candidates.splice(0))
        await pc.addIceCandidate(value);
      if (!this.current(generation)) return;
      this.accepted = true;
      this.peerRelay = signal.relay === 1;
      if (this.state.phase === "calling") this.state.phase = "connecting";
      this.emit();
      this.deadline();
      this.scheduleFallback();
    } else if (signal.action === "ice" && !this.link) {
      if (this.pc?.remoteDescription)
        await this.pc.addIceCandidate(signal.candidate);
      else if (this.candidates.length < 128)
        this.candidates.push(signal.candidate);
    }
  }
  private async switchToRelay(notify?: boolean) {
    if (!this.active() || !this.accepted || !this.state?.local) return;
    const state = this.state,
      generation = this.generation;
    try {
      if (!this.config.relay || !this.config.cipher || !this.peerRelay)
        throw Error(
          "WebRTC bị chặn. Cần cấu hình TURN hoặc cập nhật trang trên cả hai thiết bị để dùng relay cuộc gọi.",
        );
      this.fallback ??= (async () => {
        const cipher = await this.config.cipher!(state.peerId, state.callId);
        if (!this.current(generation)) return;
        const link = await this.config.relay!(state.peerId, state.callId);
        if (!this.current(generation)) {
          link.close();
          return;
        }
        this.link = link;
        this.cipher = cipher;
        const pc = this.pc;
        this.pc = undefined;
        pc?.close();
        clearTimeout(this.fallbackTimer);
        clearTimeout(this.disconnectTimer);
        state.route = "RELAY";
        state.phase = "connecting";
        state.remote = undefined;
        this.emit();
        await this.driver!.prepare(state.local!, state.kind);
        if (!this.current(generation)) return;
        this.lastFrame = this.lastSent = Date.now();
        this.watchdog = setInterval(() => {
          if (
            Date.now() - this.lastFrame > 15000 ||
            Date.now() - this.lastSent > 15000
          )
            void this.end(
              "Mất kết nối relay cuộc gọi. Kiểm tra mạng rồi gọi lại.",
            );
        }, 2000);
        this.config.log(
          "CALL_ROUTE " + state.callId + " mode=RELAY encrypted=1",
        );
      })();
      await this.fallback;
      if (!this.current(generation)) return;
      if (notify !== undefined)
        await this.config.send(state.peerId, {
          action: notify ? "relay-request" : "relay-ready",
          callId: state.callId,
        });
    } catch (error) {
      if (this.current(generation)) {
        this.config.log(
          "CALL_RELAY_ERROR " +
            state.callId +
            " peer=" +
            state.peerId +
            " " +
            this.errorText(error),
        );
        await this.end(this.errorText(error));
      }
    }
  }
  receiveFrame(input: unknown): Promise<void> {
    const parsed = mediaFrameSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();
    if (
      !this.active() ||
      !this.link ||
      !this.cipher ||
      parsed.data.callId !== this.state!.callId ||
      parsed.data.senderId !== this.state!.peerId ||
      parsed.data.sequence <= this.received[parsed.data.kind]
    )
      return Promise.resolve();
    if (parsed.data.kind !== "audio") {
      if (this.videoFrames >= 2) return Promise.resolve();
      this.videoFrames++;
      return this.receiveOneFrame(input).finally(() => {
        this.videoFrames--;
      });
    }
    if (this.decrypting >= 20) return Promise.resolve();
    this.decrypting++;
    const generation = this.generation;
    const task = this.audioFrames
      .catch(() => {})
      .then(() =>
        generation === this.generation
          ? this.receiveOneFrame(input)
          : undefined,
      )
      .finally(() => {
        this.decrypting--;
      });
    this.audioFrames = task;
    return task;
  }
  private async receiveOneFrame(input: unknown) {
    const result = mediaFrameSchema.safeParse(input),
      generation = this.generation;
    if (!result.success || !this.active() || !this.link || !this.cipher) return;
    const frame = result.data;
    if (
      frame.callId !== this.state!.callId ||
      frame.senderId !== this.state!.peerId ||
      frame.sequence <= this.received[frame.kind]
    )
      return;
    try {
      const data = await this.cipher.open(frame);
      if (
        !this.current(generation) ||
        frame.sequence <= this.received[frame.kind]
      )
        return;
      this.driver?.receive(frame.kind, data, frame.sequence);
      this.received[frame.kind] = frame.sequence;
      this.lastFrame = Date.now();
      if (this.state!.phase !== "connected") {
        this.state!.phase = "connected";
        clearTimeout(this.timer);
        this.config.log(
          "CALL_CONNECTED " +
            frame.callId +
            " peer=" +
            frame.senderId +
            " mode=RELAY",
        );
        this.emit();
      }
    } catch (error) {
      this.config.log("CALL_FRAME_REJECT " + this.errorText(error));
    }
  }
  mute(kind: "audio" | "video", muted: boolean) {
    this.state?.local
      ?.getTracks()
      .filter((track) => track.kind === kind)
      .forEach((track) => {
        track.enabled = !muted;
      });
    this.emit();
  }
  private async flushCandidates(pc: RTCPeerConnection) {
    if (this.pc !== pc || !this.active()) return;
    this.announced = true;
    for (const signal of this.outgoing.splice(0)) {
      if (this.pc !== pc || !this.active()) return;
      await this.config.send(this.state!.peerId, signal);
    }
  }
  private errorText(error: unknown) {
    if (error instanceof Error && error.name === "NotAllowedError")
      return "Chưa truy cập được mic/camera. Kiểm tra quyền của trình duyệt và hệ điều hành.";
    if (error instanceof Error && error.name === "NotFoundError")
      return "Không tìm thấy mic hoặc camera.";
    if (error instanceof Error && error.name === "NotReadableError")
      return "Mic hoặc camera đang bận. Đóng ứng dụng khác đang sử dụng thiết bị rồi thử lại.";
    return error instanceof Error ? error.message : String(error);
  }
  private dispose(error?: string) {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.fallbackTimer);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.watchdog);
    this.pc?.close();
    this.pc = undefined;
    this.driver?.close();
    this.driver = undefined;
    this.link?.close();
    this.link = undefined;
    this.cipher = undefined;
    this.candidates = [];
    this.outgoing = [];
    this.announced = false;
    this.offer = undefined;
    this.accepted = false;
    this.peerRelay = false;
    this.relayRequested = false;
    this.fallback = undefined;
    this.sequence = { audio: 0, video: 0 };
    this.received = { audio: -1, video: -1 };
    if (!this.config.stream)
      this.state?.local?.getTracks().forEach((track) => track.stop());
    this.state?.remote?.getTracks().forEach((track) => track.stop());
    if (this.state && !["ended", "failed"].includes(this.state.phase)) {
      this.state.endedAt ??= Date.now();
      this.state.phase = error ? "failed" : "ended";
      this.state.error = error;
      this.state.remoteFrame = undefined;
      this.emit();
    }
  }
  async end(error?: string) {
    const state = this.state;
    this.dispose(error);
    if (state)
      try {
        await this.config.send(state.peerId, {
          action: "end",
          callId: state.callId,
        });
      } catch {
        return;
      }
  }
  stats() {
    return this.pc?.getStats();
  }
  close() {
    this.dispose();
  }
}
