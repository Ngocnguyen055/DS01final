import "dotenv/config";
import { io, type Socket } from "socket.io-client";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChatMessage } from "../src/shared/protocol.ts";

const signalUrl = process.env.PUBLIC_SIGNAL_URL || "http://localhost:4001";
const relayUrl = process.env.PUBLIC_RELAY_URL || "http://localhost:4002";
const suffix = randomUUID().slice(0, 8);
const peers = [`bench-a-${suffix}`, `bench-b-${suffix}`];
const sockets: Socket[] = [];
async function connect(url: string, auth?: { token: string }) {
  const socket = io(url, { autoConnect: false, reconnection: false, auth });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`connection timeout: ${new URL(url).host}`)),
      5000,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
  });
  return socket;
}
async function register(peerId: string) {
  const signal = await connect(signalUrl);
  const registered = await signal.timeout(4000).emitWithAck("peer:register", {
    peerId,
    identityProof: randomUUID() + randomUUID(),
  });
  if (!registered.ok || !registered.token)
    throw new Error(registered.error || "registration failed");
  const relay = await connect(relayUrl, { token: registered.token });
  return { signal, relay };
}
try {
  const [a, b] = await Promise.all(peers.map(register));
  const sessionId = randomUUID();
  const pending = new Map<
    string,
    {
      message: ChatMessage;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();
  b.relay.on("relay:receive", (message: ChatMessage | null) => {
    const expected = message && pending.get(message.messageId);
    if (!expected) return;
    if (!isDeepStrictEqual(message, expected.message))
      expected.reject(new Error("relay changed the envelope"));
    else expected.resolve();
  });
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const messageId = randomUUID();
    const message: ChatMessage = {
      messageId,
      sessionId,
      senderId: peers[0],
      receiverId: peers[1],
      type: "text",
      timestamp: Date.now(),
      body: `benchmark ${i}`,
      mode: "RELAY",
      ackRequested: true,
      attempt: 1,
      sequence: i + 1,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delivered = new Promise<void>((resolve, reject) => {
      pending.set(messageId, { message, resolve, reject });
      timer = setTimeout(() => reject(new Error("delivery timeout")), 4000);
    });
    void delivered.catch(() => {});
    const start = performance.now();
    try {
      const result = await a.relay
        .timeout(4000)
        .emitWithAck("relay:send", message);
      if (!result.ok) throw new Error(result.error);
      await delivered;
      times.push(performance.now() - start);
    } finally {
      clearTimeout(timer);
      pending.delete(messageId);
    }
  }
  times.sort((x, y) => x - y);
  console.log(
    JSON.stringify(
      {
        scope:
          "Sequential relay envelope reception; not application ACK, browser persistence or WAN latency",
        count: times.length,
        p50_ms: times[49],
        p95_ms: times[94],
        max_ms: times[99],
        measuredAt: new Date().toISOString(),
        signalUrl,
        relayUrl,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `Relay benchmark failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.disconnect();
}
