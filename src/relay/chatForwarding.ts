import type { Socket } from "socket.io";
import { z } from "zod";
import { groupSchema, peerIdSchema, type Group } from "../shared/protocol.ts";
import { parseWireMessage, type WireMessage } from "../shared/secure.ts";
import type { RelayJournal } from "./journal.ts";

type Reply = (response: {
  ok: boolean;
  error?: string;
  queued?: boolean;
  expiresAt?: number;
}) => void;

type ChatForwardingConfig = {
  connections: ReadonlyMap<string, Socket>;
  journal: RelayJournal;
  offlineQueue: boolean;
  lookupGroup: (id: string) => Promise<Group | null>;
  authorizeDirect: (senderId: string, receiverId: string) => Promise<boolean>;
  authorizeSession: (peerId: string, session: unknown) => Promise<void>;
  requireActive: (socket: Socket, peerId: string, role: string) => void;
  metrics: {
    forwardedMessages: number;
    rejectedMessages: number;
    forwardedPayloadBytes: number;
  };
  log: (event: string, detail: string) => void;
};

export function createChatForwarding({
  connections,
  journal,
  offlineQueue,
  lookupGroup,
  authorizeDirect,
  authorizeSession,
  requireActive,
  metrics,
  log,
}: ChatForwardingConfig) {
  const drainAttempts = new Map<
    string,
    { socket: string; count: number; sentAt: number }
  >();
  let draining = false;
  const forward = (target: Socket, input: unknown, msg: WireMessage) => {
    target.emit("relay:receive", input);
    metrics.forwardedMessages++;
    metrics.forwardedPayloadBytes += Buffer.byteLength(
      JSON.stringify(input),
      "utf8",
    );
    log(
      "FORWARD",
      `${msg.messageId} ${msg.senderId} -> ${msg.receiverId} ${msg.type} attempt=${msg.attempt} result=forwarded`,
    );
  };

  async function drainMailbox() {
    if (!offlineQueue || draining) return;
    draining = true;
    try {
      for (const entry of journal.pending().slice(0, 500)) {
        const msg = parseWireMessage(entry.value),
          target = connections.get(msg.receiverId),
          attempt = drainAttempts.get(entry.key);
        if (
          !target?.connected ||
          target.data.tokenExpiresAt <= Date.now() ||
          (attempt?.socket === target.id &&
            (attempt.count >= 3 || Date.now() - attempt.sentAt < 4000))
        )
          continue;
        try {
          await authorizeSession(msg.receiverId, target.data.authSession);
          if (msg.groupId) {
            const group = groupSchema.parse(await lookupGroup(msg.groupId));
            if (
              group.id !== msg.groupId ||
              group.archived ||
              !group.members.includes(msg.senderId) ||
              !group.members.includes(msg.receiverId)
            )
              continue;
          } else if (!(await authorizeDirect(msg.senderId, msg.receiverId)))
            continue;
          if (connections.get(msg.receiverId) !== target || !target.connected)
            continue;
          drainAttempts.set(entry.key, {
            socket: target.id,
            count: attempt?.socket === target.id ? attempt.count + 1 : 1,
            sentAt: Date.now(),
          });
          forward(target, entry.value, msg);
        } catch {
          continue;
        }
      }
      for (const key of drainAttempts.keys())
        if (!journal.entries.has(key) || journal.entries.get(key)?.deleted)
          drainAttempts.delete(key);
    } finally {
      draining = false;
    }
  }

  function attach(socket: Socket, peerId: string) {
    socket.on("relay:consumed", (input, reply) => {
      if (typeof reply !== "function") return;
      try {
        requireActive(socket, peerId, "receiver");
        const value = z
          .object({ messageId: z.string().uuid(), senderId: peerIdSchema })
          .strict()
          .parse(input);
        if (offlineQueue)
          journal.acknowledge(value.senderId, value.messageId, peerId);
        reply({ ok: true });
      } catch {
        reply({ ok: false, error: "invalid mailbox receipt" });
      }
    });
    socket.on("relay:send", async (input: unknown, reply: Reply) => {
      if (typeof reply !== "function") return;
      try {
        const msg = parseWireMessage(input);
        requireActive(socket, peerId, "sender");
        await authorizeSession(peerId, socket.data.authSession);
        if (msg.senderId !== peerId || msg.mode !== "RELAY")
          throw new Error("sender or mode mismatch");
        if (msg.groupId) {
          const result = groupSchema.safeParse(await lookupGroup(msg.groupId));
          if (
            !result.success ||
            result.data.id !== msg.groupId ||
            result.data.archived ||
            !result.data.members.includes(peerId) ||
            !result.data.members.includes(msg.receiverId)
          )
            throw new Error("group access denied");
        } else if (!(await authorizeDirect(peerId, msg.receiverId)))
          throw new Error("direct chat blocked");
        const target = connections.get(msg.receiverId);
        requireActive(socket, peerId, "sender");
        if (
          !target &&
          (msg.type === "file-chunk" ||
            (msg.type === "sealed" && msg.traffic === "file-chunk"))
        )
          throw Error("file receiver offline");
        if (offlineQueue && msg.ackFor)
          journal.acknowledge(msg.receiverId, msg.ackFor, peerId);
        const queued =
          offlineQueue && (!msg.ackFor || !target)
            ? journal.enqueue(msg)
            : undefined;
        if (!target) {
          if (!offlineQueue) throw new Error("receiver offline");
          log("QUEUED", `${msg.messageId} ${peerId} -> ${msg.receiverId}`);
          return reply({
            ok: true,
            queued: true,
            expiresAt: queued?.expiresAt,
          });
        }
        requireActive(target, msg.receiverId, "receiver");
        await authorizeSession(msg.receiverId, target.data.authSession);
        requireActive(socket, peerId, "sender");
        requireActive(target, msg.receiverId, "receiver");
        forward(target, input, msg);
        if (offlineQueue)
          drainAttempts.set(
            journal.mailKey(msg.senderId, msg.messageId, msg.receiverId),
            { socket: target.id, count: 1, sentAt: Date.now() },
          );
        reply?.({ ok: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "invalid message";
        metrics.rejectedMessages++;
        log("REJECT", `${peerId}: ${message}`);
        reply?.({ ok: false, error: message });
      }
    });
  }

  return { attach, drainMailbox };
}
