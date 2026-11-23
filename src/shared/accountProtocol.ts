import { z } from "zod";
import { publicIdentitySchema } from "./secure.ts";

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const encryptedBackupSchema = z
  .object({
    v: z.literal(1),
    iv: base64.length(16),
    ciphertext: base64.min(24).max(24 * 1024 * 1024),
  })
  .strict();
export const accountVaultSchema = z
  .object({
    v: z.literal(1),
    id: z.string().uuid(),
    publicIdentity: publicIdentitySchema,
    iterations: z.literal(600000),
    salt: base64.length(24),
    sealed: encryptedBackupSchema,
  })
  .strict();
export type EncryptedBackup = z.infer<typeof encryptedBackupSchema>;
export type AccountVault = z.infer<typeof accountVaultSchema>;
export const rotationStatement = (peerId: string, vault: AccountVault) => ({
  action: "DS01_ACCOUNT_VAULT_V1",
  peerId,
  vaultId: vault.id,
  publicIdentity: vault.publicIdentity,
});
