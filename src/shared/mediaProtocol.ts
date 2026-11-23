import { z } from "zod";
import { peerIdSchema } from "./protocol.ts";
import { groupCallContextSchema } from "./groupCallProtocol.ts";

export const mediaOpenSchema = z
  .object({
    callId: z.string().uuid(),
    to: peerIdSchema,
    group: groupCallContextSchema.optional(),
  })
  .strict();
export const mediaFrameSchema = z
  .object({
    v: z.literal(1),
    callId: z.string().uuid(),
    senderId: peerIdSchema,
    receiverId: peerIdSchema,
    kind: z.enum(["audio", "video"]),
    sequence: z.number().int().nonnegative().safe(),
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    ciphertext: z
      .string()
      .min(24)
      .max(15000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type MediaFrame = z.infer<typeof mediaFrameSchema>;
export type MediaLink = {
  send: (frame: MediaFrame) => boolean;
  close: () => void;
};
export type MediaCipher = {
  seal: (
    kind: MediaFrame["kind"],
    sequence: number,
    data: Uint8Array,
  ) => Promise<MediaFrame>;
  open: (frame: MediaFrame) => Promise<Uint8Array>;
};
