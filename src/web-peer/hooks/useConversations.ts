import { useCallback, useRef, useState, type RefObject } from "react";
import {
  isDirectMessageBetween,
  peerIdSchema,
  type ChatAttachment,
  type DirectChatContact,
  type Group,
  type PeerClient,
  type PeerProfile,
  type StoredMessage,
} from "@ds01/shared";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../../shared/protocol.ts";
import type { CallRecord } from "../storage/callHistory.ts";
import { saveDownload } from "../storage/download.ts";
import type { WebStore } from "../storage/store.ts";

type ConversationContext = {
  client: RefObject<PeerClient | null>;
  store: RefObject<WebStore>;
  generation: RefObject<number>;
  peerId: string;
  displayName: string;
  hasSession: boolean;
  connected: boolean;
  online: string[];
  profiles: PeerProfile[];
  groups: Group[];
  setError: (message: string) => void;
  canImportHistory: () => boolean;
  onHistoryImported: () => void;
};

export function useConversations({
  client,
  store,
  generation,
  peerId,
  displayName,
  hasSession,
  connected,
  online,
  profiles,
  groups,
  setError,
  canImportHistory,
  onHistoryImported,
}: ConversationContext) {
  const [contacts, setContacts] = useState<DirectChatContact[]>([]),
    [target, setTarget] = useState(""),
    [groupTarget, setGroupTarget] = useState(""),
    [body, setBodyValue] = useState(""),
    [messages, setMessages] = useState<StoredMessage[]>([]),
    [unreadConversations, setUnreadConversations] = useState<string[]>([]),
    [sending, setSending] = useState(false),
    [blocked, setBlocked] = useState<string[]>([]),
    [calls, setCalls] = useState<CallRecord[]>([]);

  const draftRevision = useRef(0);
  const pendingSends = useRef(0);
  const beginSending = () => {
    pendingSends.current++;
    setSending(true);
    return generation.current;
  };
  const finishSending = (version: number) => {
    if (generation.current !== version) return;
    pendingSends.current = Math.max(0, pendingSends.current - 1);
    setSending(pendingSends.current > 0);
    void refresh();
  };
  const setBody = (value: string) => {
    draftRevision.current++;
    setBodyValue(value);
  };
  const refresh = useCallback(async () => {
    const active = store.current;
    try {
      const [rows, savedContacts, blockedPeers] = await Promise.all([
        active.list(),
        active.listDirectContacts(),
        active.listDirectBlocked(),
      ]);
      if (active !== store.current) return;
      setMessages(rows);
      setUnreadConversations(active.listUnreadConversations());
      setCalls(active.listCalls());
      setContacts(savedContacts);
      setBlocked(blockedPeers);
    } catch (error) {
      setError(String(error));
    }
  }, [store, setError]);
  const markConversationRead = useCallback((key: string) => {
    try {
      if (store.current.markConversationRead(key))
        setUnreadConversations(store.current.listUnreadConversations());
    } catch (error) {
      setError(String(error));
    }
  }, [store, setError]);
  const resetSending = () => {
    pendingSends.current = 0;
    setSending(false);
  };
  const resetConversations = () => {
    resetSending();
    setMessages([]);
    setUnreadConversations([]);
    setCalls([]);
    setContacts([]);
    setBlocked([]);
    setTarget("");
    setGroupTarget("");
    setBody("");
  };
  const send = async () => {
    if (pendingSends.current || !body.trim()) return;
    const text = body;
    const revision = draftRevision.current,
      version = generation.current;
    setError("");
    beginSending();
    try {
      if (!client.current || !hasSession)
        throw new Error("Hãy kết nối trước khi gửi");
      if (groupTarget) {
        const result = await client.current.sendGroup(groupTarget, text);
        const failed = Object.entries(result).filter(
          ([, status]) => status === "rejected",
        );
        if (failed.length && generation.current === version)
          setError(
            `Chưa giao được tới: ${failed.map(([id]) => id).join(", ")}`,
          );
      } else await client.current.sendDirect(target, text);
      if (generation.current === version && draftRevision.current === revision)
        setBody("");
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      finishSending(version);
    }
  };
  const createGroup = async (name: string, members: string) => {
    if (!client.current) throw new Error("Hãy kết nối trước");
    const group = await client.current.createGroup(
      members
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      name,
    );
    setGroupTarget(group.id);
    setTarget("");
    return group;
  };
  const changeGroup = async (memberId: string, action: "add" | "remove") => {
    try {
      if (!client.current) throw new Error("Hãy kết nối trước");
      await client.current.changeGroup(groupTarget, memberId, action);
    } catch (error) {
      setError(String(error));
    }
  };
  const openPeer = async (id: string) => {
    peerIdSchema.parse(id);
    if (id === peerId) throw new Error("Chọn một peer khác");
    if (client.current && connected)
      await client.current.lookupPeer(id);
    await store.current.saveDirectContact({
      peerId: id,
      name:
        profiles.find((profile) => profile.peerId === id)?.displayName ||
        contacts.find((contact) => contact.peerId === id)?.name ||
        id,
      email: "",
      updatedAt: Date.now(),
    });
    setTarget(id);
    setGroupTarget("");
    await refresh();
  };
  const retry = async (row: StoredMessage) => {
    const version = beginSending();
    try {
      if (!client.current) throw new Error("Hãy kết nối trước");
      await client.current.retry(row.message.messageId, row.message.receiverId);
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      finishSending(version);
    }
  };
  const sendFile = async (file: File) => {
    const version = beginSending();
    try {
      if (!client.current || (!target && !groupTarget))
        throw new Error("Chọn cuộc trò chuyện để gửi file");
      setError("");
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES)
        throw new Error("File tối đa 20 MiB");
      const data = new Uint8Array(await file.arrayBuffer());
      if (groupTarget)
        await client.current.sendGroupFile(
          groupTarget,
          file.name,
          file.type,
          data,
        );
      else await client.current.sendFile(target, file.name, file.type, data);
    } catch (error) {
      if (generation.current === version) setError(String(error));
    } finally {
      finishSending(version);
    }
  };
  const downloadFile = async (file: ChatAttachment) => {
    try {
      const saved = await store.current.getFile(file.id);
      if (!saved)
        throw new Error(
          "File chưa có trên thiết bị này. Bản sao tài khoản chỉ chứa tối đa 8 MiB file; hãy tải ở thiết bị đã nhận hoặc nhờ người gửi gửi lại.",
        );
      saveDownload(
        file.name,
        new Blob([new Uint8Array(saved.data).buffer], {
          type: "application/octet-stream",
        }),
      );
    } catch (error) {
      setError(String(error));
    }
  };
  const toggleBlock = async () => {
    if (!target) return;
    try {
      await store.current.setDirectBlocked(target, !blocked.includes(target));
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };
  const deleteHistory = async () => {
    if (!target) return;
    try {
      await store.current.deleteDirect(target);
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };
  const visible = messages.filter((row) =>
    groupTarget
      ? row.message.groupId === groupTarget
      : isDirectMessageBetween(row.message, peerId, target),
  );
  const exportHistory = async () => {
    try {
      const snapshot = await store.current.snapshot();
      saveDownload(
        `ds01-${groupTarget || target || peerId}.json`,
        new Blob(
          [
            JSON.stringify(
              {
                ...snapshot,
                rows: visible,
                calls: calls.filter((call) =>
                  groupTarget
                    ? call.groupId === groupTarget
                    : call.peerId === target,
                ),
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
    } catch (error) {
      setError(String(error));
    }
  };
  const importHistory = async (file?: File) => {
    if (!file || !canImportHistory()) return;
    try {
      if (file.size > 16 * 1024 * 1024)
        throw Error("File lịch sử vượt 16 MiB.");
      const value: unknown = JSON.parse(await file.text());
      const current = await store.current.snapshot();
      await store.current.restore(
        Array.isArray(value) ? { ...current, rows: value } : value,
      );
      await refresh();
      onHistoryImported();
    } catch (error) {
      setError(`Không nhập được lịch sử: ${String(error)}`);
    }
  };
  const knownPeers = [
    ...new Set([
      ...online,
      ...contacts.map((contact) => contact.peerId),
      ...messages.flatMap((row) =>
        row.message.groupId
          ? []
          : [row.message.senderId, row.message.receiverId],
      ),
    ]),
  ].filter((id) => id !== peerId);
  const nameOf = (id: string) =>
    profiles.find((profile) => profile.peerId === id)?.displayName ||
    contacts.find((contact) => contact.peerId === id)?.name ||
    (id === peerId ? displayName : id);
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(
      localStorage.getItem(`ds01-group-names-${peerId}`) || "{}",
    );
  } catch {}
  const historyGroups = [
    ...new Set(
      messages
        .map((row) => row.message.groupId)
        .filter((id): id is string => !!id),
    ),
  ]
    .filter((id) => !groups.some((group) => group.id === id))
    .map(
      (id) =>
        ({
          id,
          name: names[id] || `Nhóm ${id.slice(0, 8)}`,
          ownerId: peerId,
          members: [],
          version: 0,
          archived: true,
        }) as Group,
    );
  return {
    refresh,
    resetSending,
    resetConversations,
    groups: [...groups, ...historyGroups],
    target,
    setTarget,
    groupTarget,
    setGroupTarget,
    body,
    setBody,
    calls,
    messages,
    unreadConversations,
    markConversationRead,
    visible,
    sending,
    blocked,
    knownPeers,
    nameOf,
    send,
    createGroup,
    changeGroup,
    openPeer,
    retry,
    sendFile,
    downloadFile,
    toggleBlock,
    deleteHistory,
    exportHistory,
    importHistory,
  };
}
