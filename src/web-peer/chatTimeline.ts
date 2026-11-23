import type { StoredMessage } from "../shared/peerTypes.ts";
import type { CallRecord } from "./callHistory.ts";

export function chatTimeline<Bubble extends { rows: StoredMessage[] }>(
  bubbles: Bubble[],
  calls: CallRecord[],
) {
  const timeline: (
    | { type: "message"; bubble: Bubble; at: number }
    | { type: "call"; call: CallRecord; at: number }
  )[] = [];
  const orderedCalls = [...calls].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  );
  let index = 0;
  for (const bubble of bubbles) {
    const at = bubble.rows[0].message.timestamp;
    while (index < orderedCalls.length && orderedCalls[index].startedAt <= at) {
      const call = orderedCalls[index++];
      timeline.push({ type: "call", call, at: call.startedAt });
    }
    timeline.push({ type: "message", bubble, at });
  }
  for (const call of orderedCalls.slice(index))
    timeline.push({ type: "call", call, at: call.startedAt });
  return timeline;
}
