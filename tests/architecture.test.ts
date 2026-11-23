import { afterEach, describe, expect, it } from "vitest";
import {
  DirectTransport,
  type SignalKind,
} from "../src/shared/directTransport.ts";
import type { RTCFactory } from "../src/shared/peerTypes.ts";

const transports: DirectTransport[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(
  options: {
    open?: boolean;
    missingRemote?: boolean;
    slowRemote?: boolean;
    slowOffer?: boolean;
  } = {},
) {
  const instances: TestRTC[] = [],
    sent: SignalKind[] = [],
    logs: string[] = [];
  class TestRTC {
    connectionState = "new";
    signalingState = "stable";
    remoteDescription: unknown = null;
    settingRemote = false;
    channel = {
      readyState: "connecting",
      send: () => {},
    } as unknown as RTCDataChannel;
    constructor() {
      instances.push(this);
    }
    createDataChannel() {
      if (options.open)
        setTimeout(() => {
          if (this.connectionState === "closed") return;
          this.connectionState = "connected";
          Object.assign(this.channel, { readyState: "open" });
          this.channel.onopen?.(new Event("open"));
        }, 0);
      return this.channel;
    }
    async createOffer() {
      if (options.slowOffer) await delay(80);
      return { type: "offer", sdp: "test" };
    }
    async createAnswer() {
      return { type: "answer", sdp: "test" };
    }
    async setLocalDescription() {
      if (this.connectionState === "closed") throw Error("closed connection");
    }
    async setRemoteDescription(data: unknown) {
      if (this.connectionState === "closed") throw Error("closed connection");
      if (this.settingRemote) throw Error("overlapping SDP operations");
      this.settingRemote = true;
      if (options.slowRemote) await delay(20);
      this.remoteDescription = data;
      this.settingRemote = false;
    }
    async addIceCandidate() {}
    async getStats() {
      const entries = [
        { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
        {
          id: "pair",
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
        },
        { id: "local", type: "local-candidate", candidateType: "host" },
      ];
      if (!options.missingRemote)
        entries.push({
          id: "remote",
          type: "remote-candidate",
          candidateType: "host",
        });
      return new Map(entries.map((entry) => [entry.id, entry]));
    }
    close() {
      this.connectionState = "closed";
      this.signalingState = "closed";
    }
  }
  const transport = new DirectTransport({
    peerId: "peer-a",
    rtc: TestRTC as unknown as RTCFactory,
    timeoutMs: 150,
    backgroundTimeoutMs: 0,
    sendSignal: async (_to, kind) => {
      sent.push(kind);
    },
    onMessage: () => {},
    onMode: () => {},
    log: (text) => {
      logs.push(text);
    },
  });
  transports.push(transport);
  return { transport, instances, sent, logs };
}

afterEach(() => {
  transports.splice(0).forEach((item) => item.close());
});

describe("direct and relay architecture", () => {
  it("reports failed candidate pairs on timeout without exposing addresses or credentials", async () => {
    const { transport, instances, logs } = fixture();
    const pending = transport.ensure("peer-b", false);
    instances[0].getStats = async () =>
      new Map([
        [
          "local",
          {
            type: "local-candidate",
            candidateType: "host",
            address: "192.168.10.99",
          },
        ],
        [
          "remote",
          {
            type: "remote-candidate",
            candidateType: "srflx",
            address: "203.0.113.111",
          },
        ],
        [
          "pair",
          {
            type: "candidate-pair",
            state: "failed",
            credential: "TEST_SECRET",
          },
        ],
      ]) as unknown as Awaited<ReturnType<(typeof instances)[0]["getStats"]>>;
    expect(await pending).toBe(false);
    const line = logs.find((text) => text.startsWith("DIRECT_DIAGNOSTIC"))!;
    expect(line).toContain("peer=peer-b");
    expect(line).toContain('"local":{"host":1}');
    expect(line).toContain('"remote":{"srflx":1}');
    expect(line).toContain('"pairs":{"failed":1}');
    expect(line).not.toMatch(/192\.168|203\.0\.113|TEST_SECRET/);
    expect(instances[0].connectionState).toBe("closed");
  });
  it("still falls back when browser ICE statistics never resolve", async () => {
    const { transport, instances, logs } = fixture();
    const pending = transport.ensure("peer-b", false);
    instances[0].getStats = () => new Promise(() => {});
    expect(await pending).toBe(false);
    expect(logs.some((text) => text.includes('"stats":false'))).toBe(true);
    expect(instances[0].connectionState).toBe("closed");
  });
  it("ignores a repeated connection request on an open channel and retries explicitly after fallback", async () => {
    const { transport, instances } = fixture({ open: true });
    expect(await transport.ensure("peer-b", false)).toBe(true);
    const requestId = crypto.randomUUID();
    await transport.receiveSignal({
      from: "peer-b",
      kind: "request",
      data: { requestId },
    });
    await delay(10);
    await transport.receiveSignal({
      from: "peer-b",
      kind: "request",
      data: { requestId },
    });
    expect(instances).toHaveLength(2);
    expect(instances[1].connectionState).toBe("connected");
    transport.disconnect("peer-b");
    expect(await transport.ensure("peer-b", false)).toBe(false);
    expect(await transport.retry("peer-b")).toBe(true);
    expect(instances).toHaveLength(3);
  });
  it("tears down an active peer channel and falls back during cooldown without shutting down other peer connections", async () => {
    const { transport, instances } = fixture({ open: true });
    expect(await transport.ensure("peer-b", false)).toBe(true);
    expect(await transport.ensure("peer-c", false)).toBe(true);
    expect(transport.disconnect("peer-b")).toBe(true);
    expect(instances[0].connectionState).toBe("closed");
    expect(await transport.ensure("peer-b", false)).toBe(false);
    expect(instances[1].connectionState).toBe("connected");
    expect(await transport.ensure("peer-c", false)).toBe(true);
    expect(transport.disconnect("peer-missing")).toBe(false);
    transport.close();
    expect(transport.disconnect("peer-c")).toBe(false);
  });
  it("does not claim DIRECT when the selected remote ICE candidate is missing", async () => {
    const { transport, instances } = fixture({
      open: true,
      missingRemote: true,
    });
    expect(await transport.ensure("peer-b", false)).toBe(false);
    expect(instances[0].connectionState).toBe("closed");
  });

  it("accepts an incoming connection request during the local retry cooldown after direct failure", async () => {
    const { transport, instances, sent } = fixture();
    expect(await transport.ensure("peer-b", false)).toBe(false);
    await transport.receiveSignal({
      from: "peer-b",
      kind: "request",
      data: null,
    });
    expect(instances).toHaveLength(2);
    expect(instances[1].connectionState).toBe("new");
    expect(sent).toEqual(["offer", "offer"]);
  });

  it("serializes overlapping signaling operations for the same peer", async () => {
    const { transport, sent } = fixture({ slowRemote: true });
    await Promise.all(
      [1, 2].map((index) =>
        transport.receiveSignal({
          from: "peer-b",
          kind: "offer",
          data: { type: "offer", sdp: `offer ${index}` },
        }),
      ),
    );
    expect(sent).toEqual(["answer", "answer"]);
  });

  it("renegotiates when a restarted peer requests a connection while the old channel still appears open", async () => {
    const { transport, instances, sent } = fixture({ open: true });
    expect(await transport.ensure("peer-b", false)).toBe(true);
    await transport.receiveSignal({
      from: "peer-b",
      kind: "request",
      data: null,
    });
    expect(instances).toHaveLength(2);
    expect(instances[0].connectionState).toBe("closed");
    expect(sent).toEqual(["offer", "offer"]);
  });

  it("does not transmit a late offer after the transport is closed", async () => {
    const { transport, sent } = fixture({ slowOffer: true });
    const opening = transport.ensure("peer-b", false);
    transport.close();
    expect(await opening).toBe(false);
    await delay(100);
    expect(sent).toEqual([]);
    await transport.receiveSignal({
      from: "peer-b",
      kind: "offer",
      data: { type: "offer", sdp: "after close" },
    });
    expect(sent).toEqual([]);
  });
});
