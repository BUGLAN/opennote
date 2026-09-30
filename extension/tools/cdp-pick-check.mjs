#!/usr/bin/env node
/**
 * 真机验证：**元素选择**（00 §6.15㉝ / 03 §UI-16）。零依赖：只用 node:http / node:child_process +
 * Node 22 自带的 fetch 与全局 WebSocket。
 *
 * 已知边界（2026-09-30 定案）：**action popup 在 CDP 里可能处于 hidden 态被节流**
 * （`document.visibilityState === "hidden"` → 定时器不跑）—— 涉及 **popup 内交互**的路径
 * （例如「粘贴令牌 → 连接」）**不能只靠本工具判定**，它会在「产品坏了」与「工具坏了」之间骗人。
 * 该路径的结论：**CDP 环境下不可驱动；用户侧已由用户本人人工验证可用**（第三种状态，
 * 既不是「未验证」也不是「机器已验证」）。判读入口：`storeManualToken` 的 `set-token：收到`
 * 探针 + 本文件打印的 `visibilityState`。
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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = "E:\\repo\\opennote\\extension\\dist";
const PORT = 9346;
const DEMO_PORT = 8799;
const STATE_KEY = "opennote.clip.state.v1";
// 想验真实站点就传 `OPENNOTE_PICK_URL`（例如知乎那篇）；不传则用本地 demo 页
const EXTERNAL_URL = process.env.OPENNOTE_PICK_URL || "";
// 想验「有令牌 + 有预览」的完整形态就传 `OPENNOTE_PICK_TOKEN`（配合 tools/mock-bridge.mjs 起在 8795）
const PASTE_TOKEN = process.env.OPENNOTE_PICK_TOKEN || "";
const TARGET_URL = EXTERNAL_URL || `http://127.0.0.1:${DEMO_PORT}/demo`;

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
    const listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method && listeners.has(message.method)) {
        for (const handler of listeners.get(message.method)) {
          try { handler(message.params); } catch { /* 事件处理不许影响主流程 */ }
        }
      }
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
        on(method, handler) {
          if (!listeners.has(method)) listeners.set(method, []);
          listeners.get(method).push(handler);
        },
        close() {
          socket.close();
        },
      }),
    );
  });
}

/**
 * 盯住一个上下文的 console / 未捕获异常（Lead 派单③）。
 * 用户实测的卡死就是 `popup.js` 里一个 `Uncaught ReferenceError` —— 只点按钮、只看 DOM 是**看不见**它的。
 */
