/**
 * 页面内桥的真机验证（诊断工具，不是门禁，永远 exit 0 —— 与 `cdp-pick-check.mjs` 同规）。
 *
 * 它只回答两个**机器能验**的问题，其余边界如实写在 `README.md` §15：
 *
 *   A. **检测**：真 Chrome 里同时开着「网页版 Opennote」和一张普通文章页时，popup 底栏
 *      在主按钮**上方**长出 `#webPrimary`，文案逐字是 `剪藏到 127.0.0.1:4173`（域名取自那个标签页）。
 *   B. **协议**：把**真注入函数**（`content/inpage-bridge.js` 的 `deliverInpage`，通过
 *      `chrome.scripting.executeScript({func})` 注入到真网页版标签页）跑一遍，收到页面回来的
 *      结构化回执。这一条是整条通道里唯一有平台不确定性的地方 —— 内容脚本的
 *      `window.postMessage` 必须真的被页面的监听器收到（官方文档说可以，但那是文档，不是证据）。
 *
 * 跑法：
 * ```powershell
 * node build.mjs
 * cd .. ; npx vite build        # 真网页版产物（dist/）
 * cd extension
 * node tools\cdp-inpage-check.mjs
 * ```
 *
 * 为什么 B 不用 popup 上的那颗按钮：点它会先弹一次 `chrome.permissions.request` 的**浏览器气泡**，
 * 而 CDP 点不了浏览器 UI（与 `cdp-pick-check.mjs` 头部记的 `T-11` 同一类边界）。所以 B 走
 * 「让网页版标签页成为活动标签页 → 触发 action 拿到 activeTab → 注入真函数」，绕开气泡，
 * 验的仍然是同一条 postMessage 通道。
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const EXT_DIR = "E:\\repo\\opennote\\extension";
const DIST = join(EXT_DIR, "dist");
const APP_DIST = "E:\\repo\\opennote\\dist";
const PORT = 9347;
const APP_PORT = 4173;
const DEMO_PORT = 8799;
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}/`;

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
].filter(Boolean);

const DEMO_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>网页版通道真机 demo</title></head>
<body><main><article><h1>被剪的那一页</h1>
<p>这一段是普通网页上的正文，用来验证「剪藏到 &lt;域名&gt;」那颗按钮真的出现在底栏上。</p>
</article></main></body></html>`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 真网页版产物（`dist/`）的静态服务：SPA 只有一个入口，未知路径一律回 index.html。 */
function startApp() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", APP_URL);
    let file = join(APP_DIST, decodeURIComponent(url.pathname));
    if (!existsSync(file) || url.pathname.endsWith("/")) file = join(APP_DIST, "index.html");
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(APP_PORT, "127.0.0.1", () => resolve(server)));
}

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

/** 极简 CDP 会话（与 `cdp-pick-check.mjs` 同款实现）。 */
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
  if (result.exceptionDetails) throw new Error(`上下文里抛错：${result.exceptionDetails.text}`);
  return result.result.value;
}

let failed = 0;
function observe(ok, label, extra) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  —— ${extra}` : ""}`);
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

