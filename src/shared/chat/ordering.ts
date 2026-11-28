import type { StoredMessage } from "../peerTypes.ts";

export function orderMessages(rows: StoredMessage[]): StoredMessage[] {
  const chains = new Map<string, StoredMessage[]>();
  for (const row of rows) {
    const m = row.message;
    const conversation =
      m.groupId || [m.senderId, m.receiverId].sort().join(":");
    const key = `${conversation}:${m.senderId}:${m.sessionId}`;
    const chain = chains.get(key) || [];
    chain.push(row);
    chains.set(key, chain);
  }
  const tie = (a: StoredMessage, b: StoredMessage) =>
    (a.message.logicalTime ?? a.message.timestamp) -
      (b.message.logicalTime ?? b.message.timestamp) ||
    a.message.messageId.localeCompare(b.message.messageId) ||
    a.message.receiverId.localeCompare(b.message.receiverId);
  const cursors = [...chains.values()].map((chain) => ({
    rows: chain.sort(
      (a, b) => a.message.sequence - b.message.sequence || tie(a, b),
    ),
    index: 0,
  }));
  const output: StoredMessage[] = [];
  while (cursors.length) {
    cursors.sort((a, b) => tie(a.rows[a.index], b.rows[b.index]));
    const cursor = cursors[0];
    output.push(cursor.rows[cursor.index++]);
    if (cursor.index === cursor.rows.length) cursors.shift();
  }
  return output;
}
