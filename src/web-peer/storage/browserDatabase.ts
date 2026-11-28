import type { ChatAttachment } from "@ds01/shared";

type StoredFile = { file: ChatAttachment; data: Uint8Array };

function openDatabase(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function accessSecurityKey(
  scope: string,
  key: string,
  value?: unknown,
): Promise<unknown> {
  const db = await openDatabase("ds01-security-v1", "keys");
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
          "keys",
          value === undefined ? "readonly" : "readwrite",
        ),
        store = tx.objectStore("keys");
      const request =
        value === undefined
          ? store.get(`${scope}:${key}`)
          : store.put(value, `${scope}:${key}`);
      let result: unknown;
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || Error("security key storage failed"));
    });
  } finally {
    db.close();
  }
}

export async function putStoredFile(
  scope: string,
  file: ChatAttachment,
  data: Uint8Array,
): Promise<void> {
  const db = await openDatabase("ds01-files-v1", "files");
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put({ file, data }, `${scope}:${file.id}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || new Error("file storage aborted"));
    });
  } finally {
    db.close();
  }
}

export async function getStoredFile(
  scope: string,
  fileId: string,
): Promise<StoredFile | undefined> {
  const db = await openDatabase("ds01-files-v1", "files");
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readonly");
      const request = tx.objectStore("files").get(`${scope}:${fileId}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
