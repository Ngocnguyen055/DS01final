import type { Socket } from "socket.io";
import { z } from "zod";
import { peerIdSchema } from "@ds01/shared";
import {
  publicIdentitySchema,
  validatePublicIdentity,
  canonical,
  type PublicIdentity,
} from "../shared/secure.ts";
import { AtomicState, serviceLog } from "../server-kit/runtime.ts";
import type { SignalingContext } from "./types.ts";
import { accountRotation, type AccountData } from "./accountData.ts";

export class KeyDirectory {
  private state: AtomicState<Record<string, PublicIdentity>>;
  private keys: Record<string, PublicIdentity>;
  private context?: SignalingContext;
  constructor(
    path?: string,
    private accounts?: AccountData,
  ) {
    this.state = new AtomicState(path);
    this.keys =
      this.state.read((value) =>
        z.record(peerIdSchema, publicIdentitySchema).parse(value),
      ) || {};
  }
  get(peerId: string) {
    return (
      this.accounts?.get(peerId)?.vault.publicIdentity ||
      (Object.hasOwn(this.keys, peerId) ? this.keys[peerId] : undefined)
    );
  }
  notifyChange(peerId: string) {
    this.context?.io.to("registered-peers").emit("key:changed", peerId);
  }
  register(socket: Socket, context: SignalingContext) {
    this.context = context;
    socket.on("key:publish", async (input, reply) => {
      if (typeof reply !== "function") return;
      try {
        const peerId = context.peerFor(socket);
        if (!peerId) throw Error("registration required");
        const key = await validatePublicIdentity(input),
          old = this.get(peerId);
        if (context.peerFor(socket) !== peerId)
          throw Error("registration changed");
        if (!old && Object.keys(this.keys).length >= 10000)
          throw Error("key directory capacity reached");
        if (old && canonical(old) !== canonical(key))
          throw Error(
            "identity key already pinned; restore the original device key",
          );
        const next = { ...this.keys, [peerId]: key };
        this.state.write(next);
        this.keys = next;
        serviceLog("signal", "KEY_PUBLISHED", peerId);
        reply({ ok: true });
      } catch (error) {
        reply({
          ok: false,
          error:
            error instanceof Error ? error.message : "invalid public identity",
        });
      }
    });
    socket.on("key:lookup", (input, reply) => {
      if (typeof reply !== "function") return;
      const parsed = peerIdSchema.safeParse(input);
      if (!context.peerFor(socket) || !parsed.success)
        return reply({ ok: false, error: "invalid key lookup" });
      const key = this.get(parsed.data);
      if (!key)
        serviceLog(
          "signal",
          "KEY_LOOKUP_MISS",
          `requester=${context.peerFor(socket)} target=${parsed.data}`,
        );
      reply(
        key
          ? {
              ok: true,
              key,
              rotation: accountRotation(this.accounts?.get(parsed.data)),
            }
          : { ok: false, error: "peer has no published security key" },
      );
    });
  }
}