/** 找 target（`/json/list` 里 page / service_worker 的 url 都是真实地址）。 */
async function targets() {
  return httpJson("/json/list");
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error("找不到 Chrome，本项记 UNVERIFIED");
    process.exit(2);
  }
  if (!existsSync(DIST)) {
    console.error(`扩展产物不存在：${DIST}（先跑 node build.mjs）`);
    process.exit(2);
  }
  if (!existsSync(join(APP_DIST, "index.html"))) {
    console.error(`网页版产物不存在：${APP_DIST}（先在仓库根跑 npx vite build）`);
    process.exit(2);
  }
  const stale = await httpJson("/json/version").catch(() => null);
  if (stale) {
    console.error(`CDP 端口 ${PORT} 已被另一个 Chrome 占用（${stale.Browser}），本次结果不可信，已中止（退出码 2）。`);
    process.exit(2);
  }

  const app = await startApp();
  const demo = await startDemo();
  const profile = mkdtempSync(join(tmpdir(), "opennote-inpage-"));
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
      APP_URL,
    ],
    { stdio: "ignore", detached: false },
  );

  let browser = null;
  try {
    const version = await waitFor(() => httpJson("/json/version"), 30000);
    observe(Boolean(version), "Chrome 起来了（CDP /json/version）", version && version.Browser);
    if (!version) return;
    browser = await connect(version.webSocketDebuggerUrl);

    const loaded = await browser.send("Extensions.loadUnpacked", { path: DIST }).catch((error) => ({ error: error.message }));
    observe(!loaded.error, "Extensions.loadUnpacked 装载扩展", loaded.error || loaded.id);
    if (loaded.error) return;
    const extId = loaded.id;

    // 网页版标签页（第一个）与 demo 页（新开一个）
    await browser.send("Target.createTarget", { url: DEMO_URL });
    const listed = await waitFor(async () => {
      const all = await targets();
      const worker = all.find((target) => target.type === "service_worker" && target.url.includes(`chrome-extension://${extId}/`));
      const appPage = all.find((target) => target.type === "page" && target.url.startsWith(APP_URL));
      const demoPage = all.find((target) => target.type === "page" && target.url.startsWith(DEMO_URL));
      return worker && appPage && demoPage ? { worker, appPage, demoPage } : null;
    }, 30000);
    observe(Boolean(listed), "MV3 service worker + 网页版标签页 + demo 标签页都在场", listed && listed.worker.url);
    if (!listed) return;

    const tabInfos = async () => ((await browser.send("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos || []);
    const activate = async (matcher) => {
      const tabs = (await tabInfos()).filter(matcher);
      const tab = tabs[tabs.length - 1];
      if (!tab) return null;
      await browser.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => undefined);
      await sleep(300);
      return tab;
    };

    /* ── A. 检测：普通文章页上 popup 必须出现网页版按钮 ───────────────── */

    const demoSession = await connect(listed.demoPage.webSocketDebuggerUrl);
    await demoSession.send("Runtime.enable").catch(() => undefined);
    await evaluate(demoSession, "document.title");

    const demoTab = await activate((tab) => tab.url.startsWith(DEMO_URL));
    observe(Boolean(demoTab), "把 demo 标签页设为活动标签页", demoTab && demoTab.targetId);
    if (!demoTab) return;
    await browser.send("Extensions.triggerAction", { id: extId, targetId: demoTab.targetId }).catch((error) => ({ error: error.message }));
    const popupTarget = await waitFor(async () => {
      const all = await targets();
      return all.find((target) => target.type === "page" && target.url.includes(`chrome-extension://${extId}/popup/popup.html`)) || null;
    }, 15000);
    observe(Boolean(popupTarget), "扩展图标触发出真 popup", popupTarget && popupTarget.url);
    if (!popupTarget) return;
    const popup = await connect(popupTarget.webSocketDebuggerUrl);
    await popup.send("Runtime.enable").catch(() => undefined);

    const webButton = await waitFor(async () => {
      const value = await evaluate(
        popup,
        `(() => { const b = document.getElementById("webPrimary");
           if (!b) return null;
           const rect = b.getBoundingClientRect();
           const primary = document.getElementById("primary").getBoundingClientRect();
           return { hidden: b.hidden, text: b.textContent.trim(), top: Math.round(rect.top), primaryTop: Math.round(primary.top), height: Math.round(rect.height) }; })()`,
      );
      return value && !value.hidden ? value : null;
    }, 15000);
    observe(Boolean(webButton), "popup 底栏出现 #webPrimary（检测到网页版标签页）", webButton && webButton.text);
    observe(webButton?.text === `剪藏到 127.0.0.1:${APP_PORT}`, "按钮文案逐字 = 剪藏到 127.0.0.1:4173（域名取自被检测到的标签页）", webButton?.text);
    observe(
      Boolean(webButton) && webButton.top < webButton.primaryTop,
      "#webPrimary 在主按钮**上方**（用户要求的位置）",
      webButton ? `web top=${webButton.top} < primary top=${webButton.primaryTop}` : undefined,
    );

    /*
     * A2. **真点一下那颗按钮**（0.2.1 修的缺陷的回归判据）。
     *
     * 0.2.0 把 `chrome.permissions.request` 放在了 service worker 里，而手势不会跨进程传过去，
     * 于是用户点下去**一次气泡都没弹过**就立刻看到 `IMP-3001`「没有获得访问 <域名> 的权限」。
     * 这里用 CDP 的 `Input.dispatchMouseEvent` 发一次**可信点击**（合成 `element.click()`
     * 不带手势，验不出这条），然后断言 1.2 秒内界面**没有**出现那句立刻失败。
     *
     * 实测（0.2.1，Chrome 154）：点下去后按钮变成「正在剪藏…」、`data-busy=true` —— 那就是
     * 「申请真的发出去了、正在等浏览器气泡」的证据（headless 不弹气泡，所以它会一直等）。
     * 0.2.0 的现场则是 1.2 秒内直接出现 IMP-3001 那句话，这条断言会当场红。
     *
     * 气泡本身 CDP 点不了（浏览器级 UI），所以「点允许 → 入库」那一步仍归人工（见 README §4.2）。
     */
    if (webButton) {
      /*
       * 瞄准必须**当场复核**：popup 打开后还会异步重绘一次（`refreshPreview()` 回包后
       * `render()`），底栏整体会上下移动几十像素。第一次写这个探针时按「刚测到的 rect」
       * 点击，结果落在了移动过来的 `#primary` 上（点击现场显示的是主按钮那条路线的
       * `IMP-2001`，而不是网页版通道）—— 所以这里用 `elementFromPoint()` 确认指针底下
       * 真的是 `#webPrimary` 再点，点不到就重测（最多 8 次）。
       */
      let aim = null;
      for (let attempt = 0; attempt < 8 && !aim; attempt += 1) {
        const spot = await evaluate(
          popup,
          `(() => {
             // headless 的 popup 视口只有约 510px 高，底栏会被挤到折线以下；先滚到底再瞄，
             // 否则 elementFromPoint 在视口外返回 null，探针根本点不到按钮（实测 8 次全落空）。
             window.scrollTo(0, document.documentElement.scrollHeight);
             const body = document.querySelector(".clip__body");
             if (body) body.scrollTop = body.scrollHeight;
             const b = document.getElementById("webPrimary");
             if (!b || b.hidden) return null;
             const r = b.getBoundingClientRect();
             const x = Math.round(r.left + r.width / 2); const y = Math.round(r.top + r.height / 2);
             const el = document.elementFromPoint(x, y);
             return { x, y, rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
                      at: el ? el.tagName + "#" + (el.id || "") + "." + String(el.className || "").slice(0, 24) : null,
                      inner: { w: window.innerWidth, h: window.innerHeight },
                      isWeb: Boolean(el && (el.id === "webPrimary" || el.closest("#webPrimary"))) }; })()`,
        ).catch(() => null);
        if (attempt === 0) console.log("     探针 · 瞄准现场：" + JSON.stringify(spot));
        if (spot && spot.isWeb) aim = spot;
        else await sleep(300);
      }
      observe(Boolean(aim), "指针当场落在 #webPrimary 上（不是被重绘挪走后的别处）", aim ? `(${aim.x}, ${aim.y})` : "8 次都没瞄准到按钮");
      if (!aim) {
        popup.close();
        return;
      }
      await popup.send("Input.dispatchMouseEvent", { type: "mousePressed", x: aim.x, y: aim.y, button: "left", clickCount: 1 });
      await popup.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: aim.x, y: aim.y, button: "left", clickCount: 1 });
      await sleep(1200);
      const after = await evaluate(
        popup,
        `(() => { const clip = document.getElementById("clip");
           const block = document.querySelector(".clip__block");
           return { state: clip ? clip.dataset.state : null, busy: clip ? clip.dataset.busy : null,
                    chip: (document.getElementById("chipText") || {}).textContent || null,
                    tokenRow: (() => { const t = document.getElementById("tokenRow"); return t ? !t.hidden : null; })(),
                    web: (() => { const w = document.getElementById("webPrimary"); return w ? { hidden: w.hidden, text: w.textContent.trim() } : null; })(),
                    primary: (() => { const p = document.getElementById("primary"); return p ? { hidden: p.hidden, text: p.textContent.trim(), disabled: p.disabled } : null; })(),
                    body: (document.getElementById("region") || {}).innerText ? document.getElementById("region").innerText.slice(0, 120) : "",
                    text: block ? block.textContent.trim().slice(0, 80) : "" }; })()`,
      ).catch(() => null);
      console.log("     探针 · 点击后现场：" + JSON.stringify(after));
      observe(
        !after || !after.text.includes("没有获得访问"),
        "点一下按钮不会当场报「没有获得访问…的权限」（0.2.0 的缺陷）",
        after ? `state=${after.state} busy=${after.busy} block="${after.text}"` : "popup 已关闭（气泡抢焦点）—— 见 README §4.2 边界",
      );
    }
    popup.close();

    /* ── B. 协议：真注入函数 × 真网页版页面 ───────────────────────────── */

    const workerSession = await connect(listed.worker.webSocketDebuggerUrl);
    await workerSession.send("Runtime.enable").catch(() => undefined);
    // 临时监听器：把注入脚本回传的报告存到 SW 的全局上（`opennote:inpage-report` 不落任何存储）
    await evaluate(
      workerSession,
      `(() => { globalThis.__probe = null;
        chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "opennote:inpage-report") globalThis.__probe = m; });
        return true; })()`,
    );

    const appTab = await activate((tab) => tab.url.startsWith(APP_URL));
    observe(Boolean(appTab), "把网页版标签页设为活动标签页（拿到 activeTab 授权）", appTab && appTab.targetId);
    if (!appTab) return;
    // 触发一次 action：`activeTab` 只在用户手势那一刻授予，而 executeScript 需要它
    await browser.send("Extensions.triggerAction", { id: extId, targetId: appTab.targetId }).catch(() => undefined);
    const appPopupTarget = await waitFor(async () => {
      const all = await targets();
      return all.find((target) => target.type === "page" && target.url.includes(`chrome-extension://${extId}/popup/popup.html`)) || null;
    }, 15000);
    observe(Boolean(appPopupTarget), "在网页版标签页上再触发一次 popup（拿用户手势与 activeTab）", appPopupTarget && appPopupTarget.url);
    if (!appPopupTarget) return;

    /*
     * 注入从 **popup** 发起，而不是 service worker：MV3 的 SW 是 ServiceWorkerGlobalScope，
     * 那里 `import()` 被 HTML 规范明令禁止（实测报 `import() is disallowed on
     * ServiceWorkerGlobalScope`），拿不到真模块；扩展页面（popup）里可以。
     */
    const appPopup = await connect(appPopupTarget.webSocketDebuggerUrl);
    await appPopup.send("Runtime.enable").catch(() => undefined);
    const injected = await evaluate(
      appPopup,
      `(async () => {
         const mod = await import(chrome.runtime.getURL("content/inpage-bridge.js"));
         const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
         if (!tab || tab.id === undefined) return "没有活动标签页";
         try {
           await chrome.scripting.executeScript({
             target: { tabId: tab.id },
             func: mod.deliverInpage,
             args: [{ reqId: "probe-inpage-1",
                      readyMs: 300, resultMs: 5000,
                      envelope: { spec: "opennote.import/v1", importId: "probe-inpage-1",
                                  title: "页面内桥探针", body: "探针正文", tags: [],
                                  source: { url: "https://example.com/probe", capturedAt: "2026-10-07T00:00:00+08:00" } } }],
           });
           return "已注入";
         } catch (error) { return "注入失败：" + (error && error.message); }
       })()`,
    );
    observe(injected === "已注入", "把真注入函数 executeScript 进网页版标签页", injected);
    appPopup.close();

    const report = await waitFor(() => evaluate(workerSession, "globalThis.__probe"), 12000);
    observe(Boolean(report), "注入脚本把回执交回了 service worker（跨世界 postMessage 通了）", report && JSON.stringify(report).slice(0, 160));
    /*
     * 这一条是整个探针的**核心判据**：
     *   - `report.local === false` ⇒ 回执来自**页面**（hello→ready→import→result 四步全通），
     *     而不是注入脚本自己超时/握手失败（那两路是 `local: true`）；
     *   - `error.code === "IMP-4007"` ⇒ 那句話出自**应用侧接收端**（这个新 profile 里没有打开笔记本），
     *     说明页面里的 `inpageBridge` 真的跑到了 `receiveEnvelopeOutcome()`。
     */
    observe(report?.local === false, "回执来自页面而不是注入脚本的本地失败（四步握手全通）", report && `local=${report.local}`);
    observe(report?.ok === false && report?.error?.code === "IMP-4007", "页面侧的入库结果如实返回（IMP-4007：没有打开笔记本）", report && report.error && `${report.error.code} ${report.error.userMessage}`);
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* 关不掉就算了：下面还会 kill 进程 */
    }
    child.kill();
    app.close();
    demo.close();
  }
}

await main();
console.log(failed === 0 ? "\n网页版通道真机验证：全部 PASS" : `\n网页版通道真机验证：${failed} 项 FAIL`);
process.exit(0);
