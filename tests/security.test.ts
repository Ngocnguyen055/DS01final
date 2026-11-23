import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io, type Socket } from "socket.io-client";
import { createSignaling } from "../src/signaling/index.ts";
import { createRelay } from "../src/relay/index.ts";
import { serviceLog } from "../src/server-kit/runtime.ts";
import { requireSecret } from "../src/server-kit/secrets.ts";

type Service =
  ReturnType<typeof createSignaling> | ReturnType<typeof createRelay>;
const services: Service[] = [],
  sockets: Socket[] = [];
async function listen<T extends Service>(service: T) {
  services.push(service);
  await new Promise<void>((resolve) =>
    service.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${(service.httpServer.address() as AddressInfo).port}`;
}
async function connect(url: string, token?: string) {
  const socket = io(url, {
    auth: { token },
    reconnection: false,
    transports: ["websocket"],
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}
async function register(
  url: string,
  peerId: string,
  identityProof = "security-test-demo-proof-12345",
) {
  const socket = await connect(url);
  const result = await socket
    .timeout(2000)
    .emitWithAck("peer:register", { peerId, identityProof });
  expect(result.ok).toBe(true);
  return { socket, result };
}
afterEach(async () => {
  vi.restoreAllMocks();
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const service of services.splice(0).reverse()) await service.close();
  vi.unstubAllEnvs();
});

describe("basic security boundaries", () => {
  it.each([
    undefined,
    "short",
    "replace-with-a-long-random-peer-secret",
    "local-development-only-secret-padded-to-32",
  ])("rejects missing or sample secret configuration: %#", (value) => {
    vi.stubEnv("PEER_SECRET", value);
    expect(() => requireSecret("PEER_SECRET")).toThrow("must be configured");
  });

  it("never grants a relay token longer than the account identity JWT", async () => {
    const signal = createSignaling(),
      url = await listen(signal),
      peerId = "000000000000000000000001";
    const exp = Math.floor(Date.now() / 1000) + 60;
    const proof = jwt.sign(
      { sub: peerId, exp },
      process.env.JWT_SECRET || "local-development-only-secret",
    );
    const { result } = await register(url, peerId, proof);
    const relayToken = jwt.decode(result.token) as jwt.JwtPayload;
    expect(relayToken.exp).toBeLessThanOrEqual(exp);
  });

  it("denies control RPCs immediately after an account identity JWT expires", async () => {
    const signal = createSignaling(),
      url = await listen(signal),
      peerId = "000000000000000000000001";
    const exp = Math.floor(Date.now() / 1000) + 2;
    const proof = jwt.sign(
      { sub: peerId, exp },
      process.env.JWT_SECRET || "local-development-only-secret",
    );
    const { socket } = await register(url, peerId, proof);
    vi.spyOn(Date, "now").mockReturnValue((exp + 1) * 1000);
    expect(await socket.timeout(2000).emitWithAck("peer:list")).toEqual({
      ok: false,
      error: "registration required",
    });
  });

  it("requires expiration on external account identity JWTs", async () => {
    const signal = createSignaling(),
      url = await listen(signal),
      socket = await connect(url),
      peerId = "000000000000000000000001";
    const proof = jwt.sign(
      { sub: peerId },
      process.env.JWT_SECRET || "local-development-only-secret",
    );
    expect(
      (
        await socket
          .timeout(2000)
          .emitWithAck("peer:register", { peerId, identityProof: proof })
      ).ok,
    ).toBe(false);
    expect(signal.peers.size).toBe(0);
  });

  it.each(["missing-expiry", "wrong-audience", "wrong-issuer"] as const)(
    "rejects a relay token with %s",
    async (variant) => {
      const relayUrl = await listen(createRelay());
      const payload = {
        sub: "peer-a",
        aud: variant === "wrong-audience" ? "another-service" : "ds01-relay",
        iss: variant === "wrong-issuer" ? "another-issuer" : "ds01-signaling",
        ...(variant === "missing-expiry"
          ? {}
          : { exp: Math.floor(Date.now() / 1000) + 60 }),
      };
      const token = jwt.sign(
        payload,
        process.env.PEER_SECRET || "local-development-only-secret",
      );
      await expect(connect(relayUrl, token)).rejects.toThrow(
        "invalid peer token",
      );
    },
  );

  it("removes the old identity when a socket reauthenticates after its session was revoked", async () => {
    const signal = createSignaling(),
      url = await listen(signal),
      { socket } = await register(url, "peer-a");
    signal.peers.get("peer-a")!.socket.data.authSession = "revoked-session";
    expect(
      (
        await socket
          .timeout(2000)
          .emitWithAck("peer:register", {
            peerId: "peer-b",
            identityProof: "security-test-other-proof-12345",
          })
      ).ok,
    ).toBe(true);
    expect([...signal.peers.keys()]).toEqual(["peer-b"]);
    socket.disconnect();
    await vi.waitFor(() => expect(signal.peers.size).toBe(0));
  });

  it.each([
    { to: "peer-b", kind: "request", data: null, extra: "undeclared" },
    { to: "peer-b", kind: "offer", data: { type: "offer", sdp: "v=0\r\n", connectionId: "not-a-uuid" } },
    {
      to: "peer-b",
      kind: "offer",
      data: { type: "offer", sdp: "v=0\r\n", body: "undeclared" },
    },
    {
      to: "peer-b",
      kind: "offer",
      data: { type: "offer", sdp: "v=0\r\n" + "\u00e9".repeat(6100) },
    },
  ])(
    "rejects extra signaling fields and oversized UTF-8 before forwarding: %#",
    async (input) => {
      const signal = createSignaling(),
        url = await listen(signal),
        a = await register(url, "peer-a"),
        b = await register(url, "peer-b");
      const received = vi.fn();
      b.socket.on("signal:receive", received);
      expect(
        (await a.socket.timeout(2000).emitWithAck("signal:send", input)).ok,
      ).toBe(false);
      expect(received).not.toHaveBeenCalled();
    },
  );

  it("forwards valid SDP and ICE metadata without chat content", async () => {
    const signal = createSignaling(),
      url = await listen(signal),
      a = await register(url, "peer-a"),
      b = await register(url, "peer-b");
    for (const input of [
      { to: "peer-b", kind: "request", data: null },
      { to: "peer-b", kind: "request", data: { requestId: crypto.randomUUID(), connectionId: crypto.randomUUID(), restart: true } },
      { to: "peer-b", kind: "offer", data: { type: "offer", sdp: "v=0\r\n", connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() } },
      { to: "peer-b", kind: "offer", data: { type: "offer", sdp: "v=0\r\n" } },
      {
        to: "peer-b",
        kind: "ice",
        data: {
          candidate: "candidate:1",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
          connectionId: crypto.randomUUID(),
        },
      },
    ]) {
      const received = new Promise((resolve) =>
        b.socket.once("signal:receive", resolve),
      );
      expect(
        (await a.socket.timeout(2000).emitWithAck("signal:send", input)).ok,
      ).toBe(true);
      await expect(received).resolves.toEqual({
        from: "peer-a",
        kind: input.kind,
        data: input.data,
      });
    }
  });

  it("keeps untrusted log details on one bounded line", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    serviceLog(
      "relay",
      "REJECT",
      "bad\r\n2099-01-01 [auth] LOGIN\u001b[2J" + "x".repeat(5000),
    );
    expect(output).toHaveBeenCalledTimes(1);
    const line = String(output.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n\u001b]/);
    expect(line.length).toBeLessThan(2300);
    expect(line).toContain("[relay] REJECT");
  });
});
