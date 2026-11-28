import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";
import type { GroupCallRoom } from "../src/shared/media/groupCallProtocol.ts";

const services: { close: () => Promise<void> }[] = [],
  clients: Socket[] = [];
afterEach(async () => {
  clients.splice(0).forEach((socket) => socket.disconnect());
  for (const service of services.splice(0).reverse()) await service.close();
  vi.unstubAllEnvs();
});
const rpc = (socket: Socket, event: string, value: unknown) =>
  socket.timeout(2000).emitWithAck(event, value);
async function listen<
  T extends {
    httpServer: ReturnType<typeof import("node:http").createServer>;
    close: () => Promise<void>;
  },
>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return (
    "http://127.0.0.1:" + (service.httpServer.address() as AddressInfo).port
  );
}
async function socket(url: string, auth?: Record<string, unknown>) {
  const client = io(url, {
    auth,
    transports: ["websocket"],
    reconnection: false,
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
  return client;
}
async function fixture(leaseMs?: number) {
  const signal = createSignaling(undefined, undefined, undefined, {
      groupCallLeaseMs: leaseMs,
    }),
    url = await listen(signal);
  const a = await socket(url),
    b = await socket(url),
    c = await socket(url),
    outsider = await socket(url);
  const tokens: string[] = [];
  for (const [index, client] of [a, b, c, outsider].entries())
    tokens.push(
      (
        await rpc(client, "peer:register", {
          peerId: ["peer-a", "peer-b", "peer-c", "peer-x"][index],
          identityProof: "group-call-test-proof-" + index,
        })
      ).token,
    );
  const group = (
    await rpc(a, "group:create", {
      members: ["peer-b", "peer-c"],
      name: "Group call tests",
    })
  ).group;
  const start = async (kind = "video") =>
    (
      await rpc(a, "group-call:control", {
        action: "start",
        groupId: group.id,
        kind,
      })
    ).room as GroupCallRoom;
  const join = (client: Socket, roomId: string) =>
    rpc(client, "group-call:control", { action: "join", roomId });
  return { signal, url, a, b, c, outsider, group, start, join, tokens };
}
describe("group call membership and concurrency", () => {
  it("announces a call only to group members and requires explicit join for media signaling", async () => {
    const { a, b, c, outsider, group, start, join } = await fixture(),
      announcements: GroupCallRoom[] = [],
      outside = vi.fn();
    b.on("group-call:update", (room) => announcements.push(room));
    outsider.on("group-call:update", outside);
    const room = await start();
    expect(room).toMatchObject({
      groupId: group.id,
      kind: "video",
      participants: ["peer-a"],
      ended: false,
    });
    await vi.waitFor(() => expect(announcements).toHaveLength(1));
    expect(
      (await rpc(b, "group-call:control", { action: "list" })).rooms,
    ).toEqual([room]);
    expect(
      (await rpc(outsider, "group-call:control", { action: "list" })).rooms,
    ).toEqual([]);
    expect(await join(outsider, room.roomId)).toMatchObject({ ok: false });
    const data = {
      action: "offer",
      callId: randomUUID(),
      kind: "video",
      sdp: "test",
      group: {
        groupId: group.id,
        roomId: room.roomId,
        senderSession: room.sessions["peer-a"],
        receiverSession: randomUUID(),
      },
    };
    expect(
      await rpc(a, "signal:send", { to: "peer-b", kind: "media", data }),
    ).toMatchObject({ ok: false });
    const joined = (await join(b, room.roomId)).room;
    data.group.receiverSession = joined.sessions["peer-b"];
    expect(
      await rpc(a, "signal:send", { to: "peer-b", kind: "media", data }),
    ).toEqual({ ok: true });
    expect(
      await rpc(a, "signal:send", { to: "peer-c", kind: "media", data }),
    ).toMatchObject({ ok: false });
    expect(outside).not.toHaveBeenCalled();
    expect(
      (await rpc(c, "group-call:control", { action: "list" })).rooms[0]
        .participants,
    ).toEqual(["peer-a", "peer-b"]);
  });
  it("serializes simultaneous starts into one room and converges simultaneous joins", async () => {
    const { a, b, c, group, join } = await fixture();
    const results = await Promise.all(
      [a, b, c].map((client) =>
        rpc(client, "group-call:control", {
          action: "start",
          groupId: group.id,
          kind: "audio",
        }),
      ),
    );
    expect(results.filter((value) => value.ok)).toHaveLength(1);
    const room = results.find((value) => value.ok).room;
    const joined = await Promise.all([
      join(a, room.roomId),
      join(b, room.roomId),
      join(c, room.roomId),
    ]);
    expect(joined.every((value) => value.ok)).toBe(true);
    for (const client of [a, b, c])
      expect(
        (await rpc(client, "group-call:control", { action: "list" })).rooms,
      ).toMatchObject([
        { roomId: room.roomId, participants: ["peer-a", "peer-b", "peer-c"] },
      ]);
  });
  it("allows an initiator to leave without ending the remaining participants call", async () => {
    const { a, b, c, start, join } = await fixture(),
      room = await start("audio");
    await join(b, room.roomId);
    await join(c, room.roomId);
    await rpc(a, "group-call:control", {
      action: "leave",
      roomId: room.roomId,
    });
    expect(
      (await rpc(b, "group-call:control", { action: "list" })).rooms[0],
    ).toMatchObject({ participants: ["peer-b", "peer-c"], ended: false });
    await rpc(b, "group-call:control", {
      action: "leave",
      roomId: room.roomId,
    });
    await rpc(c, "group-call:control", {
      action: "leave",
      roomId: room.roomId,
    });
    expect(
      (await rpc(a, "group-call:control", { action: "list" })).rooms,
    ).toEqual([]);
    expect(await join(a, room.roomId)).toMatchObject({ ok: false });
  });
  it("rotates the membership session on rejoin and rejects stale media negotiation", async () => {
    const { a, b, group, start, join } = await fixture(),
      room = await start();
    const first = (await join(b, room.roomId)).room as GroupCallRoom;
    const second = (await join(b, room.roomId)).room as GroupCallRoom;
    expect(first.sessions["peer-b"]).not.toBe(second.sessions["peer-b"]);
    const data = {
      action: "offer",
      callId: randomUUID(),
      kind: "video",
      sdp: "test",
      group: {
        groupId: group.id,
        roomId: room.roomId,
        senderSession: second.sessions["peer-a"],
        receiverSession: first.sessions["peer-b"],
      },
    };
    expect(
      await rpc(a, "signal:send", { to: "peer-b", kind: "media", data }),
    ).toMatchObject({ ok: false });
    data.group.receiverSession = second.sessions["peer-b"];
    expect(
      await rpc(a, "signal:send", { to: "peer-b", kind: "media", data }),
    ).toEqual({ ok: true });
    await rpc(b, "group-call:control", {
      action: "leave",
      roomId: room.roomId,
      sessionId: first.sessions["peer-b"],
    });
    expect(
      (await rpc(a, "group-call:control", { action: "list" })).rooms[0]
        .sessions["peer-b"],
    ).toBe(second.sessions["peer-b"]);
    await rpc(b, "group-call:control", {
      action: "leave",
      roomId: room.roomId,
      sessionId: second.sessions["peer-b"],
    });
    expect(
      (await rpc(a, "group-call:control", { action: "list" })).rooms[0]
        .participants,
    ).toEqual(["peer-a"]);
  });
  it("revokes media permission immediately when group membership is removed", async () => {
    const { url, a, b, c, group, start, join } = await fixture(),
      room = await start();
    await join(b, room.roomId);
    await join(c, room.roomId);
    const query = new URLSearchParams({
      groupId: group.id,
      roomId: room.roomId,
      senderId: "peer-a",
      receiverId: "peer-c",
    });
    const allowed = async () =>
      (
        await (
          await fetch(url + "/internal/group-calls/authorize?" + query, {
            headers: { "x-peer-secret": process.env.PEER_SECRET! },
          })
        ).json()
      ).allowed;
    expect(await allowed()).toBe(true);
    expect(
      (
        await rpc(a, "group:change", {
          groupId: group.id,
          memberId: "peer-c",
          version: 1,
          action: "remove",
        })
      ).ok,
    ).toBe(true);
    expect(await allowed()).toBe(false);
    expect(await join(c, room.roomId)).toMatchObject({ ok: false });
    expect(
      (await rpc(c, "group-call:control", { action: "list" })).rooms,
    ).toEqual([]);
    await vi.waitFor(async () =>
      expect(
        (await rpc(a, "group-call:control", { action: "list" })).rooms[0]
          .participants,
      ).toEqual(["peer-a", "peer-b"]),
    );
    expect(
      (await fetch(url + "/internal/group-calls/authorize?" + query)).status,
    ).toBe(403);
  });
  it("removes a disconnected participant and allows a fresh connection to rejoin", async () => {
    const { url, a, b, c, start, join } = await fixture(),
      room = await start();
    await join(b, room.roomId);
    await join(c, room.roomId);
    b.io.engine.close();
    await vi.waitFor(
      async () =>
        expect(
          (await rpc(a, "group-call:control", { action: "list" })).rooms[0]
            .participants,
        ).toEqual(["peer-a", "peer-c"]),
      { timeout: 3000 },
    );
    const replacement = await socket(url);
    expect(
      (
        await rpc(replacement, "peer:register", {
          peerId: "peer-b",
          identityProof: "group-call-test-proof-1",
        })
      ).ok,
    ).toBe(true);
    expect((await join(replacement, room.roomId)).room.participants).toEqual([
      "peer-a",
      "peer-b",
      "peer-c",
    ]);
  });
  it("expires a participant lease without ending the others and rejects late heartbeats", async () => {
    const { a, b, start, join } = await fixture(300),
      room = await start();
    await join(b, room.roomId);
    const keep = setInterval(() => {
      void rpc(a, "group-call:control", {
        action: "heartbeat",
        roomId: room.roomId,
      }).catch(() => {});
    }, 70);
    try {
      await new Promise((resolve) => setTimeout(resolve, 380));
      expect(
        (await rpc(a, "group-call:control", { action: "list" })).rooms[0]
          .participants,
      ).toEqual(["peer-a"]);
      expect(
        await rpc(b, "group-call:control", {
          action: "heartbeat",
          roomId: room.roomId,
        }),
      ).toMatchObject({ ok: false });
    } finally {
      clearInterval(keep);
    }
  });
  it("rejects malformed control input and participation in two rooms at once", async () => {
    const { a, b, group, start } = await fixture(),
      room = await start();
    expect(
      await rpc(a, "group-call:control", {
        action: "join",
        roomId: room.roomId,
        participants: ["peer-x"],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await rpc(a, "group-call:control", {
        action: "start",
        groupId: group.id,
        kind: "screen",
      }),
    ).toMatchObject({ ok: false });
    const second = (
      await rpc(b, "group:create", { members: ["peer-a"], name: "Other" })
    ).group;
    const other = (
      await rpc(b, "group-call:control", {
        action: "start",
        groupId: second.id,
        kind: "audio",
      })
    ).room;
    expect(
      await rpc(a, "group-call:control", {
        action: "join",
        roomId: other.roomId,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("group relay routing and bounds", () => {
  it("opens concurrent encrypted links only within an authorized room and isolates their closure", async () => {
    const { url, a, b, c, start, join, tokens } = await fixture(),
      room = await start();
    await join(b, room.roomId);
    await join(c, room.roomId);
    vi.stubEnv("SIGNAL_INTERNAL_URL", url);
    const relay = createRelay(),
      relayUrl = await listen(relay);
    const [ra, rb, rc, rx] = await Promise.all(
      tokens.map((token) => socket(relayUrl, { token })),
    );
    const ab = randomUUID(),
      ac = randomUUID(),
      group = { groupId: room.groupId, roomId: room.roomId };
    expect(
      await rpc(ra, "media:open", { to: "peer-b", callId: ab, group }),
    ).toEqual({ ok: true });
    expect(
      await rpc(rb, "media:open", { to: "peer-a", callId: ab, group }),
    ).toEqual({ ok: true });
    expect(
      await rpc(ra, "media:open", { to: "peer-c", callId: ac, group }),
    ).toEqual({ ok: true });
    expect(
      await rpc(rc, "media:open", { to: "peer-a", callId: ac, group }),
    ).toEqual({ ok: true });
    expect(
      await rpc(rx, "media:open", {
        to: "peer-a",
        callId: randomUUID(),
        group,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await rpc(ra, "media:open", { to: "peer-b", callId: randomUUID() }),
    ).toMatchObject({ ok: false });
    const bFrames = vi.fn(),
      cFrames = vi.fn();
    rb.on("media:frame", bFrames);
    rc.on("media:frame", cFrames);
    const frame = {
      v: 1,
      callId: ac,
      senderId: "peer-a",
      receiverId: "peer-c",
      sequence: 0,
      kind: "audio",
      iv: "a".repeat(16),
      ciphertext: "a".repeat(24),
    };
    ra.emit("media:frame", frame);
    await vi.waitFor(() => expect(cFrames).toHaveBeenCalledWith(frame));
    expect(bFrames).not.toHaveBeenCalled();
    await rpc(ra, "media:close", { to: "peer-b", callId: ab, group });
    ra.emit("media:frame", { ...frame, sequence: 1 });
    await vi.waitFor(() => expect(cFrames).toHaveBeenCalledTimes(2));
    await rpc(a, "group-call:control", {
      action: "leave",
      roomId: room.roomId,
    });
    expect(
      await rpc(ra, "media:open", { to: "peer-c", callId: ac, group }),
    ).toMatchObject({ ok: false });
    expect(relay.cluster.journal.pending()).toHaveLength(0);
  });
  it("bounds streaming traffic separately so media does not exhaust the chat/RPC budget", async () => {
    const { tokens } = await fixture(),
      relay = createRelay(),
      url = await listen(relay),
      peer = await socket(url, { token: tokens[0] });
    for (let index = 0; index < 2502; index++) peer.emit("media:frame", {});
    expect(await rpc(peer, "relay:probe", null)).toMatchObject({ ok: true });
    const health = await (await fetch(url + "/health")).json();
    expect(health.metrics.rejectedMedia).toBe(2500);
  });
});
