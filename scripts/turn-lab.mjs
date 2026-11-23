import Turn from "node-turn";

const port = Number(process.env.TURN_LAB_PORT),
  username = process.env.TURN_LAB_USERNAME,
  password = process.env.TURN_LAB_PASSWORD;
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !username ||
  !password
)
  throw Error(
    "TURN lab requires an unprivileged UDP port and ephemeral credentials",
  );
const server = new Turn({
  listeningIps: ["127.0.0.1"],
  relayIps: ["127.0.0.1"],
  listeningPort: port,
  minPort: 52000,
  maxPort: 52999,
  authMech: "long-term",
  realm: "ds01-local-lab",
  credentials: { [username]: password },
  debugLevel: "ERROR",
  debug: (level, message) => {
    if (level === "ERROR" || level === "FATAL") console.error(String(message));
  },
});
server.on("binding", () => console.log("STUN_BINDING"));
server.on("allocate", () => console.log("TURN_ALLOCATE"));
server.start();
for (const socket of server.network.sockets)
  socket.once("listening", () => console.log("TURN_READY loopback-only"));
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.stop();
    process.exit(0);
  });
