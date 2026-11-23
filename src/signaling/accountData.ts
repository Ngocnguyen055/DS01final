import type { Express, Request, Response, NextFunction } from "express";
import { join } from "node:path";
import { z } from "zod";
import { AtomicState, serviceLog } from "../server-kit/runtime.ts";
import {
  accountVaultSchema,
  encryptedBackupSchema,
  rotationStatement,
  type AccountVault,
} from "../shared/accountProtocol.ts";
import {
  canonical,
  publicIdentitySchema,
  validatePublicIdentity,
  verifyIdentity,
  type PublicIdentity,
} from "../shared/secure.ts";
import type { Accounts } from "./accounts.ts";
import type { KeyDirectory } from "./keyDirectory.ts";
import express from "express";

const stateSchema = z
  .object({
    vault: accountVaultSchema,
    previousKey: publicIdentitySchema.optional(),
    rotationSignature: z.string().max(256).optional(),
    backup: z
      .object({
        version: z.number().int().nonnegative(),
        sealed: encryptedBackupSchema,
      })
      .optional(),
  })
  .strict();
type AccountDataState = z.infer<typeof stateSchema>;
export class AccountData {
  private states = new Map<string, AccountDataState>();
  constructor(private directory?: string) {}
  private disk(peerId: string) {
    if (!/^user_[a-z0-9_-]{3,24}$/.test(peerId))
      throw Error("Invalid account identity");
    return new AtomicState<AccountDataState>(
      this.directory ? join(this.directory, `${peerId}.json`) : undefined,
    );
  }
  get(peerId: string) {
    if (!/^user_[a-z0-9_-]{3,24}$/.test(peerId)) return;
    if (!this.states.has(peerId)) {
      const value = this.disk(peerId).read((input) => stateSchema.parse(input));
      if (value) this.states.set(peerId, value);
    }
    return this.states.get(peerId);
  }
  create(peerId: string, value: AccountDataState) {
    if (this.get(peerId)) throw Error("VAULT_EXISTS");
    const parsed = stateSchema.parse(value);
    this.disk(peerId).write(parsed);
    this.states.set(peerId, parsed);
  }
  backup(peerId: string, expectedVersion: number, input: unknown) {
    const value = this.get(peerId);
    if (!value) throw Error("VAULT_REQUIRED");
    if ((value.backup?.version || 0) !== expectedVersion)
      throw Error("VERSION_CONFLICT");
    const next = {
      ...value,
      backup: {
        version: expectedVersion + 1,
        sealed: encryptedBackupSchema.parse(input),
      },
    };
    this.disk(peerId).write(next);
    this.states.set(peerId, next);
    return next.backup.version;
  }
}
export function registerAccountData(
  app: Express,
  accounts: Accounts,
  data: AccountData,
  keys: KeyDirectory,
) {
  const requests = new Map<string, { since: number; count: number }>();
  const reject = (error: unknown, response: Response) => {
    const message = error instanceof Error ? error.message : "";
    if (message === "VERSION_CONFLICT" || message === "VAULT_EXISTS") {
      response.status(409).json({ error: message });
      return;
    }
    if (
      error instanceof z.ZodError ||
      (error instanceof DOMException &&
        ["DataError", "OperationError", "InvalidAccessError"].includes(
          error.name,
        )) ||
      message === "VAULT_REQUIRED"
    ) {
      response.status(400).json({ error: "Dữ liệu đồng bộ không hợp lệ." });
      return;
    }
    serviceLog("account", "STORAGE_ERROR", "Account data request failed");
    response
      .status(503)
      .json({
        error:
          "Chưa đọc hoặc lưu được bản sao tài khoản. Dữ liệu trên thiết bị vẫn được giữ; hãy thử lại sau.",
      });
  };
  const authenticate = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    try {
      const session = accounts.resolve(
        request.header("authorization")?.replace(/^Bearer /, ""),
      );
      response.locals.accountSession = session;
      const now = Date.now(),
        peerId = session.account.peerId;
      for (const [id, value] of requests)
        if (now - value.since >= 60000) requests.delete(id);
      const rate = requests.get(peerId) || { since: now, count: 0 };
      if (
        ++rate.count > 240 ||
        (!requests.has(peerId) && requests.size >= 10000)
      ) {
        response.setHeader("Retry-After", "60");
        response
          .status(429)
          .json({ error: "Đồng bộ quá nhanh. Hãy chờ một phút rồi thử lại." });
        return;
      }
      requests.set(peerId, rate);
      next();
    } catch {
      response
        .status(401)
        .json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." });
    }
  };
  app.use("/account", authenticate);
  app.get("/account/vault", (_request, response) => {
    const peerId = response.locals.accountSession.account.peerId;
    response.json({
      vault: data.get(peerId)?.vault || null,
      legacyKey: keys.get(peerId) || null,
    });
  });
  app.put(
    "/account/vault",
    express.json({ limit: "32kb" }),
    async (request, response) => {
      try {
        const session = response.locals.accountSession,
          peerId: string = session.account.peerId;
        const parsed = z
          .object({
            vault: accountVaultSchema,
            rotationSignature: z.string().max(256).optional(),
            resetLegacyKey: z.boolean().optional(),
          })
          .strict()
          .parse(request.body);
        await validatePublicIdentity(parsed.vault.publicIdentity);
        accounts.resolve(
          request.header("authorization")?.replace(/^Bearer /, ""),
        );
        if (data.get(peerId)) {
          response.status(409).json({ error: "VAULT_EXISTS" });
          return;
        }
        const previousKey = keys.get(peerId);
        if (
          previousKey &&
          canonical(previousKey) !== canonical(parsed.vault.publicIdentity)
        ) {
          const signed =
            parsed.rotationSignature &&
            (await verifyIdentity(
              previousKey,
              rotationStatement(peerId, parsed.vault),
              parsed.rotationSignature,
            ));
          if (
            !signed &&
            (!parsed.resetLegacyKey || Date.now() - session.issuedAt > 120000)
          ) {
            response
              .status(409)
              .json({ error: "LEGACY_KEY_CONFIRMATION_REQUIRED" });
            return;
          }
        }
        accounts.resolve(
          request.header("authorization")?.replace(/^Bearer /, ""),
        );
        data.create(peerId, {
          vault: parsed.vault,
          ...(previousKey ? { previousKey } : {}),
          ...(parsed.rotationSignature
            ? { rotationSignature: parsed.rotationSignature }
            : {}),
        });
        keys.notifyChange(peerId);
        serviceLog(
          "account",
          previousKey ? "VAULT_MIGRATED" : "VAULT_CREATED",
          peerId,
        );
        response.status(201).json({ ok: true });
      } catch (error) {
        reject(error, response);
      }
    },
  );
  app.get("/account/backup", (_request, response) => {
    const value = data.get(response.locals.accountSession.account.peerId);
    response.json(value?.backup || { version: 0, sealed: null });
  });
  app.put(
    "/account/backup",
    express.json({ limit: "25mb" }),
    (request, response) => {
      try {
        const peerId: string = response.locals.accountSession.account.peerId;
        const parsed = z
          .object({
            expectedVersion: z.number().int().nonnegative(),
            sealed: encryptedBackupSchema,
          })
          .strict()
          .parse(request.body);
        const version = data.backup(
          peerId,
          parsed.expectedVersion,
          parsed.sealed,
        );
        serviceLog("account", "BACKUP_SAVED", `${peerId} version=${version}`);
        response.json({ version });
      } catch (error) {
        reject(error, response);
      }
    },
  );
  app.use(
    "/account",
    (
      error: { type?: string },
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (
        error.type === "entity.too.large" ||
        error.type === "entity.parse.failed"
      ) {
        response
          .status(error.type === "entity.too.large" ? 413 : 400)
          .json({
            error:
              error.type === "entity.too.large"
                ? "Bản sao vượt giới hạn truyền 25 MiB."
                : "Dữ liệu đồng bộ không hợp lệ.",
          });
      } else reject(error, response);
    },
  );
}
export function accountRotation(value: ReturnType<AccountData["get"]>): {
  previousKey?: PublicIdentity;
  vault?: AccountVault;
  signature?: string;
} {
  return value
    ? {
        previousKey: value.previousKey,
        vault: value.vault,
        signature: value.rotationSignature,
      }
    : {};
}
