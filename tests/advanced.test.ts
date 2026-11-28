import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { io, type Socket } from "socket.io-client";
import {
  PeerClient,
  type ChatStore,
  type StoredMessage,
  type ChatMessage,
  type PeerConfig,
  type ChatAttachment,
  type PeerEvent,
} from "../src/shared/index.ts";
import {
  createIdentity,
  signIdentity,
  SecureChannel,
  type IdentityStore,
  type DeviceIdentity,
  type PublicIdentity,
} from "../src/shared/secure.ts";
import {
  createOverlayRecord,
  decentralizedPeerId,
  verifyOverlayRecord,
} from "../src/shared/overlayProtocol.ts";
import { RelayJournal } from "../src/relay/journal.ts";
import { RelaySelector } from "../src/shared/transport/relaySelection.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";
import { MessageDelivery } from "../src/shared/chat/messageDelivery.ts";
import { isPublicAddress } from "../src/server-kit/publicAddress.ts";
import { MediaSession, type CallState } from "../src/shared/media/media.ts";

class Store implements ChatStore, IdentityStore {
  rows: StoredMessage[] = [];
  identity?: DeviceIdentity;
  pins = new Map<string, PublicIdentity>();
  files = new Map<string, { file: ChatAttachment; data: Uint8Array }>();
  async put(row: StoredMessage) {
    const i = this.rows.findIndex(
      (x) =>
        x.message.messageId === row.message.messageId &&
        x.message.receiverId === row.message.receiverId &&
        x.message.senderId === row.message.senderId,
    );
    if (i < 0) this.rows.push(row);
    else this.rows[i] = row;
  }
  async mark(id: string, receiver: string, status: StoredMessage["status"]) {
    for (const row of this.rows)
      if (row.message.messageId === id && row.message.receiverId === receiver)
        row.status = status;
  }
  async has(id: string, sender: string) {
    return this.rows.some(
      (x) => x.message.messageId === id && x.message.senderId === sender,
    );
  }
  async list() {
    return this.rows;
  }
  async getIdentity() {
    return this.identity;
  }
  async putIdentity(value: DeviceIdentity) {
    this.identity = value;
  }
  async getPin(id: string) {
    return this.pins.get(id);
  }
  async putPin(id: string, value: PublicIdentity) {
    this.pins.set(id, value);
  }
  async putFile(file: ChatAttachment, data: Uint8Array) {
    this.files.set(file.id, { file, data: new Uint8Array(data) });
  }
  async getFile(id: string) {
    return this.files.get(id);
  }
}
const peers: PeerClient[] = [],
  services: { close: () => Promise<void> }[] = [],
  sockets: Socket[] = [],
  folders: string[] = [];
async function start<
  T extends {
    httpServer: ReturnType<typeof createServer>;
    close: () => Promise<void>;
  },
