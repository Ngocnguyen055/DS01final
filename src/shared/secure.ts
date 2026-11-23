import { z } from "zod";
import {
  MAX_WIRE_BYTES,
  parseMessage,
  peerIdSchema,
  idSchema,
  type ChatMessage,
} from "./protocol.ts";
import {
  mediaFrameSchema,
  type MediaCipher,
  type MediaFrame,
} from "./mediaProtocol.ts";

export const publicKeySchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const publicIdentitySchema = z
  .object({ encryptionKey: publicKeySchema, signingKey: publicKeySchema })
  .strict();
export type PublicIdentity = z.infer<typeof publicIdentitySchema>;
export type DeviceIdentity = {
  public: PublicIdentity;
  encryptionPrivate: CryptoKey;
  signingPrivate: CryptoKey;
};
export interface IdentityStore {
  getIdentity(): Promise<DeviceIdentity | undefined>;
  putIdentity(value: DeviceIdentity): Promise<void>;
  getPin(peerId: string): Promise<PublicIdentity | undefined>;
  putPin(peerId: string, value: PublicIdentity): Promise<void>;
}
export const MAX_SEALED_WIRE_BYTES = 16384;
export const sealedSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("sealed"),
    traffic: z.enum(["message", "file-chunk", "ack"]),
    messageId: idSchema,
    sessionId: idSchema,
    senderId: peerIdSchema,
    receiverId: peerIdSchema,
    groupId: idSchema.nullish(),
    timestamp: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe(),
    mode: z.enum(["DIRECT", "RELAY", "TURN"]),
    attempt: z.number().int().min(1).max(3),
    ackFor: idSchema.optional(),
    senderKey: z.string().regex(/^[a-f0-9]{64}$/),
    receiverKey: z.string().regex(/^[a-f0-9]{64}$/),
    eventTag: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    ciphertext: z
      .string()
      .min(24)
      .max(12000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type SealedMessage = z.infer<typeof sealedSchema>;
export type WireMessage = ChatMessage | SealedMessage;
export function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([, value]) => value !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, normalize(value)]),
          )
        : item;
  return JSON.stringify(normalize(value));
}
const utf8 = (value: string) => new TextEncoder().encode(value);
export const toBase64 = (value: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(value)));
export const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
export async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", utf8(canonical(value)));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
export async function createIdentity(): Promise<DeviceIdentity> {
  const encryption = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const clean = (key: JsonWebKey) =>
    publicKeySchema.parse({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
  return {
    public: {
      encryptionKey: clean(
        await crypto.subtle.exportKey("jwk", encryption.publicKey),
      ),
      signingKey: clean(
        await crypto.subtle.exportKey("jwk", signing.publicKey),
      ),
    },
    encryptionPrivate: encryption.privateKey,
    signingPrivate: signing.privateKey,
  };
}
export async function signIdentity(identity: DeviceIdentity, value: unknown) {
  return toBase64(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.signingPrivate,
      utf8(canonical(value)),
    ),
  );
}
export async function verifyIdentity(
  identity: PublicIdentity,
  value: unknown,
  signature: string,
) {
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.signingKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64(signature),
    utf8(canonical(value)),
  );
}
export async function validatePublicIdentity(input: unknown) {
  const identity = publicIdentitySchema.parse(input);
  await crypto.subtle.importKey(
    "jwk",
    identity.encryptionKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  await crypto.subtle.importKey(
    "jwk",
    identity.signingKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return identity;
}
export function parseWireMessage(input: unknown): WireMessage {
  if (
    input &&
    typeof input === "object" &&
    "type" in input &&
    input.type === "sealed"
  ) {
    if (utf8(JSON.stringify(input)).length > MAX_SEALED_WIRE_BYTES)
      throw Error("encrypted message too large");
    return sealedSchema.parse(input);
  }
  return parseMessage(input);
}
function event(message: ChatMessage) {
  return Object.fromEntries(
    Object.entries(message).filter(
      ([key]) => !["mode", "attempt", "ackRequested"].includes(key),
    ),
  );
}
function header(message: SealedMessage) {
  return Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== "ciphertext"),
  );
}
export class SecureChannel {
  private identity?: Promise<DeviceIdentity>;
  private peers = new Map<string, PublicIdentity>();
  constructor(
    private peerId: string,
    private lookup: (peerId: string) => Promise<PublicIdentity>,
    private store?: IdentityStore,
  ) {}
  getIdentity() {
    this.identity ??= (async () => {
      const existing = await this.store?.getIdentity();
      if (existing) return existing;
      const value = await createIdentity();
      await this.store?.putIdentity(value);
      return value;
    })();
    return this.identity;
  }
  async publicIdentity() {
    return (await this.getIdentity()).public;
  }
  invalidatePeer(peerId: string) {
    this.peers.delete(peerId);
  }
  invalidatePeers() {
    this.peers.clear();
  }
  async inspectPeerIdentity(peerId: string) {
    return publicIdentitySchema.parse(await this.lookup(peerId));
  }
  async acceptPeerIdentity(peerId: string, expected: PublicIdentity) {
    const value = await this.inspectPeerIdentity(peerId);
    if (canonical(value) !== canonical(expected))
      throw Error("peer security key changed during verification");
    await this.store?.putPin(peerId, value);
    this.peers.set(peerId, value);
  }
  async peerIdentity(peerId: string) {
    let value = this.peers.get(peerId);
    if (!value) {
      value = publicIdentitySchema.parse(await this.lookup(peerId));
      const pin = await this.store?.getPin(peerId);
      if (pin && canonical(pin) !== canonical(value))
        throw Error(
          "peer security key changed; verify identity before continuing",
        );
      await this.store?.putPin(peerId, value);
      this.peers.set(peerId, value);
    }
    return value;
  }
  private async keys(peerId: string) {
    const self = await this.getIdentity(),
      remote = await this.peerIdentity(peerId);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      remote.encryptionKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      self.encryptionPrivate,
      256,
    );
    const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
      "deriveKey",
    ]);
    const identities = [
      await fingerprint(self.public),
      await fingerprint(remote),
    ].sort();
    const base = {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("DS01 E2EE v1"),
      info: utf8(identities.join(":")),
    };
    return {
      self,
      remote,
      aes: await crypto.subtle.deriveKey(
        base,
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
      mac: await crypto.subtle.deriveKey(
        { ...base, info: utf8("event:" + identities.join(":")) },
        material,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      ),
    };
  }
  async mediaCipher(peerId: string, callId: string): Promise<MediaCipher> {
    z.string().uuid().parse(callId);
    const self = await this.getIdentity(),
      remote = await this.peerIdentity(peerId);
    const key = await crypto.subtle.importKey(
      "jwk",
      remote.encryptionKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: key },
      self.encryptionPrivate,
      256,
    );
    const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
      "deriveKey",
    ]);
    const identities = [
      await fingerprint(self.public),
      await fingerprint(remote),
    ].sort();
    const aes = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: utf8("DS01 media v1:" + callId),
        info: utf8(identities.join(":")),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const aad = (frame: MediaFrame) =>
      utf8(
        canonical(
          Object.fromEntries(
            Object.entries(frame).filter(([key]) => key !== "ciphertext"),
          ),
        ),
      );
    return {
      seal: async (kind, sequence, data) => {
        if (data.length > 11000) throw Error("media frame too large");
        const frame: MediaFrame = {
          v: 1,
          callId,
          senderId: this.peerId,
          receiverId: peerId,
          kind,
          sequence,
          iv: toBase64(crypto.getRandomValues(new Uint8Array(12))),
          ciphertext: "",
        };
        frame.ciphertext = toBase64(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: fromBase64(frame.iv),
              additionalData: aad(frame),
            },
            aes,
            new Uint8Array(data),
          ),
        );
        return mediaFrameSchema.parse(frame);
      },
      open: async (input) => {
        const frame = mediaFrameSchema.parse(input);
        if (
          frame.callId !== callId ||
          frame.senderId !== peerId ||
          frame.receiverId !== this.peerId
        )
          throw Error("media identity mismatch");
        return new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: fromBase64(frame.iv),
              additionalData: aad(frame),
            },
            aes,
            fromBase64(frame.ciphertext),
          ),
        );
      },
    };
  }
  async seal(input: ChatMessage): Promise<SealedMessage> {
    const message = parseMessage(input);
    if (message.senderId !== this.peerId)
      throw Error("cannot encrypt for another sender");
    const keys = await this.keys(message.receiverId);
    const outer: SealedMessage = {
      v: 1,
      type: "sealed",
      traffic:
        message.type === "file-chunk"
          ? "file-chunk"
          : message.type === "ack"
            ? "ack"
            : "message",
      messageId: message.messageId,
      sessionId: message.sessionId,
      senderId: message.senderId,
      receiverId: message.receiverId,
      ...(message.groupId != null ? { groupId: message.groupId } : {}),
      timestamp: message.timestamp,
      sequence: message.sequence,
      mode: message.mode,
      attempt: message.attempt,
      ...(message.ackFor ? { ackFor: message.ackFor } : {}),
      senderKey: await fingerprint(keys.self.public),
      receiverKey: await fingerprint(keys.remote),
      eventTag: toBase64(
        await crypto.subtle.sign(
          "HMAC",
          keys.mac,
          utf8(canonical(event(message))),
        ),
      ),
      iv: toBase64(crypto.getRandomValues(new Uint8Array(12))),
      ciphertext: "",
    };
    outer.ciphertext = toBase64(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(outer.iv),
          additionalData: utf8(canonical(header(outer))),
        },
        keys.aes,
        utf8(JSON.stringify(message)),
      ),
    );
    return sealedSchema.parse(parseWireMessage(outer));
  }
  async open(input: unknown): Promise<ChatMessage> {
    const outer = sealedSchema.parse(parseWireMessage(input));
    if (outer.receiverId !== this.peerId)
      throw Error("encrypted receiver mismatch");
    const keys = await this.keys(outer.senderId);
    if (
      outer.senderKey !== (await fingerprint(keys.remote)) ||
      outer.receiverKey !== (await fingerprint(keys.self.public))
    )
      throw Error("encrypted identity mismatch");
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(outer.iv),
        additionalData: utf8(canonical(header(outer))),
      },
      keys.aes,
      fromBase64(outer.ciphertext),
    );
    if (bytes.byteLength > MAX_WIRE_BYTES)
      throw Error("decrypted message too large");
    const message = parseMessage(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      outer.traffic !==
      (message.type === "file-chunk"
        ? "file-chunk"
        : message.type === "ack"
          ? "ack"
          : "message")
    )
      throw Error("encrypted traffic metadata mismatch");
    for (const field of [
      "messageId",
      "sessionId",
      "senderId",
      "receiverId",
      "timestamp",
      "sequence",
      "mode",
      "attempt",
      "groupId",
      "ackFor",
    ] as const)
      if ((message[field] ?? null) !== (outer[field] ?? null))
        throw Error("encrypted routing metadata mismatch");
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        keys.mac,
        fromBase64(outer.eventTag),
        utf8(canonical(event(message))),
      ))
    )
      throw Error("encrypted event identity mismatch");
    return message;
  }
}
