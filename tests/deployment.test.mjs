import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const bash =
  process.env.BASH_PATH ||
  (process.platform === "win32"
    ? ["F:/Git/bin/bash.exe", "C:/Program Files/Git/bin/bash.exe"].find(
        existsSync,
      )
    : "/bin/bash");
const execute = promisify(execFile),
  folders = [];
const revision = "b".repeat(40),
  old =
    "DS01_IMAGE_PREFIX=ghcr.io/owner/repo\nDS01_IMAGE_TAG=sha-" +
    "a".repeat(40) +
    "\n";
const script = fileURLToPath(
  new URL("../scripts/deploy-remote.sh", import.meta.url),
);
const mock =
  'docker(){ printf "%s\\n" "$*" >> calls.log; if [[ "$FAIL_UPDATE" == 1 && "$*" == *next-release.env* && "$*" == *" up "* ]]; then return 1; fi; return 0; }; export -f docker; bash "$TASK_SCRIPT" "$IMAGE_PREFIX" "$REVISION"';
function fixture(previous = true) {
  const path = mkdtempSync(join(tmpdir(), "ds01-deployment-"));
  folders.push(path);
  writeFileSync(join(path, ".env"), "NODE_ENV=production\n");
  writeFileSync(join(path, "compose.images.yml"), "services: {}\n");
  if (previous) writeFileSync(join(path, "current-release.env"), old);
  return path;
}
async function deploy(path, fail = false, prefix = "ghcr.io/owner/repo") {
  return execute(bash, ["-c", mock], {
    cwd: path,
    env: {
      ...process.env,
      TASK_SCRIPT: script,
      IMAGE_PREFIX: prefix,
      REVISION: revision,
      FAIL_UPDATE: fail ? "1" : "0",
    },
    windowsHide: true,
    timeout: 10000,
  }).then(
    (value) => ({ code: 0, ...value }),
    (error) => error,
  );
}
afterEach(() => {
  for (const folder of folders.splice(0)) {
    const checked = resolve(folder);
    if (
      dirname(checked) !== resolve(tmpdir()) ||
      !basename(checked).startsWith("ds01-deployment-")
    )
      throw Error("invalid cleanup path");
    rmSync(checked, { recursive: true, force: true });
  }
});

describe.skipIf(!bash)(
  "deployment shell state transitions with an isolated Docker test double",
  () => {
    it("promotes a healthy revision only after config, pull and health checks, keeping the previous revision", async () => {
      const path = fixture(),
        result = await deploy(path);
      expect(result.code).toBe(0);
      expect(readFileSync(join(path, "current-release.env"), "utf8")).toContain(
        "sha-" + revision,
      );
      expect(readFileSync(join(path, "previous-release.env"), "utf8")).toBe(
        old,
      );
      const calls = readFileSync(join(path, "calls.log"), "utf8")
        .trim()
        .split("\n");
      expect(calls).toHaveLength(3);
      expect(calls[0]).toContain("config --quiet");
      expect(calls[1]).toContain("pull");
      expect(calls[2]).toContain("up -d --wait");
    });
    it("restores the previous image configuration on an unhealthy deployment without replacing the committed release marker", async () => {
      const path = fixture(),
        result = await deploy(path, true);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("Restored previous release");
      expect(readFileSync(join(path, "current-release.env"), "utf8")).toBe(old);
      expect(
        readFileSync(join(path, "calls.log"), "utf8").trim().split("\n").at(-1),
      ).toContain("--env-file current-release.env");
    });
    it("rejects an invalid image argument before invoking Docker or interpreting shell substitutions", async () => {
      const path = fixture(false),
        result = await deploy(path, false, "ghcr.io/owner/$(touch INJECTED)");
      expect(result.code).toBe(1);
      expect(existsSync(join(path, "calls.log"))).toBe(false);
      expect(existsSync(join(path, "INJECTED"))).toBe(false);
    });
  },
);
