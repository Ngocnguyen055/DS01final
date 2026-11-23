import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeRoot, prepareRuntime } from "./runtime-paths.mjs";

await prepareRuntime();
const root = fileURLToPath(new URL("..", import.meta.url)),
  directory = await mkdtemp(join(runtimeRoot, "evaluation-"));
const results = join(directory, "tests.json");
console.log(`Evaluation evidence: ${directory}`);
const child = spawn(
  process.execPath,
  [
    join(root, "scripts/run-tests.mjs"),
    "--reporter=json",
    `--outputFile=${results}`,
  ],
  { cwd: root, env: process.env, stdio: "inherit", windowsHide: true },
);
const code = await new Promise((r, j) => {
  child.once("exit", r);
  child.once("error", j);
});
if (code !== 0) {
  process.exitCode = 1;
} else {
  const tests = JSON.parse(await readFile(results, "utf8")).testResults.flatMap(
    (file) => file.assertionResults,
  );
  const cases = {
    functional: [
      "returns complete public registration metadata",
      "advertises complete metadata from PeerClient",
      "sends and receives concurrently in both directions",
      "deduplicates identical retries across DIRECT and RELAY",
      "orders reordered and duplicate receives",
      "refreshes membership before fan-out",
      "exchanges simultaneous encrypted group messages and encrypted files",
      "discovers and chats using a distributed hash ring",
    ],
    concurrency: [
      "allows exactly one concurrent registration",
      "converges concurrent queue writes and deletion",
      "rejects simultaneous new events sharing one ID",
    ],
    faultRecovery: [
      "replicates encrypted offline mail and ACKs",
      "fails over when a connected relay accepts no RPCs",
      "reconnects and restores committed groups",
    ],
    security: [
      "encrypts text and authenticates metadata",
      "requires cluster authentication and rejects replay",
      "rejects unsigned, forged and expired",
    ],
  };
  const matrix = Object.fromEntries(
    Object.entries(cases).map(([category, patterns]) => [
      category,
      patterns.map((pattern) => {
        const test = tests.find((row) => row.fullName.includes(pattern));
        return {
          scenario: pattern,
          passed: test?.status === "passed",
          test: test?.fullName,
          durationMs: test?.duration,
        };
      }),
    ]),
  );
  const totals = Object.fromEntries(
    Object.entries(matrix).map(([category, cases]) => [
      category,
      cases.filter((row) => row.passed).length,
    ]),
  );
  const passed =
    totals.functional >= 8 &&
    totals.concurrency >= 2 &&
    totals.faultRecovery >= 2 &&
    totals.security >= 2;
  await writeFile(
    join(directory, "evaluation.json"),
    JSON.stringify(
      {
        requirement: "DS01 section 9",
        passed,
        totals,
        matrix,
        totalTests: tests.length,
        performance:
          "Run test:browser for latency/load matrix and test:browser:advanced for TURN/media/recovery metrics. These are separate experiments.",
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, totals, totalTests: tests.length }));
  if (!passed) process.exitCode = 1;
}
