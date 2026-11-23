import type { DeliveryMode } from "./protocol.ts";
import type { RTCFactory } from "./peerTypes.ts";
import { inspectIceRoute, DEFAULT_ICE_SERVERS } from "./iceRoute.ts";
import { randomUUID } from "./uuid.ts";
import { SignalingTransportError } from "./signalingErrors.ts";
export type SignalKind = "request" | "offer" | "answer" | "ice" | "media";
export type SignalPacket = {
  from: string;
  kind: SignalKind;
  data: unknown;
};
type DirectConnection = {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  ready: boolean;
  opening?: Promise<boolean>;
  stopOpening?: () => void;
  candidates: RTCIceCandidateInit[];
  failedUntil: number;
  negotiating?: Promise<void>;
  route: "DIRECT" | "TURN";
  classification?: Promise<void>;
  requestId: string;
  connectionId: string;
  revision: number;
  remoteRevision?: number;
  peerRequestId?: string;
  started: boolean;
  background: boolean;
  recovering: boolean;
  everReady: boolean;
  restartAttempted: boolean;
  retryRequested: boolean;
  backgroundTimer?: ReturnType<typeof setTimeout>;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  remoteOffer?: string;
  answer?: RTCSessionDescriptionInit;
};
type DirectTransportConfig = {
  peerId: string;
  rtc: RTCFactory;
  iceServers?: RTCIceServer[];
  timeoutMs?: number;
  backgroundTimeoutMs?: number;
  recoveryGraceMs?: number;
  recoveryTimeoutMs?: number;
  policy?: RTCIceTransportPolicy;
  sendSignal: (to: string, kind: SignalKind, data: unknown) => Promise<void>;
  onMessage: (
    raw: unknown,
    expectedSender: string,
    route: "DIRECT" | "TURN",
  ) => void;
  onMode: (peerId: string, mode: DeliveryMode) => void;
  log: (text: string) => void;
};

