import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { prepareRuntime, runtimeRoot } from "./runtime-paths.mjs";

await prepareRuntime();
const root = fileURLToPath(new URL("..", import.meta.url)),
  directory = await mkdtemp(join(runtimeRoot, "browser-account-recovery-"));
const children = [],
  logs = {},
  report = {
    startedAt: new Date().toISOString(),
    scope:
      "Real Chrome with E2EE, isolated browser devices and different localhost origins; not WAN evidence",
    checks: [],
  };
console.log(`Account recovery browser evidence: ${directory}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 25000) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (value) {
      error = value;
    }
    await pause(100);
  }
  throw Error(`Timeout: ${label}${error ? ` (${error.message})` : ""}`);
}
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function launch(name, executable, args, cwd = root, env = {}) {
  logs[name] = "";
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (bytes) => (logs[name] += bytes));
  child.stderr.on("data", (bytes) => (logs[name] += bytes));
  child.on("error", (error) => (logs[name] += error.message));
  return child;
}
function check(label, result) {
  report.checks.push({ label, passed: !!result });
  console.log(`${result ? "PASS" : "FAIL"} ${label}`);
  if (!result) throw Error(label);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    pause(3000),
  ]);
}
let ws, call;
const deadline = setTimeout(() => {
  for (const child of children) child.kill();
  console.error("Account browser deadline exceeded");
  process.exit(2);
}, 180000);
try {
  const work = join(directory, "data");
  await mkdir(work);
  const [sp, rp, wp] = await Promise.all([port(), port(), port()]);
  const signalUrl = `http://127.0.0.1:${sp}`,
    relayUrl = `http://127.0.0.1:${rp}`,
    webUrl = `http://127.0.0.1:${wp}`;
  const env = {
    NODE_ENV: "production",
    DS01_BIND_HOST: "127.0.0.1",
    DS01_DATA_DIR: work,
    DS01_MIGRATE_LEGACY: "0",
    JWT_SECRET: randomUUID() + randomUUID(),
    PEER_SECRET: randomUUID() + randomUUID(),
    SIGNAL_PORT: String(sp),
    RELAY_PORT: String(rp),
    SIGNAL_INTERNAL_URL: signalUrl,
    SIGNAL_STATE_PATH: join(work, "signaling.json"),
    ACCOUNT_STATE_PATH: join(work, "accounts.json"),
    RELAY_STATE_PATH: join(work, "relay.json"),
    RELAY_OFFLINE_QUEUE: "1",
  };
  const runner = join(root, "scripts/run-node.mjs");
  let signal = launch(
    "signaling",
    process.execPath,
    [runner, "signaling"],
    root,
    env,
  );
  launch("relay", process.execPath, [runner, "relay"], root, env);
  launch(
    "web",
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "--host",
      "0.0.0.0",
      "--port",
      String(wp),
      "--strictPort",
    ],
    join(root, "src/web-peer"),
    {
      VITE_SIGNAL_URL: signalUrl,
      VITE_RELAY_URL: relayUrl,
      VITE_RELAY_URLS: "",
      VITE_E2EE: "1",
      VITE_ICE_SERVERS: "[]",
    },
  );
  await Promise.all(
    [signalUrl + "/health", relayUrl + "/health", webUrl].map((url) =>
      until(async () => (await fetch(url)).ok, url),
    ),
  );
  const executable =
    process.env.CHROME_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(existsSync);
  if (!executable)
    throw Error("Set CHROME_PATH to your installed Chromium browser");
  const profile = join(directory, "chrome");
  launch("chrome", executable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  const [debugPort, suffix] = (
    await until(
      () => readFile(join(profile, "DevToolsActivePort"), "utf8"),
      "Chrome",
    )
  )
    .trim()
    .split(/\r?\n/);
  ws = new WebSocket(`ws://127.0.0.1:${debugPort}${suffix}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const value = JSON.parse(String(event.data));
    if (value.method === "Runtime.exceptionThrown")
      (report.browserErrors ||= []).push(value.params.exceptionDetails.text);
    const item = pending.get(value.id);
    if (item) {
      clearTimeout(item.timer);
      pending.delete(value.id);
      value.error
        ? item.reject(Error(JSON.stringify(value.error)))
        : item.resolve(value.result);
    }
  };
  ws.onclose = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error("Browser closed"));
    }
    pending.clear();
  };
  call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`CDP timeout: ${method}`));
        }, 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const evaluate = async (session, expression) => {
    const result = await call(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      session,
    );
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const fill = async (session, selector, value) => {
    await evaluate(
      session,
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await pause(60);
  };
  const click = async (session, selector) => {
    await until(
      () =>
        evaluate(
          session,
          `!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      selector,
    );
    await evaluate(
      session,
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  };
  const device = async (url = webUrl) => {
    const { browserContextId } = await call("Target.createBrowserContext"),
      { targetId } = await call("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      }),
      { sessionId } = await call("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
    await call("Runtime.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);
    await call(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `window.qaPackets=[];const send=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(data){window.qaPackets.push(JSON.parse(String(data)));return send.call(this,data);};`,
      },
      sessionId,
    );
    await call("Page.navigate", { url }, sessionId);
    await until(
      () =>
        evaluate(sessionId, '!!document.querySelector("input[name=username]")'),
      "login form",
    );
    return sessionId;
  };
  const password = "Browser account recovery passphrase 2026!";
  const online = (session) =>
    until(
      () =>
        evaluate(
          session,
          'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
        ),
      "online E2EE peer",
    );
  const login = async (
    session,
    username,
    takeover = false,
    value = password,
  ) => {
    await fill(session, "input[name=username]", username);
    await fill(session, "input[name=password]", value);
    if (takeover) await click(session, ".toggle-setting input[type=checkbox]");
    await click(session, ".connect-card button[type=submit]");
  };
  const register = async (session, username, name) => {
    await click(session, ".auth-tabs button:nth-child(2)");
    await fill(session, "input[autocomplete=nickname]", name);
    await fill(session, "input[name=username]", username);
    await fill(session, "input[name=password]", password);
    await fill(session, "input[name=confirmation]", password);
    await click(session, ".connect-card button[type=submit]");
    await until(
      () => evaluate(session, '!!document.querySelector(".auth-success")'),
      "registration",
    );
    await login(session, username);
    await online(session);
  };
  const choose = async (session, name) => {
    await until(
      () =>
        evaluate(
          session,
          `[...document.querySelectorAll('nav .conversation')].some(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)})`,
        ),
      "conversation",
    );
    await evaluate(
      session,
      `[...document.querySelectorAll('nav .conversation')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`,
    );
  };
  const send = async (session, text) => {
    await fill(session, "textarea", text);
    await click(session, ".send-button");
  };
  const history = (session, username) =>
    evaluate(
      session,
      `JSON.parse(localStorage.getItem('ds01-history-v1-user_${username}')||'[]')`,
    );
  const backedUp = async (username, text) =>
    until(async () => {
      const value = JSON.parse(
        await readFile(
          join(work, `account-data/user_${username}.json`),
          "utf8",
        ),
      );
      return (
        value.backup?.version > 0 &&
        (!text || !JSON.stringify(value).includes(text)) &&
        value
      );
    }, "encrypted backup saved");
  const synced = async (session) => {
    await click(session, ".diagnostics-link");
    await until(
      () =>
        evaluate(
          session,
          'document.querySelector(".advanced-panel")?.textContent.includes("Đã đồng bộ")',
        ),
      "synchronized state",
    );
    await click(session, ".diagnostics .icon-button");
  };
  const a = await device(),
    b = await device();
  await register(a, "recovery-a", "Recovery A");
  await register(b, "recovery-b", "Recovery B");
  await choose(a, "Recovery B");
  await choose(b, "Recovery A");
  await send(a, "Private message before switching devices");
  await until(
    async () =>
      (await history(a, "recovery-a")).some(
        (row) => row.status === "delivered",
      ),
    "E2EE ACK",
  );
  check(
    "authenticated browser peers exchange encrypted DIRECT messages and ACKs",
    await evaluate(
      a,
      'qaPackets.length>0&&qaPackets.every(packet=>packet.type==="sealed")',
    ),
  );
  const bytes = Buffer.from(
      Array.from({ length: 32768 }, (_, index) => index % 251),
    ),
    file = join(directory, "recovery-file.bin");
  await writeFile(file, bytes);
  const document = await call("DOM.getDocument", {}, a),
    field = await call(
      "DOM.querySelector",
      { nodeId: document.root.nodeId, selector: "input[type=file]" },
      a,
    );
  await call(
    "DOM.setFileInputFiles",
    { files: [file], nodeId: field.nodeId },
    a,
  );
  const fileRow = await until(
    async () =>
      (await history(b, "recovery-b")).find(
        (row) => row.message.type === "attachment",
      ),
    "received E2EE file",
  );
  await synced(b);
  const before = await backedUp(
    "recovery-b",
    "Private message before switching devices",
  );
  check(
    "server persists an encrypted archive without plaintext messages or password",
    !JSON.stringify(before).includes(password),
  );
  const identity = await evaluate(
    b,
    `(async()=>{const {WebStore}=await import('/store.ts');const key=await new WebStore('user_recovery-b').getIdentity();return JSON.stringify(key.public)})()`,
  );
  const fresh = await device(webUrl.replace("127.0.0.1", "localhost"));
  check(
    "new device and new URL origin begin without history or keys",
    await evaluate(
      fresh,
      `localStorage.getItem('ds01-history-v1-user_recovery-b')===null`,
    ),
  );
  await login(fresh, "recovery-b", false, "A wrong password");
  await until(
    () => evaluate(fresh, '!!document.querySelector("[role=alert]")'),
    "wrong password",
  );
  check(
    "wrong password cannot recover or replace the account vault",
    await evaluate(fresh, '!document.querySelector(".chat-layout")'),
  );
  await login(fresh, "recovery-b");
  await until(
    () =>
      evaluate(
        fresh,
        'document.querySelector("[role=alert]")?.textContent.includes("online")',
      ),
    "active session rejected",
  );
  check(
    "an active account requires explicit transfer to the new device",
    await evaluate(b, '!!document.querySelector(".self-profile .avatar")'),
  );
  await login(fresh, "recovery-b", true);
  await online(fresh);
  await until(
    () => evaluate(b, '!!document.querySelector("input[name=username]")'),
    "old device revoked",
  );
  check(
    "transfer disconnects the old device and restores the chat history",
    (await history(fresh, "recovery-b")).some(
      (row) => row.message.body === "Private message before switching devices",
    ),
  );
  const restored = await evaluate(
    fresh,
    `(async()=>{const {WebStore}=await import('/store.ts');const s=new WebStore('user_recovery-b'), key=await s.getIdentity(), keys=await s.getAccountKeys(), file=await s.getFile(${JSON.stringify(fileRow.message.attachments[0].id)});const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',file.data))].map(b=>b.toString(16).padStart(2,'0')).join('');return {public:JSON.stringify(key.public),extractable:key.encryptionPrivate.extractable||key.signingPrivate.extractable||keys.key.extractable,hash}})()`,
  );
  check(
    "new device recovers the same identity, nonextractable keys and exact file bytes",
    restored.public === identity &&
      !restored.extractable &&
      restored.hash === createHash("sha256").update(bytes).digest("hex"),
  );
  await choose(fresh, "Recovery A");
  await send(fresh, "Private reply from the recovered device");
  await until(
    async () =>
      (await history(fresh, "recovery-b")).some(
        (row) =>
          row.message.body === "Private reply from the recovered device" &&
          row.status === "delivered",
      ),
    "recovered key interoperability",
  );
  check(
    "recovered device keeps E2EE interoperability with the existing peer",
    (await history(a, "recovery-a")).some(
      (row) => row.message.body === "Private reply from the recovered device",
    ),
  );
  await evaluate(
    fresh,
    `window.realFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes('/account/backup')?Promise.reject(Error('QA backup network outage')):realFetch(...args)`,
  );
  await send(a, "Message while backup storage is unreachable");
  await until(
    async () =>
      (await history(fresh, "recovery-b")).some(
        (row) =>
          row.message.body === "Message while backup storage is unreachable",
      ),
    "local save during backup outage",
  );
  await click(fresh, ".diagnostics-link");
  await until(
    () =>
      evaluate(
        fresh,
        'document.querySelector(".advanced-panel")?.textContent.includes("Chờ đồng bộ")',
      ),
    "visible sync failure",
  );
  check(
    "backup outage preserves local messages and exposes a waiting state",
    true,
  );
  await evaluate(fresh, "window.fetch=window.realFetch");
  await until(
    () =>
      evaluate(
        fresh,
        'document.querySelector(".advanced-panel")?.textContent.includes("Đã đồng bộ")',
      ),
    "automatic sync retry",
  );
  await click(fresh, ".diagnostics .icon-button");
  check(
    "encrypted backup resumes automatically after connectivity returns",
    (await backedUp("recovery-b")).backup.version > before.backup.version,
  );
  const safety = await evaluate(
    fresh,
    `(async()=>{const {WebStore}=await import('/store.ts');const s=new WebStore('user_recovery-b'), original=JSON.stringify(await s.list()), snapshot=await s.snapshot();snapshot.files[0].data='A'.repeat(snapshot.files[0].data.length);let rejected=false;try{await s.restore(snapshot)}catch{rejected=true}return rejected&&original===JSON.stringify(await s.list())})()`,
  );
  check(
    "corrupted archived files are rejected before replacing local history",
    safety,
  );
  const rollback = await evaluate(
    fresh,
    `(async()=>{const {WebStore}=await import('/store.ts');const s=new WebStore('user_recovery-b'), original=JSON.stringify(await s.snapshot()), snapshot=await s.snapshot();snapshot.contacts.push({peerId:'user_new',name:'New',email:'',updatedAt:Date.now()});const write=Storage.prototype.setItem;let fail=true;Storage.prototype.setItem=function(k,v){if(fail&&k==='ds01-history-v1-user_recovery-b'){fail=false;throw new DOMException('Quota exceeded','QuotaExceededError')}return write.call(this,k,v)};let rejected=false;try{await s.restore(snapshot)}catch{rejected=true}finally{Storage.prototype.setItem=write}return rejected&&original===JSON.stringify(await s.snapshot())})()`,
  );
  check(
    "browser quota failure rolls back history and contact changes",
    rollback,
  );
  await stop(signal);
  signal = launch(
    "signaling-restart",
    process.execPath,
    [runner, "signaling"],
    root,
    env,
  );
  await until(
    async () => (await fetch(signalUrl + "/health")).ok,
    "signaling restart",
  );
  await online(a);
  await online(fresh);
  check(
    "server restarts with the same account database and reconnects existing peers",
    true,
  );
  const newest = await device();
  await login(newest, "recovery-b", true);
  await online(newest);
  check(
    "a fresh device restores the latest archive after server restart",
    (await history(newest, "recovery-b")).some(
      (row) =>
        row.message.body === "Message while backup storage is unreachable",
    ),
  );
  await call(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    newest,
  );
  check(
    "restored mobile chat has no horizontal overflow",
    await evaluate(newest, "document.documentElement.scrollWidth<=innerWidth"),
  );
  const shot = await call("Page.captureScreenshot", { format: "png" }, newest);
  await writeFile(
    join(directory, "recovered-mobile.png"),
    Buffer.from(shot.data, "base64"),
  );
  check("browser has no uncaught exceptions", !report.browserErrors?.length);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || error.message;
  console.error(report.error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      await call("Browser.close");
    } catch {}
    ws.close();
  }
  await Promise.all(children.map(stop));
  for (const [name, value] of Object.entries(logs))
    await writeFile(join(directory, `${name}.log`), value);
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `Account recovery browser result: ${report.passed ? "PASS" : "FAIL"} (${report.checks.length} checks)`,
  );
}
