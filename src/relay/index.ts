import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { projectRoot } from "../server-kit/storagePaths.mjs";
import { randomUUID } from "node:crypto";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import {
  MAX_WIRE_BYTES,
  groupSchema,
  peerIdSchema,
  type Group,
} from "@ds01/shared";
import { guardSocket, serviceLog } from "../server-kit/runtime.ts";
import { requireSecret } from "../server-kit/secrets.ts";
import {
  parseWireMessage,
  MAX_SEALED_WIRE_BYTES,
  type WireMessage,
} from "../shared/secure.ts";
import { RelayCluster } from "./cluster.ts";
import { z } from "zod";
import { RelayMediaRouter } from "./media.ts";
if (process.env.NODE_ENV !== "test")
  loadEnv({ path: join(projectRoot, ".env") });
type Reply = (response: {
  ok: boolean;
  error?: string;
  queued?: boolean;
  expiresAt?: number;
}) => void;
export type DirectChatAuthorizer = (
  senderId: string,
  receiverId: string,
) => Promise<boolean>;
const SECRET = requireSecret("PEER_SECRET");
const accountPeerId = /^[a-f\d]{24}$/i;
const httpDirectChatAuthorizer: DirectChatAuthorizer = async (
  senderId,
  receiverId,
) => {
  if (!accountPeerId.test(senderId) || !accountPeerId.test(receiverId))
    return true;
  const base = process.env.API_INTERNAL_URL || "http://127.0.0.1:4000";
  const query = new URLSearchParams({ senderId, receiverId });
  const response = await fetch(
    `${base}/internal/direct-chat/authorize?${query.toString()}`,
    {
      headers: { "x-peer-secret": SECRET },
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok) throw new Error("direct chat authorization unavailable");
  const result = (await response.json()) as {
    allowed?: unknown;
  };
  return result.allowed === true;
};
export type RelayOptions = {
  nodeId?: string;
  pingInterval?: number;
  pingTimeout?: number;
  statePath?: string;
  offlineQueue?: boolean;
  publicUrl?: string;
  clusterUrls?: string[];
  clusterRoutes?: Record<string, string>;
  clusterIntervalMs?: number;
  ownerPeerId?: string;
  allowLocalElection?: boolean;
  candidateLeaseMs?: number;
};
export function createRelay(
  httpServer: HttpServer = createServer(),
  groupLookup?: (id: string) => Promise<Group | null>,
  authorizeDirect: DirectChatAuthorizer = httpDirectChatAuthorizer,
  options: RelayOptions = {},
) {
  const app = express();
  const connections = new Map<string, Socket>();
  const nodeId =
    options.nodeId || process.env.NODE_ID || `relay-${randomUUID()}`;
  const log = (event: string, detail: string) =>
    serviceLog("relay", event, detail, nodeId);
  const metrics = {
    acceptedConnections: 0,
    replacedConnections: 0,
    rejectedConnections: 0,
    forwardedMessages: 0,
    rejectedMessages: 0,
    forwardedPayloadBytes: 0,
    mediaFrames: 0,
    mediaBytes: 0,
    rejectedMedia: 0,
  };
  const offlineQueue =
    options.offlineQueue ?? process.env.RELAY_OFFLINE_QUEUE === "1";
  httpServer.on("request", app);
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    maxHttpBufferSize: Math.max(MAX_WIRE_BYTES, MAX_SEALED_WIRE_BYTES) + 1024,
    pingInterval: options.pingInterval ?? 10000,
    pingTimeout: options.pingTimeout ?? 10000,
  });
  const publicUrl = () =>
    options.publicUrl ||
    process.env.RELAY_PUBLIC_URL ||
    `http://127.0.0.1:${(httpServer.address() as { port: number } | null)?.port || 4002}`;
  const drainAttempts = new Map<
    string,
    { socket: string; count: number; sentAt: number }
  >();
  let draining = false;
  const forward = (target: Socket, input: unknown, msg: WireMessage) => {
    target.emit("relay:receive", input);
    metrics.forwardedMessages++;
    metrics.forwardedPayloadBytes += Buffer.byteLength(
      JSON.stringify(input),
      "utf8",
    );
    log(
      "FORWARD",
      `${msg.messageId} ${msg.senderId} -> ${msg.receiverId} ${msg.type} attempt=${msg.attempt} result=forwarded`,
    );
  };
  const cluster = new RelayCluster(
    app,
    connections,
    {
      nodeId,
      secret: SECRET,
      url: publicUrl,
      statePath: options.statePath || process.env.RELAY_STATE_PATH,
      members:
        options.clusterUrls ||
        (process.env.RELAY_CLUSTER_URLS || "").split(",").filter(Boolean),
      routes:
        options.clusterRoutes ||
        (process.env.RELAY_CLUSTER_ROUTES
          ? z
              .record(z.string().url(), z.string().url())
              .parse(JSON.parse(process.env.RELAY_CLUSTER_ROUTES))
          : undefined),
      intervalMs: options.clusterIntervalMs,
      ownerPeerId: options.ownerPeerId || process.env.SUPER_PEER_ID,
      allowLocalElection:
        options.allowLocalElection ??
        process.env.ALLOW_LOCAL_SUPERPEERS === "1",
      candidateLeaseMs: options.candidateLeaseMs,
    },
    async () => {
      if (!offlineQueue || draining) return;
      draining = true;
      try {
        for (const entry of cluster.journal.pending().slice(0, 500)) {
          const msg = parseWireMessage(entry.value),
            target = connections.get(msg.receiverId),
            attempt = drainAttempts.get(entry.key);
          if (
            !target?.connected ||
            target.data.tokenExpiresAt <= Date.now() ||
            (attempt?.socket === target.id &&
              (attempt.count >= 3 || Date.now() - attempt.sentAt < 4000))
          )
            continue;
          try {
            await authorizeSession(msg.receiverId, target.data.authSession);
            if (msg.groupId) {
              const group = groupSchema.parse(await lookup(msg.groupId));
              if (
                group.id !== msg.groupId ||
                group.archived ||
                !group.members.includes(msg.senderId) ||
                !group.members.includes(msg.receiverId)
              )
                continue;
            } else if (!(await authorizeDirect(msg.senderId, msg.receiverId)))
              continue;
            if (connections.get(msg.receiverId) !== target || !target.connected)
              continue;
            drainAttempts.set(entry.key, {
              socket: target.id,
              count: attempt?.socket === target.id ? attempt.count + 1 : 1,
              sentAt: Date.now(),
            });
            forward(target, entry.value, msg);
          } catch {
            continue;
          }
        }
        for (const key of drainAttempts.keys())
          if (
            !cluster.journal.entries.has(key) ||
            cluster.journal.entries.get(key)?.deleted
          )
            drainAttempts.delete(key);
      } finally {
        draining = false;
      }
    },
  );
  app.get("/health", (_req, res) =>
    res.json({
      service: "relay",
      nodeId,
      peers: connections.size,
      metrics,
      pending: cluster.journal.pending().length,
      replicas: cluster.members().length,
      offlineQueue,
      ownerPeerId: options.ownerPeerId || process.env.SUPER_PEER_ID || null,
    }),
  );
  const lookup =
    groupLookup ||
    (async (id: string) => {
      const url = process.env.SIGNAL_INTERNAL_URL || "http://127.0.0.1:4001";
      const response = await fetch(
        `${url}/internal/groups/${encodeURIComponent(id)}`,
        {
          headers: { "x-peer-secret": SECRET },
          signal: AbortSignal.timeout(2000),
        },
      );
      return response.ok ? ((await response.json()) as Group) : null;
    });
  const authorizeSession = async (peerId: string, id: unknown) => {
    if (!peerId.startsWith("user_")) return;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw Error("invalid account session");
    const base = process.env.SIGNAL_INTERNAL_URL || "http://127.0.0.1:4001";
    const query = new URLSearchParams({ peerId, sessionId: id });
    const response = await fetch(
      `${base}/internal/sessions/authorize?${query}`,
      {
        headers: { "x-peer-secret": SECRET },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok || (await response.json()).allowed !== true)
      throw Error("account session expired");
  };
  const media = new RelayMediaRouter({
    connections,
    authorize: authorizeDirect,
    session: authorizeSession,
    log,
    metrics,
    authorizeGroup: async (senderId, receiverId, group) => {
      const base = process.env.SIGNAL_INTERNAL_URL || "http://127.0.0.1:4001";
      const query = new URLSearchParams({ ...group, senderId, receiverId });
      const response = await fetch(
        `${base}/internal/group-calls/authorize?${query}`,
        {
          headers: { "x-peer-secret": SECRET },
          signal: AbortSignal.timeout(2000),
        },
      );
      return response.ok && (await response.json()).allowed === true;
    },
  });
  io.use(async (socket, next) => {
    try {
      if (socket.handshake.auth.dht) {
        const record = await cluster.authenticate(
          socket.handshake.auth.dht,
          (socket.conn as unknown as { id: string }).id,
        );
        socket.data.peerId = record.peerId;
        socket.data.tokenExpiresAt = record.expiresAt;
        socket.data.decentralized = true;
        return next();
      }
      const data = jwt.verify(
        String(socket.handshake.auth.token || ""),
        SECRET,
        {
          algorithms: ["HS256"],
          audience: "ds01-relay",
          issuer: "ds01-signaling",
        },
      ) as jwt.JwtPayload;
      if (
        !peerIdSchema.safeParse(data.sub).success ||
        !Number.isSafeInteger(data.exp) ||
        data.exp! <= 0 ||
        !Number.isSafeInteger(data.exp! * 1000)
      )
        throw new Error("invalid subject");
      socket.data.peerId = data.sub;
      await authorizeSession(String(data.sub), data.sid);
      socket.data.authSession = data.sid;
      socket.data.tokenExpiresAt = data.exp! * 1000;
      if (socket.data.tokenExpiresAt <= Date.now())
        throw Error("peer token expired");
      next();
    } catch {
      metrics.rejectedConnections++;
      log("AUTH_REJECT", `connection=${socket.id} result=denied`);
      next(new Error("invalid peer token"));
    }
  });
  io.on("connection", (socket) => {
    guardSocket(
      socket,
      "relay",
      [
        "relay:send",
        "relay:probe",
        "relay:consumed",
        "media:open",
        "media:close",
        "dht:publish",
        "dht:lookup",
        "dht:key",
        "dht:list",
        "overlay:signal",
        "superpeer:offer",
      ],
      nodeId,
      { "media:frame": 2500 },
    );
    const peerId = socket.data.peerId as string;
    const old = connections.get(peerId);
    if (old) metrics.replacedConnections++;
    old?.disconnect(true);
    connections.set(peerId, socket);
    media.attach(socket);
    metrics.acceptedConnections++;
    log(
      "REGISTER",
      `${peerId} connection=${socket.id} result=accepted replaced=${Boolean(old)}`,
    );
    let expiryTimer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = socket.data.tokenExpiresAt - Date.now();
      if (remaining <= 0) {
        log("TOKEN_EXPIRED", `${peerId} connection=${socket.id}`);
        socket.disconnect(true);
      } else expiryTimer = setTimeout(expire, Math.min(remaining, 2147483647));
    };
    const requireActive = (candidate: Socket, id: string, role: string) => {
      if (!candidate.connected || connections.get(id) !== candidate)
        throw Error(`${role} connection changed`);
      if (candidate.data.tokenExpiresAt <= Date.now())
        throw Error(`${role} session expired`);
    };
    socket.on("relay:probe", (_input, reply) => {
      if (typeof reply === "function")
        reply({
          ok: true,
          load: {
            nodeId,
            peers: connections.size,
            pending: cluster.journal.pending().length,
          },
          leader: cluster.journal.leader() || null,
        });
    });
    socket.on("relay:consumed", (input, reply) => {
      if (typeof reply !== "function") return;
      try {
        requireActive(socket, peerId, "receiver");
        const value = z
          .object({ messageId: z.string().uuid(), senderId: peerIdSchema })
          .strict()
          .parse(input);
        if (offlineQueue)
          cluster.journal.acknowledge(value.senderId, value.messageId, peerId);
        reply({ ok: true });
      } catch {
        reply({ ok: false, error: "invalid mailbox receipt" });
      }
    });
    for (const event of [
      "dht:publish",
      "dht:lookup",
      "dht:key",
      "dht:list",
      "overlay:signal",
      "superpeer:offer",
    ])
      socket.on(event, async (input, reply) => {
        if (typeof reply !== "function") return;
        try {
          requireActive(socket, peerId, "sender");
          await authorizeSession(peerId, socket.data.authSession);
          let result: unknown;
          if (event === "dht:publish") {
            if (!socket.data.decentralized || input?.peerId !== peerId)
              throw Error("DHT identity mismatch");
            const record = await cluster.publish(input);
            socket.data.tokenExpiresAt = record.expiresAt;
            result = record;
          } else if (event === "dht:lookup" || event === "dht:key")
            result = await cluster.lookup(
              peerIdSchema.parse(input),
              event === "dht:key",
            );
          else if (event === "dht:list") result = await cluster.list();
          else if (event === "superpeer:offer")
            result = await cluster.offer(peerId, String(input?.url));
          else {
            const signal = z
              .object({
                to: peerIdSchema,
                kind: z.enum(["request", "offer", "answer", "ice", "media"]),
                data: z.unknown(),
              })
              .strict()
              .parse(input);
            if (
              Buffer.byteLength(JSON.stringify(signal)) > 22000 ||
              !(await authorizeDirect(peerId, signal.to))
            )
              throw Error("invalid or blocked overlay signal");
            await cluster.routeSignal(
              peerId,
              signal.to,
              signal.kind,
              signal.data,
            );
            result = true;
          }
          reply({ ok: true, result });
        } catch (error) {
          reply({
            ok: false,
            error:
              error instanceof Error ? error.message : "overlay request failed",
          });
        }
      });
    socket.emit("superpeer:leader", cluster.journal.leader() || null);
    if (offlineQueue)
      setTimeout(() => {
        void cluster.synchronize();
      }, 200);
    socket.on("relay:send", async (input: unknown, reply: Reply) => {
      if (typeof reply !== "function") return;
      try {
        const msg = parseWireMessage(input);
        requireActive(socket, peerId, "sender");
        await authorizeSession(peerId, socket.data.authSession);
        if (msg.senderId !== peerId || msg.mode !== "RELAY")
          throw new Error("sender or mode mismatch");
        if (msg.groupId) {
          const result = groupSchema.safeParse(await lookup(msg.groupId));
          if (
            !result.success ||
            result.data.id !== msg.groupId ||
            result.data.archived ||
            !result.data.members.includes(peerId) ||
            !result.data.members.includes(msg.receiverId)
          )
            throw new Error("group access denied");
        } else if (!(await authorizeDirect(peerId, msg.receiverId)))
          throw new Error("direct chat blocked");
        const target = connections.get(msg.receiverId);
        requireActive(socket, peerId, "sender");
        if (
          !target &&
          (msg.type === "file-chunk" ||
            (msg.type === "sealed" && msg.traffic === "file-chunk"))
        )
          throw Error("file receiver offline");
        if (offlineQueue && msg.ackFor)
          cluster.journal.acknowledge(msg.receiverId, msg.ackFor, peerId);
        const queued =
          offlineQueue && (!msg.ackFor || !target)
            ? cluster.journal.enqueue(msg)
            : undefined;
        if (!target) {
          if (!offlineQueue) throw new Error("receiver offline");
          log("QUEUED", `${msg.messageId} ${peerId} -> ${msg.receiverId}`);
          return reply({
            ok: true,
            queued: true,
            expiresAt: queued?.expiresAt,
          });
        }
        requireActive(target, msg.receiverId, "receiver");
        await authorizeSession(msg.receiverId, target.data.authSession);
        requireActive(socket, peerId, "sender");
        requireActive(target, msg.receiverId, "receiver");
        forward(target, input, msg);
        if (offlineQueue)
          drainAttempts.set(
            cluster.journal.mailKey(
              msg.senderId,
              msg.messageId,
              msg.receiverId,
            ),
            { socket: target.id, count: 1, sentAt: Date.now() },
          );
        reply?.({ ok: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "invalid message";
        metrics.rejectedMessages++;
        log("REJECT", `${peerId}: ${message}`);
        reply?.({ ok: false, error: message });
      }
    });
    socket.on("disconnect", (reason) => {
      clearTimeout(expiryTimer);
      if (connections.get(peerId)?.id === socket.id) {
        connections.delete(peerId);
      }
      log(
        "DISCONNECT",
        `${peerId} connection=${socket.id} reason=${reason} result=removed`,
      );
    });
    expire();
  });
  return {
    app,
    io,
    connections,
    cluster,
    httpServer,
    close: async () => {
      cluster.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
if (process.argv[1]?.endsWith("index.ts")) {
  const server = createRelay();
  server.httpServer.listen(
    Number(process.env.RELAY_PORT || 4002),
    "0.0.0.0",
    () =>
      serviceLog("relay", "LISTENING", String(process.env.RELAY_PORT || 4002)),
  );
}
