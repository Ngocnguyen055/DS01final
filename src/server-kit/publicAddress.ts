import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

export function isPublicAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) address = mapped[1];
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && !/^[23]/.test(address)) return false;
  const blocked = new BlockList();
  for (const [network, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    blocked.addSubnet(network, bits, "ipv4");
  for (const [network, bits] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ] as const)
    blocked.addSubnet(network, bits, "ipv6");
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}
export async function assertPublicEndpoint(input: string) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("a publicly reachable HTTPS candidate is required");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("public candidate DNS timeout")),
          2000,
        );
      }),
    ]);
    if (!rows.length || rows.some((row) => !isPublicAddress(row.address)))
      throw Error("candidate must resolve to public Internet addresses");
  } finally {
    clearTimeout(timer);
  }
}
