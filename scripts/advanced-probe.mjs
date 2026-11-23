import { randomUUID } from "node:crypto";
import { connectProbe } from "./connect-probe.mjs";

const [signalUrl, primaryUrl, backupUrl] = process.argv.slice(2);
if (!signalUrl || !primaryUrl || !backupUrl)
  throw Error("Usage: node scripts/advanced-probe.mjs SIGNAL PRIMARY BACKUP");
const sockets = [];
const connect = (url, auth) =>
  connectProbe(url, auth, (socket) => sockets.push(socket));
try {
  const candidates = [];
  for (const [id, url] of [
    ["super-check-primary", primaryUrl],
    ["super-check-backup", backupUrl],
  ]) {
    const signal = await connect(signalUrl);
    const registration = await signal
      .timeout(8000)
      .emitWithAck("peer:register", {
        peerId: id,
        displayName: "Public candidate probe",
        identityProof: randomUUID() + randomUUID(),
      });
    if (!registration.ok) throw Error(registration.error);
    const socket = await connect(url, { token: registration.token });
    candidates.push({ id, url, socket });
  }
  const denied = await candidates[0].socket
    .timeout(8000)
    .emitWithAck("superpeer:offer", { url: backupUrl });
  if (denied.ok) throw Error("super-peer owner impersonation was accepted");
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const result = await candidate.socket
        .timeout(8000)
        .emitWithAck("superpeer:offer", { url: candidate.url });
      if (!result.ok) throw Error(result.error);
      return result;
    }),
  );
  const expected = candidates
      .map((x) => x.id)
      .sort()
      .at(-1),
    deadline = Date.now() + 10000;
  let leaders;
  do {
    leaders = await Promise.all(
      candidates.map(
        async (x) =>
          (await x.socket.timeout(8000).emitWithAck("relay:probe", null))
            .leader,
      ),
    );
    if (leaders.every((x) => x?.peerId === expected)) break;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  if (!leaders.every((x) => x?.peerId === expected))
    throw Error("public candidate election did not converge");
  console.log(
    JSON.stringify(
      {
        scope:
          "Public HTTPS relay candidate probe, owner binding and leased election convergence; not NAT or public TURN evidence",
        passed: true,
        candidates: results.length,
        rejectedOwnerImpersonation: true,
        leaders,
      },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.disconnect();
}
