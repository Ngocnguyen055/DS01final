import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";
import {
  PeerClient,
  groupSchema,
  type Group,
  type PeerConfig,
  type PeerEvent,
} from "../src/shared/index.ts";
import { WebStore } from "../src/web-peer/storage/store.ts";

type Service =
  ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [],
  clients: PeerClient[] = [],
  sockets: Socket[] = [];
const proof = "group-chat-persistent-identity-proof";
async function listen<T extends Service>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const signal = createSignaling(),
    signalUrl = await listen(signal);
  const relay = createRelay(
      undefined,
      async (id) => signal.groups.get(id) || null,
    ),
    relayUrl = await listen(relay);
  const peer = async (peerId: string) => {
    const store = new WebStore(peerId),
      events: PeerEvent[] = [];
    const client = new PeerClient({
      peerId,
      identityProof: proof,
      signalUrl,
      relayUrl,
      forceRelay: true,
      store,
      rtc: class {} as unknown as PeerConfig["rtc"],
      ackTimeoutMs: 100,
      onEvent: (event) => events.push(event),
    });
    clients.push(client);
    await client.connect();
    await until(() => events.some((event) => event.connection?.relays === 1));
    return { client, store, events };
  };
  return { signal, relay, peer };
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const service of services.splice(0).reverse()) await service.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("group membership consistency and offline delivery", () => {
  it("ignores older, conflicting and malformed membership events, including updates after removal", async () => {
    const { signal, peer } = await fixture(),
      a = await peer("peer-a"),
      b = await peer("peer-b");
    const first = await a.client.createGroup(["peer-b"], "Team");
    await until(() => b.client.getGroups().length === 1);
    const latest = await a.client.changeGroup(first.id, "peer-c", "add");
    await until(() => b.client.getGroups()[0]?.version === 2);
    const target = signal.peers.get("peer-b")!.socket;
    for (const group of [
      first,
      { ...latest, members: ["peer-a", "peer-b"] },
      { ...latest, version: 3, members: null },
    ])
      target.emit("group:update", group);
    await b.client.lookupPeer("peer-a");
    expect(b.client.getGroups()).toEqual([latest]);
    const removed = await a.client.changeGroup(first.id, "peer-b", "remove");
    await until(() => b.client.getGroups().length === 0);
    const count = b.events.filter((event) => event.kind === "group").length;
    target.emit("group:update", latest);
    target.emit("group:update", { ...removed, members: first.members });
    await b.client.lookupPeer("peer-a");
    expect(b.client.getGroups()).toEqual([]);
    expect(b.events.filter((event) => event.kind === "group")).toHaveLength(
      count,
    );
    expect(
      b.events.some((event) => event.text === "invalid group update"),
    ).toBe(true);
  });

  it("refreshes membership before fan-out when the sender missed a join notification", async () => {
    const { signal, peer } = await fixture(),
      a = await peer("peer-a"),
      b = await peer("peer-b"),
      c = await peer("peer-c");
    const first = await a.client.createGroup(["peer-b"]);
    await until(() => b.client.getGroups().length === 1);
    const latest = {
      ...first,
      members: [...first.members, "peer-c"],
      version: 2,
    };
    signal.groups.set(first.id, latest);
    expect(b.client.getGroups()[0]).toEqual(first);
    expect(
      await b.client.sendGroup(first.id, "include newly joined member"),
    ).toEqual({ "peer-a": "fulfilled", "peer-c": "fulfilled" });
    expect(b.client.getGroups()).toEqual([latest]);
    expect(
      (await a.store.list()).filter(
        (row) => row.message.body === "include newly joined member",
      ),
    ).toHaveLength(1);
    expect(
      (await c.store.list()).filter(
        (row) => row.message.body === "include newly joined member",
      ),
    ).toHaveLength(1);
  });

  it("refreshes a conflicting edit without silently repeating the user action", async () => {
    const { signal, peer } = await fixture(),
      a = await peer("peer-a"),
      b = await peer("peer-b");
    const first = await a.client.createGroup(["peer-b"]);
    const latest = {
      ...first,
      members: [...first.members, "peer-c"],
      version: 2,
    };
    signal.groups.set(first.id, latest);
    await expect(
      a.client.changeGroup(first.id, "peer-b", "remove"),
    ).rejects.toThrow("stale version");
    expect(signal.groups.get(first.id)).toEqual(latest);
    expect(a.client.getGroups()).toEqual([latest]);
    const final = await a.client.changeGroup(first.id, "peer-b", "remove");
    expect(final).toMatchObject({ version: 3, members: ["peer-a", "peer-c"] });
    await until(() => b.client.getGroups().length === 0);
  });

  it("keeps offline membership and per-recipient status, then retries only failed delivery with the same event identity", async () => {
    const { signal, relay, peer } = await fixture(),
      a = await peer("peer-a"),
      b = await peer("peer-b");
    let c = await peer("peer-c");
    const group = await a.client.createGroup(["peer-b", "peer-c"]);
    await until(() => c.client.getGroups().length === 1);
    c.client.close();
    await until(
      () => !signal.peers.has("peer-c") && !relay.connections.has("peer-c"),
    );
    expect(await a.client.sendGroup(group.id, "offline group event")).toEqual({
      "peer-b": "fulfilled",
      "peer-c": "rejected",
    });
    const rows = await a.store.list(),
      failed = rows.find((row) => row.message.receiverId === "peer-c")!;
    expect(rows.map((row) => [row.message.receiverId, row.status])).toEqual([
      ["peer-b", "delivered"],
      ["peer-c", "failed"],
    ]);
    expect(new Set(rows.map((row) => row.message.messageId)).size).toBe(1);
    expect(signal.groups.get(group.id)).toEqual(group);
    c = await peer("peer-c");
    expect(c.client.getGroups()).toEqual([group]);
    expect(await c.store.list()).toEqual([]);
    await a.client.retry(failed.message.messageId, "peer-c");
    const received = (await c.store.list())[0].message;
    for (const key of [
      "messageId",
      "timestamp",
      "logicalTime",
      "sequence",
      "sessionId",
      "groupId",
      "body",
    ] as const)
      expect(received[key]).toEqual(failed.message[key]);
    expect(
      (await b.store.list()).filter(
        (row) => row.message.messageId === received.messageId,
      ),
    ).toHaveLength(1);
    expect(
      (await a.store.list()).every((row) => row.status === "delivered"),
    ).toBe(true);
  });

  it("revokes failed retries after removal and gives new members no automatic historical replay", async () => {
    const { signal, peer } = await fixture(),
      a = await peer("peer-a");
    const group = await a.client.createGroup(["peer-b"]);
    expect(
      await a.client.sendGroup(group.id, "private to old membership"),
    ).toEqual({ "peer-b": "rejected" });
    const failed = (await a.store.list())[0];
    await a.client.changeGroup(group.id, "peer-b", "remove");
    const b = await peer("peer-b"),
      c = await peer("peer-c");
    await expect(
      a.client.retry(failed.message.messageId, "peer-b"),
    ).rejects.toThrow("access denied");
    await a.client.changeGroup(group.id, "peer-c", "add");
    expect(await c.store.list()).toEqual([]);
    expect(await b.store.list()).toEqual([]);
    expect(await a.client.sendGroup(group.id, "new membership event")).toEqual({
      "peer-c": "fulfilled",
    });
    expect((await c.store.list()).map((row) => row.message.body)).toEqual([
      "new membership event",
    ]);
    expect(signal.groups.get(group.id)!.members).toEqual(["peer-a", "peer-c"]);
  });

  it.each(["group:authorize", "project:group"])(
    "does not authorize with an older project response after a concurrent removal: %s",
    async (event) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const first: Group = {
        id: randomUUID(),
        ownerId: "peer-a",
        members: ["peer-a", "peer-b"],
        version: 1,
        projectId: "000000000000000000000001",
      };
      let release!: (value: Group) => void, started!: () => void;
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const waiting = new Promise<Group>((resolve) => {
        release = resolve;
      });
      const read = async () => {
        started();
        return waiting;
      };
      const signal = createSignaling(undefined, {
        group: read,
        project: read,
        forPeer: async () => [],
      });
      const url = await listen(signal),
        socket = io(url, { transports: ["websocket"], reconnection: false });
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      expect(
        (
          await socket
            .timeout(2000)
            .emitWithAck("peer:register", {
              peerId: "peer-b",
              identityProof: proof,
            })
        ).ok,
      ).toBe(true);
      signal.groups.set(first.id, first);
      const pending = socket
        .timeout(2000)
        .emitWithAck(event, {
          groupId: first.id,
          otherPeerId: "peer-a",
          projectId: first.projectId,
        });
      await requested;
      const latest = { ...first, members: ["peer-a"], version: 2 };
      signal.groups.set(first.id, latest);
      release(first);
      expect(await pending).toMatchObject({ ok: false });
      expect(signal.groups.get(first.id)).toEqual(latest);
    },
  );

  it.each(["group:authorize", "project:group"])(
    "rechecks the actor session after an asynchronous group lookup: %s",
    async (event) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const group: Group = {
        id: randomUUID(),
        ownerId: "peer-a",
        members: ["peer-a", "peer-b"],
        version: 1,
        projectId: "000000000000000000000001",
      };
      let release!: (value: Group) => void, started!: () => void;
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const waiting = new Promise<Group>((resolve) => {
        release = resolve;
      });
      const read = async () => {
        started();
        return waiting;
      };
      const signal = createSignaling(undefined, {
        group: read,
        project: read,
        forPeer: async () => [],
      });
      const url = await listen(signal),
        socket = io(url, { transports: ["websocket"], reconnection: false });
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      await socket
        .timeout(2000)
        .emitWithAck("peer:register", {
          peerId: "peer-b",
          identityProof: proof,
        });
      signal.groups.set(group.id, group);
      const pending = socket
        .timeout(2000)
        .emitWithAck(event, {
          groupId: group.id,
          otherPeerId: "peer-a",
          projectId: group.projectId,
        });
      await requested;
      signal.peers.get("peer-b")!.lastSeen -= 30001;
      release(group);
      expect(await pending).toEqual({
        ok: false,
        error: "registration no longer active",
      });
    },
  );
});

describe("group metadata validation", () => {
  it.each([
    { members: ["peer-a", "peer-a"] },
    { members: ["peer-b"] },
    { version: 0 },
    { members: Array.from({ length: 17 }, (_, index) => `peer-${index}`) },
    { unexpected: true },
  ])("rejects invalid membership snapshots: %#", (invalid) => {
    expect(
      groupSchema.safeParse({
        id: randomUUID(),
        ownerId: "peer-a",
        members: ["peer-a", "peer-b"],
        version: 1,
        ...invalid,
      }).success,
    ).toBe(false);
  });
});