export class DirectTransport {
  private connections = new Map<string, DirectConnection>();
  private signals = new Map<string, Promise<void>>();
  private requests = new Map<string, Set<string>>();
  private taggedPeers = new Set<string>();
  private retired = new Map<string, Set<string>>();
  private earlyCandidates = new Map<string, Map<string, RTCIceCandidateInit[]>>();
  private closed = false;
  constructor(private config: DirectTransportConfig) { }
  availableMode(peerId: string): "DIRECT" | "TURN" | undefined {
    const direct = this.connections.get(peerId);
    return direct?.ready &&
      this.current(peerId, direct) &&
      direct.channel?.readyState === "open" &&
      !["disconnected", "failed"].includes(direct.pc.connectionState)
      ? direct.route
      : undefined;
  }
  private clearTimers(direct: DirectConnection) {
    clearTimeout(direct.backgroundTimer);
    clearTimeout(direct.recoveryTimer);
    direct.backgroundTimer = undefined;
    direct.recoveryTimer = undefined;
  }
  private dispose(peerId: string, direct: DirectConnection) {
    const wasReady = direct.ready;
    direct.ready = false;
    this.clearTimers(direct);
    const retired = this.retired.get(peerId) || new Set<string>();
    retired.add(direct.connectionId);
    if (retired.size > 64) retired.delete(retired.values().next().value!);
    this.retired.set(peerId, retired);
    const pending = this.earlyCandidates.get(peerId);
    for (const key of pending?.keys() || [])
      if (key.startsWith(`${direct.connectionId}:`)) pending!.delete(key);
    direct.stopOpening?.();
    direct.pc.close();
    if (wasReady && !this.closed) this.config.onMode(peerId, "RELAY");
  }
  private startAttempt(peerId: string, direct: DirectConnection) {
    if (direct.started) return;
    direct.started = true;
    if (this.config.backgroundTimeoutMs === 0) return;
    const timeout = Math.max(
      this.config.timeoutMs ?? 10000,
      this.config.backgroundTimeoutMs ?? 30000,
    );
    direct.backgroundTimer = setTimeout(() => {
      if (!this.current(peerId, direct) || direct.ready) return;
      this.fail(peerId, direct, `DIRECT exhausted ${peerId}; RELAY fallback`);
    }, timeout);
  }
  private async signal(
    peerId: string,
    direct: DirectConnection,
    kind: SignalKind,
    data: object,
  ) {
    try {
      await this.config.sendSignal(peerId, kind, {
        ...data,
        connectionId: direct.connectionId,
        revision: direct.revision,
      });
    } catch (error) {
      if (!this.current(peerId, direct)) return;
      if (!(error instanceof SignalingTransportError)) throw error;
      this.config.log(
        `DIRECT_SIGNAL_TIMEOUT peer=${peerId} kind=${kind}; ${direct.ready ? "keeping open channel" : "ICE continues within deadline"}`,
      );
    }
  }
  private async diagnose(peerId: string, direct: DirectConnection) {
    const summary: Record<string, unknown> = {
      pc: direct.pc.connectionState,
      ice: direct.pc.iceConnectionState,
      gathering: direct.pc.iceGatheringState,
      signaling: direct.pc.signalingState,
      channel: direct.channel?.readyState || "absent",
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stats = await Promise.race([
        direct.pc.getStats(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 200);
        }),
      ]);
      const local: Record<string, number> = {},
        remote: Record<string, number> = {},
        pairs: Record<string, number> = {};
      stats?.forEach((row) => {
        const bucket =
          row.type === "local-candidate"
            ? local
            : row.type === "remote-candidate"
              ? remote
              : row.type === "candidate-pair"
                ? pairs
                : undefined;
        if (!bucket) return;
        const label =
          row.type === "candidate-pair" ? row.state : row.candidateType;
        if (
          [
            "host",
            "srflx",
            "prflx",
            "relay",
            "frozen",
            "waiting",
            "in-progress",
            "failed",
            "succeeded",
          ].includes(label)
        )
          bucket[label] = (bucket[label] || 0) + 1;
      });
      Object.assign(summary, { local, remote, pairs, stats: !!stats });
    } catch {
      summary.stats = false;
    } finally {
      clearTimeout(timer);
    }
    if (this.current(peerId, direct))
      this.config.log(
        `DIRECT_DIAGNOSTIC peer=${peerId} ${JSON.stringify(summary)}`,
      );
  }
  private current(peerId: string, direct: DirectConnection) {
    return (
      !this.closed &&
      this.connections.get(peerId) === direct &&
      direct.pc.connectionState !== "closed"
    );
  }
  private fail(peerId: string, direct: DirectConnection, reason: string) {
    if (
      this.closed ||
      this.connections.get(peerId) !== direct ||
      (!direct.ready && direct.failedUntil > Date.now())
    )
      return;
    direct.ready = false;
    direct.recovering = false;
    direct.failedUntil = Date.now() + 30000;
    this.dispose(peerId, direct);
    this.config.onMode(peerId, "RELAY");
    this.config.log(reason);
  }
  private connection(
    peerId: string,
    incoming = false,
    connectionId?: string,
  ): DirectConnection {
    let item = this.connections.get(peerId);
    // A request-only responder has not used ICE credentials yet. Adopt the
    // offer's ID in place so an outstanding ensure() keeps waiting on it.
    if (
      item && connectionId && connectionId !== item.connectionId &&
      !item.channel && !item.pc.localDescription && !item.pc.remoteDescription &&
      item.failedUntil === 0
    ) item.connectionId = connectionId;
    if (
      item &&
      ((connectionId && connectionId !== item.connectionId) ||
        (incoming && item.ready && !connectionId) ||
        (((!item.ready && item.failedUntil > 0) ||
          ["failed", "closed"].includes(item.pc.connectionState)) &&
          (incoming || item.failedUntil <= Date.now())))
    ) {
      this.connections.delete(peerId);
      this.dispose(peerId, item);
      item = undefined;
    }
    if (item) return item;
    const pc = new this.config.rtc({
      iceTransportPolicy: this.config.policy || "all",
      iceServers: this.config.iceServers || DEFAULT_ICE_SERVERS,
    });
    item = {
      pc,
      ready: false,
      candidates: [],
      failedUntil: 0,
      route: "DIRECT",
      requestId: randomUUID(),
      connectionId: connectionId || randomUUID(),
      revision: 0,
      started: false,
      background: false,
      recovering: false,
      everReady: false,
      restartAttempted: false,
      retryRequested: false,
    };
    this.connections.set(peerId, item);
    const counts: Record<string, number> = {};
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete" && this.current(peerId, item!))
        this.config.log(
          `DIRECT_CANDIDATES peer=${peerId} connection=${item!.connectionId} ${JSON.stringify(counts)}`,
        );
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const type = event.candidate.type || "unknown";
        counts[type] = (counts[type] || 0) + 1;
      }
      if (event.candidate && this.current(peerId, item!))
        void this
          .signal(peerId, item!, "ice", event.candidate.toJSON())
          .catch((error) =>
            this.config.log(`ICE send failed: ${String(error)}`),
          );
    };
    pc.onconnectionstatechange = () => {
      if (this.closed || this.connections.get(peerId) !== item) return;
      if (
        ["disconnected", "failed"].includes(pc.connectionState) &&
        item!.everReady && item!.channel?.readyState === "open"
      ) {
        this.recover(peerId, item!);
      } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.fail(
          peerId,
          item!,
          `direct lost ${peerId}: ${pc.connectionState}; RELAY fallback`,
        );
      } else if (
        pc.connectionState === "connected" &&
        item!.recovering && item!.channel?.readyState === "open"
      ) {
        this.resumeIfConnected(peerId, item!);
      }
    };
    pc.oniceconnectionstatechange = () => this.resumeIfConnected(peerId, item!);
    pc.onicecandidateerror = (event) => {
      if (this.current(peerId, item!))
        this.config.log(
          `DIRECT ICE error peer=${peerId} connection=${item!.connectionId} code=${event.errorCode}`,
        );
    };
    pc.ondatachannel = (event) => {
      if (this.current(peerId, item!))
        this.attachChannel(peerId, item!, event.channel);
      else event.channel.close();
    };
    return item;
  }
  private attachChannel(
    peerId: string,
    direct: DirectConnection,
    channel: RTCDataChannel,
  ) {
    direct.channel = channel;
    channel.onopen = () => {
      void this.classify(peerId, direct, channel);
    };
    channel.onclose = () => {
      this.fail(peerId, direct, `DIRECT closed ${peerId}; RELAY fallback`);
    };
    channel.onerror = () => {
      this.fail(peerId, direct, `DataChannel error ${peerId}; RELAY fallback`);
    };
    channel.onmessage = (event) => {
      void (direct.classification || Promise.resolve())
        .then(() => {
          if (!direct.ready || !this.current(peerId, direct)) return;
          this.config.onMessage(
            JSON.parse(String(event.data)),
            peerId,
            direct.route,
          );
        })
        .catch((error) => {
          this.config.log(`bad direct message: ${String(error)}`);
        });
    };
  }
  private classify(peerId: string, direct: DirectConnection, channel: RTCDataChannel) {
    direct.classification = (async () => {
      try {
        const route = await inspectIceRoute(
          direct.pc,
          () => channel.readyState === "open" && this.current(peerId, direct),
        );
        if (!route) throw new Error("selected ICE route is unavailable");
        direct.route = route.mode;
        this.config.log(
          `ICE_SELECTED peer=${peerId} mode=${route.mode} local=${route.localType} remote=${route.remoteType}`,
        );
      } catch (error) {
        if (!this.current(peerId, direct)) return;
        this.fail(
          peerId,
          direct,
          `ICE route inspection unavailable ${peerId}: ${String(error)}; RELAY fallback`,
        );
        return;
      }
      if (
        channel.readyState !== "open" || !this.current(peerId, direct) ||
        ["disconnected", "failed"].includes(direct.pc.connectionState)
      )
        return;
      direct.ready = true;
      direct.everReady = true;
      direct.background = false;
      direct.recovering = false;
      direct.restartAttempted = false;
      this.clearTimers(direct);
      direct.failedUntil = 0;
      this.config.onMode(peerId, direct.route);
      this.config.log(`${direct.route} open ${peerId}`);
    })();
    return direct.classification;
  }
  private recover(peerId: string, direct: DirectConnection) {
    if (direct.recovering) return;
    this.clearTimers(direct);
    direct.ready = false;
    direct.recovering = true;
    direct.background = true;
    direct.restartAttempted = false;
    this.config.onMode(peerId, "RELAY");
    this.config.log(`DIRECT_RECOVERING peer=${peerId}; RELAY while reconnecting`);
    direct.backgroundTimer = setTimeout(() => {
      this.fail(peerId, direct, `DIRECT recovery exhausted ${peerId}; RELAY fallback`);
    }, this.config.recoveryTimeoutMs ?? 15000);
    direct.recoveryTimer = setTimeout(() => {
      void this.restart(peerId, direct);
    }, this.config.recoveryGraceMs ?? 1500);
  }
  private resumeIfConnected(peerId: string, direct: DirectConnection) {
    if (
      this.current(peerId, direct) && direct.recovering &&
      direct.pc.connectionState === "connected" &&
      ["connected", "completed"].includes(direct.pc.iceConnectionState) &&
      direct.channel?.readyState === "open"
    ) void this.classify(peerId, direct, direct.channel);
  }
  private async restart(peerId: string, direct: DirectConnection) {
    if (!this.current(peerId, direct) || !direct.recovering || direct.restartAttempted)
      return;
    if (direct.pc.signalingState !== "stable") {
      direct.recoveryTimer = setTimeout(() => { void this.restart(peerId, direct); }, 200);
      return;
    }
    direct.restartAttempted = true;
    this.config.log(`DIRECT_ICE_RESTART peer=${peerId} connection=${direct.connectionId}`);
    try {
      if (this.config.peerId < peerId) {
        direct.pc.restartIce?.();
        await this.makeOffer(peerId, direct, true);
      } else {
        await this.signal(peerId, direct, "request", {
          requestId: randomUUID(),
          restart: true,
        });
      }
    } catch (error) {
      this.fail(peerId, direct, `DIRECT restart failed ${peerId}: ${String(error)}; RELAY fallback`);
    }
  }
  private async flushCandidates(direct: DirectConnection) {
    for (const candidate of direct.candidates.splice(0))
      await direct.pc.addIceCandidate(candidate);
  }
  private async makeOffer(peerId: string, direct: DirectConnection, restart = false) {
    if (direct.ready && !restart) return;
    if (direct.negotiating) return direct.negotiating;
    this.startAttempt(peerId, direct);
    direct.negotiating = this.offer(peerId, direct, restart).finally(() => {
      direct.negotiating = undefined;
    });
    return direct.negotiating;
  }
  private async offer(peerId: string, direct: DirectConnection, restart: boolean) {
    direct.revision++;
    direct.candidates.length = 0;
    if (!direct.channel || direct.channel.readyState === "closed") {
      const channel = direct.pc.createDataChannel("chat", { ordered: true });
      this.attachChannel(peerId, direct, channel);
    }
    const offer = await direct.pc.createOffer(restart ? { iceRestart: true } : undefined);
    if (!this.current(peerId, direct)) return;
    await direct.pc.setLocalDescription(offer);
    if (!this.current(peerId, direct)) return;
    await this.signal(peerId, direct, "offer", {
      ...offer,
      ...(direct.peerRequestId ? { requestId: direct.peerRequestId } : {}),
    });
  }
  async receiveSignal(packet: SignalPacket): Promise<void> {
    if (this.closed) return;
    const previous = this.signals.get(packet.from) || Promise.resolve();
    const pending = previous
      .catch(() => { })
      .then(() => {
        if (!this.closed) return this.handleSignal(packet);
      });
    this.signals.set(packet.from, pending);
    try {
      await pending;
    } finally {
      if (this.signals.get(packet.from) === pending)
        this.signals.delete(packet.from);
    }
  }
  private async handleSignal(packet: SignalPacket): Promise<void> {
    const { from, kind, data } = packet;
    const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : undefined;
    const revision = typeof body.revision === "number" ? body.revision : undefined;
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    const existing = this.connections.get(from);
    const stale = () => this.config.log(`DIRECT_STALE_SIGNAL peer=${from} kind=${kind}`);
    if (connectionId && this.retired.get(from)?.has(connectionId)) {
      stale();
      return;
    }
    if (kind !== "request" && this.taggedPeers.has(from) && !connectionId) {
      stale();
      return;
    }
    if (connectionId) this.taggedPeers.add(from);
    const rtcData = { ...body };
    delete rtcData.connectionId;
    delete rtcData.revision;
    delete rtcData.requestId;
    delete rtcData.restart;
    if (kind === "request") {
      if (requestId) {
        const seen = this.requests.get(from) || new Set<string>();
        if (seen.has(requestId)) return;
        seen.add(requestId);
        if (seen.size > 64) seen.delete(seen.values().next().value!);
        this.requests.set(from, seen);
      }
      if (body.restart === true) {
        if (!existing || existing.connectionId !== connectionId || !existing.everReady) {
          stale();
          return;
        }
        this.recover(from, existing);
        clearTimeout(existing.recoveryTimer);
        await this.restart(from, existing);
        return;
      }
      // The lower Peer ID owns offers. Simultaneous send requests must not
      // replace its in-flight offer with a second connection.
      if (this.config.peerId > from) return;
      if (body.retry === true && existing) {
        this.connections.delete(from);
        this.dispose(from, existing);
      } else if (existing?.started && !existing.ready && !existing.background && this.current(from, existing))
        return;
      else if (existing?.background) {
        this.connections.delete(from);
        this.dispose(from, existing);
      }
      const direct = this.connection(from, true);
      direct.peerRequestId = requestId;
      if (this.config.peerId < from && direct.pc.signalingState === "stable")
        await this.makeOffer(from, direct);
      return;
    }
    if (kind === "offer") {
      if (existing && connectionId === existing.connectionId && revision !== undefined && revision < existing.revision) {
        stale();
        return;
      }
      if (requestId && requestId !== existing?.requestId) {
        stale();
        return;
      }
      const direct = this.connection(from, true, connectionId);
      if (direct.remoteOffer === body.sdp && direct.answer) {
        await this.signal(from, direct, "answer", direct.answer);
        return;
      }
      if (direct.pc.signalingState !== "stable") {
        // Resolve offer collisions deterministically. The normal path has
        // only the lower Peer ID offering, including for ICE restarts.
        if (this.config.peerId < from) return;
        await direct.pc.setLocalDescription({ type: "rollback" });
      }
      this.startAttempt(from, direct);
      if (revision !== undefined && revision !== direct.revision)
        direct.candidates.length = 0;
      direct.revision = revision ?? (direct.revision || 1);
      await direct.pc.setRemoteDescription(rtcData as unknown as RTCSessionDescriptionInit);
      if (!this.current(from, direct)) return;
      direct.remoteRevision = direct.revision;
      direct.remoteOffer = String(body.sdp);
      if (connectionId) {
        const key = `${connectionId}:${revision ?? 0}`;
        direct.candidates.push(...(this.earlyCandidates.get(from)?.get(key) || []));
        this.earlyCandidates.get(from)?.delete(key);
      }
      await this.flushCandidates(direct);
      const answer = await direct.pc.createAnswer();
      if (!this.current(from, direct)) return;
      await direct.pc.setLocalDescription(answer);
      if (!this.current(from, direct)) return;
      direct.answer = answer;
      await this.signal(from, direct, "answer", answer);
      this.resumeIfConnected(from, direct);
      return;
    }
    if (kind === "answer") {
      if (
        !existing || (connectionId && connectionId !== existing.connectionId) ||
        (revision !== undefined && revision !== existing.revision)
      ) {
        stale();
        return;
      }
      const direct = existing;
      if (direct.pc.remoteDescription && direct.pc.signalingState === "stable") return;
      await direct.pc.setRemoteDescription(rtcData as unknown as RTCSessionDescriptionInit);
      if (!this.current(from, direct)) return;
      direct.remoteRevision = direct.revision;
      await this.flushCandidates(direct);
      this.resumeIfConnected(from, direct);
      return;
    }
    if (kind !== "ice") return;
    if (existing && connectionId === existing.connectionId && revision !== undefined && revision < existing.revision) {
      stale();
      return;
    }
    if (connectionId && (
      connectionId !== existing?.connectionId ||
      (existing && revision !== undefined && revision > existing.revision)
    )) {
      // Trickle ICE can beat its offer across asynchronous authorization.
      // Keep a small bounded queue without replacing the live connection.
      const pending = this.earlyCandidates.get(from) || new Map<string, RTCIceCandidateInit[]>();
      const key = `${connectionId}:${revision ?? 0}`;
      if (!pending.has(key) && pending.size >= 4)
        pending.delete(pending.keys().next().value!);
      const candidates = pending.get(key) || [];
      if (candidates.length < 64) candidates.push(rtcData as RTCIceCandidateInit);
      pending.set(key, candidates);
      this.earlyCandidates.set(from, pending);
      return;
    }
    const direct = existing || this.connection(from);
    if (direct.pc.remoteDescription && (revision === undefined || direct.remoteRevision === revision))
      await direct.pc.addIceCandidate(rtcData as RTCIceCandidateInit);
    else if (direct.candidates.length < 64) direct.candidates.push(rtcData as RTCIceCandidateInit);
  }
  async ensure(peerId: string, forceRelay: boolean): Promise<boolean> {
    if (forceRelay || this.closed) return false;
    const direct = this.connection(peerId);
    if (this.availableMode(peerId)) return true;
    if (direct.failedUntil > Date.now()) return false;
    if (direct.background || direct.recovering) return false;
    if (direct.opening) return direct.opening;
    direct.opening = (async () => {
      const hasTurn =
        this.config.iceServers?.some((server) =>
          [server.urls].flat().some((url) => /^turns?:/i.test(url)),
        ) || false;
      this.config.log(
        `DIRECT_ATTEMPT peer=${peerId} connection=${direct.connectionId} policy=${this.config.policy || "all"} turnConfigured=${hasTurn}`,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;

      const deadline = new Promise<boolean>((resolve) => {
        direct.stopOpening = () => resolve(false);
        timer = setTimeout(
          () => resolve(false),
          this.config.timeoutMs ?? 10000,
        );
      });
      const negotiate = async () => {
        if (direct.started) return;
        this.startAttempt(peerId, direct);
        if (
          this.config.peerId < peerId &&
          direct.pc.signalingState === "stable"
        )
          await this.makeOffer(peerId, direct);
        else if (
          this.config.peerId > peerId &&
          direct.pc.signalingState === "stable"
        )
          try {
            await this.config.sendSignal(peerId, "request", {
              requestId: direct.requestId,
              ...(direct.retryRequested ? { retry: true } : {}),
            });
          } catch (error) {
            if (!(error instanceof SignalingTransportError)) throw error;
            this.config.log(`DIRECT_SIGNAL_TIMEOUT peer=${peerId} kind=request; ICE continues within deadline`);
          }
      };
      // Readiness is independent of signaling ACKs: the remote may have
      // received the offer and opened the channel before its ACK arrives.
      const waiting = async () => {
        while (!this.availableMode(peerId) && this.current(peerId, direct))
          await new Promise((resolve) => setTimeout(resolve, 100));
        return this.connections.get(peerId) === direct && !!this.availableMode(peerId);
      };
      void negotiate().catch((error) => {
        this.fail(peerId, direct, `DIRECT failed ${peerId}: ${String(error)}; RELAY fallback`);
      });
      try {
        const ready = await Promise.race([waiting(), deadline]);
        if (!ready && this.current(peerId, direct)) {
          await this.diagnose(peerId, direct);
          if (this.availableMode(peerId)) return true;
          if (this.config.backgroundTimeoutMs === 0) {
            this.fail(peerId, direct, `DIRECT timeout ${peerId}; RELAY fallback`);
          } else {
            direct.background = true;
            this.config.onMode(peerId, "RELAY");
            this.config.log(`DIRECT timeout ${peerId}; RELAY fallback; ICE continues within deadline`);
          }
        }
        return ready;
      } catch (error) {
        this.fail(
          peerId,
          direct,
          `DIRECT failed ${peerId}: ${String(error)}; RELAY fallback`,
        );
        return false;
      } finally {
        clearTimeout(timer);
        direct.stopOpening = undefined;
        direct.opening = undefined;
      }
    })();
    return direct.opening;
  }
  async retry(peerId: string) {
    const existing = this.connections.get(peerId);
    if (this.availableMode(peerId)) return true;
    if (existing) {
      this.connections.delete(peerId);
      this.dispose(peerId, existing);
    }
    this.connection(peerId).retryRequested = true;
    return this.ensure(peerId, false);
  }
  send(peerId: string, packet: unknown) {
    const direct = this.connections.get(peerId),
      channel = direct?.channel;
    if (
      !direct?.ready ||
      !this.availableMode(peerId) ||
      !this.current(peerId, direct) ||
      !channel ||
      channel.readyState !== "open"
    )
      throw new Error("direct unavailable");
    channel.send(JSON.stringify(packet));
  }
  mode(peerId: string): "DIRECT" | "TURN" {
    return this.connections.get(peerId)?.route || "DIRECT";
  }
  disconnect(peerId: string) {
    const direct = this.connections.get(peerId);
    if (!direct || !this.current(peerId, direct)) return false;
    this.fail(
      peerId,
      direct,
      `DIRECT closed by user ${peerId}; RELAY fallback`,
    );
    return true;
  }
  close() {
    this.closed = true;
    for (const [peerId, direct] of this.connections) this.dispose(peerId, direct);
    this.connections.clear();
    this.signals.clear();
    this.requests.clear();
    this.retired.clear();
    this.taggedPeers.clear();
    this.earlyCandidates.clear();
  }
}
