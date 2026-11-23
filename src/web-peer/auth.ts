import { io } from "socket.io-client";

export type Account = { username: string; peerId: string; displayName: string };
export type LoginSession = {
  account: Account;
  token: string;
  expiresAt: number;
};
type AuthResult = {
  ok: boolean;
  error?: string;
  account?: Account;
  token?: string;
  expiresAt?: number;
};
export const sessionKey = "ds01-account-session-v1";

export async function authRequest(
  url: string,
  event: string,
  input: unknown,
): Promise<AuthResult> {
  const socket = io(url, { autoConnect: false, reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Không kết nối được máy chủ tài khoản.")),
        6000,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", () => {
        clearTimeout(timer);
        reject(Error("Không kết nối được máy chủ tài khoản."));
      });
      socket.connect();
    });
    const result: AuthResult = await socket
      .timeout(12000)
      .emitWithAck(event, input);
    if (!result?.ok) throw Error(result?.error || "Không thể xử lý tài khoản.");
    return result;
  } finally {
    socket.disconnect();
  }
}
