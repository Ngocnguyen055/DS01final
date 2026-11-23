import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { orderMessages } from "../src/shared/ordering.ts";
import type { StoredMessage } from "../src/shared/peerTypes.ts";
import { chatTimeline } from "../src/web-peer/chatTimeline.ts";
import type { CallRecord } from "../src/web-peer/callHistory.ts";

const sessionId = randomUUID(),
  groupId = randomUUID();
function row(
  sequence: number,
  timestamp: number,
  logicalTime: number,
  senderId = "peer-a",
): StoredMessage {
  return {
    status: "received",
    message: {
      messageId: randomUUID(),
      sessionId,
      groupId,
      senderId,
      receiverId: "peer-c",
      sequence,
      timestamp,
      logicalTime,
      type: "text",
      body: "concurrent message",
      mode: "RELAY",
      attempt: 1,
    },
  };
}
function call(startedAt: number): CallRecord {
  return {
    id: randomUUID(),
    groupId,
    startedAt,
    updatedAt: startedAt,
    kind: "audio",
    direction: "group",
    outcome: "completed",
  };
}
const messageIds = (timeline: ReturnType<typeof chatTimeline>) =>
  timeline.flatMap((entry) =>
    entry.type === "message" ? [entry.bubble.rows[0].message.messageId] : [],
  );

describe("conversation display consistency", () => {
  it("preserves sender sequence through backwards wall clocks even when call history is interleaved", () => {
    const first = row(1, 3000, 10),
      second = row(2, 1000, 11),
      third = row(3, 2000, 12);
    const calls = [call(4000), call(500), call(1500)];
    const bubbles = orderMessages([third, first, second]).map((message) => ({
      rows: [message],
    }));
    const timeline = chatTimeline(bubbles, calls);
    expect(messageIds(timeline)).toEqual(
      [first, second, third].map((row) => row.message.messageId),
    );
    expect(
      timeline
        .filter((entry) => entry.type === "call")
        .map((entry) => entry.call.startedAt),
    ).toEqual([500, 1500, 4000]);
    expect(timeline).toHaveLength(6);
  });
  it("shows the same order for concurrent senders regardless of arrival order and keeps recipient receipts in one bubble", () => {
    const a = row(1, 3000, 10),
      b = row(1, 1000, 10, "peer-b");
    a.message.messageId = "00000000-0000-4000-8000-000000000001";
    b.message.messageId = "00000000-0000-4000-8000-000000000002";
    const ab = chatTimeline(
      orderMessages([a, b]).map((row) => ({ rows: [row] })),
      [],
    );
    const ba = chatTimeline(
      orderMessages([b, a]).map((row) => ({ rows: [row] })),
      [],
    );
    expect(messageIds(ab)).toEqual([a.message.messageId, b.message.messageId]);
    expect(messageIds(ba)).toEqual(messageIds(ab));
    const receipt = { ...a, message: { ...a.message, receiverId: "peer-b" } };
    const fanout = chatTimeline([{ rows: [a, receipt] }, { rows: [b] }], []);
    expect(fanout).toHaveLength(2);
    expect(fanout[0].type === "message" && fanout[0].bubble.rows).toHaveLength(
      2,
    );
  });
});
