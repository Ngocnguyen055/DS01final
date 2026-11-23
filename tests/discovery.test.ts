import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";
import {
  PeerClient,
  type PeerConfig,
  type PeerEvent,
} from "../src/shared/index.ts";

type Service =
  ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [],
  sockets: Socket[] = [],
  clients: PeerClient[] = [];
const connection = {
  transport: "webrtc-datachannel",
  signaling: "socket.io",
  relay: "socket.io",
};
const proof = "discovery-test-identity-proof-12345";
async function listen<T extends Service>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function connect(url: string) {
  const socket = io(url, { transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}
async function register(
  socket: Socket,
  peerId: string,
  extra: Record<string, unknown> = {},
) {
  return socket
    .timeout(2000)
    .emitWithAck("peer:register", { peerId, identityProof: proof, ...extra });
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  sockets.splice(0).forEach((socket) => socket.disconnect());
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const service of services.splice(0).reverse()) await service.close();
});

describe("joining and peer discovery", () => {
  it("returns complete public registration metadata without identity or connection secrets", async () => {
    const signal = createSignaling(),
      url = await listen(signal),
      socket = await connect(url);
    const result = await register(socket, "peer-a", {
      displayName: "  Peer A  ",
      status: "online",
      connection,
    });
    expect(result.ok).toBe(true);
    expect(result.profiles).toEqual([
      {
        peerId: "peer-a",
        displayName: "Peer A",
        status: "online",
        online: true,
        lastSeen: expect.any(Number),
        connection,
      },
    ]);
    const list = await socket.timeout(2000).emitWithAck("peer:list");
    expect(list.profiles).toEqual(result.profiles);
    expect(JSON.stringify(list)).not.toMatch(
      /identityProof|socketId|token|address/,
    );
    expect(signal.peers.get("peer-a")).toMatchObject({
      displayName: "Peer A",
      status: "online",
      connection,
    });
  });

  it.each([
    { status: "offline" },
    { connection: { ...connection, relay: "http" } },
    { connection: { ...connection, privateIp: "192.168.1.1" } },
    { extra: "unexpected registration field" },
  ])(
    "rejects malformed registration metadata before reserving an identity: %#",
    async (metadata) => {
      const signal = createSignaling(),
        url = await listen(signal),
        socket = await connect(url);
      expect((await register(socket, "peer-a", metadata)).ok).toBe(false);
      expect(signal.peers.size).toBe(0);
    },
  );

  it.each(["heartbeat", "expired-auth", "revoked-session"] as const)(
    "excludes a stale peer from every discovery snapshot before the sweep: %s",
    async (reason) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const signal = createSignaling(),
        url = await listen(signal),
        a = await connect(url),
        b = await connect(url);
      expect((await register(a, "peer-a")).ok).toBe(true);
      expect((await register(b, "peer-b")).ok).toBe(true);
      const old = signal.peers.get("peer-b")!,
        now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      if (reason === "heartbeat") old.lastSeen = now - 30000;
      if (reason === "expired-auth") old.socket.data.authExpiresAt = now;
      if (reason === "revoked-session")
        old.socket.data.authSession = "revoked-session";
      const c = await connect(url),
        broadcasts: unknown[][] = [];
      a.on("peer:profiles", (profiles) => broadcasts.push(profiles));
      const joined = await register(c, "peer-c");
      expect(joined.peers).toEqual(["peer-a", "peer-c"]);
      expect(
        joined.profiles.map((item: { peerId: string }) => item.peerId),
      ).toEqual(joined.peers);
      const list = await a.timeout(2000).emitWithAck("peer:list");
      expect(list.peers).toEqual(joined.peers);
      expect(
        (await a.timeout(2000).emitWithAck("peer:lookup", { peerId: "peer-b" }))
          .peer,
      ).toEqual({
        peerId: "peer-b",
        online: false,
        lastSeen: null,
        connection: null,
      });
      expect(
        await a
          .timeout(2000)
          .emitWithAck("signal:send", {
            to: "peer-b",
            kind: "request",
            data: null,
          }),
      ).toMatchObject({ ok: false, error: "peer offline" });
      await until(() => broadcasts.length > 0);
      expect(broadcasts.at(-1)).toEqual(joined.profiles);
      expect(signal.peers.has("peer-b")).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(signal.peers.has("peer-b")).toBe(false);
    },
  );

  it("does not revive an expired lease with a late heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signal = createSignaling(),
      url = await listen(signal),
      socket = await connect(url);
    expect((await register(socket, "peer-a")).ok).toBe(true);
    const now = Date.now(),
      peer = signal.peers.get("peer-a")!;
    vi.spyOn(Date, "now").mockReturnValue(now);
    peer.lastSeen = now - 30000;
    socket.emit("peer:heartbeat");
    expect(await socket.timeout(2000).emitWithAck("peer:list")).toEqual({
      ok: false,
      error: "registration required",
    });
    expect(peer.lastSeen).toBe(now - 30000);
    expect((await register(socket, "peer-a")).ok).toBe(true);
    expect((await socket.timeout(2000).emitWithAck("peer:list")).peers).toEqual(
      ["peer-a"],
    );
  });

  it("keeps an active peer online when its heartbeat arrives before expiry", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signal = createSignaling(),
      url = await listen(signal),
      socket = await connect(url);
    expect((await register(socket, "peer-a")).ok).toBe(true);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    signal.peers.get("peer-a")!.lastSeen = now - 29999;
    socket.emit("peer:heartbeat");
    expect(
      (await socket.timeout(2000).emitWithAck("peer:list")).profiles,
    ).toEqual([expect.objectContaining({ peerId: "peer-a", lastSeen: now })]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(signal.peers.has("peer-a")).toBe(true);
  });
  it("renews a live transport when the browser application heartbeat timer is suspended", async () => {
    const signal = createSignaling();
    signal.io.engine.opts.pingInterval = 20;
    const url = await listen(signal),
      socket = await connect(url);
    expect((await register(socket, "peer-a")).ok).toBe(true);
    const peer = signal.peers.get("peer-a")!,
      now = Date.now();
    peer.lastSeen = now - 29000;
    const heartbeat = new Promise<void>((resolve) =>
      peer.socket.conn.once("heartbeat", resolve),
    );
    await heartbeat;
    expect(peer.lastSeen).toBeGreaterThanOrEqual(now);
    expect((await socket.timeout(2000).emitWithAck("peer:list")).peers).toEqual(
      ["peer-a"],
    );
  });
  it.each(["expired-lease", "expired-auth"] as const)(
    "does not revive %s from transport pongs",
    async (reason) => {
      const signal = createSignaling();
      signal.io.engine.opts.pingInterval = 20;
      const url = await listen(signal),
        socket = await connect(url);
      expect((await register(socket, "peer-a")).ok).toBe(true);
      const peer = signal.peers.get("peer-a")!,
        now = Date.now();
      peer.lastSeen = now - (reason === "expired-lease" ? 30000 : 1000);
      if (reason === "expired-auth") peer.socket.data.authExpiresAt = now;
      const previous = peer.lastSeen;
      await new Promise<void>((resolve) =>
        peer.socket.conn.once("heartbeat", resolve),
      );
      expect(peer.lastSeen).toBe(previous);
      expect((await socket.timeout(2000).emitWithAck("peer:list")).ok).toBe(
        false,
      );
    },
  );

  it("allows exactly one concurrent registration for a Peer ID and safely replaces an expired connection", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signal = createSignaling(),
      url = await listen(signal),
      first = await connect(url),
      second = await connect(url);
    const results = await Promise.all([
      register(first, "peer-a"),
      register(second, "peer-a"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const original = signal.peers.get("peer-a")!,
      replacement = results[0].ok ? second : first;
    original.lastSeen = Date.now() - 31000;
    expect((await register(replacement, "peer-a")).ok).toBe(true);
    await until(() => !(results[0].ok ? first : second).connected);
    expect(signal.peers.get("peer-a")!.socket.id).toBe(replacement.id);
    expect(
      (await replacement.timeout(2000).emitWithAck("peer:list")).peers,
    ).toEqual(["peer-a"]);
  });

  it("advertises complete metadata from PeerClient and clears its cached presence on close", async () => {
    const signal = createSignaling(),
      signalUrl = await listen(signal),
      relayUrl = await listen(createRelay());
    let advertised: unknown;
    signal.io.on("connection", (socket) =>
      socket.prependListener("peer:register", (value) => {
        advertised = value;
      }),
    );
    const events: PeerEvent[] = [];
    const client = new PeerClient({
      peerId: "peer-a",
      identityProof: proof,
      signalUrl,
      relayUrl,
      rtc: class {} as unknown as PeerConfig["rtc"],
      store: {
        put: async () => {},
        mark: async () => {},
        has: async () => false,
        list: async () => [],
      },
      onEvent: (event) => events.push(event),
    });
    clients.push(client);
    await client.connect();
    expect(advertised).toMatchObject({
      peerId: "peer-a",
      displayName: "peer-a",
      status: "online",
      connection,
    });
    await until(() =>
      events.some((event) =>
        event.profiles?.some((profile) => profile.peerId === "peer-a"),
      ),
    );
    client.close();
    expect(client.getOnlinePeers()).toEqual([]);
    expect(
      events.filter((event) => event.kind === "presence").at(-1),
    ).toMatchObject({ peers: [], profiles: [] });
  });

  it("allows an authenticated account to log in again after its old peer lease expires", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signal = createSignaling(),
      url = await listen(signal),
      control = await connect(url),
      first = await connect(url),
      second = await connect(url);
    const credentials = {
      username: "discovery-alice",
      password: "Discovery account passphrase!",
    };
    expect(
      (
        await control
          .timeout(3000)
          .emitWithAck("auth:register", {
            ...credentials,
            displayName: "Alice",
          })
      ).ok,
    ).toBe(true);
    const original = await control
      .timeout(3000)
      .emitWithAck("auth:login", credentials);
    expect(original.ok).toBe(true);
    expect(
      (
        await register(first, "user_discovery-alice", {
          identityProof: original.token,
        })
      ).ok,
    ).toBe(true);
    signal.peers.get("user_discovery-alice")!.lastSeen = Date.now() - 31000;
    const refreshed = await control
      .timeout(3000)
      .emitWithAck("auth:login", credentials);
    expect(refreshed.ok).toBe(true);
    expect(
      (
        await register(second, "user_discovery-alice", {
          identityProof: refreshed.token,
        })
      ).ok,
    ).toBe(true);
    await until(() => !first.connected);
    expect(signal.peers.get("user_discovery-alice")!.socket.id).toBe(second.id);
    const impersonator = await connect(url);
    expect(
      (
        await register(impersonator, "user_discovery-alice", {
          identityProof: original.token,
        })
      ).ok,
    ).toBe(false);
  });

  it("does not issue a token for an old registration after the same socket changes identity", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let entered = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signal = createSignaling(undefined, {
      group: async () => null,
      project: async () => null,
      forPeer: async () => {
        entered = true;
        await gate;
        return [];
      },
    });
    const url = await listen(signal),
      socket = await connect(url),
      peerId = "000000000000000000000001";
    const token = jwt.sign({ sub: peerId }, process.env.JWT_SECRET!, {
      expiresIn: "1h",
    });
    const pending = register(socket, peerId, { identityProof: token });
    try {
      await until(() => entered);
      expect((await register(socket, "peer-new")).ok).toBe(true);
    } finally {
      release();
    }
    expect(await pending).toEqual({
      ok: false,
      error: "registration no longer active",
    });
    expect(signal.peers.has(peerId)).toBe(false);
    expect(signal.peers.get("peer-new")!.socket.id).toBe(socket.id);
  });

  it.each(["peer:lookup", "signal:send"])(
    "rejects a delayed control request after its sender changes identity: %s",
    async (event) => {
      let entered = false,
        release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signal = createSignaling(undefined, undefined, async () => {
        entered = true;
        await gate;
        return true;
      });
      const url = await listen(signal),
        a = await connect(url),
        b = await connect(url);
      expect((await register(a, "peer-a")).ok).toBe(true);
      expect((await register(b, "peer-b")).ok).toBe(true);
      const received = vi.fn();
      b.on("signal:receive", received);
      const payload =
        event === "peer:lookup"
          ? { peerId: "peer-b" }
          : { to: "peer-b", kind: "request", data: null };
      const pending = a.timeout(2000).emitWithAck(event, payload);
      try {
        await until(() => entered);
        expect((await register(a, "peer-c")).ok).toBe(true);
      } finally {
        release();
      }
      expect(await pending).toEqual({
        ok: false,
        error: "registration required",
      });
      expect(received).not.toHaveBeenCalled();
    },
  );
});
