import { io, type Socket } from "socket.io-client";
import type { ChatMessage } from "../protocol.ts";
import { RelaySelector, type RelaySample } from "./relaySelection.ts";

type RelayReply = {
  ok: boolean;
  error?: string;
  queued?: boolean;
  expiresAt?: number;
  load?: { peers: number; pending: number };
};

type RelayPoolConfig<Reply extends RelayReply> = {
  primaryUrl: string;
  requestTimeoutMs?: number;
  policy: () => "priority" | "latency-load" | undefined;
  isClosed: () => boolean;
  configureSocket: (socket: Socket) => void;
  call: (socket: Socket, event: string, payload: unknown) => Promise<Reply>;
  log: (text: string) => void;
  onConnection: () => void;
  onMetrics: (samples: RelaySample[]) => void;
};

export class RelayPool<Reply extends RelayReply> {
  private readonly sockets = new Map<string, Socket>();
  private readonly waiters = new Set<() => void>();
  private activeRelay?: string;
  readonly selector = new RelaySelector();

  constructor(private readonly config: RelayPoolConfig<Reply>) {}

  get size() {
    return this.sockets.size;
  }

  get activeUrl() {
    return this.activeRelay;
  }

  get activeSocket() {
    return this.activeRelay ? this.sockets.get(this.activeRelay) : undefined;
  }

  connectedSockets() {
    return [...this.sockets.values()].filter((socket) => socket.connected);
  }

  private connectionChanged() {
    for (const check of this.waiters) check();
    this.config.onConnection();
  }

  clear() {
    for (const socket of this.sockets.values()) socket.disconnect();
    this.sockets.clear();
    this.activeRelay = undefined;
    for (const check of this.waiters) check();
  }

  attach(url: string) {
    url = url.replace(/\/$/, "");
    if (this.config.isClosed() || this.sockets.has(url)) return;
    const socket = io(url, { autoConnect: false, reconnection: true });
    this.sockets.set(url, socket);
    this.config.configureSocket(socket);
    socket.on("connect", () => {
      if (
        !this.activeRelay ||
        (this.config.policy() !== "latency-load" &&
          url === this.config.primaryUrl.replace(/\/$/, ""))
      )
        this.activeRelay = url;
      this.config.log(`relay connected ${url}`);
      this.connectionChanged();
      if (this.config.policy() === "latency-load")
        void this.probe();
    });
    socket.on("disconnect", () => {
      if (this.activeRelay === url)
        this.activeRelay = [...this.sockets].find(
          ([, socket]) => socket.connected,
        )?.[0];
      this.config.log(`relay disconnected ${url}`);
      this.connectionChanged();
    });
    socket.on("connect_error", (error) => {
      this.config.log(`relay error: ${error.message}`);
      this.connectionChanged();
    });
    socket.connect();
  }

  async waitForConnection() {
    if (this.config.isClosed()) throw new Error("peer disconnected");
    if (this.connectedSockets().length > 0) return;
    this.config.log("waiting for outbound relay connection");
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.config.isClosed()) finish(new Error("peer disconnected"));
        else if (this.connectedSockets().length > 0) finish();
      };
      const timer = setTimeout(
        () => finish(new Error("relay connection timeout")),
        this.config.requestTimeoutMs ?? 4000,
      );
      this.waiters.add(check);
      check();
    });
  }

  async send(
    packet: Pick<ChatMessage, "messageId" | "receiverId">,
    wire: unknown,
  ): Promise<{ queued: true; expiresAt?: number } | undefined> {
    await this.waitForConnection();
    let failure = "relay unavailable";
    if (
      this.config.policy() === "latency-load" &&
      !this.selector.samples.size
    )
      await this.probe();
    const urls =
      this.config.policy() === "latency-load"
        ? this.selector.rank([...this.sockets.keys()], this.activeRelay)
        : [...this.sockets.keys()].sort(
            (a, b) =>
              Number(b === this.activeRelay) - Number(a === this.activeRelay),
          );
    const candidates = urls.map((url) => [url, this.sockets.get(url)!] as const);
    for (const [url, socket] of candidates) {
      if (!socket.connected) continue;
      try {
        const response = await this.config.call(socket, "relay:send", wire);
        if (!response.ok) {
          failure = response.error || "relay rejected";
          continue;
        }
        this.activeRelay = url;
        this.connectionChanged();
        this.config.log(
          `RELAY SEND ${packet.messageId} -> ${packet.receiverId} via ${url}`,
        );
        return response.queued
          ? { queued: true, expiresAt: response.expiresAt }
          : undefined;
      } catch (error) {
        failure = String(error);
        this.config.log(`relay failover: ${failure}`);
      }
    }
    throw new Error(failure);
  }

  async probe() {
    await Promise.allSettled(
      [...this.sockets]
        .filter(([, socket]) => socket.connected)
        .map(async ([url, socket]) => {
          const start = performance.now(),
            response = await this.config.call(socket, "relay:probe", null);
          if (!response.ok || !response.load) return;
          const sample = this.selector.update(
            url,
            performance.now() - start,
            response.load.peers,
            response.load.pending,
          );
          this.config.log(
            `RELAY_SCORE ${url} rtt=${sample.rttMs.toFixed(1)}ms peers=${sample.peers} pending=${sample.pending} score=${sample.score.toFixed(1)}`,
          );
        }),
    );
    this.config.onMetrics([...this.selector.samples.values()]);
  }

  async request(event: string, input: unknown): Promise<Reply> {
    let last: unknown;
    for (const socket of this.sockets.values())
      if (socket.connected)
        try {
          const response = await this.config.call(socket, event, input);
          if (response.ok) return response;
          last = response.error;
        } catch (error) {
          last = error;
        }
    throw Error(`overlay unavailable: ${String(last)}`);
  }
}
