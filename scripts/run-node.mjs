import { build, context } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { prepareRuntime, runtimeTemp, dataRoot } from "./runtime-paths.mjs";
import {
  prepareData,
  acquireStorageLock,
} from "../src/server-kit/storagePaths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [kind, ...flags] = process.argv.slice(2);
const entries = {
  signaling: "src/signaling/index.ts",
  relay: "src/relay/index.ts",
  benchmark: "scripts/benchmark-relay.ts",
};
if (
  !Object.hasOwn(entries, kind) ||
  flags.some((flag) => flag !== "--watch") ||
  (kind === "benchmark" && flags.length)
)
  throw Error(
    "Usage: node scripts/run-node.mjs signaling|relay [--watch], or benchmark",
  );
const watching = flags.includes("--watch");
if (process.env.NODE_ENV !== "test") loadEnv({ path: join(root, ".env") });
await prepareRuntime();
process.env.DS01_PROJECT_ROOT = root;
let releaseStorage;
const statePath =
  kind === "signaling"
    ? process.env.SIGNAL_STATE_PATH || join(dataRoot, "signaling.json")
    : process.env.RELAY_STATE_PATH ||
      join(
        dataRoot,
        `relay-${process.env.RELAY_PORT === "4003" ? "backup" : !process.env.RELAY_PORT || process.env.RELAY_PORT === "4002" ? "primary" : process.env.RELAY_PORT}.json`,
      );
if (
  kind !== "benchmark" &&
  !process.env.SIGNAL_STATE_PATH &&
  !process.env.RELAY_STATE_PATH
)
  await prepareData();
if (kind !== "benchmark") {
  const normalized =
    process.platform === "win32"
      ? resolve(statePath).toLowerCase()
      : resolve(statePath);
  const lock =
    kind === "signaling"
      ? "signaling"
      : `relay-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
  releaseStorage = await acquireStorageLock(dirname(statePath), lock);
}

const directory = join(runtimeTemp, `runtime-${kind}-${randomUUID()}`);
const outfile = join(directory, "entry.mjs");
await mkdir(directory, { recursive: true });
let service,
  watcher,
  stopping = false,
  revision = 0;
async function start() {
  if (stopping) return;
  if (service) await service.close();
  service = undefined;
  const module = await import(
    `${pathToFileURL(outfile).href}?revision=${++revision}`
  );
  if (kind === "benchmark") return;
  service =
    kind === "signaling"
      ? module.createSignaling(undefined, undefined, undefined, {
          statePath,
          accountStatePath:
            process.env.ACCOUNT_STATE_PATH ||
            (process.env.SIGNAL_STATE_PATH
              ? `${statePath}.accounts.json`
              : join(dataRoot, "accounts.json")),
        })
      : module.createRelay(undefined, undefined, undefined, {
          statePath,
          offlineQueue: process.env.RELAY_OFFLINE_QUEUE !== "0",
        });
  const port = Number(
    kind === "signaling"
      ? process.env.SIGNAL_PORT || 4001
      : process.env.RELAY_PORT || 4002,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Service port must be 1..65535");
  await new Promise((resolve, reject) => {
    service.httpServer.once("error", reject);
    service.httpServer.listen(
      port,
      process.env.DS01_BIND_HOST || "0.0.0.0",
      resolve,
    );
  });
  console.log(
    `${new Date().toISOString()} [${kind}] LISTENING ${port} node=${process.env.NODE_ID || `${kind}-${process.pid}`}`,
  );
}
async function removeBundle() {
  const checked = resolve(directory);
  if (
    dirname(checked) !== runtimeTemp ||
    !basename(checked).startsWith(`runtime-${kind}-`)
  )
    throw Error("Unexpected runtime cleanup path");
  await rm(checked, { recursive: true, force: true });
}
async function stop() {
  stopping = true;
  if (watcher) await watcher.dispose();
  if (service) await service.close();
  await releaseStorage?.();
  releaseStorage = undefined;
  await removeBundle();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );
  });
const options = {
  absWorkingDir: root,
  entryPoints: [entries[kind]],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@ds01/shared": join(root, "src/shared/index.ts") },
  sourcemap: "inline",
  plugins: [
    {
      name: "external-dependencies",
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^(dotenv|express|jsonwebtoken|socket\.io|socket\.io-client|zod)(\/.*)?$/,
          },
          (args) => ({ path: import.meta.resolve(args.path), external: true }),
        );
      },
    },
  ],
};
try {
  if (watching) {
    watcher = await context({
      ...options,
      plugins: [
        ...options.plugins,
        {
          name: "restart-service",
          setup(builder) {
            builder.onEnd(async (result) => {
              if (result.errors.length || stopping) return;
              try {
                await start();
              } catch (error) {
                console.error(`Service restart failed: ${error.message}`);
              }
            });
          },
        },
      ],
    });
    await watcher.watch();
  } else {
    await build(options);
    await start();
    await removeBundle();
  }
} catch (error) {
  console.error(`Cannot start ${kind}: ${error.message}`);
  process.exitCode = 1;
  await stop();
}
