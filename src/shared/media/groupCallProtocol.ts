import { z } from "zod";
import { peerIdSchema } from "../protocol.ts";
import type { CallState } from "./media.ts";

export const MAX_GROUP_CALL_PEERS = 8;
export const groupCallContextSchema = z
  .object({ groupId: z.string().uuid(), roomId: z.string().uuid() })
  .strict();
export type GroupCallContext = z.infer<typeof groupCallContextSchema>;
export const groupCallSignalContextSchema = groupCallContextSchema.extend({
  senderSession: z.string().uuid(),
  receiverSession: z.string().uuid(),
});
export type GroupCallSignalContext = z.infer<
  typeof groupCallSignalContextSchema
>;
export const groupCallRoomSchema = z
  .object({
    roomId: z.string().uuid(),
    groupId: z.string().uuid(),
    kind: z.enum(["audio", "video"]),
    startedBy: peerIdSchema,
    startedAt: z.number().int().positive().safe(),
    version: z.number().int().positive().safe(),
    participants: peerIdSchema.array().max(MAX_GROUP_CALL_PEERS),
    ended: z.boolean(),
    sessions: z.record(peerIdSchema, z.string().uuid()),
  })
  .strict()
  .refine(
    (room) =>
      new Set(room.participants).size === room.participants.length &&
      room.ended === (room.participants.length === 0) &&
      Object.keys(room.sessions).length === room.participants.length &&
      room.participants.every((id) => Object.hasOwn(room.sessions, id)),
    "invalid call roster",
  );
export type GroupCallRoom = z.infer<typeof groupCallRoomSchema>;
export const groupCallControlSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      groupId: z.string().uuid(),
      kind: z.enum(["audio", "video"]),
    })
    .strict(),
  z
    .object({
      action: z.enum(["join", "heartbeat"]),
      roomId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("leave"),
      roomId: z.string().uuid(),
      sessionId: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ action: z.literal("list") }).strict(),
]);
export type GroupCallControl = z.infer<typeof groupCallControlSchema>;
export type GroupCallState = {
  room: GroupCallRoom;
  phase: "incoming" | "joining" | "active" | "ended" | "failed";
  joinedAt?: number;
  endedAt?: number;
  local?: MediaStream;
  peers: CallState[];
  error?: string;
  muted: boolean;
  cameraOff: boolean;
};
