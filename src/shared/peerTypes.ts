import type {
  ChatAttachment,
  ChatMessage,
  DeliveryMode,
  Group,
  PeerProfile,
} from "./protocol.ts";
export type MessageStatus =
  | "pending"
  | "sent"
  | "forwarded"
  | "queued"
  | "delivered"
  | "failed"
  | "received";
export type StoredMessage = {
  message: ChatMessage;
  status: MessageStatus;
  queuedUntil?: number;
};
export type DirectChatContact = {
  peerId: string;
  name: string;
  email: string;
  updatedAt: number;
};

export interface ChatStore {
  put(row: StoredMessage): Promise<void>;
  mark(
    messageId: string,
    receiverId: string,
    status: MessageStatus,
  ): Promise<void>;
  has(messageId: string, senderId: string): Promise<boolean>;
  list(): Promise<StoredMessage[]>;

  isDirectBlocked?(peerId: string): Promise<boolean>;
  putFile?(file: ChatAttachment, data: Uint8Array): Promise<void>;
  getFile?(fileId: string): Promise<
    | {
        file: ChatAttachment;
        data: Uint8Array;
      }
    | undefined
  >;
}
export interface DirectChatStore extends ChatStore {
  putDirect(row: StoredMessage): Promise<void>;
  listDirect(peerId: string): Promise<StoredMessage[]>;
  listDirectAttachments(peerId: string): Promise<StoredMessage[]>;
  deleteDirect(peerId: string): Promise<void>;
  setDirectBlocked(peerId: string, blocked: boolean): Promise<void>;
  isDirectBlocked(peerId: string): Promise<boolean>;
  listDirectBlocked(): Promise<string[]>;
  saveDirectContact(contact: DirectChatContact): Promise<void>;
  listDirectContacts(): Promise<DirectChatContact[]>;
  removeDirectContact(peerId: string): Promise<void>;
}
export type RTCFactory = new (config: RTCConfiguration) => RTCPeerConnection;
export type PeerEvent = {
  kind:
    | "message"
    | "presence"
    | "group"
    | "mode"
    | "log"
    | "connection"
    | "transfer"
    | "auth-expired"
    | "call"
    | "group-call"
    | "relay-metrics"
    | "superpeer";
  call?: import("./media.ts").CallState;
  groupCall?: import("./groupCallProtocol.ts").GroupCallState;
  groupCalls?: import("./groupCallProtocol.ts").GroupCallRoom[];
  relayMetrics?: import("./relaySelection.ts").RelaySample[];
  leader?: { peerId: string; url: string; leaseUntil: number } | null;
  message?: StoredMessage;
  peers?: string[];
  group?: Group;
  peerId?: string;
  mode?: DeliveryMode;
  text?: string;
  profiles?: PeerProfile[];
  connection?: {
    signaling: "connecting" | "online" | "reconnecting" | "offline";
    relays: number;
    activeRelay?: string;
  };
  transfer?: {
    id: string;
    name: string;
    peerId: string;
    direction: "send" | "receive";
    progress: number;
    status: "transferring" | "complete" | "failed";
    error?: string;
  };
};
export type PeerConfig = {
  peerId: string;
  displayName?: string;
  identityProof: string;
  signalUrl: string;
  relayUrl: string;
  relayUrls?: string[];
  rtc: RTCFactory;
  store: ChatStore;
  forceRelay?: boolean;
  iceServers?: RTCIceServer[];
  directTimeoutMs?: number;
  /** Maximum total time to keep checking ICE after a send falls back to relay. */
  directBackgroundTimeoutMs?: number;

  requestTimeoutMs?: number;
  ackTimeoutMs?: number;
  encryption?: boolean;
  identityStore?: import("./secure.ts").IdentityStore;
  relaySelection?: "priority" | "latency-load";
  discovery?: "signaling" | "dht";
  dhtLeaseMs?: number;
  rtcPolicy?: RTCIceTransportPolicy;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  simulateMediaIceFailure?: boolean;
  onEvent: (event: PeerEvent) => void;
};
