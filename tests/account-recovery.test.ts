import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { io, type Socket } from "socket.io-client";
import type { AddressInfo } from "node:net";
import { createSignaling } from "../src/signaling/index.ts";
import {
  createAccountVault,
  unlockAccountVault,
  sealAccountData,
  openAccountData,
} from "../src/web-peer/account/accountCrypto.ts";
import { createIdentity, canonical } from "../src/shared/secure.ts";
import {
  prepareData,
  acquireStorageLock,
  durableDemoSecrets,
} from "../src/server-kit/storagePaths.mjs";
import { mkdir } from "node:fs/promises";

const folders: string[] = [],
  sockets: Socket[] = [],
  services: ReturnType<typeof createSignaling>[] = [];
function folder() {
  const path = mkdtempSync(join(tmpdir(), "ds01-recovery-"));
  folders.push(path);
  return path;
}
const credentials = {
  username: "alice",
  password: "Account recovery password 2026!",
};
async function start(path?: string) {
  const service = createSignaling(
    undefined,
    undefined,
    undefined,
    path
      ? {
          statePath: join(path, "signaling.json"),
          accountStatePath: join(path, "accounts.json"),
        }
      : {},
  );
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return {
    service,
    url: `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`,
  };
}
async function socket(url: string) {
  const value = io(url, { reconnection: false });
  sockets.push(value);
  await new Promise<void>((resolve, reject) => {
    value.once("connect", resolve);
    value.once("connect_error", reject);
  });
  return value;
}
async function login(url: string, register = false, takeover = false) {
  const control = await socket(url);
  if (register)
    expect(
      (
        await control
          .timeout(5000)
          .emitWithAck("auth:register", {
            ...credentials,
            displayName: "Alice",
          })
      ).ok,
    ).toBe(true);
  const result = await control
    .timeout(5000)
    .emitWithAck("auth:login", { ...credentials, takeover });
  expect(result.ok).toBe(true);
  return result;
}
async function api(url: string, token: string, route: string, body?: unknown) {
  return fetch(url + "/account/" + route, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const service of services.splice(0)) await service.close();
  for (const path of folders.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith("ds01-recovery-")
    )
      throw Error("Unexpected cleanup path");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("account recovery and durable storage", () => {
  it("restores the same E2EE identity and encrypted data using a password on a fresh device", async () => {
    const first = await createAccountVault("user_alice", credentials.password),
      second = await unlockAccountVault(
        "user_alice",
        credentials.password,
        first.vault,
      );
    expect(canonical(second.identity.public)).toBe(
      canonical(first.identity.public),
    );
    expect(second.identity.encryptionPrivate.extractable).toBe(false);
    expect(second.identity.signingPrivate.extractable).toBe(false);
    const sealed = await sealAccountData(first.syncKey, "alice-history", {
      text: "private saved history",
    });
    expect(JSON.stringify(sealed)).not.toContain("private saved history");
    expect(
      await openAccountData(second.syncKey, "alice-history", sealed),
    ).toEqual({ text: "private saved history" });
    await expect(
      unlockAccountVault("user_alice", "a wrong password", first.vault),
    ).rejects.toThrow();
    await expect(
      unlockAccountVault("user_bob", credentials.password, first.vault),
    ).rejects.toThrow();
    await expect(
      openAccountData(second.syncKey, "other-context", sealed),
    ).rejects.toThrow();
  });

  it("preserves a vault and ciphertext backup across server restart and a new login", async () => {
    const directory = folder(),
      first = await start(directory),
      session = await login(first.url, true),
      created = await createAccountVault("user_alice", credentials.password);
    expect(
      (await api(first.url, session.token, "vault", { vault: created.vault }))
        .status,
    ).toBe(201);
    const sealed = await sealAccountData(created.syncKey, "test-history", {
      text: "persisted private message",
    });
    expect(
      (
        await api(first.url, session.token, "backup", {
          expectedVersion: 0,
          sealed,
        })
      ).ok,
    ).toBe(true);
    const disk = readFileSync(
      join(directory, "account-data/user_alice.json"),
      "utf8",
    );
    expect(disk).not.toContain(credentials.password);
    expect(disk).not.toContain("persisted private message");
    await first.service.close();
    services.splice(services.indexOf(first.service), 1);
    const next = await start(directory),
      second = await login(next.url),
      vault = await (await api(next.url, second.token, "vault")).json();
    const recovered = await unlockAccountVault(
      "user_alice",
      credentials.password,
      vault.vault,
    );
    const restored = await (await api(next.url, second.token, "backup")).json();
    expect(restored.version).toBe(1);
    expect(
      await openAccountData(recovered.syncKey, "test-history", restored.sealed),
    ).toEqual({ text: "persisted private message" });
    expect((await api(next.url, session.token, "backup")).status).toBe(401);
  }, 15000);

  it("rejects concurrent stale backup writes and unauthorized vault replacement", async () => {
    const { url } = await start(),
      session = await login(url, true),
      created = await createAccountVault("user_alice", credentials.password);
    expect(
      (await api(url, session.token, "vault", { vault: created.vault })).status,
    ).toBe(201);
    expect(
      (await api(url, session.token, "vault", { vault: created.vault })).status,
    ).toBe(409);
    const sealed = await sealAccountData(created.syncKey, "history", {
      value: 1,
    });
    const writes = await Promise.all([
      api(url, session.token, "backup", { expectedVersion: 0, sealed }),
      api(url, session.token, "backup", { expectedVersion: 0, sealed }),
    ]);
    expect(writes.map((value) => value.status).sort()).toEqual([200, 409]);
    expect((await api(url, "forged-token", "backup")).status).toBe(401);
    expect(
      (
        await api(url, session.token, "backup", {
          expectedVersion: 1,
          sealed,
          peerId: "user_bob",
        })
      ).status,
    ).toBe(400);
  }, 15000);

  it("requires password-authenticated explicit takeover and revokes the old online session", async () => {
    const { url } = await start(),
      session = await login(url, true),
      peer = await socket(url);
    expect(
      (
        await peer
          .timeout(3000)
          .emitWithAck("peer:register", {
            peerId: "user_alice",
            identityProof: session.token,
          })
      ).ok,
    ).toBe(true);
    const rejected = await socket(url);
    expect(
      (await rejected.timeout(5000).emitWithAck("auth:login", credentials)).ok,
    ).toBe(false);
    expect(
      (
        await rejected
          .timeout(5000)
          .emitWithAck("auth:login", {
            ...credentials,
            password: "incorrect-password",
            takeover: true,
          })
      ).ok,
    ).toBe(false);
    const expired = new Promise((resolve) =>
      peer.once("auth:expired", resolve),
    );
    const next = await login(url, false, true);
    await expired;
    expect((await api(url, session.token, "vault")).status).toBe(401);
    expect((await api(url, next.token, "vault")).status).toBe(200);
  }, 15000);

  it("requires explicit confirmation to replace a legacy device key and then pins the recoverable key", async () => {
    const { url } = await start(),
      session = await login(url, true),
      peer = await socket(url),
      legacy = await createIdentity();
    await peer
      .timeout(3000)
      .emitWithAck("peer:register", {
        peerId: "user_alice",
        identityProof: session.token,
      });
    expect(
      (await peer.timeout(3000).emitWithAck("key:publish", legacy.public)).ok,
    ).toBe(true);
    const created = await createAccountVault(
      "user_alice",
      credentials.password,
    );
    expect(
      (await api(url, session.token, "vault", { vault: created.vault })).status,
    ).toBe(409);
    expect(
      (
        await api(url, session.token, "vault", {
          vault: created.vault,
          resetLegacyKey: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (await peer.timeout(3000).emitWithAck("key:publish", legacy.public)).ok,
    ).toBe(false);
    expect(
      (
        await peer
          .timeout(3000)
          .emitWithAck("key:publish", created.identity.public)
      ).ok,
    ).toBe(true);
  }, 15000);

  it("imports old accounts once without changing password hashes or overwriting conflicts", async () => {
    const root = folder(),
      legacy = join(root, "legacy"),
      runtime = join(root, "runtime"),
      target = join(root, "data");
    await mkdir(legacy);
    await mkdir(runtime);
    const account = {
      username: "nabc",
      peerId: "user_nabc",
      displayName: "Nabc",
      salt: "a".repeat(32),
      passwordHash: "b".repeat(128),
      createdAt: 1,
    };
    writeFileSync(
      join(legacy, "signaling.json.accounts.json"),
      JSON.stringify({ version: 1, users: [account], sessions: [] }),
    );
    expect(
      (await prepareData(target, { legacyRoot: legacy, runtime })).migrated,
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(target, "accounts.json"), "utf8")).users,
    ).toEqual([account]);
    writeFileSync(
      join(legacy, "signaling.json.accounts.json"),
      JSON.stringify({
        version: 1,
        users: [{ ...account, passwordHash: "c".repeat(128) }],
        sessions: [],
      }),
    );
    await prepareData(target, { legacyRoot: legacy, runtime });
    expect(
      JSON.parse(readFileSync(join(target, "accounts.json"), "utf8")).users[0]
        .passwordHash,
    ).toBe(account.passwordHash);
    const secrets = await durableDemoSecrets(target, () => undefined);
    expect(await durableDemoSecrets(target, () => undefined)).toEqual(secrets);
  });

  it("prevents a second signaling writer and recovers a stale process lock", async () => {
    const root = folder(),
      release = await acquireStorageLock(root, "signaling");
    await expect(acquireStorageLock(root, "signaling")).rejects.toThrow(
      "already using",
    );
    await release();
    writeFileSync(
      join(root, "signaling.lock"),
      JSON.stringify({ pid: 2147483647, nonce: "stale" }),
    );
    const next = await acquireStorageLock(root, "signaling");
    await next();
  });
});
