import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MessageDelivery } from "../src/shared/chat/messageDelivery.ts";
import {
  MAX_DELIVERY_ATTEMPTS,
  parseMessage,
  type ChatMessage,
} from "../src/shared/protocol.ts";
import type {
  ChatStore,
  PeerEvent,
  StoredMessage,
} from "../src/shared/peerTypes.ts";
import { WebStore } from "../src/web-peer/storage/store.ts";

class MemoryStore implements ChatStore {
  rows: StoredMessage[] = [];
  async put(row: StoredMessage) {
    const at = this.rows.findIndex(
      (item) =>
        item.message.messageId === row.message.messageId &&
        item.message.senderId === row.message.senderId &&
        item.message.receiverId === row.message.receiverId,
    );
    if (at < 0) this.rows.push(row);
    else this.rows[at] = row;
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
const deliveries: MessageDelivery[] = [];
function delivery(
  peerId: string,
  store: ChatStore,
  extra: Partial<ConstructorParameters<typeof MessageDelivery>[0]> = {},
) {
  const value = new MessageDelivery({
    peerId,
    store,
    ackTimeoutMs: 20,
    getGroup: () => undefined,
    selectMode: async () => "RELAY",
    syncProjectGroup: async () => {
      throw Error("unused");
    },
    authorizeGroup: async () => {
      throw Error("group denied");
    },
    transport: async () => {},
    emit: () => {},
    log: () => {},
    ...extra,
  });
  deliveries.push(value);
  return value;
}
function packet(sequence = 1): ChatMessage {
  return parseMessage({
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId: "peer-a",
    receiverId: "peer-b",
    type: "text",
    body: `message ${sequence}`,
    timestamp: 1000 + sequence,
    logicalTime: 1000 + sequence,
    sequence,
    attempt: 1,
    mode: "RELAY",
  });
}
function ackFor(message: ChatMessage): ChatMessage {
  return parseMessage({
    messageId: randomUUID(),
    sessionId: message.sessionId,
    senderId: message.receiverId,
    receiverId: message.senderId,
    groupId: message.groupId,
    type: "ack",
    body: "",
    timestamp: Date.now(),
    logicalTime: (message.logicalTime ?? message.timestamp) + 1,
    sequence: message.sequence,
    attempt: 1,
    mode: message.mode,
    ackFor: message.messageId,
    ackRequested: false,
  });
}
function browserStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("localStorage", storage);
  return { values, storage };
}
afterEach(() => {
  deliveries.splice(0).forEach((value) => value.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reliable delivery and message identity", () => {
  it("retains the cause and recipient when missing keys exhaust the bounded send attempts", async () => {
    const store = new MemoryStore(),
      logs: string[] = [];
    const sender = delivery("peer-a", store, {
      transport: async () => {
        throw Error("peer has no published security key");
      },
      log: (text) => logs.push(text),
    });
    await expect(
      sender.sendDirect("peer-b", "private content"),
    ).rejects.toThrow(
      "delivery failed to peer-b: Error: peer has no published security key",
    );
    const failed = logs.filter((text) => text.startsWith("send attempt"));
    expect(failed).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(
      failed.every(
        (text) =>
          text.includes("peer=peer-b") &&
          text.includes("message=") &&
          text.includes("type=text"),
      ),
    ).toBe(true);
    expect(logs.join("\n")).not.toContain("private content");
    expect(store.rows[0].status).toBe("failed");
  });
  it("processes outgoing ACKs while an unrelated incoming message is blocked on storage", async () => {
    const store = new MemoryStore();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const originalPut = store.put.bind(store);
    store.put = async (row) => {
      if (row.status === "received" && row.message.body === "slow incoming") {
        entered();
        await gate;
      }
      await originalPut(row);
    };
    let b!: MessageDelivery;
    b = delivery("peer-b", store, {
      transport: async (message) => {
        if (message.type !== "ack")
          void b.receive(ackFor(message), message.mode);
      },
    });
    const incoming = b.receive(
      { ...packet(), senderId: "peer-c", body: "slow incoming" },
      "RELAY",
    );
    await started;
    try {
      await expect(
        b.sendDirect("peer-a", "outgoing during slow receive"),
      ).resolves.toBeUndefined();
      expect(store.rows).toEqual([
        expect.objectContaining({ status: "delivered" }),
      ]);
    } finally {
      release();
      await incoming;
    }
    expect(store.rows.filter((row) => row.status === "received")).toHaveLength(
      1,
    );
  });

  it.each([
    { body: "different content" },
    { sessionId: randomUUID() },
    { sequence: 2 },
    { timestamp: 9999 },
    { logicalTime: 9999 },
    {
      type: "attachment",
      body: "",
      attachments: [
        {
          id: "other-file",
          name: "other.bin",
          mime: "application/octet-stream",
          size: 1,
        },
      ],
    },
  ])(
    "does not ACK a different logical event reusing a received Message ID: %#",
    async (changed) => {
      const store = new MemoryStore(),
        acknowledgements: ChatMessage[] = [],
        logs: string[] = [];
      const b = delivery("peer-b", store, {
        transport: async (message) => {
          acknowledgements.push(message);
        },
        log: (text) => logs.push(text),
      });
      const first = packet();
      await b.receive(first, "RELAY");
      await b.receive({ ...first, ...changed }, "RELAY");
      expect(acknowledgements).toHaveLength(1);
      expect(store.rows).toEqual([{ message: first, status: "received" }]);
      expect(logs.some((text) => text.includes("conflicting message ID"))).toBe(
        true,
      );
    },
  );

  it("deduplicates identical retries across DIRECT and RELAY while acknowledging every valid copy", async () => {
    const store = new MemoryStore(),
      acknowledgements: ChatMessage[] = [];
    const b = delivery("peer-b", store, {
      transport: async (message) => {
        acknowledgements.push(message);
      },
    });
    const first = { ...packet(), mode: "DIRECT" as const };
    await Promise.all([
      b.receive(first, "DIRECT", "peer-a"),
      b.receive({ ...first, mode: "RELAY", attempt: 2 }, "RELAY"),
    ]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].message).toEqual(first);
    expect(acknowledgements.map((message) => message.mode)).toEqual([
      "DIRECT",
      "RELAY",
    ]);
    expect(
      acknowledgements.every((message) => message.ackFor === first.messageId),
    ).toBe(true);
  });

  it.each(["peer-b", "peer-c"])(
    "rejects reuse of a sent Message ID for a new event addressed to %s",
    async (receiver) => {
      const store = new MemoryStore(),
        transmitted: ChatMessage[] = [];
      let a!: MessageDelivery;
      a = delivery("peer-a", store, {
        transport: async (message) => {
          transmitted.push(message);
          await a.receive(ackFor(message), "RELAY");
        },
      });
      const id = randomUUID();
      await a.send("peer-b", "original event", undefined, id);
      const original = structuredClone(store.rows);
      await expect(
        a.send(receiver, "a different event", undefined, id),
      ).rejects.toThrow("message ID already used");
      expect(store.rows).toEqual(original);
      expect(transmitted).toHaveLength(1);
    },
  );

  it("rejects simultaneous new events sharing one ID even when their recipients differ", async () => {
    const store = new MemoryStore(),
      transmitted: ChatMessage[] = [];
    let a!: MessageDelivery;
    a = delivery("peer-a", store, {
      transport: async (message) => {
        transmitted.push(message);
        await a.receive(ackFor(message), "RELAY");
      },
    });
    const id = randomUUID();
    const results = await Promise.allSettled([
      a.send("peer-b", "event one", undefined, id),
      a.send("peer-c", "event two", undefined, id),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(transmitted).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it.each(["DIRECT", "RELAY"] as const)(
    "distinguishes transport progress from receiver-confirmed delivery over %s",
    async (mode) => {
      const store = new MemoryStore(),
        events: PeerEvent[] = [];
      let sent!: (message: ChatMessage) => void;
      const transmitted = new Promise<ChatMessage>((resolve) => {
        sent = resolve;
      });
      const a = delivery("peer-a", store, {
        ackTimeoutMs: 1000,
        selectMode: async () => mode,
        emit: (event) => events.push(event),
        transport: async (message) => {
          sent(message);
        },
      });
      const sending = a.sendDirect("peer-b", "await receiver confirmation");
      const message = await transmitted;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.rows[0].status).toBe(
        mode === "RELAY" ? "forwarded" : "sent",
      );
      expect(
        events.some((event) => event.message?.status === "delivered"),
      ).toBe(false);
      await a.receive(ackFor(message), mode);
      await sending;
      expect(
        events
          .filter((event) => event.kind === "message")
          .map((event) => event.message!.status),
      ).toEqual([
        "pending",
        mode === "RELAY" ? "forwarded" : "sent",
        "delivered",
      ]);
    },
  );

  it.each(["rejected", "stalled"])(
    "accepts end-to-end confirmation even when the relay RPC response is %s",
    async (response) => {
      const source = new MemoryStore(),
        target = new MemoryStore();
      let a!: MessageDelivery,
        count = 0;
      const b = delivery("peer-b", target, {
        transport: async (message) => {
          await a.receive(message, "RELAY");
        },
      });
      a = delivery("peer-a", source, {
        transport: async (message) => {
          count++;
          await b.receive(message, "RELAY");
          if (response === "rejected") throw Error("relay RPC response lost");
          await new Promise<void>(() => {});
        },
      });
      const sending = a
        .sendDirect("peer-b", "peer confirmation is authoritative")
        .then(
          () => "delivered",
          () => "failed",
        );
      expect(
        await Promise.race([
          sending,
          new Promise((resolve) =>
            setTimeout(() => resolve("still waiting"), 200),
          ),
        ]),
      ).toBe("delivered");
      expect(count).toBe(1);
      expect(source.rows[0]).toMatchObject({
        status: "delivered",
        message: { mode: "RELAY" },
      });
      expect(target.rows).toHaveLength(1);
    },
  );

  it.each(["lost-data", "lost-first-ack", "lost-all-acks"])(
    "applies bounded retries without duplicating history: %s",
    async (failure) => {
      const source = new MemoryStore(),
        target = new MemoryStore(),
        attempts: ChatMessage[] = [];
      let a!: MessageDelivery,
        acknowledgements = 0;
      const b = delivery("peer-b", target, {
        transport: async (message) => {
          acknowledgements++;
          if (
            failure === "lost-all-acks" ||
            (failure === "lost-first-ack" && acknowledgements === 1)
          )
            return;
          await a.receive(message, message.mode);
        },
      });
      a = delivery("peer-a", source, {
        selectMode: async () => "DIRECT",
        transport: async (message) => {
          attempts.push(message);
          if (failure === "lost-data" && attempts.length === 1) return;
          await b.receive(message, message.mode, "peer-a");
        },
      });
      if (failure === "lost-all-acks") {
        await expect(a.sendDirect("peer-b", failure)).rejects.toThrow(
          "delivery failed",
        );
        expect(source.rows[0].status).toBe("failed");
        expect(attempts).toHaveLength(MAX_DELIVERY_ATTEMPTS);
      } else {
        await a.sendDirect("peer-b", failure);
        expect(source.rows[0].status).toBe("delivered");
        expect(attempts).toHaveLength(2);
      }
      expect(target.rows).toHaveLength(1);
      expect(attempts.map((message) => message.attempt)).toEqual(
        Array.from({ length: attempts.length }, (_, index) => index + 1),
      );
      expect(attempts.map((message) => message.mode)).toEqual([
        "DIRECT",
        ...Array(attempts.length - 1).fill("RELAY"),
      ]);
      expect(
        new Set(
          attempts.map((message) =>
            JSON.stringify([
              message.messageId,
              message.sessionId,
              message.sequence,
              message.timestamp,
              message.logicalTime,
              message.body,
            ]),
          ),
        ).size,
      ).toBe(1);
    },
  );

  it("recovers an interrupted forwarded send as unconfirmed and preserves sequence and session", async () => {
    browserStorage();
    const store = new WebStore("peer-a"),
      old = packet(7);
    await store.put({ message: old, status: "forwarded" });
    let a!: MessageDelivery;
    a = delivery("peer-a", store, {
      transport: async (message) => {
        await a.receive(ackFor(message), "RELAY");
      },
    });
    await a.recover();
    expect((await new WebStore("peer-a").list())[0].status).toBe("failed");
    await a.sendDirect("peer-b", "after recovery");
    const rows = await store.list();
    expect(rows.map((row) => row.status)).toEqual(["failed", "delivered"]);
    expect(rows[1].message).toMatchObject({
      sequence: 8,
      sessionId: old.sessionId,
    });
  });

  it("orders reordered and duplicate receives by sender sequence even with backwards timestamps", async () => {
    browserStorage();
    const store = new WebStore("peer-b"),
      b = delivery("peer-b", store),
      first = packet();
    const second = { ...packet(2), sessionId: first.sessionId, timestamp: 900 },
      third = { ...packet(3), sessionId: first.sessionId, timestamp: 800 };
    await Promise.all(
      [third, first, second, second].map((message) =>
        b.receive(message, "RELAY"),
      ),
    );
    expect(
      (await store.listDirect("peer-a")).map((row) => row.message.sequence),
    ).toEqual([1, 2, 3]);
    expect(
      (await new WebStore("peer-b").list()).map((row) => row.message.messageId),
    ).toEqual([first, second, third].map((message) => message.messageId));
  });

  it("allows route/status updates but never overwrites retained content for the same ID", async () => {
    browserStorage();
    const store = new WebStore("peer-a"),
      message = packet();
    await store.put({ message, status: "pending" });
    await store.put({
      message: { ...message, attempt: 2 },
      status: "forwarded",
    });
    await expect(
      store.put({
        message: { ...message, body: "overwritten" },
        status: "delivered",
      }),
    ).rejects.toThrow("conflicting message ID");
    expect((await store.list())[0]).toEqual({
      message: { ...message, attempt: 2 },
      status: "forwarded",
    });
  });

  it("retries a failed dedup-ledger write without losing or duplicating the already persisted message", async () => {
    const { storage } = browserStorage(),
      originalSet = storage.setItem;
    let failOnce = true;
    storage.setItem = (key, value) => {
      if (key.endsWith("-seen") && failOnce) {
        failOnce = false;
        throw Error("quota failure");
      }
      originalSet(key, value);
    };
    const source = new WebStore("peer-a"),
      target = new WebStore("peer-b");
    let a!: MessageDelivery,
      count = 0;
    const b = delivery("peer-b", target, {
      transport: async (message) => {
        await a.receive(message, "RELAY");
      },
    });
    a = delivery("peer-a", source, {
      transport: async (message) => {
        count++;
        await b.receive(message, "RELAY");
      },
    });
    await a.sendDirect("peer-b", "survives partial storage write");
    expect(count).toBe(2);
    expect(await target.list()).toHaveLength(1);
    expect((await source.list())[0].status).toBe("delivered");
  });
});
