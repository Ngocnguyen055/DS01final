import { describe, expect, it, vi } from "vitest";
import { inspectIceRoute } from "../src/shared/transport/iceRoute.ts";
import { DirectTransport } from "../src/shared/transport/directTransport.ts";
import type { RTCFactory } from "../src/shared/peerTypes.ts";

function stats(localType = "host", remoteType = "srflx") {
  return new Map([
    [
      "transport",
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
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
      { id: "local", type: "local-candidate", candidateType: localType },
    ],
    [
      "remote",
      { id: "remote", type: "remote-candidate", candidateType: remoteType },
    ],
    [
      "unused-turn",
      { id: "unused-turn", type: "local-candidate", candidateType: "relay" },
    ],
  ]);
}

describe("ICE route inspection", () => {
  it.each([
    ["host", "srflx", "DIRECT"],
    ["relay", "host", "TURN"],
    ["host", "relay", "TURN"],
  ])(
    "uses the native selected pair: %s / %s -> %s",
    async (local, remote, mode) => {
      const getStats = vi.fn(() => {
        throw Error("stats unavailable");
      });
      const pc = {
        sctp: {
          transport: {
            iceTransport: {
              getSelectedCandidatePair: () => ({
                local: { type: local },
                remote: { type: remote },
              }),
            },
          },
        },
        getStats,
      } as unknown as RTCPeerConnection;
      expect(await inspectIceRoute(pc, () => true)).toMatchObject({ mode });
      expect(getStats).not.toHaveBeenCalled();
    },
  );

  it("ignores unused TURN candidates when the selected path is direct", async () => {
    const pc = {
      getStats: async () => stats(),
    } as unknown as RTCPeerConnection;
    expect(await inspectIceRoute(pc, () => true)).toMatchObject({
      mode: "DIRECT",
    });
  });

  it("keeps an open DataChannel while browser statistics become available", async () => {
    let rtc!: DelayedRTC;
    class DelayedRTC {
      connectionState = "connected";
      signalingState = "stable";
      channel = {
        readyState: "open",
        send: vi.fn(),
      } as unknown as RTCDataChannel;
      reads = 0;
      constructor() {
        rtc = this;
      }
      createDataChannel() {
        queueMicrotask(() => this.channel.onopen?.(new Event("open")));
        return this.channel;
      }
      async createOffer() {
        return { type: "offer", sdp: "test" };
      }
      async setLocalDescription() {}
      async getStats() {
        return ++this.reads === 1 ? new Map() : stats();
      }
      close() {
        this.connectionState = "closed";
      }
    }
    const transport = new DirectTransport({
      peerId: "peer-a",
      rtc: DelayedRTC as unknown as RTCFactory,
      timeoutMs: 1000,
      sendSignal: async () => {},
      onMessage: () => {},
      onMode: () => {},
      log: () => {},
    });
    try {
      expect(await transport.ensure("peer-b", false)).toBe(true);
      expect(rtc.reads).toBeGreaterThan(1);
      expect(rtc.connectionState).toBe("connected");
      expect(transport.mode("peer-b")).toBe("DIRECT");
    } finally {
      transport.close();
    }
  });

  it("bounds a stalled getStats call without inventing a direct route", async () => {
    const pc = {
      getStats: () => new Promise(() => {}),
    } as unknown as RTCPeerConnection;
    const result = await Promise.race([
      inspectIceRoute(pc, () => true, 30),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 300)),
    ]);
    expect(result).toBeUndefined();
  });

  it("does not publish a stale result after its connection has closed", async () => {
    let active = true;
    const pc = {
      getStats: async () => {
        active = false;
        return stats();
      },
    } as unknown as RTCPeerConnection;
    expect(await inspectIceRoute(pc, () => active)).toBeUndefined();
  });

  it("does not infer DIRECT from incomplete candidate information", async () => {
    const pc = {
      getStats: async () => stats("unknown", "host"),
    } as unknown as RTCPeerConnection;
    expect(await inspectIceRoute(pc, () => true, 30)).toBeUndefined();
  });
});
