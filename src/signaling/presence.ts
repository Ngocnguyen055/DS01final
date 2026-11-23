import type { PeerProfile } from "@ds01/shared";
import type { PeerSession, SignalingContext } from "./types.ts";
import { serviceLog } from "../server-kit/runtime.ts";

function authorized(
  context: SignalingContext,
  peerId: string,
  peer: PeerSession,
  now: number,
) {
  const { authExpiresAt, authSession } = peer.socket.data;
  return (
    (authExpiresAt === undefined || authExpiresAt > now) &&
    (!authSession || context.accounts.authorize(peerId, authSession))
  );
}

export function peerIsOnline(
  context: SignalingContext,
  peerId: string,
  peer: PeerSession,
  now = Date.now(),
) {
  return (
    peer.socket.connected &&
    peer.socket.data.peerId === peerId &&
    now - peer.lastSeen < context.heartbeatFreshMs &&
    authorized(context, peerId, peer, now)
  );
}

export function onlineProfiles(context: SignalingContext): PeerProfile[] {
  const now = Date.now();
  return [...context.peers]
    .filter(([peerId, peer]) => peerIsOnline(context, peerId, peer, now))
    .map(([peerId, peer]) => ({
      peerId,
      displayName: peer.displayName,
      status: peer.status,
      online: true,
      lastSeen: peer.lastSeen,
      connection: { ...peer.connection },
    }));
}

export function removeExpiredPeer(
  context: SignalingContext,
  peerId: string,
  peer: PeerSession,
  now = Date.now(),
) {
  if (
    context.peers.get(peerId) !== peer ||
    peerIsOnline(context, peerId, peer, now)
  )
    return false;
  context.peers.delete(peerId);
  if (peer.socket.data.peerId === peerId) {
    if (!authorized(context, peerId, peer, now)) {
      peer.socket.emit("auth:expired");
      serviceLog("auth", "SESSION_EXPIRED", peerId);
    } else
      serviceLog(
        "signal",
        peer.socket.connected ? "TIMEOUT" : "DISCONNECT",
        peerId,
      );
    peer.socket.disconnect(true);
  }
  return true;
}

export function expirePeers(context: SignalingContext) {
  const now = Date.now();
  let changed = false;
  for (const [peerId, peer] of context.peers) {
    if (removeExpiredPeer(context, peerId, peer, now)) changed = true;
  }
  if (changed) context.publishPresence();
}
