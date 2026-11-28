import { randomUUID } from "../uuid.ts";
import {
  chatAttachmentSchema,
  MAX_CHAT_ATTACHMENT_BYTES,
  FILE_CHUNK_BYTES,
  type ChatMessage,
  type FileChunk,
} from "../protocol.ts";
import type { ChatStore, PeerEvent } from "../peerTypes.ts";
const CHUNK_BYTES = FILE_CHUNK_BYTES;
export async function fileHash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(data).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
type Assembly = {
  chunk: FileChunk;
  senderId: string;
  parts: Map<number, Uint8Array>;
  updated: number;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
};
export class FileTransfer {
  private assemblies = new Map<string, Assembly>();
  private rejected = new Map<string, number>();
  private closed = false;
  constructor(
    private config: {
      store: ChatStore;
      sendChunk: (
        peerId: string,
        chunk: FileChunk,
        groupId?: string,
      ) => Promise<void>;
      sendAttachment: (
        peerId: string,
        file: FileChunk["file"],
      ) => Promise<void>;
      sendGroupAttachment?: (
        groupId: string,
        file: FileChunk["file"],
        recipients: string[],
      ) => Promise<Record<string, string>>;
      emit: (event: PeerEvent) => void;
    },
  ) {}
  private progress(
    chunk: FileChunk,
    peerId: string,
    direction: "send" | "receive",
    progress: number,
    status: "transferring" | "complete" | "failed",
    error?: string,
  ) {
    this.config.emit({
      kind: "transfer",
      transfer: {
        id: chunk.transferId,
        name: chunk.file.name,
        peerId,
        direction,
        progress,
        status,
        error,
      },
    });
  }
  private assertOpen() {
    if (this.closed) throw new Error("file transfer closed");
  }
  private removeAssembly(key: string) {
    clearTimeout(this.assemblies.get(key)?.timer);
    this.assemblies.delete(key);
  }
  private expireAfterInactivity(key: string, item: Assembly) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      if (this.assemblies.get(key) !== item) return;
      this.removeAssembly(key);
      this.progress(
        item.chunk,
        item.senderId,
        "receive",
        0,
        "failed",
        "file transfer timeout; send the file again",
      );
    }, 120000);

    if (typeof item.timer === "object") item.timer.unref?.();
  }
  async send(peerId: string, name: string, mime: string, data: Uint8Array) {
    await this.sendTo([peerId], name, mime, data);
  }
  async sendGroup(
    groupId: string,
    recipients: string[],
    name: string,
    mime: string,
    data: Uint8Array,
  ) {
    if (!this.config.sendGroupAttachment)
      throw Error("group file transfer unsupported");
    return this.sendTo([...new Set(recipients)], name, mime, data, groupId);
  }
  private async sendTo(
    recipients: string[],
    name: string,
    mime: string,
    data: Uint8Array,
    groupId?: string,
  ) {
    this.assertOpen();
    if (!recipients.length)
      throw Error("Không có thành viên khác để nhận file.");
    if (!this.config.store.putFile) throw new Error("file storage unsupported");
    if (!data.length || data.length > MAX_CHAT_ATTACHMENT_BYTES)
      throw new Error("File phải từ 1 byte đến 20 MiB");
    const file = {
      ...chatAttachmentSchema.parse({
        id: randomUUID(),
        name,
        mime: mime || "application/octet-stream",
        size: data.length,
      }),
      sha256: await fileHash(data),
    };
    this.assertOpen();
    const total = Math.ceil(data.length / CHUNK_BYTES);
    await this.config.store.putFile(file, data);
    const successful: string[] = [],
      failed: string[] = [];
    for (const peerId of recipients) {
      let last: FileChunk = {
        transferId: file.id,
        index: 0,
        total,
        data: "",
        file,
      };
      try {
        for (let index = 0; index < total; index += 4) {
          this.assertOpen();
          const started = Date.now();
          this.progress(
            last,
            peerId,
            "send",
            Math.round((index / total) * 100),
            "transferring",
          );
          const batch = Array.from(
            { length: Math.min(4, total - index) },
            (_, offset) => {
              const part = index + offset,
                bytes = data.subarray(
                  part * CHUNK_BYTES,
                  (part + 1) * CHUNK_BYTES,
                );
              last = {
                transferId: file.id,
                index: part,
                total,
                data: btoa(String.fromCharCode(...bytes)),
                file,
              };
              return this.config.sendChunk(peerId, last, groupId);
            },
          );
          const results = await Promise.allSettled(batch);
          const error = results.find((result) => result.status === "rejected");
          if (error?.status === "rejected") throw error.reason;
          const delay = 100 - (Date.now() - started);
          if (delay > 0)
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        this.assertOpen();
        if (!groupId) await this.config.sendAttachment(peerId, file);
        this.assertOpen();
        successful.push(peerId);
        this.progress(
          last,
          peerId,
          "send",
          groupId ? 99 : 100,
          groupId ? "transferring" : "complete",
        );
      } catch (error) {
        this.progress(last, peerId, "send", 0, "failed", String(error));
        if (!groupId) throw error;
        failed.push(peerId);
      }
    }
    if (groupId && successful.length) {
      const last = {
        transferId: file.id,
        file,
        index: total - 1,
        total,
        data: "",
      };
      try {
        const result = await this.config.sendGroupAttachment!(
          groupId,
          file,
          successful,
        );
        for (const id of successful) {
          if (result[id] === "fulfilled")
            this.progress(last, id, "send", 100, "complete");
          else {
            failed.push(id);
            this.progress(
              last,
              id,
              "send",
              99,
              "failed",
              "Chưa nhận được ACK cho file.",
            );
          }
        }
      } catch (error) {
        for (const id of successful)
          this.progress(last, id, "send", 99, "failed", String(error));
        throw error;
      }
    }
    if (failed.length)
      throw Error(
        "Chưa gửi được file đến: " +
          failed.join(", ") +
          ". Người nhận cần trực tuyến và còn trong nhóm.",
      );
  }
  async receive(message: ChatMessage) {
    this.assertOpen();
    const chunk = message.fileChunk;
    if (!chunk || !this.config.store.putFile || !this.config.store.getFile)
      throw new Error("file storage unsupported");
    if (chunk.total !== Math.ceil(chunk.file.size / CHUNK_BYTES))
      throw new Error("invalid chunk count");
    const bytes = Uint8Array.from(atob(chunk.data), (char) =>
      char.charCodeAt(0),
    );
    const expectedSize =
      chunk.index === chunk.total - 1
        ? chunk.file.size - chunk.index * CHUNK_BYTES
        : CHUNK_BYTES;
    if (bytes.length !== expectedSize) throw new Error("invalid chunk size");
    const complete = await this.config.store.getFile(chunk.transferId);
    this.assertOpen();
    if (complete) {
      if (complete.file.sha256 !== chunk.file.sha256)
        throw new Error("conflicting file");
      return;
    }
    for (const [key, item] of this.assemblies)
      if (Date.now() - item.updated > 120000) {
        this.removeAssembly(key);
        this.progress(
          item.chunk,
          item.senderId,
          "receive",
          0,
          "failed",
          "file transfer timeout; send the file again",
        );
      }
    const key = `${message.senderId}:${chunk.transferId}`;
    for (const [id, at] of this.rejected)
      if (Date.now() - at > 120000) this.rejected.delete(id);
    if (this.rejected.has(key))
      throw new Error("file integrity failed; start a new transfer");
    let item = this.assemblies.get(key);
    if (!item) {
      if (this.assemblies.size >= 4)
        throw new Error("too many concurrent files");
      item = {
        chunk,
        senderId: message.senderId,
        parts: new Map(),
        updated: Date.now(),
        bytes: 0,
      };
      this.assemblies.set(key, item);
    }
    if (
      JSON.stringify(item.chunk.file) !== JSON.stringify(chunk.file) ||
      item.chunk.total !== chunk.total
    )
      throw new Error("conflicting file metadata");
    const prior = item.parts.get(chunk.index);
    if (
      prior &&
      (prior.length !== bytes.length ||
        prior.some((byte, index) => byte !== bytes[index]))
    )
      throw new Error("conflicting chunk");
    if (!prior) {
      item.parts.set(chunk.index, bytes);
      item.bytes += bytes.length;
    }
    item.updated = Date.now();
    this.expireAfterInactivity(key, item);
    this.progress(
      chunk,
      message.senderId,
      "receive",
      Math.round((item.parts.size / chunk.total) * 100),
      "transferring",
    );
    if (item.parts.size !== chunk.total) return;
    const data = new Uint8Array(chunk.file.size);
    for (let index = 0; index < chunk.total; index++)
      data.set(item.parts.get(index)!, index * CHUNK_BYTES);
    const hash = await fileHash(data);
    this.assertOpen();
    if (this.assemblies.get(key) !== item)
      throw new Error("file transfer interrupted");
    if (item.bytes !== chunk.file.size || hash !== chunk.file.sha256) {
      this.removeAssembly(key);
      this.rejected.set(key, Date.now());
      if (this.rejected.size > 128)
        this.rejected.delete(this.rejected.keys().next().value!);
      this.progress(
        chunk,
        message.senderId,
        "receive",
        0,
        "failed",
        "SHA-256 mismatch",
      );
      throw new Error("SHA-256 mismatch");
    }
    await this.config.store.putFile(chunk.file, data);
    this.assertOpen();
    if (this.assemblies.get(key) !== item)
      throw new Error("file transfer interrupted");
    this.removeAssembly(key);
    this.progress(chunk, message.senderId, "receive", 100, "complete");
  }
  close() {
    this.closed = true;
    for (const [key, item] of this.assemblies) {
      this.removeAssembly(key);
      this.progress(
        item.chunk,
        item.senderId,
        "receive",
        0,
        "failed",
        "file transfer closed",
      );
    }
    this.rejected.clear();
  }
}
