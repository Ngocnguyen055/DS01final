import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io, type Socket } from "socket.io-client";
import { createRelay } from "../src/relay/index.ts";
import {
  MAX_WIRE_BYTES,
  parseMessage,
  type ChatMessage,
} from "../src/shared/protocol.ts";
import { MessageDelivery } from "../src/shared/chat/messageDelivery.ts";
import type {
  ChatStore,
  PeerEvent,
  StoredMessage,
} from "../src/shared/peerTypes.ts";

function packet(): ChatMessage {
  return {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId: "peer-a",
    receiverId: "peer-b",
    type: "text",
    timestamp: Date.now(),
    logicalTime: 20,
    body: "Xin chào",
    mode: "RELAY",
    attempt: 1,
    sequence: 1,
  };
}
class MemoryStore implements ChatStore {
  rows: StoredMessage[] = [];
  async put(row: StoredMessage) {
    const at = this.rows.findIndex(
      (item) =>
        item.message.messageId === row.message.messageId &&
        item.message.receiverId === row.message.receiverId &&
        item.message.senderId === row.message.senderId,
    );
    if (at < 0) this.rows.push(row);
    else this.rows[at] = row;
  }
  async mark(id: string, receiverId: string, status: StoredMessage["status"]) {
    for (const row of this.rows)
      if (row.message.messageId === id && row.message.receiverId === receiverId)
        row.status = status;
  }
  async has(id: string, senderId: string) {
    return this.rows.some(
      (row) =>
        row.message.messageId === id && row.message.senderId === senderId,
    );
  }
  async list() {
    return this.rows;
  }
  async isDirectBlocked(peerId: string) {
    return peerId === "peer-blocked";
  }
}
const deliveries: MessageDelivery[] = [];
const relays: ReturnType<typeof createRelay>[] = [],
  sockets: Socket[] = [];
function delivery(
  peerId: string,
  store: MemoryStore,
  transport: (message: ChatMessage) => Promise<void>,
  events: PeerEvent[] = [],
) {
  const value = new MessageDelivery({
    peerId,
    store,
    transport,
    ackTimeoutMs: 100,
    selectMode: async () => "RELAY",
    getGroup: () => undefined,
    syncProjectGroup: async () => {
      throw Error("group denied");
    },
    authorizeGroup: async () => {
      throw Error("group denied");
    },
    emit: (event) => events.push(event),
    log: () => {},
  });
  deliveries.push(value);
  return value;
}
afterEach(async () => {
  deliveries.splice(0).forEach((value) => value.close());
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const relay of relays.splice(0)) await relay.close();
  vi.restoreAllMocks();
});

