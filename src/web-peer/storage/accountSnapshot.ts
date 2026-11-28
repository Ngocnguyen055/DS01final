import { z } from "zod";
import {
  orderMessages,
  peerIdSchema,
  sameMessageEvent,
  type DirectChatContact,
  type MessageStatus,
  type StoredMessage,
} from "@ds01/shared";
import { chatAttachmentSchema, messageSchema } from "../../shared/protocol.ts";
import { publicIdentitySchema } from "../../shared/secure.ts";
import { callRecordSchema } from "./callHistory.ts";

const rowSchema = z
  .object({
    message: messageSchema,
    status: z.enum([
      "pending",
      "sent",
      "forwarded",
      "queued",
      "delivered",
      "failed",
      "received",
    ]),
    queuedUntil: z.number().int().positive().optional(),
  })
  .strict();
export const accountSnapshotSchema = z
  .object({
    v: z.literal(1),
    peerId: peerIdSchema,
    rows: z.array(rowSchema).max(1000),
    contacts: z
      .array(
        z
          .object({
            peerId: peerIdSchema,
            name: z.string().max(80),
            email: z.string().max(254),
            updatedAt: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(500),
    blocked: z.array(peerIdSchema).max(10000),
    blockEdits: z
      .record(
        peerIdSchema,
        z.object({ blocked: z.boolean(), at: z.number().int().nonnegative() }),
      )
      .default({}),
    deleted: z.array(z.string().max(120)).max(10000),
    seen: z.array(z.string().max(80)).max(10000),
    calls: z.array(callRecordSchema).max(1000).default([]),
    groupNames: z.record(z.string().uuid(), z.string().max(100)),
    pins: z.record(peerIdSchema, publicIdentitySchema),
    files: z
      .array(
        z
          .object({
            file: chatAttachmentSchema,
            data: z
              .string()
              .max(12 * 1024 * 1024)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;
export const rowId = (row: StoredMessage) =>
  `${row.message.senderId}:${row.message.messageId}:${row.message.receiverId}`;
export function mergeAccountSnapshots(
  local: AccountSnapshot,
  remote: AccountSnapshot,
): AccountSnapshot {
  if (local.peerId !== remote.peerId)
    throw Error("Bản sao thuộc tài khoản khác.");
  const deleted = new Set([...remote.deleted, ...local.deleted]),
    rows = new Map<string, StoredMessage>();
  const priority: Record<MessageStatus, number> = {
    pending: 0,
    sent: 1,
    forwarded: 2,
    queued: 3,
    failed: 4,
    delivered: 5,
    received: 5,
  };
  for (const row of [...remote.rows, ...local.rows]) {
    if (
      row.message.senderId !== local.peerId &&
      row.message.receiverId !== local.peerId
    )
      throw Error("Lịch sử chứa tin nhắn của tài khoản khác.");
    const id = rowId(row),
      previous = rows.get(id);
    if (previous && !sameMessageEvent(previous.message, row.message))
      throw Error("Bản sao chứa Message ID có nội dung xung đột.");
    if (
      !deleted.has(id) &&
      (!previous || priority[row.status] >= priority[previous.status])
    )
      rows.set(id, row);
  }
  const contacts = new Map<string, DirectChatContact>();
  for (const contact of [...remote.contacts, ...local.contacts])
    if (
      !contacts.has(contact.peerId) ||
      contacts.get(contact.peerId)!.updatedAt <= contact.updatedAt
    )
      contacts.set(contact.peerId, contact);
  const files = new Map(
    [...remote.files, ...local.files].map((value) => [value.file.id, value]),
  );
  const blockEdits = { ...remote.blockEdits };
  for (const [id, edit] of Object.entries(local.blockEdits))
    if (!blockEdits[id] || edit.at >= blockEdits[id].at) blockEdits[id] = edit;
  const blocked = new Set([...remote.blocked, ...local.blocked]);
  for (const [id, edit] of Object.entries(blockEdits)) {
    if (edit.blocked) blocked.add(id);
    else blocked.delete(id);
  }
  const calls = new Map(
    [...remote.calls, ...local.calls].map((call) => [call.id, call]),
  );
  for (const call of remote.calls)
    if (call.updatedAt > (calls.get(call.id)?.updatedAt || 0))
      calls.set(call.id, call);
  const finalRows = orderMessages([...rows.values()]).slice(-1000),
    usedFiles = new Set(
      finalRows.flatMap(
        (row) => row.message.attachments?.map((file) => file.id) || [],
      ),
    );
  let fileBudget = 8 * 1024 * 1024;
  const snapshotFiles = [...usedFiles].reverse().flatMap((id) => {
    const file = files.get(id);
    if (!file || file.file.size > fileBudget) return [];
    fileBudget -= file.file.size;
    return [file];
  });
  return accountSnapshotSchema.parse({
    ...remote,
    ...local,
    rows: finalRows,
    calls: [...calls.values()]
      .filter((call) => !deleted.has("call:" + call.id))
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-1000),
    contacts: [...contacts.values()].slice(-500),
    blocked: [...blocked],
    blockEdits,
    deleted: [...deleted].slice(-10000),
    seen: [...new Set([...remote.seen, ...local.seen])].slice(-10000),
    groupNames: { ...remote.groupNames, ...local.groupNames },
    pins: { ...remote.pins, ...local.pins },
    files: snapshotFiles,
  });
}