async function watchConsole(session, sink) {
  session.on("Runtime.exceptionThrown", (params) => {
    const d = (params && params.exceptionDetails) || {};
    sink.push(`Uncaught ${d.exception ? (d.exception.description || d.exception.value) : d.text}`);
  });
  session.on("Runtime.consoleAPICalled", (params) => {
    if (!params || params.type !== "error") return;
    const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
    sink.push(`console.error ${text}`);
  });
  session.on("Log.entryAdded", (params) => {
    const entry = (params && params.entry) || {};
    if (entry.level === "error") sink.push(`log.error ${entry.text}`);
  });
  await session.send("Runtime.enable").catch(() => {});
  await session.send("Log.enable").catch(() => {});
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

// task-29 ④⑤：视觉类改动**先复现再修** —— 截图钩子（只读，不改产品行为）。
// 注意区分两处取证面：① 的蒙层活在**页面**里（不受 popup 节流影响），④⑤ 活在 popup 里（可能只拿到空白帧）。
const SHOT_DIR = join(import.meta.dirname, "..", ".shots");
async function capture(session, name) {
  try {
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    if (!shot || !shot.data) {
      console.log(`     截图 ${name}：**拿不到帧**（data 为空）`);
      return null;
    }
    const bytes = Buffer.from(shot.data, "base64");
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = join(SHOT_DIR, `${name}.png`);
    writeFileSync(file, bytes);
    console.log(`     截图 ${name}：${file}（${bytes.length} 字节${bytes.length < 4000 ? "，疑似空白帧" : ""}）`);
    return file;
  } catch (error) {
    console.log(`     截图 ${name}：失败（${error.message}）`);
    return null;
  }
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

  const demo = EXTERNAL_URL ? { close() {} } : await startDemo();
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
      TARGET_URL,
    ],
    { stdio: "ignore", detached: false },
  );

  let browser = null;
  let page = null;
  let popup = null;
  let workerSession = null;
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
      const demoPage = targets.find((target) => target.type === "page" && target.url.startsWith(TARGET_URL.slice(0, 40)));
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
      tabInfos.find((info) => String(info.url || "").startsWith(TARGET_URL.slice(0, 40))) ||
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

    // Lead 派单③：把 popup 与 service worker 的 console 全盯住。
    // 用户实测的卡死就是 `popup.js` 里的一个 `Uncaught ReferenceError`（渲染路径抛错 → 永远停在
    // 「正在读取页面…」）—— 只点按钮、只看覆盖层的断言**看不见**它。
    const consoleProblems = [];
    await watchConsole(popup, consoleProblems);
    try {
      workerSession = await connect(listed.worker.webSocketDebuggerUrl);
      await watchConsole(workerSession, consoleProblems);
    } catch (error) {
      console.log(`     注意：service worker 的 console 没接上（${error.message}）`);
    }

    // 首帧（④ 说的「第一次打开」）：popup target 一出现就抓，此时多半还在骨架/加载态
    await popup.send("Page.enable").catch(() => {});
    await capture(popup, "popup-01-first-frame");

    // 重新加载一次 popup：**首次加载期的异常**才是要抓的那类（`bindEvents()` 中途抛错 → 后面的按钮
    // 全是死的，而 popup 看起来「正常」）。刚才那次加载发生在我们接上 console 之前，会漏掉它。
    await popup.send("Page.reload", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 断言：popup 必须在 8 秒内**离开加载态**（这是此前缺的那条 —— 它本该抓住用户看到的卡死）
    const leftLoading = await waitFor(      () =>
        evaluate(
          popup,
          `(() => { const b = document.getElementById("clip"); if (!b) return null; const t = (b.textContent || "").trim(); return t && t !== "正在读取页面…" ? t : null; })()`,
        ),
      8000,
    ).catch(() => null);
    observe(Boolean(leftLoading), "popup 在 8 秒内离开加载态（不会停在「正在读取页面…」）", leftLoading || "(仍是加载态)");
    // 稳定态（⑤ 的两按钮与「看不出选的是元素还是整页」都看这一张）
    await capture(popup, "popup-02-stable");

    const pickLabel = await waitFor(
      () => evaluate(popup, `(() => { const b = document.getElementById("pick"); return b && b.textContent; })()`),
      15000,
    );
    observe(pickLabel === "选择当前元素", "popup 的 L2 入口逐字 = 选择当前元素（M1）", pickLabel);
    if (pickLabel !== "选择当前元素") return;

    if (PASTE_TOKEN) {
      // 顺带把「粘贴令牌」这条真机链路也走一遍（此前是 UNVERIFIED）：填 → 连接 → 等落盘
      // 注意：**赋值与点击必须在同一次 evaluate 里**（中间任何一次渲染都可能把输入框清掉，
      // 那样点下去读到的就是空串 —— 这是合成事件与真人输入的差异，不是产品流程的问题）。
      const filled = await evaluate(
        popup,
        `(() => { const i = document.getElementById("tokenInput"); i.value = ${JSON.stringify(PASTE_TOKEN)}; i.dispatchEvent(new Event("input", { bubbles: true })); return i.value.length; })()`,
      );
      console.log(`     粘贴令牌：输入框长度=${filled}`);
      // 差异探针：① 事件到底有没有派发出来（我自己挂一个捕获阶段监听器数一下）
      //          ② 点完之后本地有没有立刻给反馈 ③ 换 Enter 键这条等价入口再试一次
      const probe = await evaluate(
        popup,
        `(() => {
           const b = document.getElementById("tokenSave");
           const i = document.getElementById("tokenInput");
           let hits = 0;
           b.addEventListener("click", () => { hits += 1; }, true);
           i.value = ${JSON.stringify(PASTE_TOKEN)};
           b.click();
           return { hits, valueLen: i.value.length, err: (document.getElementById("tokenError") || {}).textContent || null, errHidden: (document.getElementById("tokenError") || {}).hidden, visibility: document.visibilityState, docHidden: document.hidden, focused: document.hasFocus() };
         })()`,
      );
      // `visibility: hidden` 是 action popup 在 CDP 环境里的已知形状：**被隐藏的文档会节流定时器**，
      // 于是连工具自己的兜底都打不出来 —— 必须与「后台没被调到」区分开（看 SW console 里有没有
      // `set-token：收到`），否则会把测试环境 artifact 当成产品缺陷。
      console.log(`     差异探针（合成点击）：${JSON.stringify(probe)}`);
      const saved = await waitFor(async () => {
        const state = await evaluate(popup, `(() => { const code = document.getElementById("tokenCode"); return code && code.textContent.includes("•") ? code.textContent : null; })()`);
        return state;
      }, 15000);
      if (!saved) {
        // 失败时把现场打出来：本地预检没过？后台拒绝？还是回显没刷新？
        const diag = await evaluate(
          popup,
          `(() => ({ tokenError: (document.getElementById("tokenError") || {}).textContent || null, tokenErrorHidden: (document.getElementById("tokenError") || {}).hidden, tokenSavedHidden: (document.getElementById("tokenSaved") || {}).hidden, tokenInputRowHidden: (document.getElementById("tokenInputRow") || {}).hidden, tokenCode: (document.getElementById("tokenCode") || {}).textContent || null, notice: (document.getElementById("notice") || {}).textContent || null, region: ((document.getElementById("region") || {}).textContent || "").trim().slice(0, 60) }))()`,
        ).catch(() => null);
        console.log(`     粘贴令牌失败现场：${JSON.stringify(diag)}`);
        // 决定性证据：令牌到底进没进 chrome.storage.local（进了 = 存盘成功，只是回显没刷新）
        const stored = workerSession
          ? await workerSession
              .send("Runtime.evaluate", {
                expression: `(async () => { const s = ((await chrome.storage.local.get("opennote")).opennote) || {}; return { hasToken: Boolean(s.token), tail: s.tokenTail || null, port: s.port || null, lastOkAt: s.lastOkAt || null }; })()`,
                awaitPromise: true,
                returnByValue: true,
              })
              .then((r) => r.result && r.result.value)
              .catch(() => null)
          : null;
        console.log(`     后台实际存储：${JSON.stringify(stored)}（粘贴的令牌尾 4 位=${PASTE_TOKEN.slice(-4)}）`);
      }
      observe(Boolean(saved), "粘贴令牌 → 连接 → 只读回显", saved);
      await evaluate(popup, `document.getElementById("tokenConfirmNo").click()`).catch(() => {});
    }

    // M1（task-24）按钮①：`整页提取` 必须真的能拿到正文（不是死按钮）
    const pagePhrase = await evaluate(page, `(() => { const el = document.querySelector("h1, h2, article p, p"); return el ? el.textContent.trim().slice(0, 8) : ""; })()`).catch(() => "");
    await evaluate(popup, `document.getElementById("extractPage").click()`);
    // 判据①（不依赖令牌）：点一下必须把来源切到整页正文 —— 读 popup 自己的 `data-mode`
    const modeAfter = await waitFor(() => evaluate(popup, `(() => { const el = document.getElementById("clip"); return el && el.dataset.mode === "page" ? "page" : el && el.dataset.mode; })()`), 10000);
    observe(modeAfter === "page", "「整页提取」把来源切到整页正文（popup data-mode=page）", modeAfter);

    // 判据②（需要可用令牌）：预览区必须渲染出页面上的正文，而不是令牌块/空态
    const previewText = await waitFor(() => evaluate(popup, `(() => { const r = document.getElementById("region"); const text = r && r.textContent.trim(); return text && text.length > 10 ? text : null; })()`), 20000).catch(() => null);
    if (previewText && previewText.includes("令牌")) {
      console.log(`     （预览区当前显示的是令牌块：${previewText.slice(0, 24)}… —— 说明这次快照停在「未配置令牌」，不是正文预览）`);
    } else {
      observe(Boolean(previewText), "「整页提取」得到正文预览（不是死按钮）", previewText && previewText.slice(0, 30).replace(/\s+/g, " "));
      if (previewText) {
        observe(!previewText.includes("还没选元素"), "整页提取走的是整页正文，不是元素空态");
        observe(Boolean(pagePhrase) && previewText.includes(pagePhrase), "预览里出现的就是页面上的正文", `页面短语=${pagePhrase}`);
      }
    }

    // M1 按钮②：`选择当前元素` 仍走 ㉝ 那套（一字未改）
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
    if (!host) {
      // 取证：把 popup 里那两句（人话 + 真实错误原文）原样打出来 —— 这才是要修的东西
      const note = await evaluate(popup, `(() => { const n = document.getElementById("pickNote"); const d = document.getElementById("pickDetail"); return { note: n && n.textContent, detail: d && d.textContent, hidden: d && d.hidden }; })()`).catch(() => null);
      console.log("     popup 现场：" + JSON.stringify(note));
      return;
    }
    observe(
      host.position === "fixed" && host.pointerEvents === "none" && host.shadow === "closed",
      "覆盖层 = position:fixed / pointer-events:none / closed 影子根",
      JSON.stringify(host),
    );

    // 目标元素：本地 demo 用 #para；真实站点用「最长的正文段落」，再退到 article / body
    const point = await evaluate(page, `(() => {
      const para = document.getElementById("para");
      let el = para;
      if (!el) {
        const paras = Array.from(document.querySelectorAll("p"))
          .filter((p) => p.textContent.trim().length > 40 && p.getBoundingClientRect().height > 0)
          .sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
        el = paras[0] || document.querySelector("article") || document.querySelector("main") || document.body;
      }
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + Math.min(rect.width, 300) / 2),
        y: Math.round(Math.max(rect.top, 4) + Math.min(rect.height, 20) / 2),
        // 把「指针底下到底是哪个元素」也记下来：断言用它，而不是用猜的 target
        atPoint: (document.elementFromPoint(Math.round(rect.left + Math.min(rect.width, 300) / 2), Math.round(Math.max(rect.top, 4) + Math.min(rect.height, 20) / 2)) || el).tagName.toLowerCase(),
      };
    })()`);
    // ① 的取证面在**页面**里（不受 popup 节流影响）：先把指针移到目标上（`.op-box` 出现 = hover 态），
    // 纸色一张、夜版一张 —— 「更浅 / 被 hover 那块清晰 / 周边变淡」与「两主题都成立」都在这里判。
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await capture(page, "page-01-mask-paper");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await capture(page, "page-02-mask-night");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", clickCount: 1 });

    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    }

    // 探针（只读，不改产品）：pick 之后 popup 会不会**自己**把预览切到被点中的那块？
    // 这一步同时回答两件事：① 断言该怎么写；② 产品该不该自动刷新（挑完元素还得再点一下？）
    {
      await new Promise((r) => setTimeout(r, 1500));
      const readRegion = () => evaluate(popup, `(() => { const r = document.getElementById("region"); const c = document.getElementById("clip"); const t = (r && r.textContent.trim()) || ""; return { mode: c && c.dataset.mode, text: t, len: t.length }; })()`);
      const afterPick = await readRegion().catch(() => null);
      console.log(`     探针 · pick 之后（等 1.5s）：data-mode=${afterPick && afterPick.mode} 预览长度=${afterPick && afterPick.len} 头 30 字=${JSON.stringify(afterPick && afterPick.text.slice(0, 30))}`);
      const rawPick = await readStoredPick(extId).catch(() => null);
      console.log(`     探针 · 落盘的被选块：tagName=${rawPick && rawPick.tagName} chars=${rawPick && (rawPick.chars || String(rawPick.markdown || "").length)} 头 30 字=${JSON.stringify(String((rawPick && rawPick.markdown) || "").slice(0, 30))}`);
      await evaluate(popup, `document.getElementById("extractPage").click()`).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const afterPage = await readRegion().catch(() => null);
      console.log(`     探针 · 再点「整页提取」：data-mode=${afterPage && afterPage.mode} 预览长度=${afterPage && afterPage.len} 头 30 字=${JSON.stringify(afterPage && afterPage.text.slice(0, 30))}`);
      console.log(`     探针 · 两份预览文本相等？ ${Boolean(afterPick && afterPage && afterPick.text === afterPage.text)}`);
      // ★ 决定 P0 是否闭环的问题：**重新打开 popup** 之后的初始 mode 是什么？
      // 用户报的是「重新选择的预览和整页提取的预览是一样的」—— 他看到的必然是"重新打开后"的那一屏。
      const needle = String(((await readStoredPick(extId).catch(() => null)) || {}).markdown || "").trim().slice(0, 12);
      // 旧 target 已随 action popup 关闭而销毁（Page.navigate 会 CDP 超时）→ 必须**重新 triggerAction** 并重连
      const reErr = await browser.send("Extensions.triggerAction", { id: extId, targetId: (tab && tab.targetId) || listed.demoPage.id }).then(() => null).catch((e) => e.message);
      const popupTarget2 = await waitFor(async () => (await httpJson("/json/list")).find((t) => t.type === "page" && t.url.includes(`chrome-extension://${extId}/popup/popup.html`)), 15000);
      if (popupTarget2) popup = await connect(popupTarget2.webSocketDebuggerUrl);
      console.log(`     探针 · 重开方式：triggerAction` + (reErr ? ` 报错：${reErr}` : ` 成功`) + `；新 popup target=` + Boolean(popupTarget2));
      const entryNow = await readStoredPick(extId).catch(() => null);
      const pageUrl = ((await httpJson("/json/list")).find((t) => t.type === "page" && t.url.startsWith("http")) || {}).url || "";
      console.log(`     探针 · picked 还在？ ${Boolean(entryNow)}；entry.url=${entryNow && entryNow.url}；页面 url=${pageUrl}；相等？ ${Boolean(entryNow && entryNow.url === pageUrl)}`);
      const fresh = await waitFor(() => readRegion().then((r) => (r && r.mode ? r : null)), 20000).catch(() => null);
      console.log(`     探针 · 重新加载 popup 后：data-mode=${fresh && fresh.mode} 预览长度=${fresh && fresh.len} 头 30 字=${JSON.stringify(fresh && fresh.text.slice(0, 30))}`);
      console.log(`     探针 · 特征串 ${JSON.stringify(needle)} 出现在预览里？ ${fresh ? Boolean(needle && fresh.text.includes(needle)) : "UNKNOWN（读不到 popup）"}`);
      // 15s 探针：摘要是"稍后才填上"还是"永远不填"？这决定 ② 是瞬时态还是掩盖根因。
      let filledAt = null;
      for (let i = 1; i <= 15; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        const sample = await readRegion().catch(() => null);
        const hit = Boolean(sample && needle && sample.text.includes(needle));
        if (i % 3 === 0 || hit || i === 1) {
          console.log(`     探针 +${i}s · 长度=${sample && sample.len} 特征串在？ ${hit} 头 30 字=${JSON.stringify(sample && sample.text.slice(0, 30))}`);
        }
        if (hit) { filledAt = i; break; }
      }
      console.log(`     探针 · 15s 内摘要被填上？ ${filledAt ? `是（第 ${filledAt} 秒）` : "否（15s 仍是空/无特征串）"}`);
      if (!fresh) console.log("     探针 · 读不到 popup：可能是 action popup 被关闭且 target 已销毁 → 需改用 Extensions.triggerAction 重开");
    }
    const entry = await waitFor(() => readStoredPick(extId), 25000);
    observe(Boolean(entry), "点一下之后选择结果落进 chrome.storage.local（picked）",
      entry && `tagName=${entry.tagName} chars=${entry.chars} selector=${entry.selector}`);
    if (entry) {
      const markdown = String(entry.markdown || "");
      if (EXTERNAL_URL) {
        observe(entry.tagName === point.atPoint, `抽到的元素 = 指针底下那个 <${point.atPoint}>`, `实际 ${entry.tagName}`);
        observe(markdown.trim().length > 20, "正文 Markdown 非空（真的抽到了内容）", `${markdown.length} 字符`);
        observe(!["html", "body"].includes(entry.tagName), "没有退化成「整页/整个 body」", entry.tagName);
      } else {
        observe(entry.tagName === "p", "抽到的元素 = 被点中的那个 <p>", entry.tagName);
        observe(markdown.includes("这一段是要被点中的正文段落"), "正文 Markdown 真的来自点中的那块", `${markdown.length} 字符`);
        observe(
          !markdown.includes("侧栏噪声") && !markdown.includes("页脚"),
          "没有把侧栏/页脚带进来（没有退回整页抽取）",
        );
      }
    }

    const gone = await waitFor(() => evaluate(page, `!document.getElementById("opennote-pick-host")`), 10000);
    observe(Boolean(gone), "点完覆盖层已移除（页面上不留节点）");

    // Lead 派单③：任何未捕获异常 / console.error 一律 FAIL —— 渲染路径跑不通就不算过
    observe(
      consoleProblems.length === 0,
      "popup / service worker 没有 Uncaught 或 console.error",
      consoleProblems.slice(0, 3).join(" | ") || "干净",
    );
  } finally {
    if (workerSession) workerSession.close();
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
