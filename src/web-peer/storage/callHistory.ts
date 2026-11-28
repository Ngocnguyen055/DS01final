import { z } from "zod";
import { peerIdSchema } from "../../shared/protocol.ts";
import type { CallState } from "../../shared/media/media.ts";
import type { GroupCallState } from "../../shared/media/groupCallProtocol.ts";

export const callRecordSchema = z
  .object({
    id: z.string().min(1).max(160),
    peerId: peerIdSchema.optional(),
    groupId: z.string().uuid().optional(),
    kind: z.enum(["audio", "video"]),
    direction: z.enum(["incoming", "outgoing", "group"]),
    startedAt: z.number().int().positive(),
    connectedAt: z.number().int().positive().optional(),
    endedAt: z.number().int().positive().optional(),
    outcome: z.enum([
      "ongoing",
      "completed",
      "missed",
      "unanswered",
      "failed",
      "interrupted",
    ]),
    route: z.enum(["DIRECT", "TURN", "RELAY"]).optional(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => !!value.peerId !== !!value.groupId,
    "one conversation required",
  );
export type CallRecord = z.infer<typeof callRecordSchema>;
export function privateCallRecord(state: CallState): CallRecord | undefined {
  if (!state.startedAt || !state.direction) return;
  const ended = state.phase === "ended" || state.phase === "failed";
  return {
    id: state.callId,
    peerId: state.peerId,
    kind: state.kind,
    direction: state.direction,
    startedAt: state.startedAt,
    connectedAt: state.connectedAt,
    endedAt: state.endedAt,
    route: state.route,
    outcome: !ended
      ? "ongoing"
      : state.connectedAt
        ? "completed"
        : state.direction === "incoming"
          ? "missed"
          : state.phase === "failed"
            ? "failed"
            : "unanswered",
    updatedAt: state.endedAt || state.connectedAt || state.startedAt,
  };
}
export function groupCallRecord(state: GroupCallState): CallRecord | undefined {
  if (!state.joinedAt) return;
  const ended = state.phase === "ended" || state.phase === "failed";
  const routes = state.peers.map((peer) => peer.route);
  return {
    id: state.room.roomId + ":" + state.joinedAt,
    groupId: state.room.groupId,
    kind: state.room.kind,
    direction: "group",
    startedAt: state.joinedAt,
    connectedAt: state.joinedAt,
    endedAt: state.endedAt,
    route: routes.includes("RELAY")
      ? "RELAY"
      : routes.includes("TURN")
        ? "TURN"
        : routes.includes("DIRECT")
          ? "DIRECT"
          : undefined,
    outcome: ended ? "completed" : "ongoing",
    updatedAt: state.endedAt || state.joinedAt,
  };
}
export function recoverCallRecords(
  records: CallRecord[],
  now = Date.now(),
): CallRecord[] {
  return records.map((record) =>
    record.outcome === "ongoing"
      ? {
          ...record,
          endedAt: now,
          updatedAt: now,
          outcome: record.connectedAt
            ? "interrupted"
            : record.direction === "incoming"
              ? "missed"
              : "unanswered",
        }
      : record,
  );
}
