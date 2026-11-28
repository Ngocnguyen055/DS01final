import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import {
  PeerClient,
  type ChatMessage,
  type PeerConfig,
  type PeerEvent,
} from "../src/shared/index.ts";
import { WebStore } from "../src/web-peer/storage/store.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";

type Service =
  ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [],
  clients: PeerClient[] = [];
async function listen<T extends Service>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const signal = createSignaling(),
    signalUrl = await listen(signal),
    relay = createRelay(),
    relayUrl = await listen(relay);
  const peer = async (peerId: string, ackTimeoutMs = 800) => {
    const store = new WebStore(peerId),
      events: PeerEvent[] = [];
    const client = new PeerClient({
      peerId,
      identityProof: "direct-chat-persistent-identity-proof",
      signalUrl,
      relayUrl,
      forceRelay: true,
      store,
      rtc: class {} as unknown as PeerConfig["rtc"],
      ackTimeoutMs,
      onEvent: (event) => events.push(event),
    });
    clients.push(client);
    await client.connect();
    await until(() => events.some((event) => event.connection?.relays === 1));
    return { client, store, events };
  };
  return { signal, relay, peer };
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  for (const service of services.splice(0).reverse()) await service.close();
  vi.unstubAllGlobals();
});

describe("direct chat and local history", () => {
  it("sends and receives concurrently in both directions with confirmed, ordered and isolated local histories", async () => {
    const { peer } = await fixture(),
      a = await peer("peer-a"),
      b = await peer("peer-b");
    const sends = Array.from({ length: 12 }, (_, index) => [
      a.client.sendDirect("peer-b", `A-${index}`),
      b.client.sendDirect("peer-a", `B-${index}`),
    ]).flat();
    await expect(Promise.all(sends)).resolves.toHaveLength(24);
    const left = await a.store.listDirect("peer-b"),
      right = await b.store.listDirect("peer-a");
    expect(left).toHaveLength(24);
    expect(right).toHaveLength(24);
    expect(new Set(left.map((row) => row.message.messageId)).size).toBe(24);
    for (const [rows, self] of [
      [left, "peer-a"],
      [right, "peer-b"],
    ] as const) {
      expect(
        rows
          .filter((row) => row.message.senderId === self)
          .map((row) => row.status),
      ).toEqual(Array(12).fill("delivered"));
      expect(
        rows
          .filter((row) => row.message.senderId !== self)
          .map((row) => row.status),
      ).toEqual(Array(12).fill("received"));
      for (const sender of ["peer-a", "peer-b"])
        expect(
          rows
            .filter((row) => row.message.senderId === sender)
            .map((row) => row.message.sequence),
        ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    }
    expect(left.map((row) => row.message.messageId)).toEqual(
      right.map((row) => row.message.messageId),
    );
    expect(await new WebStore("peer-a").listDirect("peer-b")).toEqual(left);
    expect(await new WebStore("peer-b").listDirect("peer-a")).toEqual(right);
    expect(await new WebStore("peer-c").list()).toEqual([]);
  });

  it("preserves an unconfirmed message across restart and retries without duplicating receiver history", async () => {
    const { signal, relay, peer } = await fixture();
    let loseAcks = true;
    relay.io.on("connection", (socket) => {
      const forward = socket.listeners("relay:send")[0];
      socket.removeAllListeners("relay:send");
      socket.on(
        "relay:send",
        (packet: ChatMessage, reply: (result: { ok: boolean }) => void) => {
          if (loseAcks && packet.type === "ack") reply({ ok: true });
          else forward(packet, reply);
        },
      );
    });
    const a = await peer("peer-a", 30),
      b = await peer("peer-b", 30);
    await expect(
      a.client.sendDirect("peer-b", "stored at receiver despite lost ACK"),
    ).rejects.toThrow("delivery failed");
    const failed = (await a.store.list())[0];
    expect(failed.status).toBe("failed");
    expect((await b.store.list()).map((row) => row.message.body)).toEqual([
      "stored at receiver despite lost ACK",
    ]);
    a.client.close();
    b.client.close();
    await until(() => signal.peers.size === 0);
    expect((await new WebStore("peer-a").list())[0]).toEqual(failed);
    loseAcks = false;
    const resumedB = await peer("peer-b"),
      resumedA = await peer("peer-a");
    await resumedA.client.retry(failed.message.messageId, "peer-b");
    const final = await resumedA.store.list();
    expect(final).toHaveLength(1);
    expect(final[0].status).toBe("delivered");
    expect(final[0].message).toMatchObject({
      messageId: failed.message.messageId,
      sessionId: failed.message.sessionId,
      timestamp: failed.message.timestamp,
      logicalTime: failed.message.logicalTime,
      sequence: failed.message.sequence,
      body: failed.message.body,
    });
    expect(await resumedB.store.list()).toHaveLength(1);
    expect(
      resumedB.events.some((event) => event.text?.includes(" duplicate")),
    ).toBe(true);
  });
});