>(service: T) {
  services.push(service);
  await new Promise<void>((r) => service.httpServer.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function stop(service: { close: () => Promise<void> }) {
  await service.close();
  services.splice(services.indexOf(service), 1);
}
async function wait(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("advanced condition timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function connect(url: string, auth?: Record<string, unknown>) {
  const socket = io(url, {
    auth,
    transports: ["websocket"],
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((r, j) => {
    socket.once("connect", r);
    socket.once("connect_error", j);
  });
  return socket;
}
function folder() {
  const path = mkdtempSync(join(tmpdir(), "ds01-advanced-"));
  folders.push(path);
  return path;
}
function message(): ChatMessage {
  return {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId: "peer-a",
    receiverId: "peer-b",
    type: "text",
    body: "private nội dung 123",
    timestamp: Date.now(),
    sequence: 1,
    mode: "RELAY",
    attempt: 1,
  };
}
function makePeer(
  id: string,
  store: Store,
  signalUrl: string,
  relayUrl: string,
  options: Partial<PeerConfig> = {},
) {
  const events: PeerEvent[] = [];
  const peer = new PeerClient({
    peerId: id,
    identityProof: "advanced-proof-" + id,
    signalUrl,
    relayUrl,
    rtc: class {} as unknown as PeerConfig["rtc"],
    forceRelay: true,
    encryption: true,
    identityStore: store,
    store,
    ackTimeoutMs: 500,
    requestTimeoutMs: 1500,
    onEvent: (e) => events.push(e),
    ...options,
  });
  peers.push(peer);
  return { peer, events };
}
afterEach(async () => {
  peers.splice(0).forEach((p) => p.close());
  sockets.splice(0).forEach((s) => s.disconnect());
  for (const service of services.splice(0).reverse()) await service.close();
  for (const path of folders.splice(0)) {
    const checked = resolve(path);
    if (
      dirname(checked) !== resolve(tmpdir()) ||
      !basename(checked).startsWith("ds01-advanced-")
    )
      throw Error("invalid cleanup path");
    rmSync(checked, { recursive: true, force: true });
  }
});

describe("advanced encryption and replica consistency", () => {
  it("accepts ordinary globally routed IP addresses for candidate checks", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"])
      expect(isPublicAddress(address)).toBe(true);
  });
  it("keeps an incoming call stable on duplicate offers and rejects a different busy caller without capturing media", async () => {
    const states: CallState[] = [],
      sent: { action: string; callId: string }[] = [];
    const media = new MediaSession({
      rtc: class {} as unknown as PeerConfig["rtc"],
      emit: (state) => states.push(state),
      send: async (_to, data) => {
        sent.push(data);
      },
      log: () => {},
      devices: {
        getUserMedia: async () => {
          throw Error("incoming call must not capture before acceptance");
        },
      },
    });
    try {
      const offer = {
        action: "offer",
        callId: randomUUID(),
        kind: "audio",
        sdp: "prototype-sdp",
      };
      await media.receive("peer-b", offer);
      await media.receive("peer-b", offer);
      expect(states.at(-1)).toMatchObject({
        phase: "incoming",
        peerId: "peer-b",
      });
      expect(sent).toHaveLength(0);
      const another = { ...offer, callId: randomUUID() };
      await media.receive("peer-c", another);
      expect(sent).toEqual([{ action: "reject", callId: another.callId }]);
      expect(states.at(-1)?.local).toBeUndefined();
    } finally {
      media.close();
    }
  });
  it.each([
    "127.0.0.1",
    "10.20.30.40",
    "172.16.8.9",
    "192.168.1.2",
    "169.254.1.1",
    "100.64.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])(
    "does not treat a private, loopback or link-local candidate as public: %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
  it("reports an expired offline mailbox as unconfirmed and still accepts a later valid receiver ACK", async () => {
    const store = new Store(),
      logs: string[] = [];
    const delivery = new MessageDelivery({
      peerId: "peer-a",
      store,
      getGroup: () => undefined,
      syncProjectGroup: async () => {
        throw Error("unused");
      },
      authorizeGroup: async () => {
        throw Error("unused");
      },
      selectMode: async () => "RELAY",
      transport: async () => ({ queued: true, expiresAt: Date.now() + 40 }),
      emit: () => {},
      log: (value) => logs.push(value),
    });
    try {
      await delivery.sendDirect("peer-b", "bounded offline mail");
      expect(store.rows[0].status).toBe("queued");
      await wait(() => store.rows[0].status === "failed");
      expect(logs.some((x) => x.includes("DELIVERY_ERROR"))).toBe(true);
      const original = store.rows[0].message;
      await delivery.receive(
        {
          ...original,
          messageId: randomUUID(),
          senderId: "peer-b",
          receiverId: "peer-a",
          type: "ack",
          body: "",
          ackFor: original.messageId,
          ackRequested: false,
        },
        "RELAY",
      );
      expect(store.rows[0].status).toBe("delivered");
    } finally {
      delivery.close();
    }
  });
  it("encrypts text and authenticates metadata, ciphertext, recipient and persistent identity pins", async () => {
    const a = new Store(),
      b = new Store();
    a.identity = await createIdentity();
    b.identity = await createIdentity();
    const alice = new SecureChannel(
        "peer-a",
        async () => b.identity!.public,
        a,
      ),
      bob = new SecureChannel("peer-b", async () => a.identity!.public, b);
    const original = message(),
      wire = await alice.seal(original);
    expect(JSON.stringify(wire)).not.toContain(original.body);
    expect(await bob.open(wire)).toMatchObject(original);
    const retry = await alice.seal({ ...original, attempt: 2 });
    expect(retry.eventTag).toBe(wire.eventTag);
    expect(retry.iv).not.toBe(wire.iv);
    await expect(bob.open({ ...wire, sequence: 2 })).rejects.toThrow();
    await expect(
      bob.open({
        ...wire,
        ciphertext:
          (wire.ciphertext[0] === "A" ? "B" : "A") + wire.ciphertext.slice(1),
      }),
    ).rejects.toThrow();
    await expect(bob.open({ ...wire, receiverId: "peer-c" })).rejects.toThrow();
    const impostor = await createIdentity(),
      restarted = new SecureChannel("peer-b", async () => impostor.public, b);
    await expect(restarted.open(wire)).rejects.toThrow("security key changed");
    expect(a.identity.encryptionPrivate.extractable).toBe(false);
  });
  it("converges concurrent queue writes and deletion regardless of replica merge order", () => {
    const a = new RelayJournal("node-a"),
      b = new RelayJournal("node-b"),
      c = new RelayJournal("node-c"),
      packet = message();
    a.enqueue(packet);
    b.enqueue({ ...packet, attempt: 2 });
    b.acknowledge(packet.senderId, packet.messageId, packet.receiverId);
    c.merge([...b.entries.values()]);
    c.merge([...a.entries.values()]);
    a.merge([...b.entries.values()]);
    b.merge([...a.entries.values()]);
    expect([a, b, c].map((x) => x.pending().length)).toEqual([0, 0, 0]);
    expect([...a.entries.values()]).toEqual([...b.entries.values()]);
  });
  it("persists mailbox state, rejects conflicting IDs and enforces capacity and TTL", () => {
    const path = join(folder(), "relay.json"),
      journal = new RelayJournal("node-a", path, 1),
      packet = message();
    journal.enqueue(packet, 1000);
    expect(new RelayJournal("node-a", path).pending()).toHaveLength(1);
    expect(() => journal.enqueue({ ...packet, body: "changed" })).toThrow(
      "conflicting",
    );
    expect(() => journal.enqueue(message())).toThrow("mailbox full");
    const expired = new RelayJournal("expiry");
    expired.enqueue(packet, -1);
    expired.prune();
    expect(expired.pending()).toHaveLength(0);
  });
  it("selects using RTT, connection load and queue load with hysteresis and stale-sample expiry", () => {
    const selector = new RelaySelector();
    selector.update("slow", 150, 10, 0);
    selector.update("fast", 5, 10, 0);
    expect(selector.rank(["slow", "fast"])[0]).toBe("fast");
    selector.update("fast", 5, 1000, 100);
    expect(selector.rank(["slow", "fast"])[0]).toBe("slow");
    for (const sample of selector.samples.values()) sample.sampledAt -= 60000;
    expect(selector.rank(["slow", "fast"])).toEqual(["slow", "fast"]);
  });
  it("rejects unsigned, forged and expired self-certifying DHT records", async () => {
    const identity = await createIdentity(),
      record = await createOverlayRecord(identity, "Alice", [
        "http://127.0.0.1:4002",
      ]);
    expect((await verifyOverlayRecord(record)).peerId).toBe(
      await decentralizedPeerId(identity),
    );
    await expect(
      verifyOverlayRecord({ ...record, displayName: "Impostor" }),
    ).rejects.toThrow();
    await expect(
      verifyOverlayRecord({ ...record, peerId: "peer-other" }),
    ).rejects.toThrow();
    await expect(
      verifyOverlayRecord(
        await createOverlayRecord(identity, "Alice", record.relayUrls, -1),
      ),
    ).rejects.toThrow();
  });
});

describe("advanced features over real HTTP and Socket.IO", () => {
  it("retains self-certified keys for offline decryption while rejecting expired leases and connection-proof replay", async () => {
    const relay = createRelay(),
      url = await start(relay),
      identity = await createIdentity();
    const record = await createOverlayRecord(
      identity,
      "short lease",
      [url],
      300,
    );
    const proof = {
      peerId: record.peerId,
      connectionId: "actual-engine-connection",
      issuedAt: Date.now(),
    };
    const auth = {
      record,
      proof: {
        connectionId: proof.connectionId,
        issuedAt: proof.issuedAt,
        signature: await signIdentity(identity, proof),
      },
    };
    await expect(
      relay.cluster.authenticate(auth, "other-engine-connection"),
    ).rejects.toThrow("possession proof");
    expect(
      (await relay.cluster.authenticate(auth, proof.connectionId)).peerId,
    ).toBe(record.peerId);
    await new Promise((r) => setTimeout(r, 350));
    expect(await relay.cluster.lookup(record.peerId)).toBeUndefined();
    expect((await relay.cluster.lookup(record.peerId, true))?.identity).toEqual(
      identity.public,
    );
    await expect(
      relay.cluster.authenticate(auth, proof.connectionId),
    ).rejects.toThrow("decentralized peer identity");
  });
  it("converges concurrent candidate offers across replicas and elects the remaining candidate after leader expiry", async () => {
    const servers = [createServer(), createServer()];
    for (const server of servers)
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const urls = servers.map(
      (s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    );
    const a = createRelay(servers[0], undefined, undefined, {
      ownerPeerId: "peer-a",
      publicUrl: urls[0],
      clusterUrls: urls,
      allowLocalElection: true,
      candidateLeaseMs: 2000,
      clusterIntervalMs: 60000,
    });
    const b = createRelay(servers[1], undefined, undefined, {
      ownerPeerId: "peer-b",
      publicUrl: urls[1],
      clusterUrls: urls,
      allowLocalElection: true,
      candidateLeaseMs: 150,
      clusterIntervalMs: 60000,
    });
    services.push(a, b);
    await Promise.all([
      a.cluster.offer("peer-a", urls[0]),
      b.cluster.offer("peer-b", urls[1]),
    ]);
    await Promise.all([a.cluster.synchronize(), b.cluster.synchronize()]);
    expect([a, b].map((x) => x.cluster.journal.leader()?.peerId)).toEqual([
      "peer-b",
      "peer-b",
    ]);
    await new Promise((r) => setTimeout(r, 170));
    expect([a, b].map((x) => x.cluster.journal.leader()?.peerId)).toEqual([
      "peer-a",
      "peer-a",
    ]);
  });
  it("exchanges simultaneous encrypted group messages and encrypted files without exposing plaintext to the relay", async () => {
    const signal = createSignaling(),
      signalUrl = await start(signal),
      relay = createRelay(
        undefined,
        async (id) => signal.groups.get(id) || null,
      ),
      relayUrl = await start(relay);
    const stores = [new Store(), new Store(), new Store()],
      members = ["peer-a", "peer-b", "peer-c"].map((id, i) =>
        makePeer(id, stores[i], signalUrl, relayUrl),
      );
    for (const { peer } of members) await peer.connect();
    await wait(() => relay.connections.size === 3);
    const seen: unknown[] = [];
    for (const socket of relay.connections.values())
      socket.onAny((event, data) => {
        if (event === "relay:send") seen.push(data);
      });
    const group = await members[0].peer.createGroup(["peer-b", "peer-c"]);
    await wait(() =>
      members.every((x) => x.peer.getGroups().some((g) => g.id === group.id)),
    );
    await Promise.all([
      members[0].peer.sendGroup(group.id, "secret-group-A"),
      members[1].peer.sendGroup(group.id, "secret-group-B"),
    ]);
    await wait(
      () => stores[2].rows.filter((x) => x.status === "received").length === 2,
    );
    expect(new Set(stores[2].rows.map((x) => x.message.body))).toEqual(
      new Set(["secret-group-A", "secret-group-B"]),
    );
    const bytes = new TextEncoder().encode("classified file ".repeat(500));
    await members[0].peer.sendFile(
      "peer-b",
      "private.txt",
      "text/plain",
      bytes,
    );
    expect([...stores[1].files.values()][0]?.data).toEqual(bytes);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((x) => (x as { type: string }).type === "sealed")).toBe(
      true,
    );
    expect(JSON.stringify(seen)).not.toContain("secret-group");
    expect(JSON.stringify(seen)).not.toContain("classified file");
    expect(stores[0].rows.filter((x) => x.status === "failed")).toHaveLength(0);
  });
  it("sends an encrypted group file larger than 512 KiB with per-recipient ACKs and rejects removed members", async () => {
    const signal = createSignaling(),
      signalUrl = await start(signal),
      relay = createRelay(
        undefined,
        async (id) => signal.groups.get(id) || null,
      ),
      relayUrl = await start(relay);
    const stores = [new Store(), new Store(), new Store()],
      members = ["peer-a", "peer-b", "peer-c"].map((id, i) =>
        makePeer(id, stores[i], signalUrl, relayUrl),
      );
    for (const { peer } of members) await peer.connect();
    const group = await members[0].peer.createGroup(["peer-b", "peer-c"]);
    await wait(() =>
      members.every((member) =>
        member.peer.getGroups().some((value) => value.id === group.id),
      ),
    );
    const bytes = Uint8Array.from(
      { length: 600 * 1024 },
      (_, index) => index % 251,
    );
    await members[0].peer.sendGroupFile(
      group.id,
      "group.bin",
      "application/octet-stream",
      bytes,
    );
    const sent = stores[0].rows.filter(
      (row) => row.message.type === "attachment",
    );
    expect(sent).toHaveLength(2);
    expect(
      sent.every(
        (row) => row.status === "delivered" && row.message.groupId === group.id,
      ),
    ).toBe(true);
    expect(new Set(sent.map((row) => row.message.messageId)).size).toBe(1);
    for (const store of stores.slice(1)) {
      const rows = store.rows.filter(
        (row) => row.message.type === "attachment",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].message.groupId).toBe(group.id);
      expect(store.files.get(rows[0].message.attachments![0].id)?.data).toEqual(
        bytes,
      );
      expect(store.rows.some((row) => row.message.type === "file-chunk")).toBe(
        false,
      );
    }
    await members[0].peer.changeGroup(group.id, "peer-c", "remove");
    await expect(
      members[2].peer.sendGroupFile(
        group.id,
        "denied.bin",
        "application/octet-stream",
        new Uint8Array([1]),
      ),
    ).rejects.toThrow();
    await expect(
      members[0].peer.sendGroupFile(
        group.id,
        "oversize.bin",
        "application/octet-stream",
        new Uint8Array(20 * 1024 * 1024 + 1),
      ),
    ).rejects.toThrow("20 MiB");
  }, 40000);
  it("replicates encrypted offline mail and ACKs across relay failure and sender restart", async () => {
    const path = folder(),
      signal = createSignaling(),
      signalUrl = await start(signal);
    const relayA = createRelay(undefined, undefined, undefined, {
      statePath: join(path, "a.json"),
      offlineQueue: true,
      clusterIntervalMs: 60000,
    });
    const urlA = await start(relayA);
    const relayB = createRelay(undefined, undefined, undefined, {
        statePath: join(path, "b.json"),
        offlineQueue: true,
        clusterUrls: [urlA],
        clusterIntervalMs: 60000,
      }),
      urlB = await start(relayB);
    const a = new Store(),
      b = new Store();
    const alice = makePeer("peer-a", a, signalUrl, urlA),
      bob = makePeer("peer-b", b, signalUrl, urlA);
    await alice.peer.connect();
    await bob.peer.connect();
    await wait(() => relayA.connections.size === 2);
    bob.peer.close();
    await wait(() => !relayA.connections.has("peer-b"));
    await alice.peer.send("peer-b", "offline-secret");
    expect(a.rows[0].status).toBe("queued");
    alice.peer.close();
    await relayB.cluster.synchronize();
    expect(relayB.cluster.journal.pending()).toHaveLength(1);
    expect(readFileSync(join(path, "b.json"), "utf8")).not.toContain(
      "offline-secret",
    );
    await stop(relayA);
    const bobRestored = makePeer("peer-b", b, signalUrl, urlB);
    await bobRestored.peer.connect();
    await wait(() =>
      b.rows.some(
        (x) => x.message.body === "offline-secret" && x.status === "received",
      ),
    );
    await wait(() =>
      relayB.cluster.journal
        .pending()
        .some((x) => (x.value as { traffic: string }).traffic === "ack"),
    );
    const aliceRestored = makePeer("peer-a", a, signalUrl, urlB);
    await aliceRestored.peer.connect();
    await wait(() => a.rows[0].status === "delivered");
    expect(
      b.rows.filter((x) => x.message.body === "offline-secret"),
    ).toHaveLength(1);
    await wait(() => relayB.cluster.journal.pending().length === 0);
  }, 15000);
  it("discovers and chats using a distributed hash ring with no signaling server, including owner failure", async () => {
    const a = new Store(),
      b = new Store();
    a.identity = await createIdentity();
    b.identity = await createIdentity();
    const aid = await decentralizedPeerId(a.identity),
      bid = await decentralizedPeerId(b.identity);
    const serverA = createServer(),
      serverB = createServer();
    await new Promise<void>((r) => serverA.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => serverB.listen(0, "127.0.0.1", r));
    const urls = [serverA, serverB].map(
      (s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    );
    const ra = createRelay(serverA, undefined, undefined, {
        offlineQueue: true,
        publicUrl: urls[0],
        clusterUrls: urls,
      }),
      rb = createRelay(serverB, undefined, undefined, {
        offlineQueue: true,
        publicUrl: urls[1],
        clusterUrls: urls,
      });
    services.push(ra, rb);
    const alice = makePeer(aid, a, "http://127.0.0.1:1", urls[0], {
      discovery: "dht",
      relayUrls: [urls[1]],
    });
    const bob = makePeer(bid, b, "http://127.0.0.1:1", urls[1], {
      discovery: "dht",
      relayUrls: [urls[0]],
    });
    await alice.peer.connect();
    await bob.peer.connect();
    expect((await ra.cluster.lookup(bid))?.identity).toEqual(b.identity.public);
    await alice.peer.send(bid, "DHT secret");
    await wait(() => b.rows.some((x) => x.message.body === "DHT secret"));
    await stop(ra);
    expect((await rb.cluster.lookup(aid))?.peerId).toBe(aid);
    await bob.peer.send(aid, "after DHT owner failure");
    await wait(() =>
      a.rows.some((x) => x.message.body === "after DHT owner failure"),
    );
  }, 15000);
  it("requires cluster authentication and rejects replay and arbitrary member URLs", async () => {
    const relay = createRelay(),
      url = await start(relay);
    expect(
      (
        await fetch(url + "/cluster/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const body = JSON.stringify({ action: "state" }),
      time = String(Date.now()),
      nonce = randomUUID();
    const mac = createHmac("sha256", process.env.PEER_SECRET!)
      .update(`${time}\n${nonce}\n${body}`)
      .digest("hex");
    const options = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ds01-time": time,
        "x-ds01-nonce": nonce,
        "x-ds01-mac": mac,
      },
      body,
    };
    expect((await fetch(url + "/cluster/rpc", options)).status).toBe(200);
    expect((await fetch(url + "/cluster/rpc", options)).status).toBe(403);
    await expect(
      relay.cluster.request("http://127.0.0.1:1", { action: "state" }),
    ).rejects.toThrow("untrusted");
  });
  it("elects only a reachable companion relay owned by the candidate and expires its lease", async () => {
    const relay = createRelay(undefined, undefined, undefined, {
      ownerPeerId: "peer-b",
      allowLocalElection: true,
      candidateLeaseMs: 100,
    });
    const url = await start(relay);
    await expect(relay.cluster.offer("peer-a", url)).rejects.toThrow(
      "does not belong",
    );
    expect((await relay.cluster.offer("peer-b", url))?.peerId).toBe("peer-b");
    await new Promise((r) => setTimeout(r, 130));
    expect(relay.cluster.journal.leader()).toBeUndefined();
    const strict = createRelay(undefined, undefined, undefined, {
        ownerPeerId: "peer-b",
      }),
      strictUrl = await start(strict);
    await expect(strict.cluster.offer("peer-b", strictUrl)).rejects.toThrow(
      "publicly reachable",
    );
  });
  it("does not let an authenticated peer replace another device public key", async () => {
    const signal = createSignaling(),
      url = await start(signal),
      socket = await connect(url);
    expect(
      (
        await socket
          .timeout(2000)
          .emitWithAck("peer:register", {
            peerId: "constructor",
            identityProof: "a-long-valid-proof-1234",
          })
      ).ok,
    ).toBe(true);
    const first = await createIdentity(),
      second = await createIdentity();
    expect(
      (await socket.timeout(2000).emitWithAck("key:publish", first.public)).ok,
    ).toBe(true);
    expect(
      (await socket.timeout(2000).emitWithAck("key:publish", second.public)).ok,
    ).toBe(false);
    expect(
      (await socket.timeout(2000).emitWithAck("key:lookup", "constructor")).key,
    ).toEqual(first.public);
  });
});
