import { z } from "zod";
import { AtomicState } from "../server-kit/runtime.ts";
import {
  canonical,
  parseWireMessage,
  type WireMessage,
} from "../shared/secure.ts";
import { superPeerSchema } from "../shared/overlayProtocol.ts";

export const journalEntrySchema = z
  .object({
    key: z.string().min(1).max(200),
    kind: z.enum(["mail", "candidate"]),
    clock: z.number().int().nonnegative().safe(),
    origin: z.string().min(1).max(100),
    expiresAt: z.number().int().positive().safe(),
    deleted: z.boolean(),
    value: z.unknown().optional(),
  })
  .strict();
export type JournalEntry = z.infer<typeof journalEntrySchema>;
export type Candidate = { peerId: string; url: string; leaseUntil: number };
const snapshotSchema = z
  .object({
    clock: z.number().int().nonnegative().safe(),
    entries: z.array(journalEntrySchema).max(20000),
  })
  .strict();
export class RelayJournal {
  readonly entries = new Map<string, JournalEntry>();
  private clock = 0;
  private state: AtomicState<z.infer<typeof snapshotSchema>>;
  constructor(
    readonly nodeId: string,
    path?: string,
    private maxPending = 500,
  ) {
    this.state = new AtomicState(path);
    const restored = this.state.read((value) => snapshotSchema.parse(value));
    if (restored) {
      this.clock = restored.clock;
      for (const entry of restored.entries)
        this.entries.set(entry.key, this.validate(entry));
    }
    this.prune();
  }
  private validate(input: unknown) {
    const entry = journalEntrySchema.parse(input);
    if (!entry.deleted) {
      if (entry.kind === "mail") {
        const packet = parseWireMessage(entry.value);
        if (
          entry.key !==
          this.mailKey(packet.senderId, packet.messageId, packet.receiverId)
        )
          throw Error("replica mail key mismatch");
      } else {
        const value = superPeerSchema.parse(entry.value);
        if (
          entry.key !== `candidate:${value.peerId}` ||
          value.leaseUntil !== entry.expiresAt
        )
          throw Error("invalid relay candidate");
      }
    }
    return entry;
  }
  private persist() {
    this.state.write({
      clock: this.clock,
      entries: [...this.entries.values()],
    });
  }
  private write(
    kind: JournalEntry["kind"],
    key: string,
    value: unknown,
    expiresAt: number,
    deleted = false,
  ) {
    if (this.entries.size >= 20000 && !this.entries.has(key))
      throw Error("relay state capacity reached");
    const entry = this.validate({
      key,
      kind,
      clock: ++this.clock,
      origin: this.nodeId,
      expiresAt,
      deleted,
      ...(value === undefined ? {} : { value }),
    });
    const previous = this.entries.get(key);
    this.entries.set(key, entry);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.entries.set(key, previous);
      else this.entries.delete(key);
      throw error;
    }
    return entry;
  }
  merge(input: unknown[]) {
    const next = new Map(this.entries),
      previousClock = this.clock;
    let changed = false;
    for (const raw of input) {
      const entry = this.validate(raw);
      if (entry.expiresAt <= Date.now()) continue;
      this.clock = Math.max(this.clock, entry.clock);
      const prior = next.get(entry.key);
      const newer =
        !prior ||
        (entry.kind === "mail" && entry.deleted !== prior.deleted
          ? entry.deleted
          : entry.clock > prior.clock ||
            (entry.clock === prior.clock && entry.origin > prior.origin));
      if (newer) {
        if (next.size >= 20000 && !next.has(entry.key))
          throw Error("replica state capacity reached");
        next.set(entry.key, entry);
        changed = true;
      }
    }
    if (!changed) return false;
    const previous = new Map(this.entries);
    this.entries.clear();
    next.forEach((value, key) => this.entries.set(key, value));
    try {
      this.persist();
    } catch (error) {
      this.entries.clear();
      previous.forEach((value, key) => this.entries.set(key, value));
      this.clock = previousClock;
      throw error;
    }
    return true;
  }
  mailKey(sender: string, id: string, receiver: string) {
    return `mail:${sender}:${id}:${receiver}`;
  }
  enqueue(packet: WireMessage, ttlMs = 86400000) {
    this.prune();
    const key = this.mailKey(
        packet.senderId,
        packet.messageId,
        packet.receiverId,
      ),
      existing = this.entries.get(key);
    if (existing) {
      if (existing.deleted) return existing;
      const prior = parseWireMessage(existing.value);
      const event = (value: WireMessage) =>
        value.type === "sealed"
          ? value.eventTag
          : canonical({
              ...value,
              mode: undefined,
              attempt: undefined,
              ackRequested: undefined,
            });
      if (event(prior) !== event(packet))
        throw Error("conflicting queued message ID");
      return existing;
    }
    if (this.pending().length >= this.maxPending)
      throw Error("offline mailbox full");
    return this.write("mail", key, packet, Date.now() + ttlMs);
  }
  acknowledge(senderId: string, ackFor: string, receiverId: string) {
    return this.write(
      "mail",
      this.mailKey(senderId, ackFor, receiverId),
      undefined,
      Date.now() + 7 * 86400000,
      true,
    );
  }
  pending(peerId?: string) {
    return [...this.entries.values()].filter(
      (entry) =>
        entry.kind === "mail" &&
        !entry.deleted &&
        entry.expiresAt > Date.now() &&
        (!peerId || parseWireMessage(entry.value).receiverId === peerId),
    );
  }
  offer(candidate: Candidate) {
    return this.write(
      "candidate",
      `candidate:${candidate.peerId}`,
      candidate,
      candidate.leaseUntil,
    );
  }
  leader() {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.kind === "candidate" &&
          !entry.deleted &&
          entry.expiresAt > Date.now(),
      )
      .map((entry) => entry.value as Candidate)
      .sort((a, b) =>
        a.peerId > b.peerId ? -1 : a.peerId < b.peerId ? 1 : 0,
      )[0];
  }
  prune() {
    let changed = false;
    for (const [key, value] of this.entries)
      if (value.expiresAt <= Date.now()) {
        this.entries.delete(key);
        changed = true;
      }
    if (changed) this.persist();
  }
  page(after = "") {
    const rows = [...this.entries.values()]
      .filter((entry) => entry.key > after)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, 24);
    return {
      entries: rows,
      after: rows.length === 24 ? rows.at(-1)!.key : null,
    };
  }
}
