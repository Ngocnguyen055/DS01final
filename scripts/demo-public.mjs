import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { parse as parseEnv } from "dotenv";
import {
  runtimeRoot,
  toolsDirectory,
  dataRoot,
  prepareRuntime,
} from "./runtime-paths.mjs";
import {
  prepareData,
  durableDemoSecrets,
  acquireStorageLock,
} from "../src/server-kit/storagePaths.mjs";
import { createDemoDashboard } from "./demo-dashboard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
async function sourceFingerprint() {
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(join(root, directory), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", "dist"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        /\.(?:[cm]?ts|tsx|[cm]?js|jsx|css|html|json)$/.test(entry.name)
      ) {
        hash.update(path.replaceAll("\\", "/"));
        hash.update(await readFile(join(root, path)));
      }
    }
  }
  await visit("src");
  for (const path of ["package-lock.json", "scripts/demo-public.mjs"]) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  return hash.digest("hex");
}
const args = process.argv.slice(2);
const modes = ["--local", "--check", "--public", "--public-check"];
const checkOnly = args.includes("--check") || args.includes("--public-check"),
  publicMode = args.includes("--public") || args.includes("--public-check");
const help =
  "Usage: node scripts/demo-public.mjs --local | --check | --public | --public-check [--cloudflared PATH]\n--local runs the local demo and dashboard; --check tests localhost and exits; --public-check tests temporary public endpoints and exits; --public keeps the Internet demo open until Ctrl+C.";
if (!args.length || args.includes("--help")) {
  console.log(help);
  process.exit(0);
}
const remaining = args.filter((value) => !modes.includes(value));
if (
  args.filter((value) => modes.includes(value)).length !== 1 ||
  (remaining.length &&
    (remaining.length !== 2 ||
      remaining[0] !== "--cloudflared" ||
      !remaining[1]))
) {
  console.error(help);
  process.exit(2);
}
const portable = join(toolsDirectory, "cloudflared.exe");
const cloudflared =
  remaining[1] ||
  process.env.CLOUDFLARED_PATH ||
  (process.platform === "win32" && existsSync(portable)
    ? portable
    : "cloudflared");
