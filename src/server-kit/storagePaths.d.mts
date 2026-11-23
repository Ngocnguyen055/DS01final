export const projectRoot: string;
export const runtimeRoot: string;
export const runtimeTemp: string;
export const toolsDirectory: string;
export const dataRoot: string;
export function prepareRuntime(): Promise<void>;
export function acquireStorageLock(
  directory: string,
  name: string,
): Promise<() => Promise<void>>;
export function prepareData(
  directory?: string,
  options?: { legacyRoot?: string; runtime?: string; migrate?: boolean },
): Promise<{ directory: string; migrated: boolean; conflicts: string[] }>;
export function durableDemoSecrets(
  directory: string,
  option: (name: string) => string | undefined,
): Promise<{ JWT_SECRET: string; PEER_SECRET: string }>;
