import { io } from "socket.io-client";

export async function connectProbe(url, auth, track = () => {}) {
  const socket = io(url, {
    autoConnect: false,
    transports: ["websocket"],
    auth,
    timeout: 5000,
    reconnection: true,
    reconnectionAttempts: 2,
    reconnectionDelay: 500,
    reconnectionDelayMax: 1500,
    randomizationFactor: 0,
  });
  track(socket);
  let lastError;
  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        socket.off("connect", connected);
        socket.off("connect_error", failed);
        socket.io.off("reconnect_failed", exhausted);
        error ? reject(error) : resolve();
      };
      const connected = () => finish();
      const failed = (error) => {
        lastError = error;
        if (!socket.active) finish(error);
      };
      const exhausted = () =>
        finish(lastError || Error("Connection attempts exhausted"));
      const timer = setTimeout(
        () => finish(lastError || Error("Connection timeout after 15 seconds")),
        15000,
      );
      socket.once("connect", connected);
      socket.on("connect_error", failed);
      socket.io.once("reconnect_failed", exhausted);
      socket.connect();
    });

    socket.io.reconnection(false);
    return socket;
  } catch (error) {
    socket.io.reconnection(false);
    socket.disconnect();
    const detail = error.description || error.context;
    const reason = [
      detail?.message,
      detail?.code,
      detail?.error?.message,
      detail?.error?.code,
      typeof detail === "string" || typeof detail === "number" ? detail : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw Error(
      `Socket.IO ${new URL(url).host}: ${error.message}${reason ? ` (${reason})` : ""}`,
    );
  }
}
