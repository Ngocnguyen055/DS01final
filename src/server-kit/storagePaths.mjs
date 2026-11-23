import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  copyFile,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { parse } from "dotenv";

function findProjectRoot() {
  if (process.env.DS01_PROJECT_ROOT)
    return resolve(process.env.DS01_PROJECT_ROOT);
  let path = process.cwd();
  while (true) {
    try {
      if (
        JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name ===
        "ds01-p2p-chat"
      )
        return path;
    } catch {}
    const parent = dirname(path);
    if (parent === path) throw Error("Cannot locate the DS01 project root");
    path = parent;
  }
}
export const projectRoot = findProjectRoot();
let configured = {};
try {
  configured = parse(readFileSync(join(projectRoot, ".env"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
export const runtimeRoot = resolve(
  projectRoot,
  process.env.DS01_RUNTIME_DIR ||
    configured.DS01_RUNTIME_DIR ||
    "../DS01-runtime",
);
export const runtimeTemp = join(runtimeRoot, "tmp");
export const toolsDirectory = join(runtimeRoot, "tools");
export const dataRoot = resolve(
  projectRoot,
  process.env.DS01_DATA_DIR ||
    configured.DS01_DATA_DIR ||
    join(runtimeRoot, "data"),
);

export async function prepareRuntime() {
  await mkdir(runtimeTemp, { recursive: true });
  Object.assign(process.env, {
    TEMP: runtimeTemp,
    TMP: runtimeTemp,
    TMPDIR: runtimeTemp,
    DS01_PROJECT_ROOT: projectRoot,
    DS01_RUNTIME_DIR: runtimeRoot,
  });
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw Error(`Cannot read durable data ${path}: ${error.message}`);
  }
}
async function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temporary, path);
}
export async function acquireStorageLock(directory, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw Error("Invalid storage lock name");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.lock`),
    nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      } finally {
        await handle.close();
      }
      return async () => {
        const saved = await json(path);
        if (saved?.nonce === nonce)
          await unlink(path).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const saved = await json(path);
      let alive = Number.isInteger(saved?.pid) && saved.pid > 0;
      if (alive)
        try {
          process.kill(saved.pid, 0);
        } catch (probe) {
          alive = probe.code !== "ESRCH";
        }
      if (alive)
        throw Error(
          `DS01 ${name} is already using ${directory} (PID ${saved.pid}). Open its dashboard or stop that instance first.`,
        );
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  throw Error(`Cannot acquire storage lock: ${path}`);
}
export async function prepareData(directory = dataRoot, options = {}) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const markerPath = join(directory, "storage-version.json");
  if (existsSync(markerPath)) {
    await json(markerPath);
    return { directory, migrated: false, conflicts: [] };
  }
  const release = await acquireStorageLock(directory, "migration");
  try {
    if (existsSync(markerPath))
      return { directory, migrated: false, conflicts: [] };
    const legacy = options.legacyRoot || join(projectRoot, ".data"),
      runtime = options.runtime || runtimeRoot;
    const sources = [
      {
        accounts: join(legacy, "signaling.json.accounts.json"),
        signal: join(legacy, "signaling.json"),
        keys: join(legacy, "signaling.json.keys.json"),
      },
    ];
    if (options.migrate !== false) {
      const sessions = [];
      for (const entry of await readdir(runtime, { withFileTypes: true }).catch(
        () => [],
      )) {
        if (!entry.isDirectory() || !entry.name.startsWith("ds01-public-demo-"))
          continue;
        const path = join(runtime, entry.name),
          session = await json(join(path, "session.json")).catch(
            () => undefined,
          );
        if (session?.mode === "temporary-public")
          sessions.push({ path, startedAt: session.startedAt });
      }
      sessions.sort((a, b) =>
        String(b.startedAt).localeCompare(String(a.startedAt)),
      );
      for (const session of sessions)
        sources.push({
          accounts: join(session.path, "accounts.json"),
          signal: join(session.path, "state.json"),
          keys: join(session.path, "state.json.keys.json"),
        });
    } else sources.length = 0;
    const accountPath = join(directory, "accounts.json"),
      signalPath = join(directory, "signaling.json"),
      keyPath = join(directory, "signaling.json.keys.json");
    const accounts = (await json(accountPath)) || {
      version: 1,
      users: [],
      sessions: [],
    };
    const signal = (await json(signalPath)) || { identities: [], groups: [] },
      keys = (await json(keyPath)) || {};
    const conflicts = [],
      imported = [];
    const backup = join(
      directory,
      "migration-backup",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    for (const source of sources) {
      const users = await json(source.accounts);
      if (users) {
        if (users.version !== 1 || !Array.isArray(users.users))
          throw Error(`Invalid legacy account store: ${source.accounts}`);
        for (const user of users.users) {
          if (
            typeof user.username !== "string" ||
            user.peerId !== `user_${user.username}` ||
            !/^[a-f0-9]{128}$/.test(user.passwordHash) ||
            !/^[a-f0-9]{32}$/.test(user.salt)
          )
            throw Error(`Invalid account in ${source.accounts}`);
          const previous = accounts.users.find(
            (item) => item.username === user.username,
          );
          if (!previous) accounts.users.push(user);
          else if (
            previous.passwordHash !== user.passwordHash ||
            previous.salt !== user.salt
          )
            conflicts.push(user.username);
        }
      }
      const previousSignal = await json(source.signal),
        previousKeys = await json(source.keys);
      for (const identity of previousSignal?.identities || [])
        if (!signal.identities.some((item) => item[0] === identity[0]))
          signal.identities.push(identity);
      for (const group of previousSignal?.groups || [])
        if (!signal.groups.some((item) => item.id === group.id))
          signal.groups.push(group);
      for (const [peer, key] of Object.entries(previousKeys || {}))
        if (!Object.hasOwn(keys, peer))
          Object.defineProperty(keys, peer, {
            value: key,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      for (const file of Object.values(source))
        if (existsSync(file)) {
          await mkdir(backup, { recursive: true });
          await copyFile(
            file,
            join(
              backup,
              `${imported.length}-${file.endsWith("accounts.json") ? "accounts" : file.endsWith("keys.json") ? "keys" : "signaling"}.json`,
            ),
          );
          imported.push(file);
        }
    }
    await atomic(accountPath, accounts);
    await atomic(signalPath, signal);
    await atomic(keyPath, keys);
    await atomic(markerPath, {
      version: 1,
      createdAt: new Date().toISOString(),
      imported,
      conflicts: [...new Set(conflicts)],
    });
    return {
      directory,
      migrated: imported.length > 0,
      conflicts: [...new Set(conflicts)],
    };
  } finally {
    await release();
  }
}
export async function durableDemoSecrets(directory, option) {
  const path = join(directory, "service-secrets.json");
  const saved = (await json(path)) || {};
  for (const name of ["JWT_SECRET", "PEER_SECRET"]) {
    const value = option(name);
    if (value && value.length >= 32 && !value.includes("replace-with-"))
      saved[name] = value;
    else if (!saved[name]) saved[name] = randomBytes(32).toString("hex");
  }
  if (saved.JWT_SECRET === saved.PEER_SECRET)
    throw Error("JWT_SECRET and PEER_SECRET must be different");
  await atomic(path, saved);
  return saved;
}
