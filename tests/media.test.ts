import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io, type Socket } from "socket.io-client";
import { createRelay } from "../src/relay/index.ts";
import { createIdentity, SecureChannel } from "../src/shared/secure.ts";
import {
  MediaSession,
  type CallState,
  type MediaSignal,
} from "../src/shared/media.ts";
import {
  mediaFrameSchema,
  type MediaFrame,
} from "../src/shared/mediaProtocol.ts";
import type { RTCFactory } from "../src/shared/peerTypes.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function ciphers(callId = randomUUID()) {
  const identities = {
    "peer-a": await createIdentity(),
    "peer-b": await createIdentity(),
  };
  const make = (id: keyof typeof identities) =>
    new SecureChannel(
      id,
      async (other) => identities[other as keyof typeof identities].public,
      {
        getIdentity: async () => identities[id],
        putIdentity: async () => {},
        getPin: async () => undefined,
        putPin: async () => {},
      },
    );
  const a = make("peer-a"),
    b = make("peer-b");
  return {
    callId,
    a,
    b,
    ac: await a.mediaCipher("peer-b", callId),
    bc: await b.mediaCipher("peer-a", callId),
  };
}
async function relayFixture(allowed = true) {
  const service = createRelay(undefined, undefined, async () => allowed);
  cleanup.push(() => service.close());
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  const url =
    "http://127.0.0.1:" + (service.httpServer.address() as AddressInfo).port;
  const connect = async (id: string) => {
    const token = jwt.sign({ sub: id }, process.env.PEER_SECRET!, {
      expiresIn: 60,
      audience: "ds01-relay",
      issuer: "ds01-signaling",
    });
    const socket = io(url, {
      transports: ["websocket"],
      auth: { token },
      reconnection: false,
    });
    cleanup.push(() => {
      socket.disconnect();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  };
  return {
    service,
    a: await connect("peer-a"),
    b: await connect("peer-b"),
    url,
  };
}
const rpc = (socket: Socket, event: string, input: unknown) =>
  socket.timeout(1000).emitWithAck(event, input);

describe("encrypted relay calls", () => {
  it("encrypts binary media and authenticates the call, sequence, kind and identities", async () => {
    const { callId, a, ac, bc } = await ciphers(),
      bytes = new Uint8Array(1280).fill(37);
    const frame = await ac.seal("audio", 1, bytes);
    expect(await bc.open(frame)).toEqual(bytes);
    expect(JSON.stringify(frame)).not.toContain("37,37");
    for (const change of [
      { kind: "video" },
      { sequence: 2 },
      { senderId: "peer-c" },
      { receiverId: "peer-c" },
      { callId: randomUUID() },
    ]) {
      await expect(
        bc.open({ ...frame, ...change } as MediaFrame),
      ).rejects.toThrow();
    }
    const otherCall = await a.mediaCipher("peer-b", randomUUID());
    await expect(
      bc.open(await otherCall.seal("audio", 1, bytes)),
    ).rejects.toThrow();
    await expect(ac.seal("video", 0, new Uint8Array(11001))).rejects.toThrow(
      "too large",
    );
    expect(frame.callId).toBe(callId);
  });
  it("requires mutual call consent and preserves ciphertext without chat forwarding or storage", async () => {
    const { service, a, b } = await relayFixture(),
      { callId, ac, bc } = await ciphers();
    const frames: MediaFrame[] = [];
    b.on("media:frame", (frame) => frames.push(frame));
    expect(await rpc(a, "media:open", { to: "peer-b", callId })).toEqual({
      ok: true,
    });
    a.emit("media:frame", await ac.seal("audio", 0, new Uint8Array(1280)));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames).toHaveLength(0);
    expect(await rpc(b, "media:open", { to: "peer-a", callId })).toEqual({
      ok: true,
    });
    const frame = await ac.seal("audio", 1, new Uint8Array(1280).fill(42));
    a.emit("media:frame", frame);
    await vi.waitFor(() => expect(frames).toEqual([frame]));
    expect(await bc.open(frames[0])).toEqual(new Uint8Array(1280).fill(42));
    expect(service.cluster.journal.pending()).toHaveLength(0);
    const health = await (
      await fetch(
        "http://127.0.0.1:" +
          (service.httpServer.address() as AddressInfo).port +
          "/health",
      )
    ).json();
    expect(health.metrics).toMatchObject({
      mediaFrames: 1,
      forwardedMessages: 0,
    });
    await rpc(b, "media:close", { to: "peer-a", callId });
    a.emit("media:frame", frame);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames).toHaveLength(1);
  });
  it("rejects identity spoofing, oversized frames, mismatched calls and expired recipients", async () => {
    const { service, a, b, url } = await relayFixture(),
      { callId, ac } = await ciphers();
    await rpc(a, "media:open", { to: "peer-b", callId });
    await rpc(b, "media:open", { to: "peer-a", callId });
    const received = vi.fn();
    b.on("media:frame", received);
    const frame = await ac.seal("audio", 0, new Uint8Array(1280));
    for (const change of [
      { senderId: "peer-c" },
      { callId: randomUUID() },
      { ciphertext: "a".repeat(15001) },
    ])
      a.emit("media:frame", { ...frame, ...change });
    service.connections.get("peer-b")!.data.tokenExpiresAt = Date.now() - 1;
    a.emit("media:frame", frame);
    await vi.waitFor(async () =>
      expect(
        (await (await fetch(url + "/health")).json()).metrics.rejectedMedia,
      ).toBe(4),
    );
    expect(received).not.toHaveBeenCalled();
    expect(mediaFrameSchema.safeParse({ ...frame, extra: true }).success).toBe(
      false,
    );
  });
  it("rejects blocked peers and concurrent replacement calls", async () => {
    const denied = await relayFixture(false),
      callId = randomUUID();
    expect(
      await rpc(denied.a, "media:open", { to: "peer-b", callId }),
    ).toMatchObject({ ok: false });
    const allowed = await relayFixture();
    expect(
      await rpc(allowed.a, "media:open", { to: "peer-b", callId }),
    ).toEqual({ ok: true });
    expect(
      await rpc(allowed.a, "media:open", {
        to: "peer-b",
        callId: randomUUID(),
      }),
    ).toMatchObject({ ok: false });
  });
});

