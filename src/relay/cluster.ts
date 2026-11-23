import {
  createHmac,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import express, { type Express } from "express";
import type { Socket } from "socket.io";
import { z } from "zod";
import { AtomicState, serviceLog } from "../server-kit/runtime.ts";
import { RelayJournal } from "./journal.ts";
import {
  overlayRecordSchema,
  verifyOverlayRecord,
  type OverlayRecord,
} from "../shared/overlayProtocol.ts";
import { verifyIdentity } from "../shared/secure.ts";
import { peerIdSchema } from "../shared/protocol.ts";
import { assertPublicEndpoint } from "../server-kit/publicAddress.ts";

export type ClusterOptions = {
  nodeId: string;
  secret: string;
  url: () => string;
  members?: string[];
  routes?: Record<string, string>;
  statePath?: string;
  intervalMs?: number;
  ownerPeerId?: string;
  allowLocalElection?: boolean;
  candidateLeaseMs?: number;
};
const normalize = (url: string) => url.replace(/\/$/, "");
export class RelayCluster {
  readonly journal: RelayJournal;
  private seen = new Map<string, number>();
  private records = new Map<string, OverlayRecord>();
  private dhtState: AtomicState<OverlayRecord[]>;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private leaderId = "";
  private closed = false;
  private lifetime = new AbortController();
  constructor(
    private app: Express,
    private connections: Map<string, Socket>,
    private options: ClusterOptions,
    private deliver: () => Promise<void>,
  ) {
    this.journal = new RelayJournal(options.nodeId, options.statePath);
    this.dhtState = new AtomicState(
      options.statePath ? `${options.statePath}.dht.json` : undefined,
    );
    for (const record of this.dhtState.read((value) =>
      overlayRecordSchema.array().max(5000).parse(value),
    ) || [])
      if (record.expiresAt > Date.now() - 2 * 86400000)
        this.records.set(record.peerId, record);
    app.post(
      "/cluster/rpc",
      (req, res, next) => {
        if (
          !/^\d{13}$/.test(String(req.header("x-ds01-time"))) ||
          !/^[a-f\d-]{36}$/.test(String(req.header("x-ds01-nonce"))) ||
          !/^[a-f\d]{64}$/.test(String(req.header("x-ds01-mac")))
        )
          return res.sendStatus(403);
        next();
      },
      express.raw({ type: "application/json", limit: "1mb" }),
      async (req, res) => {
        try {
          const body = Buffer.isBuffer(req.body)
              ? req.body.toString("utf8")
              : "",
            time = String(req.header("x-ds01-time")),
            nonce = String(req.header("x-ds01-nonce"));
          if (
            Math.abs(Date.now() - Number(time)) > 30000 ||
            this.seen.has(nonce) ||
            !this.equal(
              this.mac(time, nonce, body),
              String(req.header("x-ds01-mac")),
            )
          )
            return res.sendStatus(403);
          this.seen.set(nonce, Date.now());
          if (this.seen.size > 10000)
            this.seen.delete(this.seen.keys().next().value!);
          const result = JSON.stringify(await this.rpc(JSON.parse(body)));
          res.setHeader("x-ds01-mac", this.mac(time, nonce, result));
          res.type("json").send(result);
        } catch (error) {
          serviceLog(
            "relay",
            "CLUSTER_REJECT",
            error instanceof Error ? error.message : "invalid cluster request",
            options.nodeId,
          );
          res.status(400).json({ error: "invalid cluster request" });
        }
      },
    );
    this.timer = setInterval(() => {
      void this.synchronize().catch((error) =>
        serviceLog("relay", "CLUSTER_ERROR", String(error), options.nodeId),
      );
    }, options.intervalMs ?? 2000);
    this.timer.unref();
  }
  private mac(time: string, nonce: string, body: string) {
    return createHmac("sha256", this.options.secret)
      .update(`${time}\n${nonce}\n${body}`)
      .digest("hex");
  }
  private equal(a: string, b: string) {
    return (
      /^[a-f\d]{64}$/.test(b) &&
      timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
    );
  }
  members() {
    return [
      ...new Set(
        [this.options.url(), ...(this.options.members || [])].map(normalize),
      ),
    ].sort();
  }
  async request(
    url: string,
    payload: unknown,
    publicProbe = false,
  ): Promise<Record<string, unknown>> {
    if (!this.members().includes(normalize(url)))
      throw Error("untrusted cluster member");
    const body = JSON.stringify(payload),
      time = String(Date.now()),
      nonce = randomUUID();
    const endpoint =
      (!publicProbe && this.options.routes?.[normalize(url)]) || url;
    const response = await fetch(`${normalize(endpoint)}/cluster/rpc`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-ds01-time": time,
        "x-ds01-nonce": nonce,
        "x-ds01-mac": this.mac(time, nonce, body),
      },
      body,
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(1500),
      ]),
    });
    if (!response.ok) throw Error("cluster member unavailable");
    const bytes = await response.text();
    if (
      Buffer.byteLength(bytes) > 1048576 ||
      !this.equal(
        this.mac(time, nonce, bytes),
        String(response.headers.get("x-ds01-mac")),
      )
    )
      throw Error("invalid cluster response");
    return JSON.parse(bytes);
  }
  private owners(peerId: string) {
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const ring = this.members()
      .map((url) => ({ url, hash: hash(url) }))
      .sort((a, b) => a.hash.localeCompare(b.hash));
    const key = hash(peerId),
      first = Math.max(
        0,
        ring.findIndex((node) => node.hash >= key),
      );
    return [ring[first].url, ring[(first + 1) % ring.length].url].filter(
      (url, index, rows) => rows.indexOf(url) === index,
    );
  }
  async publish(input: unknown) {
    const record = await verifyOverlayRecord(input);
    if (
      record.relayUrls.some((url) => !this.members().includes(normalize(url)))
    )
      throw Error("peer advertised an untrusted relay");
    const settled = await Promise.allSettled(
      this.owners(record.peerId).map((url) =>
        normalize(url) === normalize(this.options.url())
          ? this.storeRecord(record)
          : this.request(url, { action: "dht-put", record }),
      ),
    );
    if (settled.every((value) => value.status === "rejected"))
      throw Error("DHT replicas unavailable");
    serviceLog(
      "relay",
      "DHT_PUT",
      `${record.peerId} owners=${this.owners(record.peerId).join(",")}`,
      this.options.nodeId,
    );
    return record;
  }
  private async storeRecord(input: unknown) {
    const record = await verifyOverlayRecord(input),
      previous = this.records.get(record.peerId);
    if (!previous || previous.issuedAt <= record.issuedAt) {
      if (this.records.size >= 5000 && !previous)
        throw Error("DHT capacity reached");
      this.records.set(record.peerId, record);
      this.dhtState.write([...this.records.values()]);
    }
    return { ok: true };
  }
  async lookup(peerId: string, includeOffline = false) {
    peerIdSchema.parse(peerId);
    for (const url of this.owners(peerId)) {
      try {
        const value =
          normalize(url) === normalize(this.options.url())
            ? this.records.get(peerId)
            : (await this.request(url, { action: "dht-get", peerId })).record;
        if (value) return await verifyOverlayRecord(value, includeOffline);
      } catch {
        continue;
      }
    }
    return undefined;
  }
  async list() {
    const rows: OverlayRecord[] = [];
    for (const url of this.members()) {
      try {
        const records =
          normalize(url) === normalize(this.options.url())
            ? [...this.records.values()]
            : (await this.request(url, { action: "dht-list" })).records;
        for (const value of overlayRecordSchema
          .array()
          .max(5000)
          .parse(records))
          try {
            rows.push(await verifyOverlayRecord(value));
          } catch {
            continue;
          }
      } catch {
        continue;
      }
    }
    const latest = new Map<string, OverlayRecord>();
    for (const row of rows)
      if (
        !latest.has(row.peerId) ||
        latest.get(row.peerId)!.issuedAt < row.issuedAt
      )
        latest.set(row.peerId, row);
    return [...latest.values()];
  }
  async routeSignal(from: string, to: string, kind: string, data: unknown) {
    const local = this.connections.get(to);
    if (local?.connected) {
      local.emit("overlay:signal", { from, kind, data });
      return;
    }
    const record = await this.lookup(to);
    if (!record) throw Error("DHT peer offline");
    for (const url of record.relayUrls)
      try {
        if (
          (await this.request(url, { action: "signal", from, to, kind, data }))
            .ok
        )
          return;
      } catch {
        continue;
      }
    throw Error("DHT peer unreachable");
  }
  async authenticate(input: unknown, connectionId: string) {
    const auth = z
      .object({
        record: overlayRecordSchema,
        proof: z
          .object({
            connectionId: z.string(),
            issuedAt: z.number().int(),
            signature: z.string().max(100),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    const record = await verifyOverlayRecord(auth.record);
    const proof = {
      connectionId: auth.proof.connectionId,
      issuedAt: auth.proof.issuedAt,
      peerId: record.peerId,
    };
    if (
      proof.connectionId !== connectionId ||
      Math.abs(proof.issuedAt - Date.now()) > 10000 ||
      !(await verifyIdentity(record.identity, proof, auth.proof.signature))
    )
      throw Error("DHT possession proof invalid");
    await this.publish(record);
    return record;
  }
  async offer(peerId: string, url: string) {
    url = normalize(z.string().url().max(256).parse(url));
    if (!this.members().includes(url)) throw Error("untrusted cluster member");
    if (!this.options.allowLocalElection) await assertPublicEndpoint(url);
    const nonce = randomUUID(),
      result = await this.request(
        url,
        { action: "candidate-probe", nonce },
        true,
      );
    if (result.ownerPeerId !== peerId || result.nonce !== nonce)
      throw Error("candidate does not belong to this peer");
    this.journal.offer({
      peerId,
      url,
      leaseUntil: Date.now() + (this.options.candidateLeaseMs ?? 45000),
    });
    serviceLog(
      "relay",
      "ELECTION_CANDIDATE",
      `${peerId} ${url}`,
      this.options.nodeId,
    );
    this.publishLeader();
    return this.journal.leader();
  }
  publishLeader() {
    const leader = this.journal.leader(),
      id = leader ? `${leader.peerId}:${leader.url}` : "";
    if (id === this.leaderId) return;
    this.leaderId = id;
    for (const socket of this.connections.values())
      socket.emit("superpeer:leader", leader || null);
    serviceLog(
      "relay",
      "ELECTION_RESULT",
      leader
        ? `${leader.peerId} ${leader.url}`
        : "no reachable leased candidate",
      this.options.nodeId,
    );
  }
  private async rpc(input: unknown): Promise<Record<string, unknown>> {
    const request = z
      .object({
        action: z.enum([
          "state",
          "dht-put",
          "dht-get",
          "dht-list",
          "signal",
          "candidate-probe",
        ]),
        after: z.string().max(200).optional(),
        record: z.unknown().optional(),
        peerId: peerIdSchema.optional(),
        from: peerIdSchema.optional(),
        to: peerIdSchema.optional(),
        kind: z.enum(["request", "offer", "answer", "ice", "media"]).optional(),
        data: z.unknown().optional(),
        nonce: z.string().uuid().optional(),
      })
      .strict()
      .parse(input);
    if (request.action === "state") return this.journal.page(request.after);
    if (request.action === "dht-put") return this.storeRecord(request.record);
    if (request.action === "dht-get")
      return { record: this.records.get(request.peerId!) || null };
    if (request.action === "dht-list")
      return {
        records: [...this.records.values()]
          .filter((record) => record.expiresAt > Date.now())
          .slice(0, 500),
      };
    if (request.action === "candidate-probe")
      return {
        nonce: request.nonce,
        ownerPeerId: this.options.ownerPeerId || null,
      };
    if (
      !request.from ||
      !request.to ||
      !request.kind ||
      Buffer.byteLength(JSON.stringify(request.data)) > 20000
    )
      throw Error("invalid routed signal");
    const socket = this.connections.get(request.to);
    if (!socket?.connected) return { ok: false };
    socket.emit("overlay:signal", {
      from: request.from,
      kind: request.kind,
      data: request.data,
    });
    return { ok: true };
  }
  async synchronize() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      await Promise.allSettled(
        this.members()
          .filter((url) => normalize(url) !== normalize(this.options.url()))
          .map(async (url) => {
            let after: string | null = "";
            for (let page = 0; page < 40 && after !== null; page++) {
              const result = await this.request(url, {
                action: "state",
                after,
              });
              if (!Array.isArray(result.entries))
                throw Error("invalid replica state");
              if (this.journal.merge(result.entries))
                serviceLog(
                  "relay",
                  "REPLICA_MERGE",
                  `${url} records=${result.entries.length}`,
                  this.options.nodeId,
                );
              after = typeof result.after === "string" ? result.after : null;
            }
          }),
      );
      if (this.closed) return;
      this.journal.prune();
      for (const [id, value] of this.records)
        if (value.expiresAt <= Date.now() - 2 * 86400000)
          this.records.delete(id);
      for (const [nonce, time] of this.seen)
        if (Date.now() - time > 30000) this.seen.delete(nonce);
      this.publishLeader();
      await this.deliver();
    } finally {
      this.busy = false;
    }
  }
  close() {
    this.closed = true;
    this.lifetime.abort();
    clearInterval(this.timer);
  }
}
