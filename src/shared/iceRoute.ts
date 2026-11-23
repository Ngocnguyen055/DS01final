export type IceRoute = {
  mode: "DIRECT" | "TURN";
  localType: string;
  remoteType: string;
};
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

function classify(local: unknown, remote: unknown): IceRoute | undefined {
  const types = ["host", "srflx", "prflx", "relay"];
  if (
    typeof local !== "string" ||
    typeof remote !== "string" ||
    !types.includes(local) ||
    !types.includes(remote)
  )
    return;
  return {
    mode: local === "relay" || remote === "relay" ? "TURN" : "DIRECT",
    localType: local,
    remoteType: remote,
  };
}

async function selectedRoute(
  pc: RTCPeerConnection,
): Promise<IceRoute | undefined> {
  let native: IceRoute | undefined;
  try {
    const pair = pc.sctp?.transport.iceTransport.getSelectedCandidatePair?.();
    native = classify(pair?.local.type, pair?.remote.type);
  } catch {
    native = undefined;
  }
  if (native) return native;
  const rows: Record<string, unknown>[] = [];
  (await pc.getStats()).forEach((row) => rows.push(row));
  const selected = rows.find(
    (row) => row.type === "transport" && row.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  const pair =
    rows.find((row) => row.id === selected && row.type === "candidate-pair") ||
    rows.find(
      (row) =>
        row.type === "candidate-pair" &&
        row.state === "succeeded" &&
        row.nominated,
    );
  const local = rows.find(
    (row) =>
      row.id === pair?.localCandidateId && row.type === "local-candidate",
  );
  const remote = rows.find(
    (row) =>
      row.id === pair?.remoteCandidateId && row.type === "remote-candidate",
  );
  return classify(local?.candidateType, remote?.candidateType);
}

export function inspectIceRoute(
  pc: RTCPeerConnection,
  current: () => boolean,
  timeoutMs = 1500,
): Promise<IceRoute | undefined> {
  return new Promise((resolve) => {
    let finished = false,
      retry: ReturnType<typeof setTimeout> | undefined;
    const finish = (route?: IceRoute) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      resolve(route);
    };
    const deadline = setTimeout(() => finish(), timeoutMs);
    const inspect = async () => {
      if (finished) return;
      if (!current()) {
        finish();
        return;
      }
      let route: IceRoute | undefined;
      try {
        route = await selectedRoute(pc);
      } catch {
        route = undefined;
      }
      if (finished) return;
      if (!current()) {
        finish();
        return;
      }
      if (route) {
        finish(route);
        return;
      }
      retry = setTimeout(() => {
        void inspect();
      }, 50);
    };
    void inspect();
  });
}
