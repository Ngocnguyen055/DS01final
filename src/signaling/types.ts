import type { Server, Socket } from "socket.io";
import type {
  Group,
  PeerConnection,
  PeerDiscovery,
  PeerProfile,
} from "@ds01/shared";
import type { ProjectDirectory } from "./projectDirectory.ts";
import type { Accounts } from "./accounts.ts";
export type PeerSession = {
  socket: Socket;
  lastSeen: number;
  displayName: string;
  status: "online";
  connection: PeerConnection;
};
export type DirectChatAuthorizer = (
  senderId: string,
  receiverId: string,
) => Promise<boolean>;
export type SignalingReply = (response: {
  ok: boolean;
  error?: string;
  token?: string;
  peers?: string[];
  profiles?: PeerProfile[];
  groups?: Group[];
  group?: Group;
  peer?: PeerDiscovery;
}) => void;
export type SignalingContext = {
  accounts: Accounts;
  io: Server;
  peers: Map<string, PeerSession>;
  groups: Map<string, Group>;
  demoSecrets: Map<string, string>;
  save: () => void;
  directory: ProjectDirectory;
  authorizeDirect: DirectChatAuthorizer;
  peerSecret: string;
  jwtSecret: string;
  heartbeatFreshMs: number;
  publishGroup: (group: Group) => void;
  currentGroup: (id: string) => Promise<Group | null>;
  publishPresence: () => void;
  onlineProfiles: () => PeerProfile[];
  peerFor: (socket: Socket) => string | undefined;
};