class FakeRTC {
  connectionState = "new";
  signalingState = "stable";
  remoteDescription?: RTCSessionDescriptionInit;
  onconnectionstatechange?: () => void;
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  addTrack = vi.fn();
  async createOffer() {
    return { type: "offer" as const, sdp: "offer-sdp" };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "answer-sdp" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(value: RTCSessionDescriptionInit) {
    this.remoteDescription = value;
  }
  async addIceCandidate() {}
}
function sessionFixture(
  extra: Partial<ConstructorParameters<typeof MediaSession>[0]> = {},
) {
  let pc!: FakeRTC;
  const track = { kind: "audio", enabled: true, stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const driver = {
    unlock: vi.fn(),
    prepare: vi.fn(async () => {}),
    start: vi.fn(),
    receive: vi.fn(),
    close: vi.fn(),
  };
  const sent: MediaSignal[] = [],
    states: CallState[] = [];
  const session = new MediaSession({
    rtc: class extends FakeRTC {
      constructor() {
        super();
        pc = this;
      }
    } as unknown as RTCFactory,
    devices: { getUserMedia: async () => stream },
    driver: () => driver,
    send: async (_to, data) => {
      sent.push(data);
    },
    emit: (state) => states.push(state),
    log: () => {},
    ...extra,
  });
  cleanup.push(() => session.close());
  return { session, driver, track, sent, states, pc: () => pc };
}

describe("call lifecycle and recovery", () => {
  it.each(["audio", "video"] as const)(
    "simulates blocked ICE for a new %s call and delivers real relay frames only after consent",
    async (kind) => {
      const { callId, ac, bc } = await ciphers(),
        configurations: RTCConfiguration[] = [],
        logs: string[] = [];
      const link = { send: vi.fn(() => true), close: vi.fn() };
      let simulate = true;
      const { session, driver, states } = sessionFixture({
        rtc: class extends FakeRTC {
          constructor(config: RTCConfiguration) {
            super();
            configurations.push(config);
          }
        } as unknown as RTCFactory,
        simulateIceFailure: () => simulate,
        iceServers: [
          {
            urls: "turn:example.org",
            username: "demo",
            credential: "temporary",
          },
        ],
        fallbackMs: 10,
        relay: async () => link,
        cipher: async () => bc,
        log: (text) => logs.push(text),
      });
      await session.receive("peer-a", {
        action: "offer",
        callId,
        kind,
        sdp: "offer-sdp",
        relay: 1,
      });
      expect(configurations).toHaveLength(0);
      expect(driver.prepare).not.toHaveBeenCalled();
      await session.accept();
      expect(configurations).toEqual([
        { iceServers: [], iceTransportPolicy: "relay" },
      ]);
      expect(states.at(-1)?.route).toBeUndefined();
      await vi.waitFor(() => expect(driver.prepare).toHaveBeenCalledOnce());
      await session.receive("peer-a", { action: "relay-ready", callId });
      await session.receiveFrame(
        await ac.seal("audio", 0, new Uint8Array(1280).fill(37)),
      );
      expect(driver.receive).toHaveBeenCalledWith(
        "audio",
        new Uint8Array(1280).fill(37),
        0,
      );
      expect(states.at(-1)).toMatchObject({
        route: "RELAY",
        phase: "connected",
      });
      expect(logs).toContain("CALL_ICE_BLOCKED " + callId + " simulation=1");
      await session.end();
      simulate = false;
      await session.start("peer-a", kind);
      expect(configurations.at(-1)).toEqual({
        iceServers: [
          {
            urls: "turn:example.org",
            username: "demo",
            credential: "temporary",
          },
        ],
        iceTransportPolicy: "all",
      });
    },
  );
  it("reports the concrete relay failure instead of silently relabeling a failed call", async () => {
    const logs: string[] = [],
      { bc, callId } = await ciphers();
    const { session, states } = sessionFixture({
      fallbackMs: 10,
      cipher: async () => bc,
      relay: async () => {
        throw Error("destination relay connection offline");
      },
      log: (text) => logs.push(text),
    });
    await session.receive("peer-a", {
      action: "offer",
      callId,
      kind: "audio",
      sdp: "offer-sdp",
      relay: 1,
    });
    await session.accept();
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe("failed"));
    expect(states.at(-1)?.route).toBeUndefined();
    expect(states.at(-1)?.error).toBe("destination relay connection offline");
    expect(logs).toContain(
      "CALL_RELAY_ERROR " +
        callId +
        " peer=peer-a destination relay connection offline",
    );
  });
  it("serializes media signaling while an answer is being applied", async () => {
    const { session, pc } = sessionFixture();
    await session.start("peer-b", "audio");
    const callId = (session as unknown as { state: CallState }).state.callId;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    pc().setRemoteDescription = async () => {
      await blocked;
      pc().remoteDescription = { type: "answer", sdp: "x" };
    };
    const add = vi.spyOn(pc(), "addIceCandidate");
    const answer = session.receive("peer-b", {
      action: "answer",
      callId,
      sdp: "answer-sdp",
    });
    const ice = session.receive("peer-b", {
      action: "ice",
      callId,
      candidate: { candidate: "candidate" },
    });
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
    release();
    await Promise.all([answer, ice]);
    expect(add).toHaveBeenCalledOnce();
  });
  it("keeps a transient disconnect alive while ICE reconnects", async () => {
    const { session, pc, states } = sessionFixture({ disconnectGraceMs: 100 });
    await session.start("peer-b", "audio");
    const callId = states.at(-1)!.callId;
    await session.receive("peer-b", {
      action: "answer",
      callId,
      sdp: "answer-sdp",
    });
    pc().connectionState = "disconnected";
    pc().onconnectionstatechange?.();
    expect(states.at(-1)?.phase).toBe("connecting");
    pc().connectionState = "connected";
    pc().onconnectionstatechange?.();
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(states.at(-1)?.phase).toBe("connected");
  });
  it("cleans up a cancelled permission request without reviving the call", async () => {
    let release!: (value: MediaStream) => void;
    let requested = false;
    const pending = new Promise<MediaStream>((resolve) => {
      release = resolve;
    });
    const { session, track, states } = sessionFixture({
      devices: {
        getUserMedia: async () => {
          requested = true;
          return pending;
        },
      },
    });
    const starting = session.start("peer-b", "audio").catch(() => {});
    await vi.waitFor(() => expect(requested).toBe(true));
    await session.end();
    release({ getTracks: () => [track] } as unknown as MediaStream);
    await starting;
    expect(track.stop).toHaveBeenCalled();
    expect(states.at(-1)?.phase).toBe("ended");
  });
  it("falls back only after acceptance, deduplicates frames and closes the relay on hangup", async () => {
    const { callId, ac, bc } = await ciphers(),
      link = { send: vi.fn(() => true), close: vi.fn() };
    const { session, driver, states, sent } = sessionFixture({
      fallbackMs: 10,
      relay: async () => link,
      cipher: async () => bc,
    });
    await session.receive("peer-a", {
      action: "offer",
      callId,
      kind: "audio",
      sdp: "offer-sdp",
      relay: 1,
    });
    await session.receive("peer-a", { action: "relay-request", callId });
    expect(driver.prepare).not.toHaveBeenCalled();
    await session.accept();
    await vi.waitFor(() =>
      expect(sent.some((signal) => signal.action === "relay-request")).toBe(
        true,
      ),
    );
    await session.receive("peer-a", { action: "relay-ready", callId });
    const frame = await ac.seal("audio", 1, new Uint8Array(1280));
    await session.receiveFrame(frame);
    await session.receiveFrame(frame);
    expect(driver.receive).toHaveBeenCalledOnce();
    expect(driver.start).toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "connected", route: "RELAY" });
    await session.end();
    expect(link.close).toHaveBeenCalledOnce();
    expect(driver.close).toHaveBeenCalled();
  });
});
