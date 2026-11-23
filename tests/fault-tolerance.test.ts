import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import {
  PeerClient,
  type ChatAttachment,
  type ChatMessage,
  type ChatStore,
  type PeerConfig,
  type PeerEvent,
  type StoredMessage,
} from "../src/shared/index.ts";
import { MessageDelivery } from "../src/shared/messageDelivery.ts";
import { DirectTransport } from "../src/shared/directTransport.ts";
import { FileTransfer, fileHash } from "../src/shared/fileTransfer.ts";
import {
  FILE_CHUNK_BYTES,
  MAX_CHAT_ATTACHMENT_BYTES,
  parseMessage,
} from "../src/shared/protocol.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";

class MemoryStore implements ChatStore {
  rows: StoredMessage[] = [];
  files = new Map<string, { file: ChatAttachment; data: Uint8Array }>();
  async put(row: StoredMessage) {
    const index = this.rows.findIndex(
      (item) =>
        item.message.messageId === row.message.messageId &&
        item.message.receiverId === row.message.receiverId &&
        item.message.senderId === row.message.senderId,
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
  async putFile(file: ChatAttachment, data: Uint8Array) {
    this.files.set(file.id, { file, data: new Uint8Array(data) });
  }
  async getFile(id: string) {
    return this.files.get(id);
  }
}
type Service =
  ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [],
  clients: PeerClient[] = [],
  deliveries: MessageDelivery[] = [],
  transfers: FileTransfer[] = [],
  directs: DirectTransport[] = [],
  folders: string[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await delay(10);
  }
}
async function listen<T extends Service>(service: T, port = 0) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(port, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function stop(service: Service) {
  await service.close();
  services.splice(services.indexOf(service), 1);
}
async function peer(
  peerId: string,
  signalUrl: string,
  relayUrl: string,
  extra: Partial<PeerConfig> = {},
) {
  const store = new MemoryStore(),
    events: PeerEvent[] = [];
  const client = new PeerClient({
    peerId,
    identityProof: "fault-test-identity-proof-12345",
    signalUrl,
    relayUrl,
    store,
    forceRelay: true,
    rtc: class {} as unknown as PeerConfig["rtc"],
    ackTimeoutMs: 300,
    ...extra,
    onEvent: (event) => events.push(event),
  });
  clients.push(client);
  await client.connect();
  await until(() =>
    events.some((event) => (event.connection?.relays ?? 0) > 0),
  );
  return { client, store, events };
}
function delivery(
  peerId: string,
  store: MemoryStore,
  transport: (packet: ChatMessage) => Promise<void>,
) {
  const item = new MessageDelivery({
    peerId,
    store,
    transport,
    ackTimeoutMs: 20,
    selectMode: async () => "RELAY",
    getGroup: () => undefined,
    syncProjectGroup: async () => {
      throw Error("unused");
    },
    authorizeGroup: async () => {
      throw Error("unused");
    },
    emit: () => {},
    log: () => {},
  });
  deliveries.push(item);
  return item;
}
async function filePacket(size = 4608) {
  const data = Uint8Array.from({ length: size }, (_, index) => index % 251),
    transferId = randomUUID();
  const file = {
    id: transferId,
    name: "recovery.bin",
    mime: "application/octet-stream",
    size,
    sha256: await fileHash(data),
  };
  const packet: ChatMessage = {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId: "peer-a",
    receiverId: "peer-b",
    type: "file-chunk",
    body: "",
    timestamp: Date.now(),
    sequence: 1,
    mode: "RELAY",
    attempt: 1,
    fileChunk: {
      transferId,
      index: 0,
      total: Math.ceil(size / 2304),
      file,
      data: btoa(String.fromCharCode(...data.subarray(0, 2304))),
    },
  };
  return { packet, data };
}
function transfer(store: MemoryStore, events: PeerEvent[]) {
  const item = new FileTransfer({
    store,
    sendChunk: async () => {},
    sendAttachment: async () => {},
    emit: (event) => events.push(event),
  });
  transfers.push(item);
  return item;
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  deliveries.splice(0).forEach((item) => item.close());
  transfers.splice(0).forEach((item) => item.close());
  directs.splice(0).forEach((item) => item.close());
  vi.useRealTimers();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const folder of folders.splice(0)) {
    const checked = resolve(folder);
    if (
      dirname(checked) !== resolve(tmpdir()) ||
      !basename(checked).startsWith("ds01-fault-")
    )
      throw Error("Unexpected cleanup path");
    rmSync(checked, { recursive: true, force: true });
  }
});

