import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Socket } from "socket.io-client";
import { PeerClient } from "../src/shared/peer.ts";
import type { ChatStore, PeerConfig, PeerEvent, StoredMessage } from "../src/shared/peerTypes.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";

type Service = ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [], clients: PeerClient[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await delay(10);
  }
}
async function listen(service: Service) {
  services.push(service);
  await new Promise<void>((resolve) => service.httpServer.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function peer(peerId: string, signalUrl: string, relayUrl: string, extra: Partial<PeerConfig> = {}) {
  const rows: StoredMessage[] = [], events: PeerEvent[] = [];
  const store: ChatStore = {
    async put(row) {
      const index = rows.findIndex((value) => value.message.messageId === row.message.messageId);
      if (index < 0) rows.push(row);
      else rows[index] = row;
    },
    async mark(id, _receiver, status) {
      for (const row of rows) if (row.message.messageId === id) row.status = status;
    },
    async has(id, sender) {
      return rows.some((row) => row.message.messageId === id && row.message.senderId === sender);
    },
    async list() { return rows; },
  };
  const client = new PeerClient({
    peerId, signalUrl, relayUrl, store,
    identityProof: "signaling-recovery-test-proof-12345",
    rtc: class {} as unknown as PeerConfig["rtc"],
    encryption: true, forceRelay: true, requestTimeoutMs: 100, ackTimeoutMs: 500,
    ...extra, onEvent: (event) => events.push(event),
  });
  clients.push(client);
  await client.connect();
  await until(() => events.some((event) => event.connection?.relays === 1));
  return { client, rows, events };
}
function state(value: Awaited<ReturnType<typeof peer>>) {
  return value.events.filter((event) => event.connection).at(-1)?.connection;
}
function socket(client: PeerClient) {
  return (client as unknown as { signal: Socket }).signal;
}
function interrupt(signal: ReturnType<typeof createSignaling>, client: PeerClient) {
  socket(client).io.reconnectionDelay(20).reconnectionDelayMax(30);
  signal.peers.get(client.peerId)!.socket.conn.close();
}

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  vi.restoreAllMocks();
  for (const service of services.splice(0).reverse()) await service.close();
});

