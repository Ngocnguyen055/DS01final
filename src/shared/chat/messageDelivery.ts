import { randomUUID } from "../uuid.ts";
import {
  MAX_DELIVERY_ATTEMPTS,
  parseMessage,
  peerIdSchema,
  sameMessageEvent,
  type ChatAttachment,
  type ChatMessage,
  type DeliveryMode,
  type Group,
  type FileChunk,
} from "../protocol.ts";
import type { ChatStore, PeerEvent } from "../peerTypes.ts";
type PendingAck = {
  resolve: () => void;
  reject: (error: Error) => void;
  sessionId: string;
  groupId?: string | null;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
};
type MessageDeliveryConfig = {
  peerId: string;
  store: ChatStore;
  ackTimeoutMs?: number;
  getGroup: (groupId: string) => Group | undefined;
  syncProjectGroup: (projectId: string) => Promise<Group>;
  authorizeGroup: (groupId: string, otherPeerId: string) => Promise<Group>;
  selectMode: (receiverId: string) => Promise<DeliveryMode>;
  transport: (
    message: ChatMessage,
    mode: DeliveryMode,
  ) => Promise<void | { queued: true; expiresAt?: number }>;
  emit: (event: PeerEvent) => void;
  log: (text: string) => void;
  onFileChunk?: (message: ChatMessage) => Promise<void>;
};