describe("fault tolerance and recovery", () => {
  it("cancels initial registration promptly when the user closes a connecting peer", async () => {
    const signal = createSignaling(),
      signalUrl = await listen(signal);
    let requested = false;
    signal.io.on("connection", (socket) => {
      socket.removeAllListeners("peer:register");
      socket.on("peer:register", () => {
        requested = true;
      });
    });
    const client = new PeerClient({
      peerId: "peer-a",
      identityProof: "fault-test-identity-proof-12345",
      signalUrl,
      relayUrl: signalUrl,
      store: new MemoryStore(),
      rtc: class {} as unknown as PeerConfig["rtc"],
      onEvent: () => {},
    });
    clients.push(client);
    const result = client.connect().then(
      () => "connected",
      () => "rejected",
    );
    await until(() => requested);
    client.close();
    expect(
      await Promise.race([result, delay(150).then(() => "still pending")]),
    ).toBe("rejected");
    expect(signal.peers.size).toBe(0);
  });

  it("cancels connection setup while the signaling endpoint is unreachable", async () => {
    let connecting = false;
    const client = new PeerClient({
      peerId: "peer-a",
      identityProof: "fault-test-identity-proof-12345",
      signalUrl: "http://127.0.0.1:1",
      relayUrl: "http://127.0.0.1:1",
      store: new MemoryStore(),
      rtc: class {} as unknown as PeerConfig["rtc"],
      onEvent: (event) => {
        if (event.connection?.signaling === "connecting") connecting = true;
      },
    });
    clients.push(client);
    const result = client.connect().then(
      () => "connected",
      () => "rejected",
    );
    await until(() => connecting);
    client.close();
    expect(
      await Promise.race([result, delay(150).then(() => "still pending")]),
    ).toBe("rejected");
  });

  it("rejects offline control RPCs instead of replaying a group creation after reconnect", async () => {
    const signal = createSignaling(),
      signalUrl = await listen(signal),
      relayUrl = await listen(createRelay());
    const a = await peer("peer-a", signalUrl, relayUrl);
    signal.peers.get("peer-a")!.socket.disconnect(true);
    await until(
      () => a.events.at(-1)?.connection?.signaling === "reconnecting",
    );
    const result = a.client.createGroup(["peer-b"]).then(
      () => "created",
      () => "rejected",
    );
    expect(
      await Promise.race([result, delay(150).then(() => "still pending")]),
    ).toBe("rejected");
    await until(() => signal.peers.has("peer-a"));
    expect(signal.groups.size).toBe(0);
    expect(a.client.getGroups()).toEqual([]);
  });

  it.each([false, true])(
    "retries lost application ACKs without duplicate history (all ACKs lost=%s)",
    async (allLost) => {
      const source = new MemoryStore(),
        target = new MemoryStore();
      let attempts = 0,
        acknowledgements = 0,
        drop = true;
      let a!: MessageDelivery;
      const b = delivery("peer-b", target, async (ack) => {
        acknowledgements++;
        if (!drop || (!allLost && acknowledgements > 1))
          await a.receive(ack, "RELAY");
      });
      a = delivery("peer-a", source, async (packet) => {
        attempts++;
        await b.receive(packet, "RELAY");
      });
      const sending = a.sendDirect("peer-b", "one event despite ACK loss");
      if (allLost) {
        await expect(sending).rejects.toThrow("delivery failed");
        expect(attempts).toBe(3);
        expect(source.rows[0].status).toBe("failed");
        drop = false;
        await a.retry(source.rows[0].message.messageId, "peer-b");
        expect(attempts).toBe(4);
      } else {
        await sending;
        expect(attempts).toBe(2);
      }
      expect(source.rows[0].status).toBe("delivered");
      expect(target.rows).toHaveLength(1);
      expect(target.rows[0].message.messageId).toBe(
        source.rows[0].message.messageId,
      );
      expect(acknowledgements).toBe(attempts);
    },
  );

  it("withholds application ACK on storage failure and succeeds after a bounded retry", async () => {
    const source = new MemoryStore(),
      target = new MemoryStore();
    let writes = 0,
      attempts = 0,
      acknowledgements = 0;
    const put = target.put.bind(target);
    target.put = async (row) => {
      if (++writes === 1) throw Error("temporary storage failure");
      await put(row);
    };
    let a!: MessageDelivery;
    const b = delivery("peer-b", target, async (ack) => {
      acknowledgements++;
      await a.receive(ack, "RELAY");
    });
    a = delivery("peer-a", source, async (packet) => {
      attempts++;
      await b.receive(packet, "RELAY");
    });
    await a.sendDirect("peer-b", "store before acknowledging");
    expect({ attempts, writes, acknowledgements }).toEqual({
      attempts: 2,
      writes: 2,
      acknowledgements: 1,
    });
    expect(target.rows).toHaveLength(1);
    expect(source.rows[0].status).toBe("delivered");
  });

  it("fails over when a connected relay accepts no RPCs, then receives an end-to-end ACK", async () => {
    const signal = createSignaling(),
      signalUrl = await listen(signal),
      primary = createRelay(),
      primaryUrl = await listen(primary),
      backupUrl = await listen(createRelay());
    primary.io.on("connection", (socket) => {
      socket.removeAllListeners("relay:send");
    });
    const a = await peer("peer-a", signalUrl, primaryUrl, {
      relayUrls: [backupUrl],
      requestTimeoutMs: 100,
    });
    const b = await peer("peer-b", signalUrl, primaryUrl, {
      relayUrls: [backupUrl],
      requestTimeoutMs: 100,
    });
    await until(() =>
      [a, b].every(
        (item) =>
          item.events.filter((event) => event.connection).at(-1)?.connection
            ?.relays === 2,
      ),
    );
    const result = a.client.sendDirect("peer-b", "primary is silent").then(
      () => "delivered",
      () => "failed",
    );
    expect(
      await Promise.race([result, delay(1200).then(() => "still pending")]),
    ).toBe("delivered");
    expect(a.store.rows[0].status).toBe("delivered");
    expect(b.store.rows).toHaveLength(1);
    expect(
      a.events.some((event) => event.connection?.activeRelay === backupUrl),
    ).toBe(true);
  });

  it("expires a missing heartbeat and publishes the peer as offline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signal = createSignaling(),
      signalUrl = await listen(signal),
      relayUrl = await listen(createRelay());
    const a = await peer("peer-a", signalUrl, relayUrl),
      b = await peer("peer-b", signalUrl, relayUrl);
    await until(() => a.client.getOnlinePeers().includes("peer-b"));

    signal.peers.get("peer-b")!.lastSeen = Date.now() - 31000;
    await vi.advanceTimersByTimeAsync(5000);
    await until(() => !a.client.getOnlinePeers().includes("peer-b"));
    expect(signal.peers.has("peer-b")).toBe(false);
    expect(
      b.events.some((event) => event.connection?.signaling === "reconnecting"),
    ).toBe(true);
  });

  it("reconnects and restores committed groups after signaling restarts", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ds01-fault-"));
    folders.push(folder);
    const statePath = join(folder, "signal.json");
    let signal = createSignaling(undefined, undefined, undefined, {
      statePath,
    });
    const signalUrl = await listen(signal),
      port = (signal.httpServer.address() as AddressInfo).port,
      relayUrl = await listen(
        createRelay(undefined, async (id) => signal.groups.get(id) ?? null),
      );
    const a = await peer("peer-a", signalUrl, relayUrl),
      b = await peer("peer-b", signalUrl, relayUrl);
    const group = await a.client.createGroup(["peer-b"]);
    await until(() =>
      b.client.getGroups().some((item) => item.id === group.id),
    );
    await stop(signal);
    await until(() =>
      [a, b].every((item) =>
        item.events.some(
          (event) => event.connection?.signaling === "reconnecting",
        ),
      ),
    );
    signal = createSignaling(undefined, undefined, undefined, { statePath });
    await listen(signal, port);
    await until(
      () =>
        signal.peers.size === 2 &&
        [a, b].every((item) => {
          const state = item.events
            .filter((event) => event.connection)
            .at(-1)?.connection;
          return state?.signaling === "online" && state.relays === 1;
        }),
    );
    expect(signal.groups.get(group.id)).toEqual(group);
    expect(a.client.getGroups()).toContainEqual(group);
    expect(b.client.getGroups()).toContainEqual(group);
    expect(
      await a.client.sendGroup(group.id, "after control-plane recovery"),
    ).toEqual({ "peer-b": "fulfilled" });
    expect(b.store.rows.at(-1)?.message.body).toBe(
      "after control-plane recovery",
    );
  }, 10000);

  it("times out an interrupted file without further traffic, releases capacity and permits a new transfer", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore(),
      events: PeerEvent[] = [],
      receiver = transfer(store, events);
    const packets = await Promise.all(
      Array.from({ length: 4 }, () => filePacket()),
    );
    for (const { packet } of packets) await receiver.receive(packet);
    const overflow = await filePacket();
    await expect(receiver.receive(overflow.packet)).rejects.toThrow(
      "too many concurrent files",
    );
    expect(store.files.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120001);
    for (const { packet } of packets)
      expect(events).toContainEqual(
        expect.objectContaining({
          transfer: expect.objectContaining({
            id: packet.fileChunk!.transferId,
            status: "failed",
          }),
        }),
      );
    expect(store.files.size).toBe(0);
    const fresh = await filePacket(3);
    await receiver.receive(fresh.packet);
    expect(store.files.get(fresh.packet.fileChunk!.transferId)?.data).toEqual(
      fresh.data,
    );
    expect(events.at(-1)?.transfer?.status).toBe("complete");
  });

  it("does not revive a file receive that was awaiting storage when the peer closed", async () => {
    const store = new MemoryStore(),
      events: PeerEvent[] = [],
      receiver = transfer(store, events);
    let unblock!: () => void;
    store.getFile = () =>
      new Promise((resolve) => {
        unblock = () => resolve(undefined);
      });
    const { packet } = await filePacket(3);
    const receiving = receiver.receive(packet);
    receiver.close();
    unblock();
    await expect(receiving).rejects.toThrow("closed");
    expect(store.files.size).toBe(0);
    expect(events.some((event) => event.transfer?.status === "complete")).toBe(
      false,
    );
  });

  it("bounds DIRECT negotiation even when the signaling operation never resolves", async () => {
    class StuckRTC {
      connectionState = "new";
      signalingState = "stable";
      createDataChannel() {
        return { readyState: "connecting" };
      }
      async createOffer() {
        return new Promise<RTCSessionDescriptionInit>(() => {});
      }
      close() {
        this.connectionState = "closed";
      }
    }
    const modes: string[] = [];
    const direct = new DirectTransport({
      peerId: "peer-a",
      rtc: StuckRTC as unknown as PeerConfig["rtc"],
      timeoutMs: 30,
      sendSignal: async () => {},
      onMessage: () => {},
      onMode: (_peerId, mode) => modes.push(mode),
      log: () => {},
    });
    directs.push(direct);
    expect(
      await Promise.race([
        direct.ensure("peer-b", false),
        delay(150).then(() => "still pending"),
      ]),
    ).toBe(false);
    expect(modes).toContain("RELAY");
  });
});

