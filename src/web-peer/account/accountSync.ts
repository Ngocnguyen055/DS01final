import type { LoginSession } from "./auth.ts";
import { WebStore } from "../storage/store.ts";
import {
  createAccountVault,
  unlockAccountVault,
  sealAccountData,
  openAccountData,
  AccountCapacityError,
} from "./accountCrypto.ts";
import { canonical, signIdentity } from "../../shared/secure.ts";
import {
  accountVaultSchema,
  rotationStatement,
  type AccountVault,
  type EncryptedBackup,
} from "../../shared/accountProtocol.ts";

export class AccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function accountRequest(
  url: string,
  token: string,
  path: "vault" | "backup",
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(`${url.replace(/\/$/, "")}/account/${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    cache: "no-store",
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new AccountApiError(
      "Dịch vụ đồng bộ chưa phản hồi hợp lệ. Dữ liệu cục bộ vẫn được giữ; hãy thử lại sau.",
      response.ok ? 503 : response.status,
    );
  }
  if (!response.ok)
    throw new AccountApiError(
      result.error || "Không kết nối được dịch vụ đồng bộ.",
      response.status,
    );
  return result;
}
export type AccountSyncState = {
  phase: "loading" | "syncing" | "synced" | "waiting";
  detail?: string;
  at?: number;
};
export class AccountSync {
  private version = 0;
  private dirty = false;
  private closed = false;
  private restoring = false;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retryMs = 1000;
  private controller = new AbortController();
  private constructor(
    private url: string,
    private session: LoginSession,
    private store: WebStore,
    private vault: AccountVault,
    private key: CryptoKey,
    private emit: (state: AccountSyncState) => void,
    private restored: () => void,
  ) {}
  static async open(
    url: string,
    session: LoginSession,
    store: WebStore,
    password: string | undefined,
    confirmReset: () => boolean,
    emit: (state: AccountSyncState) => void,
    restored = () => {},
    signal?: AbortSignal,
  ) {
    emit({ phase: "loading" });
    const request = (path: "vault" | "backup", body?: unknown) =>
      accountRequest(url, session.token, path, body, signal);
    let result = await request("vault");
    let vault: AccountVault, key: CryptoKey;
    const existing = await store.getIdentity(),
      cached = await store.getAccountKeys();
    if (
      result.vault &&
      existing &&
      cached &&
      cached.vaultId === result.vault.id &&
      canonical(existing.public) === canonical(result.vault.publicIdentity)
    ) {
      vault = accountVaultSchema.parse(result.vault);
      key = cached.key;
    } else {
      if (!password)
        throw Error(
          "Hãy đăng nhập lại để mở bản sao bảo mật trên thiết bị này.",
        );
      if (!result.vault) {
        const created = await createAccountVault(
          session.account.peerId,
          password,
        );
        const signature =
          existing &&
          result.legacyKey &&
          canonical(existing.public) === canonical(result.legacyKey)
            ? await signIdentity(
                existing,
                rotationStatement(session.account.peerId, created.vault),
              )
            : undefined;
        signal?.throwIfAborted();
        try {
          await request("vault", {
            vault: created.vault,
            ...(signature ? { rotationSignature: signature } : {}),
          });
        } catch (error) {
          if (
            error instanceof AccountApiError &&
            error.message === "LEGACY_KEY_CONFIRMATION_REQUIRED"
          ) {
            if (!confirmReset())
              throw Error(
                "Chưa chuyển khóa. Hãy đăng nhập tại thiết bị/địa chỉ cũ để giữ quyền truy cập khóa cũ.",
              );
            await request("vault", {
              vault: created.vault,
              resetLegacyKey: true,
            });
          } else if (!(
            error instanceof AccountApiError && error.message === "VAULT_EXISTS"
          ))
            throw error;
        }
        result = await request("vault");
      }
      const unlocked = await unlockAccountVault(
        session.account.peerId,
        password,
        result.vault,
      );
      signal?.throwIfAborted();
      vault = unlocked.vault;
      key = unlocked.syncKey;
      await store.putIdentity(unlocked.identity);
      await store.putAccountKeys(vault.id, key);
    }
    signal?.throwIfAborted();
    const sync = new AccountSync(
      url,
      session,
      store,
      vault,
      key,
      emit,
      restored,
    );
    signal?.addEventListener("abort", () => sync.close(), { once: true });
    try {
      await sync.pull();
    } catch (error) {
      sync.emit({
        phase: "waiting",
        detail: error instanceof Error ? error.message : "Chờ kết nối.",
      });
    }
    sync.schedule();
    return sync;
  }
  private context() {
    return `DS01 encrypted history v1:${this.session.account.peerId}:${this.vault.id}`;
  }
  private async pull() {
    const result: { version: number; sealed: EncryptedBackup | null } =
      await accountRequest(
        this.url,
        this.session.token,
        "backup",
        undefined,
        this.controller.signal,
      );
    if (!Number.isSafeInteger(result.version) || result.version < 0)
      throw Error("Phiên bản dữ liệu đồng bộ không hợp lệ.");
    if (result.sealed) {
      const snapshot = await openAccountData(
        this.key,
        this.context(),
        result.sealed,
      );
      this.controller.signal.throwIfAborted();
      this.restoring = true;
      try {
        await this.store.restore(snapshot, () => this.closed);
        this.restored();
      } finally {
        this.restoring = false;
      }
    }
    this.version = result.version;
  }
  schedule() {
    if (this.closed || this.restoring) return;
    this.dirty = true;
    clearTimeout(this.timer);
    this.emit({ phase: "syncing" });
    this.timer = setTimeout(() => {
      void this.flush();
    }, 300);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.closed) return;
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        let conflicts = 0;
        while (this.dirty && !this.closed) {
          this.dirty = false;
          const sealed = await sealAccountData(
            this.key,
            this.context(),
            await this.store.snapshot(),
          );
          try {
            const result = await accountRequest(
              this.url,
              this.session.token,
              "backup",
              { expectedVersion: this.version, sealed },
              this.controller.signal,
            );
            if (
              !Number.isSafeInteger(result.version) ||
              result.version !== this.version + 1
            )
              throw Error("Phiên bản đồng bộ không khớp.");
            this.version = result.version;
          } catch (error) {
            if (
              !(error instanceof AccountApiError && error.status === 409) ||
              ++conflicts > 3
            )
              throw error;
            await this.pull();
            this.dirty = true;
          }
        }
        this.retryMs = 1000;
        if (!this.closed) this.emit({ phase: "synced", at: Date.now() });
      } catch (error) {
        this.dirty = true;
        if (!this.closed) {
          this.emit({
            phase: "waiting",
            detail:
              error instanceof Error ? error.message : "Chờ mạng để đồng bộ.",
          });
          if (
            !(error instanceof AccountCapacityError) &&
            !(
              error instanceof AccountApiError &&
              [400, 401, 413].includes(error.status)
            )
          ) {
            this.timer = setTimeout(() => {
              void this.flush();
            }, this.retryMs);
            this.retryMs = Math.min(this.retryMs * 2, 30000);
          }
        }
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
  }
}
