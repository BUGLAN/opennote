#!/usr/bin/env node
/**
 * 真机验证：**元素选择**（00 §6.15㉝ / 03 §UI-16）。零依赖：只用 node:http / node:child_process +
 * Node 22 自带的 fetch 与全局 WebSocket。
 *
 * 为什么必须走 CDP：Chrome 137+ 起命令行的 `--load-extension` 对未打包扩展不再生效，
 * 只能靠 `Extensions.loadUnpacked`（需要 `--enable-unsafe-extension-debugging`）。
 *
 * 观察链（每步打印 PASS/FAIL，不改被测代码；任何一步 FAIL 都会如实打印，绝不写成 PASS）：
 *   1. 起本地 demo 页（node:http，127.0.0.1:8799）+ 专用 Chrome（CDP 127.0.0.1:9346，headless=new）
 *   2. `Extensions.loadUnpacked` 装载 `dist`，从 service worker target 认出扩展 id
 *   3. `Extensions.triggerAction` 弹出**真 popup**
 *   4. 在 popup 真 DOM 里点 `#pick`
 *   5. 页面里必须出现 `#opennote-pick-host`：position:fixed / pointer-events:none / closed 影子根
 *   6. `Input.dispatchMouseEvent` 在正文段落上真点一下（mousePressed + mouseReleased）
 *   7. 覆盖层必须已移除；`chrome.storage.local` 里必须出现 `picked`：tagName=p、
 *      Markdown 含被点段落、**不含**侧栏/页脚（证明没有退回整页抽取）
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 环境缺失（没装 Chrome / 没 build）。
 * 用法：`node build.mjs ; node tools/cdp-pick-check.mjs`
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = "E:\\repo\\opennote\\extension\\dist";
const PORT = 9346;
const DEMO_PORT = 8799;
const STATE_KEY = "opennote.clip.state.v1";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
].filter(Boolean);

const DEMO_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>元素选择真机 demo</title></head>
<body><header><h1>示例站</h1></header>
<main><article id="target"><h2>中文排版指北</h2>
<p id="para">这一段是要被点中的正文段落，用来验证元素选择能把「元素及子树」抽成 Markdown。</p>
<p>第二段：行内 <code>code</code> 与 <a href="https://example.com/x">链接</a> 也要保留。</p>
</article><aside><p>侧栏噪声</p></aside></main>
<footer><p>页脚</p></footer></body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startDemo() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(DEMO_HTML);
  });
  return new Promise((resolve) => server.listen(DEMO_PORT, "127.0.0.1", () => resolve(server)));
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

async function httpJson(path) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
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
        if (message.error) fail(new Error(`${message.error.message} ${JSON.stringify(message.error.data || "")}`));
        else done(message.result);
      }
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
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
            }, 20000);
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

let failed = 0;
function observe(ok, label, extra) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` —— ${extra}`}`);
}

async function waitFor(check, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

/** 从扩展的 service worker target 里读 `opennote.clip.state.v1`。 */
async function readStoredPick(extId) {
  const targets = await httpJson("/json/list");
  const worker = targets.find((target) => target.type === "service_worker" && target.url.includes(extId));
  if (!worker) return null;
  const session = await connect(worker.webSocketDebuggerUrl);
  try {
    return await evaluate(session, `new Promise((resolve) => {
      chrome.storage.local.get(${JSON.stringify(STATE_KEY)}, (bag) => {
        const item = bag && bag[${JSON.stringify(STATE_KEY)}] && bag[${JSON.stringify(STATE_KEY)}].picked;
        resolve(item && item.picked ? item : null);
      });
    })`);
  } finally {
    session.close();
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error("找不到 Chrome，无法跑真机验证（本项记 UNVERIFIED）");
    process.exit(2);
  }
  if (!existsSync(DIST)) {
    console.error(`dist 不存在：${DIST}（先跑 node build.mjs）`);
    process.exit(2);
  }

  const demo = await startDemo();
  // 端口自检：如果 9346 已经有 Chrome 在答，说明是**上一轮遗留**的实例，
  // 那我们看到的 target / 扩展都是旧的 —— 这种结果不可信，必须直接中止（不打印红绿）。
  const stale = await httpJson("/json/version").catch(() => null);
  if (stale) {
    demo.close();
    console.error(`CDP 端口 ${PORT} 已被另一个 Chrome 占用（${stale.Browser}）。那是上一轮遗留的实例，本次结果不可信，已中止（退出码 2）。`);
    console.error(`先结束它再跑：Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force`);
    process.exit(2);
  }
  const profile = mkdtempSync(join(tmpdir(), "opennote-pick-"));
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      `http://127.0.0.1:${DEMO_PORT}/demo`,
    ],
    { stdio: "ignore", detached: false },
  );

  let browser = null;
  let page = null;
  let popup = null;
  try {
    const version = await waitFor(() => httpJson("/json/version"), 30000);
    observe(Boolean(version), "Chrome 起来了（CDP /json/version）", version && version.Browser);
    if (!version) return;

    browser = await connect(version.webSocketDebuggerUrl);
    const loaded = await browser
      .send("Extensions.loadUnpacked", { path: DIST })
      .catch((error) => ({ error: error.message }));
    observe(!loaded.error, "Extensions.loadUnpacked 装载 dist", loaded.error || JSON.stringify(loaded));
    if (loaded.error) return;
    // 只认**我们刚装载的这个**扩展：浏览器里还有 Chrome 自带的组件扩展（也是 chrome-extension://…/service_worker.js）
    const extId = loaded.id;
    console.log(`     扩展 id = ${extId}`);

    const listed = await waitFor(async () => {
      const targets = await httpJson("/json/list");
      const worker = targets.find((target) => typeof target.url === "string" && target.url.includes(`chrome-extension://${extId}/`));
      const demoPage = targets.find((target) => target.type === "page" && target.url.includes(`127.0.0.1:${DEMO_PORT}`));
      return worker && demoPage ? { worker, demoPage } : null;
    }, 30000);
    if (!listed) {
      // 如实打印现场：target 列表长什么样（诊断用，不改变结论）
      const targets = await httpJson("/json/list");
      console.log("     target 现场：" + targets.map((target) => `${target.type} ${target.url}`).join(" | "));
    }
    observe(Boolean(listed), "MV3 service worker 起在浏览器里（扩展真的被装载）", listed && listed.worker.url);
    if (!listed) return;
    page = await connect(listed.demoPage.webSocketDebuggerUrl);

    // `Extensions.triggerAction` 要的是 **tab target** 的 id（page target 的 id 不是它）
    const tabs = await browser.send("Target.getTargets", { filter: [{ type: "tab" }] }).catch(() => ({ targetInfos: [] }));
    const tabInfos = tabs.targetInfos || [];
    const tab =
      tabInfos.find((info) => String(info.url || "").includes(`127.0.0.1:${DEMO_PORT}`)) ||
      (tabInfos.length === 1 ? tabInfos[0] : null);
    if (!tab) {
      console.log(`     tab target 现场：${tabInfos.map((info) => `${info.targetId} ${info.url}`).join(" | ") || "(空)"}`);
    }
    const triggered = await browser
      .send("Extensions.triggerAction", { id: extId, targetId: (tab && tab.targetId) || listed.demoPage.id })
      .catch((error) => ({ error: error.message }));
    if (triggered.error) console.log(`     注意：triggerAction 报错 ${triggered.error}`);
    const popupTarget = await waitFor(async () => {
      const targets = await httpJson("/json/list");
      return targets.find((target) => target.type === "page" && target.url.includes(`chrome-extension://${extId}/popup/popup.html`));
    }, 15000);
    observe(Boolean(popupTarget), "扩展图标触发出真 popup（不是本地 HTML 预览）", popupTarget && popupTarget.url);
    if (!popupTarget) return;
    popup = await connect(popupTarget.webSocketDebuggerUrl);

    const pickLabel = await waitFor(
      () => evaluate(popup, `(() => { const b = document.getElementById("pick"); return b && b.textContent; })()`),
      15000,
    );
    observe(pickLabel === "选择页面元素", "popup 的 L2 入口逐字 = 选择页面元素", pickLabel);
    if (pickLabel !== "选择页面元素") return;
    await evaluate(popup, `document.getElementById("pick").click()`);

    const host = await waitFor(
      () =>
        evaluate(page, `(() => {
          const el = document.getElementById("opennote-pick-host");
          if (!el) return null;
          const style = getComputedStyle(el);
          return {
            position: style.position,
            zIndex: style.zIndex,
            pointerEvents: style.pointerEvents,
            shadow: el.shadowRoot === null ? "closed" : "open",
          };
        })()`),
      15000,
    );
    observe(Boolean(host), "页面上出现元素选择覆盖层 #opennote-pick-host", host && JSON.stringify(host));
    if (!host) return;
    observe(
      host.position === "fixed" && host.pointerEvents === "none" && host.shadow === "closed",
      "覆盖层 = position:fixed / pointer-events:none / closed 影子根",
      JSON.stringify(host),
    );

    const point = await evaluate(page, `(() => {
      const rect = document.getElementById("para").getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    }

    const entry = await waitFor(() => readStoredPick(extId), 25000);
    observe(Boolean(entry), "点一下之后选择结果落进 chrome.storage.local（picked）",
      entry && `tagName=${entry.tagName} chars=${entry.chars} selector=${entry.selector}`);
    if (entry) {
      observe(entry.tagName === "p", "抽到的元素 = 被点中的那个 <p>", entry.tagName);
      const markdown = String(entry.markdown || "");
      observe(markdown.includes("这一段是要被点中的正文段落"), "正文 Markdown 真的来自点中的那块", `${markdown.length} 字符`);
      observe(
        !markdown.includes("侧栏噪声") && !markdown.includes("页脚"),
        "没有把侧栏/页脚带进来（没有退回整页抽取）",
      );
    }

    const gone = await waitFor(() => evaluate(page, `!document.getElementById("opennote-pick-host")`), 10000);
    observe(Boolean(gone), "点完覆盖层已移除（页面上不留节点）");
  } finally {
    if (popup) popup.close();
    if (page) page.close();
    if (browser) browser.close();
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
    demo.close();
  }

  console.log(failed === 0 ? "\n元素选择真机验证：全部 PASS" : `\n元素选择真机验证：${failed} 项 FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`真机验证中断：${error.message}`);
  process.exit(1);
});
