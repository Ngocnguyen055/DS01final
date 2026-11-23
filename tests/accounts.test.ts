import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { Accounts } from "../src/signaling/accounts.ts";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";

const folders: string[] = [],
  sockets: Socket[] = [],
  services: (
    ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>
  )[] = [];
const credentials = {
    username: "alice",
    password: "A long test passphrase 2026!",
  },
  registration = { ...credentials, displayName: "Alice" };
function folder() {
  const value = mkdtempSync(join(tmpdir(), "ds01-auth-"));
  folders.push(value);
  return value;
}
async function start<T extends (typeof services)[number]>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function connect(url: string, token?: string) {
  const socket = io(url, {
    reconnection: false,
    transports: ["websocket"],
    auth: { token },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}
afterEach(async () => {
  vi.restoreAllMocks();
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const service of services.splice(0)) await service.close();
  vi.unstubAllEnvs();
  for (const path of folders.splice(0)) {
    const checked = resolve(path);
    if (
      dirname(checked) !== resolve(tmpdir()) ||
      !basename(checked).startsWith("ds01-auth-")
    )
      throw Error("Unexpected cleanup path");
    rmSync(checked, { recursive: true, force: true });
  }
});
describe("account authentication", () => {
  it("persists salted password hashes and session hashes, restores identity and revokes old sessions", async () => {
    const path = join(folder(), "accounts.json"),
      accounts = new Accounts(path);
    const user = await accounts.register(registration, "test");
    expect(user.peerId).toBe("user_alice");
    const session = await accounts.login(
      { ...credentials, username: " ALICE " },
      "test",
      () => false,
    );
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain(credentials.password);
    expect(disk).not.toContain(session.token);
    expect(JSON.parse(disk).users[0].passwordHash).toHaveLength(128);
    const restored = new Accounts(path);
    expect(restored.resolve(session.token).account).toEqual(user);
    const next = await restored.login(credentials, "test", () => false);
    expect(() => restored.resolve(session.token)).toThrow();
    restored.logout(next.token);
    expect(() => new Accounts(path).resolve(next.token)).toThrow();
  }, 15000);
  it("accepts exactly one simultaneous registration for a normalized username", async () => {
    const path = join(folder(), "accounts.json");
    const accounts = new Accounts(path);
    const result = await Promise.allSettled([
      accounts.register(registration, "a"),
      accounts.register({ ...registration, username: "ALICE" }, "b"),
    ]);
    expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(result.filter((value) => value.status === "rejected")).toHaveLength(
      1,
    );
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.users).toHaveLength(1);
    expect(persisted.users[0]).toMatchObject({
      username: "alice",
      peerId: "user_alice",
    });
    const restored = new Accounts(path);
    expect(
      (await restored.login(credentials, "restored", () => false)).account
        .peerId,
    ).toBe("user_alice");
  }, 15000);
  it("rejects invalid data, wrong credentials and login while the account peer is online", async () => {
    const accounts = new Accounts();
    await expect(
      accounts.register({ ...registration, password: "short" }, "test"),
    ).rejects.toThrow();
    await expect(
      accounts.register({ ...registration, username: "../bad" }, "test"),
    ).rejects.toThrow();
    await accounts.register(registration, "test");
    await expect(
      accounts.login(
        { ...credentials, password: "wrong-password" },
        "test",
        () => false,
      ),
    ).rejects.toThrow("Tên đăng nhập hoặc mật khẩu không đúng");
    await expect(
      accounts.login(credentials, "test", () => true),
    ).rejects.toThrow("online");
    expect(() => accounts.resolve("forged")).toThrow();
  }, 15000);
  it("expires sessions and fails startup on corrupted durable account state", async () => {
    const path = join(folder(), "accounts.json"),
      accounts = new Accounts(path);
    await accounts.register(registration, "test");
    const session = await accounts.login(credentials, "test", () => false);
    vi.spyOn(Date, "now").mockReturnValue(session.expiresAt + 1);
    expect(() => accounts.resolve(session.token)).toThrow();
    writeFileSync(path, "{broken");
    expect(() => new Accounts(path)).toThrow();
  }, 15000);
  it("limits attempts across independent requests rather than resetting the budget on reconnect", async () => {
    const accounts = new Accounts();
    await accounts.register(registration, "test");
    for (let attempt = 0; attempt < 9; attempt++)
      await expect(accounts.register(registration, "test")).rejects.toThrow(
        "đã được sử dụng",
      );
    await expect(
      accounts.login(credentials, "test", () => false),
    ).rejects.toThrow("Quá nhiều lần thử");
  }, 15000);
  it("binds signaling and relay identities to an account session, and revokes existing relay access on logout", async () => {
    const signal = createSignaling(),
      signalUrl = await start(signal);
    vi.stubEnv("SIGNAL_INTERNAL_URL", signalUrl);
    const relay = createRelay(),
      relayUrl = await start(relay),
      control = await connect(signalUrl);
    expect(
      (await control.timeout(3000).emitWithAck("auth:register", registration))
        .ok,
    ).toBe(true);
    const login = await control
      .timeout(5000)
      .emitWithAck("auth:login", credentials);
    expect(login.ok).toBe(true);
    const peerSocket = await connect(signalUrl);
    const registered = await peerSocket
      .timeout(3000)
      .emitWithAck("peer:register", {
        peerId: "user_alice",
        identityProof: login.token,
        displayName: "Forged name",
      });
    expect(registered.ok).toBe(true);
    expect(signal.peers.get("user_alice")?.displayName).toBe("Alice");
    const impostor = await connect(signalUrl);
    expect(
      (
        await impostor
          .timeout(3000)
          .emitWithAck("peer:register", {
            peerId: "user_bob",
            identityProof: login.token,
          })
      ).ok,
    ).toBe(false);
    expect(
      (
        await impostor
          .timeout(3000)
          .emitWithAck("peer:register", {
            peerId: "user_unknown",
            identityProof: "demo-secret-cannot-claim-account",
          })
      ).ok,
    ).toBe(false);
    expect(
      (
        await impostor
          .timeout(3000)
          .emitWithAck("peer:register", {
            peerId: "user_alice",
            identityProof: login.token,
          })
      ).error,
    ).toBe("peer ID already online");
    const ar = await connect(relayUrl, registered.token);
    const receiver = await connect(signalUrl);
    const br = await receiver
      .timeout(3000)
      .emitWithAck("peer:register", {
        peerId: "demo-bob",
        identityProof: "valid-demo-test-secret",
      });
    await connect(relayUrl, br.token);
    const packet = {
      messageId: randomUUID(),
      sessionId: randomUUID(),
      senderId: "user_alice",
      receiverId: "demo-bob",
      type: "text",
      timestamp: Date.now(),
      body: "authenticated relay",
      mode: "RELAY",
      attempt: 1,
      sequence: 1,
    };
    expect((await ar.timeout(3000).emitWithAck("relay:send", packet)).ok).toBe(
      true,
    );
    expect(
      (
        await ar
          .timeout(3000)
          .emitWithAck("relay:send", { ...packet, senderId: "demo-bob" })
      ).ok,
    ).toBe(false);
    expect(
      (
        await control
          .timeout(3000)
          .emitWithAck("auth:logout", { token: login.token })
      ).ok,
    ).toBe(true);
    expect(signal.peers.has("user_alice")).toBe(false);
    expect((await ar.timeout(3000).emitWithAck("relay:send", packet)).ok).toBe(
      false,
    );
    await expect(connect(relayUrl, registered.token)).rejects.toThrow(
      "invalid peer token",
    );
    expect(
      (
        await control
          .timeout(3000)
          .emitWithAck("auth:session", { token: login.token })
      ).ok,
    ).toBe(false);
    expect(
      (await control.timeout(5000).emitWithAck("auth:login", credentials)).ok,
    ).toBe(true);
  }, 20000);
});
