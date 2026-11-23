import type { ChatMessage } from "./protocol.ts";

export function isDirectMessageBetween(
  message: ChatMessage,
  currentPeerId: string,
  otherPeerId: string,
): boolean {
  return (
    (message.type === "text" || message.type === "attachment") &&
    message.groupId == null &&
    ((message.senderId === currentPeerId &&
      message.receiverId === otherPeerId) ||
      (message.senderId === otherPeerId &&
        message.receiverId === currentPeerId))
  );
}
