import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { promisify } from "node:util";
import { createDemoDashboard } from "../scripts/demo-dashboard.mjs";

const dashboards = [];
const execute = promisify(execFile);
afterEach(async () => {
  for (const dashboard of dashboards.splice(0)) await dashboard.close();
});
async function start() {
  const dashboard = await createDemoDashboard(() => ({
    mode: "test",
    passed: true,
    publicReachable: false,
    directory: "F:/Downloads/DS01-runtime/test",
    urls: {
      web: "http://localhost:5173",
      signal: "http://localhost:4001",
      relay: "http://localhost:4002",
      secret: "http://private.invalid",
    },
    processes: [
      { name: "relay", pid: 123, running: true, token: "PRIVATE-TOKEN" },
    ],
    logs: [
      {
        name: "relay",
        text: "REGISTER peer-a\nFORWARD message-id peer-a -> peer-b",
        internal: "PRIVATE-LOG-METADATA",
      },
    ],
    secret: "PRIVATE-CONFIGURATION",
  }));
  dashboards.push(dashboard);
  return dashboard;
}
describe("local demo observation dashboard", () => {
  it("serves a read-only view with service URLs, PIDs and logs while excluding unlisted configuration", async () => {
    const dashboard = await start(),
      response = await fetch(dashboard.url + "/api/state"),
      state = await response.json();
    expect(state).toMatchObject({
      mode: "test",
      publicReachable: false,
      processes: [{ name: "relay", pid: 123, running: true }],
    });
    expect(Object.keys(state.urls)).toEqual(["web", "signal", "relay"]);
    expect(JSON.stringify(state)).not.toContain("PRIVATE-");
    expect(state.logs[0].text).toContain("FORWARD message-id");
    const page = await fetch(dashboard.url);
    expect(await page.text()).toContain("dashboard.js");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      (await fetch(dashboard.url + "/dashboard.js")).headers.get(
        "content-type",
      ),
    ).toContain("text/javascript");
    expect((await fetch(dashboard.url + "/dashboard.css")).ok).toBe(true);
  });

  it("rejects foreign Host/Origin, mutation methods and arbitrary file paths", async () => {
    const dashboard = await start();
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const req = request(
        dashboard.url + "/api/state",
        { headers: { Host: "attacker.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(foreignHostStatus).toBe(403);
    expect(
      (
        await fetch(dashboard.url + "/api/state", {
          headers: { Origin: "https://attacker.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(dashboard.url + "/api/state", { method: "POST" })).status,
    ).toBe(405);
    for (const path of ["/session.json", "/.env", "/stop", "/logs/relay.log"])
      expect((await fetch(dashboard.url + path)).status).toBe(404);
  });

  it.each([
    ["--check", "--public"],
    ["--check", "--public-check"],
    ["--public", "--public-check"],
    ["--local", "--public"],
    ["--local", "--check"],
  ])(
    "rejects conflicting deployment modes before starting services: %s + %s",
    async (first, second) => {
      const error = await execute(
        process.execPath,
        ["scripts/demo-public.mjs", first, second],
        { timeout: 10000, windowsHide: true },
      ).then(
        () => null,
        (error) => error,
      );
      expect(error.code).toBe(2);
      expect(error.stderr).toContain("Usage:");
      expect(error.stdout).not.toContain("Demo data:");
    },
  );

  it("keeps the demo, dashboard and backup alive when the primary relay process crashes", async () => {
    const data = await mkdtemp(join(tmpdir(), "ds01-demo-state-"));
    const child = spawn(
      process.execPath,
      ["scripts/demo-public.mjs", "--local"],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DS01_DATA_DIR: data,
          DS01_MIGRATE_LEGACY: "0",
          VITE_ICE_SERVERS: "[]",
          VITE_ICE_POLICY: "all",
        },
      },
    );
    let output = "";
    const capture = (chunk) => {
      output = (output + chunk).slice(-100000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const closed = new Promise((resolve) => child.once("close", resolve));
    async function until(check, label, timeout = 45000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw Error(`Demo exited during ${label}: ${output}`);
        const value = await check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw Error(`Timeout ${label}: ${output}`);
    }
    try {
      const directory = await until(
        () => output.match(/Demo data: ([^\r\n]+)/)?.[1],
        "startup directory",
      );
      await until(() => output.includes("Local demo ready."), "ready demo");
      const session = JSON.parse(
        await readFile(join(directory, "session.json"), "utf8"),
      );
      const initial = await (
        await fetch(session.dashboardUrl + "/api/state")
      ).json();
      const primary = initial.processes.find((item) => item.name === "relay");
      expect(primary.running).toBe(true);
      expect(
        initial.processes.find((item) => item.name === "backup").running,
      ).toBe(true);
      process.kill(primary.pid);
      await until(
        async () => {
          const state = await (
            await fetch(session.dashboardUrl + "/api/state")
          ).json();
          return (
            state.processes.find((item) => item.name === "relay")?.running ===
            false
          );
        },
        "relay crash",
        5000,
      );
      expect(child.exitCode).toBeNull();
      for (const name of ["signal", "backup"])
        expect((await fetch(session.local[name] + "/health")).ok).toBe(true);
      expect((await fetch(session.local.web)).ok).toBe(true);
      expect(output).toContain(
        "Keeping signaling, web and the other relay running for failover.",
      );
      const repeated = await execute(
        process.execPath,
        ["scripts/demo-public.mjs", "--local"],
        {
          windowsHide: true,
          timeout: 15000,
          env: {
            ...process.env,
            DS01_DATA_DIR: session.dataDirectory,
            DS01_MIGRATE_LEGACY: "0",
            VITE_ICE_SERVERS: "[]",
            VITE_ICE_POLICY: "all",
          },
        },
      );
      expect(repeated.stdout).toContain("Reusing the existing demo");
      expect(repeated.stdout).toContain(session.urls.web);
      expect(repeated.stdout).not.toContain("Demo data:");
      const changedConfiguration = await execute(
        process.execPath,
        ["scripts/demo-public.mjs", "--local"],
        {
          windowsHide: true,
          timeout: 15000,
          env: {
            ...process.env,
            DS01_DATA_DIR: session.dataDirectory,
            DS01_MIGRATE_LEGACY: "0",
            VITE_ICE_SERVERS: "[]",
            VITE_ICE_POLICY: "relay",
          },
        },
      ).catch((error) => error);
      expect(changedConfiguration.code).toBe(1);
      expect(changedConfiguration.stderr).toContain(
        "Cấu hình WebRTC đã thay đổi",
      );
      expect(changedConfiguration.stdout).not.toContain(
        "Reusing the existing demo",
      );
      expect((await fetch(session.local.web)).ok).toBe(true);
      await writeFile(
        join(session.dataDirectory, "last-session.json"),
        JSON.stringify({ ...session, sourceFingerprint: "0".repeat(64) }),
      );
      const stale = await execute(
        process.execPath,
        ["scripts/demo-public.mjs", "--local"],
        {
          windowsHide: true,
          timeout: 15000,
          env: {
            ...process.env,
            DS01_DATA_DIR: session.dataDirectory,
            DS01_MIGRATE_LEGACY: "0",
            VITE_ICE_SERVERS: "[]",
            VITE_ICE_POLICY: "all",
          },
        },
      ).catch((error) => error);
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain("Mã nguồn đã thay đổi");
      expect(stale.stdout).not.toContain("Reusing the existing demo");
      expect((await fetch(session.local.web)).ok).toBe(true);
    } finally {
      if (child.exitCode === null) {
        if (process.platform === "win32")
          await execute(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true },
          ).catch((error) => {
            if (child.exitCode === null) throw error;
          });
        else child.kill("SIGINT");
      }
      let timeout;
      try {
        await Promise.race([
          closed,
          new Promise((resolve) => {
            timeout = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  }, 60000);
});