export class MessageDelivery {
  private pending = new Map<string, PendingAck>();
  private inFlight = new Set<string>();
  private creating = new Set<string>();
  private sequence = new Map<string, number>();
  private sessionIds = new Map<string, string>();
  private initialized?: Promise<void>;
  private clock = 0;
  private closed = false;
  private incoming = Promise.resolve();
  private queuedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queuedUpdates = new Map<string, Promise<void>>();
  private cancel!: (error: Error) => void;
  private cancelled!: Promise<never>;
  constructor(private config: MessageDeliveryConfig) {
    this.open();
  }
  private open() {
    this.closed = false;
    this.cancelled = new Promise<never>((_resolve, reject) => {
      this.cancel = reject;
    });
    void this.cancelled.catch(() => {});
  }
  private wait<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.cancelled]);
  }
  private assertOpen() {
    if (this.closed) throw new Error("peer disconnected");
  }
  async recover() {
    this.initialized ??= (async () => {
      for (const row of await this.config.store.list()) {
        const m = row.message;
        this.clock = Math.max(this.clock, m.logicalTime ?? m.timestamp);
        if (m.senderId !== this.config.peerId) continue;
        const key = m.groupId || [m.senderId, m.receiverId].sort().join(":");
        this.sequence.set(
          key,
          Math.max(this.sequence.get(key) || 0, m.sequence),
        );
        if (!m.groupId) this.sessionIds.set(key, m.sessionId);
        if (row.status === "queued")
          this.watchQueued({
            ...row,
            queuedUntil: row.queuedUntil ?? m.timestamp + 86400000,
          });
        if (
          row.status === "pending" ||
          row.status === "sent" ||
          row.status === "forwarded"
        ) {
          await this.config.store.mark(m.messageId, m.receiverId, "failed");
          this.config.emit({
            kind: "message",
            message: { message: m, status: "failed" },
          });
        }
      }
    })();
    return this.initialized;
  }
  async send(
    receiverId: string,
    body: string,
    groupId?: string | null,
    messageId = randomUUID(),
    sequenceOverride?: number,
    attachments?: ChatAttachment[],
    fileChunk?: FileChunk,
  ): Promise<void> {
    if (this.creating.has(messageId))
      throw new Error("message ID already in use");
    this.creating.add(messageId);
    try {
      await this.exclusiveSend(messageId, receiverId, async () => {
        await this.recover();
        this.assertOpen();
        if (
          (await this.config.store.list()).some(
            (row) =>
              row.message.senderId === this.config.peerId &&
              row.message.messageId === messageId,
          )
        )
          throw new Error(
            "message ID already used; retry the original message",
          );
        await this.deliver(
          this.createMessage(
            receiverId,
            body,
            groupId,
            messageId,
            sequenceOverride,
            attachments,
            fileChunk,
          ),
        );
      });
    } finally {
      this.creating.delete(messageId);
    }
  }
  private async exclusiveSend(
    messageId: string,
    receiverId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.assertOpen();
    const key = `${messageId}:${receiverId}`;
    if (this.inFlight.has(key)) throw new Error("message is already in flight");
    this.inFlight.add(key);
    try {
      await operation();
    } finally {
      this.inFlight.delete(key);
    }
  }
  async retry(messageId: string, receiverId: string): Promise<void> {
    return this.exclusiveSend(messageId, receiverId, async () => {
      await this.recover();
      this.assertOpen();
      const row = (await this.config.store.list()).find(
        (row) =>
          row.message.messageId === messageId &&
          row.message.receiverId === receiverId &&
          row.message.senderId === this.config.peerId,
      );
      if (!row || row.status !== "failed" || row.message.type !== "text")
        throw new Error("message cannot be retried");
      if (
        !row.message.groupId &&
        (await this.config.store.isDirectBlocked?.(receiverId))
      )
        throw new Error("peer blocked");
      if (row.message.groupId)
        await this.config.authorizeGroup(row.message.groupId, receiverId);
      await this.deliver(parseMessage(row.message));
    });
  }
  private createMessage(
    receiverId: string,
    body: string,
    groupId: string | null | undefined,
    messageId: string,
    sequenceOverride?: number,
    attachments?: ChatAttachment[],
    fileChunk?: FileChunk,
  ): ChatMessage {
    if (!body.trim() && !attachments?.length && !fileChunk)
      throw new Error("empty message");
    if (groupId && !this.config.getGroup(groupId)?.members.includes(receiverId))
      throw new Error("receiver not in group");
    const conversationKey =
      groupId || [this.config.peerId, receiverId].sort().join(":");
    const sequence =
      sequenceOverride ?? (this.sequence.get(conversationKey) || 0) + 1;
    if (sequenceOverride === undefined)
      this.sequence.set(conversationKey, sequence);
    let sessionId = groupId || this.sessionIds.get(conversationKey);
    if (!sessionId) {
      sessionId = randomUUID();
      this.sessionIds.set(conversationKey, sessionId);
    }
    return parseMessage({
      messageId,
      sessionId,
      senderId: this.config.peerId,
      receiverId,
      groupId,
      type: fileChunk
        ? "file-chunk"
        : attachments?.length
          ? "attachment"
          : "text",
      timestamp: Date.now(),
      body,
      attachments,
      mode: "RELAY",
      ackRequested: true,
      attempt: 1,
      sequence,
      logicalTime: (this.clock = Math.max(Date.now(), this.clock + 1)),
      fileChunk,
    });
  }
  private async deliver(message: ChatMessage): Promise<void> {
    this.assertOpen();
    const { messageId, receiverId, fileChunk } = message;
    if (
      message.groupId &&
      !this.config.getGroup(message.groupId)?.members.includes(receiverId)
    )
      throw new Error("receiver not in group");
    if (!fileChunk) {
      await this.config.store.put({ message, status: "pending" });
      this.config.emit({
        kind: "message",
        message: { message, status: "pending" },
      });
    }
    let mode: DeliveryMode = "RELAY";
    try {
      mode = await this.wait(this.config.selectMode(receiverId));
    } catch (error) {
      this.config.log(`DIRECT selection failed: ${String(error)}`);
    }
    this.config.emit({ kind: "mode", peerId: receiverId, mode });
    let lastAccepted = message;
    let lastFailure = "";
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      const packet = { ...message, mode, attempt };
      try {
        this.assertOpen();
        let armTimeout = () => {};
        const ack = new Promise<void>((resolve, reject) => {
          const key = `${messageId}:${receiverId}`;
          const waiting: PendingAck = {
            resolve,
            reject,
            sessionId: message.sessionId,
            groupId: message.groupId,
            sequence: message.sequence,
          };
          this.pending.set(key, waiting);
          armTimeout = () => {
            if (this.pending.get(key) !== waiting) return;
            waiting.timer = setTimeout(() => {
              if (this.pending.get(key) !== waiting) return;
              this.pending.delete(key);
              reject(new Error("ACK timeout"));
            }, this.config.ackTimeoutMs || 2000);
          };
        });
        void ack.catch(() => {});
        const accepted = await this.wait(
          Promise.race([
            this.config
              .transport(packet, mode)
              .then((result) => ({
                transport: true,
                queued: result?.queued === true,
                expiresAt: result?.queued ? result.expiresAt : undefined,
              })),
            ack.then(() => ({
              transport: false,
              queued: false,
              expiresAt: undefined,
            })),
          ]),
        );
        this.assertOpen();
        lastAccepted = packet;
        if (
          accepted.queued &&
          this.pending.has(`${messageId}:${receiverId}`) &&
          !fileChunk
        ) {
          const queued = {
            message: packet,
            status: "queued" as const,
            queuedUntil: Math.min(
              Number.isSafeInteger(accepted.expiresAt)
                ? accepted.expiresAt!
                : Date.now() + 86400000,
              Date.now() + 86400000,
            ),
          };
          await this.config.store.put(queued);
          if (this.pending.has(`${messageId}:${receiverId}`)) {
            this.pending.delete(`${messageId}:${receiverId}`);
            this.config.emit({ kind: "message", message: queued });
            this.watchQueued(queued);
            return;
          }
        }
        if (accepted.transport && !accepted.queued) {
          if (!fileChunk) {
            const status = mode === "RELAY" ? "forwarded" : "sent";
            await this.config.store.put({ message: packet, status });
            this.config.emit({
              kind: "message",
              message: { message: packet, status },
            });
          }
          armTimeout();
          await this.wait(ack);
        }
        this.assertOpen();
        if (!fileChunk) {
          await this.config.store.put({ message: packet, status: "delivered" });
          this.config.emit({
            kind: "message",
            message: { message: packet, status: "delivered" },
          });
        }
        return;
      } catch (error) {
        const pending = this.pending.get(`${messageId}:${receiverId}`);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(`${messageId}:${receiverId}`);
        }
        lastFailure = String(error);
        this.config.log(
          `send attempt ${attempt} failed: ${lastFailure} peer=${receiverId} message=${messageId} type=${message.type}${message.groupId ? " group=" + message.groupId : ""}`,
        );
        if (this.closed) break;
        mode = "RELAY";
        this.config.emit({ kind: "mode", peerId: receiverId, mode });
      }
    }
    if (!fileChunk) {
      await this.config.store.mark(messageId, receiverId, "failed");
      this.config.emit({
        kind: "message",
        message: { message: lastAccepted, status: "failed" },
      });
    }
    throw new Error(
      `delivery failed to ${receiverId}${lastFailure ? ": " + lastFailure : ""}`,
    );
  }
  async sendDirect(receiverId: string, body: string): Promise<void> {
    peerIdSchema.parse(receiverId);
    if (receiverId === this.config.peerId)
      throw new Error("cannot chat with yourself");
    if (await this.config.store.isDirectBlocked?.(receiverId))
      throw new Error("peer is blocked");
    await this.send(receiverId, body);
  }
  async sendDirectAttachment(
    receiverId: string,
    attachments: ChatAttachment[],
    caption = "",
  ): Promise<void> {
    peerIdSchema.parse(receiverId);
    if (receiverId === this.config.peerId)
      throw new Error("cannot chat with yourself");
    if (await this.config.store.isDirectBlocked?.(receiverId))
      throw new Error("peer is blocked");
    await this.send(
      receiverId,
      caption.trim(),
      undefined,
      randomUUID(),
      undefined,
      attachments,
    );
  }
  async sendGroup(
    groupId: string,
    body: string,
    attachments?: ChatAttachment[],
    onlyRecipients?: string[],
  ): Promise<Record<string, string>> {
    await this.recover();
    const group = this.config.getGroup(groupId);
    if (!group || !group.members.includes(this.config.peerId))
      throw new Error("not a group member");
    const current = group.projectId
      ? await this.config.syncProjectGroup(group.projectId)
      : await this.config.authorizeGroup(groupId, this.config.peerId);
    if (current.archived) throw new Error("project archived");
    const messageId = randomUUID();
    const sequence = (this.sequence.get(groupId) || 0) + 1;
    this.sequence.set(groupId, sequence);
    const recipients = current.members.filter(
      (peerId) =>
        peerId !== this.config.peerId &&
        (!onlyRecipients || onlyRecipients.includes(peerId)),
    );
    if (!recipients.length)
      throw new Error("add another member before sending");

    const message = this.createMessage(
      recipients[0],
      body,
      groupId,
      messageId,
      sequence,
      attachments,
    );
    const results = await Promise.allSettled(
      recipients.map((peerId) =>
        this.exclusiveSend(messageId, peerId, () =>
          this.deliver({ ...message, receiverId: peerId }),
        ),
      ),
    );
    return Object.fromEntries(
      recipients.map((peerId, index) => [peerId, results[index].status]),
    );
  }
  receive(
    raw: unknown,
    mode: DeliveryMode,
    expectedSender?: string,
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      const message = parseMessage(raw);
      if (message.type === "ack")
        return this.receiveOne(message, mode, expectedSender);
      const job = this.incoming.then(() =>
        this.receiveOne(message, mode, expectedSender),
      );
      this.incoming = job.catch(() => {});
      return job;
    } catch (error) {
      this.config.log(`receive rejected: ${String(error)}`);
      return Promise.resolve();
    }
  }
  private async receiveOne(
    message: ChatMessage,
    mode: DeliveryMode,
    expectedSender?: string,
  ) {
    try {
      if (this.closed) return;
      if (
        message.receiverId !== this.config.peerId ||
        message.mode !== mode ||
        (expectedSender && message.senderId !== expectedSender)
      )
        throw new Error("wrong receiver, sender or mode");
      if (
        !message.groupId &&
        (await this.config.store.isDirectBlocked?.(message.senderId))
      )
        throw new Error("sender blocked");
      if (message.groupId)
        await this.config.authorizeGroup(message.groupId, message.senderId);
      if (message.type === "ack") {
        const pending = this.pending.get(
          `${message.ackFor}:${message.senderId}`,
        );
        if (
          pending &&
          pending.sessionId === message.sessionId &&
          (pending.groupId ?? null) === (message.groupId ?? null) &&
          pending.sequence === message.sequence
        ) {
          this.clock =
            Math.max(this.clock, message.logicalTime ?? message.timestamp) + 1;
          clearTimeout(pending.timer);
          this.pending.delete(`${message.ackFor}:${message.senderId}`);
          pending.resolve();
        } else {
          await this.updateQueued(
            `${message.ackFor}:${message.senderId}`,
            async () => {
              const row = (await this.config.store.list()).find(
                (row) =>
                  row.message.messageId === message.ackFor &&
                  row.message.senderId === this.config.peerId &&
                  row.message.receiverId === message.senderId &&
                  row.message.sessionId === message.sessionId &&
                  row.message.sequence === message.sequence &&
                  (row.message.groupId ?? null) === (message.groupId ?? null) &&
                  ["queued", "failed"].includes(row.status),
              );
              if (row) {
                clearTimeout(
                  this.queuedTimers.get(
                    `${message.ackFor}:${message.senderId}`,
                  ),
                );
                this.queuedTimers.delete(
                  `${message.ackFor}:${message.senderId}`,
                );
                this.clock =
                  Math.max(
                    this.clock,
                    message.logicalTime ?? message.timestamp,
                  ) + 1;
                await this.config.store.put({ ...row, status: "delivered" });
                this.config.emit({
                  kind: "message",
                  message: { ...row, status: "delivered" },
                });
              }
            },
          );
        }
        return;
      }
      if (!message.groupId) {
        const key = [this.config.peerId, message.senderId].sort().join(":");
        if (!this.sessionIds.has(key))
          this.sessionIds.set(key, message.sessionId);
      }
      if (message.type === "file-chunk") {
        if (!this.config.onFileChunk)
          throw new Error("file transfer unsupported");
        await this.config.onFileChunk(message);
      }
      if (message.type === "attachment")
        for (const file of message.attachments || [])
          if (file.sha256) {
            const stored = await this.config.store.getFile?.(file.id);
            if (
              !stored ||
              stored.file.sha256 !== file.sha256 ||
              stored.data.length !== file.size
            )
              throw new Error("file bytes missing or unverified");
          }
      const duplicate =
        message.type === "file-chunk" ||
        (await this.config.store.has(message.messageId, message.senderId));
      if (duplicate && message.type !== "file-chunk") {
        const previous = (await this.config.store.list()).find(
          (row) =>
            row.message.messageId === message.messageId &&
            row.message.senderId === message.senderId,
        );
        if (previous && !sameMessageEvent(previous.message, message))
          throw new Error("conflicting message ID");
      }
      this.clock =
        Math.max(this.clock, message.logicalTime ?? message.timestamp) + 1;
      if (!duplicate) {
        await this.config.store.put({ message, status: "received" });
        this.config.emit({
          kind: "message",
          message: { message, status: "received" },
        });
      }
      this.config.emit({ kind: "mode", peerId: message.senderId, mode });
      this.config.log(
        `${mode} RECEIVE ${message.messageId} <- ${message.senderId}${duplicate ? " duplicate" : ""}`,
      );
      const ack: ChatMessage = {
        messageId: randomUUID(),
        sessionId: message.sessionId,
        senderId: this.config.peerId,
        receiverId: message.senderId,
        groupId: message.groupId,
        type: "ack",
        timestamp: Date.now(),
        logicalTime: ++this.clock,
        body: "",
        mode,
        ackFor: message.messageId,
        ackRequested: false,
        attempt: 1,
        sequence: message.sequence,
      };
      try {
        await this.config.transport(ack, mode);
      } catch {
        await this.config.transport({ ...ack, mode: "RELAY" }, "RELAY");
      }
    } catch (error) {
      this.config.log(`receive rejected: ${String(error)}`);
    }
  }
  private async updateQueued(key: string, operation: () => Promise<void>) {
    const previous = this.queuedUpdates.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queuedUpdates.set(key, current);
    try {
      await current;
    } finally {
      if (this.queuedUpdates.get(key) === current)
        this.queuedUpdates.delete(key);
    }
  }
  private watchQueued(row: import("../peerTypes.ts").StoredMessage) {
    const m = row.message,
      key = `${m.messageId}:${m.receiverId}`,
      deadline = row.queuedUntil!;
    clearTimeout(this.queuedTimers.get(key));
    this.queuedTimers.set(
      key,
      setTimeout(
        () => {
          this.queuedTimers.delete(key);
          void this.updateQueued(key, async () => {
            if (this.closed) return;
            const current = (await this.config.store.list()).find(
              (item) =>
                item.message.messageId === m.messageId &&
                item.message.receiverId === m.receiverId &&
                item.message.senderId === this.config.peerId,
            );
            if (!current || current.status !== "queued" || this.closed) return;
            const failed = { ...current, status: "failed" as const };
            await this.config.store.put(failed);
            this.config.log(
              `DELIVERY_ERROR ${m.messageId}: offline mailbox deadline expired without receiver ACK; retry preserves the event ID`,
            );
            this.config.emit({ kind: "message", message: failed });
          }).catch((error) =>
            this.config.log(`mailbox expiry check failed: ${String(error)}`),
          );
        },
        Math.max(0, deadline - Date.now()),
      ),
    );
  }
  close() {
    this.closed = true;
    const error = new Error("peer disconnected");
    this.cancel(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const timer of this.queuedTimers.values()) clearTimeout(timer);
    this.queuedTimers.clear();
  }
}
