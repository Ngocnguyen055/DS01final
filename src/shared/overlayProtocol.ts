import { z } from "zod";
import { peerIdSchema } from "./protocol.ts";
import {
  publicIdentitySchema,
  fingerprint,
  verifyIdentity,
  type DeviceIdentity,
  signIdentity,
} from "./secure.ts";

export const overlayRecordSchema = z
  .object({
    peerId: peerIdSchema,
    displayName: z.string().min(1).max(80),
    identity: publicIdentitySchema,
    relayUrls: z.array(z.string().url().max(256)).min(1).max(16),
    issuedAt: z.number().int().safe(),
    expiresAt: z.number().int().safe(),
    signature: z.string().max(100),
  })
  .strict();
export type OverlayRecord = z.infer<typeof overlayRecordSchema>;
export const superPeerSchema = z
  .object({
    peerId: peerIdSchema,
    url: z.string().url().max(256),
    leaseUntil: z.number().int().positive().safe(),
  })
  .strict();
export async function decentralizedPeerId(identity: DeviceIdentity) {
  return "p_" + (await fingerprint(identity.public.signingKey)).slice(0, 28);
}
export async function createOverlayRecord(
  identity: DeviceIdentity,
  displayName: string,
  relayUrls: string[],
  ttlMs = 60000,
): Promise<OverlayRecord> {
  const value = {
    peerId: await decentralizedPeerId(identity),
    displayName,
    identity: identity.public,
    relayUrls: [...new Set(relayUrls.map((url) => url.replace(/\/$/, "")))],
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  return overlayRecordSchema.parse({
    ...value,
    signature: await signIdentity(identity, value),
  });
}
export async function verifyOverlayRecord(
  input: unknown,
  allowExpired = false,
): Promise<OverlayRecord> {
  const record = overlayRecordSchema.parse(input),
    { signature, ...value } = record;
  if (
    (!allowExpired && record.expiresAt <= Date.now()) ||
    record.expiresAt <= record.issuedAt ||
    record.issuedAt > Date.now() + 10000 ||
    record.expiresAt - record.issuedAt > 90000 ||
    record.peerId !==
      "p_" + (await fingerprint(record.identity.signingKey)).slice(0, 28) ||
    !(await verifyIdentity(record.identity, value, signature))
  )
    throw Error("invalid decentralized peer identity");
  return record;
}
