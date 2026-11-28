import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  PeerClient,
  type ChatMessage,
  type ChatStore,
  type PeerConfig,
  type PeerEvent,
  type StoredMessage,
} from "../src/shared/index.ts";
import { DirectTransport } from "../src/shared/transport/directTransport.ts";
import { MessageDelivery } from "../src/shared/chat/messageDelivery.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";

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
class PendingRTC {
  connectionState = "new";
  signalingState = "stable";
  remoteDescription: unknown = null;
  channel = {
    readyState: "connecting",
    send: () => {},
  } as unknown as RTCDataChannel;
  onconnectionstatechange?: () => void;
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "test" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "test" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(value: unknown) {
    this.remoteDescription = value;
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
  }
}
type Service =
  ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [],
  clients: PeerClient[] = [],
  directs: DirectTransport[] = [],
  deliveries: MessageDelivery[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen<T extends Service>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await delay(10);
  }
}
function directFixture() {
  let rtc!: PendingRTC;
  class TestRTC extends PendingRTC {
    constructor() {
      super();
      rtc = this;
    }
  }
  const modes: string[] = [];
  const direct = new DirectTransport({
    peerId: "peer-a",
    rtc: TestRTC as unknown as PeerConfig["rtc"],
    timeoutMs: 1000,
    sendSignal: async () => {},
    onMessage: () => {},
    onMode: (_peerId, mode) => modes.push(mode),
    log: () => {},
  });
  directs.push(direct);
  return { direct, modes, rtc: () => rtc };
}
function delivery(
  peerId: string,
  store: MemoryStore,
  events: PeerEvent[],
  extra: Partial<ConstructorParameters<typeof MessageDelivery>[0]> = {},
) {
  const instance = new MessageDelivery({
    peerId,
    store,
    ackTimeoutMs: 100,
    selectMode: async () => "DIRECT",
    transport: async () => {},
    getGroup: () => undefined,
    syncProjectGroup: async () => {
      throw Error("unused");
    },
    authorizeGroup: async () => {
      throw Error("access denied");
    },
    emit: (event) => events.push(event),
    log: () => {},
    ...extra,
  });
  deliveries.push(instance);
  return instance;
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  directs.splice(0).forEach((direct) => direct.close());
  deliveries.splice(0).forEach((item) => item.close());
  for (const service of services.splice(0).reverse()) await service.close();
});