async function main() {
  await prepareRuntime();
  let configured = {};
  try {
    configured = parseEnv(await readFile(join(root, ".env"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const option = (name) => process.env[name] || configured[name];
  const fingerprint = await sourceFingerprint();
  const rtcConfiguration = {
    iceServers:
      option("VITE_ICE_SERVERS") ||
      '[{"urls":"stun:stun.cloudflare.com:3478"},{"urls":"stun:stun.l.google.com:19302"}]',
    policy: option("VITE_ICE_POLICY") || "all",
  };
  const configurationFingerprint = createHash("sha256")
    .update(JSON.stringify(rtcConfiguration))
    .digest("hex");
  const isolated =
    checkOnly ||
    (process.env.NODE_ENV === "test" && !process.env.DS01_DATA_DIR);
  if (!isolated) {
    let active;
    try {
      const lock = JSON.parse(
        await readFile(join(dataRoot, "demo.lock"), "utf8"),
      );
      const previous = JSON.parse(
        await readFile(join(dataRoot, "last-session.json"), "utf8"),
      );
      if (
        lock.pid === previous.processId &&
        !previous.finishedAt &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(previous.dashboardUrl)
      ) {
        const response = await fetch(previous.dashboardUrl + "/api/state", {
          signal: AbortSignal.timeout(2000),
        });
        const state = await response.json();
        if (
          response.ok &&
          state.directory === previous.directory &&
          state.processes.some((item) => item.pid === lock.pid && item.running)
        )
          active = previous;
      }
    } catch {}
    if (active) {
      console.log(
        `DS01 is already running. Dashboard: ${active.dashboardUrl}\nPersistent data: ${dataRoot}\nWeb: ${active.urls.web}`,
      );
      if (active.sourceFingerprint !== fingerprint) {
        console.error(
          "Mã nguồn đã thay đổi; phiên demo đang chạy vẫn dùng bản cũ. Nhấn Ctrl+C ở terminal demo cũ, rồi chạy lại npm.cmd run demo:public (hoặc demo:local). Dữ liệu tài khoản được giữ nguyên.",
        );
        process.exitCode = 1;
        return;
      }
      if (active.configurationFingerprint !== configurationFingerprint) {
        console.error(
          "Cấu hình WebRTC đã thay đổi; phiên demo đang chạy vẫn dùng cấu hình cũ. Nhấn Ctrl+C ở terminal demo cũ, chạy lại lệnh demo và mở URL Web mới trên cả hai thiết bị.",
        );
        process.exitCode = 1;
        return;
      }
      if ((active.mode === "temporary-public") !== publicMode) {
        console.error(
          "Stop the existing demo with Ctrl+C in its terminal before changing local/public mode.",
        );
        process.exitCode = 1;
      } else
        console.log(
          "Reusing the existing demo; no services or account files were restarted.",
        );
      return;
    }
  }
  if (publicMode) {
    const version = spawnSync(cloudflared, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (version.error || version.status !== 0) {
      console.error(
        `Install official cloudflared at ${portable} or set CLOUDFLARED_PATH. No tunnel or demo service was started.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const directory = await mkdtemp(join(runtimeRoot, "ds01-public-demo-"));
  console.log(`Demo data: ${directory}`);
  const webRoot = join(directory, "web");
  const children = [];
  const report = {
    mode: publicMode
      ? checkOnly
        ? "public-check"
        : "temporary-public"
      : checkOnly
        ? "local-check"
        : "local",
    startedAt: new Date().toISOString(),
    directory,
    processId: process.pid,
    sourceFingerprint: fingerprint,
    configurationFingerprint,
    wanNatVerified: false,
    publicReachable: false,
  };
  let server,
    dashboard,
    releaseDemo,
    stopping = false,
    stopRequested = false,
    initialized = false,
    failure;
  let endSession;
  const sessionEnded = new Promise((resolve) => {
    endSession = resolve;
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function launch(name, executable, commandArgs, env = {}, persistent = true) {
    const childEnv = { ...process.env, ...env };
    if (name.startsWith("tunnel-"))
      for (const key of Object.keys(childEnv))
        if (key.startsWith("TUNNEL_")) delete childEnv[key];
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stream = createWriteStream(join(directory, `${name}.log`));
    const item = { name, child, stream, output: "", code: null, error: null };
    children.push(item);
    stream.on("error", (error) => {
      item.error = Error(`Cannot write ${name}.log: ${error.message}`);
      failure = item.error;
      stopRequested = true;
      endSession();
    });
    const capture = (data) => {
      if (!stream.destroyed) stream.write(data);
      item.output = (item.output + data).slice(-250000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    item.closed = new Promise((resolve) => {
      child.once("error", (error) => {
        item.error = error;
        resolve();
      });
      child.once("close", (code) => {
        item.code = code;
        if (persistent && !stopping && !item.expectedStop) {
          item.error = new Error(`${name} stopped unexpectedly (${code})`);
          if (initialized) {
            if (
              ["relay", "backup", "tunnel-relay", "tunnel-backup"].includes(
                name,
              )
            )
              console.warn(
                `${item.error.message}. Keeping signaling, web and the other relay running for failover.`,
              );
            else {
              failure = item.error;
              endSession();
            }
          }
        }
        resolve();
      });
    });
    return item;
  }
  async function until(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let cause;
    while (Date.now() < deadline) {
      if (stopRequested) throw failure || Error("Demo stopped");
      for (const item of children) if (item.error) throw item.error;
      try {
        const value = await fn();
        if (value) return value;
      } catch (error) {
        cause = error;
      }
      await pause(100);
    }
    throw Error(
      `${label} timed out${cause ? `: ${cause.message}` : ""}. Logs: ${directory}`,
    );
  }
  async function freePort() {
    const listener = createPortServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    return port;
  }
  async function healthy(url) {
    return until(
      async () => (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok,
      url,
      publicMode ? 90000 : 20000,
    );
  }
  async function tunnel(name, origin, config) {
    const item = launch(`tunnel-${name}`, cloudflared, [
      "tunnel",
      "--config",
      config,
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--metrics",
      "127.0.0.1:0",
      "--url",
      origin,
    ]);
    return until(
      () =>
        item.output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0],
      `${name} tunnel`,
      90000,
    );
  }
  async function probe(name, commandArgs, env) {
    const item = launch(name, process.execPath, commandArgs, env, false);
    let timer;
    try {
      await Promise.race([
        item.closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`${name} timed out`)), 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (item.error || item.code !== 0) {
      const reason =
        item.error?.message || item.output.match(/^ERROR: (.+)$/m)?.[1]?.trim();
      throw Error(
        `${name} failed${reason ? `: ${reason}` : ""}. Logs: ${join(directory, `${name}.log`)}`,
      );
    }
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  async function serve(request, response) {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      const target = resolve(webRoot, `.${pathname}`),
        path = relative(webRoot, target);
      if (
        path.startsWith("..") ||
        isAbsolute(path) ||
        path.split(/[\\/]/).some((part) => part.startsWith("."))
      ) {
        response.writeHead(403).end();
        return;
      }
      let file = target;
      try {
        if (!(await stat(file)).isFile()) file = join(webRoot, "index.html");
      } catch {
        if (extname(pathname)) {
          response.writeHead(404).end();
          return;
        }
        file = join(webRoot, "index.html");
      }
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(400).end();
    }
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      stopRequested = true;
      endSession();
    });
  const startupDeadline = setTimeout(() => {
    failure = Error("Demo startup deadline exceeded");
    stopRequested = true;
    endSession();
  }, 180000);
  try {
    const stateDirectory = isolated ? join(directory, "data") : dataRoot;
    await mkdir(stateDirectory, { recursive: true });
    releaseDemo = await acquireStorageLock(stateDirectory, "demo");
    const migration = await prepareData(stateDirectory, {
      migrate: !isolated && option("DS01_MIGRATE_LEGACY") !== "0",
    });
    const secrets = await durableDemoSecrets(stateDirectory, option);
    report.dataDirectory = stateDirectory;
    console.log(
      `Persistent data: ${stateDirectory}${isolated ? " (isolated check)" : ""}`,
    );
    if (migration.migrated)
      console.log(
        "Existing accounts and groups imported; original files retained in migration-backup.",
      );
    if (migration.conflicts.length)
      console.warn(
        `Account name conflicts retained for review: ${migration.conflicts.join(", ")}`,
      );
    const [signalPort, relayPort, backupPort, webPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    const local = {
      signal: `http://127.0.0.1:${signalPort}`,
      relay: `http://127.0.0.1:${relayPort}`,
      backup: `http://127.0.0.1:${backupPort}`,
      web: `http://127.0.0.1:${webPort}`,
    };
    report.local = local;
    const env = {
      NODE_ENV: "production",
      DS01_BIND_HOST: "127.0.0.1",
      SIGNAL_PORT: String(signalPort),
      RELAY_PORT: String(relayPort),
      SIGNAL_INTERNAL_URL: local.signal,
      DS01_DATA_DIR: stateDirectory,
      SIGNAL_STATE_PATH: join(stateDirectory, "signaling.json"),
      ACCOUNT_STATE_PATH: join(stateDirectory, "accounts.json"),
      RELAY_STATE_PATH: join(stateDirectory, "relay-primary.json"),
      ...secrets,
      API_INTERNAL_URL: "http://127.0.0.1:1",
    };
    const runner = join(root, "scripts/run-node.mjs");
    launch("signaling", process.execPath, [runner, "signaling"], env);
    const initialRelay = launch(
      "relay-initial",
      process.execPath,
      [runner, "relay"],
      { ...env, RELAY_PUBLIC_URL: local.relay },
    );
    const initialBackup = launch(
      "backup-initial",
      process.execPath,
      [runner, "relay"],
      {
        ...env,
        RELAY_PORT: String(backupPort),
        RELAY_PUBLIC_URL: local.backup,
        RELAY_STATE_PATH: join(stateDirectory, "relay-backup.json"),
      },
    );
    await Promise.all([
      healthy(`${local.signal}/health`),
      healthy(`${local.relay}/health`),
      healthy(`${local.backup}/health`),
    ]);
    let urls = local;
    if (publicMode) {
      console.log("Opening HTTPS tunnels...");
      const config = join(directory, "cloudflared.yml");
      await writeFile(config, "{}\n");
      const [signal, relay, backup, web] = await Promise.all(
        ["signal", "relay", "backup", "web"].map((name) =>
          tunnel(name, local[name], config),
        ),
      );
      urls = { signal, relay, backup, web };
    }
    for (const item of [initialRelay, initialBackup]) {
      item.expectedStop = true;
      item.child.kill();
      await item.closed;
    }
    const clusterEnv = {
      ...env,
      RELAY_OFFLINE_QUEUE: "1",
      ALLOW_LOCAL_SUPERPEERS: publicMode
        ? "0"
        : option("ALLOW_LOCAL_SUPERPEERS") || "0",
      RELAY_CLUSTER_URLS: [urls.relay, urls.backup].join(","),
      RELAY_CLUSTER_ROUTES: JSON.stringify({
        [urls.relay]: local.relay,
        [urls.backup]: local.backup,
      }),
    };
    launch("relay", process.execPath, [runner, "relay"], {
      ...clusterEnv,
      RELAY_PUBLIC_URL: urls.relay,
      SUPER_PEER_ID:
        publicMode && checkOnly
          ? "super-check-primary"
          : option("SUPER_PEER_ID") || "",
    });
    launch("backup", process.execPath, [runner, "relay"], {
      ...clusterEnv,
      RELAY_PORT: String(backupPort),
      RELAY_PUBLIC_URL: urls.backup,
      RELAY_STATE_PATH: join(stateDirectory, "relay-backup.json"),
      SUPER_PEER_ID:
        publicMode && checkOnly
          ? "super-check-backup"
          : option("SUPER_PEER_BACKUP_ID") || "",
    });
    report.urls = urls;
    dashboard = await createDemoDashboard(() => ({
      ...report,
      processes: children
        .filter(
          (item) =>
            ["signaling", "relay", "backup"].includes(item.name) ||
            item.name.startsWith("tunnel-"),
        )
        .map((item) => ({
          name: item.name,
          pid: item.child.pid,
          running: item.child.exitCode === null && !item.error,
        }))
        .concat({
          name: "web + dashboard",
          pid: process.pid,
          running: !stopping,
        }),
      logs: children
        .filter((item) => ["signaling", "relay", "backup"].includes(item.name))
        .map((item) => ({ name: item.name, text: item.output })),
    }));
    report.dashboardUrl = dashboard.url;

    Object.assign(process.env, {
      NODE_ENV: "production",
      VITE_SIGNAL_URL: urls.signal,
      VITE_RELAY_URL: urls.relay,
      VITE_RELAY_URLS: urls.backup,
      VITE_E2EE: "1",
      VITE_RELAY_SELECTION: "latency-load",
      VITE_ICE_SERVERS: rtcConfiguration.iceServers,
      VITE_ICE_POLICY: rtcConfiguration.policy,
    });
    await mkdir(webRoot, { recursive: true });
    await build({
      root: join(root, "src/web-peer"),
      envDir: false,
      logLevel: "silent",
      build: { outDir: webRoot, emptyOutDir: false },
    });
    server = createServer((request, response) => {
      void serve(request, response);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(webPort, "127.0.0.1", resolve);
    });
    await Promise.all([
      healthy(`${urls.signal}/health`),
      healthy(`${urls.relay}/health`),
      healthy(`${urls.backup}/health`),
      healthy(urls.web),
    ]);
    console.log(
      `Checking ${publicMode ? "public" : "local"} endpoints and Socket.IO discovery, validation, relay delivery...`,
    );
    for (const mode of ["discovery", "validation"])
      await probe(
        `probe-${mode}`,
        [
          join(root, "scripts/manual-probe.mjs"),
          mode,
          "--signal",
          urls.signal,
          "--relay",
          urls.relay,
        ],
        env,
      );
    await probe(
      "probe-load",
      [
        join(root, "scripts/load-relay.mjs"),
        "--peers",
        "3",
        "--messages",
        "1",
        "--concurrency",
        "1",
        "--signal",
        urls.signal,
        "--relay",
        urls.relay,
      ],
      env,
    );
    await probe(
      "probe-backup",
      [
        join(root, "scripts/load-relay.mjs"),
        "--peers",
        "3",
        "--messages",
        "1",
        "--concurrency",
        "1",
        "--signal",
        urls.signal,
        "--relay",
        urls.backup,
      ],
      env,
    );
    if (publicMode && checkOnly) {
      await probe(
        "probe-election",
        [
          join(root, "scripts/advanced-probe.mjs"),
          urls.signal,
          urls.relay,
          urls.backup,
        ],
        env,
      );
      report.publicElectionVerified = true;
    }
    Object.assign(report, {
      passed: true,
      urls,
      local,
      publicReachable: publicMode,
      scope:
        "Endpoint reachability and real Socket.IO probes; not proof of two networks, NAT failure or TURN.",
    });
    await writeFile(
      join(directory, "session.json"),
      JSON.stringify(report, null, 2),
    );
    if (!isolated)
      await writeFile(
        join(stateDirectory, "last-session.json"),
        JSON.stringify(report, null, 2),
      );
    console.log(`Session: ${join(directory, "session.json")}`);
    if (checkOnly) console.log(`DS01_DEMO_CHECK ${JSON.stringify(report)}`);
    else {
      console.log(`Dashboard (this computer only): ${dashboard.url}`);
      console.log(
        `Web: ${urls.web}\nSignaling: ${urls.signal}\nRelay: ${urls.relay}\nBackup relay: ${urls.backup}`,
      );
      console.log(
        publicMode
          ? "Use your existing accounts, or create accounts once. Use Wi-Fi and 4G on separate devices. Ctrl+C stops the URLs; accounts and groups remain saved."
          : "Local demo ready. Ctrl+C stops the demo services and dashboard; account data remains saved.",
      );
      initialized = true;
      clearTimeout(startupDeadline);
      await sessionEnded;
      if (failure) throw failure;
    }
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    console.error(`Demo failed: ${error.message}\nLogs: ${directory}`);
    process.exitCode = 1;
  } finally {
    stopping = true;
    clearTimeout(startupDeadline);
    for (const item of children)
      if (item.child.exitCode === null) item.child.kill();
    await Promise.all(
      children.map(async (item) => {
        let timer;
        try {
          await Promise.race([
            item.closed,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 3000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const item of children)
      if (!item.stream.destroyed)
        await new Promise((resolve) => {
          item.stream.once("close", resolve);
          item.stream.end();
        });
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await dashboard?.close();
    report.finishedAt = new Date().toISOString();
    try {
      await writeFile(
        join(directory, "session.json"),
        JSON.stringify(report, null, 2),
      );
      if (!isolated && report.dataDirectory)
        await writeFile(
          join(report.dataDirectory, "last-session.json"),
          JSON.stringify(report, null, 2),
        );
    } catch (error) {
      console.error(`Cannot save session.json: ${error.message}`);
      process.exitCode = 1;
    }
    await releaseDemo?.();
  }
}
await main().catch((error) => {
  console.error(`Cannot prepare demo in ${runtimeRoot}: ${error.message}`);
  process.exitCode = 1;
});
