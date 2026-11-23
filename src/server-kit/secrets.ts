export function requireSecret(name: "JWT_SECRET" | "PEER_SECRET"): string {
  const value = process.env[name];
  if (
    !value ||
    value.trim() !== value ||
    value.length < 32 ||
    /replace[-_]with|local-development-only|change[-_]?me/i.test(value)
  )
    throw new Error(
      `${name} must be configured with a random secret of at least 32 characters. Run npm.cmd run setup:env.`,
    );
  return value;
}
