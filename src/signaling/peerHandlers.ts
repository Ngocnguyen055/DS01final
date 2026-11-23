import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Socket } from "socket.io";
import {
  peerDiscoverySchema,
  peerIdSchema,
  peerRegistrationSchema,
} from "@ds01/shared";
import { ACCOUNT_PEER_ID } from "./directChatAuthorization.ts";
import type { SignalingContext, SignalingReply } from "./types.ts";
import { serviceLog } from "../server-kit/runtime.ts";
import { LOCAL_ACCOUNT_PREFIX } from "./accounts.ts";
import { peerIsOnline, removeExpiredPeer } from "./presence.ts";
function isRegistered(socket: Socket, context: SignalingContext) {
  const peerId = context.peerFor(socket);
  return !!peerId && context.peers.get(peerId)?.socket.id === socket.id;
}

export function registerPeerHandlers(
  socket: Socket,
  context: SignalingContext,
) {
  socket.on("peer:register", async (input: unknown, reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    const parsed = peerRegistrationSchema.safeParse(input);
    if (!parsed.success)
      return reply({ ok: false, error: "invalid registration data" });
    const { peerId, identityProof, status, connection } = parsed.data;
    let displayName = parsed.data.displayName || peerId;
    let authSession: string | undefined, authExpiresAt: number | undefined;
    if (peerId.startsWith(LOCAL_ACCOUNT_PREFIX)) {
      try {
        const session = context.accounts.resolve(identityProof);
        if (session.account.peerId !== peerId) throw Error("wrong account");
        authSession = session.sessionId;
        authExpiresAt = session.expiresAt;
        displayName = session.account.displayName;
      } catch {
        return reply({
          ok: false,
          error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
        });
      }
    } else if (ACCOUNT_PEER_ID.test(peerId)) {
      try {
        const token = jwt.verify(identityProof, context.jwtSecret, {
          algorithms: ["HS256"],
        }) as jwt.JwtPayload;
        if (token.sub !== peerId || typeof token.exp !== "number")
          throw new Error("wrong account");
        authExpiresAt = token.exp * 1000;
      } catch {
        return reply({ ok: false, error: "invalid account token" });
      }
    } else {
      if (identityProof.length < 16)
        return reply({ ok: false, error: "demo peer secret too short" });
      const hash = createHash("sha256").update(identityProof).digest("hex");
      if (
        context.demoSecrets.has(peerId) &&
        context.demoSecrets.get(peerId) !== hash
      )
        return reply({
          ok: false,
          error: "peer ID belongs to another demo peer",
        });
      const before = context.demoSecrets.get(peerId);
      context.demoSecrets.set(peerId, hash);
      try {
        context.save();
      } catch {
        if (before) context.demoSecrets.set(peerId, before);
        else context.demoSecrets.delete(peerId);
        return reply({ ok: false, error: "identity persistence unavailable" });
      }
    }
    const existing = context.peers.get(peerId);
    if (
      existing &&
      existing.socket.id !== socket.id &&
      !removeExpiredPeer(context, peerId, existing)
    )
      return reply({ ok: false, error: "peer ID already online" });
    const previous = socket.data.peerId as string | undefined;
    if (
      previous &&
      previous !== peerId &&
      context.peers.get(previous)?.socket.id === socket.id
    )
      context.peers.delete(previous);
    socket.data.peerId = peerId;
    socket.data.authSession = authSession;
    socket.data.authExpiresAt = authExpiresAt;
    context.peers.set(peerId, {
      socket,
      lastSeen: Date.now(),
      displayName,
      status,
      connection,
    });
    void socket.join("registered-peers");
    if (ACCOUNT_PEER_ID.test(peerId)) {
      try {
        for (const group of await context.directory.forPeer(peerId))
          context.publishGroup(group);
      } catch {
        console.warn(
          "[signal] project directory unavailable; project chat will fail closed",
        );
      }
    }
    if (context.peerFor(socket) !== peerId)
      return reply({ ok: false, error: "registration no longer active" });
    const token = jwt.sign(
      {
        sub: peerId,
        exp: Math.floor(
          (authExpiresAt ?? Date.now() + 12 * 60 * 60 * 1000) / 1000,
        ),
        ...(peerId.startsWith(LOCAL_ACCOUNT_PREFIX)
          ? { sid: socket.data.authSession }
          : {}),
      },
      context.peerSecret,
      {
        algorithm: "HS256",
        audience: "ds01-relay",
        issuer: "ds01-signaling",
      },
    );
    serviceLog("signal", "REGISTER", peerId);
    const profiles = context.onlineProfiles();
    reply({
      ok: true,
      token,
      peers: profiles.map((peer) => peer.peerId),
      profiles,
      groups: [...context.groups.values()].filter((group) =>
        group.members.includes(peerId),
      ),
    });
    socket.emit("peer:ready");
    context.publishPresence();
  });
  const renewLease = () => {
    const peerId = context.peerFor(socket);
    if (peerId && context.peers.get(peerId)?.socket.id === socket.id)
      context.peers.get(peerId)!.lastSeen = Date.now();
  };
  socket.on("peer:heartbeat", renewLease);
  socket.conn.on("heartbeat", renewLease);
  socket.on("peer:list", (reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    if (!isRegistered(socket, context))
      return reply({ ok: false, error: "registration required" });
    const profiles = context.onlineProfiles();
    reply({ ok: true, peers: profiles.map((peer) => peer.peerId), profiles });
  });
  socket.on("peer:lookup", async (input: unknown, reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    const requesterId = context.peerFor(socket);
    if (!requesterId || !isRegistered(socket, context))
      return reply({ ok: false, error: "registration required" });
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, "peerId")
    )
      return reply({ ok: false, error: "invalid peer lookup" });
    const parsed = peerIdSchema.safeParse(
      (
        input as {
          peerId?: unknown;
        }
      ).peerId,
    );
    if (!parsed.success)
      return reply({ ok: false, error: "invalid peer lookup" });
    const peerId = parsed.data;
    try {
      if (!(await context.authorizeDirect(requesterId, peerId)))
        return reply({ ok: false, error: "direct chat blocked" });
    } catch {
      return reply({
        ok: false,
        error: "direct chat authorization unavailable",
      });
    }
    if (context.peerFor(socket) !== requesterId)
      return reply({ ok: false, error: "registration required" });
    const target = context.peers.get(peerId);
    const peer =
      !target || !peerIsOnline(context, peerId, target)
        ? {
            peerId,
            online: false as const,
            lastSeen: null,
            connection: null,
          }
        : {
            peerId,
            online: true as const,
            lastSeen: target.lastSeen,
            connection: target.connection,
          };
    reply({ ok: true, peer: peerDiscoverySchema.parse(peer) });
  });
  socket.on("disconnect", () => {
    socket.conn.off("heartbeat", renewLease);
    const peerId = socket.data.peerId as string | undefined;
    if (peerId && context.peers.get(peerId)?.socket.id === socket.id) {
      context.peers.delete(peerId);
      serviceLog("signal", "DISCONNECT", peerId);
      context.publishPresence();
    }
  });
}
