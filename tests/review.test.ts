import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PeerClient,
  parseMessage,
  orderMessages,
  type ChatMessage,
  type ChatStore,
  type Group,
  type PeerConfig,
  type StoredMessage,
} from "../src/shared/index.ts";
import { MessageDelivery } from "../src/shared/messageDelivery.ts";
import { WebStore } from "../src/web-peer/store.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";

class MemoryStore implements ChatStore {
  rows: StoredMessage[] = [];
  async put(row: StoredMessage) {
    const index = this.rows.findIndex(
      (item) =>
        item.message.messageId === row.message.messageId &&
        item.message.senderId === row.message.senderId &&
        item.message.receiverId === row.message.receiverId,
    );
    if (index < 0) this.rows.push(row);
    else this.rows[index] = row;
  }
  async mark(id: string, receiver: string, status: StoredMessage["status"]) {
    for (const row of this.rows)
      if (row.message.messageId === id && row.message.receiverId === receiver)
        row.status = status;
  }
  async has(id: string, sender: string) {
    return this.rows.some(
      (row) => row.message.messageId === id && row.message.senderId === sender,
    );
  }
  async list() {
    return this.rows;
  }
}
const services: {
  httpServer: import("node:http").Server;
  close: () => Promise<void>;
}[] = [];
const clients: PeerClient[] = [];
const deliveries: MessageDelivery[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  deliveries.splice(0).forEach((delivery) => delivery.close());
  for (const service of services.splice(0).reverse()) await service.close();
  vi.unstubAllGlobals();
});
async function listen<T extends (typeof services)[number]>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function setup() {
  const signal = createSignaling();
  const signalUrl = await listen(signal);
  const relayUrl = await listen(
    createRelay(undefined, async (id) => signal.groups.get(id) || null),
  );
  async function peer(peerId: string) {
    const store = new MemoryStore();
    let ready = false;
    const client = new PeerClient({
      peerId,
      identityProof: "review-regression-identity-secret",
      signalUrl,
      relayUrl,
      store,
      forceRelay: true,
      rtc: class {} as unknown as PeerConfig["rtc"],
      ackTimeoutMs: 100,
      onEvent: (event) => {
        if (event.connection) ready = event.connection.relays > 0;
      },
    });
    clients.push(client);
    await client.connect();
    await waitFor(() => ready);
    return { client, store };
  }
  return { peer };
}
function packet(): ChatMessage {
  return {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId: "peer-a",
    receiverId: "peer-b",
    type: "text",
    timestamp: Date.now(),
    logicalTime: Date.now(),
    body: "review",
    mode: "RELAY",
    attempt: 1,
    sequence: 1,
  };
}
function identity(message: ChatMessage) {
  const {
    messageId,
    sessionId,
    senderId,
    groupId,
    type,
    timestamp,
    logicalTime,
    body,
    sequence,
  } = message;
  return {
    messageId,
    sessionId,
    senderId,
    groupId,
    type,
    timestamp,
    logicalTime,
    body,
    sequence,
  };
}

