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
  directory = await mkdtemp(join(runtimeRoot, "browser-advanced-"));
const publicRelays = process.argv.includes("--public-relays");
const children = [],
  logs = {},
  report = {
    scope:
      "Local real Chrome, real UDP STUN/TURN, fake microphone/camera; not public WAN/NAT evidence",
    startedAt: new Date().toISOString(),
    checks: [],
  };
console.log(`Advanced browser evidence: ${directory}`);
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
let turn, ws, call;
const deadline = setTimeout(
  () => {
    for (const child of children) child.kill();
    console.error("Advanced browser deadline");
    process.exit(2);
  },
  publicRelays ? 300000 : 180000,
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
      `(async()=>{const {PeerClient}=await import('/@fs/'+${JSON.stringify(join(root, "src/shared/peer.ts").replaceAll("\\", "/"))});const {WebStore}=await import('/storage/store.ts');window.Peer=PeerClient;window.Store=WebStore;window.rtc=[];window.wire=[];window.events=[];const Native=RTCPeerConnection;window.RTC=class extends Native{constructor(...a){super(...a);window.rtc.push(this);this.addEventListener('icecandidateerror',e=>window.events.push({kind:'log',text:e.errorCode+':'+e.errorText}))}};const send=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(d){window.wire.push(JSON.parse(d));return send.call(this,d)};window.config={peerId:${JSON.stringify(id)},identityProof:'advanced-browser-'+${JSON.stringify(id)},displayName:${JSON.stringify(id)},signalUrl:${JSON.stringify(signalUrl)},relayUrl:${JSON.stringify(relayUrls[0])},relayUrls:[${JSON.stringify(relayUrls[1])}],rtc:RTC,store:new WebStore(${JSON.stringify(id)}),identityStore:new WebStore(${JSON.stringify(id)}),encryption:true,relaySelection:'latency-load',iceServers:[{urls:${JSON.stringify(`turn:127.0.0.1:${tp}?transport=udp`)},username:${JSON.stringify(username)},credential:${JSON.stringify(credential)}}],rtcPolicy:'relay',directTimeoutMs:8000,ackTimeoutMs:2000,onEvent:e=>{window.events.push(e);if(e.kind==='call')window.lastCall=e.call;}};window.peer=new PeerClient(config);await peer.connect();return true})()`,
    );
  }
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
  const before = await forwards();
  const started = performance.now();
  await evaluate(a, `peer.send('peer-b','TURN secret message')`);
  await until(
    async () =>
      (await rows(b, "peer-b")).some(
        (x) =>
          x.message.body === "TURN secret message" && x.status === "received",
      ),
    "TURN delivery",
  );
  const selected = await evaluate(
    a,
    `(async()=>{const result=[];for(const pc of rtc){const report=await pc.getStats();report.forEach(x=>result.push(x))}return result.filter(x=>x.type==='local-candidate'||x.type==='remote-candidate'||x.type==='candidate-pair')})()`,
  );
  report.turnCandidateStats = selected;
  report.peerEvents = await Promise.all(
    pages.map((s) => evaluate(s, `events.filter(x=>x.kind==='log')`)),
  );
  check(
    "real TURN DataChannel delivers E2EE chat without application relay forwarding",
    (await forwards()) === before &&
      (await rows(a, "peer-a")).some(
        (x) =>
          x.message.body === "TURN secret message" &&
          x.message.mode === "TURN" &&
          x.status === "delivered",
      ),
    { deliveryMs: performance.now() - started },
  );
  check(
    "wire packets contain ciphertext rather than chat content",
    await evaluate(
      a,
      `wire.length>0 && wire.every(x=>x.type==='sealed') && !JSON.stringify(wire).includes('TURN secret message')`,
    ),
  );
  check(
    "ICE statistics include an actual relay candidate",
    selected.some((x) => x.candidateType === "relay"),
  );
  await evaluate(a, `peer.media.start('peer-b','video')`);
  await until(
    () => evaluate(b, `lastCall?.phase==='incoming'`),
    "incoming video",
  );
  check(
    "incoming call does not capture media before acceptance",
    await evaluate(b, `!lastCall.local`),
  );
  await evaluate(b, "peer.media.accept()");
  await until(
    () =>
      evaluate(a, `lastCall?.phase==='connected' && lastCall.route==='TURN'`),
    "connected TURN video",
  );
  await until(
    () =>
      evaluate(
        b,
        `lastCall?.phase==='connected' && lastCall.remote?.getVideoTracks().length===1`,
      ),
    "remote video track",
  );
  await until(
    () =>
      evaluate(
        b,
        `(async()=>{const s=await peer.media.stats();let frames=0;s?.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='video')frames+=r.framesDecoded||0});return frames>0})()`,
      ),
    "decoded video frames",
  );
  report.mediaStats = await evaluate(
    b,
    `(async()=>{const rows=[];(await peer.media.stats()).forEach(x=>{if(['inbound-rtp','outbound-rtp'].includes(x.type))rows.push(x)});return rows})()`,
  );
  check(
    "real prototype video and audio RTP arrive through TURN",
    report.mediaStats.some((x) => x.kind === "video" && x.framesDecoded > 0) &&
      report.mediaStats.some(
        (x) => x.kind === "audio" && x.packetsReceived > 0,
      ),
  );
  for (const page of [a, b]) {
    await evaluate(
      page,
      `window.nativeAudio=new AudioContext();window.nativeAnalyser=nativeAudio.createAnalyser();nativeAudio.createMediaStreamSource(lastCall.remote).connect(nativeAnalyser);window.nativeSamples=new Float32Array(nativeAnalyser.fftSize);window.nativeOutput=new Audio();nativeOutput.srcObject=lastCall.remote;nativeOutput.play()`,
    );
    await until(
      () =>
        evaluate(
          page,
          `(async()=>{const rows=[];(await peer.media.stats()).forEach(x=>rows.push(x));nativeAnalyser.getFloatTimeDomainData(nativeSamples);return rows.some(x=>x.type==='inbound-rtp'&&x.kind==='video'&&x.framesDecoded>0)&&nativeSamples.some(x=>Math.abs(x)>0.001)})()`,
        ),
      "two-way WebRTC video and microphone energy",
    );
  }
  check(
    "both WebRTC peers receive decoded video and non-silent microphone audio",
    true,
  );
  await evaluate(a, `peer.media.mute('audio',true)`);
  check(
    "microphone mute changes live tracks",
    await evaluate(a, `lastCall.local.getAudioTracks().every(t=>!t.enabled)`),
  );
  await evaluate(a, `peer.media.end()`);
  await until(() => evaluate(b, `lastCall.phase==='ended'`), "remote hangup");
  for (const page of [a, b])
    await evaluate(
      page,
      `nativeOutput.pause();nativeOutput.srcObject=null;nativeAudio.close()`,
    );
  check(
    "hangup releases camera and microphone tracks",
    await evaluate(
      a,
      `lastCall.local.getTracks().every(t=>t.readyState==='ended')`,
    ),
  );
  for (const page of [a, b]) {
    await evaluate(
      page,
      `(async()=>{peer.close();window.peer=new Peer({...config,simulateMediaIceFailure:true});window.relayWire=[];for(const s of peer.relayPool.sockets.values())s.on('media:frame',x=>relayWire.push(x));await peer.connect();for(const s of peer.relayPool.sockets.values())s.on('media:frame',x=>relayWire.push(x));})()`,
    );
  }
  const mediaBefore = (await (await fetch(relayUrls[0] + "/health")).json())
    .metrics.mediaFrames;
  await evaluate(a, `peer.media.start('peer-b','video')`);
  await until(
    () => evaluate(b, `lastCall?.phase==='incoming'`),
    "blocked ICE incoming video",
  );
  await evaluate(b, "peer.media.accept()");
  await Promise.all(
    [a, b].map((page) =>
      until(
        () =>
          evaluate(
            page,
            `lastCall?.phase==='connected'&&lastCall.route==='RELAY'&&!!lastCall.remoteFrame`,
          ),
        "encrypted relay video in both directions",
      ),
    ),
  );
  for (const page of [a, b]) {
    await evaluate(
      page,
      `window.remoteAudio=new AudioContext();window.remoteAnalyser=remoteAudio.createAnalyser();remoteAudio.createMediaStreamSource(lastCall.remote).connect(remoteAnalyser);window.remoteSamples=new Float32Array(remoteAnalyser.fftSize)`,
    );
    await until(
      () =>
        evaluate(
          page,
          `remoteAnalyser.getFloatTimeDomainData(remoteSamples);remoteSamples.some(x=>Math.abs(x)>0.001)`,
        ),
      "relay microphone signal in remote audio stream",
    );
  }
  check(
    "blocked ICE falls back to encrypted application relay with two-way video and audible audio samples",
    true,
  );
  check(
    "relay frames carry authenticated ciphertext and separate media counters",
    (await evaluate(
      b,
      `relayWire.length>0&&relayWire.every(x=>!!x.ciphertext&&!x.data&&!x.sdp)`,
    )) &&
      (await (await fetch(relayUrls[0] + "/health")).json()).metrics
        .mediaFrames > mediaBefore,
  );
  for (const page of [a, b]) await evaluate(page, `remoteAudio.close()`);
  await evaluate(
    a,
    `peer.media.mute('audio',true);peer.media.mute('video',true)`,
  );
  check(
    "relay mute disables the actual capture tracks",
    await evaluate(a, `lastCall.local.getTracks().every(t=>!t.enabled)`),
  );
  await evaluate(a, `peer.media.end()`);
  await until(
    () => evaluate(b, `lastCall.phase==='ended'`),
    "relay video hangup",
  );
  check(
    "relay hangup releases both peers capture devices",
    (
      await Promise.all(
        [a, b].map((page) =>
          evaluate(
            page,
            `lastCall.local.getTracks().every(t=>t.readyState==='ended')`,
          ),
        ),
      )
    ).every(Boolean),
  );
  await evaluate(b, `peer.media.start('peer-a','audio')`);
  await until(
    () => evaluate(a, `lastCall?.phase==='incoming'`),
    "reverse relay audio call",
  );
  await evaluate(a, `peer.media.accept()`);
  await Promise.all(
    [a, b].map((page) =>
      until(
        () =>
          evaluate(
            page,
            `lastCall?.phase==='connected'&&lastCall.route==='RELAY'&&lastCall.kind==='audio'`,
          ),
        "reverse relay audio connected",
      ),
    ),
  );
  check("audio-only call also falls back after NAT blocks WebRTC", true);
  await evaluate(b, `peer.media.end()`);
  await until(
    () => evaluate(a, `lastCall.phase==='ended'`),
    "reverse relay hangup",
  );
  if (publicRelays) {
    report.passed = true;
  } else {
    const stun = await evaluate(
      c,
      `(async()=>{const p=new RTC({iceServers:[{urls:${JSON.stringify(`stun:127.0.0.1:${tp}`)}}]});p.createDataChannel('stun-probe');const candidates=[];p.onicecandidate=e=>{if(e.candidate)candidates.push(e.candidate.toJSON())};await p.setLocalDescription(await p.createOffer());await new Promise(r=>{if(p.iceGatheringState==='complete')r();else{const timer=setTimeout(r,4000);p.onicegatheringstatechange=()=>{if(p.iceGatheringState==='complete'){clearTimeout(timer);r()}}}});p.close();return candidates})()`,
    );
    report.stunCandidates = stun;
    report.stunBindingRequests = logs.turn.split("STUN_BINDING").length - 1;
    report.turnAllocationRequests = logs.turn.split("TURN_ALLOCATE").length - 1;
    check(
      "STUN server handles actual binding requests during ICE gathering",
      stun.length > 0 && report.stunBindingRequests > 0,
    );
    for (const [index, page] of pages.entries())
      await evaluate(
        page,
        `peer.forceRelay=true;peer.disconnectDirect(${JSON.stringify(index === 0 ? "peer-b" : "peer-a")})`,
      );
    await evaluate(b, "peer.close()");
    await until(
      async () =>
        !(await (await fetch(relayUrls[0] + "/health")).json()).peers ||
        (await (await fetch(relayUrls[0] + "/health")).json()).peers === 2,
      "offline B",
    );
    await evaluate(a, `peer.send('peer-b','durable browser secret')`);
    check(
      "offline send reports queued rather than delivered",
      (await rows(a, "peer-a")).some(
        (x) =>
          x.message.body === "durable browser secret" && x.status === "queued",
      ),
    );
    await until(
      async () =>
        (await (await fetch(relayUrls[1] + "/health")).json()).pending > 0,
      "replica mailbox",
    );
    const switchStart = performance.now();
    primary.kill();
    await until(async () => {
      try {
        return !(
          await fetch(relayUrls[0] + "/health", {
            signal: AbortSignal.timeout(2000),
          })
        ).ok;
      } catch {
        return true;
      }
    }, "relay failure");
    await evaluate(
      b,
      `(async()=>{window.peer=new Peer(config);await peer.connect()})()`,
    );
    await until(
      async () =>
        (await rows(b, "peer-b")).some(
          (x) =>
            x.message.body === "durable browser secret" &&
            x.status === "received",
        ),
      "mailbox recovery",
    );
    await until(
      async () =>
        (await rows(a, "peer-a")).some(
          (x) =>
            x.message.body === "durable browser secret" &&
            x.status === "delivered",
        ),
      "delayed ACK",
    );
    check(
      "replicated mailbox survives primary failure in real browsers",
      true,
      { recoveryMs: performance.now() - switchStart },
    );
    const identity = await evaluate(a, "peer.secure.publicIdentity()");
    await evaluate(a, "peer.close(); window.deviceIdentity=null");
    await call("Page.reload", {}, a);
    await until(
      () => evaluate(a, 'document.readyState === "complete"'),
      "reload",
    );
    const restored = await evaluate(
      a,
      `(async()=>{const {WebStore}=await import('/storage/store.ts');return (await new WebStore('peer-a').getIdentity()).public})()`,
    );
    check(
      "nonextractable device identity persists across browser reload",
      JSON.stringify(restored) === JSON.stringify(identity),
    );
    signaling.kill();
    const dhtIds = [];
    for (const page of [b, c]) {
      dhtIds.push(
        await evaluate(
          page,
          `(async()=>{peer.close();const secure=await import('/@fs/'+${JSON.stringify(root.replaceAll("\\", "/") + "/src/shared/secure.ts")});const overlay=await import('/@fs/'+${JSON.stringify(root.replaceAll("\\", "/") + "/src/shared/overlayProtocol.ts")});const store=new Store('dht-device');let identity=await store.getIdentity();if(!identity){identity=await secure.createIdentity();await store.putIdentity(identity)}window.dhtId=await overlay.decentralizedPeerId(identity);window.dhtConfig={...config,peerId:dhtId,signalUrl:'http://127.0.0.1:1',relayUrl:${JSON.stringify(relayUrls[1])},relayUrls:[],store,identityStore:store,discovery:'dht',forceRelay:false};window.peer=new Peer(dhtConfig);await peer.connect();return dhtId})()`,
        ),
      );
    }
    await evaluate(
      b,
      `peer.send(${JSON.stringify(dhtIds[1])},'DHT real TURN secret')`,
    );
    await until(
      () =>
        evaluate(
          c,
          `(async()=>{return (await new Store('dht-device').list()).some(x=>x.message.body==='DHT real TURN secret'&&x.status==='received')})()`,
        ),
      "DHT encrypted delivery",
    );
    check(
      "DHT uses real WebRTC TURN with signaling process stopped",
      await evaluate(
        b,
        `(async()=>{return (await new Store('dht-device').list()).some(x=>x.message.body==='DHT real TURN secret'&&x.message.mode==='TURN'&&x.status==='delivered')})()`,
      ),
    );
    await evaluate(c, "peer.close()");
    await call("Page.reload", {}, c);
    await until(
      () => evaluate(c, '!!document.querySelector(".demo-toggle")'),
      "DHT UI login",
    );
    await evaluate(c, 'document.querySelector(".demo-toggle").click()');
    await pause(100);
    await evaluate(
      c,
      `(()=>{const e=document.querySelector('input[autocomplete=nickname]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'DHT Browser UI');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await pause(100);
    await evaluate(
      c,
      `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('DHT')).click()`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.self-profile small')?.textContent.startsWith('p_') && !!document.querySelector('.connection-pill.is-online')`,
        ),
      "DHT UI connected without signaling",
    );
    report.uiDhtPeerId = await evaluate(
      c,
      `document.querySelector('.self-profile small').textContent`,
    );
    check(
      "DHT entry in the actual application derives Peer ID and joins without a signaling server",
      true,
    );
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
      c,
    );
    await evaluate(c, `document.querySelector('.diagnostics-link').click()`);
    await pause(100);
    check(
      "application diagnostics show E2EE and decentralized discovery",
      await evaluate(
        c,
        `document.querySelector('.advanced-panel').textContent.includes('E2EE') && document.querySelector('.advanced-panel').textContent.includes('DHT')`,
      ),
    );
    const screenshot = await call(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      c,
    );
    await writeFile(
      join(directory, "advanced-ui.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    await call("Page.reload", {}, c);
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.self-profile small')?.textContent===${JSON.stringify(report.uiDhtPeerId)} && !!document.querySelector('.connection-pill.is-online')`,
        ),
      "DHT UI reload",
    );
    check("DHT UI reload restores the same device identity", true);
    await until(
      () =>
        evaluate(
          b,
          `(async()=>{return (await peer.lookupPeer(${JSON.stringify(report.uiDhtPeerId)})).online})()`,
        ),
      "DHT application reachable",
    );
    await evaluate(
      b,
      `peer.media.start(${JSON.stringify(report.uiDhtPeerId)},'video')`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='incoming'`,
        ),
      "video call in actual application",
    );
    await call(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      c,
    );
    check(
      "incoming call controls stay visible on the mobile conversation list",
      await evaluate(
        c,
        `(()=>{const p=document.querySelector('.call-panel'),r=p.getBoundingClientRect();return p.getClientRects().length>0&&r.left>=0&&r.right<=innerWidth&&!!p.querySelector('.primary-button')})()`,
      ),
    );
    let frame = await call(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      c,
    );
    await writeFile(
      join(directory, "ui-call-incoming-mobile.png"),
      Buffer.from(frame.data, "base64"),
    );
    await evaluate(
      c,
      `document.querySelector('.call-panel .primary-button').click()`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='connected' && document.querySelector('.call-panel .remote-video').videoWidth>0`,
        ),
      "application video playback",
    );
    check(
      "application accepts a real TURN video call and renders the remote stream",
      await evaluate(
        c,
        `document.querySelector('.call-panel [role=status]').textContent.includes('TURN') && !!document.querySelector('.call-panel .local-video').srcObject`,
      ),
    );
    frame = await call(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      c,
    );
    await writeFile(
      join(directory, "ui-call-connected-mobile.png"),
      Buffer.from(frame.data, "base64"),
    );
    await evaluate(
      c,
      `[...document.querySelectorAll('.call-actions button')].find(x=>x.textContent.includes('Tắt mic')).click()`,
    );
    check(
      "application mute control updates its state and disables the microphone track",
      await evaluate(
        c,
        `!!document.querySelector('.call-actions button[aria-pressed=true]') && document.querySelector('.call-panel .local-video').srcObject.getAudioTracks().every(t=>!t.enabled)`,
      ),
    );
    await evaluate(c, `document.querySelector('.call-panel .danger').click()`);
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='ended'`,
        ),
      "application hangup",
    );
    await until(
      () => evaluate(b, `lastCall?.phase==='ended'`),
      "remote application hangup",
    );
    await evaluate(
      c,
      `document.querySelector('.call-panel .secondary-button').click()`,
    );
    check(
      "application hangup reaches the remote peer and dismisses the call panel",
      await evaluate(c, `!document.querySelector('.call-panel')`),
    );
    await evaluate(
      b,
      `(async()=>{peer.close();window.peer=new Peer(dhtConfig);await peer.connect()})()`,
    );
    await evaluate(c, `document.querySelector('.diagnostics-link').click()`);
    await until(
      () =>
        evaluate(
          c,
          `!!document.querySelector('input[aria-label="Kiểm tra cuộc gọi qua relay"]')`,
        ),
      "relay call simulation control",
    );
    await evaluate(
      c,
      `document.querySelector('input[aria-label="Kiểm tra cuộc gọi qua relay"]').click()`,
    );
    check(
      "application enables blocked call ICE without rebuilding or changing chat connectivity",
      await evaluate(
        c,
        `document.querySelector('input[aria-label="Kiểm tra cuộc gọi qua relay"]').checked && document.querySelector('.connection-pill.is-online')!==null`,
      ),
    );
    await evaluate(
      c,
      `document.querySelector('button[aria-label="Đóng chẩn đoán"]').click()`,
    );
    await evaluate(
      c,
      `window.playMedia=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){return this.tagName==='AUDIO'?Promise.reject(new DOMException('Playback requires a tap','NotAllowedError')):playMedia.call(this)}`,
    );
    await evaluate(
      b,
      `peer.media.start(${JSON.stringify(report.uiDhtPeerId)},'video')`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='incoming'`,
        ),
      "blocked ICE video call in application",
    );
    await evaluate(
      c,
      `document.querySelector('.call-actions .primary-button').click()`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='connected'&&document.querySelector('.relay-video')?.naturalWidth>0`,
        ),
      "application relay video renders",
    );
    check(
      "mobile application renders remote relay video when WebRTC is blocked",
      await evaluate(
        c,
        `document.querySelector('.call-panel [role=status]').textContent.includes('RELAY')&&document.querySelector('.call-panel audio').srcObject.getAudioTracks().length===1`,
      ),
    );
    check(
      "blocked autoplay offers an explicit audio playback control",
      await evaluate(
        c,
        `[...document.querySelectorAll('.call-panel button')].some(x=>x.textContent==='Bật âm thanh cuộc gọi')`,
      ),
    );
    await evaluate(
      c,
      `HTMLMediaElement.prototype.play=playMedia;[...document.querySelectorAll('.call-panel button')].find(x=>x.textContent==='Bật âm thanh cuộc gọi').click()`,
    );
    await until(
      () =>
        evaluate(
          c,
          `!document.querySelector('.call-panel audio').paused&&!([...document.querySelectorAll('.call-panel button')].some(x=>x.textContent==='Bật âm thanh cuộc gọi'))`,
        ),
      "audio playback resumes after user action",
    );
    check("audio playback resumes after the user taps the audio control", true);
    frame = await call(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      c,
    );
    await writeFile(
      join(directory, "ui-call-relay-mobile.png"),
      Buffer.from(frame.data, "base64"),
    );
    await evaluate(c, `document.querySelector('.call-panel .danger').click()`);
    await until(
      () => evaluate(b, `lastCall?.phase==='ended'`),
      "application relay hangup",
    );
    await evaluate(
      b,
      `peer.media.start(${JSON.stringify(report.uiDhtPeerId)},'audio')`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='incoming'`,
        ),
      "simulated blocked audio in application",
    );
    await evaluate(
      c,
      `document.querySelector('.call-actions .primary-button').click()`,
    );
    await until(
      () =>
        evaluate(
          c,
          `document.querySelector('.call-panel')?.dataset.phase==='connected'&&document.querySelector('.call-panel [role=status]').textContent.includes('RELAY')`,
        ),
      "application audio switches to relay",
    );
    await until(
      () =>
        evaluate(
          b,
          `lastCall?.phase==='connected'&&lastCall.route==='RELAY'&&lastCall.kind==='audio'`,
        ),
      "reverse relay audio confirmed",
    );
    check(
      "the same application checkbox makes audio calls fall back with both peers confirmed on RELAY",
      true,
    );
    await evaluate(c, `document.querySelector('.call-panel .danger').click()`);
    await until(
      () => evaluate(b, `lastCall?.phase==='ended'`),
      "simulated audio hangup",
    );
    await evaluate(c, `document.querySelector('.diagnostics-link').click()`);
    await evaluate(
      c,
      `document.querySelector('input[aria-label="Kiểm tra cuộc gọi qua relay"]').click()`,
    );
    check(
      "application disables call simulation and records the injected fault in peer logs",
      await evaluate(
        c,
        `!document.querySelector('input[aria-label="Kiểm tra cuộc gọi qua relay"]').checked&&document.querySelector('.log-console').textContent.includes('CALL_ICE_BLOCKED')`,
      ),
    );
    await evaluate(
      c,
      `document.querySelector('button[aria-label="Đóng chẩn đoán"]').click()`,
    );
    report.privateCallHistory = await evaluate(
      c,
      `JSON.parse(localStorage.getItem('ds01-history-v1-'+${JSON.stringify(report.uiDhtPeerId)}+'-calls')||'[]')`,
    );
    check(
      "private call history persists direction, route and end time for both native and relay calls",
      report.privateCallHistory.length >= 2 &&
        report.privateCallHistory.some(
          (record) => record.route === "TURN" && record.endedAt,
        ) &&
        report.privateCallHistory.some(
          (record) => record.route === "RELAY" && record.endedAt,
        ) &&
        report.privateCallHistory.every(
          (record) => record.direction === "incoming",
        ),
    );
    report.passed = true;
  }
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(error);
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
    join(directory, "advanced-results.json"),
    JSON.stringify(report, null, 2),
  );
  for (const [name, log] of Object.entries(logs))
    await writeFile(join(directory, `${name}.log`), log);
}
