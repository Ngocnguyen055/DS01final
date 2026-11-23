import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareRuntime } from "./runtime-paths.mjs";

await prepareRuntime();
const root = fileURLToPath(new URL("..", import.meta.url));
const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);

const child = spawn(
  process.execPath,
  [
    vitest,
    "run",
    "--maxWorkers",
    "1",
    "--no-file-parallelism",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(`Cannot start tests: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
