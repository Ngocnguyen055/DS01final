import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "socket.io";
export function serviceLog(
  service: string,
  event: string,
  detail = "",
  nodeId?: string,
) {
  const clean = (value: string) =>
    value
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, " ")
      .slice(0, 2048);
  console.log(
    `${new Date().toISOString()} [${clean(service)}] ${clean(event)}${detail ? ` ${clean(detail)}` : ""} node=${clean(nodeId || process.env.NODE_ID || `${service}-${process.pid}`)}`,
  );
}

export class AtomicState<T> {
  constructor(private path?: string) {}
  read(validate: (input: unknown) => T): T | undefined {
    if (!this.path || !existsSync(this.path)) return;
    return validate(JSON.parse(readFileSync(this.path, "utf8")));
  }
  write(value: T) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
export function guardSocket(
  socket: Socket,
  service: string,
  rpcEvents: string[],
  nodeId?: string,
  streamLimits: Record<string, number> = {},
) {
  let since = Date.now(),
    count = 0;
  const streams = new Map<string, { since: number; count: number }>();
  socket.use((packet, next) => {
    const [event, ...args] = packet;
    const reply = args.at(-1);
    if (rpcEvents.includes(event) && typeof reply !== "function") {
      serviceLog(service, "REJECT", `${event}: callback required`, nodeId);
      return;
    }
    if (Object.hasOwn(streamLimits, event)) {
      let bucket = streams.get(event);
      if (!bucket || Date.now() - bucket.since > 10000) {
        bucket = { since: Date.now(), count: 0 };
        streams.set(event, bucket);
      }
      if (++bucket.count > streamLimits[event]) {
        if (bucket.count === streamLimits[event] + 1)
          serviceLog(service, "REJECT", `${event}: stream rate limit`, nodeId);
        return;
      }
      return next();
    }
    if (Date.now() - since > 10000) {
      since = Date.now();
      count = 0;
    }
    if (++count > 1000) {
      if (typeof reply === "function")
        reply({ ok: false, error: "rate limit exceeded" });
      serviceLog(service, "REJECT", `${event}: rate limit`, nodeId);
      return;
    }
    if (typeof reply === "function")
      packet[packet.length - 1] = (response: unknown, ...rest: unknown[]) => {
        if (
          response &&
          typeof response === "object" &&
          "ok" in response &&
          response.ok === false
        )
          serviceLog(
            service,
            "REJECT",
            `${event}: ${"error" in response ? String(response.error) : "request denied"}`,
            nodeId,
          );
        reply(response, ...rest);
      };
    next();
  });
  socket.on("error", (error) =>
    serviceLog(service, "ERROR", String(error.message), nodeId),
  );
}
