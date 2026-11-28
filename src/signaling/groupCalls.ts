import type { Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import {
  groupCallControlSchema,
  MAX_GROUP_CALL_PEERS,
  type GroupCallContext,
  type GroupCallSignalContext,
  type GroupCallRoom,
} from "../shared/media/groupCallProtocol.ts";
import type { SignalingContext } from "./types.ts";
import { serviceLog } from "../server-kit/runtime.ts";

type Room = {
  value: GroupCallRoom;
  leases: Map<string, { socketId: string; until: number; instanceId: string }>;
};
export class GroupCalls {
  private rooms = new Map<string, Room>();
  private revision = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private context: SignalingContext,
    private leaseMs = 30000,
  ) {
    this.timer = setInterval(() => this.sweep(), Math.min(1000, leaseMs));
    this.timer.unref();
  }
  private registered(socket: Socket) {
    const peerId = this.context.peerFor(socket);
    if (!peerId) throw Error("registration required");
    return peerId;
  }
  private publish(room: Room, previous: string[] = []) {
    room.value = {
      ...room.value,
      version: ++this.revision,
      participants: [...room.leases.keys()].sort(),
      sessions: Object.fromEntries(
        [...room.leases].map(([id, lease]) => [id, lease.instanceId]),
      ),
      ended: room.leases.size === 0,
    };
    const group = this.context.groups.get(room.value.groupId);
    for (const id of new Set([...(group?.members || []), ...previous])) {
      const socket = this.context.peers.get(id)?.socket;
      if (socket && this.context.peerFor(socket) === id)
        socket.emit("group-call:update", room.value);
    }
    if (room.value.ended) this.rooms.delete(room.value.roomId);
    serviceLog(
      "signal",
      "GROUP_CALL",
      `room=${room.value.roomId} group=${room.value.groupId} participants=${room.value.participants.join(",")} version=${room.value.version} result=${room.value.ended ? "ended" : "updated"}`,
    );
  }
  private remove(room: Room, peerId: string) {
    if (room.leases.delete(peerId)) this.publish(room, [peerId]);
  }
  private sweep() {
    for (const room of this.rooms.values()) {
      const group = this.context.groups.get(room.value.groupId),
        removed: string[] = [];
      for (const [id, lease] of room.leases) {
        const socket = this.context.peers.get(id)?.socket;
        if (
          !group ||
          group.archived ||
          !group.members.includes(id) ||
          lease.until <= Date.now() ||
          !socket ||
          socket.id !== lease.socketId ||
          this.context.peerFor(socket) !== id
        ) {
          room.leases.delete(id);
          removed.push(id);
        }
      }
      if (removed.length) this.publish(room, removed);
    }
  }
  allowed(sender: string, receiver: string, scope: GroupCallContext) {
    const room = this.rooms.get(scope.roomId),
      group = this.context.groups.get(scope.groupId);
    if (
      !room ||
      room.value.groupId !== scope.groupId ||
      !group ||
      group.archived ||
      !group.members.includes(sender) ||
      !group.members.includes(receiver) ||
      sender === receiver
    )
      return false;
    return [sender, receiver].every((id) => {
      const lease = room.leases.get(id),
        socket = this.context.peers.get(id)?.socket;
      return (
        !!lease &&
        lease.until > Date.now() &&
        socket?.id === lease.socketId &&
        this.context.peerFor(socket) === id
      );
    });
  }
  allowedSignal(
    sender: string,
    receiver: string,
    scope: GroupCallSignalContext,
  ) {
    const leases = this.rooms.get(scope.roomId)?.leases;
    return (
      this.allowed(sender, receiver, scope) &&
      leases?.get(sender)?.instanceId === scope.senderSession &&
      leases?.get(receiver)?.instanceId === scope.receiverSession
    );
  }
  register(socket: Socket) {
    socket.on("group-call:control", async (input, reply) => {
      if (typeof reply !== "function") return;
      try {
        const actor = this.registered(socket),
          value = groupCallControlSchema.parse(input);
        this.sweep();
        if (value.action === "list") {
          const rooms = [...this.rooms.values()]
            .filter((room) => {
              const group = this.context.groups.get(room.value.groupId);
              return group && !group.archived && group.members.includes(actor);
            })
            .map((room) => room.value);
          return reply({ ok: true, rooms });
        }
        const room =
          value.action === "start" ? undefined : this.rooms.get(value.roomId);
        if (value.action === "leave") {
          const lease = room?.leases.get(actor);
          if (
            room &&
            lease?.socketId === socket.id &&
            (!value.sessionId || value.sessionId === lease.instanceId)
          )
            this.remove(room, actor);
          return reply({ ok: true });
        }
        const groupId =
          value.action === "start" ? value.groupId : room?.value.groupId;
        const group = groupId && (await this.context.currentGroup(groupId));
        if (
          this.registered(socket) !== actor ||
          !group ||
          group.archived ||
          !group.members.includes(actor)
        )
          throw Error("group call access denied");
        if (value.action === "start") {
          if (
            [...this.rooms.values()].some(
              (room) => room.value.groupId === group.id,
            )
          )
            throw Error("Nhóm đã có cuộc gọi. Hãy chọn Tham gia.");
          if ([...this.rooms.values()].some((room) => room.leases.has(actor)))
            throw Error("Bạn đang tham gia cuộc gọi khác.");
          const created: Room = {
            value: {
              roomId: randomUUID(),
              groupId: group.id,
              kind: value.kind,
              startedBy: actor,
              startedAt: Date.now(),
              version: 1,
              participants: [],
              sessions: {},
              ended: true,
            },
            leases: new Map([
              [
                actor,
                {
                  socketId: socket.id,
                  until: Date.now() + this.leaseMs,
                  instanceId: randomUUID(),
                },
              ],
            ]),
          };
          this.rooms.set(created.value.roomId, created);
          this.publish(created);
          return reply({ ok: true, room: created.value });
        }
        if (!room || this.rooms.get(room.value.roomId) !== room)
          throw Error("Cuộc gọi đã kết thúc.");
        if (value.action === "join") {
          if (
            [...this.rooms.values()].some(
              (other) => other !== room && other.leases.has(actor),
            )
          )
            throw Error("Bạn đang tham gia cuộc gọi khác.");
          if (
            !room.leases.has(actor) &&
            room.leases.size >= MAX_GROUP_CALL_PEERS
          )
            throw Error(
              "Cuộc gọi hỗ trợ tối đa " + MAX_GROUP_CALL_PEERS + " người.",
            );
          room.leases.set(actor, {
            socketId: socket.id,
            until: Date.now() + this.leaseMs,
            instanceId: randomUUID(),
          });
          this.publish(room);
        } else {
          const lease = room.leases.get(actor);
          if (lease?.socketId !== socket.id)
            throw Error("Bạn chưa tham gia cuộc gọi.");
          lease.until = Date.now() + this.leaseMs;
        }
        reply({ ok: true, room: room.value });
      } catch (error) {
        reply({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "invalid group call request",
        });
      }
    });
    socket.on("disconnect", () => {
      for (const room of this.rooms.values()) {
        const peerId = socket.data.peerId;
        if (room.leases.get(peerId)?.socketId === socket.id)
          this.remove(room, peerId);
      }
    });
  }
  close() {
    clearInterval(this.timer);
    this.rooms.clear();
  }
}
