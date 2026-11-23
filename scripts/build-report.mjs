import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url)),
  docs = join(root, "docs");
const readJSON = async (name) => {
  try {
    return JSON.parse(await readFile(join(docs, "evidence", name), "utf8"));
  } catch {
    return null;
  }
};
const browser = await readJSON("browser-smoke.json"),
  unit = await readJSON("unit-tests.json"),
  load = await readJSON("load-relay.json");
const evidence =
  [
    `Vitest: ${unit ? `${unit.numPassedTests}/${unit.numTotalTests} test đạt` : "chưa có JSON kết quả mới; chạy npm test với reporter JSON"}.`,
    browser
      ? `Browser: ${browser.passed ? "đạt" : "chưa đạt"}; ${browser.checks.filter((item) => item.passed).length}/${browser.checks.length} check. Ngày chạy: ${browser.finishedAt}. Commit ${browser.commit || "chưa ghi"}; working tree modified: ${browser.workingTreeModified ?? "chưa ghi"}.`
      : "Browser: NOT RUN.",
    browser?.sourceFingerprint
      ? `Source fingerprint SHA-256: ${browser.sourceFingerprint}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n") +
  "\n\n" +
  [
    "| Kiểm tra browser | Kết quả |",
    "|---|---|",
    ...(browser?.checks || []).map(
      (item) => `| ${item.label} | ${item.passed ? "PASS" : "FAIL"} |`,
    ),
  ].join("\n");
const metric = (value) =>
  typeof value === "number" ? value.toFixed(2) : "NOT RUN";
const measured = load
  ? `Môi trường đo: ${load.node}, ${load.signalHost} / ${load.relayHost}, ${load.measuredAt}.\n\n| Chỉ số | Kết quả |\n|---|---|\n| Simulated peers / workers | ${load.peers} / ${load.concurrency} |\n| Requested / delivered / failed | ${load.requested} / ${load.delivered} / ${load.failed} |\n| Duplicate deliveries | ${load.duplicateDeliveries} |\n| p50 / p95 / max (ms) | ${metric(load.p50Ms)} / ${metric(load.p95Ms)} / ${metric(load.maxMs)} |\n| Throughput (message/s) | ${metric(load.throughputMessagesPerSecond)} |\n| Serialized envelope bytes | ${load.serializedEnvelopeBytes} |\n\nSource fingerprint: ${load.sourceFingerprint || "chưa ghi"}; commit ${load.commit || "chưa ghi"}, working tree modified ${load.workingTreeModified ?? "chưa ghi"}.`
  : "NOT RUN: chưa có load-relay.json; không sử dụng số liệu cũ thay kết quả hiện tại.";
const markdown = (await readFile(join(docs, "report.md"), "utf8"))
  .replace("{{EVIDENCE_SUMMARY}}", evidence)
  .replace("{{LOAD_SUMMARY}}", measured);
const escape = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const inline = (text) =>
  escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2">$1</a>');
const lines = markdown.split(/\r?\n/),
  html = [];
for (let index = 0; index < lines.length;) {
  const line = lines[index];
  if (!line.trim()) {
    index++;
    continue;
  }
  if (line.startsWith("```")) {
    const code = [];
    index++;
    while (index < lines.length && !lines[index].startsWith("```"))
      code.push(lines[index++]);
    index++;
    html.push(`<pre>${escape(code.join("\n"))}</pre>`);
    continue;
  }
  const heading = line.match(/^(#{1,6}) (.*)/);
  if (heading) {
    html.push(
      `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`,
    );
    index++;
    continue;
  }
  const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (image) {
    html.push(
      `<figure><img src="${escape(image[2])}"><figcaption>${inline(image[1])}</figcaption></figure>`,
    );
    index++;
    continue;
  }
  if (line.startsWith("|")) {
    const rows = [];
    while (index < lines.length && lines[index].startsWith("|")) {
      const row = lines[index++];
      if (/^\|[- :|]+\|$/.test(row)) continue;
      rows.push(
        row
          .slice(1, -1)
          .split("|")
          .map((value) => value.trim()),
      );
    }
    html.push(
      `<table>${rows.map((row, i) => `<tr>${row.map((cell) => `<${i ? "td" : "th"}>${inline(cell)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`,
    );
    continue;
  }
  if (line.startsWith("- ")) {
    const items = [];
    while (index < lines.length && lines[index].startsWith("- "))
      items.push(`<li>${inline(lines[index++].slice(2))}</li>`);
    html.push(`<ul>${items.join("")}</ul>`);
    continue;
  }
  const paragraph = [];
  while (
    index < lines.length &&
    lines[index].trim() &&
    !/^(#|\||```|!\[|- )/.test(lines[index])
  )
    paragraph.push(lines[index++]);
  html.push(`<p>${inline(paragraph.join(" "))}</p>`);
}
const document = `<!doctype html><html lang="vi"><meta charset="UTF-8"><title>DS01 P2P Chat — Báo cáo kỹ thuật dự thảo</title><style>@page{size:A4;margin:18mm 17mm}body{font:11pt/1.7 'Segoe UI',Arial,sans-serif;color:#263b31;max-width:190mm;margin:auto}h1{font-size:27pt;line-height:1.3;color:#246b50;border-bottom:3px solid #719b77;padding-bottom:18px;margin-top:30px}h2{font-size:17pt;line-height:1.4;margin-top:28px;border-bottom:1px solid #d8e4d5;padding-bottom:9px;break-after:avoid}h3{font-size:13pt;break-after:avoid}p{text-align:justify;margin:11px 0}table{width:100%;border-collapse:collapse;font-size:9pt;margin:15px 0}th,td{border:1px solid #d6e0d1;padding:7px;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3e8;text-align:left}tr{break-inside:avoid}a{color:#276b50}code,pre{font-family:Consolas,monospace;font-size:9pt;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#eff3eb;padding:14px;border-radius:6px}figure{margin:20px 0;break-inside:avoid}img{max-width:100%;max-height:130mm;object-fit:contain;border:1px solid #dce4d8}figcaption{font-size:9pt;color:#718568;text-align:center}li{margin-bottom:7px}</style><body>${html.join("\n")}</body></html>`;
await writeFile(join(docs, "report.html"), document);
const chrome =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].find(existsSync);
if (!chrome)
  throw Error(
    "HTML created. Set CHROME_PATH or print docs/report.html to PDF manually.",
  );
const profile = resolve(join(root, ".data", `report-${randomUUID()}`));
await mkdir(profile, { recursive: true });
try {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--single-process",
      "--disable-gpu",
      "--no-first-run",
      "--no-pdf-header-footer",
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${join(docs, "report.pdf")}`,
      pathToFileURL(join(docs, "report.html")).href,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let error = "";
  child.stderr.on("data", (bytes) => (error += bytes));
  const timer = setTimeout(() => child.kill(), 40000);
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  clearTimeout(timer);
  const pdf = await readFile(join(docs, "report.pdf"));
  if (code !== 0 || pdf.length < 1000)
    throw Error("PDF render failed: " + error.slice(-1500));
  console.log(
    "Created docs/report.html and docs/report.pdf. Technical DRAFT: complete real group information and WAN evidence before submission.",
  );
} finally {
  if (
    dirname(profile) === resolve(root, ".data") &&
    basename(profile).startsWith("report-")
  )
    await rm(profile, { recursive: true, force: true }).catch(() => {});
}
