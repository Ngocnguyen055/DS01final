import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runtimeRoot, prepareRuntime } from "./runtime-paths.mjs";
import { createDemoDashboard } from "./demo-dashboard.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await prepareRuntime();
const evidence = await mkdtemp(join(runtimeRoot, "browser-smoke-"));
const qa = join(evidence, "work"),
  children = [],
  logs = { signal: "", primary: "", backup: "", web: "", chrome: "" };
console.log(`Browser evidence: ${evidence}`);
const report = {
  scope:
    "Real headless Chrome on localhost, separate signaling/relay/web processes; not WAN/NAT evidence",
  checks: [],
  startedAt: new Date().toISOString(),
};
const mandatory = {
  requirement: "DS01 section 5.10",
  scope: report.scope,
  scenarios: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    status: "not_run",
  })),
};
const scenario = (id, status, detail) =>
  Object.assign(mandatory.scenarios[id - 1], { status, detail });
scenario(
  1,
  "pending_internet",
  "Local services only; use demo:public or demo:public:check to verify public endpoints separately.",
);
scenario(
  6,
  "pending_network_domains",
  "No independent network domains or real NAT isolation in this browser suite; force-relay and closing DataChannels are not NAT evidence.",
);
const rtcProbe = `window.qaRTC=[];var Native=RTCPeerConnection;window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);window.qaRTC.push(this);}async createOffer(...args){if(window.qaDelayOfferMs)await new Promise(resolve=>setTimeout(resolve,window.qaDelayOfferMs));return super.createOffer(...args);}};window.qaWirePackets=[];window.qaWireSend=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(data){window.qaWirePackets.push(JSON.parse(String(data)));return window.qaWireSend.call(this,data);};`;
const processRows = [],
  pathProof = { scope: report.scope };
