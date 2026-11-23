import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connectProbe } from "./connect-probe.mjs";
loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
const [mode = "help", ...args] = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(key);
  return index < 0 ? fallback : args[index + 1];
};
const signalUrl = option(
  "--signal",
  process.env.PUBLIC_SIGNAL_URL || "http://localhost:4001",
);
const relayUrl = option(
  "--relay",
  process.env.PUBLIC_RELAY_URL || "http://localhost:4002",
);
const sockets = [];
const heartbeats = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const suffix = randomUUID().slice(0, 8);
let failures = 0;
let checks = 0;
const line = (label, data = "") =>
  console.log(`${new Date().toISOString()} ${label}`, data);
function check(label, condition, data = "") {
  checks++;
  line(`${condition ? "PASS" : "FAIL"} ${label}`, data);
  if (!condition) failures++;
}
async function waitFor(predicate, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return false;
}
async function connect(url, auth) {
  return connectProbe(url, auth, (socket) => sockets.push(socket));
}
const call = (socket, event, ...payload) =>
  socket.timeout(4000).emitWithAck(event, ...payload);
async function register(
  id,
  proof = randomUUID() + randomUUID(),
  heartbeat = true,
) {
  const signal = await connect(signalUrl);
  const registration = await call(signal, "peer:register", {
    peerId: id,
    identityProof: proof,
  });
  if (!registration.ok)
    throw new Error(`Registration ${id}: ${registration.error}`);
  if (heartbeat)
    heartbeats.push(setInterval(() => signal.emit("peer:heartbeat"), 10000));
  return { id, signal, token: registration.token, proof };
}
async function relay(peer) {
  return connect(relayUrl, { token: peer.token });
}
async function peers(count = 3) {
  const result = [];
  for (let index = 0; index < count; index++)
    result.push(await register(`qa-${index}-${suffix}`));
  return result;
}
function packet(senderId, receiverId, extra = {}) {
  return {
    messageId: randomUUID(),
    sessionId: randomUUID(),
    senderId,
    receiverId,
    type: "text",
    timestamp: Date.now(),
    body: `qa-message-${suffix}`,
    mode: "RELAY",
    ackRequested: true,
    attempt: 1,
    sequence: 1,
    ...extra,
  };
}
async function healthy(url) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(url).hostname,
  );
  for (let attempt = 0; attempt < (local ? 1 : 2); attempt++) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(local ? 2000 : 4000),
      });
      if (
        response.ok &&
        ["signaling", "relay"].includes((await response.json()).service)
      )
        return true;
    } catch {}
    if (!local && attempt === 0) await sleep(250);
  }
  return false;
}
function requireLocal() {
  for (const url of [signalUrl, relayUrl]) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error(
        "Crash probes are limited to localhost. Use a disposable local lab.",
      );
    }
  }
}
const modes = {
  async discovery() {
    const [a, b, c] = await peers();
    const list = await call(a.signal, "peer:list");
    check(
      "three unique IDs visible",
      list.ok && [a, b, c].every((peer) => list.peers.includes(peer.id)),
    );
    const found = await call(a.signal, "peer:lookup", { peerId: b.id });
    check(
      "online lookup returns connectivity",
      found.ok &&
        found.peer.online &&
        found.peer.connection?.transport === "webrtc-datachannel",
    );
    line("lookup result (no token)", found.peer);
    const duplicate = await connect(signalUrl);
    const sameId = await call(duplicate, "peer:register", {
      peerId: a.id,
      identityProof: a.proof,
    });
    check(
      "same ID and same secret cannot have two active sessions",
      sameId.ok === false,
    );
    const otherSecret = await call(duplicate, "peer:register", {
      peerId: a.id,
      identityProof: randomUUID() + randomUUID(),
    });
    check("same ID with another secret rejected", otherSecret.ok === false);
    c.signal.disconnect();
    await waitFor(
      async () =>
        (await call(a.signal, "peer:lookup", { peerId: c.id })).peer?.online ===
        false,
    );
    const offline = await call(a.signal, "peer:lookup", { peerId: c.id });
    check(
      "disconnected peer becomes offline",
      offline.ok && offline.peer.online === false,
    );
    const anonymous = await connect(signalUrl);
    const rejected = await call(anonymous, "peer:list");
    check("anonymous discovery rejected", rejected.ok === false);
  },
  async validation() {
    const [a, b, c] = await peers();
    const ar = await relay(a),
      br = await relay(b),
      cr = await relay(c);
    const receivedB = [],
      receivedC = [];
    br.on("relay:receive", (msg) => receivedB.push(msg));
    cr.on("relay:receive", (msg) => receivedC.push(msg));
    const valid = packet(a.id, b.id);
    const forwarded = await call(ar, "relay:send", valid);
    await waitFor(() => receivedB.length === 1);
    check(
      "valid envelope forwarded unchanged to correct peer",
      forwarded.ok &&
        receivedB[0]?.messageId === valid.messageId &&
        receivedB[0]?.body === valid.body,
    );
    await sleep(100);
    check("unrelated peer receives no message", receivedC.length === 0);
    const invalid = [
      ["spoofed sender", { senderId: c.id }],
      ["body over 4000 characters", { body: "x".repeat(5000) }],
      ["invalid UUID", { messageId: "not-a-uuid" }],
      ["invalid Peer ID", { receiverId: "../invalid" }],
      ["empty text", { body: "   " }],
      ["ACK without ackFor", { type: "ack", body: "", ackRequested: false }],
      ["DIRECT packet sent to relay", { mode: "DIRECT" }],
    ];
    for (const [label, extra] of invalid) {
      const response = await call(ar, "relay:send", {
        ...packet(a.id, b.id),
        ...extra,
      });
      check(`${label} rejected`, response.ok === false, response.error || "");
    }
    const created = await call(a.signal, "group:create", { members: [b.id] });
    if (!created.ok) throw new Error("Could not create test group");
    const outsider = await call(
      cr,
      "relay:send",
      packet(c.id, b.id, {
        groupId: created.group.id,
        sessionId: created.group.id,
      }),
    );
    check("group outsider rejected", outsider.ok === false);
    let invalidTokenAccepted = false;
    try {
      await connect(relayUrl, { token: "invalid-test-token" });
      invalidTokenAccepted = true;
    } catch {}
    check("invalid relay token rejected", !invalidTokenAccepted);
    const invalidRegistration = await connect(signalUrl);
    const badId = await call(invalidRegistration, "peer:register", {
      peerId: "../bad",
      identityProof: randomUUID(),
    });
    const shortSecret = await call(invalidRegistration, "peer:register", {
      peerId: `qa-short-${suffix}`,
      identityProof: "short",
    });
    check("invalid registration ID rejected", badId.ok === false);
    check("short demo secret rejected", shortSecret.ok === false);
    for (const input of [
      null,
      {},
      { peerId: "../bad" },
      { peerId: b.id, extra: true },
    ]) {
      check(
        "malformed lookup rejected",
        (await call(a.signal, "peer:lookup", input)).ok === false,
      );
    }
    check("invalid packets did not reach receiver", receivedB.length === 1);
    check(
      "services remain healthy",
      (await healthy(signalUrl)) && (await healthy(relayUrl)),
    );
  },
  async conflict() {
    const [a, b, c] = await peers();
    const updates = new Map();
    for (const peer of [a, b, c])
      peer.signal.on("group:update", (group) => updates.set(peer.id, group));
    const created = await call(a.signal, "group:create", {
      members: [b.id, c.id],
    });
    if (!created.ok) throw new Error("Could not create test group");
    const groupId = created.group.id;
    const responses = await Promise.all([
      call(a.signal, "group:change", {
        groupId,
        memberId: c.id,
        action: "remove",
        version: 1,
      }),
      call(b.signal, "group:change", {
        groupId,
        memberId: b.id,
        action: "remove",
        version: 1,
      }),
    ]);
    check(
      "exactly one concurrent edit accepted",
      responses.filter((response) => response.ok).length === 1,
    );
    const current = await call(a.signal, "group:authorize", {
      groupId,
      otherPeerId: a.id,
    });
    check("version increments once", current.ok && current.group.version === 2);
    await waitFor(
      () =>
        [...updates.values()].filter(
          (group) => group.id === groupId && group.version === 2,
        ).length === 3,
    );
    check(
      "same final membership published to all three peers, including removed peer",
      [a, b, c].every(
        (peer) =>
          JSON.stringify(updates.get(peer.id)?.members) ===
          JSON.stringify(current.group?.members),
      ),
    );
    line("winner and final state", {
      accepted: responses.map((response) => response.ok),
      group: current.group,
    });
  },
  async duplicate() {
    const receiverId = option("--to", "peer-b");
    const a = await register(`qa-replay-${suffix}`);
    const found = await call(a.signal, "peer:lookup", { peerId: receiverId });
    if (!found.ok || !found.peer.online)
      throw new Error(`Open and register ${receiverId} in the actual UI first`);
    const ar = await relay(a);
    const msg = packet(a.id, receiverId, { body: `DUPLICATE-CHECK-${suffix}` });
    let acknowledgements = 0;
    ar.on("relay:receive", (ack) => {
      if (
        ack.type === "ack" &&
        ack.ackFor === msg.messageId &&
        ack.senderId === receiverId
      )
        acknowledgements++;
    });
    for (const attempt of [1, 2]) {
      check(
        `relay accepts duplicate test attempt ${attempt}`,
        (await call(ar, "relay:send", { ...msg, attempt })).ok === true,
      );
      await sleep(250);
    }
    await waitFor(() => acknowledgements >= 2, 5000);
    check("receiver ACKs original and duplicate", acknowledgements >= 2, {
      acknowledgements,
    });
    line(
      "MANUAL CHECK REQUIRED: receiver history must contain exactly ONE row for this Message ID",
      { senderId: a.id, receiverId, messageId: msg.messageId, body: msg.body },
    );
  },
  async blackhole() {
    const a = await register("qa-noack", "qa-noack-lab-secret-not-production");
    const ar = await relay(a);
    line(
      "READY: select qa-noack in peer UI, force RELAY, send a message. This recipient intentionally sends no application ACK. Hold for 60 seconds.",
    );
    ar.on("relay:receive", (msg) =>
      line("received without ACK", {
        messageId: msg.messageId,
        attempt: msg.attempt,
        type: msg.type,
      }),
    );
    await sleep(60000);
  },
  async lease() {
    const observer = await register(`qa-observer-${suffix}`);
    const ghost = await register(
      `qa-silent-${suffix}`,
      randomUUID() + randomUUID(),
      false,
    );
    const started = Date.now();
    line(
      "READY: Socket.IO stays connected, but no peer:heartbeat is sent. Wait up to 40 seconds.",
      { peerId: ghost.id },
    );
    const disconnected = await waitFor(() => !ghost.signal.connected, 40000);
    const elapsedMs = Date.now() - started;
    const found = await call(observer.signal, "peer:lookup", {
      peerId: ghost.id,
    });
    check(
      "heartbeat lease expires and peer becomes offline",
      disconnected && found.ok && !found.peer.online,
      { elapsedMs },
    );
    line("Compare signaling TIMEOUT log and the peer lists in browser UIs.");
  },
  async "identity-owner"() {
    const a = await register(
      "qa-identity-check",
      "qa-original-test-secret-not-production",
    );
    check("original owner registered", !!a.token);
    line(
      "Next: identity-other before restart must reject; repeat identity-other after signaling restart to test persistent ownership.",
    );
  },
  async "identity-other"() {
    const signal = await connect(signalUrl);
    const response = await call(signal, "peer:register", {
      peerId: "qa-identity-check",
      identityProof: "qa-different-test-secret-not-production",
    });
    check(
      "another secret cannot claim the reserved identity",
      response.ok === false,
      { accepted: response.ok, error: response.error },
    );
    line(
      "Use identity-owner first. A fresh service with no prior owner cannot establish this test precondition.",
    );
  },
  async "crash-signal"() {
    requireLocal();
    line(
      "Sending one malformed callback to your local lab signaling. This can stop the current unfixed service.",
    );
    const signal = await connect(signalUrl);
    signal.emit("group:create", { members: [] }, "not-a-function");
    await sleep(1000);
    check("signaling survives malformed callback", await healthy(signalUrl));
  },
  async "crash-relay"() {
    requireLocal();
    line(
      "Sending one malformed callback to your local lab relay. This can stop the current unfixed service.",
    );
    const a = await register(`qa-callback-${suffix}`),
      ar = await relay(a);
    ar.emit(
      "relay:send",
      packet(a.id, `qa-offline-${suffix}`),
      "not-a-function",
    );
    await sleep(1000);
    check("relay survives malformed callback", await healthy(relayUrl));
  },
};
if (mode === "help" || mode === "--help") {
  console.log(
    "node scripts/manual-probe.mjs <case> [--signal URL] [--relay URL] [--to peer-b]",
  );
  console.log(`Cases: ${Object.keys(modes).join(", ")}`);
  console.log(
    "Run the application servers separately. blackhole holds for 60s; lease for up to 40s.",
  );
  console.log(
    "crash-* deliberately sends malformed input to localhost only; run last in a disposable lab.",
  );
  console.log(
    "No tokens or peer secrets are printed. Compare Message IDs, peer delivery status and service logs; see README.md.",
  );
} else if (!modes[mode]) {
  console.error("Unknown case. Use --help.");
  process.exitCode = 2;
} else {
  const deadline = setTimeout(
    () => {
      console.error("Probe deadline exceeded");
      process.exit(2);
    },
    mode === "blackhole" ? 75000 : mode === "lease" ? 55000 : 40000,
  );
  try {
    line("CASE", mode);
    await modes[mode]();
    line(
      "RESULT",
      failures
        ? `${failures} check(s) FAILED`
        : checks
          ? "Script checks passed; complete any MANUAL CHECK REQUIRED steps."
          : "No automatic verdict; complete the manual steps.",
    );
    process.exitCode = failures ? 1 : 0;
  } catch (error) {
    console.error(
      "ERROR:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 2;
  } finally {
    clearTimeout(deadline);
    heartbeats.forEach(clearInterval);
    sockets.forEach((socket) => socket.disconnect());
  }
}
