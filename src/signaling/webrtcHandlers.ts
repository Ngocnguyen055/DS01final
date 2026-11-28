import type { Socket } from "socket.io";
import { peerIdSchema } from "@ds01/shared";
import { z } from "zod";
import type { SignalingContext, SignalingReply } from "./types.ts";
import { serviceLog } from "../server-kit/runtime.ts";
import { peerIsOnline } from "./presence.ts";
import { mediaSignalSchema } from "../shared/media/media.ts";
import type { GroupCalls } from "./groupCalls.ts";
const sdp = (type: "offer" | "answer") =>
  z.object({
    type: z.literal(type),
    sdp: z.string().max(12000),
    connectionId: z.string().uuid().optional(),
    revision: z.number().int().min(0).max(2147483647).optional(),
    requestId: z.string().uuid().optional(),
  }).strict();
const signalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      to: peerIdSchema,
      kind: z.literal("media"),
      data: mediaSignalSchema,
    })
    .strict(),
  z
    .object({
      to: peerIdSchema,
      kind: z.literal("request"),
      data: z.union([
        z.null(),
        z.object({
          requestId: z.string().uuid(),
          connectionId: z.string().uuid().optional(),
          revision: z.number().int().min(0).max(2147483647).optional(),
          restart: z.boolean().optional(),
          retry: z.boolean().optional(),
        }).strict(),
      ]),
    })
    .strict(),
  z
    .object({ to: peerIdSchema, kind: z.literal("offer"), data: sdp("offer") })
    .strict(),
  z
    .object({
      to: peerIdSchema,
      kind: z.literal("answer"),
      data: sdp("answer"),
    })
    .strict(),
  z
    .object({
      to: peerIdSchema,
      kind: z.literal("ice"),
      data: z
        .object({
          candidate: z.string().max(4000),
          sdpMid: z.string().max(256).nullish(),
          sdpMLineIndex: z.number().int().min(0).max(65535).nullish(),
          usernameFragment: z.string().max(256).nullish(),
          connectionId: z.string().uuid().optional(),
          revision: z.number().int().min(0).max(2147483647).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export function registerWebRtcHandlers(
  socket: Socket,
  context: SignalingContext,
  groupCalls?: GroupCalls,
) {
  socket.on("signal:send", async (input: unknown, reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    const senderId = context.peerFor(socket);
    const parsed = signalSchema.safeParse(input);
    if (
      !senderId ||
      context.peers.get(senderId)?.socket.id !== socket.id ||
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 12000
    )
      return reply?.({ ok: false, error: "invalid signaling data" });
    const value = parsed.data;
    if (
      value.kind === "media" &&
      value.data.group &&
      !groupCalls?.allowedSignal(senderId, value.to, value.data.group)
    )
      return reply({ ok: false, error: "group call access denied" });
    try {
      if (!(await context.authorizeDirect(senderId, String(value.to))))
        return reply?.({ ok: false, error: "direct chat blocked" });
    } catch {
      return reply?.({
        ok: false,
        error: "direct chat authorization unavailable",
      });
    }
    if (context.peerFor(socket) !== senderId)
      return reply({ ok: false, error: "registration required" });
    if (
      value.kind === "media" &&
      value.data.group &&
      !groupCalls?.allowedSignal(senderId, value.to, value.data.group)
    )
      return reply({ ok: false, error: "group call access denied" });
    const target = context.peers.get(String(value.to));
    if (!target || !peerIsOnline(context, String(value.to), target))
      return reply?.({ ok: false, error: "peer offline" });
    target.socket.emit("signal:receive", {
      from: senderId,
      kind: value.kind,
      data: value.data,
    });
    serviceLog("signal", String(value.kind), `${senderId} -> ${value.to}`);
    reply?.({ ok: true });
  });
}
