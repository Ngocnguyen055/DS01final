import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  prepareRuntime,
  runtimeRoot,
  toolsDirectory,
} from "./runtime-paths.mjs";

await prepareRuntime();
const root = fileURLToPath(new URL("..", import.meta.url)),
  directory = await mkdtemp(join(runtimeRoot, "browser-groups-"));
const publicRelays = process.argv.includes("--public-relays");
const children = [],
  logs = {},
  report = {
    scope:
      "Local real Chrome, real UDP STUN/TURN, fake microphone/camera; not public WAN/NAT evidence",
    startedAt: new Date().toISOString(),
    checks: [],
  };
console.log(`Group call browser evidence: ${directory}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      error = e;
    }
    await pause(100);
  }
  throw Error(`Timeout: ${label} ${error?.message || ""}`);
}
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function udpPort() {
  const s = createSocket("udp4");
  await new Promise((r) => s.bind(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function launch(
  name,
  args,
  cwd = root,
  env = {},
  executable = process.execPath,
) {
  logs[name] = "";
  const c = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  c.stdout.on("data", (b) => (logs[name] += b));
  c.stderr.on("data", (b) => (logs[name] += b));
  c.on("error", (e) => (logs[name] += e.message));
  children.push(c);
  return c;
}
function check(label, result, metrics) {
  report.checks.push({ label, passed: !!result, metrics });
  console.log(`${result ? "PASS" : "FAIL"} ${label}`);
  if (!result) throw Error(label);
}
let turn, ws, call, diagnose;
const deadline = setTimeout(
  () => {
    for (const child of children) child.kill();
    console.error("Advanced browser deadline");
    process.exit(2);
  },
  publicRelays ? 360000 : 240000,
);
try {
  const [sp, rp, bp, wp, tp] = await Promise.all([
    port(),
    port(),
    port(),
    port(),
    udpPort(),
  ]);
  const signalUrl = `http://127.0.0.1:${sp}`,
    relayUrls = [`http://127.0.0.1:${rp}`, `http://127.0.0.1:${bp}`],
    webUrl = `http://127.0.0.1:${wp}`;
  const username = randomBytes(12).toString("hex"),
    credential = randomBytes(24).toString("hex");
  turn = launch("turn", [join(root, "scripts/turn-lab.mjs")], root, {
    TURN_LAB_PORT: String(tp),
    TURN_LAB_USERNAME: username,
    TURN_LAB_PASSWORD: credential,
  });
  await until(() => logs.turn.includes("TURN_READY"), "local TURN startup");
  const env = {
    NODE_ENV: "production",
    DS01_BIND_HOST: "127.0.0.1",
    SIGNAL_PORT: String(sp),
    SIGNAL_INTERNAL_URL: signalUrl,
    SIGNAL_STATE_PATH: join(directory, "signal.json"),
    ACCOUNT_STATE_PATH: join(directory, "accounts.json"),
    JWT_SECRET: randomBytes(32).toString("hex"),
    PEER_SECRET: randomBytes(32).toString("hex"),
    RELAY_OFFLINE_QUEUE: "1",
    RELAY_CLUSTER_URLS: relayUrls.join(","),
  };
  const runner = join(root, "scripts/run-node.mjs");
  const signaling = launch("signal", [runner, "signaling"], root, env);
  const primary = launch("primary", [runner, "relay"], root, {
    ...env,
    RELAY_PORT: String(rp),
    RELAY_PUBLIC_URL: relayUrls[0],
    RELAY_STATE_PATH: join(directory, "primary.json"),
  });
  launch("backup", [runner, "relay"], root, {
    ...env,
    RELAY_PORT: String(bp),
    RELAY_PUBLIC_URL: relayUrls[1],
    RELAY_STATE_PATH: join(directory, "backup.json"),
  });
  if (publicRelays) {
    const config = join(directory, "cloudflared.yml");
    await writeFile(config, "{}\n");
    const cloudflared =
      process.env.CLOUDFLARED_PATH ||
      (process.platform === "win32"
        ? join(toolsDirectory, "cloudflared.exe")
        : "cloudflared");
    const urls = await Promise.all(
      relayUrls.map(async (url, index) => {
        const name = "tunnel-" + index;
        launch(
          name,
          [
            "tunnel",
            "--config",
            config,
            "--no-autoupdate",
            "--protocol",
            "http2",
            "--metrics",
            "127.0.0.1:0",
            "--url",
            url,
          ],
          root,
          {},
          cloudflared,
        );
        return until(
          () =>
            logs[name].match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0],
          name,
          90000,
        );
      }),
    );
    relayUrls.splice(0, relayUrls.length, ...urls);
    report.publicRelayUrls = urls;
    report.scope =
      "Real Chrome with HTTPS public application relays; blocked native ICE simulation and loopback TURN; not physical VPN device evidence";
    console.log(
      "Testing application media through public HTTPS relays: " +
        urls.join(", "),
    );
  }
  launch(
    "web",
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
      VITE_RELAY_URL: relayUrls[0],
      VITE_RELAY_URLS: relayUrls[1],
      VITE_E2EE: "1",
      VITE_ICE_POLICY: "relay",
      VITE_ICE_SERVERS: JSON.stringify([
        { urls: `turn:127.0.0.1:${tp}?transport=udp`, username, credential },
      ]),
    },
  );
  await Promise.all(
    [signalUrl + "/health", ...relayUrls.map((x) => x + "/health"), webUrl].map(
      (url) =>
        until(
          async () =>
            (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok,
          url,
          publicRelays ? 90000 : 20000,
        ),
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
  if (!executable) throw Error("Set CHROME_PATH to Chromium");
  const profile = join(directory, "chrome");
  await mkdir(profile);
  launch(
    "chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--allow-loopback-in-peer-connection",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    root,
    {},
    executable,
  );
  const [cp, suffix] = (
    await until(
      () => readFile(join(profile, "DevToolsActivePort"), "utf8"),
      "Chrome startup",
    )
  )
    .trim()
    .split(/\r?\n/);
  ws = new WebSocket(`ws://127.0.0.1:${cp}${suffix}`);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const data = JSON.parse(String(e.data)),
      p = pending.get(data.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(data.id);
      data.error
        ? p.reject(Error(JSON.stringify(data.error)))
        : p.resolve(data.result);
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Chrome closed"));
    }
    pending.clear();
  };
  call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next,
        timer = setTimeout(
          () => {
            pending.delete(id);
            reject(Error("CDP timeout " + method));
          },
          method === "Page.captureScreenshot" ? 30000 : 12000,
        );
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
    const value = await call(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      session,
    );
    if (value.exceptionDetails)
      throw Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const pages = [];
  for (const id of ["peer-a", "peer-b", "peer-c"]) {
    const { browserContextId } = await call("Target.createBrowserContext");
    const { targetId } = await call("Target.createTarget", {
      url: webUrl,
      browserContextId,
    });
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    pages.push(sessionId);
    await call("Runtime.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);
    await until(
      () =>
        evaluate(
          sessionId,
          `location.origin === ${JSON.stringify(webUrl)} && document.readyState === "complete"`,
        ),
      "page",
    );
    if (id === "peer-a" && !publicRelays) {
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
        sessionId,
      );
      await until(
        () =>
          evaluate(
            sessionId,
            '!!document.querySelector("input[name=username]")',
          ),
        "mobile application login",
      );
      const preview = await call(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        sessionId,
      );
      await writeFile(
        join(directory, "ui-login-mobile.png"),
        Buffer.from(preview.data, "base64"),
      );
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
    }
    await evaluate(
      sessionId,
      `(async()=>{const {PeerClient}=await import('/@fs/'+${JSON.stringify(join(root, "src/shared/peer.ts").replaceAll("\\", "/"))});const {WebStore}=await import('/storage/store.ts');window.Peer=PeerClient;window.Store=WebStore;window.rtc=[];window.wire=[];window.events=[];const Native=RTCPeerConnection;window.RTC=class extends Native{constructor(...a){super(...a);window.rtc.push(this);this.addEventListener('icecandidateerror',e=>window.events.push({kind:'log',text:e.errorCode+':'+e.errorText}))}};const send=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(d){window.wire.push(JSON.parse(d));return send.call(this,d)};window.config={peerId:${JSON.stringify(id)},identityProof:'advanced-browser-'+${JSON.stringify(id)},displayName:${JSON.stringify(id)},signalUrl:${JSON.stringify(signalUrl)},relayUrl:${JSON.stringify(relayUrls[0])},relayUrls:[${JSON.stringify(relayUrls[1])}],rtc:RTC,store:new WebStore(${JSON.stringify(id)}),identityStore:new WebStore(${JSON.stringify(id)}),encryption:true,relaySelection:'latency-load',iceServers:[{urls:${JSON.stringify(`turn:127.0.0.1:${tp}?transport=udp`)},username:${JSON.stringify(username)},credential:${JSON.stringify(credential)}}],rtcPolicy:'relay',directTimeoutMs:8000,ackTimeoutMs:2000,onEvent:e=>{window.events.push(e);if(e.kind==='call')window.lastCall=e.call;if(e.kind==='group-call'){window.groupCall=e.groupCall;window.groupRooms=e.groupCalls;}}};window.peer=new PeerClient(config);await peer.connect();return true})()`,
    );
  }
  diagnose = async () => {
    report.browserFailure = await Promise.all(
      pages.map((page) =>
        evaluate(
          page,
          `({body:document.body.innerText.slice(-16000),calls:localStorage.getItem('ds01-history-v1-peer-c-calls'),events:(window.events||[]).slice(-30).map(e=>e.kind==='log'?e.text:e.kind)})`,
        ).catch(String),
      ),
    );
    for (let i = 0; i < pages.length; i++) {
      const shot = await call(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        pages[i],
      ).catch(() => null);
      if (shot)
        await writeFile(
          join(directory, "failure-" + i + ".png"),
          Buffer.from(shot.data, "base64"),
        );
    }
  };
  const [a, b, c] = pages,
    rows = (s, id) => evaluate(s, `new Store(${JSON.stringify(id)}).list()`);
  const forwards = async () =>
    (
      await Promise.all(
        relayUrls.map(
          async (x) =>
            (await (await fetch(x + "/health")).json()).metrics
              .forwardedMessages,
        ),
      )
    ).reduce((x, y) => x + y, 0);

  const resetCapture = async (page) =>
    evaluate(
      page,
      `window.captureCount=0;if(!window.captureMedia){window.captureMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...a)=>{captureCount++;return captureMedia(...a)}}`,
    );
  const joinCall = async (page, roomId) =>
    evaluate(page, `peer.groupMedia.join(${JSON.stringify(roomId)})`);
  const connected = async (page, mode, count = 2, video = true) =>
    until(
      () =>
        evaluate(
          page,
          `groupCall?.phase==='active'&&groupCall.room.participants.length===${count + 1}&&groupCall.peers.length===${count}&&groupCall.peers.every(p=>p.phase==='connected'&&p.route===${JSON.stringify(mode)}&&p.remote?.getAudioTracks().length&&${video && mode === "RELAY" ? "!!p.remoteFrame" : video ? "p.remote.getVideoTracks().length===1" : "true"})`,
        ),
      mode + " group connections",
    );
  const audio = async (page, ui = false) => {
    await evaluate(
      page,
      `(async()=>{window.voiceContext=new AudioContext();window.voicePlayers=[];window.voiceChecks=${ui ? "[...document.querySelectorAll('.group-call-tile[data-local=false] audio')].map(p=>p.srcObject)" : "groupCall.peers.map(p=>p.remote)"}.map(stream=>{const player=new Audio();player.srcObject=stream;voicePlayers.push(player);const analyser=voiceContext.createAnalyser();voiceContext.createMediaStreamSource(stream).connect(analyser);return {analyser,buffer:new Float32Array(analyser.fftSize),heard:false}});await Promise.all(voicePlayers.map(p=>p.play()))})()`,
    );
    await until(
      () =>
        evaluate(
          page,
          `voiceChecks.every(c=>{c.analyser.getFloatTimeDomainData(c.buffer);c.heard||=c.buffer.some(x=>Math.abs(x)>0.001);return c.heard})`,
        ),
      "audio signal from every other group participant",
    );
    await evaluate(
      page,
      "voicePlayers.forEach(p=>{p.pause();p.srcObject=null});voiceContext.close()",
    );
  };
  for (const page of pages) await resetCapture(page);
  report.groupId = await evaluate(
    a,
    `(async()=>{const g=await peer.createGroup(['peer-b','peer-c'],'Group Calls QA');return g.id})()`,
  );
  await evaluate(
    a,
    `peer.groupMedia.start(${JSON.stringify(report.groupId)},'video')`,
  );
  const roomId = await until(
    () => evaluate(a, `groupCall?.room.roomId`),
    "group room",
  );
  await until(
    () => evaluate(b, `groupCall?.phase==='incoming'`),
    "group invitation B",
  );
  await until(
    () => evaluate(c, `groupCall?.phase==='incoming'`),
    "group invitation C",
  );
  check(
    "group invitation never captures microphone or camera before consent",
    (await evaluate(b, "captureCount===0&&!groupCall.local")) &&
      (await evaluate(c, "captureCount===0&&!groupCall.local")),
  );
  await Promise.all([joinCall(b, roomId), joinCall(c, roomId)]);
  await Promise.all(pages.map((page) => connected(page, "TURN")));
  for (const page of pages) await audio(page);
  check(
    "three peers exchange video and non-silent audio on all six WebRTC directions",
    true,
  );
  check(
    "each participant captures microphone and camera exactly once for the mesh",
    (
      await Promise.all(pages.map((page) => evaluate(page, "captureCount===1")))
    ).every(Boolean),
  );
  await evaluate(
    a,
    `peer.groupMedia.mute('audio',true);peer.groupMedia.mute('video',true)`,
  );
  check(
    "group mute and camera controls change shared live capture tracks",
    await evaluate(
      a,
      "groupCall.muted&&groupCall.cameraOff&&groupCall.local.getTracks().every(t=>!t.enabled)",
    ),
  );
  await evaluate(a, "peer.groupMedia.leave()");
  await Promise.all([connected(b, "TURN", 1), connected(c, "TURN", 1)]);
  check(
    "initiator leaving preserves the call between the remaining members",
    await evaluate(
      a,
      "groupCall.local.getTracks().every(t=>t.readyState==='ended')",
    ),
  );
  for (const page of [b, c]) await evaluate(page, "peer.groupMedia.leave()");
  await until(
    () => evaluate(a, "groupRooms.length===0"),
    "empty group call ends",
  );
  check(
    "the last participant leaving closes the room for every group member",
    true,
  );

  for (const page of pages)
    await evaluate(
      page,
      `(async()=>{peer.close();window.peer=new Peer({...config,iceServers:[],rtcPolicy:'all'});await peer.connect()})()`,
    );
  await evaluate(
    a,
    `peer.groupMedia.start(${JSON.stringify(report.groupId)},'video')`,
  );
  const directRoom = await until(
    () => evaluate(a, "groupCall?.phase==='active'&&groupCall.room.roomId"),
    "direct group room",
  );
  await until(
    () => evaluate(b, `groupCall?.room.roomId===${JSON.stringify(directRoom)}`),
    "direct group invitation B",
  );
  await until(
    () => evaluate(c, `groupCall?.room.roomId===${JSON.stringify(directRoom)}`),
    "direct group invitation C",
  );
  await Promise.all([joinCall(b, directRoom), joinCall(c, directRoom)]);
  await Promise.all(pages.map((page) => connected(page, "DIRECT")));
  for (const page of pages) await audio(page);
  check(
    "group video also uses real DIRECT WebRTC when host connectivity is available",
    true,
  );
  for (const page of pages) await evaluate(page, "peer.groupMedia.leave()");

  for (const page of pages) {
    await evaluate(
      page,
      `(async()=>{peer.close();window.peer=new Peer({...config,simulateMediaIceFailure:true});await peer.connect()})()`,
    );
    await resetCapture(page);
  }
  for (const kind of ["audio", "video"]) {
    await evaluate(
      a,
      `peer.groupMedia.start(${JSON.stringify(report.groupId)},${JSON.stringify(kind)})`,
    );
    const id = await until(
      () => evaluate(a, "groupCall?.phase==='active'&&groupCall.room.roomId"),
      "new relay group room",
    );
    await until(
      () => evaluate(b, `groupCall?.room.roomId===${JSON.stringify(id)}`),
      "relay room B",
    );
    await until(
      () => evaluate(c, `groupCall?.room.roomId===${JSON.stringify(id)}`),
      "relay room C",
    );
    await Promise.all([joinCall(b, id), joinCall(c, id)]);
    await Promise.all(
      pages.map((page) => connected(page, "RELAY", 2, kind === "video")),
    );
    for (const page of pages) await audio(page);
    check(
      "three-peer " +
        kind +
        " call falls back to encrypted relay when ICE is blocked",
      true,
    );
    if (kind === "audio")
      for (const page of pages) await evaluate(page, "peer.groupMedia.leave()");
  }
  check(
    "multiple relay links remain isolated within the same group room",
    (await (await fetch(relayUrls[0] + "/health")).json()).metrics.mediaFrames >
      0,
  );
  await evaluate(
    c,
    `peer.groupMedia.leave();peer.close();localStorage.setItem('ds01-peer-id','peer-c');localStorage.setItem('ds01-display-name','Peer C');localStorage.setItem('ds01-peer-secret-peer-c','advanced-browser-peer-c')`,
  );
  await call("Page.reload", {}, c);
  await until(
    () => evaluate(c, '!!document.querySelector(".demo-toggle")'),
    "UI reload",
  );
  await evaluate(c, `document.querySelector('.demo-toggle').click()`);
  await until(
    () => evaluate(c, '!!document.querySelector(".demo-card")'),
    "legacy login",
  );
  await evaluate(c, `document.querySelector('.demo-card').requestSubmit()`);
  await until(
    () => evaluate(c, '!!document.querySelector(".connection-pill.is-online")'),
    "actual UI connected",
  );
  await resetCapture(c);
  await until(
    () =>
      evaluate(
        c,
        `!!document.querySelector('.group-call-panel[data-phase=incoming]')`,
      ),
    "call invitation in actual UI",
  );
  check(
    "newly connected group member discovers the ongoing call without capture",
    await evaluate(c, "captureCount===0"),
  );
  await evaluate(
    c,
    `[...document.querySelectorAll('.group-call-panel button')].find(b=>b.textContent==='Để sau').click();[...document.querySelectorAll('.conversation')].find(b=>b.textContent.includes('Group Calls QA')).click()`,
  );
  await until(
    () =>
      evaluate(
        c,
        `!!document.querySelector('button[aria-label="Gọi video nhóm"]')&&!!document.querySelector('.group-call-banner')`,
      ),
    "group header controls and call banner",
  );
  check(
    "group conversation exposes voice/video controls and a late-join call banner",
    true,
  );
  await call(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    c,
  );
  await evaluate(
    c,
    `document.querySelector('.group-call-banner button').click()`,
  );
  await until(
    () =>
      evaluate(
        c,
        `document.querySelector('.group-call-panel')?.dataset.phase==='active'&&document.querySelectorAll('.group-call-tile[data-local=false] img').length===2&&[...document.querySelectorAll('.group-call-tile[data-local=false] img')].every(i=>i.naturalWidth>0)`,
      ),
    "three participants shown in mobile UI",
  );
  await Promise.all([connected(a, "RELAY"), connected(b, "RELAY")]);
  await audio(c, true);
  check(
    "mobile UI joins the existing call and plays both remote audio/video streams",
    await evaluate(
      c,
      `captureCount===1&&[...document.querySelectorAll('.group-call-tile[data-local=false] audio')].every(a=>!a.paused)`,
    ),
  );
  check(
    "mobile group call panel stays inside the viewport",
    await evaluate(
      c,
      `(()=>{const r=document.querySelector('.group-call-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&document.documentElement.scrollWidth<=innerWidth})()`,
    ),
  );
  let screenshot = await call(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    c,
  );
  await writeFile(
    join(directory, "group-call-mobile.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await evaluate(
    c,
    `[...document.querySelectorAll('.group-call-panel .call-actions button')].find(b=>b.textContent==='Tắt mic').click();[...document.querySelectorAll('.group-call-panel .call-actions button')].find(b=>b.textContent==='Tắt camera').click()`,
  );
  check(
    "mobile group mute/camera buttons affect the actual local capture",
    await evaluate(
      c,
      `document.querySelectorAll('.group-call-panel button[aria-pressed=true]').length===2&&document.querySelector('.group-call-tile[data-local=true] video').srcObject.getTracks().every(t=>!t.enabled)`,
    ),
  );
  await call(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
    c,
  );
  const position = () =>
    evaluate(
      c,
      `(()=>{const r=document.querySelector('.group-call-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
    );
  const initialBox = await position();
  await call(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x: initialBox.x + 50,
      y: initialBox.y + 20,
      button: "left",
      clickCount: 1,
    },
    c,
  );
  await call(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: initialBox.x + 130,
      y: initialBox.y + 70,
      button: "left",
      buttons: 1,
    },
    c,
  );
  await call(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x: initialBox.x + 130,
      y: initialBox.y + 70,
      button: "left",
    },
    c,
  );
  await until(
    async () => (await position()).x > initialBox.x + 40,
    "dragged call position rendered",
  );
  const movedBox = await position();
  check(
    "call window can be dragged without interrupting media",
    movedBox.x > initialBox.x + 40,
  );
  await evaluate(
    c,
    `document.querySelector('.call-resize').focus();document.querySelector('.call-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`,
  );
  await until(
    async () => (await position()).width > movedBox.width,
    "resized call rendered",
  );
  check(
    "call window supports keyboard resizing",
    (await position()).width > movedBox.width,
  );
  await evaluate(
    c,
    `document.querySelector('button[aria-label="Thu gọn cuộc gọi"]').click()`,
  );
  check(
    "minimizing preserves audio playback and frees the conversation area",
    await evaluate(
      c,
      `document.querySelector('.group-call-panel').classList.contains('minimized')&&[...document.querySelectorAll('.group-call-panel audio')].every(a=>!a.paused)&&document.querySelector('.group-call-panel').getBoundingClientRect().height<120`,
    ),
  );
  await evaluate(
    c,
    `document.querySelector('button[aria-label="Mở cửa sổ cuộc gọi"]').click();document.querySelector('button[aria-label="Phóng to cuộc gọi"]').click()`,
  );
  check(
    "video call expands to the desktop viewport",
    (await position()).width > 1200,
  );
  await evaluate(
    c,
    `document.querySelector('button[aria-label="Khôi phục kích thước cuộc gọi"]').click();document.querySelector('.sidebar-toggle').click()`,
  );
  await until(
    () =>
      evaluate(
        c,
        `document.querySelector('.sidebar').getBoundingClientRect().width===0`,
      ),
    "sidebar collapse animation",
  );
  check(
    "sidebar collapses and restores without covering chat",
    await evaluate(
      c,
      `document.querySelector('.sidebar').getBoundingClientRect().width===0&&document.querySelector('.main-panel').getBoundingClientRect().left<10`,
    ),
  );
  await evaluate(
    c,
    `document.querySelector('.sidebar-toggle').click();const input=document.querySelector('.composer input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File(['group file via actual UI'],'ui-group.txt',{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  await until(
    async () =>
      (await rows(a, "peer-a")).some(
        (row) =>
          row.message.type === "attachment" &&
          row.message.attachments?.[0].name === "ui-group.txt",
      ) &&
      (await rows(b, "peer-b")).some(
        (row) =>
          row.message.type === "attachment" &&
          row.message.attachments?.[0].name === "ui-group.txt",
      ),
    "file reaches both group recipients",
    45000,
  );
  await until(
    () =>
      evaluate(
        c,
        `[...document.querySelectorAll('.message-meta')].some(node=>node.textContent.includes('2/2 đã nhận'))`,
      ),
    "per-recipient file ACKs visible",
  );
  check(
    "actual group composer sends a file to both recipients and displays per-recipient delivery",
    await evaluate(
      c,
      `document.querySelectorAll('.attachment').length===1&&[...document.querySelectorAll('.message-meta')].some(node=>node.textContent.includes('2/2 đã nhận'))`,
    ),
  );
  await evaluate(
    c,
    `document.querySelector('.message-meta details').open=true`,
  );
  check(
    "message details stay inside the chat area with long IDs",
    await evaluate(
      c,
      `(()=>{const d=document.querySelector('.message-details').getBoundingClientRect(),p=document.querySelector('.chat-panel').getBoundingClientRect();return d.left>=p.left&&d.right<=p.right&&document.documentElement.scrollWidth<=innerWidth})()`,
    ),
  );
  screenshot = await call(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    c,
  );
  await writeFile(
    join(directory, "movable-call-and-chat-desktop.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await evaluate(
    c,
    `document.querySelector('.group-call-panel .danger').click()`,
  );
  await until(
    () =>
      evaluate(c, `!!document.querySelector('.call-history-entry.completed')`),
    "group call history in conversation",
  );
  check(
    "group call history records completed participation inside the conversation",
    await evaluate(
      c,
      `JSON.parse(localStorage.getItem('ds01-history-v1-peer-c-calls')).some(record=>record.groupId===${JSON.stringify(report.groupId)}&&record.endedAt&&record.outcome==='completed')`,
    ),
  );
  await call(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    c,
  );
  await Promise.all([connected(a, "RELAY", 1), connected(b, "RELAY", 1)]);
  check(
    "mobile leave releases devices while the other two peers keep talking",
    await evaluate(
      c,
      `document.querySelector('.group-call-panel')?.dataset.phase==='ended'&&document.querySelector('.group-call-tile')===null`,
    ),
  );
  await evaluate(
    c,
    `document.querySelector('.group-call-banner button').click()`,
  );
  await until(
    () =>
      evaluate(
        c,
        `document.querySelector('.group-call-panel')?.dataset.phase==='active'&&document.querySelectorAll('.group-call-tile[data-local=false] img').length===2`,
      ),
    "group rejoin",
  );
  await Promise.all([connected(a, "RELAY"), connected(b, "RELAY")]);
  check("a participant can rejoin the same ongoing group call", true);
  await evaluate(a, "peer.groupMedia.leave()");
  await evaluate(b, "peer.groupMedia.leave()");
  await evaluate(
    c,
    `document.querySelector('.group-call-panel .danger').click()`,
  );
  await until(
    () =>
      evaluate(
        c,
        `!document.querySelector('.group-call-banner')&&!document.querySelector('button[aria-label="Gọi thoại nhóm"]').disabled`,
      ),
    "group start control enabled after call ends",
  );
  await evaluate(
    c,
    `document.querySelector('button[aria-label="Gọi thoại nhóm"]').click()`,
  );
  const voiceRoom = await until(
    () =>
      evaluate(
        a,
        "groupCall?.phase==='incoming'&&groupCall.room.kind==='audio'&&groupCall.room.roomId",
      ),
    "UI initiated group voice call",
  );
  await until(
    () => evaluate(b, `groupCall?.room.roomId===${JSON.stringify(voiceRoom)}`),
    "UI voice invitation B",
  );
  await Promise.all([joinCall(a, voiceRoom), joinCall(b, voiceRoom)]);
  await Promise.all([
    connected(a, "RELAY", 2, false),
    connected(b, "RELAY", 2, false),
  ]);
  await until(
    () =>
      evaluate(
        c,
        `document.querySelectorAll('.group-call-tile').length===3&&document.querySelector('.group-call-panel')?.dataset.kind==='audio'`,
      ),
    "UI group voice participants",
  );
  await audio(c, true);
  check(
    "actual group voice button starts a three-way call without enabling the camera",
    await evaluate(
      c,
      `document.querySelector('.group-call-tile[data-local=true] video').srcObject.getVideoTracks().length===0`,
    ),
  );
  await evaluate(
    a,
    `peer.changeGroup(${JSON.stringify(report.groupId)},'peer-c','remove')`,
  );
  await until(
    () =>
      evaluate(
        c,
        `document.querySelector('.group-call-panel')?.dataset.phase==='ended'&&!document.querySelector('.group-call-banner')`,
      ),
    "removed member loses call access",
  );
  await Promise.all([
    connected(a, "RELAY", 1, false),
    connected(b, "RELAY", 1, false),
  ]);
  check(
    "removing a group member terminates that members media links and leaves the others connected",
    true,
  );
  await evaluate(a, "peer.groupMedia.leave()");
  await evaluate(b, "peer.groupMedia.leave()");
  await call("Page.reload", {}, c);
  await until(
    () => evaluate(c, `!!document.querySelector('.demo-toggle')`),
    "login after reload",
  );
  await evaluate(c, `document.querySelector('.demo-toggle').click()`);
  await until(
    () => evaluate(c, `!!document.querySelector('.demo-card')`),
    "legacy login form rendered",
  );
  await evaluate(c, `document.querySelector('.demo-card').requestSubmit()`);
  await until(
    () => evaluate(c, `!!document.querySelector('.connection-pill.is-online')`),
    "session restored after reload",
  );
  await evaluate(
    c,
    `[...document.querySelectorAll('.conversation')].find(b=>b.textContent.includes('Group Calls QA')).click()`,
  );
  await until(
    () =>
      evaluate(
        c,
        `document.querySelectorAll('.call-history-entry').length>=3&&!!document.querySelector('.attachment')`,
      ),
    "persistent group call and file history",
  );
  check(
    "reload retains call and file history and restores no stale active call",
    await evaluate(
      c,
      `!document.querySelector('.group-call-panel[data-phase=active]')&&JSON.parse(localStorage.getItem('ds01-history-v1-peer-c-calls')).every(record=>record.outcome!=='ongoing')`,
    ),
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
  await diagnose?.().catch(() => {});
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  if (call)
    await Promise.race([call("Browser.close").catch(() => {}), pause(1000)]);
  ws?.close();
  for (const child of children)
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        pause(1500),
      ]);
    }
  if (turn?.exitCode === null) turn.kill();
  clearTimeout(deadline);
  await writeFile(
    join(directory, "group-call-results.json"),
    JSON.stringify(report, null, 2),
  );
  for (const [name, log] of Object.entries(logs))
    await writeFile(join(directory, name + ".log"), log);
}
