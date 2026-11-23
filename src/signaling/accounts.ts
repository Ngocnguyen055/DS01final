import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AtomicState, serviceLog } from "../server-kit/runtime.ts";

export const LOCAL_ACCOUNT_PREFIX = "user_";
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{3,24}$/);
const passwordSchema = z
  .string()
  .min(10)
  .max(128)
  .refine((value) => Buffer.byteLength(value) <= 256);
const publicAccountSchema = z.object({
  username: usernameSchema,
  peerId: z.string(),
  displayName: z.string().trim().min(1).max(80),
});
const userSchema = publicAccountSchema.extend({
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  passwordHash: z.string().regex(/^[a-f0-9]{128}$/),
  createdAt: z.number(),
});
const stateSchema = z.object({
  version: z.literal(1),
  users: z.array(userSchema),
  sessions: z.array(
    z.object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      peerId: z.string(),
      expiresAt: z.number(),
      issuedAt: z.number().optional(),
    }),
  ),
});
export type Account = z.infer<typeof publicAccountSchema>;
type AccountState = z.infer<typeof stateSchema>;
const sessionId = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class Accounts {
  private disk: AtomicState<AccountState>;
  private state: AccountState;
  private hashing = 0;
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(path?: string) {
    this.disk = new AtomicState(path);
    this.state = this.disk.read((value) => stateSchema.parse(value)) || {
      version: 1,
      users: [],
      sessions: [],
    };
    const names = new Set<string>();
    for (const user of this.state.users) {
      if (
        user.peerId !== LOCAL_ACCOUNT_PREFIX + user.username ||
        names.has(user.username)
      )
        throw Error("Invalid account registry");
      names.add(user.username);
    }
    if (
      this.state.sessions.some(
        (session) =>
          !this.state.users.some((user) => user.peerId === session.peerId),
      )
    )
      throw Error("Invalid session registry");
  }
  private commit(next: AccountState) {
    this.disk.write(next);
    this.state = next;
  }
  private public(user: Account): Account {
    return {
      username: user.username,
      peerId: user.peerId,
      displayName: user.displayName,
    };
  }
  private throttle(ip: string, username: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key);
    for (const [key, limit] of [
      [`ip:${ip}`, 40],
      [`user:${username}`, 10],
    ] as const) {
      const value = this.attempts.get(key) || {
        count: 0,
        until: now + 10 * 60_000,
      };
      if (value.count >= limit)
        throw Error("Quá nhiều lần thử. Vui lòng thử lại sau 10 phút.");
      if (this.attempts.size >= 10000 && !this.attempts.has(key))
        throw Error("Máy chủ đang bận. Hãy thử lại sau.");
      value.count++;
      this.attempts.set(key, value);
    }
  }
  private async derive(password: string, salt: string): Promise<Buffer> {
    if (this.hashing >= 2) throw Error("Máy chủ đang bận. Hãy thử lại sau.");
    this.hashing++;
    try {
      return await new Promise<Buffer>((resolve, reject) =>
        scrypt(
          password,
          salt,
          64,
          { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        ),
      );
    } finally {
      this.hashing--;
    }
  }
  async register(input: unknown, ip: string) {
    const parsed = z
      .object({
        username: usernameSchema,
        password: passwordSchema,
        displayName: z.string().trim().min(1).max(80),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw Error(
        "Tên đăng nhập cần 3–24 ký tự a-z, 0-9, _, -. Mật khẩu cần 10–128 ký tự; tên hiển thị tối đa 80 ký tự.",
      );
    const { username, password, displayName } = parsed.data;
    this.throttle(ip, username);
    if (this.state.users.some((user) => user.username === username))
      throw Error("Tên đăng nhập đã được sử dụng.");
    const salt = randomBytes(16).toString("hex"),
      hash = await this.derive(password, salt);

    if (this.state.users.some((user) => user.username === username))
      throw Error("Tên đăng nhập đã được sử dụng.");
    const user = {
      username,
      peerId: LOCAL_ACCOUNT_PREFIX + username,
      displayName,
      salt,
      passwordHash: hash.toString("hex"),
      createdAt: Date.now(),
    };
    this.commit({ ...this.state, users: [...this.state.users, user] });
    serviceLog("auth", "REGISTER", user.peerId);
    return this.public(user);
  }
  async login(input: unknown, ip: string, isOnline: (id: string) => boolean) {
    const parsed = z
      .object({
        username: usernameSchema,
        password: passwordSchema,
        takeover: z.boolean().optional(),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw Error("Tên đăng nhập hoặc mật khẩu không đúng.");
    const { username, password } = parsed.data;
    this.throttle(ip, username);
    const user = this.state.users.find((user) => user.username === username);
    const hash = await this.derive(
      password,
      user?.salt || "00000000000000000000000000000000",
    );
    if (
      !user ||
      !timingSafeEqual(hash, Buffer.from(user.passwordHash, "hex"))
    ) {
      serviceLog("auth", "LOGIN_DENIED");
      throw Error("Tên đăng nhập hoặc mật khẩu không đúng.");
    }
    if (isOnline(user.peerId) && !parsed.data.takeover)
      throw Error(
        "Tài khoản đang online ở thiết bị khác. Chọn chuyển phiên đăng nhập để dùng thiết bị này.",
      );
    const token = randomBytes(32).toString("hex"),
      expiresAt = Date.now() + 12 * 60 * 60_000;
    this.commit({
      ...this.state,
      sessions: [
        ...this.state.sessions.filter(
          (session) =>
            session.peerId !== user.peerId && session.expiresAt > Date.now(),
        ),
        {
          id: sessionId(token),
          peerId: user.peerId,
          expiresAt,
          issuedAt: Date.now(),
        },
      ],
    });
    serviceLog("auth", "LOGIN", user.peerId);
    return { account: this.public(user), token, expiresAt };
  }
  authorize(peerId: string, id: unknown) {
    return (
      typeof id === "string" &&
      this.state.sessions.some(
        (session) =>
          session.peerId === peerId &&
          session.id === id &&
          session.expiresAt > Date.now(),
      )
    );
  }
  resolve(token: unknown) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      throw Error("Phiên đăng nhập không hợp lệ hoặc đã hết hạn.");
    const id = sessionId(token),
      session = this.state.sessions.find(
        (session) => session.id === id && session.expiresAt > Date.now(),
      );
    const user =
      session &&
      this.state.users.find((user) => user.peerId === session.peerId);
    if (!session || !user)
      throw Error("Phiên đăng nhập không hợp lệ hoặc đã hết hạn.");
    return {
      account: this.public(user),
      sessionId: id,
      expiresAt: session.expiresAt,
      issuedAt: session.issuedAt || 0,
    };
  }
  logout(token: unknown) {
    const session = this.resolve(token);
    this.commit({
      ...this.state,
      sessions: this.state.sessions.filter(
        (value) => value.id !== session.sessionId,
      ),
    });
    serviceLog("auth", "LOGOUT", session.account.peerId);
    return session;
  }
}