function sourceFingerprint() {
  const hash = createHash("sha256");
  function visit(dir) {
    for (const item of readdirSync(join(root, dir), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["dist", "node_modules"].includes(item.name)) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (/\.(ts|tsx|css|html|json)$/.test(path)) {
        hash.update(path.replaceAll("\\", "/"));
        hash.update(readFileSync(join(root, path)));
      }
    }
  }
  visit("src");
  hash.update(readFileSync(join(root, "package-lock.json")));
  return hash.digest("hex");
}
report.sourceFingerprint = sourceFingerprint();
report.node = process.version;
report.commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
report.workingTreeModified = !!execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browserCall, ws, chrome, dashboard;
function launch(name, executable, args, cwd = root, env = {}) {
  const c = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(c);
  processRows.push({ name, child: c });
  c.stdout.on("data", (b) => (logs[name] += b));
  c.stderr.on("data", (b) => (logs[name] += b));
  c.on("error", (error) => (logs[name] += error.message));
  return c;
}
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      error = e;
    }
    await pause(100);
  }
  throw new Error(`Timeout: ${label}${error ? ` (${error.message})` : ""}`);
}
function check(label, ok, detail) {
  report.checks.push({ label, passed: !!ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), pause(2000)]);
}
const deadline = setTimeout(() => {
  console.error("Browser smoke deadline exceeded");
  for (const child of children) child.kill();
  process.exit(2);
}, 180000);
try {
  await mkdir(qa, { recursive: true });
  const [sp, rp, bp, wp] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const signalUrl = `http://127.0.0.1:${sp}`,
    primaryUrl = `http://127.0.0.1:${rp}`,
    backupUrl = `http://127.0.0.1:${bp}`,
    webUrl = `http://127.0.0.1:${wp}`;
  const env = {
    NODE_ENV: "production",
    DS01_BIND_HOST: "127.0.0.1",
    RELAY_OFFLINE_QUEUE: "0",
    SIGNAL_PORT: String(sp),
    SIGNAL_INTERNAL_URL: signalUrl,
    PEER_SECRET: randomUUID() + randomUUID(),
    JWT_SECRET: randomUUID() + randomUUID(),
    SIGNAL_STATE_PATH: join(qa, "state.json"),
    ACCOUNT_STATE_PATH: join(qa, "accounts.json"),
  };
  const runner = join(root, "scripts/run-node.mjs");
  let signal = launch(
    "signal",
    process.execPath,
    [runner, "signaling"],
    root,
    env,
  );
  const primary = launch("primary", process.execPath, [runner, "relay"], root, {
    ...env,
    RELAY_PORT: String(rp),
    RELAY_STATE_PATH: join(qa, "primary.json"),
  });
  launch("backup", process.execPath, [runner, "relay"], root, {
    ...env,
    RELAY_PORT: String(bp),
    RELAY_STATE_PATH: join(qa, "backup.json"),
  });
  launch(
    "web",
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(wp),
      "--strictPort",
    ],
    join(root, "src/web-peer"),
    {
      VITE_SIGNAL_URL: signalUrl,
      VITE_RELAY_URL: primaryUrl,
      VITE_RELAY_URLS: backupUrl,
      VITE_E2EE: "0",
      VITE_RELAY_SELECTION: "priority",
    },
  );
  await Promise.all(
    [
      signalUrl + "/health",
      primaryUrl + "/health",
      backupUrl + "/health",
      webUrl,
    ].map((url) => until(async () => (await fetch(url)).ok, url)),
  );
  dashboard = await createDemoDashboard(() => ({
    mode: "localhost-browser-validation",
    passed: true,
    publicReachable: false,
    urls: { signal: signalUrl, relay: primaryUrl, web: webUrl },
    directory: evidence,
    processes: processRows
      .filter((row) =>
        ["signal", "primary", "backup", "web"].includes(row.name),
      )
      .map((row) => ({
        name: row.name,
        pid: row.child.pid,
        running: row.child.exitCode === null,
      })),
    logs: ["signal", "primary", "backup"].map((name) => ({
      name,
      text: logs[name],
    })),
  }));
  const executable =
    process.env.CHROME_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(existsSync);
  if (!executable)
    throw new Error("Set CHROME_PATH to your installed Chromium browser");
  const profile = join(qa, "chrome");

  chrome = launch("chrome", executable, [
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
  const [port, suffix] = (
    await until(
      () => readFile(join(profile, "DevToolsActivePort"), "utf8"),
      "Chrome startup",
    )
  )
    .trim()
    .split(/\r?\n/);
  ws = new WebSocket(`ws://127.0.0.1:${port}${suffix}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  ws.onclose = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Browser closed"));
    }
    pending.clear();
  };
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    if (data.method === "Runtime.exceptionThrown")
      (report.browserErrors ||= []).push(data.params.exceptionDetails);
    const item = pending.get(data.id);
    if (item) {
      clearTimeout(item.timer);
      pending.delete(data.id);
      data.error
        ? item.reject(new Error(JSON.stringify(data.error)))
        : item.resolve(data.result);
    }
  };
  browserCall = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 12000);
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
    const result = await browserCall(
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
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const reload = async (session) => {
    await evaluate(session, "window.qaReloadPending=true");
    await browserCall("Page.reload", {}, session);
    await until(
      () =>
        evaluate(
          session,
          '!window.qaReloadPending && document.readyState === "complete"',
        ),
      "fresh document after reload",
    );
  };
  const fill = async (session, selector, value) => {
    await evaluate(
      session,
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing field');Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await pause(80);
  };
  const click = async (session, selector) => {
    await until(
      () =>
        evaluate(
          session,
          `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      `enabled control: ${selector}`,
    );
    return evaluate(
      session,
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  };
  const choose = async (session, text) =>
    evaluate(
      session,
      `(()=>{const item=[...document.querySelectorAll('nav .conversation')].find(item=>item.querySelector('strong')?.textContent===${JSON.stringify(text)});if(!item)throw Error('Conversation missing');item.click();})()`,
    );
  const send = async (session, text) => {
    await fill(session, "textarea", text);
    await click(session, ".send-button");
  };
  const history = (session, id) =>
    evaluate(
      session,
      `JSON.parse(localStorage.getItem('ds01-history-v1-${id}')||'[]')`,
    );
  const screenshot = async (session, name) => {
    await pause(180);
    const { data } = await browserCall(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      session,
    );
    await writeFile(join(evidence, name), Buffer.from(data, "base64"));
  };
  const peerLog = async (session) => {
    await click(session, ".diagnostics-link");
    const value = await evaluate(
      session,
      'document.querySelector(".log-console").textContent',
    );
    await click(session, ".diagnostics .icon-button");
    return value;
  };
  const pages = [];
  for (const [index, id] of ["user_qa-a", "user_qa-b", "user_qa-c"].entries()) {
    const { browserContextId } = await browserCall(
      "Target.createBrowserContext",
    );
    const { targetId } = await browserCall("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const { sessionId } = await browserCall("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    pages.push(sessionId);
    await browserCall("Runtime.enable", {}, sessionId);
    await browserCall("Page.enable", {}, sessionId);
    await browserCall(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: rtcProbe },
      sessionId,
    );
    await browserCall(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await browserCall("Page.navigate", { url: webUrl }, sessionId);
    await until(
      () =>
        evaluate(
          sessionId,
          '!!document.querySelector("input[autocomplete=username]")',
        ),
      "login page",
    );
    if (index === 0) {
      await evaluate(
        sessionId,
        `localStorage.setItem('ds01-display-name','Previous user');localStorage.setItem('ds01-peer-id','peer-stale');`,
      );
      await reload(sessionId);
      await until(
        () =>
          evaluate(
            sessionId,
            '!!document.querySelector("input[autocomplete=username]")',
          ),
        "login with cached identity",
      );
      check(
        "logged-out page hides cached profile name, Peer ID and avatar",
        await evaluate(
          sessionId,
          '!document.querySelector(".self-profile .avatar") && !document.querySelector(".self-profile small") && !document.querySelector(".self-profile")?.textContent.includes("Previous user")',
        ),
      );
      await screenshot(sessionId, "ui-welcome.png");
      await browserCall(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        sessionId,
      );
      await screenshot(sessionId, "ui-welcome-mobile.png");
      check(
        "mobile login form remains visible without horizontal overflow",
        await evaluate(
          sessionId,
          'document.documentElement.scrollWidth <= innerWidth && document.querySelector(".connect-card").getBoundingClientRect().width <= innerWidth',
        ),
      );
      await browserCall(
        "Emulation.setDeviceMetricsOverride",
        { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
    }
    await click(sessionId, ".auth-tabs button:nth-child(2)");
    await fill(
      sessionId,
      "input[autocomplete=nickname]",
      `Peer ${String.fromCharCode(65 + index)}`,
    );
    await fill(sessionId, "input[name=username]", id.replace(/^user_/, ""));
    await fill(
      sessionId,
      "input[name=password]",
      "Browser acceptance passphrase!",
    );
    await fill(
      sessionId,
      "input[name=confirmation]",
      "Browser acceptance passphrase!",
    );
    if (index === 0) {
      await screenshot(sessionId, "ui-register.png");
      await browserCall(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        sessionId,
      );
      await evaluate(
        sessionId,
        'document.querySelector(".welcome").scrollTop = document.querySelector(".welcome").scrollHeight',
      );
      await screenshot(sessionId, "ui-register-mobile.png");
      check(
        "mobile registration scrolls to a reachable submit button",
        await evaluate(
          sessionId,
          '(()=>{const area=document.querySelector(".welcome").getBoundingClientRect(),button=document.querySelector(".connect-card button[type=submit]").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&button.top>=area.top&&button.bottom<=area.bottom})()',
        ),
      );
      await browserCall(
        "Emulation.setDeviceMetricsOverride",
        { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      await evaluate(
        sessionId,
        'document.querySelector(".welcome").scrollTop = 0',
      );
    }
    await click(sessionId, ".connect-card button[type=submit]");
    await until(
      () => evaluate(sessionId, '!!document.querySelector(".auth-success")'),
      "account registration",
    );
    if (index === 0) {
      await fill(sessionId, "input[name=password]", "An incorrect passphrase!");
      await click(sessionId, ".connect-card button[type=submit]");
      await until(
        () =>
          evaluate(
            sessionId,
            'document.querySelector("[role=alert]")?.textContent.includes("không đúng")',
          ),
        "wrong password rejection",
      );
      check(
        "wrong account password cannot enter the chat workspace",
        await evaluate(
          sessionId,
          '!document.querySelector(".empty-chat") && !document.querySelector(".chat-layout")',
        ),
      );
    }
    await fill(
      sessionId,
      "input[name=password]",
      "Browser acceptance passphrase!",
    );
    await click(sessionId, ".connect-card button[type=submit]");
    await until(
      () =>
        evaluate(
          sessionId,
          'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
        ),
      "peer registration",
    );
  }
  const [a, b, c] = pages;
  await until(
    () =>
      evaluate(a, 'document.querySelectorAll("nav .conversation").length===2'),
    "three peers discovery",
  );
  check(
    "three accounts register, log in, automatically join the peer network and discover display names",
    true,
  );
  scenario(
    2,
    "passed_local",
    "Three independent browser contexts with authenticated Peer IDs user_qa-a, user_qa-b, user_qa-c.",
  );
  scenario(
    3,
    "passed_local",
    "Registration, presence and display-name discovery visible on browser interfaces.",
  );
  const operatorTarget = await browserCall("Target.createTarget", {
    url: dashboard.url,
  });
  const { sessionId: operator } = await browserCall("Target.attachToTarget", {
    targetId: operatorTarget.targetId,
    flatten: true,
  });
  await browserCall("Runtime.enable", {}, operator);
  await until(
    () =>
      evaluate(
        operator,
        'document.querySelectorAll("#processes tr").length===4',
      ),
    "operator dashboard process list",
  );
  await fill(operator, "#filter", "user_qa-a");
  await until(
    () =>
      evaluate(
        operator,
        'document.querySelector("#logs").textContent.includes("REGISTER user_qa-a")',
      ),
    "server log filtering in browser",
  );
  check(
    "operator dashboard displays independent service PIDs, URLs and filtered server logs in the browser",
    await evaluate(
      operator,
      'new Set([...document.querySelectorAll("#processes tr")].map(row=>row.children[1].textContent)).size===4 && document.querySelectorAll("#links a").length===5 && !document.querySelector("#logs").textContent.includes("REGISTER user_qa-b")',
    ),
  );
  await screenshot(operator, "ui-demo-dashboard.png");
  check(
    "authenticated profile and browser task title display the current account identity",
    await evaluate(
      a,
      'document.querySelector(".self-profile strong")?.textContent === "Peer A" && document.querySelector(".self-profile small")?.textContent === "user_qa-a" && document.title.includes("user_qa-a")',
    ),
  );
  await screenshot(a, "ui-empty-desktop.png");
  await click(a, 'button[aria-label="Mở hội thoại mới"]');
  await screenshot(a, "ui-new-conversation.png");
  await evaluate(
    a,
    'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
  );
  await until(
    () => evaluate(a, '!document.querySelector(".modal")'),
    "close conversation dialog with Escape",
  );

  await choose(a, "Peer B");
  await choose(b, "Peer A");
  await evaluate(a, "window.qaDelayOfferMs=700");
  await send(a, "QA-PENDING-DIRECT");
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-PENDING-DIRECT" && row.status === "pending",
      ),
    "pending direct selection",
  );
  check(
    "a pending message does not falsely claim a RELAY path before connection selection",
    await evaluate(
      a,
      '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-PENDING-DIRECT")?.querySelector(".route-tag")?.textContent === "Đang chọn đường"',
    ),
  );
  const pendingDirect = await until(
    async () =>
      (await history(a, "user_qa-a")).find(
        (row) =>
          row.message.body === "QA-PENDING-DIRECT" &&
          row.status === "delivered",
      ),
    "pending direct delivered",
    20000,
  );
  check(
    "pending delivery progresses to confirmed DIRECT without relay forwarding",
    pendingDirect.message.mode === "DIRECT" &&
      !logs.primary.includes(pendingDirect.message.messageId) &&
      !logs.backup.includes(pendingDirect.message.messageId),
  );
  await evaluate(a, "window.qaDelayOfferMs=0");

  await evaluate(
    b,
    `window.qaHeldAcks=[];window.qaOriginalChannelSend=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(data){const packet=JSON.parse(data);if(packet.type==='ack'){window.qaHeldAcks.push({channel:this,data});return;}return window.qaOriginalChannelSend.call(this,data);};`,
  );
  await send(a, "QA-A-WAITING-ACK");
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-A-WAITING-ACK" && row.status === "sent",
      ),
    "waiting for receiver ACK",
  );
  await until(
    () =>
      evaluate(
        a,
        '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-A-WAITING-ACK")?.querySelector(".message-meta")?.textContent.includes("Đã gửi · chờ xác nhận")',
      ),
    "unconfirmed sent status",
  );
  check(
    "the interface distinguishes sent from receiver-confirmed delivery",
    true,
  );
  await send(b, "QA-B-WHILE-A-SENDS");
  await until(
    async () =>
      (await history(b, "user_qa-b")).some(
        (row) =>
          row.message.body === "QA-B-WHILE-A-SENDS" &&
          row.status === "delivered",
      ),
    "opposite direction delivery while ACK is held",
  );
  check(
    "a peer receives and confirms an incoming message while its outgoing message awaits ACK",
    (await history(a, "user_qa-a")).some(
      (row) =>
        row.message.body === "QA-B-WHILE-A-SENDS" && row.status === "received",
    ) &&
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-A-WAITING-ACK" && row.status === "sent",
      ),
  );
  check(
    "the composer remains editable while awaiting delivery confirmation",
    await evaluate(a, '!document.querySelector("textarea").disabled'),
  );
  await choose(a, "Peer C");
  await fill(a, "textarea", "QA-DRAFT-FOR-C");
  await evaluate(
    b,
    "RTCDataChannel.prototype.send=window.qaOriginalChannelSend;for(const item of window.qaHeldAcks)window.qaOriginalChannelSend.call(item.channel,item.data);window.qaHeldAcks=[];",
  );
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-A-WAITING-ACK" && row.status === "delivered",
      ),
    "released ACK confirmation",
  );
  await until(
    () => evaluate(a, '!document.querySelector(".send-button").disabled'),
    "composer ready after confirmation",
  );
  check(
    "delivery completion preserves the draft for a different selected peer",
    await evaluate(
      a,
      'document.querySelector("textarea").value === "QA-DRAFT-FOR-C" && document.querySelector(".chat-title h2").textContent === "Peer C"',
    ),
  );
  await fill(a, "textarea", "");

  const directRows = [];
  for (const routes of [
    [
      [c, "user_qa-c", b, "user_qa-b", "Peer B"],
      [b, "user_qa-b", a, "user_qa-a", "Peer A"],
      [a, "user_qa-a", c, "user_qa-c", "Peer C"],
    ],
    [
      [b, "user_qa-b", c, "user_qa-c", "Peer C"],
      [a, "user_qa-a", b, "user_qa-b", "Peer B"],
      [c, "user_qa-c", a, "user_qa-a", "Peer A"],
    ],
  ]) {
    await Promise.all(
      routes.map(async ([session, sender, receiver, destination, name]) => {
        const body = `QA-BIDIRECTIONAL-${sender}-${destination}`;
        await choose(session, name);
        await send(session, body);
        const row = await until(
          async () =>
            (await history(session, sender)).find(
              (item) =>
                item.message.body === body && item.status === "delivered",
            ),
          body,
          20000,
        );
        const received = (await history(receiver, destination)).filter(
          (item) =>
            item.message.messageId === row.message.messageId &&
            item.message.senderId === sender,
        );
        directRows.push({
          sender,
          destination,
          messageId: row.message.messageId,
          mode: row.message.mode,
          received: received.length,
        });
      }),
    );
  }
  check(
    "A, B and C each initiate and accept real DIRECT exchanges in all six directions without relay forwarding",
    directRows.length === 6 &&
      directRows.every(
        (row) =>
          row.mode === "DIRECT" &&
          row.received === 1 &&
          !logs.primary.includes(row.messageId) &&
          !logs.backup.includes(row.messageId),
      ),
    directRows,
  );
  const envelopes = (
    await Promise.all(
      pages.map((session) => evaluate(session, "window.qaWirePackets")),
    )
  ).flat();
  const dataEnvelopes = envelopes.filter((packet) => packet.type !== "ack"),
    ackEnvelopes = envelopes.filter((packet) => packet.type === "ack");
  const byId = new Map(
    dataEnvelopes.map((packet) => [packet.messageId, packet]),
  );
  const requiredEnvelopeFields = [
    "messageId",
    "senderId",
    "receiverId",
    "sessionId",
    "type",
    "timestamp",
    "body",
    "mode",
    "ackRequested",
  ];
  check(
    "real JSON DataChannel envelopes carry all required fields and correlated application ACK information",
    dataEnvelopes.length >= 6 &&
      ackEnvelopes.length >= 6 &&
      envelopes.every((packet) =>
        requiredEnvelopeFields.every((field) => Object.hasOwn(packet, field)),
      ) &&
      dataEnvelopes.every((packet) => packet.ackRequested === true) &&
      ackEnvelopes.every((ack) => {
        const original = byId.get(ack.ackFor);
        return (
          original &&
          ack.ackRequested === false &&
          ack.messageId !== original.messageId &&
          ack.sessionId === original.sessionId &&
          ack.senderId === original.receiverId &&
          ack.receiverId === original.senderId &&
          ack.sequence === original.sequence &&
          ack.logicalTime > original.logicalTime
        );
      }),
    {
      dataEnvelopes: dataEnvelopes.length,
      ackEnvelopes: ackEnvelopes.length,
      requiredFields: requiredEnvelopeFields,
    },
  );

  await choose(a, "Peer B");
  await choose(b, "Peer A");
  const directBefore = await Promise.all(
    [primaryUrl, backupUrl].map(
      async (url) => await (await fetch(url + "/health")).json(),
    ),
  );
  await send(a, "QA-DIRECT-REAL");
  const direct = await until(
    async () => {
      const rows = await history(a, "user_qa-a");
      return rows.find(
        (row) =>
          row.message.body === "QA-DIRECT-REAL" && row.status === "delivered",
      );
    },
    "real DIRECT delivery",
    20000,
  );
  check(
    "real WebRTC DIRECT delivered with no relay FORWARD",
    direct.message.mode === "DIRECT" &&
      !logs.primary.includes(direct.message.messageId) &&
      !logs.backup.includes(direct.message.messageId),
    { messageId: direct.message.messageId },
  );
  await until(
    async () =>
      (
        await Promise.all(
          [a, b].map((session) =>
            evaluate(
              session,
              'document.querySelector(".mode-label")?.textContent',
            ),
          ),
        )
      ).every((mode) => mode === "DIRECT"),
    "DIRECT path at both peers",
  );
  check("both peer interfaces identify the DIRECT message path", true);
  const directAfter = await Promise.all(
    [primaryUrl, backupUrl].map(
      async (url) => await (await fetch(url + "/health")).json(),
    ),
  );
  const directPeerLogs = await Promise.all([a, b].map(peerLog));
  const directPacket = await evaluate(
    a,
    `window.qaWirePackets.find(packet=>packet.messageId===${JSON.stringify(direct.message.messageId)})`,
  );
  const directAck = await evaluate(
    b,
    `window.qaWirePackets.find(packet=>packet.type==='ack'&&packet.ackFor===${JSON.stringify(direct.message.messageId)})`,
  );
  pathProof.direct = {
    messageId: direct.message.messageId,
    measuredAt: new Date().toISOString(),
    sourceLog: directPeerLogs[0],
    destinationLog: directPeerLogs[1],
    dataChannelPacket: directPacket,
    applicationAck: directAck,
    relaysBefore: directBefore,
    relaysAfter: directAfter,
    relayMatchingLines: [logs.primary, logs.backup].flatMap((value) =>
      value
        .split("\n")
        .filter((line) => line.includes(direct.message.messageId)),
    ),
  };
  check(
    "saved DIRECT proof correlates DataChannel data and ACK, both peer logs and unchanged live relay counters",
    directPeerLogs[0].includes(`DIRECT SEND ${direct.message.messageId}`) &&
      directPeerLogs[1].includes(
        `DIRECT RECEIVE ${direct.message.messageId}`,
      ) &&
      directPacket?.mode === "DIRECT" &&
      directAck?.mode === "DIRECT" &&
      pathProof.direct.relayMatchingLines.length === 0 &&
      directAfter.every(
        (value, index) =>
          value.metrics.forwardedMessages ===
          directBefore[index].metrics.forwardedMessages,
      ),
  );
  scenario(
    4,
    "passed_local",
    `Real WebRTC DataChannel chat, Message ID ${direct.message.messageId}.`,
  );
  scenario(
    5,
    "passed_local",
    "path-proof.json contains matching sender/receiver logs, DataChannel packet/ACK, live relay health counters and no matching relay forwarding.",
  );
  await evaluate(a, `
    window.qaRecoveryPC=window.qaRTC.find(pc=>pc.connectionState==='connected');
    window.qaRecoverySdp=window.qaRecoveryPC.localDescription.sdp;
    Object.defineProperty(window.qaRecoveryPC,'connectionState',{configurable:true,get:()=> 'disconnected'});
    window.qaRecoveryPC.dispatchEvent(new Event('connectionstatechange'));
  `);
  await until(
    () => evaluate(a, 'document.querySelector(".mode-label")?.textContent==="RELAY"'),
    "relay while recovering a disconnection notification",
  );
  try {
    await until(async () => (await peerLog(a)).includes("DIRECT_ICE_RESTART"), "native ICE restart");
  } catch (error) {
    report.recoveryDebug = {
      peerLog: await peerLog(a),
      state: await evaluate(a, `({
        pc:window.qaRecoveryPC.connectionState,
        ice:window.qaRecoveryPC.iceConnectionState,
        signaling:window.qaRecoveryPC.signalingState,
        states:window.qaRTC.map(pc=>({pc:pc.connectionState,ice:pc.iceConnectionState,signaling:pc.signalingState})),
      })`),
    };
    throw error;
  }
  await evaluate(a, `
    delete window.qaRecoveryPC.connectionState;
    window.qaRecoveryPC.dispatchEvent(new Event('connectionstatechange'));
  `);
  await until(
    () => evaluate(a, 'document.querySelector(".mode-label")?.textContent==="DIRECT" && window.qaRecoveryPC.connectionState==="connected" && window.qaRecoveryPC.localDescription.sdp!==window.qaRecoverySdp'),
    "same peer connection recovers through native ICE restart",
    20000,
  );
  await send(a, "QA-ICE-RECOVERY");
  const recovered = await until(async () => (await history(a, "user_qa-a")).find(
    row => row.message.body === "QA-ICE-RECOVERY" && row.status === "delivered"
  ), "direct delivery after native ICE restart");
  check(
    "native ICE restart after a simulated loss notification keeps the same real peer connection and restores DIRECT delivery",
    recovered.message.mode === "DIRECT" &&
      !logs.primary.includes(recovered.message.messageId) &&
      !logs.backup.includes(recovered.message.messageId),
  );
  await click(a, ".diagnostics-link");
  const openBeforeBreak = await evaluate(
    a,
    'window.qaRTC.filter(pc=>pc.connectionState!=="closed").length',
  );
  await click(a, 'button[aria-label="Ngắt kênh trực tiếp"]');
  check(
    "diagnostics closes the selected real peer connection while force-relay remains disabled and signaling stays online",
    await evaluate(
      a,
      `window.qaRTC.filter(pc=>pc.connectionState!=="closed").length===${openBeforeBreak - 1}&&!document.querySelector('.toggle-setting input').checked&&document.querySelector('.connection-pill').textContent.includes('Đang trực tuyến')`,
    ),
  );
  await click(a, ".diagnostics .icon-button");
  await send(a, "QA-AUTO-FALLBACK");
  const fallback = await until(async () => {
    const rows = await history(a, "user_qa-a");
    return rows.find(
      (row) =>
        row.message.body === "QA-AUTO-FALLBACK" && row.status === "delivered",
    );
  }, "fallback after closing established DIRECT");
  check(
    "established DIRECT closes and automatically falls back without forced checkbox",
    fallback.message.mode === "RELAY" &&
      (logs.primary.includes(fallback.message.messageId) ||
        logs.backup.includes(fallback.message.messageId)),
  );
  check(
    "relay status clears the old DIRECT success explanation",
    await evaluate(
      a,
      '!!document.querySelector(".route-explanation") && !document.querySelector(".route-explanation").textContent.includes("Đã thiết lập đường DIRECT")',
    ),
  );
  await until(
    async () =>
      (
        await Promise.all(
          [a, b].map((session) =>
            evaluate(
              session,
              'document.querySelector(".mode-label")?.textContent',
            ),
          ),
        )
      ).every((mode) => mode === "RELAY"),
    "RELAY path at both peers",
  );
  check(
    "both peer interfaces identify the RELAY path after automatic fallback",
    true,
  );
  const pathLogs = [];
  for (const [session, direction] of [
    [a, "SEND"],
    [b, "RECEIVE"],
  ]) {
    await click(session, ".diagnostics-link");
    pathLogs.push(
      await evaluate(
        session,
        `document.querySelector('.log-console').textContent.includes(${JSON.stringify(`RELAY ${direction} ${fallback.message.messageId}`)})`,
      ),
    );
    await click(session, 'button[aria-label="Đóng chẩn đoán"]');
  }
  check(
    "sender and receiver logs identify the same relayed message and actual data path",
    pathLogs.every(Boolean),
  );
  pathProof.relay = {
    messageId: fallback.message.messageId,
    measuredAt: new Date().toISOString(),
    sourceLog: await peerLog(a),
    destinationLog: await peerLog(b),
    relayMatchingLines: [logs.primary, logs.backup].flatMap((value) =>
      value
        .split("\n")
        .filter(
          (line) =>
            line.includes(fallback.message.messageId) &&
            line.includes("FORWARD"),
        ),
    ),
  };
  check(
    "saved RELAY proof includes correlated peer logs and a real relay FORWARD for the same Message ID",
    pathProof.relay.sourceLog.includes(
      `RELAY SEND ${fallback.message.messageId}`,
    ) &&
      pathProof.relay.destinationLog.includes(
        `RELAY RECEIVE ${fallback.message.messageId}`,
      ) &&
      pathProof.relay.relayMatchingLines.length > 0,
  );
  scenario(
    7,
    "passed_local",
    "Correlated peer SEND/RECEIVE and relay FORWARD retained in path-proof.json; real different-network proof remains pending in scenario 6.",
  );
  scenario(
    11,
    "passed_local",
    "Diagnostics action closed the selected real PeerConnection/DataChannel; subsequent chat automatically used RELAY with force-relay disabled and signaling still online.",
  );
  const fileBytes = Buffer.from(
      Array.from({ length: 32768 }, (_, index) => index % 251),
    ),
    filePath = join(qa, "browser-transfer.bin");
  await writeFile(filePath, fileBytes);
  const document = await browserCall("DOM.getDocument", {}, a),
    field = await browserCall(
      "DOM.querySelector",
      { nodeId: document.root.nodeId, selector: "input[type=file]" },
      a,
    );
  await browserCall(
    "DOM.setFileInputFiles",
    { files: [filePath], nodeId: field.nodeId },
    a,
  );
  const fileRow = await until(
    async () => {
      const rows = await history(a, "user_qa-a");
      return rows.find(
        (row) =>
          row.message.type === "attachment" && row.status === "delivered",
      );
    },
    "browser file transfer",
    20000,
  );
  const fileId = fileRow.message.attachments[0].id;
  const saved = await evaluate(
    b,
    `(async()=>{const {WebStore}=await import('/store.ts');const value=await new WebStore('user_qa-b').getFile(${JSON.stringify(fileId)});const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(value.data).buffer);return {length:value.data.length,hash:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')};})()`,
  );
  check(
    "browser file bytes persist in IndexedDB with matching SHA-256",
    saved.length === fileBytes.length &&
      saved.hash === createHash("sha256").update(fileBytes).digest("hex"),
  );
  await click(c, 'button[aria-label="Đăng xuất"]');
  await until(
    () => evaluate(c, '!!document.querySelector("input[name=password]")'),
    "third peer logout",
  );
  await until(
    () =>
      evaluate(
        a,
        '[...document.querySelectorAll("nav .conversation")].some(item=>item.querySelector("strong")?.textContent==="Peer C"&&!item.querySelector(".avatar .online"))',
      ),
    "third peer offline",
  );
  await choose(a, "Peer C");
  await send(a, "QA-OFFLINE-RETRY");
  const offlineMessage = await until(
    async () =>
      (await history(a, "user_qa-a")).find(
        (row) =>
          row.message.body === "QA-OFFLINE-RETRY" && row.status === "failed",
      ),
    "unconfirmed offline message",
  );
  await until(
    () =>
      evaluate(
        a,
        '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-OFFLINE-RETRY")?.querySelector(".message-meta")?.textContent.includes("Chưa xác nhận")',
      ),
    "honest unconfirmed status",
  );
  check(
    "a failed send is displayed as unconfirmed and remains in local history with a retry action",
    await evaluate(
      a,
      '!![...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-OFFLINE-RETRY")?.querySelector(".retry-link")',
    ),
  );
  await fill(c, "input[name=username]", "qa-c");
  await fill(c, "input[name=password]", "Browser acceptance passphrase!");
  await click(c, ".connect-card button[type=submit]");
  await until(
    () =>
      evaluate(
        c,
        'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
      ),
    "third peer returns",
  );
  await evaluate(
    a,
    '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-OFFLINE-RETRY").querySelector(".retry-link").click()',
  );
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.messageId === offlineMessage.message.messageId &&
          row.status === "delivered",
      ),
    "retry after receiver returns",
  );
  check(
    "retry delivers the original Message ID exactly once after the receiver rejoins",
    (await history(a, "user_qa-a")).filter(
      (row) => row.message.messageId === offlineMessage.message.messageId,
    ).length === 1 &&
      (await history(c, "user_qa-c")).filter(
        (row) => row.message.messageId === offlineMessage.message.messageId,
      ).length === 1,
  );
  await click(a, 'button[aria-label="Tạo nhóm"]');
  await fill(a, '.modal input[maxlength="80"]', "Team QA");
  await fill(a, ".modal form label:last-of-type input", "user_qa-b,user_qa-c");
  await click(a, ".modal .primary-button");
  await until(
    () =>
      evaluate(
        b,
        '[...document.querySelectorAll("nav strong")].some(item=>item.textContent==="Team QA")',
      ),
    "group membership",
  );
  await choose(b, "Team QA");
  await choose(c, "Team QA");
  await send(a, "QA-GROUP-A");
  await Promise.all([send(b, "QA-CONCURRENT-B"), send(c, "QA-CONCURRENT-C")]);
  await until(async () => {
    const rows = await history(a, "user_qa-a");
    return (
      rows.filter((row) => row.message.body.startsWith("QA-CONCURRENT-"))
        .length === 2
    );
  }, "concurrent group sends");
  await Promise.all(
    pages.map((session, index) =>
      until(async () => {
        const self = `user_qa-${String.fromCharCode(97 + index)}`,
          rows = await history(session, self);
        return ["QA-GROUP-A", "QA-CONCURRENT-B", "QA-CONCURRENT-C"].every(
          (body, sender) => {
            const copies = rows.filter((row) => row.message.body === body);
            return (
              copies.length === (sender === index ? 2 : 1) &&
              copies.every(
                (row) =>
                  row.status === (sender === index ? "delivered" : "received"),
              )
            );
          },
        );
      }, "complete concurrent group histories"),
    ),
  );
  check("group fan-out and simultaneous sends arrive once per receiver", true);
  scenario(
    8,
    "passed_local",
    "A, B, C joined Team QA and each sent group messages with confirmed per-recipient delivery.",
  );
  const simultaneous = await Promise.all(
    [
      [b, "user_qa-b", "QA-CONCURRENT-B"],
      [c, "user_qa-c", "QA-CONCURRENT-C"],
    ].map(async ([session, self, body]) => {
      const row = (await history(session, self)).find(
        (row) => row.message.senderId === self && row.message.body === body,
      );
      return {
        senderId: self,
        messageId: row.message.messageId,
        timestamp: row.message.timestamp,
      };
    }),
  );
  const sendGapMs = Math.abs(
    simultaneous[0].timestamp - simultaneous[1].timestamp,
  );
  check(
    "concurrent group send evidence includes sender timestamps less than one second apart and converged histories",
    sendGapMs < 1000,
    { sendGapMs, simultaneous },
  );
  scenario(9, "passed_local", {
    method:
      "Promise.all across independent peer contexts; all three histories checked",
    sendGapMs,
    simultaneous,
  });
  const beforeCrash = (await history(c, "user_qa-c")).map(
      (row) => row.message.messageId,
    ),
    crashLogStart = logs.signal.length,
    crashStart = Date.now();
  await Promise.race([
    browserCall("Page.crash", {}, c).catch(() => {}),
    pause(500),
  ]);
  await Promise.all(
    [a, b].map((session) =>
      until(
        () =>
          evaluate(
            session,
            '[...document.querySelectorAll("nav .conversation")].some(item=>item.querySelector("strong")?.textContent==="Peer C"&&!item.querySelector(".avatar .online"))',
          ),
        "abrupt renderer crash updates peer status",
        45000,
      ),
    ),
  );
  const crashEvidence = {
    model:
      "Actual Chrome renderer crash via CDP Page.crash; no logout, PeerClient.close or graceful Socket.IO disconnect invoked",
    peerId: "user_qa-c",
    offlineDetectedMs: Date.now() - crashStart,
    stoppedAt: new Date(crashStart).toISOString(),
    signalingLog: logs.signal.slice(crashLogStart),
  };
  check(
    "abrupt peer renderer crash updates the offline status on both surviving peers",
    crashEvidence.signalingLog.includes("DISCONNECT user_qa-c") ||
      crashEvidence.signalingLog.includes("TIMEOUT user_qa-c"),
    crashEvidence,
  );
  scenario(10, "passed_local", crashEvidence);
  await browserCall("Page.reload", {}, c);
  await until(
    () =>
      evaluate(
        c,
        'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
      ),
    "crashed peer automatically restores account session",
    20000,
  );
  await until(
    () =>
      evaluate(
        c,
        '[...document.querySelectorAll("nav strong")].some(item=>item.textContent==="Team QA")',
      ),
    "crashed peer restores group membership",
  );
  await until(
    () =>
      evaluate(
        a,
        '[...document.querySelectorAll("nav .conversation")].some(item=>item.querySelector("strong")?.textContent==="Peer C"&&item.querySelector(".avatar .online"))',
      ),
    "restarted peer online again",
  );
  const restoredIds = new Set(
    (await history(c, "user_qa-c")).map((row) => row.message.messageId),
  );
  check(
    "restarting the crashed peer restores its original Peer ID, chat history and group membership",
    beforeCrash.every((id) => restoredIds.has(id)) &&
      (await evaluate(
        c,
        'document.querySelector(".self-profile small")?.textContent==="user_qa-c"',
      )),
  );
  scenario(
    12,
    "passed_local",
    "After renderer crash/reload, original authenticated Peer ID, complete retained history and group membership restored; other peers observe online presence.",
  );
  await choose(c, "Team QA");
  for (const session of pages) {
    if (!(await evaluate(session, '!!document.querySelector(".inspector")')))
      await click(session, 'button[aria-label="Thông tin hội thoại"]');
  }
  const memberNames = (session) =>
    evaluate(
      session,
      '[...document.querySelectorAll(".inspector .member strong")].map(item=>item.textContent).sort()',
    );
  await click(a, 'button[aria-label="Xóa user_qa-c khỏi nhóm"]');
  await until(
    async () =>
      JSON.stringify(await memberNames(a)) === '["Peer A","Peer B"]' &&
      JSON.stringify(await memberNames(b)) === '["Peer A","Peer B"]' &&
      (await evaluate(c, 'document.querySelector("textarea").disabled')),
    "consistent removal on all three interfaces",
  );
  await send(a, "QA-WHILE-C-REMOVED");
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-WHILE-C-REMOVED" &&
          row.status === "delivered",
      ),
    "group message after removal",
  );
  await fill(a, 'input[aria-label="Peer ID thành viên mới"]', "user_qa-c");
  await click(a, 'button[aria-label="Thêm thành viên"]');
  await until(
    async () =>
      (await Promise.all(pages.map(memberNames))).every(
        (names) => JSON.stringify(names) === '["Peer A","Peer B","Peer C"]',
      ) && (await evaluate(c, '!document.querySelector("textarea").disabled')),
    "consistent rejoin on all three interfaces",
  );
  check(
    "owner removal and addition update all membership views and permissions without replaying old group messages",
    !(await history(c, "user_qa-c")).some(
      (row) => row.message.body === "QA-WHILE-C-REMOVED",
    ) && (await evaluate(b, '!document.querySelector(".add-member")')),
  );

  const loginAgain = async (session, username) => {
    await fill(session, "input[name=username]", username);
    await fill(
      session,
      "input[name=password]",
      "Browser acceptance passphrase!",
    );
    await click(session, ".connect-card button[type=submit]");
    await until(
      () =>
        evaluate(
          session,
          'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
        ),
      "group member returns",
    );
    await until(
      () =>
        evaluate(
          session,
          '[...document.querySelectorAll("nav strong")].some(item=>item.textContent==="Team QA")',
        ),
      "restored group snapshot",
    );
    await choose(session, "Team QA");
  };
  await click(c, 'button[aria-label="Đăng xuất"]');
  await until(
    () => evaluate(c, '!!document.querySelector("input[name=password]")'),
    "offline group member",
  );
  await send(a, "QA-GROUP-PARTIAL-OFFLINE");
  const partial = await until(async () => {
    const rows = (await history(a, "user_qa-a")).filter(
      (row) => row.message.body === "QA-GROUP-PARTIAL-OFFLINE",
    );
    return (
      rows.length === 2 &&
      rows.some(
        (row) =>
          row.message.receiverId === "user_qa-b" && row.status === "delivered",
      ) &&
      rows.some(
        (row) =>
          row.message.receiverId === "user_qa-c" && row.status === "failed",
      ) &&
      rows
    );
  }, "partial group delivery");
  await loginAgain(c, "qa-c");
  await evaluate(
    a,
    '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-GROUP-PARTIAL-OFFLINE").querySelector(".retry-link").click()',
  );
  await until(
    async () =>
      (await history(a, "user_qa-a")).filter(
        (row) =>
          row.message.messageId === partial[0].message.messageId &&
          row.status === "delivered",
      ).length === 2,
    "retry only offline group recipient",
  );
  check(
    "offline group member retains membership; manual retry confirms the same event without resending to successful recipients",
    (await history(b, "user_qa-b")).filter(
      (row) => row.message.messageId === partial[0].message.messageId,
    ).length === 1 &&
      (await history(c, "user_qa-c")).filter(
        (row) => row.message.messageId === partial[0].message.messageId,
      ).length === 1,
  );

  await Promise.all(
    [b, c].map((session) => click(session, 'button[aria-label="Đăng xuất"]')),
  );
  await Promise.all(
    [b, c].map((session) =>
      until(
        () =>
          evaluate(session, '!!document.querySelector("input[name=password]")'),
        "both recipients offline",
      ),
    ),
  );
  await send(a, "QA-GROUP-BULK-RETRY");
  await until(
    async () =>
      (await history(a, "user_qa-a")).filter(
        (row) =>
          row.message.body === "QA-GROUP-BULK-RETRY" && row.status === "failed",
      ).length === 2,
    "two unconfirmed recipients",
  );
  await Promise.all([loginAgain(b, "qa-b"), loginAgain(c, "qa-c")]);
  await evaluate(
    c,
    `(async()=>{const {WebStore}=await import('/store.ts');const original=WebStore.prototype.put;const gate=new Promise(resolve=>window.qaReleaseGroup=resolve);WebStore.prototype.put=async function(row){if(row.status==='received'&&row.message.body==='QA-GROUP-BULK-RETRY'){window.qaGroupHeld=true;await gate;}return original.call(this,row);};window.qaRestoreGroupStore=()=>{WebStore.prototype.put=original;};})()`,
  );
  await fill(a, "textarea", "QA-DRAFT-DURING-BULK-RETRY");
  await evaluate(
    a,
    '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-GROUP-BULK-RETRY").querySelector(".retry-link").click()',
  );
  await until(
    async () =>
      (await evaluate(c, "!!window.qaGroupHeld")) &&
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-GROUP-BULK-RETRY" &&
          row.message.receiverId === "user_qa-b" &&
          row.status === "delivered",
      ),
    "first retry finishes while second is held",
  );
  await pause(150);
  const busyUntilLastRecipient = await evaluate(
    a,
    'document.querySelector(".send-button").disabled && document.querySelector("textarea").value==="QA-DRAFT-DURING-BULK-RETRY"',
  );
  check(
    "group progress remains unconfirmed when only one recipient has acknowledged",
    await evaluate(
      a,
      '(()=>{const meta=[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-GROUP-BULK-RETRY").querySelector(".message-meta");return meta.textContent.includes("1/2 đã nhận") && ![...meta.querySelectorAll("svg path")].some(path=>path.getAttribute("d")==="m4 12 5 5L20 6");})()',
    ),
  );
  await send(c, "QA-SEND-WHILE-RECEIVE-BLOCKED");
  await until(
    async () =>
      (await history(c, "user_qa-c")).filter(
        (row) =>
          row.message.body === "QA-SEND-WHILE-RECEIVE-BLOCKED" &&
          row.status === "delivered",
      ).length === 2,
    "outgoing group ACKs bypass slow incoming persistence",
  );
  check(
    "a peer confirms its outgoing group delivery while another incoming group message is still waiting for storage",
    !(await history(c, "user_qa-c")).some(
      (row) => row.message.body === "QA-GROUP-BULK-RETRY",
    ),
  );
  await evaluate(c, "window.qaRestoreGroupStore();window.qaReleaseGroup()");
  await until(
    async () =>
      (await history(a, "user_qa-a")).filter(
        (row) =>
          row.message.body === "QA-GROUP-BULK-RETRY" &&
          row.status === "delivered",
      ).length === 2,
    "all bulk retries confirmed",
  );
  check(
    "bulk retry keeps send controls busy until every recipient finishes and preserves the draft",
    busyUntilLastRecipient,
  );
  await fill(a, "textarea", "");
  await reload(b);
  await until(
    () =>
      evaluate(
        b,
        'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
      ),
    "receiver rejoin",
  );
  check(
    "browser reload automatically restores authenticated session, history and membership",
    (await history(b, "user_qa-b")).some(
      (row) => row.message.body === "QA-DIRECT-REAL",
    ) &&
      (await evaluate(
        b,
        '[...document.querySelectorAll("nav strong")].some(item=>item.textContent==="Team QA")',
      )),
  );
  await choose(b, "Peer C");
  await send(b, "QA-DIRECT-AFTER-RELOAD");
  const restartedDirect = await until(
    async () =>
      (await history(b, "user_qa-b")).find(
        (row) =>
          row.message.body === "QA-DIRECT-AFTER-RELOAD" &&
          row.status === "delivered",
      ),
    "direct after browser reload",
    20000,
  );
  check(
    "a restarted peer establishes a fresh DIRECT connection without waiting for the old session to expire",
    restartedDirect.message.mode === "DIRECT" &&
      !logs.primary.includes(restartedDirect.message.messageId) &&
      !logs.backup.includes(restartedDirect.message.messageId),
  );
  await choose(b, "Peer A");
  await send(b, "QA-GROUP-DIRECT-LINK");
  await until(
    async () =>
      (await history(b, "user_qa-b")).some(
        (row) =>
          row.message.body === "QA-GROUP-DIRECT-LINK" &&
          row.status === "delivered" &&
          row.message.mode === "DIRECT",
      ),
    "direct group recipient link",
  );
  await evaluate(c, "window.qaRTC.forEach(pc=>pc.close())");
  await choose(a, "Team QA");
  await send(a, "QA-GROUP-MIXED-ROUTES");
  const mixed = await until(async () => {
    const rows = (await history(a, "user_qa-a")).filter(
      (row) => row.message.body === "QA-GROUP-MIXED-ROUTES",
    );
    return (
      rows.length === 2 &&
      rows.every((row) => row.status === "delivered") &&
      rows
    );
  }, "mixed group delivery");
  check(
    "one group event uses DIRECT and RELAY per recipient with confirmed delivery and visible route details",
    mixed.some((row) => row.message.mode === "DIRECT") &&
      mixed.some((row) => row.message.mode === "RELAY") &&
      (await evaluate(
        a,
        '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-GROUP-MIXED-ROUTES").querySelector(".route-tag").textContent.includes("DIRECT") && [...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-GROUP-MIXED-ROUTES").querySelector(".route-tag").textContent.includes("RELAY")',
      )),
    mixed.map((row) => ({
      receiver: row.message.receiverId,
      mode: row.message.mode,
      messageId: row.message.messageId,
    })),
  );
  await stop(signal);
  await until(
    () =>
      evaluate(
        a,
        'document.querySelector(".connection-pill")?.textContent.includes("kết nối lại")',
      ),
    "honest reconnect UI",
  );
  signal = launch("signal", process.execPath, [runner, "signaling"], root, env);
  await until(
    async () => (await fetch(signalUrl + "/health")).ok,
    "signaling restart",
  );
  await Promise.all(
    pages.map((session) =>
      until(
        () =>
          evaluate(
            session,
            'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
          ),
        "automatic reconnect",
      ),
    ),
  );
  check(
    "signaling restart restores identities, groups, and browser sessions",
    await evaluate(
      a,
      '[...document.querySelectorAll("nav strong")].some(item=>item.textContent==="Team QA")',
    ),
  );
  await choose(a, "Peer B");
  await click(a, ".diagnostics-link");
  await click(a, ".toggle-setting input");
  await click(a, 'button[aria-label="Đóng chẩn đoán"]');
  await evaluate(
    b,
    `(async()=>{const {WebStore}=await import('/store.ts');const original=WebStore.prototype.put;const gate=new Promise(resolve=>window.qaReleaseForwarded=resolve);WebStore.prototype.put=async function(row){if(row.status==='received'&&row.message.body==='QA-FORWARDED-WAITING-ACK')await gate;return original.call(this,row);};window.qaRestoreForwardedStore=()=>{WebStore.prototype.put=original;};})()`,
  );
  await send(a, "QA-FORWARDED-WAITING-ACK");
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-FORWARDED-WAITING-ACK" &&
          row.status === "forwarded",
      ),
    "relay forwarding receipt before receiver persistence",
  );
  await until(
    () =>
      evaluate(
        a,
        '[...document.querySelectorAll(".message-row.mine")].find(row=>row.querySelector(".bubble p")?.textContent==="QA-FORWARDED-WAITING-ACK")?.querySelector(".message-meta")?.textContent.includes("Đã chuyển tiếp · chờ xác nhận")',
      ),
    "forwarded status label",
  );
  const forwardedWithoutReceipt = !(await history(b, "user_qa-b")).some(
    (row) => row.message.body === "QA-FORWARDED-WAITING-ACK",
  );
  await evaluate(
    b,
    "window.qaRestoreForwardedStore();window.qaReleaseForwarded()",
  );
  await until(
    async () =>
      (await history(a, "user_qa-a")).some(
        (row) =>
          row.message.body === "QA-FORWARDED-WAITING-ACK" &&
          row.status === "delivered",
      ),
    "forwarded progresses to receiver-confirmed delivery",
  );
  check(
    "the interface distinguishes relay-forwarded progress from receiver-confirmed persistence",
    forwardedWithoutReceipt &&
      (await history(b, "user_qa-b")).some(
        (row) =>
          row.message.body === "QA-FORWARDED-WAITING-ACK" &&
          row.status === "received",
      ),
  );
  await send(a, "QA-PRIMARY-RELAY");
  const primaryMessage = await until(async () => {
    const rows = await history(a, "user_qa-a");
    return rows.find(
      (row) =>
        row.message.body === "QA-PRIMARY-RELAY" && row.status === "delivered",
    );
  }, "primary relay baseline");
  check(
    "primary relay handles the baseline before failover",
    primaryMessage.message.mode === "RELAY" &&
      logs.primary.includes(primaryMessage.message.messageId),
  );
  await evaluate(
    a,
    `(async()=>{const {WebStore}=await import('/store.ts');const original=WebStore.prototype.put;const starts=new Map();window.qaLatency=[];WebStore.prototype.put=async function(row){const m=row.message;if(m.senderId==='user_qa-a'&&m.body.startsWith('QA-LATENCY-')){if(row.status==='pending'&&!starts.has(m.messageId))starts.set(m.messageId,performance.now());const result=await original.call(this,row);if(row.status==='delivered'&&starts.has(m.messageId)){window.qaLatency.push({messageId:m.messageId,body:m.body,mode:m.mode,milliseconds:performance.now()-starts.get(m.messageId),serializedEnvelopeBytes:new TextEncoder().encode(JSON.stringify(m)).length});starts.delete(m.messageId);}return result;}return original.call(this,row);};window.qaRestoreLatency=()=>{WebStore.prototype.put=original;};})()`,
  );
  const latencyComparison = {
    scope:
      "Local Chrome application ACK latency from first pending persistence through confirmed delivered persistence; includes peer authorization and storage; excludes UI automation waits; not WAN/NAT or production capacity",
    bodyBytes: 256,
    warmupPerMode: 1,
    samplesPerMode: 20,
    sourceFingerprint: report.sourceFingerprint,
    commit: report.commit,
    modes: {},
  };
  for (const mode of ["DIRECT", "RELAY"]) {
    await click(a, ".diagnostics-link");
    if (
      (await evaluate(
        a,
        'document.querySelector(".toggle-setting input").checked',
      )) !==
      (mode === "RELAY")
    )
      await click(a, ".toggle-setting input");
    await click(a, ".diagnostics .icon-button");
    for (let index = -1; index < latencyComparison.samplesPerMode; index++) {
      const body = `QA-LATENCY-${mode}-${index}-`.padEnd(
        latencyComparison.bodyBytes,
        "x",
      );
      await send(a, body);
      await until(
        () =>
          evaluate(
            a,
            `window.qaLatency.some(sample=>sample.body===${JSON.stringify(body)})`,
          ),
        `${mode} application ACK measurement`,
      );
    }
    const samples = (await evaluate(a, "window.qaLatency")).filter(
      (sample) =>
        sample.mode === mode &&
        !sample.body.startsWith(`QA-LATENCY-${mode}--1-`),
    );
    const sorted = samples
      .map((sample) => sample.milliseconds)
      .sort((left, right) => left - right);
    if (
      samples.length !== latencyComparison.samplesPerMode ||
      sorted.some((value) => !Number.isFinite(value) || value <= 0)
    )
      throw Error(`${mode} latency samples invalid or used a different path`);
    latencyComparison.modes[mode] = {
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
      samples,
    };
  }
  await evaluate(a, "window.qaRestoreLatency()");
  latencyComparison.measuredAt = new Date().toISOString();
  await writeFile(
    join(evidence, "latency-comparison.json"),
    JSON.stringify(latencyComparison, null, 2),
  );
  check(
    "DIRECT and RELAY application ACK latency measured with equal payloads and verified delivery paths",
    true,
    Object.fromEntries(
      Object.entries(latencyComparison.modes).map(([mode, result]) => [
        mode,
        { p50Ms: result.p50Ms, p95Ms: result.p95Ms },
      ]),
    ),
  );
  await stop(primary);
  await pause(700);
  await send(a, "QA-BACKUP-RELAY");
  const backup = await until(async () => {
    const rows = await history(a, "user_qa-a");
    return rows.find(
      (row) =>
        row.message.body === "QA-BACKUP-RELAY" && row.status === "delivered",
    );
  }, "relay failover");
  check(
    "browser automatically uses backup relay after primary stops",
    backup.message.mode === "RELAY" &&
      logs.backup.includes(backup.message.messageId),
  );
  await choose(a, "Team QA");
  await screenshot(a, "ui-chat-desktop.png");
  await click(a, ".diagnostics-link");
  await screenshot(a, "ui-diagnostics-desktop.png");
  await click(a, '.diagnostics button[aria-label="Đóng chẩn đoán"]');
  if (await evaluate(a, '!!document.querySelector(".inspector")'))
    await click(a, 'button[aria-label="Đóng thông tin"]');
  await browserCall(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    a,
  );
  await screenshot(a, "ui-chat-mobile.png");
  check(
    "mobile layout has no horizontal page overflow",
    await evaluate(a, "document.documentElement.scrollWidth <= innerWidth"),
  );
  await click(a, ".mobile-back");
  await click(a, 'button[aria-label="Đổi giao diện sáng tối"]');
  await choose(a, "Team QA");
  await until(
    () => evaluate(a, 'document.documentElement.dataset.theme === "dark"'),
    "dark theme",
  );
  check(
    "dark theme applies readable foreground colors",
    await evaluate(
      a,
      `(()=>{const luminance=color=>{const rgb=color.match(/[\\d.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722};const contrast=(fg,bg)=>{const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};const body=getComputedStyle(document.body),sidebar=document.querySelector('.sidebar'),text=sidebar.querySelector('.conversation-copy small');return contrast(body.color,body.backgroundColor)>=7&&!!text&&contrast(getComputedStyle(text).color,getComputedStyle(sidebar).backgroundColor)>=4.5})()`,
    ),
  );
  await screenshot(a, "ui-chat-mobile-dark.png");
  await click(a, ".mobile-back");
  await click(a, ".diagnostics-link");
  await screenshot(a, "ui-diagnostics-mobile-dark.png");
  await click(a, '.diagnostics button[aria-label="Đóng chẩn đoán"]');
  const loadMatrix = [];
  for (const [peers, messages, concurrency] of [
    [3, 20, 1],
    [20, 10, 8],
    [50, 10, 20],
    [100, 10, 50],
  ]) {
    const before = await (await fetch(backupUrl + "/health")).json();
    const loadChild = spawn(
      process.execPath,
      [
        join(root, "scripts/load-relay.mjs"),
        "--peers",
        String(peers),
        "--messages",
        String(messages),
        "--concurrency",
        String(concurrency),
        "--signal",
        signalUrl,
        "--relay",
        backupUrl,
      ],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(loadChild);
    let loadOutput = "",
      loadError = "";
    loadChild.stdout.on("data", (bytes) => (loadOutput += bytes));
    loadChild.stderr.on("data", (bytes) => (loadError += bytes));
    const loadCode = await new Promise((resolve, reject) => {
      loadChild.once("exit", resolve);
      loadChild.once("error", reject);
    });
    if (loadCode !== 0)
      throw new Error(`Load experiment failed: ${loadError}\n${loadOutput}`);
    const load = JSON.parse(loadOutput);
    load.commit = report.commit;
    load.sourceFingerprint = report.sourceFingerprint;
    load.workingTreeModified = report.workingTreeModified;
    const after = await (await fetch(backupUrl + "/health")).json();
    load.relayMetricsDelta = Object.fromEntries(
      ["forwardedMessages", "forwardedPayloadBytes"].map((key) => [
        key,
        after.metrics[key] - before.metrics[key],
      ]),
    );
    loadMatrix.push(load);
    if (peers === 20)
      await writeFile(
        join(evidence, "load-relay.json"),
        JSON.stringify(load, null, 2),
      );
    check(
      `${peers} simulated peers deliver ${peers * messages} relay messages with concurrency ${concurrency} without loss, duplication, misrouting or content changes`,
      load.delivered === peers * messages &&
        load.failed === 0 &&
        load.duplicateDeliveries === 0 &&
        load.misroutedDeliveries === 0 &&
        load.corruptedDeliveries === 0 &&
        load.relayMetricsDelta.forwardedMessages === load.delivered &&
        load.relayMetricsDelta.forwardedPayloadBytes ===
          load.serializedEnvelopeBytes,
    );
  }
  await writeFile(
    join(evidence, "load-matrix.json"),
    JSON.stringify(
      {
        scope:
          "Sequential localhost load scenarios, fixed headless demo-identity envelopes; not application ACK, browser persistence, real-account session authorization, WAN or maximum capacity",
        sourceFingerprint: report.sourceFingerprint,
        commit: report.commit,
        scenarios: loadMatrix,
      },
      null,
      2,
    ),
  );
  await click(b, 'button[aria-label="Đăng xuất"]');
  await until(
    () => evaluate(b, '!!document.querySelector("input[name=password]")'),
    "account logout",
  );
  check(
    "logout clears the tab session and hides chat history",
    await evaluate(
      b,
      '!sessionStorage.getItem("ds01-account-session-v1") && !document.querySelector(".chat-layout") && !document.querySelector("nav .conversation") && !document.querySelector(".self-profile .avatar") && !document.querySelector(".self-profile small")',
    ),
  );
  await reload(b);
  await until(
    () => evaluate(b, '!!document.querySelector("input[name=password]")'),
    "logged-out reload",
  );
  check(
    "logged-out reload stays at the login form",
    await evaluate(
      b,
      '!document.querySelector(".empty-chat") && !sessionStorage.getItem("ds01-account-session-v1")',
    ),
  );
  await fill(b, "input[name=username]", "qa-b");
  await fill(b, "input[name=password]", "Browser acceptance passphrase!");
  await click(b, ".connect-card button[type=submit]");
  await until(
    () =>
      evaluate(
        b,
        'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
      ),
    "same-account login after logout",
  );
  check(
    "same account logs back in with its original Peer ID and local history",
    (await history(b, "user_qa-b")).some(
      (row) => row.message.body === "QA-DIRECT-REAL",
    ),
  );
  await click(b, 'button[aria-label="Đăng xuất"]');
  await until(
    () => evaluate(b, '!!document.querySelector("input[name=password]")'),
    "second logout",
  );
  await click(b, ".demo-toggle");
  await fill(b, "input[autocomplete=nickname]", "Legacy demo peer");
  await fill(b, ".demo-card label:last-of-type input", "qa-legacy-web");
  await click(b, ".demo-card button[type=submit]");
  await until(
    () =>
      evaluate(
        b,
        'document.querySelector(".connection-pill")?.textContent.includes("Đang trực tuyến")',
      ),
    "legacy demo connection",
  );
  check(
    "legacy Peer ID demo remains available and does not mix account chat history",
    await evaluate(
      b,
      'document.querySelector(".self-profile small").textContent === "qa-legacy-web" && !JSON.parse(localStorage.getItem("ds01-history-v1-qa-legacy-web")||"[]").length',
    ),
  );
  check(
    "no browser JavaScript exceptions",
    !report.browserErrors?.length,
    report.browserErrors,
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  report.logs = logs;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  mandatory.sourceFingerprint = report.sourceFingerprint;
  mandatory.commit = report.commit;
  mandatory.finishedAt = report.finishedAt;
  mandatory.localFunctionalChecksPassed = report.passed === true;
  mandatory.allMandatoryScenariosVerified = false;
  report.mandatoryScenarios = "mandatory-scenarios.json";
  await Promise.all([
    writeFile(
      join(evidence, "browser-smoke.json"),
      JSON.stringify(report, null, 2),
    ),
    writeFile(
      join(evidence, "mandatory-scenarios.json"),
      JSON.stringify(mandatory, null, 2),
    ),
    writeFile(
      join(evidence, "path-proof.json"),
      JSON.stringify(
        {
          ...pathProof,
          sourceFingerprint: report.sourceFingerprint,
          commit: report.commit,
        },
        null,
        2,
      ),
    ),
  ]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  if (browserCall)
    await Promise.race([
      browserCall("Browser.close").catch(() => {}),
      pause(1000),
    ]);
  ws?.close();
  await stop(chrome);
  for (const child of children) await stop(child);
  await dashboard?.close();
  await Promise.all(
    ["signal", "primary", "backup", "web"].map((name) =>
      writeFile(join(evidence, `${name}.log`), logs[name]),
    ),
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  clearTimeout(deadline);
  const checked = resolve(qa);
  if (dirname(checked) === evidence && basename(checked) === "work")
    await rm(checked, { recursive: true, force: true }).catch(() => {});
}
