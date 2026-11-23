import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io, type Socket } from "socket.io-client";
import { createRelay } from "../src/relay/index.ts";
import type { ChatMessage, Group } from "../src/shared/protocol.ts";

const relays: ReturnType<typeof createRelay>[] = [],
  clients: Socket[] = [];
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(relay = createRelay()) {
  relays.push(relay);
  await new Promise<void>((resolve) =>
    relay.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return {
    relay,
    url: `http://127.0.0.1:${(relay.httpServer.address() as AddressInfo).port}`,
  };
}
function token(peerId: string, extra: Record<string, unknown> = {}) {
  return jwt.sign(
    { sub: peerId, exp: Math.floor(Date.now() / 1000) + 3600, ...extra },
    process.env.PEER_SECRET!,
    { audience: "ds01-relay", issuer: "ds01-signaling" },
  );
}
async function connect(
  url: string,
  peerId: string,
  extra: Record<string, unknown> = {},
) {
  const socket = io(url, {
    auth: { token: token(peerId, extra) },
    transports: ["websocket"],
    reconnection: false,
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}
function packet(senderId = "peer-a", receiverId = "peer-b"): ChatMessage {
  return {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId,
    receiverId,
    type: "text",
    timestamp: Date.now(),
    body: "Nội dung nguyên vẹn 漢字",
    mode: "RELAY",
    attempt: 1,
    sequence: 1,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  clients.splice(0).forEach((client) => client.disconnect());
  for (const relay of relays.splice(0)) await relay.close();
  vi.unstubAllEnvs();
});

describe("relay requirements in DS01 section 5.9", () => {
  it("preserves the original JSON values including legacy ACK shape and attachment metadata", async () => {
    const { url } = await listen(),
      a = await connect(url, "peer-a"),
      b = await connect(url, "peer-b");
    const input = {
      ...packet(),
      type: "attachment",
      body: "",
      attachments: [
        {
          id: randomUUID(),
          name: "  sample.bin  ",
          mime: " application/octet-stream ",
          size: 1,
          sha256: "a".repeat(64),
        },
      ],
    };
    const received = new Promise((resolve) => b.once("relay:receive", resolve));
    expect(await a.timeout(1000).emitWithAck("relay:send", input)).toEqual({
      ok: true,
    });
    expect(await received).toEqual(input);
    const health = await (await fetch(url + "/health")).json();
    expect(health).toMatchObject({
      service: "relay",
      peers: 2,
      metrics: {
        forwardedMessages: 1,
        forwardedPayloadBytes: Buffer.byteLength(JSON.stringify(input)),
        acceptedConnections: 2,
      },
    });
    expect(health.nodeId).toMatch(/^relay-/);
  });

  it.each(["disconnect", "replace"])(
    "rejects an in-flight send when the source connection changes: %s",
    async (change) => {
      const entered = deferred(),
        release = deferred();
      const { relay, url } = await listen(
        createRelay(undefined, undefined, async () => {
          entered.resolve();
          await release.promise;
          return true;
        }),
      );
      const a = await connect(url, "peer-a"),
        b = await connect(url, "peer-b"),
        received = vi.fn();
      b.on("relay:receive", received);
      const send = a
        .timeout(250)
        .emitWithAck("relay:send", packet())
        .catch(() => undefined);
      await entered.promise;
      if (change === "replace") await connect(url, "peer-a");
      else {
        a.disconnect();
        await vi.waitFor(() =>
          expect(relay.connections.has("peer-a")).toBe(false),
        );
      }
      release.resolve();
      await vi.waitFor(async () =>
        expect(
          (await (await fetch(url + "/health")).json()).metrics
            .rejectedMessages,
        ).toBe(1),
      );
      expect(received).not.toHaveBeenCalled();
      if (change === "replace")
        expect(relay.connections.get("peer-a")?.connected).toBe(true);
      await send;
    },
  );

  it.each(["disconnect", "replace"])(
    "does not forward to a stale destination after asynchronous session authorization: %s",
    async (change) => {
      const entered = deferred(),
        release = deferred();
      let paused = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (paused && String(input).includes("peerId=user_b")) {
          paused = false;
          entered.resolve();
          await release.promise;
        }
        return Response.json({ allowed: true });
      });
      const { relay, url } = await listen(),
        sid = "a".repeat(64);
      const a = await connect(url, "user_a", { sid }),
        b = await connect(url, "user_b", { sid }),
        received = vi.fn();
      b.on("relay:receive", received);
      paused = true;
      const send = a
        .timeout(1000)
        .emitWithAck("relay:send", packet("user_a", "user_b"));
      await entered.promise;
      let replacement: Socket | undefined;
      if (change === "replace") {
        replacement = await connect(url, "user_b", { sid });
        replacement.on("relay:receive", received);
      } else {
        b.disconnect();
        await vi.waitFor(() =>
          expect(relay.connections.has("user_b")).toBe(false),
        );
      }
      release.resolve();
      expect(await send).toEqual({
        ok: false,
        error: "receiver connection changed",
      });
      expect(received).not.toHaveBeenCalled();
      if (replacement) {
        const next = new Promise((resolve) =>
            replacement!.once("relay:receive", resolve),
          ),
          input = packet("user_a", "user_b");
        expect(await a.timeout(1000).emitWithAck("relay:send", input)).toEqual({
          ok: true,
        });
        expect(await next).toEqual(input);
      }
    },
  );

  it.each(["sender", "receiver"])(
    "rechecks token expiry after awaiting authorization: %s",
    async (role) => {
      const entered = deferred(),
        release = deferred();
      const { relay, url } = await listen(
        createRelay(undefined, undefined, async () => {
          entered.resolve();
          await release.promise;
          return true;
        }),
      );
      const a = await connect(url, "peer-a"),
        b = await connect(url, "peer-b"),
        received = vi.fn();
      b.on("relay:receive", received);
      const send = a.timeout(1000).emitWithAck("relay:send", packet());
      await entered.promise;
      relay.connections.get(
        role === "sender" ? "peer-a" : "peer-b",
      )!.data.tokenExpiresAt = Date.now() - 1;
      release.resolve();
      expect(await send).toEqual({
        ok: false,
        error: `${role} session expired`,
      });
      expect(received).not.toHaveBeenCalled();
    },
  );

  it("removes an idle connection when its signed token expires", async () => {
    const { relay, url } = await listen(),
      exp = Math.floor(Date.now() / 1000) + 2;
    const a = await connect(url, "peer-a", { exp });
    await new Promise<void>((resolve) => a.once("disconnect", () => resolve()));
    expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000);
    expect(relay.connections.size).toBe(0);
  });

  it("rejects a token which expires while account-session verification is pending", async () => {
    const entered = deferred(),
      release = deferred(),
      now = Date.now(),
      exp = Math.floor(now / 1000) + 60;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ allowed: true });
    });
    const { relay, url } = await listen();
    const pending = connect(url, "user_a", { sid: "a".repeat(64), exp }).then(
      () => "accepted",
      (error) => error.message,
    );
    await entered.promise;
    vi.spyOn(Date, "now").mockReturnValue((exp + 1) * 1000);
    release.resolve();
    expect(await pending).toBe("invalid peer token");
    expect(relay.connections.size).toBe(0);
  });

  it("detects a peer that stops responding to heartbeat without a clean disconnect", async () => {
    const { relay, url } = await listen(
      createRelay(undefined, undefined, undefined, {
        pingInterval: 40,
        pingTimeout: 100,
      }),
    );
    const a = await connect(url, "peer-a"),
      serverSocket = relay.connections.get("peer-a")!;
    const transport = a.io.engine.transport,
      original = transport.send.bind(transport);
    transport.send = (packets) =>
      original(
        packets.filter((value: { type: string }) => value.type !== "pong"),
      );
    const reason = await new Promise<string>((resolve) =>
      serverSocket.once("disconnect", resolve),
    );
    expect(reason).toBe("ping timeout");
    expect(relay.connections.size).toBe(0);
  });

  it.each(["wrong-id", "malformed", "archived"])(
    "fails closed when group authority returns an invalid resource: %s",
    async (invalid) => {
      const groupId = randomUUID();
      const group = {
        id: invalid === "wrong-id" ? randomUUID() : groupId,
        ownerId: "peer-a",
        members: ["peer-a", "peer-b"],
        version: 1,
        ...(invalid === "malformed" ? { extra: true } : {}),
        ...(invalid === "archived" ? { archived: true } : {}),
      };
      const { url } = await listen(
        createRelay(undefined, async () => group as Group),
      );
      const a = await connect(url, "peer-a"),
        b = await connect(url, "peer-b"),
        received = vi.fn();
      b.on("relay:receive", received);
      expect(
        await a
          .timeout(1000)
          .emitWithAck("relay:send", { ...packet(), groupId }),
      ).toEqual({ ok: false, error: "group access denied" });
      expect(received).not.toHaveBeenCalled();
    },
  );

  it("routes concurrent sends to the right active connections and rejects a forged sender", async () => {
    const { relay, url } = await listen(),
      ids = ["peer-a", "peer-b", "peer-c", "peer-d"];
    const sockets = await Promise.all(ids.map((id) => connect(url, id))),
      received: ChatMessage[] = [];
    sockets.forEach((socket, index) =>
      socket.on("relay:receive", (message) => {
        expect(message.receiverId).toBe(ids[index]);
        received.push(message);
      }),
    );
    const packets = Array.from({ length: 40 }, (_, i) =>
      packet(ids[i % 4], ids[(i + 1) % 4]),
    );
    expect(
      await Promise.all(
        packets.map((input, i) =>
          sockets[i % 4].timeout(2000).emitWithAck("relay:send", input),
        ),
      ),
    ).toEqual(packets.map(() => ({ ok: true })));
    await vi.waitFor(() => expect(received).toHaveLength(40));
    expect(new Set(received.map((message) => message.messageId)).size).toBe(40);
    expect(received).toEqual(expect.arrayContaining(packets));
    expect(
      await sockets[0]
        .timeout(1000)
        .emitWithAck("relay:send", packet("peer-c")),
    ).toEqual({ ok: false, error: "sender or mode mismatch" });
    expect(relay.connections.size).toBe(4);
  });

  it("identifies separate relay nodes and logs outcomes without tokens, sessions or message content", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await listen(
      createRelay(undefined, undefined, undefined, { nodeId: "relay-primary" }),
    );
    const second = await listen(
      createRelay(undefined, undefined, undefined, { nodeId: "relay-backup" }),
    );
    const a = await connect(first.url, "peer-a"),
      b = await connect(first.url, "peer-b");
    const input = { ...packet(), body: "PRIVATE-CONTENT-DO-NOT-LOG" };
    expect(await a.timeout(1000).emitWithAck("relay:send", input)).toEqual({
      ok: true,
    });
    await expect(
      connect(first.url, "peer-forged", { sub: "../bad" }),
    ).rejects.toThrow("invalid peer token");
    a.disconnect();
    await vi.waitFor(() =>
      expect(first.relay.connections.has("peer-a")).toBe(false),
    );
    const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const event of ["REGISTER", "FORWARD", "AUTH_REJECT", "DISCONNECT"])
      expect(lines).toContain(`[relay] ${event}`);
    expect(lines).toContain("node=relay-primary");
    expect(lines).not.toContain(input.body);
    expect(lines).not.toContain(
      a.auth && (a.auth as Record<string, string>).token,
    );
    expect((await (await fetch(second.url + "/health")).json()).nodeId).toBe(
      "relay-backup",
    );
    expect(b.connected).toBe(true);
  });
});
