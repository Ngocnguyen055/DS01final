import { ACCOUNT_PEER_ID } from "./directChatAuthorization.ts";
import type { SignalingContext } from "./types.ts";
import { expirePeers } from "./presence.ts";

export function startSignalingMaintenance(context: SignalingContext) {
  const presenceTimer = setInterval(() => expirePeers(context), 5000);
  presenceTimer.unref();
  let synchronizing = false;
  const projectTimer = setInterval(async () => {
    if (synchronizing) return;
    synchronizing = true;
    try {
      const accountIds = [...context.peers.keys()].filter((peerId) =>
        ACCOUNT_PEER_ID.test(peerId),
      );
      for (const peerId of accountIds)
        for (const group of await context.directory.forPeer(peerId))
          context.publishGroup(group);
      for (const group of [...context.groups.values()].filter(
        (item) => item.projectId,
      )) {
        const latest = await context.directory.group(group.id);
        if (latest) context.publishGroup(latest);
      }
    } catch {
    } finally {
      synchronizing = false;
    }
  }, 2000);
  projectTimer.unref();
  return () => {
    clearInterval(presenceTimer);
    clearInterval(projectTimer);
  };
}