describe("message structure required by DS01 section 5.7", () => {
  it.each([
    "messageId",
    "senderId",
    "receiverId",
    "sessionId",
    "type",
    "timestamp",
    "body",
    "mode",
    "sequence",
    "attempt",
  ])("rejects a missing required field before dispatch: %s", (field) => {
    const input: Record<string, unknown> = packet();
    delete input[field];
    expect(() => parseMessage(input)).toThrow();
  });

  it("round-trips direct, group, attachment, file chunk and ACK envelopes as JSON with explicit acknowledgement information", () => {
    const base = packet(),
      groupId = randomUUID(),
      transferId = randomUUID();
    const file = {
      id: transferId,
      name: "sample.bin",
      mime: "application/octet-stream",
      size: 1,
      sha256: "a".repeat(64),
    };
    for (const input of [
      { ...base, mode: "DIRECT" },
      { ...base, groupId, sessionId: groupId },
      { ...base, type: "attachment", body: "", attachments: [file] },
      {
        ...base,
        type: "file-chunk",
        body: "",
        fileChunk: { transferId, index: 0, total: 1, data: "YQ==", file },
      },
      { ...base, type: "ack", body: "", ackFor: randomUUID() },
    ]) {
      const message = parseMessage(input),
        restored = parseMessage(JSON.parse(JSON.stringify(message)));
      expect(restored).toEqual(message);
      expect(message.ackRequested).toBe(message.type !== "ack");
      if (message.type === "ack") expect(message.ackFor).toBe(input.ackFor);
    }
  });

  it.each([
    { ackRequested: false },
    { ackRequested: "true" },
    { type: "ack", body: "", ackFor: randomUUID(), ackRequested: true },
    { type: "ack", body: "", ackRequested: false },
    { status: "delivered" },
    { type: "unknown" },
  ])(
    "rejects contradictory ACK metadata, unsupported types and forged local status: %#",
    (invalid) => {
      expect(() => parseMessage({ ...packet(), ...invalid })).toThrow();
    },
  );

  it("rejects an ACK which refers to its own Message ID", () => {
    const base = packet();
    expect(() =>
      parseMessage({
        ...base,
        type: "ack",
        body: "",
        ackFor: base.messageId,
        ackRequested: false,
      }),
    ).toThrow("ACK cannot acknowledge itself");
  });

  it.each([
    { timestamp: 0 },
    { timestamp: -1 },
    { timestamp: Infinity },
    { timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { logicalTime: -1 },
    { logicalTime: NaN },
    { logicalTime: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: 1.5 },
    { sequence: -1 },
    { attempt: 0 },
  ])("rejects invalid timestamps and ordering metadata: %#", (invalid) => {
    expect(() => parseMessage({ ...packet(), ...invalid })).toThrow();
  });

  it("enforces the complete UTF-8 envelope limit at exactly 8192 bytes", () => {
    const input = { ...packet(), body: "", ackRequested: true };
    const available =
      MAX_WIRE_BYTES - Buffer.byteLength(JSON.stringify(input), "utf8");
    input.body =
      "漢".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    expect(input.body.length).toBeLessThan(4000);
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(
      MAX_WIRE_BYTES,
    );
    expect(parseMessage(input).body).toBe(input.body);
    expect(() => parseMessage({ ...input, body: input.body + "x" })).toThrow(
      "message too large",
    );
  });

  it("checks the normalized envelope size when accepting an older message without ackRequested", () => {
    const input = { ...packet(), body: "" };
    const available =
      MAX_WIRE_BYTES - Buffer.byteLength(JSON.stringify(input), "utf8");
    input.body =
      "漢".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(
      MAX_WIRE_BYTES,
    );
    expect(() => parseMessage(input)).toThrow("message too large");
  });

  it("forwards a valid 8192-byte JSON envelope through Socket.IO framing and rejects 8193 bytes", async () => {
    const relay = createRelay();
    relays.push(relay);
    await new Promise<void>((resolve) =>
      relay.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(relay.httpServer.address() as AddressInfo).port}`;
    const [a, b] = await Promise.all(
      ["peer-a", "peer-b"].map(async (peerId) => {
        const token = jwt.sign({ sub: peerId }, process.env.PEER_SECRET!, {
          expiresIn: "1h",
          audience: "ds01-relay",
          issuer: "ds01-signaling",
        });
        const socket = io(url, {
          auth: { token },
          transports: ["websocket"],
          reconnection: false,
        });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("connect_error", reject);
        });
        return socket;
      }),
    );
    const input = { ...packet(), body: "", ackRequested: true },
      received: ChatMessage[] = [];
    const available =
      MAX_WIRE_BYTES - Buffer.byteLength(JSON.stringify(input), "utf8");
    input.body =
      "漢".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    b.on("relay:receive", (message) => received.push(message));
    const receivedOnce = new Promise<void>((resolve) =>
      b.once("relay:receive", () => resolve()),
    );
    expect(await a.timeout(1000).emitWithAck("relay:send", input)).toEqual({
      ok: true,
    });
    await receivedOnce;
    expect(received).toEqual([input]);
    expect(
      await a
        .timeout(1000)
        .emitWithAck("relay:send", {
          ...input,
          messageId: randomUUID(),
          body: input.body + "x",
        }),
    ).toEqual({ ok: false, error: "message too large" });
    expect(received).toHaveLength(1);
  });

  it("acknowledges only after local persistence, identifies the original message and never ACKs an ACK", async () => {
    const left = new MemoryStore(),
      right = new MemoryStore(),
      packets: ChatMessage[] = [];
    let a!: MessageDelivery, b!: MessageDelivery;
    a = delivery("peer-a", left, async (message) => {
      packets.push(message);
      await b.receive(JSON.parse(JSON.stringify(message)), "RELAY");
    });
    b = delivery("peer-b", right, async (message) => {
      expect(
        right.rows.some(
          (row) =>
            row.message.messageId === message.ackFor &&
            row.status === "received",
        ),
      ).toBe(true);
      packets.push(message);
      await a.receive(JSON.parse(JSON.stringify(message)), "RELAY");
    });
    await a.sendDirect("peer-b", "confirmed after persistence");
    expect(packets).toHaveLength(2);
    const [message, ack] = packets;
    expect(message.ackRequested).toBe(true);
    expect(ack).toMatchObject({
      type: "ack",
      ackFor: message.messageId,
      ackRequested: false,
      senderId: message.receiverId,
      receiverId: message.senderId,
      sessionId: message.sessionId,
      sequence: message.sequence,
      mode: "RELAY",
      body: "",
    });
    expect(ack.messageId).not.toBe(message.messageId);
    expect(ack.logicalTime).toBeGreaterThan(message.logicalTime!);
    expect(left.rows.map((row) => row.status)).toEqual(["delivered"]);
    expect(right.rows.map((row) => row.status)).toEqual(["received"]);
  });

  it.each(["receiver", "sender", "mode", "blocked", "group", "unmatched-ack"])(
    "does not advance local logical time for rejected or unmatched packets: %s",
    async (reason) => {
      vi.spyOn(Date, "now").mockReturnValue(10000);
      const store = new MemoryStore(),
        events: PeerEvent[] = [],
        transmitted: ChatMessage[] = [];
      let self!: MessageDelivery;
      self = delivery(
        "peer-b",
        store,
        async (message) => {
          transmitted.push(message);
          await self.receive(
            {
              ...message,
              messageId: randomUUID(),
              type: "ack",
              body: "",
              ackFor: message.messageId,
              ackRequested: false,
              senderId: message.receiverId,
              receiverId: message.senderId,
            },
            "RELAY",
          );
        },
        events,
      );
      const invalid: ChatMessage = {
        ...packet(),
        receiverId: "peer-b",
        logicalTime: 1_000_000,
      };
      if (reason === "receiver") invalid.receiverId = "peer-c";
      if (reason === "sender") invalid.senderId = "peer-forged";
      if (reason === "mode") invalid.mode = "DIRECT";
      if (reason === "blocked") invalid.senderId = "peer-blocked";
      if (reason === "group") invalid.groupId = randomUUID();
      if (reason === "unmatched-ack") {
        invalid.type = "ack";
        invalid.body = "";
        invalid.ackFor = randomUUID();
      }
      await self.receive(
        invalid,
        "RELAY",
        reason === "sender" ? "peer-a" : undefined,
      );
      expect(store.rows).toHaveLength(0);
      await self.sendDirect("peer-c", "still usable");
      expect(transmitted[0].logicalTime).toBe(10000);
      expect(store.rows[0].status).toBe("delivered");
    },
  );
});