describe("DS01 reliability and consistency review", () => {
  it("retries a failed message with its original identity and ordering metadata", async () => {
    const { peer } = await setup();
    const a = await peer("peer-a");
    await expect(
      a.client.sendDirect("peer-b", "retry after receiver rejoins"),
    ).rejects.toThrow("delivery failed");
    const original = structuredClone(a.store.rows[0].message);
    const b = await peer("peer-b");
    await a.client.sendDirect("peer-b", "newer message");
    await a.client.retry(original.messageId, "peer-b");
    const outgoing = a.store.rows.find(
      (row) => row.message.messageId === original.messageId,
    )!;
    const incoming = b.store.rows.find(
      (row) => row.message.messageId === original.messageId,
    )!;
    expect(outgoing.status).toBe("delivered");
    expect(identity(outgoing.message)).toEqual(identity(original));
    expect(identity(incoming.message)).toEqual(identity(original));
    expect(
      b.store.rows.filter(
        (row) => row.message.messageId === original.messageId,
      ),
    ).toHaveLength(1);
  });

  it("uses one immutable logical event for every recipient of a group broadcast", async () => {
    const { peer } = await setup();
    const a = await peer("peer-a"),
      b = await peer("peer-b"),
      c = await peer("peer-c");
    const group = await a.client.createGroup(["peer-b", "peer-c"]);
    await waitFor(() =>
      [a, b, c].every((item) =>
        item.client.getGroups().some((row) => row.id === group.id),
      ),
    );
    await Promise.all([
      a.client.sendGroup(group.id, "broadcast-a"),
      b.client.sendGroup(group.id, "broadcast-b"),
    ]);
    for (const body of ["broadcast-a", "broadcast-b"]) {
      const copies = [a, b, c]
        .flatMap((item) => item.store.rows)
        .filter((row) => row.message.body === body);
      expect(copies).toHaveLength(4);
      expect(
        new Set(copies.map((row) => JSON.stringify(identity(row.message))))
          .size,
      ).toBe(1);
    }
    const finalViews = [a, b, c].map((item) => [
      ...new Set(
        orderMessages(item.store.rows).map((row) => row.message.messageId),
      ),
    ]);
    expect(finalViews[0]).toHaveLength(2);
    expect(finalViews[1]).toEqual(finalViews[0]);
    expect(finalViews[2]).toEqual(finalViews[0]);
  });

  it("settles overlapping retries without replacing the pending application ACK", async () => {
    const { peer } = await setup();
    const a = await peer("peer-a");
    await expect(
      a.client.sendDirect("peer-b", "overlapping retry"),
    ).rejects.toThrow("delivery failed");
    const id = a.store.rows[0].message.messageId;
    const b = await peer("peer-b");
    const results = await Promise.allSettled([
      a.client.retry(id, "peer-b"),
      a.client.retry(id, "peer-b"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(a.store.rows[0].status).toBe("delivered");
    expect(b.store.rows).toHaveLength(1);
  });

  it("retries two failed group recipients concurrently while retaining one logical event", async () => {
    const { peer } = await setup();
    const a = await peer("peer-a");
    const group = await a.client.createGroup(["peer-b", "peer-c"]);
    expect(await a.client.sendGroup(group.id, "retry both recipients")).toEqual(
      { "peer-b": "rejected", "peer-c": "rejected" },
    );
    const original = structuredClone(a.store.rows[0].message);
    const b = await peer("peer-b"),
      c = await peer("peer-c");
    await Promise.all([
      a.client.retry(original.messageId, "peer-b"),
      a.client.retry(original.messageId, "peer-c"),
    ]);
    expect(a.store.rows).toHaveLength(2);
    expect(a.store.rows.every((row) => row.status === "delivered")).toBe(true);
    for (const receiver of [b, c]) {
      expect(receiver.store.rows).toHaveLength(1);
      expect(identity(receiver.store.rows[0].message)).toEqual(
        identity(original),
      );
    }
  });

  it.each([
    "group",
    "sequence",
    "session",
    "sender",
    "receiver",
    "ackFor",
  ] as const)("ignores an ACK with the wrong %s context", async (mismatch) => {
    const store = new MemoryStore();
    const group: Group = {
      id: randomUUID(),
      ownerId: "peer-a",
      members: ["peer-a", "peer-b"],
      version: 1,
    };
    let correctAckSent = false;
    const delivery = new MessageDelivery({
      peerId: "peer-a",
      store,
      ackTimeoutMs: 200,
      getGroup: () => group,
      syncProjectGroup: async () => group,
      authorizeGroup: async () => group,
      selectMode: async () => "RELAY",
      emit: () => {},
      log: () => {},
      transport: async (message) => {
        const ack: ChatMessage = {
          ...message,
          messageId: randomUUID(),
          senderId: "peer-b",
          receiverId: "peer-a",
          type: "ack",
          body: "",
          ackFor: message.messageId,
          ackRequested: false,
        };
        const invalid = { ...ack };
        if (mismatch === "group") invalid.groupId = null;
        if (mismatch === "sequence") invalid.sequence++;
        if (mismatch === "session") invalid.sessionId = randomUUID();
        if (mismatch === "sender") invalid.senderId = "peer-outsider";
        if (mismatch === "receiver") invalid.receiverId = "peer-other";
        if (mismatch === "ackFor") invalid.ackFor = randomUUID();
        await delivery.receive(invalid, "RELAY");
        setTimeout(() => {
          correctAckSent = true;
          void delivery.receive(ack, "RELAY");
        }, 25);
      },
    });
    deliveries.push(delivery);
    await delivery.sendGroup(group.id, "context-bound ACK");
    expect(correctAckSent).toBe(true);
    expect(store.rows[0].status).toBe("delivered");
  });

  it("rejects contradictory or unrecognized wire fields instead of silently stripping them", () => {
    const base = packet();
    expect(() =>
      parseMessage({ ...base, undeclaredPayload: "not in the protocol" }),
    ).toThrow();
    expect(() => parseMessage({ ...base, ackFor: randomUUID() })).toThrow();
    expect(() =>
      parseMessage({
        ...base,
        type: "ack",
        ackFor: randomUUID(),
        body: "hidden content",
      }),
    ).toThrow();
  });

  it.each([
    null,
    { message: { sequence: 1, messageId: randomUUID() }, status: "received" },
    { message: packet(), status: "unknown" },
  ])("preserves and reports malformed local history: %j", async (bad) => {
    const raw = JSON.stringify([
      { message: packet(), status: "received" },
      bad,
    ]);
    const values = new Map([["ds01-history-v1-peer-b", raw]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const store = new WebStore("peer-b");
    await expect(store.list()).rejects.toThrow("Lịch sử cục bộ bị hỏng");
    await expect(
      store.put({ message: packet(), status: "received" }),
    ).rejects.toThrow("Lịch sử cục bộ bị hỏng");
    expect(values.get("ds01-history-v1-peer-b")).toBe(raw);
  });

  it("makes the load experiment fail when a relay forwards to the wrong socket", async () => {
    const signalUrl = await listen(createSignaling());
    const relay = createRelay();
    const relayUrl = await listen(relay);

    relay.io.on("connection", (socket) => {
      socket.removeAllListeners("relay:send");
      socket.on("relay:send", (message, reply) => {
        socket.emit("relay:receive", message);
        reply({ ok: true });
      });
    });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/load-relay.mjs", import.meta.url)),
        "--peers",
        "3",
        "--messages",
        "1",
        "--concurrency",
        "1",
        "--signal",
        signalUrl,
        "--relay",
        relayUrl,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (errors += data));
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      expect(errors).toBe("");
      expect(code).toBe(1);
      expect(JSON.parse(output)).toMatchObject({
        requested: 3,
        delivered: 0,
        failed: 3,
        misroutedDeliveries: 3,
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  });
});
