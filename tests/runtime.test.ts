import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const children: ChildProcess[] = [];
const directories: string[] = [];
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function launch(kind: string, env: NodeJS.ProcessEnv, watch = false) {
  const child = spawn(
    process.execPath,
    [join(root, "scripts/run-node.mjs"), kind, ...(watch ? ["--watch"] : [])],
    {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let output = "",
    errors = "";
  child.stdout!.on("data", (data) => (output += data));
  child.stderr!.on("data", (data) => (errors += data));
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  void done.catch(() => {});
  return { child, done, output: () => output, errors: () => errors };
}
async function health(url: string, process: ReturnType<typeof launch>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null)
      throw Error(`Service failed: ${process.errors()}`);
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Startup timeout: ${process.errors()}`);
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await exited;
  }
  for (const directory of directories.splice(0)) {
    const checked = resolve(directory);
    if (
      dirname(checked) !== resolve(tmpdir()) ||
      !basename(checked).startsWith("launcher-test-")
    )
      throw Error("Unexpected test cleanup path");
    await rm(checked, { recursive: true, force: true });
  }
});

describe("documented Node service launch commands", () => {
  it("runs signaling and relay as independent processes and completes the sequential benchmark", async () => {
    const [signalPort, relayPort] = await Promise.all([freePort(), freePort()]);
    const directory = join(tmpdir(), `launcher-test-${randomUUID()}`);
    directories.push(directory);
    const env = {
      SIGNAL_PORT: String(signalPort),
      RELAY_PORT: String(relayPort),
      SIGNAL_INTERNAL_URL: `http://127.0.0.1:${signalPort}`,
      SIGNAL_STATE_PATH: join(directory, "state.json"),
      ACCOUNT_STATE_PATH: join(directory, "accounts.json"),
      RELAY_STATE_PATH: join(directory, "relay.json"),
      PEER_SECRET: randomUUID() + randomUUID(),
      JWT_SECRET: randomUUID() + randomUUID(),
    };
    const signal = launch("signaling", env),
      relay = launch("relay", env);
    const signalUrl = `http://127.0.0.1:${signalPort}`,
      relayUrl = `http://127.0.0.1:${relayPort}`;
    expect(await health(signalUrl, signal)).toMatchObject({
      service: "signaling",
      peers: 0,
    });
    expect(await health(relayUrl, relay)).toMatchObject({
      service: "relay",
      peers: 0,
    });
    expect(signal.child.pid).not.toBe(relay.child.pid);
    const benchmark = launch("benchmark", {
      ...env,
      PUBLIC_SIGNAL_URL: signalUrl,
      PUBLIC_RELAY_URL: relayUrl,
    });
    expect(await benchmark.done).toBe(0);
    expect(benchmark.errors()).toBe("");
    expect(JSON.parse(benchmark.output())).toMatchObject({ count: 100 });
  }, 15000);

  it("starts development watch mode and fails a benchmark with an unreachable endpoint within a bounded time", async () => {
    const port = await freePort();
    const directory = join(tmpdir(), `launcher-test-${randomUUID()}`);
    directories.push(directory);
    const service = launch(
      "relay",
      {
        RELAY_PORT: String(port),
        RELAY_STATE_PATH: join(directory, "relay.json"),
      },
      true,
    );
    expect(await health(`http://127.0.0.1:${port}`, service)).toMatchObject({
      service: "relay",
    });
    const duplicate = launch("relay", {
      RELAY_PORT: String(await freePort()),
      RELAY_STATE_PATH: join(directory, "relay.json"),
    });
    expect(await duplicate.done).toBe(1);
    expect(duplicate.errors()).toContain("already using");
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
    const started = Date.now();
    const benchmark = launch("benchmark", {
      PUBLIC_SIGNAL_URL: "http://127.0.0.1:1",
      PUBLIC_RELAY_URL: "http://127.0.0.1:1",
    });
    expect(await benchmark.done).toBe(1);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(benchmark.errors()).toContain("Relay benchmark failed");
  }, 15000);
});
