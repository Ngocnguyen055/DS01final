import { z } from "zod";
export const peerIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/);
export const idSchema = z.string().uuid();
export const MAX_CHAT_ATTACHMENTS = 3;
export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 2304;
const MAX_FILE_CHUNKS = Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / FILE_CHUNK_BYTES);
export const MAX_DELIVERY_ATTEMPTS = 3;
export const chatAttachmentSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((name) => !/[\\/\u0000-\u001f]/.test(name), "invalid file name"),
    mime: z.string().trim().min(1).max(120),
    size: z.number().int().positive().max(MAX_CHAT_ATTACHMENT_BYTES),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
export const fileChunkSchema = z
  .object({
    transferId: idSchema,
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_FILE_CHUNKS - 1),
    total: z.number().int().min(1).max(MAX_FILE_CHUNKS),
    data: z
      .string()
      .min(1)
      .max(3072)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    file: chatAttachmentSchema.extend({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  })
  .strict()
  .refine(
    (chunk) => chunk.index < chunk.total && chunk.file.id === chunk.transferId,
    "invalid file chunk",
  );
export type FileChunk = z.infer<typeof fileChunkSchema>;
export const messageSchema = z
  .object({
    messageId: idSchema,
    sessionId: idSchema,
    senderId: peerIdSchema,
    receiverId: peerIdSchema,
    groupId: idSchema.nullish(),
    type: z.enum(["text", "attachment", "ack", "file-chunk"]),
    timestamp: z.number().int().positive(),
    body: z.string().max(4000),
    attachments: z
      .array(chatAttachmentSchema)
      .min(1)
      .max(MAX_CHAT_ATTACHMENTS)
      .optional(),
    mode: z.enum(["DIRECT", "RELAY", "TURN"]),
    ackRequested: z.boolean().optional(),
    ackFor: idSchema.optional(),
    attempt: z.number().int().min(1).max(MAX_DELIVERY_ATTEMPTS),
    sequence: z.number().int().nonnegative(),
    logicalTime: z.number().int().nonnegative().optional(),
    fileChunk: fileChunkSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.ackRequested !== undefined && m.ackRequested !== (m.type !== "ack"))
      ctx.addIssue({
        code: "custom",
        message: "ackRequested must match the message type",
      });
    if (m.type === "ack" && m.ackFor === m.messageId)
      ctx.addIssue({
        code: "custom",
        message: "ACK cannot acknowledge itself",
      });
    if (m.type !== "ack" && m.ackFor !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "ackFor is only supported on ACK messages",
      });
    if (m.type === "ack" && m.body.length)
      ctx.addIssue({ code: "custom", message: "ack cannot have a body" });
    if (m.type === "file-chunk" && (!m.fileChunk || m.attachments || m.body))
      ctx.addIssue({ code: "custom", message: "invalid file chunk envelope" });
    if (m.type !== "file-chunk" && m.fileChunk)
      ctx.addIssue({ code: "custom", message: "unexpected file chunk" });
    if (m.type === "ack" && !m.ackFor)
      ctx.addIssue({ code: "custom", message: "ackFor required" });
    if (m.type === "text" && !m.body.trim())
      ctx.addIssue({ code: "custom", message: "body required" });
    if (m.type === "text" && m.attachments)
      ctx.addIssue({ code: "custom", message: "text cannot have attachments" });
    if (m.type === "attachment" && !m.attachments)
      ctx.addIssue({ code: "custom", message: "attachments required" });
    if (m.type === "ack" && m.attachments)
      ctx.addIssue({ code: "custom", message: "ack cannot have attachments" });
  });
export type ChatMessage = z.infer<typeof messageSchema>;
function messageEvent(input: ChatMessage) {
  const message = messageSchema.parse(input);
  return JSON.stringify([
    message.messageId,
    message.sessionId,
    message.senderId,
    message.receiverId,
    message.groupId ?? null,
    message.type,
    message.timestamp,
    message.logicalTime ?? null,
    message.sequence,
    message.body,
    message.attachments ?? null,
    message.fileChunk ?? null,
    message.ackFor ?? null,
  ]);
}
export function sameMessageEvent(
  left: ChatMessage,
  right: ChatMessage,
): boolean {
  return messageEvent(left) === messageEvent(right);
}
export type DeliveryMode = ChatMessage["mode"];
export type PeerPresence = {
  peerId: string;
  online: boolean;
};
export const peerConnectionSchema = z
  .object({
    transport: z.literal("webrtc-datachannel"),
    signaling: z.literal("socket.io"),
    relay: z.literal("socket.io"),
  })
  .strict();
export const DEFAULT_PEER_CONNECTION = Object.freeze({
  transport: "webrtc-datachannel" as const,
  signaling: "socket.io" as const,
  relay: "socket.io" as const,
});
export type PeerConnection = z.infer<typeof peerConnectionSchema>;
export const peerRegistrationSchema = z
  .object({
    peerId: peerIdSchema,
    identityProof: z.string().min(16).max(4096),
    displayName: z.string().trim().min(1).max(80).optional(),
    status: z.literal("online").default("online"),
    connection: peerConnectionSchema.default(DEFAULT_PEER_CONNECTION),
  })
  .strict();
export const peerProfileSchema = z
  .object({
    peerId: peerIdSchema,
    displayName: z.string().trim().min(1).max(80),
    status: z.literal("online"),
    online: z.literal(true),
    lastSeen: z.number().int().nonnegative(),
    connection: peerConnectionSchema,
  })
  .strict();
export type PeerProfile = z.infer<typeof peerProfileSchema>;
export const peerDiscoverySchema = z.discriminatedUnion("online", [
  z
    .object({
      peerId: peerIdSchema,
      online: z.literal(true),
      lastSeen: z.number().int().nonnegative(),
      connection: peerConnectionSchema,
    })
    .strict(),
  z
    .object({
      peerId: peerIdSchema,
      online: z.literal(false),
      lastSeen: z.null(),
      connection: z.null(),
    })
    .strict(),
]);
export type PeerDiscovery = z.infer<typeof peerDiscoverySchema>;
export const groupSchema = z
  .object({
    id: idSchema,
    ownerId: peerIdSchema,
    members: z.array(peerIdSchema).max(16),
    version: z.number().int().positive(),
    projectId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    archived: z.boolean().optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine(
    (group) => new Set(group.members).size === group.members.length,
    "members must be unique",
  )
  .refine(
    (group) => group.archived || group.members.includes(group.ownerId),
    "owner must be a member",
  );
export type Group = z.infer<typeof groupSchema>;
export const MAX_WIRE_BYTES = 8192;
export function parseMessage(input: unknown): ChatMessage {
  if (BufferLikeSize(input) > MAX_WIRE_BYTES)
    throw new Error("message too large");
  const message = messageSchema.parse(input);
  const normalized = { ...message, ackRequested: message.type !== "ack" };
  if (BufferLikeSize(normalized) > MAX_WIRE_BYTES)
    throw new Error("message too large");
  return normalized;
}
function BufferLikeSize(input: unknown): number {
  return new TextEncoder().encode(JSON.stringify(input)).length;
}
