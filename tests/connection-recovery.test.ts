import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectTransport, type SignalKind, type SignalPacket } from "../src/shared/transport/directTransport.ts";
import { PeerClient } from "../src/shared/peer.ts";
import { SignalingTransportError } from "../src/shared/transport/signalingErrors.ts";
import type { ChatStore, PeerConfig, StoredMessage } from "../src/shared/peerTypes.ts";
import type { DeliveryMode } from "../src/shared/protocol.ts";

const cleanups: Array<() => void> = [];

function fixture(options: {
  peerId?: string;
  sendSignal?: (to: string, kind: SignalKind, data: unknown) => Promise<void>;
} = {}) {
  const instances: TestRTC[] = [], modes: DeliveryMode[] = [], logs: string[] = [];
  const sent: Array<{ to: string; kind: SignalKind; data: Record<string, unknown> }> = [];
  class TestRTC {
    connectionState = "new";
    iceConnectionState = "checking";
    iceGatheringState = "complete";
    signalingState = "stable";
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    onconnectionstatechange?: () => void;
    ondatachannel?: (event: RTCDataChannelEvent) => void;
    onicecandidate?: (event: RTCPeerConnectionIceEvent) => void;
    channel = { readyState: "connecting", send: vi.fn() } as unknown as RTCDataChannel;
    channelCount = 0;
    offers: Array<RTCOfferOptions | undefined> = [];
    added: RTCIceCandidateInit[] = [];
    restartIce = vi.fn();
    sctp = {
      transport: {
        iceTransport: {
          getSelectedCandidatePair: () => ({
            local: { type: "host" }, remote: { type: "host" },
          })
        }
      }
    };
    constructor() { instances.push(this); }
    createDataChannel() { this.channelCount++; return this.channel; }
    async createOffer(options?: RTCOfferOptions) {
      this.offers.push(options);
      return { type: "offer" as const, sdp: `offer ${this.offers.length}` };
    }
    async createAnswer() { return { type: "answer" as const, sdp: "answer" }; }
    async setLocalDescription(value: RTCSessionDescriptionInit) {
      this.localDescription = value;
      this.signalingState = value.type === "offer" ? "have-local-offer" : "stable";
    }
    async setRemoteDescription(value: RTCSessionDescriptionInit) {
      this.remoteDescription = value;
      this.signalingState = value.type === "offer" ? "have-remote-offer" : "stable";
    }
    async addIceCandidate(value: RTCIceCandidateInit) { this.added.push(value); }
    async getStats() {
      return new Map([
        ["pair", { type: "candidate-pair", state: "in-progress" }],
      ]);
    }
    open(incoming = false) {
      if (incoming) this.ondatachannel?.({ channel: this.channel } as RTCDataChannelEvent);
      this.connectionState = "connected";
      this.iceConnectionState = "completed";
      Object.assign(this.channel, { readyState: "open" });
      this.channel.onopen?.(new Event("open"));
      this.onconnectionstatechange?.();
    }
    close() {
      this.connectionState = "closed";
      this.signalingState = "closed";
      Object.assign(this.channel, { readyState: "closed" });
    }
  }
  const transport = new DirectTransport({
    peerId: options.peerId || "peer-a",
    rtc: TestRTC as unknown as PeerConfig["rtc"],
    timeoutMs: 1000,
    backgroundTimeoutMs: 3000,
    recoveryGraceMs: 500,
    recoveryTimeoutMs: 2000,
    sendSignal: async (to, kind, data) => {
      sent.push({ to, kind, data: data as Record<string, unknown> });
      await options.sendSignal?.(to, kind, data);
    },
    onMessage: () => { },
    onMode: (_id, mode) => modes.push(mode),
    log: (line) => logs.push(line),
  });
  cleanups.push(() => transport.close());
  return { transport, instances, modes, logs, sent, rtc: TestRTC };
}