describe("WAN connection establishment", () => {
  it.each(["failed", "disconnected", "channel-error"])(
    "ends the DIRECT attempt promptly when failure is already known: %s",
    async (reason) => {
      const { direct, modes, rtc } = directFixture();
      const opening = direct.ensure("peer-b", false);
      if (reason === "channel-error")
        rtc().channel.onerror?.(new Event("error") as RTCErrorEvent);
      else {
        rtc().connectionState = reason;
        rtc().onconnectionstatechange?.();
      }
      expect(
        await Promise.race([opening, delay(150).then(() => "still waiting")]),
      ).toBe(false);
      expect(rtc().connectionState).toBe("closed");
      expect(modes.at(-1)).toBe("RELAY");
    },
  );

  it("waits for the outbound relay handshake after lookup and DIRECT timeout instead of exhausting retries immediately", async () => {
    const signal = createSignaling(),
      signalUrl = await listen(signal),
      relay = createRelay(),
      relayUrl = await listen(relay);
    const order: string[] = [];
    signal.io.on("connection", (socket) =>
      socket.onAny((event) => {
        if (
          socket.data.peerId === "peer-a" &&
          ["peer:lookup", "signal:send"].includes(event)
        )
          order.push(event);
      }),
    );
    relay.io.use(async (socket, next) => {
      if (socket.data.peerId === "peer-a") await delay(350);
      next();
    });
    relay.io.on("connection", (socket) =>
      socket.on("relay:send", () => {
        if (socket.data.peerId === "peer-a") order.push("relay:send");
      }),
    );
    const stores = [new MemoryStore(), new MemoryStore()],
      events: PeerEvent[][] = [[], []];
    for (const [index, peerId] of ["peer-b", "peer-a"].entries()) {
      const client = new PeerClient({
        peerId,
        identityProof: "wan-establishment-test-proof-12345",
        signalUrl,
        relayUrl,
        rtc: PendingRTC as unknown as PeerConfig["rtc"],
        store: stores[index],
        directTimeoutMs: 30,
        requestTimeoutMs: 1000,
        ackTimeoutMs: 300,
        onEvent: (event) => events[index].push(event),
      });
      clients.push(client);
      await client.connect();
      if (index === 0)
        await until(() =>
          events[0].some((event) => event.connection?.relays === 1),
        );
    }
    await expect(
      clients
        .at(-1)!
        .sendDirect("peer-b", "first message during relay startup"),
    ).resolves.toBeUndefined();
    expect(stores[1].rows).toEqual([
      expect.objectContaining({
        status: "delivered",
        message: expect.objectContaining({ mode: "RELAY" }),
      }),
    ]);
    expect(stores[0].rows).toHaveLength(1);
    expect(order.indexOf("peer:lookup")).toBeLessThan(
      order.indexOf("signal:send"),
    );
    expect(order.indexOf("signal:send")).toBeLessThan(
      order.indexOf("relay:send"),
    );
    expect(
      events.every((items) =>
        items.some((event) => event.kind === "mode" && event.mode === "RELAY"),
      ),
    ).toBe(true);
  });

  it("keeps the message route visible at both peers when its ACK falls back to another path", async () => {
    const aStore = new MemoryStore(),
      bStore = new MemoryStore(),
      aEvents: PeerEvent[] = [],
      bEvents: PeerEvent[] = [];
    let a!: MessageDelivery;
    const b = delivery("peer-b", bStore, bEvents, {
      transport: async (packet, mode) => {
        if (mode === "DIRECT") throw Error("ACK direct path unavailable");
        await a.receive(packet, "RELAY");
      },
    });
    a = delivery("peer-a", aStore, aEvents, {
      transport: async (packet) => {
        await b.receive(packet, "DIRECT", "peer-a");
      },
    });
    await a.sendDirect("peer-b", "DIRECT data, RELAY acknowledgement");
    expect(aStore.rows[0].status).toBe("delivered");
    expect(aEvents.filter((event) => event.kind === "mode").at(-1)?.mode).toBe(
      "DIRECT",
    );
    expect(bEvents.filter((event) => event.kind === "mode").at(-1)?.mode).toBe(
      "DIRECT",
    );
    expect(bStore.rows[0].message.mode).toBe("DIRECT");
  });

  it.each([false, true])(
    "bounds waiting for an unavailable relay and cancels on close (close=%s)",
    async (close) => {
      const signalUrl = await listen(createSignaling()),
        relay = createRelay(),
        relayUrl = await listen(relay);
      relay.io.use((_socket, next) =>
        next(new Error("relay temporarily unavailable")),
      );
      const store = new MemoryStore(),
        events: PeerEvent[] = [];
      const client = new PeerClient({
        peerId: "peer-a",
        identityProof: "wan-establishment-test-proof-12345",
        signalUrl,
        relayUrl,
        rtc: PendingRTC as unknown as PeerConfig["rtc"],
        store,
        forceRelay: true,
        requestTimeoutMs: close ? 1000 : 40,
        onEvent: (event) => events.push(event),
      });
      clients.push(client);
      await client.connect();
      const sending = client.sendDirect("peer-b", "bounded waiting").then(
        () => "delivered",
        () => "failed",
      );
      await until(() =>
        events.some(
          (event) => event.text === "waiting for outbound relay connection",
        ),
      );
      if (close) client.close();
      expect(
        await Promise.race([sending, delay(500).then(() => "still waiting")]),
      ).toBe("failed");
      expect(store.rows[0].status).toBe("failed");
      expect(
        events.filter((event) => event.text?.startsWith("send attempt")).length,
      ).toBe(close ? 1 : 3);
    },
  );

  it("does not advertise the path of a rejected group message", async () => {
    const store = new MemoryStore(),
      events: PeerEvent[] = [],
      receiver = delivery("peer-b", store, events);
    const packet: ChatMessage = {
      messageId: randomUUID(),
      sessionId: randomUUID(),
      groupId: randomUUID(),
      senderId: "peer-a",
      receiverId: "peer-b",
      type: "text",
      body: "unauthorized",
      timestamp: Date.now(),
      mode: "RELAY",
      attempt: 1,
      sequence: 1,
    };
    await receiver.receive(packet, "RELAY");
    expect(events.filter((event) => event.kind === "mode")).toEqual([]);
    expect(store.rows).toEqual([]);
  });
});
