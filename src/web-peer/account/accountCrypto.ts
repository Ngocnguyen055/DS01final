import {
  accountVaultSchema,
  encryptedBackupSchema,
  type AccountVault,
  type EncryptedBackup,
} from "../../shared/accountProtocol.ts";
import {
  canonical,
  publicIdentitySchema,
  type DeviceIdentity,
} from "../../shared/secure.ts";
import { z } from "zod";

const utf8 = (value: string) => new TextEncoder().encode(value);
export class AccountCapacityError extends Error {}
export function encodeBytes(value: Uint8Array) {
  const parts: string[] = [];
  for (let at = 0; at < value.length; at += 16384)
    parts.push(String.fromCharCode(...value.subarray(at, at + 16384)));
  return btoa(parts.join(""));
}
export const decodeBytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
async function passwordKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      iterations: 600000,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealAccountData(
  key: CryptoKey,
  context: string,
  value: unknown,
): Promise<EncryptedBackup> {
  const bytes = utf8(JSON.stringify(value));
  if (bytes.length > 16 * 1024 * 1024)
    throw new AccountCapacityError(
      "Dữ liệu đồng bộ vượt 16 MiB. Hãy xuất lịch sử và giảm các file đính kèm trước khi đồng bộ.",
    );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(context) },
    key,
    bytes,
  );
  return encryptedBackupSchema.parse({
    v: 1,
    iv: encodeBytes(iv),
    ciphertext: encodeBytes(new Uint8Array(encrypted)),
  });
}
export async function openAccountData(
  key: CryptoKey,
  context: string,
  input: unknown,
): Promise<unknown> {
  const value = encryptedBackupSchema.parse(input);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBytes(value.iv),
      additionalData: utf8(context),
    },
    key,
    decodeBytes(value.ciphertext),
  );
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(decrypted),
  );
}
const privateKeySchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().length(43),
  y: z.string().length(43),
  d: z.string().length(43),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).optional(),
});
const bundleSchema = z
  .object({
    encryption: privateKeySchema,
    signing: privateKeySchema,
    syncSecret: z.string().length(44),
  })
  .strict();
type Bundle = z.infer<typeof bundleSchema>;
async function importBundle(
  value: Bundle,
): Promise<{ identity: DeviceIdentity; syncKey: CryptoKey }> {
  const clean = (key: JsonWebKey) =>
    publicIdentitySchema.shape.encryptionKey.parse({
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      y: key.y,
    });
  const encryptionPrivate = await crypto.subtle.importKey(
    "jwk",
    value.encryption,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const signingPrivate = await crypto.subtle.importKey(
    "jwk",
    value.signing,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const syncKey = await crypto.subtle.importKey(
    "raw",
    decodeBytes(value.syncSecret),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return {
    identity: {
      public: {
        encryptionKey: clean(value.encryption),
        signingKey: clean(value.signing),
      },
      encryptionPrivate,
      signingPrivate,
    },
    syncKey,
  };
}
function vaultContext(
  peerId: string,
  vault: Pick<AccountVault, "id" | "publicIdentity">,
) {
  return `DS01 account vault v1:${peerId}:${vault.id}:${canonical(vault.publicIdentity)}`;
}
export async function createAccountVault(peerId: string, password: string) {
  const encryption = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const bundle = bundleSchema.parse({
    encryption: await crypto.subtle.exportKey("jwk", encryption.privateKey),
    signing: await crypto.subtle.exportKey("jwk", signing.privateKey),
    syncSecret: encodeBytes(crypto.getRandomValues(new Uint8Array(32))),
  });
  const imported = await importBundle(bundle),
    salt = crypto.getRandomValues(new Uint8Array(16));
  const metadata = {
    v: 1 as const,
    id: crypto.randomUUID(),
    publicIdentity: imported.identity.public,
    iterations: 600000 as const,
    salt: encodeBytes(salt),
  };
  const key = await passwordKey(password, salt);
  const vault = accountVaultSchema.parse({
    ...metadata,
    sealed: await sealAccountData(key, vaultContext(peerId, metadata), bundle),
  });
  return { vault, ...imported };
}
export async function unlockAccountVault(
  peerId: string,
  password: string,
  input: unknown,
) {
  const vault = accountVaultSchema.parse(input);
  const key = await passwordKey(password, decodeBytes(vault.salt));
  const bundle = bundleSchema.parse(
    await openAccountData(key, vaultContext(peerId, vault), vault.sealed),
  );
  const imported = await importBundle(bundle);
  if (canonical(imported.identity.public) !== canonical(vault.publicIdentity))
    throw Error("Khóa tài khoản không khớp bản sao bảo mật.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const publicSigning = await crypto.subtle.importKey(
    "jwk",
    imported.identity.public.signingKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    imported.identity.signingPrivate,
    challenge,
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicSigning,
      signature,
      challenge,
    ))
  )
    throw Error("Bản sao khóa ký không hợp lệ.");
  const probe = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicEncryption = await crypto.subtle.importKey(
    "jwk",
    imported.identity.public.encryptionKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const first = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: probe.publicKey },
      imported.identity.encryptionPrivate,
      256,
    ),
  );
  const second = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicEncryption },
      probe.privateKey,
      256,
    ),
  );
  if (first.some((byte, at) => byte !== second[at]))
    throw Error("Bản sao khóa mã hóa không hợp lệ.");
  return { vault, ...imported };
}