async function opened(options: Parameters<typeof fixture>[0] = {}) {
  const value = fixture(options);
  const pending = value.transport.ensure("peer-b", false);
  await vi.advanceTimersByTimeAsync(1);
  const connectionId = value.sent.find((item) => item.kind === "offer")!.data.connectionId;
  await value.transport.receiveSignal({
    from: "peer-b", kind: "answer", data: {
      type: "answer", sdp: "initial answer", connectionId,
    }
  });
  value.instances[0].open();
  await vi.advanceTimersByTimeAsync(110);
  expect(await pending).toBe(true);
  return { ...value, connectionId };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("direct connection recovery and signaling generations", () => {
  it.each(["timeout", "denied", "forced"])(
    "keeps a usable channel only for a transient lookup failure, not a rejection or force-relay: %s",
    async (reason) => {
      vi.useFakeTimers();
      const value = await opened();
      const rows: StoredMessage[] = [];
      const store: ChatStore = {
        put: async (row) => { rows.push(row); }, mark: async () => { },
        has: async () => false, list: async () => [],
      };
      const client = new PeerClient({
        peerId: "peer-a", identityProof: "connection-recovery-test-proof-12345",
        signalUrl: "http://127.0.0.1:1", relayUrl: "http://127.0.0.1:2",
        rtc: value.rtc as unknown as PeerConfig["rtc"], store, onEvent: () => { },
        forceRelay: reason === "forced",
      });
      const internal = client as unknown as {
        directTransport: DirectTransport;
        signal: unknown;
        transport: (packet: unknown, mode: DeliveryMode) => Promise<{ queued: true }>;
      };
      internal.directTransport = value.transport;
      internal.signal = {
        connected: true, disconnect: () => { },
        timeout: () => ({
          emit: (_event: string, _payload: unknown, reply: (error: Error | null, result?: unknown) => void) => {
            if (reason === "timeout") reply(new Error("operation has timed out"));
            else reply(null, { ok: false, error: "direct chat blocked" });
          }
        }),
      };
      cleanups.push(() => client.close());
      const send = vi.spyOn(internal, "transport").mockResolvedValue({ queued: true });
      await client.sendDirect("peer-b", "message after a lookup failure");
      expect(send).toHaveBeenCalledWith(expect.anything(), reason === "timeout" ? "DIRECT" : "RELAY");
      expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
    },
  );

  it("does not wait for or tear down a usable channel because an offer ACK is lost", async () => {
    vi.useFakeTimers();
    const value = await opened({
      sendSignal: async (_to, kind) => {
        if (kind !== "offer") return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        throw new SignalingTransportError("operation has timed out");
      }
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
    expect(value.instances[0].connectionState).toBe("connected");
    expect(value.logs.some((line) => line.includes("keeping open channel"))).toBe(true);
  });

  it("still tears down a channel if the server explicitly rejects signaling", async () => {
    vi.useFakeTimers();
    const value = await opened({
      sendSignal: async (_to, kind) => {
        if (kind !== "offer") return;
        await new Promise((resolve) => setTimeout(resolve, 500));
        throw new Error("direct chat blocked");
      }
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(value.transport.availableMode("peer-b")).toBeUndefined();
    expect(value.instances[0].connectionState).toBe("closed");
  });

  it("uses relay at the send deadline and accepts a direct channel that opens during bounded background checks", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const opening = value.transport.ensure("peer-b", false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await opening).toBe(false);
    expect(value.instances[0].connectionState).not.toBe("closed");
    expect(await value.transport.ensure("peer-b", false)).toBe(false);
    value.instances[0].open();
    await vi.advanceTimersByTimeAsync(10);
    expect(await value.transport.ensure("peer-b", false)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(value.instances[0].connectionState).toBe("connected");
    expect(value.modes.at(-1)).toBe("DIRECT");
  });

  it("closes an unsuccessful background attempt at its hard deadline", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const opening = value.transport.ensure("peer-b", false);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await opening).toBe(false);
    expect(value.instances[0].connectionState).toBe("closed");
    expect(value.logs).toContain("DIRECT exhausted peer-b; RELAY fallback");
  });

  it("lets a brief disconnection recover without destroying the channel or restarting ICE", async () => {
    vi.useFakeTimers();
    const value = await opened();
    const pc = value.instances[0];
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    expect(value.modes.at(-1)).toBe("RELAY");
    expect(await value.transport.ensure("peer-b", false)).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2500);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(pc.connectionState).toBe("connected");
    expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
  });

  it("restarts ICE once using the existing channel after a longer disconnection", async () => {
    vi.useFakeTimers();
    const value = await opened();
    const pc = value.instances[0];
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(501);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(pc.offers.at(-1)).toEqual({ iceRestart: true });
    expect(pc.channelCount).toBe(1);
    expect(value.sent.at(-1)?.data.connectionId).toBe(value.connectionId);
    await value.transport.receiveSignal({
      from: "peer-b", kind: "answer", data: {
        type: "answer", sdp: "restart answer", connectionId: value.connectionId,
      }
    });
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2100);
    expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it("closes a recovery attempt that never succeeds and cancels all recovery timers on close", async () => {
    vi.useFakeTimers();
    const value = await opened();
    value.instances[0].connectionState = "disconnected";
    value.instances[0].onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2001);
    expect(value.instances[0].connectionState).toBe("closed");
    value.transport.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops old answers, offers and ICE after explicit retry without applying them to the new connection", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const first = value.transport.ensure("peer-b", false);
    await vi.advanceTimersByTimeAsync(1);
    const oldId = value.sent[0].data.connectionId;
    const second = value.transport.retry("peer-b");
    await vi.advanceTimersByTimeAsync(1);
    for (const [kind, data] of [
      ["answer", { type: "answer", sdp: "old answer", connectionId: oldId }],
      ["offer", { type: "offer", sdp: "old offer", connectionId: oldId }],
      ["ice", { candidate: "old candidate", connectionId: oldId }],
    ] as const) await value.transport.receiveSignal({ from: "peer-b", kind, data });
    expect(value.instances).toHaveLength(2);
    expect(value.instances[1].remoteDescription).toBeNull();
    expect(value.instances[1].added).toEqual([]);
    expect(value.logs.filter((line) => line.startsWith("DIRECT_STALE_SIGNAL"))).toHaveLength(3);
    value.transport.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });

  it("buffers ICE that arrives before its offer and strips protocol metadata before calling WebRTC", async () => {
    vi.useFakeTimers();
    const value = fixture({ peerId: "peer-b" });
    const connectionId = crypto.randomUUID();
    await value.transport.receiveSignal({
      from: "peer-a", kind: "ice", data: {
        candidate: "candidate before offer", sdpMid: "0", connectionId,
      }
    });
    expect(value.instances).toHaveLength(0);
    await value.transport.receiveSignal({
      from: "peer-a", kind: "offer", data: {
        type: "offer", sdp: "initial offer", connectionId,
      }
    });
    expect(value.instances[0].remoteDescription).toEqual({ type: "offer", sdp: "initial offer" });
    expect(value.instances[0].added).toEqual([{ candidate: "candidate before offer", sdpMid: "0" }]);
    expect(value.sent.at(-1)?.data.connectionId).toBe(connectionId);
  });

  it("correlates an offer with the current request and keeps the responder's wait alive", async () => {
    vi.useFakeTimers();
    const value = fixture({ peerId: "peer-b" });
    const first = value.transport.ensure("peer-a", false);
    await vi.advanceTimersByTimeAsync(1);
    const oldRequest = value.sent[0].data.requestId;
    const second = value.transport.retry("peer-a");
    await vi.advanceTimersByTimeAsync(1);
    const requestId = value.sent[1].data.requestId;
    await value.transport.receiveSignal({
      from: "peer-a", kind: "offer", data: {
        type: "offer", sdp: "old response", requestId: oldRequest, connectionId: crypto.randomUUID(),
      }
    });
    expect(value.instances[1].remoteDescription).toBeNull();
    await value.transport.receiveSignal({
      from: "peer-a", kind: "offer", data: {
        type: "offer", sdp: "current response", requestId, connectionId: crypto.randomUUID(),
      }
    });
    expect(value.instances).toHaveLength(2);
    value.instances[1].open(true);
    await vi.advanceTimersByTimeAsync(110);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });

  it("establishes a single session when both peers initiate together", async () => {
    vi.useFakeTimers();
    let a!: ReturnType<typeof fixture>, b!: ReturnType<typeof fixture>;
    const errors: unknown[] = [];
    function deliver(peer: () => ReturnType<typeof fixture>, from: string, kind: SignalKind, data: unknown) {
      queueMicrotask(() => { void peer().transport.receiveSignal({ from, kind, data } as SignalPacket).catch((error) => errors.push(error)); });
      return Promise.resolve();
    }
    a = fixture({ sendSignal: (_to, kind, data) => deliver(() => b, "peer-a", kind, data) });
    b = fixture({ peerId: "peer-b", sendSignal: (_to, kind, data) => deliver(() => a, "peer-b", kind, data) });
    const aReady = a.transport.ensure("peer-b", false), bReady = b.transport.ensure("peer-a", false);
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toEqual([]);
    expect(a.instances).toHaveLength(1);
    expect(b.instances).toHaveLength(1);
    expect(a.instances[0].remoteDescription?.type).toBe("answer");
    expect(b.instances[0].remoteDescription?.type).toBe("offer");
    a.instances[0].open();
    b.instances[0].open(true);
    await vi.advanceTimersByTimeAsync(110);
    expect(await aReady).toBe(true);
    expect(await bReady).toBe(true);
  });

  it("ignores a previously handled request even after a newer request establishes another channel", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const requestId = crypto.randomUUID();
    await value.transport.receiveSignal({ from: "peer-b", kind: "request", data: { requestId } });
    value.instances[0].open();
    await vi.advanceTimersByTimeAsync(10);
    await value.transport.receiveSignal({ from: "peer-b", kind: "request", data: { requestId: crypto.randomUUID() } });
    value.instances[1].open();
    await vi.advanceTimersByTimeAsync(10);
    await value.transport.receiveSignal({ from: "peer-b", kind: "request", data: { requestId } });
    expect(value.instances).toHaveLength(2);
    expect(value.instances[1].connectionState).toBe("connected");
    expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
  });

  it("asks the offer owner to restart ICE when the responder loses connectivity", async () => {
    vi.useFakeTimers();
    const value = fixture({ peerId: "peer-b" });
    const connectionId = crypto.randomUUID();
    await value.transport.receiveSignal({
      from: "peer-a", kind: "offer", data: {
        type: "offer", sdp: "initial offer", connectionId,
      }
    });
    value.instances[0].open(true);
    await vi.advanceTimersByTimeAsync(10);
    value.instances[0].connectionState = "disconnected";
    value.instances[0].onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(501);
    expect(value.sent.at(-1)).toMatchObject({
      to: "peer-a", kind: "request", data: { restart: true, connectionId },
    });
    expect(value.instances[0].restartIce).not.toHaveBeenCalled();
  });

  it("handles a matching restart request without replacing an established peer connection", async () => {
    vi.useFakeTimers();
    const value = await opened();
    await value.transport.receiveSignal({
      from: "peer-b", kind: "request", data: {
        requestId: crypto.randomUUID(), connectionId: value.connectionId, restart: true,
      }
    });
    expect(value.instances).toHaveLength(1);
    expect(value.instances[0].restartIce).toHaveBeenCalledTimes(1);
    expect(value.instances[0].channelCount).toBe(1);
    expect(value.sent.at(-1)).toMatchObject({ kind: "offer", data: { connectionId: value.connectionId } });
  });

  it("does not accept an untagged late answer once the remote has used connection IDs", async () => {
    vi.useFakeTimers();
    const value = await opened();
    value.instances[0].connectionState = "disconnected";
    value.instances[0].onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(501);
    await value.transport.receiveSignal({
      from: "peer-b", kind: "answer", data: {
        type: "answer", sdp: "untagged stale answer",
      }
    });
    expect(value.instances[0].remoteDescription?.sdp).toBe("initial answer");
    expect(value.instances[0].signalingState).toBe("have-local-offer");
  });

  it("rejects an answer and candidates from an earlier ICE revision during recovery", async () => {
    vi.useFakeTimers();
    const value = await opened();
    const pc = value.instances[0];
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(501);
    const revision = value.sent.at(-1)!.data.revision as number;
    expect(revision).toBe(2);
    await value.transport.receiveSignal({
      from: "peer-b", kind: "answer", data: {
        type: "answer", sdp: "duplicate old answer", connectionId: value.connectionId, revision: 1,
      }
    });
    await value.transport.receiveSignal({
      from: "peer-b", kind: "ice", data: {
        candidate: "old ICE", connectionId: value.connectionId, revision: 1,
      }
    });
    expect(pc.remoteDescription?.sdp).toBe("initial answer");
    expect(pc.added).toEqual([]);
    await value.transport.receiveSignal({
      from: "peer-b", kind: "ice", data: {
        candidate: "new ICE", connectionId: value.connectionId, revision,
      }
    });
    expect(pc.added).toEqual([]);
    await value.transport.receiveSignal({
      from: "peer-b", kind: "answer", data: {
        type: "answer", sdp: "new answer", connectionId: value.connectionId, revision,
      }
    });
    expect(pc.added).toEqual([{ candidate: "new ICE" }]);
  });

  it("does not restart a recovered connection again when an old restart request is repeated", async () => {
    vi.useFakeTimers();
    const value = await opened();
    const request = { from: "peer-b", kind: "request" as const, data: {
      requestId: crypto.randomUUID(), connectionId: value.connectionId, restart: true,
    } };
    await value.transport.receiveSignal(request);
    await value.transport.receiveSignal({ from: "peer-b", kind: "answer", data: {
      type: "answer", sdp: "recovered answer", connectionId: value.connectionId, revision: 2,
    } });
    await vi.advanceTimersByTimeAsync(10);
    expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
    await value.transport.receiveSignal(request);
    expect(value.instances[0].restartIce).toHaveBeenCalledTimes(1);
    expect(value.transport.availableMode("peer-b")).toBe("DIRECT");
  });

  it.each([50, 1100])("creates a new session at both ends when the responder retries a pending attempt after %ims", async (delay) => {
    vi.useFakeTimers();
    let a!: ReturnType<typeof fixture>, b!: ReturnType<typeof fixture>;
    const errors: unknown[] = [];
    function deliver(peer: () => ReturnType<typeof fixture>, from: string, kind: SignalKind, data: unknown) {
      queueMicrotask(() => { void peer().transport.receiveSignal({ from, kind, data }).catch((error) => errors.push(error)); });
      return Promise.resolve();
    }
    a = fixture({ sendSignal: (_to, kind, data) => deliver(() => b, "peer-a", kind, data) });
    b = fixture({ peerId: "peer-b", sendSignal: (_to, kind, data) => deliver(() => a, "peer-b", kind, data) });
    const initial = a.transport.ensure("peer-b", false);
    await vi.advanceTimersByTimeAsync(delay);
    const retry = b.transport.retry("peer-a");
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toEqual([]);
    expect(a.instances).toHaveLength(2);
    expect(b.instances).toHaveLength(2);
    expect(b.sent.find((packet) => packet.kind === "request")?.data.retry).toBe(true);
    a.instances[1].open();
    b.instances[1].open(true);
    await vi.advanceTimersByTimeAsync(110);
    expect(await initial).toBe(false);
    expect(await retry).toBe(true);
    expect(a.transport.availableMode("peer-b")).toBe("DIRECT");
  });
});
