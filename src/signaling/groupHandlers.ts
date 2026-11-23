import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { peerIdSchema, type Group } from "@ds01/shared";
import type { SignalingContext, SignalingReply } from "./types.ts";
import { serviceLog } from "../server-kit/runtime.ts";
function registeredPeer(socket: Socket, context: SignalingContext) {
  const peerId = context.peerFor(socket);
  return peerId && context.peers.get(peerId)?.socket.id === socket.id
    ? peerId
    : undefined;
}

export function registerGroupHandlers(
  socket: Socket,
  context: SignalingContext,
) {
  socket.on("project:group", async (input: unknown, reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    const actor = registeredPeer(socket, context);
    if (!actor) return reply({ ok: false, error: "registration required" });
    const projectId = (
      input as {
        projectId?: unknown;
      } | null
    )?.projectId;
    if (typeof projectId !== "string" || !/^[a-f\d]{24}$/i.test(projectId))
      return reply({ ok: false, error: "invalid project ID" });
    try {
      const fetched = await context.directory.project(projectId);
      if (registeredPeer(socket, context) !== actor)
        return reply({ ok: false, error: "registration no longer active" });
      if (fetched) context.publishGroup(fetched);
      const group = fetched ? context.groups.get(fetched.id) : undefined;
      if (!group || !group.members.includes(actor))
        return reply({ ok: false, error: "project group access denied" });
      reply({ ok: true, group });
    } catch {
      reply({ ok: false, error: "project authorization unavailable" });
    }
  });
  socket.on(
    "group:authorize",
    async (input: unknown, reply: SignalingReply) => {
      if (typeof reply !== "function") return;
      const actor = registeredPeer(socket, context);
      if (!actor) return reply({ ok: false, error: "registration required" });
      const value = input as {
        groupId?: unknown;
        otherPeerId?: unknown;
      } | null;
      if (
        !value ||
        typeof value.groupId !== "string" ||
        !/^[\da-f-]{36}$/i.test(value.groupId) ||
        !peerIdSchema.safeParse(value.otherPeerId).success
      )
        return reply({ ok: false, error: "invalid group authorization" });
      try {
        const group = await context.currentGroup(value.groupId);
        if (registeredPeer(socket, context) !== actor)
          return reply({ ok: false, error: "registration no longer active" });
        if (
          !group ||
          group.archived ||
          !group.members.includes(actor) ||
          !group.members.includes(String(value.otherPeerId))
        )
          return reply({
            ok: false,
            error: "group access denied or project archived",
          });
        reply({ ok: true, group });
      } catch {
        reply({ ok: false, error: "project authorization unavailable" });
      }
    },
  );
  socket.on("group:create", (input: unknown, reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    const ownerId = registeredPeer(socket, context);
    const members = (
      input as {
        members?: unknown;
      }
    )?.members;
    const name = (
      input as {
        name?: unknown;
      }
    )?.name;
    if (
      name !== undefined &&
      (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    )
      return reply({ ok: false, error: "invalid group name" });
    if (
      !ownerId ||
      !Array.isArray(members) ||
      members.length > 15 ||
      !members.every((value) => peerIdSchema.safeParse(value).success)
    )
      return reply?.({ ok: false, error: "invalid members" });
    const group: Group = {
      id: randomUUID(),
      ownerId,
      members: [...new Set([ownerId, ...members])],
      version: 1,
      name: typeof name === "string" ? name.trim() : undefined,
    };
    context.groups.set(group.id, group);
    try {
      context.save();
    } catch {
      context.groups.delete(group.id);
      return reply({ ok: false, error: "group persistence unavailable" });
    }
    group.members.forEach((peerId) => {
      const target = context.peers.get(peerId)?.socket;
      if (target && context.peerFor(target) === peerId)
        target.emit("group:update", group);
    });
    serviceLog(
      "signal",
      "GROUP",
      `${group.id} members=${group.members.join(",")}`,
    );
    reply?.({ ok: true, group });
  });
  socket.on("group:change", (input: unknown, reply: SignalingReply) => {
    if (typeof reply !== "function") return;
    const actor = registeredPeer(socket, context);
    const { groupId, memberId, action, version } = (input || {}) as Record<
      string,
      unknown
    >;
    const group = context.groups.get(String(groupId));
    if (group?.projectId)
      return reply?.({
        ok: false,
        error: "manage project members through REST API",
      });
    if (
      !actor ||
      !group ||
      !group.members.includes(actor) ||
      group.version !== version ||
      !peerIdSchema.safeParse(memberId).success ||
      (action !== "add" && action !== "remove")
    )
      return reply?.({
        ok: false,
        error: "invalid group change or stale version",
      });
    if (action === "add" && actor !== group.ownerId)
      return reply?.({ ok: false, error: "only owner can add member" });
    if (action === "remove" && actor !== group.ownerId && actor !== memberId)
      return reply?.({ ok: false, error: "not allowed" });
    if (
      action === "add" &&
      !group.members.includes(String(memberId)) &&
      group.members.length >= 16
    )
      return reply({ ok: false, error: "group limit is 16 members" });
    const before = [...group.members];
    const next = {
      ...group,
      members:
        action === "add"
          ? [...new Set([...group.members, String(memberId)])]
          : group.members.filter((peerId) => peerId !== memberId),
      version: group.version + 1,
    };
    if (!next.members.includes(next.ownerId)) {
      if (next.members.length) next.ownerId = [...next.members].sort()[0];
      else next.archived = true;
    }
    context.groups.set(next.id, next);
    try {
      context.save();
    } catch {
      context.groups.set(group.id, group);
      return reply({ ok: false, error: "group persistence unavailable" });
    }
    [...new Set([...before, ...next.members])].forEach((peerId) => {
      const target = context.peers.get(peerId)?.socket;
      if (target && context.peerFor(target) === peerId)
        target.emit("group:update", next);
    });
    serviceLog(
      "signal",
      "GROUP_CHANGE",
      `${next.id} v${next.version} owner=${next.ownerId}`,
    );
    reply({ ok: true, group: next });
  });
}
