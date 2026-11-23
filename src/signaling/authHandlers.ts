import type { Socket } from "socket.io";
import type { Accounts } from "./accounts.ts";
import type { SignalingContext } from "./types.ts";
import { serviceLog } from "../server-kit/runtime.ts";
import { peerIsOnline } from "./presence.ts";

export function registerAuthHandlers(
  socket: Socket,
  accounts: Accounts,
  context: SignalingContext,
) {
  for (const event of [
    "auth:register",
    "auth:login",
    "auth:session",
    "auth:logout",
  ]) {
    socket.on(
      event,
      async (input: unknown, reply: (result: unknown) => void) => {
        if (typeof reply !== "function") return;
        try {
          const token =
            input && typeof input === "object" && "token" in input
              ? input.token
              : undefined;
          if (event === "auth:register")
            reply({
              ok: true,
              account: await accounts.register(input, socket.handshake.address),
            });
          else if (event === "auth:login") {
            const session = await accounts.login(
              input,
              socket.handshake.address,
              (id) => {
                const peer = context.peers.get(id);
                return !!peer && peerIsOnline(context, id, peer);
              },
            );
            const previous = context.peers.get(session.account.peerId);
            if (previous) {
              previous.socket.emit("auth:expired");
              previous.socket.disconnect(true);
            }
            reply({ ok: true, ...session });
          } else if (event === "auth:session") {
            const session = accounts.resolve(token);
            reply({
              ok: true,
              account: session.account,
              expiresAt: session.expiresAt,
            });
          } else {
            const session = accounts.logout(token),
              peer = context.peers.get(session.account.peerId);
            if (peer?.socket.data.authSession === session.sessionId) {
              peer.socket.emit("auth:expired");
              peer.socket.disconnect(true);
            }
            reply({ ok: true });
          }
        } catch (error) {
          serviceLog("auth", "REJECT", event);
          reply({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Không thể xử lý tài khoản.",
          });
        }
      },
    );
  }
}