describe("large file boundary", () => {
  it("reassembles the full 20 MiB limit with validated chunk counts and SHA-256", async () => {
    const { packet, data } = await filePacket(MAX_CHAT_ATTACHMENT_BYTES),
      store = new MemoryStore(),
      events: PeerEvent[] = [],
      receiver = transfer(store, events);
    for (let index = 0; index < packet.fileChunk!.total; index++) {
      const chunk = data.subarray(
        index * FILE_CHUNK_BYTES,
        (index + 1) * FILE_CHUNK_BYTES,
      );
      await receiver.receive(
        parseMessage({
          ...packet,
          fileChunk: {
            ...packet.fileChunk,
            index,
            data: btoa(String.fromCharCode(...chunk)),
          },
        }),
      );
    }
    const saved = store.files.get(packet.fileChunk!.transferId)!;
    expect(saved.data.length).toBe(MAX_CHAT_ATTACHMENT_BYTES);
    expect(await fileHash(saved.data)).toBe(await fileHash(data));
    expect(events.at(-1)?.transfer?.status).toBe("complete");
    expect(() =>
      parseMessage({
        ...packet,
        fileChunk: { ...packet.fileChunk, total: packet.fileChunk!.total + 1 },
      }),
    ).toThrow();
  }, 15000);
});
