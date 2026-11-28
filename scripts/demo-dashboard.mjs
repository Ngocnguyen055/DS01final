import { createServer } from "node:http";

const page = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DS01 — Quan sát demo</title><link rel="stylesheet" href="/dashboard.css"><script src="/dashboard.js" defer></script></head><body><main><h1>DS01 · Quan sát demo</h1><p>Màn hình này chỉ mở trên máy chạy server. Dùng các URL Web để kết nối A, B, C từ thiết bị khác.</p><p id="status" role="status">Đang tải…</p><section id="links"></section><h2>Tiến trình độc lập</h2><table><thead><tr><th>Thành phần</th><th>PID</th><th>Trạng thái</th></tr></thead><tbody id="processes"></tbody></table><h2>Nhật ký server</h2><p>Lọc theo Message ID lấy từ “Tình trạng kết nối” trên peer để đối chiếu DIRECT/RELAY. DIRECT cần log SEND/RECEIVE ở hai peer, relay hoạt động và không có FORWARD của ID đó.</p><label>Message ID hoặc nội dung log <input id="filter" placeholder="Dán Message ID…"></label><button type="button" id="pause-logs" aria-controls="logs" disabled>Tạm dừng log</button><section id="logs"></section><p id="scope"></p><p id="directory"></p></main></body></html>`;
const css = `body{font:16px system-ui;background:#eef3ef;color:#17352c;margin:0}main{max-width:1100px;margin:auto;padding:24px}h1,h2{margin-top:28px}section>div,article{background:white;padding:16px;border-radius:12px;margin:12px 0}a{color:#075c48;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;background:white}td,th{text-align:left;padding:12px;border-bottom:1px solid #d7e3dd}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin:8px 0;font:inherit}pre{background:#142b24;color:#d9efe4;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto;font-size:13px}#pause-logs{padding:8px 12px;border:1px solid #a6bdb0;border-radius:6px;background:white;color:inherit;font:inherit;cursor:pointer}#status{font-weight:bold}small{display:block;margin-top:8px}p{line-height:1.5}`;
const script = String.raw`
const byId = (id) => document.getElementById(id);
const pauseButton = byId('pause-logs');
const filterInput = byId('filter');
const panes = new Map();
let latest;
let pausedLogs;

function setPaused(paused) {
  if (!latest) return;
  pausedLogs = paused ? latest.logs : undefined;
  pauseButton.textContent = paused ? 'Tiếp tục cập nhật' : 'Tạm dừng log';
  if (!paused) renderLogs(true);
}

function renderLogs(resetScroll = false) {
  const logs = pausedLogs ?? latest?.logs ?? [];
  const filter = filterInput.value.trim();
  for (const item of logs) {
    let pane = panes.get(item.name);
    if (!pane) {
      const article = document.createElement('article');
      const title = document.createElement('h3');
      const pre = document.createElement('pre');
      title.textContent = item.name;
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', 'Nhật ký ' + item.name);
      pre.addEventListener('scroll', () => {
        if (pre.scrollTop > 0 && !pausedLogs) setPaused(true);
      });
      article.append(title, pre);
      byId('logs').append(article);
      pane = { article, pre };
      panes.set(item.name, pane);
    }
    const lines = item.text.split('\n').filter((line) => line.includes(filter));
    const text = lines.length
      ? lines.slice(-150).join('\n')
      : 'Không có dòng phù hợp trong phần log đang giữ.';
    if (pane.pre.textContent !== text) pane.pre.textContent = text;
    if (resetScroll) pane.pre.scrollTop = 0;
  }
  for (const [name, pane] of panes) {
    if (logs.some((item) => item.name === name)) continue;
    pane.article.remove();
    panes.delete(name);
  }
}

function render(state) {
  latest = state;
  pauseButton.disabled = false;
  byId('status').textContent = (state.passed ? 'Sẵn sàng' : 'Đang khởi tạo') +
    ' · ' + state.mode + ' · ' + new Date().toLocaleTimeString();
  byId('links').replaceChildren();
  for (const [name, url] of Object.entries(state.urls || {})) {
    const box = document.createElement('div');
    const label = document.createElement('strong');
    const link = document.createElement('a');
    label.textContent = name + ' · ';
    link.textContent = url;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    box.append(label, link);
    if (name !== 'web') {
      const health = document.createElement('a');
      const small = document.createElement('small');
      health.href = url + '/health';
      health.textContent = 'Mở /health';
      health.target = '_blank';
      health.rel = 'noopener noreferrer';
      small.append(health);
      box.append(small);
    }
    byId('links').append(box);
  }
  byId('processes').replaceChildren();
  for (const item of state.processes) {
    const row = document.createElement('tr');
    for (const value of [item.name, item.pid || '—', item.running ? 'Đang chạy' : 'Đã dừng']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    byId('processes').append(row);
  }
  if (!pausedLogs) renderLogs();
  byId('scope').textContent = 'Public endpoint đã kiểm tra: ' +
    (state.publicReachable ? 'có' : 'chưa') +
    '. Ba thiết bị/mạng khác nhau và NAT: cần kiểm chứng riêng. Không dùng checkbox ưu tiên relay làm bằng chứng NAT.';
  byId('directory').textContent = 'Thư mục phiên demo: ' + state.directory;
}

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw Error('Server không phản hồi');
    render(await response.json());
  } catch (error) {
    byId('status').textContent = 'Mất kết nối tới phiên demo: ' + error.message;
  }
}

filterInput.addEventListener('input', () => renderLogs(true));
pauseButton.addEventListener('click', () => setPaused(!pausedLogs));
refresh();
setInterval(refresh, 1000);
`;

export async function createDemoDashboard(getState) {
  const server = createServer((request, response) => {
    const port = server.address().port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (!allowedHosts.includes(request.headers.host)) {
      response.writeHead(403).end();
      return;
    }
    if (
      request.headers.origin &&
      !allowedHosts.some((host) => request.headers.origin === `http://${host}`)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const path = request.url?.split("?")[0];
    if (path === "/api/state") {
      const state = getState();
      const body = {
        mode: state.mode,
        passed: state.passed === true,
        publicReachable: state.publicReachable === true,
        urls: Object.fromEntries(
          Object.entries(state.urls || {}).filter(
            ([name, url]) =>
              ["web", "signal", "relay", "backup"].includes(name) &&
              typeof url === "string" &&
              /^https?:\/\//.test(url),
          ),
        ),
        directory: state.directory,
        processes: state.processes.map((item) => ({
          name: item.name,
          pid: item.pid,
          running: item.running,
        })),
        logs: state.logs.map((item) => ({
          name: item.name,
          text: item.text.slice(-60000),
        })),
      };
      response
        .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify(body));
    } else if (
      path === "/" ||
      path === "/dashboard.js" ||
      path === "/dashboard.css"
    ) {
      const [body, type] =
        path === "/"
          ? [page, "text/html"]
          : path === "/dashboard.js"
            ? [script, "text/javascript"]
            : [css, "text/css"];
      response
        .writeHead(200, { "Content-Type": `${type}; charset=utf-8` })
        .end(body);
    } else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
