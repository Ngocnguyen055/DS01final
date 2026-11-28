import {
  isDirectMessageBetween,
  parseMessage,
  peerIdSchema,
  sameMessageEvent,
  type DirectChatContact,
  type DirectChatStore,
  type StoredMessage,
  type MessageStatus,
  type ChatAttachment,
  orderMessages,
} from "@ds01/shared";
import {
  publicIdentitySchema,
  type DeviceIdentity,
  type PublicIdentity,
  type IdentityStore,
} from "../../shared/secure.ts";
import {
  callRecordSchema,
  recoverCallRecords,
  type CallRecord,
} from "./callHistory.ts";
import { encodeBytes, decodeBytes } from "../account/accountCrypto.ts";

import {
  accountSnapshotSchema,
  mergeAccountSnapshots,
  rowId,
  type AccountSnapshot,
} from "./accountSnapshot.ts";
import { accessSecurityKey, getStoredFile, putStoredFile } from "./browserDatabase.ts";

export class WebStore implements DirectChatStore, IdentityStore {
  private contactWrites = Promise.resolve();
  private revision = 0;
  constructor(
    private scope: string,
    private changed?: () => void,
  ) {}
  private notify() {
    this.revision++;
    this.changed?.();
  }
  private get key() {
    return `ds01-history-v1-${this.scope}`;
  }
  private get contactKey() {
    return `ds01-direct-contacts-v1-${this.scope}`;
  }
  private get blockedKey() {
    return `ds01-direct-blocked-v1-${this.scope}`;
  }
  private get unreadKey() {
    return `ds01-unread-conversations-v1-${this.scope}`;
  }
  listUnreadConversations(): string[] {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(this.unreadKey) || "[]",
      );
      return Array.isArray(value)
        ? [
            ...new Set(
              value.filter(
                (key): key is string =>
                  typeof key === "string" && /^(peer|group):.{1,80}$/.test(key),
              ),
            ),
          ]
        : [];
    } catch {
      return [];
    }
  }
  markUnread(row: StoredMessage) {
    const message = row.message;
    if (
      row.status !== "received" ||
      message.senderId === this.scope ||
      message.receiverId !== this.scope ||
      !["text", "attachment"].includes(message.type)
    )
      return;
    const key = message.groupId
      ? `group:${message.groupId}`
      : `peer:${message.senderId}`;
    const unread = this.listUnreadConversations();
    if (unread.includes(key)) return;
    localStorage.setItem(this.unreadKey, JSON.stringify([...unread, key]));
  }
  markConversationRead(key: string) {
    const unread = this.listUnreadConversations();
    if (!unread.includes(key)) return false;
    localStorage.setItem(
      this.unreadKey,
      JSON.stringify(unread.filter((item) => item !== key)),
    );
    return true;
  }
  private read(): StoredMessage[] {
    try {
      const rows: unknown = JSON.parse(localStorage.getItem(this.key) || "[]");
      if (!Array.isArray(rows)) throw new Error("invalid history");
      return rows.map((row: unknown): StoredMessage => {
        if (
          !row ||
          typeof row !== "object" ||
          !("message" in row) ||
          !("status" in row) ||
          typeof row.status !== "string" ||
          ![
            "pending",
            "sent",
            "forwarded",
            "queued",
            "delivered",
            "failed",
            "received",
          ].includes(row.status) ||
          Object.keys(row).some(
            (key) => !["message", "status", "queuedUntil"].includes(key),
          ) ||
          ("queuedUntil" in row &&
            (!Number.isSafeInteger(row.queuedUntil) ||
              Number(row.queuedUntil) <= 0))
        )
          throw new Error("invalid stored message");
        return {
          message: parseMessage(row.message),
          status: row.status as MessageStatus,
          ...("queuedUntil" in row
            ? { queuedUntil: Number(row.queuedUntil) }
            : {}),
        };
      });
    } catch {
      throw new Error(
        "Lịch sử cục bộ bị hỏng. Hãy xuất dữ liệu trước khi đặt lại storage.",
      );
    }
  }
  private write(rows: StoredMessage[]) {
    localStorage.setItem(this.key, JSON.stringify(rows.slice(-1000)));
    this.notify();
  }
  async put(row: StoredMessage) {
    const rows = this.read();
    const index = rows.findIndex(
      (r) =>
        r.message.messageId === row.message.messageId &&
        r.message.receiverId === row.message.receiverId &&
        r.message.senderId === row.message.senderId,
    );
    if (index >= 0 && !sameMessageEvent(rows[index].message, row.message))
      throw new Error("conflicting message ID");
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    this.write(rows);
    if (row.status === "received") {
      const key = `${this.key}-seen`;
      const seen = this.seen();
      seen.add(`${row.message.senderId}:${row.message.messageId}`);
      localStorage.setItem(key, JSON.stringify([...seen].slice(-10000)));
    }
  }
  async putDirect(row: StoredMessage) {
    const currentPeerId = peerIdSchema.parse(this.scope);
    const message = row.message;
    const otherPeerId =
      message.senderId === currentPeerId
        ? message.receiverId
        : message.senderId;
    peerIdSchema.parse(otherPeerId);
    if (
      otherPeerId === currentPeerId ||
      !isDirectMessageBetween(message, currentPeerId, otherPeerId)
    )
      throw new Error("direct message does not belong to this store");
    await this.put(row);
  }
  async mark(messageId: string, receiverId: string, status: MessageStatus) {
    const rows = this.read();
    for (const row of rows)
      if (
        row.message.messageId === messageId &&
        row.message.receiverId === receiverId
      )
        row.status = status;
    this.write(rows);
  }
  async has(messageId: string, senderId: string) {
    return (
      this.seen().has(`${senderId}:${messageId}`) ||
      this.read().some(
        (r) =>
          r.message.messageId === messageId && r.message.senderId === senderId,
      )
    );
  }
  async list() {
    return orderMessages(this.read());
  }
  async listDirect(peerId: string) {
    const currentPeerId = peerIdSchema.parse(this.scope);
    const otherPeerId = peerIdSchema.parse(peerId);
    if (currentPeerId === otherPeerId)
      throw new Error("direct conversation requires another peer");
    return orderMessages(
      this.read().filter((row) =>
        isDirectMessageBetween(row.message, currentPeerId, otherPeerId),
      ),
    );
  }
  async listDirectAttachments(peerId: string) {
    return (await this.listDirect(peerId)).filter(
      (row) => row.message.type === "attachment",
    );
  }
  async deleteDirect(peerId: string) {
    const currentPeerId = peerIdSchema.parse(this.scope);
    const otherPeerId = peerIdSchema.parse(peerId);
    if (currentPeerId === otherPeerId)
      throw new Error("direct conversation requires another peer");
    const rows = this.read(),
      deleted = new Set<string>(
        JSON.parse(localStorage.getItem(`${this.key}-deleted`) || "[]"),
      );
    for (const row of rows)
      if (isDirectMessageBetween(row.message, currentPeerId, otherPeerId))
        deleted.add(rowId(row));
    localStorage.setItem(
      `${this.key}-deleted`,
      JSON.stringify([...deleted].slice(-10000)),
    );
    const previousCalls = this.listCalls();
    for (const call of previousCalls)
      if (call.peerId === otherPeerId) deleted.add("call:" + call.id);
    localStorage.setItem(
      `${this.key}-deleted`,
      JSON.stringify([...deleted].slice(-10000)),
    );
    const calls = previousCalls.filter((call) => call.peerId !== otherPeerId);
    localStorage.setItem(`${this.key}-calls`, JSON.stringify(calls));
    this.markConversationRead(`peer:${otherPeerId}`);
    this.write(
      rows.filter(
        (row) =>
          !isDirectMessageBetween(row.message, currentPeerId, otherPeerId),
      ),
    );
  }
  async setDirectBlocked(peerId: string, blocked: boolean) {
    const otherPeerId = peerIdSchema.parse(peerId);
    if (otherPeerId === peerIdSchema.parse(this.scope))
      throw new Error("cannot block yourself");
    const rows = new Set<string>(
      JSON.parse(localStorage.getItem(this.blockedKey) || "[]") as string[],
    );
    if (blocked) rows.add(otherPeerId);
    else rows.delete(otherPeerId);
    localStorage.setItem(this.blockedKey, JSON.stringify([...rows].sort()));
    const edits = JSON.parse(
      localStorage.getItem(`${this.blockedKey}-edits`) || "{}",
    );
    Object.defineProperty(edits, otherPeerId, {
      value: {
        blocked,
        at: Math.max(Date.now(), (edits[otherPeerId]?.at || 0) + 1),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    localStorage.setItem(`${this.blockedKey}-edits`, JSON.stringify(edits));
    this.notify();
  }
  async isDirectBlocked(peerId: string) {
    return (await this.listDirectBlocked()).includes(
      peerIdSchema.parse(peerId),
    );
  }
  async listDirectBlocked() {
    try {
      const rows = JSON.parse(
        localStorage.getItem(this.blockedKey) || "[]",
      ) as unknown;
      return Array.isArray(rows)
        ? rows.filter(
            (row): row is string => peerIdSchema.safeParse(row).success,
          )
        : [];
    } catch {
      return [];
    }
  }
  async saveDirectContact(contact: DirectChatContact) {
    const operation = this.contactWrites.then(() => this.saveContact(contact));
    this.contactWrites = operation.catch(() => {});
    return operation;
  }
  private async saveContact(contact: DirectChatContact) {
    const peerId = peerIdSchema.parse(contact.peerId);
    if (peerId === peerIdSchema.parse(this.scope))
      throw new Error("cannot save yourself");
    const contacts = await this.listDirectContacts();
    const next = [contact, ...contacts.filter((row) => row.peerId !== peerId)];
    localStorage.setItem(this.contactKey, JSON.stringify(next.slice(0, 500)));
    this.notify();
  }
  async listDirectContacts(): Promise<DirectChatContact[]> {
    try {
      const rows = JSON.parse(
        localStorage.getItem(this.contactKey) || "[]",
      ) as DirectChatContact[];
      return Array.isArray(rows)
        ? rows
            .filter(
              (row) =>
                peerIdSchema.safeParse(row.peerId).success &&
                typeof row.name === "string" &&
                typeof row.email === "string" &&
                Number.isSafeInteger(row.updatedAt),
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)
        : [];
    } catch {
      return [];
    }
  }
  async removeDirectContact(peerId: string) {
    const otherPeerId = peerIdSchema.parse(peerId);
    localStorage.setItem(
      this.contactKey,
      JSON.stringify(
        (await this.listDirectContacts()).filter(
          (contact) => contact.peerId !== otherPeerId,
        ),
      ),
    );
    this.notify();
  }
  private seen(): Set<string> {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(`${this.key}-seen`) || "[]",
      );
      return new Set(
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }
  listCalls(): CallRecord[] {
    return callRecordSchema
      .array()
      .parse(JSON.parse(localStorage.getItem(`${this.key}-calls`) || "[]"));
  }
  putCall(input: CallRecord) {
    const record = callRecordSchema.parse(input),
      records = this.listCalls(),
      index = records.findIndex((call) => call.id === record.id);
    if (index >= 0 && JSON.stringify(records[index]) === JSON.stringify(record))
      return false;
    if (index >= 0) records[index] = record;
    else records.push(record);
    localStorage.setItem(
      `${this.key}-calls`,
      JSON.stringify(
        records.sort((a, b) => a.startedAt - b.startedAt).slice(-1000),
      ),
    );
    this.notify();
    return true;
  }
  recoverCalls() {
    const records = recoverCallRecords(this.listCalls());
    for (const record of records) this.putCall(record);
  }
  async getIdentity() {
    return (await accessSecurityKey(this.scope, "identity")) as DeviceIdentity | undefined;
  }
  async putIdentity(value: DeviceIdentity) {
    await accessSecurityKey(this.scope, "identity", value);
  }
  async getAccountKeys() {
    return (await accessSecurityKey(this.scope, "account-keys")) as
      { vaultId: string; key: CryptoKey } | undefined;
  }
  async putAccountKeys(vaultId: string, key: CryptoKey) {
    await accessSecurityKey(this.scope, "account-keys", { vaultId, key });
  }
  async getPin(peerId: string) {
    const value = await accessSecurityKey(this.scope, `pin:${peerId}`);
    return value ? publicIdentitySchema.parse(value) : undefined;
  }
  async putPin(peerId: string, value: PublicIdentity) {
    await accessSecurityKey(this.scope, `pin:${peerId}`, publicIdentitySchema.parse(value));
  }
  async putFile(file: ChatAttachment, data: Uint8Array) {
    await putStoredFile(this.scope, file, data);
    this.notify();
  }
  async getFile(fileId: string) {
    return getStoredFile(this.scope, fileId);
  }
  async snapshot(attempt = 0): Promise<AccountSnapshot> {
    await this.contactWrites;
    const revision = this.revision;
    let fileBudget = 8 * 1024 * 1024;
    const rows = await this.list(),
      files: AccountSnapshot["files"] = [];
    for (const id of new Set(
      rows.flatMap(
        (row) => row.message.attachments?.map((file) => file.id) || [],
      ),
    )) {
      const saved = await this.getFile(id);
      if (saved && saved.data.length <= fileBudget) {
        files.push({ file: saved.file, data: encodeBytes(saved.data) });
        fileBudget -= saved.data.length;
      }
    }
    const pins: Record<string, PublicIdentity> = {};
    for (const id of new Set(
      rows
        .flatMap((row) => [row.message.senderId, row.message.receiverId])
        .filter((id) => id !== this.scope),
    )) {
      const pin = await this.getPin(id);
      if (pin)
        Object.defineProperty(pins, id, { value: pin, enumerable: true });
    }
    const snapshot = accountSnapshotSchema.parse({
      v: 1,
      peerId: this.scope,
      rows,
      files,
      pins,
      calls: this.listCalls(),
      contacts: await this.listDirectContacts(),
      blocked: await this.listDirectBlocked(),
      blockEdits: JSON.parse(
        localStorage.getItem(`${this.blockedKey}-edits`) || "{}",
      ),
      deleted: JSON.parse(localStorage.getItem(`${this.key}-deleted`) || "[]"),
      seen: [...this.seen()],
      groupNames: JSON.parse(
        localStorage.getItem(`ds01-group-names-${this.scope}`) || "{}",
      ),
    });
    if (revision !== this.revision) {
      if (attempt >= 8)
        throw Error("Lịch sử đang thay đổi. Sẽ thử đồng bộ lại.");
      return this.snapshot(attempt + 1);
    }
    return snapshot;
  }
  async restore(input: unknown, cancelled = () => false) {
    const remote = accountSnapshotSchema.parse(input),
      merged = mergeAccountSnapshots(await this.snapshot(), remote);
    const files = merged.files.map((value) => ({
      ...value,
      bytes: decodeBytes(value.data),
    }));
    for (const value of [
      ...files,
      ...remote.files.map((value) => ({
        ...value,
        bytes: decodeBytes(value.data),
      })),
    ]) {
      if (value.bytes.length !== value.file.size)
        throw Error("Kích thước file đồng bộ không đúng.");
      if (value.file.sha256) {
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", value.bytes)),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (hash !== value.file.sha256)
          throw Error("File đồng bộ không vượt qua kiểm tra SHA-256.");
      }
    }
    if (cancelled()) return;
    for (const value of files) {
      if (cancelled()) return;
      await this.putFile(value.file, value.bytes);
    }
    for (const [peerId, pin] of Object.entries(merged.pins))
      await this.putPin(peerId, pin);
    const latest = mergeAccountSnapshots(await this.snapshot(), remote);
    if (cancelled()) return;
    const writes = [
      [`${this.key}-calls`, latest.calls],
      [this.contactKey, latest.contacts],
      [this.blockedKey, latest.blocked],
      [`${this.blockedKey}-edits`, latest.blockEdits],
      [`${this.key}-deleted`, latest.deleted],
      [`${this.key}-seen`, latest.seen],
      [`ds01-group-names-${this.scope}`, latest.groupNames],
      [this.key, latest.rows],
    ] as const;
    const previous = writes.map(
      ([key]) => [key, localStorage.getItem(key)] as const,
    );
    try {
      for (const [key, value] of writes)
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      for (const [key] of writes) localStorage.removeItem(key);
      for (const [key, value] of previous)
        if (value !== null) localStorage.setItem(key, value);
      throw error;
    }
    this.notify();
  }
}
