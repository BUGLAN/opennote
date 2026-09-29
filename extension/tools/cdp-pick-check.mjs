#!/usr/bin/env node
/**
 * 真机验证：**元素选择**（00 §6.15㉝ / 03 §UI-16）。
 *
 * 为什么必须走 CDP：Chrome 137+ 起命令行的 `--load-extension` 对未打包扩展不再生效，
 * 只能靠 `Extensions.loadUnpacked`（需要 `--enable-unsafe-extension-debugging`）。
 *
 * 这个脚本只做**观察**，不改动被测代码：
 *   1. 起一个专用 Chrome（CDP 端口 9346）+ 一个本地 demo 页面（node:http，零依赖）；
 *   2. CDP 装载 `dist`，`Extensions.triggerAction` 弹出真 popup；
 *   3. 在 popup 的真 DOM 里点 `#pick`（真 click 事件）；
 *   4. 等页面目标里出现 `opennote-pick-host`，读它的计算样式与影子根状态；
 *   5. CDP `Input.dispatchMouseEvent` 在正文段落上真点一下；
 *   6. 读页面：覆盖层必须**已移除**；读 service worker 的 `chrome.storage.local`：必须出现 `picked`。
 *
 * 退出码 0 = 全部观察点通过；非 0 = 有一步没观察到（把看到的东西原样打出来）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = "E:\\repo\\opennote\\extension\\dist";
const PORT = 9346;
const DEMO_PORT = 8799;

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
].filter(Boolean);

const DEMO_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>元素选择真机 demo</title></head>
<body><header><h1>示例站</h1></header>
<main><article id="target"><h2>中文排版指北</h2>
<p>这一段是要被点中的正文段落，用来验证元素选择能把「元素及子树」抽成 Markdown。</p>
<p>第二段：行内 <code>code</code> 与 <a href="https://example.com/x">链接</a> 也要保留。</p>
</article><aside><p>侧栏噪声</p></aside></main>
<footer><p>页脚</p></footer></body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startDemo() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(DEMO_HTML);
  });
  return new Promise((resolve) => server.listen(DEMO_PORT, "127.0.0.1", () => resolve(server)));
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

async function cdp(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return response.json();
}

/** 极简 CDP 会话：连一个 target 的 webSocketDebuggerUrl，发命令、收结果。 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && waiting.has(message.id)) {
        const { resolve: done, reject: fail } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) fail(new Error(`${message.error.message} (${JSON.stringify(message.error.data || "")})`));
        else done(message.result);
      }
    });
    socket.addEventListener("error", (event) => reject(new Error(`WebSocket 错误：${event.message || "unknown"}`)));
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const messageId = ++id;
          return new Promise((done, fail) => {
            waiting.set(messageId, { resolve: done, reject: fail });
            socket.send(JSON.stringify({ id: messageId, method, params }));
            setTimeout(() => {
              if (waiting.has(messageId)) {
                waiting.delete(messageId);
                fail(new Error(`CDP 超时：${method}`));
              }
            }, 15000);
          });
        },
        close() {
          socket.close();
        },
      }),
    );
  });
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`页面里抛错：${result.exceptionDetails.text}`);
  return result.result.value;
}

const observations = [];
function observe(ok, label, extra) {
  observations.push({ ok, label, extra });
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` —— ${extra}` : ""}`);
}

async function main() {
  const chrome = await findChrome();
  if (!chrome) {
    console.error("找不到 Chrome，跳过真机验证（本项在报告里记 UNVERIFIED）");
    process.exit(2);
  }
  if (!existsSync(DIST)) {
    console.error(`dist 不存在：${DIST}（先跑 node build.mjs）`);
    process.exit(2);
  }
  const demo = await startDemo();
  const profile = mkdtempSync(join(tmpdir(), "opennote-pick-"));
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DialMediaRouteProvider",
      `http://127.0.0.1:${DEMO_PORT}/demo`,
    ],
    { stdio: "ignore", detached: false },
  );

  let version = null;
  for (let i = 0; i < 40 && !version; i += 1) {
    try {
      version = await cdp(PORT, "/json/version");
    } catch {
      await sleep 
    }
  }
  console.log(JSON.stringify(version));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
