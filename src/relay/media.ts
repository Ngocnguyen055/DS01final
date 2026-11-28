import type { Socket } from "socket.io";
import { mediaFrameSchema, mediaOpenSchema } from "../shared/media/mediaProtocol.ts";
import {
  MAX_GROUP_CALL_PEERS,
  type GroupCallContext,
} from "../shared/media/groupCallProtocol.ts";

type Binding = {
  callId: string;
  to: string;
  target: string;
  group?: GroupCallContext;
  expiresAt: number;
  window: number;
  frames: number;
  bytes: number;
};
const sameGroup = (a?: GroupCallContext, b?: GroupCallContext) =>
  a?.roomId === b?.roomId && a?.groupId === b?.groupId;
export class RelayMediaRouter {
  private calls = new Map<string, Map<string, Binding>>();
  constructor(
    private config: {
      connections: Map<string, Socket>;
      authorize: (senderId: string, receiverId: string) => Promise<boolean>;
      authorizeGroup?: (
        senderId: string,
        receiverId: string,
        group: GroupCallContext,
      ) => Promise<boolean>;
      session: (peerId: string, session: unknown) => Promise<void>;
      log: (event: string, detail: string) => void;
      metrics: {
        mediaFrames: number;
        mediaBytes: number;
        rejectedMedia: number;
      };
    },
  ) {}
  private active(
    socket: Socket | undefined,
    peerId: string,
  ): asserts socket is Socket {
    if (
      !socket?.connected ||
      this.config.connections.get(peerId) !== socket ||
      socket.data.tokenExpiresAt <= Date.now()
    )
      throw Error("media peer offline or session expired");
  }
  attach(socket: Socket) {
    const peerId = socket.data.peerId as string;
    let window = Date.now(),
      bytesInWindow = 0;
    socket.on("media:open", async (input, reply) => {
      if (typeof reply !== "function") return;
      try {
        const value = mediaOpenSchema.parse(input),
          target = this.config.connections.get(value.to);
        this.active(socket, peerId);
        this.active(target, value.to);
        await Promise.all([
          this.config.session(peerId, socket.data.authSession),
          this.config.session(value.to, target.data.authSession),
        ]);
        if (
          value.to === peerId ||
          !(await this.config.authorize(peerId, value.to))
        )
          throw Error("media access denied");
        if (
          value.group &&
          !(await this.config.authorizeGroup?.(peerId, value.to, value.group))
        )
          throw Error("group call access denied");
        this.active(socket, peerId);
        this.active(target, value.to);
        const calls = this.calls.get(socket.id) || new Map<string, Binding>();
        for (const [id, binding] of calls)
          if (binding.expiresAt <= Date.now()) calls.delete(id);
        const old = calls.get(value.callId),
          others = [...calls.values()].filter(
            (binding) => binding.callId !== value.callId,
          );
        if (
          (old &&
            (old.to !== value.to || !sameGroup(old.group, value.group))) ||
          others.some(
            (binding) => !value.group || !sameGroup(binding.group, value.group),
          )
        )
          throw Error("another relay call is active");
        if (!old && calls.size >= MAX_GROUP_CALL_PEERS - 1)
          throw Error("too many relay call connections");
        calls.set(value.callId, {
          callId: value.callId,
          to: value.to,
          target: target.id,
          group: value.group,
          expiresAt: Date.now() + 20000,
          window: old?.window || Date.now(),
          frames: old?.frames || 0,
          bytes: old?.bytes || 0,
        });
        this.calls.set(socket.id, calls);
        if (!old)
          this.config.log(
            "MEDIA_OPEN",
            peerId +
              " -> " +
              value.to +
              " call=" +
              value.callId +
              (value.group ? " room=" + value.group.roomId : "") +
              " encrypted=1 result=accepted",
          );
        reply({ ok: true });
      } catch (error) {
        this.config.metrics.rejectedMedia++;
        reply({
          ok: false,
          error:
            error instanceof Error ? error.message : "invalid media session",
        });
      }
    });
    socket.on("media:frame", (input) => {
      try {
        const frame = mediaFrameSchema.parse(input),
          binding = this.calls.get(socket.id)?.get(frame.callId),
          target = this.config.connections.get(frame.receiverId);
        this.active(socket, peerId);
        this.active(target, frame.receiverId);
        const other = this.calls.get(target.id)?.get(frame.callId);
        if (
          frame.senderId !== peerId ||
          !binding ||
          binding.expiresAt <= Date.now() ||
          binding.to !== frame.receiverId ||
          binding.target !== target.id
        )
          throw Error("invalid sender media session");
        if (
          !other ||
          other.expiresAt <= Date.now() ||
          other.to !== peerId ||
          other.target !== socket.id ||
          !sameGroup(binding.group, other.group)
        )
          return;
        if (Date.now() - binding.window >= 1000) {
          binding.window = Date.now();
          binding.frames = 0;
          binding.bytes = 0;
        }
        if (Date.now() - window >= 1000) {
          window = Date.now();
          bytesInWindow = 0;
        }
        const bytes = Buffer.byteLength(frame.ciphertext);
        if (
          ++binding.frames > 80 ||
          (binding.bytes += bytes) > 500000 ||
          (bytesInWindow += bytes) > 2000000
        )
          throw Error("media rate limit exceeded");
        if (
          ((target.conn as unknown as { writeBuffer?: unknown[] } | undefined)
            ?.writeBuffer?.length || 0) > 32
        )
          return;
        if (frame.kind === "video") target.volatile.emit("media:frame", frame);
        else target.emit("media:frame", frame);
        this.config.metrics.mediaFrames++;
        this.config.metrics.mediaBytes += bytes;
      } catch {
        this.config.metrics.rejectedMedia++;
      }
    });
    socket.on("media:close", (input, reply) => {
      const parsed = mediaOpenSchema.safeParse(input),
        calls = this.calls.get(socket.id),
        binding = parsed.success ? calls?.get(parsed.data.callId) : undefined;
      if (
        parsed.success &&
        binding?.to === parsed.data.to &&
        sameGroup(binding.group, parsed.data.group)
      ) {
        calls!.delete(binding.callId);
        if (!calls!.size) this.calls.delete(socket.id);
        this.config.log(
          "MEDIA_CLOSE",
          peerId + " call=" + binding.callId + " result=closed",
        );
      }
      if (typeof reply === "function") reply({ ok: parsed.success });
    });
    socket.on("disconnect", () => this.calls.delete(socket.id));
  }
}