describe("signaling registration recovery", () => {
  it("retries an initial registration whose ACK was lost", async () => {
    const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
    let attempts = 0;
    signal.io.on("connection", (server) => {
      const [register] = server.listeners("peer:register");
      server.removeAllListeners("peer:register");
      server.on("peer:register", (input, reply) => register(input, ++attempts === 1 ? () => {} : reply));
    });
    const a = await peer("peer-a", signalUrl, relayUrl);
    expect(attempts).toBe(2);
    expect(state(a)?.signaling).toBe("online");
    expect(socket(a.client).active).toBe(true);
  });

  it.each(["peer:register", "key:publish"])(
    "recovers after a lost %s ACK and holds encrypted messages until registration is ready",
    async (event) => {
      const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
      let drop = false, dropped = false, prematureLookups = 0;
      signal.io.on("connection", (server) => {
        const [handler] = server.listeners(event);
        server.removeAllListeners(event);
        server.on(event, (input, reply) => {
          if (drop && !dropped) {
            dropped = true;
            void handler(input, () => {});
          } else void handler(input, reply);
        });
        server.on("key:lookup", () => {
          if (drop && state(a)?.signaling !== "online") prematureLookups++;
        });
      });
      const a = await peer("peer-a", signalUrl, relayUrl), b = await peer("peer-b", signalUrl, relayUrl);
      drop = true;
      interrupt(signal, a.client);
      await until(() => dropped);
      const sending = a.client.sendDirect("peer-b", "send while registering again");
      await until(() => a.events.some((item) => item.text?.startsWith("register failed:")));
      await sending;
      expect(state(a)?.signaling).toBe("online");
      expect(socket(a.client).connected).toBe(true);
      expect(socket(a.client).active).toBe(true);
      expect(prematureLookups).toBe(0);
      expect(a.rows[0].status).toBe("delivered");
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0].message.body).toBe("send while registering again");
      expect(a.events.some((item) => item.text?.includes("security key directory unavailable"))).toBe(false);
    },
  );

  it.each([false, true])("ignores a stale registration after another connection has registered (reject=%s)", async (reject) => {
    const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
    const a = await peer("peer-a", signalUrl, relayUrl);
    const identity = await a.client.secure.publicIdentity();
    let release!: () => void, waiting = false;
    vi.spyOn(a.client.secure, "publicIdentity").mockImplementationOnce(() => {
      waiting = true;
      return new Promise((resolve, fail) => {
        release = () => reject ? fail(Error("obsolete identity failure")) : resolve(identity);
      });
    });
    interrupt(signal, a.client);
    await until(() => waiting);
    interrupt(signal, a.client);
    await until(() => state(a)?.signaling === "online" && state(a)?.relays === 1);
    const relays = () => [...(a.client as unknown as { relayPool: { sockets: Map<string, Socket> } }).relayPool.sockets.values()];
    const [relay] = relays();
    release();
    await delay(100);
    expect(state(a)?.signaling).toBe("online");
    expect(relays()).toEqual([relay]);
    expect(socket(a.client).active).toBe(true);
  });

  it("stops reconnecting after an explicit registration rejection", async () => {
    const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
    let deny = false, attempts = 0;
    signal.io.on("connection", (server) => {
      const [register] = server.listeners("peer:register");
      server.removeAllListeners("peer:register");
      server.on("peer:register", (input, reply) => {
        attempts++;
        if (deny) reply({ ok: false, error: "invalid account token" });
        else void register(input, reply);
      });
    });
    const a = await peer("peer-a", signalUrl, relayUrl);
    deny = true;
    interrupt(signal, a.client);
    await until(() => state(a)?.signaling === "offline");
    await delay(400);
    expect(attempts).toBe(2);
    expect(socket(a.client).active).toBe(false);
  });

  it("bounds the wait for encryption readiness while registration keeps timing out", async () => {
    const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
    let drop = false, requested = false;
    signal.io.on("connection", (server) => {
      const [register] = server.listeners("peer:register");
      server.removeAllListeners("peer:register");
      server.on("peer:register", (input, reply) => {
        if (drop) requested = true;
        else void register(input, reply);
      });
    });
    const a = await peer("peer-a", signalUrl, relayUrl, { connectionWaitTimeoutMs: 100 });
    drop = true;
    interrupt(signal, a.client);
    await until(() => requested);
    const result = a.client.sendDirect("peer-b", "bounded wait").then(
      () => "delivered", (error: Error) => error.message,
    );
    expect(await Promise.race([result, delay(1500).then(() => "still pending")]))
      .toContain("signaling readiness timeout");
    expect(a.rows[0].status).toBe("failed");
    expect(socket(a.client).active).toBe(true);
  });

  it("holds group sends until the reconnected session is ready", async () => {
    const signal = createSignaling(), signalUrl = await listen(signal),
      relayUrl = await listen(createRelay(undefined, async (id) => signal.groups.get(id) ?? null));
    let hold = false, release: (() => void) | undefined, prematureAuthorizations = 0;
    signal.io.on("connection", (server) => {
      const [register] = server.listeners("peer:register");
      server.removeAllListeners("peer:register");
      server.on("peer:register", (input, reply) => {
        if (hold) void register(input, (response: unknown) => { release = () => reply(response); });
        else void register(input, reply);
      });
      server.on("group:authorize", () => {
        if (hold && state(a)?.signaling !== "online") prematureAuthorizations++;
      });
    });
    const a = await peer("peer-a", signalUrl, relayUrl), b = await peer("peer-b", signalUrl, relayUrl);
    const group = await a.client.createGroup(["peer-b"]);
    hold = true;
    interrupt(signal, a.client);
    await until(() => !!release);
    const sending = a.client.sendGroup(group.id, "group send during recovery");
    await delay(30);
    release!();
    expect(await sending).toEqual({ "peer-b": "fulfilled" });
    expect(prematureAuthorizations).toBe(0);
    expect(b.rows[0].message.body).toBe("group send during recovery");
  });

  it("does not reopen relays when a pending identity operation finishes after close", async () => {
    const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
    const a = await peer("peer-a", signalUrl, relayUrl);
    const identity = await a.client.secure.publicIdentity();
    let release!: () => void, waiting = false;
    vi.spyOn(a.client.secure, "publicIdentity").mockImplementationOnce(() => {
      waiting = true;
      return new Promise((resolve) => { release = () => resolve(identity); });
    });
    interrupt(signal, a.client);
    await until(() => waiting);
    a.client.close();
    release();
    await delay(100);
    expect(state(a)?.signaling).toBe("offline");
    expect(state(a)?.relays).toBe(0);
    expect(socket(a.client).active).toBe(false);
  });

  it("cancels waiting sends and scheduled registration retries when the user closes the peer", async () => {
    const signal = createSignaling(), signalUrl = await listen(signal), relayUrl = await listen(createRelay());
    let drop = false, attempts = 0;
    signal.io.on("connection", (server) => {
      const [register] = server.listeners("peer:register");
      server.removeAllListeners("peer:register");
      server.on("peer:register", (input, reply) => {
        attempts++;
        if (!drop) void register(input, reply);
      });
    });
    const a = await peer("peer-a", signalUrl, relayUrl);
    drop = true;
    interrupt(signal, a.client);
    await until(() => a.events.some((item) => item.text?.startsWith("register failed:")));
    const result = a.client.sendDirect("peer-b", "cancel waiting send").then(
      () => "delivered", (error: Error) => error.message,
    );
    await until(() => a.rows.length === 1);
    a.client.close();
    expect(await Promise.race([result, delay(150).then(() => "still pending")])).toContain("peer disconnected");
    await delay(400);
    expect(attempts).toBe(2);
    expect(state(a)?.signaling).toBe("offline");
    expect(socket(a.client).active).toBe(false);
  });
});
