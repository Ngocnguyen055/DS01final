import { describe, expect, it } from "vitest";
import { PcmPlayout } from "../src/shared/media/audioPlayout.ts";
import {
  groupCallRecord,
  privateCallRecord,
  recoverCallRecords,
} from "../src/web-peer/storage/callHistory.ts";
import { GroupMediaSession } from "../src/shared/media/groupMedia.ts";

function tone(sequence: number) {
  const bytes = new Uint8Array(1280),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < 640; i++)
    view.setInt16(
      i * 2,
      Math.round(
        Math.sin(((sequence * 640 + i) * 2 * Math.PI * 440) / 16000) * 8192,
      ),
      true,
    );
  return bytes;
}
describe("relay voice playout", () => {
  it("plays a continuous tone with packet jitter through a bounded 16kHz to 48kHz buffer", () => {
    const queue = new PcmPlayout(),
      samples: number[] = [];
    let packet = 0;
    for (let time = 0; time < 2000; time += 128 / 48) {
      while (packet < 50 && packet * 40 + [0, 18, -10, 8][packet % 4] <= time) {
        queue.push(tone(packet), packet);
        packet++;
      }
      const block = new Float32Array(128);
      queue.pull(block, 48000);
      samples.push(...block);
      expect(queue.bufferedSamples).toBeLessThan(6400);
    }
    const played = samples.slice(48000 / 5);
    const energy = Math.sqrt(
      played.reduce((sum, value) => sum + value * value, 0) / played.length,
    );
    expect(energy).toBeGreaterThan(0.16);
    expect(energy).toBeLessThan(0.19);
    expect(
      Math.max(
        ...played
          .slice(1)
          .map((value, index) => Math.abs(value - played[index])),
      ),
    ).toBeLessThan(0.04);
  });
  it("deduplicates packets, conceals a missing frame and bounds latency after a long interruption", () => {
    const queue = new PcmPlayout();
    queue.push(tone(0), 0);
    queue.push(tone(1), 1);
    queue.push(tone(2), 2);
    const before = queue.bufferedSamples;
    queue.push(tone(2), 2);
    expect(queue.bufferedSamples).toBe(before);
    queue.push(tone(4), 4);
    expect(queue.bufferedSamples).toBe(before + 1280);
    for (let index = 5; index < 100; index++) queue.push(tone(index), index);
    expect(queue.bufferedSamples).toBeLessThanOrEqual(6400);
    const output = new Float32Array(48000);
    queue.pull(output, 48000);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(Math.abs(output.at(-1)!)).toBeLessThan(0.00001);
  });
});
describe("call history records", () => {
  it("ignores late call updates after membership is revoked and accepts invitations after a valid rejoin", () => {
    let invited = false;
    const session = new GroupMediaSession({
      peerId: "peer-c",
      busy: () => false,
      control: async () => ({}),
      create: () => {
        throw Error("capture must not occur");
      },
      emit: (state) => {
        invited = state?.phase === "incoming";
      },
      log: () => {},
    });
    const groupId = crypto.randomUUID(),
      room = {
        roomId: crypto.randomUUID(),
        groupId,
        kind: "audio",
        startedBy: "peer-a",
        startedAt: 100,
        version: 1,
        participants: ["peer-a"],
        sessions: { "peer-a": crypto.randomUUID() },
        ended: false,
      };
    session.membership({
      id: groupId,
      ownerId: "peer-a",
      members: ["peer-a"],
      version: 2,
    });
    session.update(room);
    expect(invited).toBe(false);
    session.membership({
      id: groupId,
      ownerId: "peer-a",
      members: ["peer-a", "peer-c"],
      version: 3,
    });
    session.update({ ...room, version: 2 });
    expect(invited).toBe(true);
    session.close();
  });
  it("keeps private call direction, actual path and connected duration without media streams", () => {
    const record = privateCallRecord({
      callId: crypto.randomUUID(),
      peerId: "peer-b",
      kind: "audio",
      phase: "ended",
      direction: "outgoing",
      startedAt: 100,
      connectedAt: 200,
      endedAt: 1300,
      route: "RELAY",
    });
    expect(record).toMatchObject({
      outcome: "completed",
      startedAt: 100,
      connectedAt: 200,
      endedAt: 1300,
      route: "RELAY",
    });
    expect(
      privateCallRecord({
        callId: crypto.randomUUID(),
        peerId: "peer-b",
        kind: "video",
        phase: "ended",
        direction: "incoming",
        startedAt: 100,
        endedAt: 300,
      })?.outcome,
    ).toBe("missed");
  });
  it("recovers interrupted calls and keeps group participation IDs stable after membership changes", () => {
    const record = privateCallRecord({
      callId: crypto.randomUUID(),
      peerId: "peer-b",
      kind: "audio",
      phase: "calling",
      direction: "outgoing",
      startedAt: 100,
    })!;
    expect(recoverCallRecords([record], 500)[0]).toMatchObject({
      outcome: "unanswered",
      endedAt: 500,
    });
    expect(
      recoverCallRecords([{ ...record, connectedAt: 200 }], 500)[0].outcome,
    ).toBe("interrupted");
    const state = {
      room: {
        roomId: crypto.randomUUID(),
        groupId: crypto.randomUUID(),
        kind: "video" as const,
        startedBy: "peer-a",
        startedAt: 100,
        version: 2,
        participants: ["peer-a"],
        ended: false,
        sessions: { "peer-a": crypto.randomUUID() },
      },
      phase: "active" as const,
      joinedAt: 300,
      peers: [],
      muted: false,
      cameraOff: false,
    };
    const active = groupCallRecord(state)!;
    expect(
      groupCallRecord({
        ...state,
        phase: "ended",
        endedAt: 900,
        room: { ...state.room, participants: [], sessions: {}, ended: true },
      })?.id,
    ).toBe(active.id);
  });
});
