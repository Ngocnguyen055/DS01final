import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";
import {
  PeerClient,
  type ChatAttachment,
  type ChatMessage,
  type ChatStore,
  type StoredMessage,
  type PeerConfig,
} from "../src/shared/index.ts";
import { MessageDelivery } from "../src/shared/messageDelivery.ts";
import { FileTransfer, fileHash } from "../src/shared/fileTransfer.ts";
import { WebStore } from "../src/web-peer/store.ts";
import { DirectTransport } from "../src/shared/directTransport.ts";
class MemoryStore implements ChatStore {
  rows: StoredMessage[] = [];
  files = new Map<
    string,
    {
      file: ChatAttachment;
      data: Uint8Array;
    }
  >();
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
  sockets: Socket[] = [],
  clients: PeerClient[] = [],
  folders: string[] = [];
async function start<T extends Service>(server: T) {
  services.push(server);
  await new Promise<void>((resolve) =>
    server.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
}
async function connect(url: string, auth?: Record<string, string>) {
  const socket = io(url, {
    transports: ["websocket"],
    auth,
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}
async function register(
  url: string,
  id: string,
  proof = "valid-regression-secret-12345",
  name?: string,
) {
  const socket = await connect(url);
  const response = await socket
    .timeout(2000)
    .emitWithAck("peer:register", {
      peerId: id,
      identityProof: proof,
      displayName: name,
    });
  return { socket, response };
}
async function waitFor(predicate: () => boolean, ms = 4000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function removeTestFolder(folder: string) {
  const checked = resolve(folder);
  if (
    dirname(checked) !== resolve(tmpdir()) ||
    !basename(checked).startsWith("ds01-regression-")
  )
    throw Error("Unexpected cleanup path");
  rmSync(checked, { recursive: true, force: true });
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const service of services.splice(0)) await service.close();
  for (const folder of folders.splice(0)) removeTestFolder(folder);
  vi.unstubAllGlobals();
});
function message(sequence = 1): ChatMessage {
  return {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId: "peer-a",
    receiverId: "peer-b",
    type: "text",
    timestamp: 10000,
    body: `message-${sequence}`,
    mode: "RELAY",
    attempt: 1,
    sequence,
  };
}
describe("recovery and adversarial inputs", () => {
  it("does not consume the receiver ACK budget while the transport is still authorizing or forwarding", async () => {
    const store = new MemoryStore();
    let attempts = 0;
    let delivery!: MessageDelivery;
    delivery = new MessageDelivery({
      peerId: "peer-a",
      store,
      ackTimeoutMs: 10,
      getGroup: () => undefined,
      syncProjectGroup: async () => {
        throw Error("unused");
      },
      authorizeGroup: async () => {
        throw Error("unused");
      },
      selectMode: async () => "RELAY",
      emit: () => {},
      log: () => {},
      transport: async (packet) => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        await delivery.receive(
          {
            ...packet,
            type: "ack",
            body: "",
            messageId: randomUUID(),
            senderId: "peer-b",
            receiverId: "peer-a",
            ackFor: packet.messageId,
            ackRequested: false,
          },
          "RELAY",
        );
      },
    });
    await delivery.sendDirect("peer-b", "slow transport, valid ACK");
    expect(attempts).toBe(1);
    expect(store.rows[0].status).toBe("delivered");
    delivery.close();
  });
  it("keeps demo identity and groups across restart and refuses a damaged registry", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ds01-regression-"));
    folders.push(folder);
    const path = join(folder, "state.json");
    let server = createSignaling(undefined, undefined, undefined, {
      statePath: path,
    });
    let url = await start(server);
    const a = await register(url, "peer-a");
    expect(a.response.ok).toBe(true);
    const b = await register(url, "peer-b");
    const c = await register(url, "peer-c");
    const created = await a.socket
      .timeout(2000)
      .emitWithAck("group:create", {
        members: ["peer-b", "peer-c"],
        name: "Nhóm bền vững",
      });
    expect(created.ok).toBe(true);
    const [first, second] = await Promise.all([
      a.socket
        .timeout(2000)
        .emitWithAck("group:change", {
          groupId: created.group.id,
          memberId: "peer-c",
          action: "remove",
          version: 1,
        }),
      b.socket
        .timeout(2000)
        .emitWithAck("group:change", {
          groupId: created.group.id,
          memberId: "peer-b",
          action: "remove",
          version: 1,
        }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const expected = {
      ...created.group,
      version: 2,
      members: first.ok ? ["peer-a", "peer-b"] : ["peer-a", "peer-c"],
    };
    expect(server.groups.get(created.group.id)).toEqual(expected);
    a.socket.disconnect();
    b.socket.disconnect();
    c.socket.disconnect();
    await server.close();
    services.splice(services.indexOf(server), 1);
    server = createSignaling(undefined, undefined, undefined, {
      statePath: path,
    });
    url = await start(server);
    const attacker = await register(
      url,
      "peer-a",
      "another-identity-proof-12345",
    );
    expect(attacker.response.ok).toBe(false);
    const owner = await register(url, "peer-a");
    expect(owner.response.groups).toEqual([expected]);
    expect(server.groups.get(created.group.id)).toEqual(expected);
    writeFileSync(join(folder, "corrupt.json"), "{damaged");
    expect(() =>
      createSignaling(undefined, undefined, undefined, {
        statePath: join(folder, "corrupt.json"),
      }),
    ).toThrow();
  });
  it("survives malformed callbacks on anonymous signaling and authenticated relay sockets", async () => {
    const signal = createSignaling(),
      signalUrl = await start(signal),
      relay = createRelay(),
      relayUrl = await start(relay);
    const anonymous = await connect(signalUrl);
    anonymous.emit("group:create", { members: [] }, "bad");
    anonymous.emit("signal:send", null, {});
    anonymous.emit("group:change", null, 42);
    const a = await register(signalUrl, "peer-a");
    const ar = await connect(relayUrl, { token: a.response.token });
    ar.emit("relay:send", null, "bad");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await fetch(signalUrl + "/health")).ok).toBe(true);
    expect((await fetch(relayUrl + "/health")).ok).toBe(true);
    const b = await register(signalUrl, "peer-b");
    expect(b.response.ok).toBe(true);
    expect(
      (
        await ar
          .timeout(2000)
          .emitWithAck("relay:send", {
            ...message(),
            receiverId: "peer-offline",
          })
      ).error,
    ).toBe("receiver offline");
  });
  it("publishes display names and transfers ownership when the owner leaves", async () => {
    const signal = createSignaling(),
      url = await start(signal);
    const observer = await register(url, "peer-b");
    const profiles: unknown[] = [];
    observer.socket.on("peer:profiles", (value) => profiles.push(value));
    const a = await register(url, "peer-a", undefined, "Minh Anh");
    await waitFor(() => profiles.length > 0);
    expect(profiles.at(-1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: "peer-a", displayName: "Minh Anh" }),
      ]),
    );
    const created = await a.socket
      .timeout(2000)
      .emitWithAck("group:create", { members: ["peer-b"] });
    const changed = await a.socket
      .timeout(2000)
      .emitWithAck("group:change", {
        groupId: created.group.id,
        memberId: "peer-a",
        action: "remove",
        version: 1,
      });
    expect(changed.group.ownerId).toBe("peer-b");
    expect(
      (
        await observer.socket
          .timeout(2000)
          .emitWithAck("group:change", {
            groupId: created.group.id,
            memberId: "peer-c",
            action: "add",
            version: 2,
          })
      ).ok,
    ).toBe(true);
  });
  it("orders equal-clock and out-of-order messages by sender sequence without a cyclic comparator", async () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) || null,
      setItem: (key: string, value: string) => data.set(key, value),
    });
    const store = new WebStore("peer-b");
    const first = {
        ...message(1),
        messageId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      },
      second = {
        ...message(2),
        sessionId: first.sessionId,
        messageId: "00000000-0000-4000-8000-000000000001",
        timestamp: 9000,
      };
    await store.put({ message: second, status: "received" });
    await store.put({ message: first, status: "received" });
    expect(
      (await store.listDirect("peer-a")).map((row) => row.message.sequence),
    ).toEqual([1, 2]);
    await Promise.all(
      ["peer-c", "peer-d", "peer-e"].map((peerId) =>
        store.saveDirectContact({
          peerId,
          name: peerId,
          email: "",
          updatedAt: Date.now(),
        }),
      ),
    );
    expect(await store.listDirectContacts()).toHaveLength(3);
    await store.deleteDirect("peer-a");
    expect(await store.has(first.messageId, "peer-a")).toBe(true);
  });
  it("settles an in-flight send on close and recovers sequence plus interrupted history after restart", async () => {
    const store = new MemoryStore();
    let notified!: () => void;
    const sent = new Promise<void>((resolve) => (notified = resolve));
    const config = {
      peerId: "peer-a",
      store,
      ackTimeoutMs: 100,
      getGroup: () => undefined,
      syncProjectGroup: async () => {
        throw Error("unused");
      },
      authorizeGroup: async () => {
        throw Error("unused");
      },
      selectMode: async () => "RELAY" as const,
      emit: () => {},
      log: () => {},
      transport: async () => {
        notified();
      },
    };
    const delivery = new MessageDelivery(config);
    const sending = delivery.sendDirect("peer-b", "cancel me");
    const rejection = expect(sending).rejects.toThrow("delivery failed");
    await sent;
    delivery.close();
    await rejection;
    expect(store.rows[0].status).toBe("failed");
    store.rows[0].status = "sent";
    let resumed!: MessageDelivery;
    resumed = new MessageDelivery({
      ...config,
      transport: async (packet) => {
        await resumed.receive(
          {
            ...packet,
            type: "ack",
            body: "",
            messageId: randomUUID(),
            senderId: "peer-b",
            receiverId: "peer-a",
            ackFor: packet.messageId,
            ackRequested: false,
          },
          "RELAY",
        );
      },
    });
    await resumed.sendDirect("peer-b", "after restart");
    expect(store.rows.map((row) => row.status)).toEqual([
      "failed",
      "delivered",
    ]);
    expect(store.rows[1].message.sequence).toBe(2);
    expect(store.rows[1].message.sessionId).toBe(
      store.rows[0].message.sessionId,
    );
    resumed.close();
  });
});
describe("advanced delivery", () => {
  it("labels an ICE relay candidate as TURN instead of claiming a direct path", async () => {
    let rtc!: SyntheticRTC;
    class SyntheticRTC {
      connectionState = "connected";
      signalingState = "stable";
      remoteDescription = null;
      channel = {
        readyState: "open",
        send: vi.fn(),
      } as unknown as RTCDataChannel;
      constructor() {
        rtc = this;
      }
      createDataChannel() {
        setTimeout(() => this.channel.onopen?.(new Event("open")), 0);
        return this.channel;
      }
      async createOffer() {
        return { type: "offer", sdp: "synthetic" };
      }
      async setLocalDescription() {}
      async getStats() {
        return new Map([
          [
            "transport",
            {
              id: "transport",
              type: "transport",
              selectedCandidatePairId: "pair",
            },
          ],
          [
            "pair",
            {
              id: "pair",
              type: "candidate-pair",
              state: "succeeded",
              nominated: true,
              localCandidateId: "local",
              remoteCandidateId: "remote",
            },
          ],
          [
            "local",
            { id: "local", type: "local-candidate", candidateType: "relay" },
          ],
          [
            "remote",
            { id: "remote", type: "remote-candidate", candidateType: "host" },
          ],
        ]);
      }
      close() {
        this.connectionState = "closed";
      }
    }
    const received: string[] = [];
    const transport = new DirectTransport({
      peerId: "peer-a",
      rtc: SyntheticRTC as unknown as PeerConfig["rtc"],
      sendSignal: async () => {},
      onMessage: (_raw, _sender, route) => received.push(route),
      onMode: () => {},
      log: () => {},
    });
    expect(await transport.ensure("peer-b", false)).toBe(true);
    expect(transport.mode("peer-b")).toBe("TURN");
    rtc.channel.onmessage?.(new MessageEvent("message", { data: "{}" }));
    await waitFor(() => received.length === 1);
    expect(received).toEqual(["TURN"]);
    transport.close();
  });
  it("fails over to an independent second relay and reassembles a 512 KiB file with an application ACK per chunk", async () => {
    const signal = createSignaling(),
      signalUrl = await start(signal),
      first = createRelay(),
      firstUrl = await start(first),
      second = createRelay(),
      secondUrl = await start(second);
    const stores = [new MemoryStore(), new MemoryStore()],
      counts = [0, 0];
    for (const [index, id] of ["peer-a", "peer-b"].entries()) {
      const client = new PeerClient({
        peerId: id,
        identityProof: "advanced-test-secret-12345",
        signalUrl,
        relayUrl: firstUrl,
        relayUrls: [secondUrl],
        rtc: class {} as unknown as PeerConfig["rtc"],
        store: stores[index],
        forceRelay: true,
        ackTimeoutMs: 1000,
        onEvent: (event) => {
          if (event.connection) counts[index] = event.connection.relays;
        },
      });
      clients.push(client);
      await client.connect();
    }
    await waitFor(() => counts.every((count) => count === 2));
    await first.close();
    services.splice(services.indexOf(first), 1);
    await waitFor(() => counts.every((count) => count === 1));
    await clients[0].sendDirect("peer-b", "delivered after relay failure");
    expect(stores[1].rows[0].message.body).toBe(
      "delivered after relay failure",
    );
    const data = Uint8Array.from(
      { length: 512 * 1024 },
      (_, index) => index % 251,
    );
    await clients[0].sendFile(
      "peer-b",
      "sample.bin",
      "application/octet-stream",
      data,
    );
    expect(stores[1].files.size).toBe(1);
    const saved = [...stores[1].files.values()][0];
    expect(saved.data).toEqual(data);
    expect(saved.file.sha256).toBe(await fileHash(data));
    expect(
      stores[1].rows.filter((row) => row.message.type === "attachment"),
    ).toHaveLength(1);
    expect(
      stores[1].rows.some((row) => row.message.type === "file-chunk"),
    ).toBe(false);
    expect(stores[0].rows.at(-1)?.status).toBe("delivered");
  }, 15000);
  it("rejects corrupt file bytes before storage and never marks integrity failures complete", async () => {
    const store = new MemoryStore(),
      events: unknown[] = [];
    const transfer = new FileTransfer({
      store,
      sendChunk: async () => {},
      sendAttachment: async () => {},
      emit: (event) => events.push(event),
    });
    const transferId = randomUUID();
    const data = new Uint8Array([1, 2, 3]);
    const file = {
      id: transferId,
      name: "integrity.bin",
      mime: "application/octet-stream",
      size: 3,
      sha256: await fileHash(data),
    };
    const bad = {
      ...message(),
      type: "file-chunk" as const,
      body: "",
      fileChunk: {
        transferId,
        index: 0,
        total: 1,
        data: btoa(String.fromCharCode(9, 2, 3)),
        file,
      },
    };
    await expect(transfer.receive(bad)).rejects.toThrow("SHA-256 mismatch");
    await expect(transfer.receive(bad)).rejects.toThrow(
      "file integrity failed",
    );
    expect(store.files.size).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        transfer: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});
