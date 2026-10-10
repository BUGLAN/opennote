#!/usr/bin/env node
/**
 * verify-editor-geometry.cjs —— Opennote 编辑器「几何回归」判据。
 *
 *   node scripts/verify-editor-geometry.cjs
 *
 * 它自己完成：起 vite（后台，独立端口）→ 起 headless Chrome（独立
 * `--user-data-dir` + `--remote-debugging-port`）→ 连 CDP → 让
 * `scripts/geometry-probe/probe.ts` 量原始像素 → **在这里**做 PASS/FAIL 判定 →
 * 打印结果 → 杀掉**自己起的**进程 → 按结果给退出码。
 *
 * 零依赖：只用 Node 22 自带的全局 `WebSocket` 与 CDP（照抄
 * `docs/editor-ux/probe/cdp.mjs` 的做法），不装 Playwright / Puppeteer。
 *
 * 绝不 `taskkill /IM chrome.exe` —— 那会连用户正在用的浏览器一起杀掉。
 * 这里只按 PID 精确杀自己 spawn 出来的进程树。
 *
 * 环境变量：
 *   GEOMETRY_VITE_PORT   默认 5211
 *   GEOMETRY_CDP_PORT    默认 9333
 *   CHROME_PATH          显式指定 chrome.exe
 *
 * 参数：
 *   --keep       跑完不杀 Chrome / vite（排查用）
 *   --json <path>  把原始测量 JSON 写到文件
 *   --verbose    打印每条断言的完整原始数据
 *   --dump       不跑断言，只把探针页面的逐行 DOM 快照 + CM 内部量打出来（排查用）
 *   --help
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* ============================================================ 常量 */

const REPO_ROOT = path.resolve(__dirname, "..");
const PROBE_DIR = path.join(REPO_ROOT, "scripts", "geometry-probe");
const VITE_CONFIG = path.join(PROBE_DIR, "vite.config.mts");
const PROBE_PAGE = "scripts/geometry-probe/index.html";

const VITE_PORT = Number(process.env.GEOMETRY_VITE_PORT || 5211);
const CDP_PORT = Number(process.env.GEOMETRY_CDP_PORT || 9333);
const PAGE_URL = `http://127.0.0.1:${VITE_PORT}/${PROBE_PAGE}`;

/**
 * 判定阈值。
 *
 * 任务书要求「位移必须为 0」。这里用 `<= 1px` 作为**严格**容差：亚像素布局在
 * `getBoundingClientRect()` 上天然有 ±1px 级别的抖动，用 0 会把抖动报成位移。
 * 但每一条的实际数值都会原样打出来 —— 只要它非 0，就一定看得见。
 */
const TOLERANCE_PX = 1;

const CHROME_WINDOW = "1280,2900";
const VITE_READY_TIMEOUT_MS = 90_000;
const CDP_READY_TIMEOUT_MS = 60_000;
const PAGE_READY_TIMEOUT_MS = 90_000;

/* ============================================================ 小工具 */

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const VERBOSE = argv.includes("--verbose");
const DUMP = argv.includes("--dump");
const JSON_OUT = (() => {
  const i = argv.indexOf("--json");
  return i >= 0 ? argv[i + 1] : null;
})();

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "用法: node scripts/verify-editor-geometry.cjs [--keep] [--verbose] [--json <path>] [--dump]",
      "",
      "  --keep        跑完不杀自己起的 Chrome / vite",
      "  --verbose     打印每条断言的完整原始数据",
      "  --json <path> 把原始测量 JSON 写到文件",
      "  --dump        不跑断言，只打印探针页面的逐行 DOM 快照 + CM 内部量",
      "",
      `  vite 端口 ${VITE_PORT}（GEOMETRY_VITE_PORT）  CDP 端口 ${CDP_PORT}（GEOMETRY_CDP_PORT）`,
      `  Chrome 路径用 CHROME_PATH 覆盖`,
    ].join("\n"),
  );
  process.exit(0);
}

/** 中英混排的等宽对齐：CJK 记 2 列。 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide =
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        cp === 0x2329 ||
        cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd));
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, width) {
  const d = width - dispWidth(s);
  return d > 0 ? String(s) + " ".repeat(d) : String(s);
}

function px(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "  n/a ";
  const sign = n > 0 ? "+" : n < 0 ? "-" : " ";
  return `${sign}${Math.abs(n).toFixed(2)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================ 源码指纹 */

/**
 * 这组数字属于哪一份源码？
 *
 * 判据报告必须能自证「量的是哪个版本」：把 `src/**` 下所有 `.ts/.tsx/.css` 的内容
 * 揉成一个 sha256，连同 `git HEAD` 与「src 是否脏」一起打进报告。否则在并发的
 * 修复过程中跑出来的数字无法归属。
 */
function srcFingerprint() {
  const hash = crypto.createHash("sha256");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(p);
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  for (const f of files) {
    hash.update(path.relative(REPO_ROOT, f).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(f));
    hash.update("\0");
  }
  return { digest: hash.digest("hex").slice(0, 16), files: files.length };
}

function gitState() {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? String(r.stdout) : null;
  };
  const head = run(["rev-parse", "--short", "HEAD"]);
  const status = run(["status", "--porcelain", "--", "src"]);
  return {
    head: head ? head.trim() : null,
    srcDirty: status === null ? null : status.split("\n").filter(Boolean),
  };
}

/* ============================================================ 进程清理 */

const owned = []; // { name, pid }
const tempDirs = []; // 自己创建的临时目录（Chrome profile）
/** 日志目录：全绿就删掉，红了就留着给人查。 */
let runLogDir = null;
let cleanedUp = false;

function killTree(name, pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // 只按 PID 精确杀（含子进程树）。绝不 /IM chrome.exe。
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    console.log(`[cleanup] 已结束 ${name} (pid ${pid})`);
  } catch (error) {
    console.log(`[cleanup] 结束 ${name} (pid ${pid}) 失败：${error && error.message}`);
  }
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (KEEP) {
    console.log(`[cleanup] --keep：保留 ${owned.map((o) => `${o.name}(pid ${o.pid})`).join(", ") || "（无）"}`);
    console.log(`[cleanup] --keep：临时目录保留在 ${tempDirs.join(", ") || "（无）"}`);
    return;
  }
  for (const o of owned.slice().reverse()) killTree(o.name, o.pid);
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.log(`[cleanup] 删临时目录 ${dir} 失败（不影响结果）：${error && error.message}`);
    }
  }
}

process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

/* ============================================================ 启动 vite */

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function waitFor(label, probe, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await sleep(400);
  }
}

/**
 * 端口上是不是已经有人在服务？
 *
 * 这是为了**拒绝**去连一个不是自己起的实例：上一次运行被强杀（Ctrl-C、超时）会留下
 * 孤儿 vite / Chrome，此时新起的那一个绑不上端口，脚本却会悄悄连到旧实例上 ——
 * 旧页面的编辑器状态不可控，`Runtime.evaluate` 会一直等下去（实测卡死过一次）。
 * 宁可明确报错，也不要量一个来源不明的页面。
 */
async function portInUse(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function startVite(logPath) {
  const existing = await httpOk(PAGE_URL);
  if (existing !== null && /geometry probe/i.test(existing)) {
    console.log(`[vite] ${VITE_PORT} 上已经有一个 geometry-probe 的 vite 在跑，复用它（结束时不会杀它）`);
    return { proc: null, owned: false };
  }
  if (existing !== null) {
    throw new Error(`端口 ${VITE_PORT} 被别的东西占用了（返回的不是 geometry-probe 页面）。请换端口：GEOMETRY_VITE_PORT=xxxx`);
  }

  const viteBin = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    throw new Error(`找不到 vite：${viteBin}（先在仓库根跑 pnpm install）`);
  }

  const fd = fs.openSync(logPath, "a");
  const proc = spawn(process.execPath, [viteBin, "--config", VITE_CONFIG], {
    cwd: REPO_ROOT,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, GEOMETRY_VITE_PORT: String(VITE_PORT) },
  });
  fs.closeSync(fd);
  owned.push({ name: "vite", pid: proc.pid });
  proc.on("exit", (code) => {
    if (!cleanedUp && code !== 0 && code !== null) {
      console.log(`[vite] 进程提前退出，code=${code}（日志：${logPath}）`);
    }
  });

  console.log(`[vite] 启动中 … pid ${proc.pid}，配置 ${path.relative(REPO_ROOT, VITE_CONFIG)}`);
  const ready = await waitFor(
    "vite",
    async () => {
      const html = await httpOk(PAGE_URL);
      return html !== null && /geometry probe/i.test(html) ? html : null;
    },
    VITE_READY_TIMEOUT_MS,
  );
  if (!ready) {
    throw new Error(`vite 在 ${VITE_READY_TIMEOUT_MS / 1000}s 内没起来，看日志：${logPath}`);
  }
  console.log(`[vite] 就绪 → ${PAGE_URL}`);
  return { proc, owned: true };
}

/* ============================================================ 启动 Chrome */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function startChrome(logPath) {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error(
      "找不到 Chrome。设 CHROME_PATH 环境变量，例如：\n" +
        '  CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node scripts/verify-editor-geometry.cjs',
    );
  }

  /*
   * CDP 端口必须先确认是空的。
   *
   * 如果上一次运行被强杀（Ctrl-C / 超时 / 蓝屏），会留下一个孤儿 Chrome 占着这个端口；
   * 这时新起的 Chrome 绑不上端口，而下面的 `waitFor` 会**连到那个孤儿实例**上 ——
   * 它的页面状态不可控，`Runtime.evaluate` 可能永远不返回（实测卡死过一次）。
   * 所以宁可在这里明确失败，也不要量一个来源不明的页面。
   */
  if (await portInUse(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
    throw new Error(
      `CDP 端口 ${CDP_PORT} 已被占用（多半是上一次运行留下的孤儿 Chrome）。\n` +
        `  先结束它，或换一个端口：GEOMETRY_CDP_PORT=9444 node scripts/verify-editor-geometry.cjs\n` +
        `  （查占用者：netstat -ano | findstr :${CDP_PORT}  →  taskkill /PID <pid> /T /F）`,
    );
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-geometry-chrome-"));
  tempDirs.push(profileDir);
  const fd = fs.openSync(logPath, "a");
  const args = [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    // 让隐藏窗口里的 rAF / 定时器照常跑：探针的「等 3 帧」依赖 requestAnimationFrame。
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--window-size=${CHROME_WINDOW}`,
    PAGE_URL,
  ];
  const proc = spawn(chromePath, args, { stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  owned.push({ name: "chrome", pid: proc.pid });

  console.log(`[chrome] ${chromePath}`);
  console.log(`[chrome] pid ${proc.pid} · CDP 端口 ${CDP_PORT} · profile ${profileDir}`);
  console.log(`[chrome] --window-size=${CHROME_WINDOW}`);

  const target = await waitFor(
    "cdp",
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const list = await res.json();
        const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        return pages.find((t) => String(t.url).includes("geometry-probe")) || pages[0] || null;
      } catch {
        return null;
      }
    },
    CDP_READY_TIMEOUT_MS,
  );
  if (!target) {
    throw new Error(`Chrome 的 CDP 在 ${CDP_READY_TIMEOUT_MS / 1000}s 内没起来，看日志：${logPath}`);
  }
  return { proc, profileDir, target };
}

/* ============================================================ CDP */

function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")));
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { socket, opened, send };
}

/**
 * 页面内求值，**带硬超时**。
 *
 * `Runtime.evaluate` 配 `awaitPromise` 时，只要页面里那个 Promise 永远不 settle，
 * 这里就会永远等下去 —— 整个判据静默挂死。所以两重保险：CDP 自己的 `timeout` 参数
 * （超时后终止页面执行），加一个 JS 侧的 race（保证 Node 这边一定往前走）。
 */
async function evaluate(cdp, expression, timeoutMs = 30000) {
  const call = cdp.send("Runtime.evaluate", {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  let result;
  try {
    result = await Promise.race([
      call,
      sleep(timeoutMs + 5000).then(() => {
        throw new Error(`页面内求值超过 ${timeoutMs / 1000}s 没有返回（探针页面可能卡住了）`);
      }),
    ]);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/navigated or closed/i.test(message)) {
      throw new Error(
        "探针页面在测量过程中被重新加载 / 关掉了（CDP: Inspected target navigated or closed）。\n" +
          "  最常见的原因：测量期间有人在改 `src/**`，vite 的文件监听推了 HMR、页面整页 reload。\n" +
          "  探针的 vite 已经关掉 hmr/watch（scripts/geometry-probe/vite.config.mts），若仍然出现，\n" +
          "  请确认没有第二个 vite / 别的工具在同一个页面上动手，然后重跑。",
      );
    }
    throw error;
  }
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
    throw new Error(`页面内求值抛异常：\n${detail}`);
  }
  return result.result.value;
}

/* ============================================================ 判定 */

const STATUS = { PASS: "PASS", FAIL: "FAIL", UNMEASURED: "UNMEASURED" };

function judge(delta, extraReason) {
  if (extraReason) return { status: STATUS.UNMEASURED, reason: extraReason, delta: null };
  if (delta === null || delta === undefined || !Number.isFinite(delta)) {
    return { status: STATUS.UNMEASURED, reason: "测量点缺失（标尺段落不在 DOM / coordsAtPos 返回 null）", delta: null };
  }
  return { status: Math.abs(delta) <= TOLERANCE_PX ? STATUS.PASS : STATUS.FAIL, reason: null, delta };
}

function printInvariantHeader(title, note) {
  console.log("");
  console.log("─".repeat(78));
  console.log(title);
  console.log(`  判定阈值：|Δ| <= ${TOLERANCE_PX}px（严格容差；实际数值一律原样打印）${note ? `  ·  ${note}` : ""}`);
  console.log("─".repeat(78));
}

function printRow(status, label, delta, suffix) {
  const tag = pad(status, 11);
  const name = pad(label, 46);
  const d = delta === null || delta === undefined ? "     n/a " : `${px(delta)} px`;
  console.log(`  ${tag}${name}Δ = ${d}${suffix ? `   ${suffix}` : ""}`);
}

/* ============================================================ 主流程 */

async function main() {
  const t0 = Date.now();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-geometry-"));
  runLogDir = logDir;
  const viteLog = path.join(logDir, "vite.log");
  const chromeLog = path.join(logDir, "chrome.log");

  console.log("═".repeat(78));
  console.log("Opennote 编辑器几何回归 · verify-editor-geometry");
  console.log("═".repeat(78));
  console.log(`  仓库根   ${REPO_ROOT}`);
  console.log(`  探针页面 ${PAGE_URL}`);
  console.log(`  Node     ${process.version} (${process.platform})`);
  console.log(`  日志     ${logDir}`);

  const fingerprint = srcFingerprint();
  const git = gitState();
  console.log(
    `  源码     src/** sha256:${fingerprint.digest} (${fingerprint.files} 个 .ts/.tsx/.css)` +
      `${git.head ? `  ·  HEAD ${git.head}` : ""}`,
  );
  if (git.srcDirty && git.srcDirty.length) {
    console.log(`  ⚠ src 是脏的（${git.srcDirty.length} 个文件有未提交改动）—— 下面的数字属于这份未提交的工作区状态：`);
    for (const line of git.srcDirty.slice(0, 12)) console.log(`      ${line}`);
    if (git.srcDirty.length > 12) console.log(`      …还有 ${git.srcDirty.length - 12} 个`);
  } else if (git.srcDirty) {
    console.log("  src 干净（git status --porcelain -- src 为空）");
  }

  const vite = await startVite(viteLog);
  const chrome = await startChrome(chromeLog);

  const cdp = connectCdp(chrome.target.webSocketDebuggerUrl);
  await cdp.opened;

  const ready = await waitFor(
    "probe",
    async () => {
      try {
        /*
         * `up > 1500` 是防「vite 依赖预打包完成后自动 reload」的护栏：页面一旦被重新
         * 加载，`performance.now()` 会归零。等它稳定超过 1.5s 再开始测量，避免量到
         * 一半页面刷新、EditorView 状态被丢掉。
         */
        const st = await evaluate(cdp, "return { ready: !!(window.PROBE_READY && window.GEOM), up: Math.round(performance.now()) }");
        return st && st.ready && st.up > 1500 ? st : null;
      } catch {
        return null;
      }
    },
    PAGE_READY_TIMEOUT_MS,
  );
  if (!ready) throw new Error(`探针页面在 ${PAGE_READY_TIMEOUT_MS / 1000}s 内没就绪（PROBE_READY）`);

  const env = await evaluate(
    cdp,
    "return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, ua: navigator.userAgent }",
  );
  console.log(
    `  视口     ${env.innerWidth}×${env.innerHeight} @${env.dpr}x  ${/HeadlessChrome\/([\d.]+)/.exec(env.ua)?.[0] ?? ""}`,
  );

  if (DUMP) {
    const dump = await evaluate(cdp, "return { lines: GEOM.dumpLines(), internals: GEOM.internals() }");
    console.log("");
    console.log("─".repeat(78));
    console.log("逐行 DOM 快照（光标在文档开头）");
    console.log("─".repeat(78));
    for (const l of dump.lines) {
      console.log(
        `  ${pad(l.text || "␀", 30)} ${pad(l.cls, 46)} display=${pad(l.display, 6)} top=${l.rect ? l.rect.top : "n/a"}`,
      );
    }
    console.log("");
    console.log("CM 内部量：", JSON.stringify(dump.internals, null, 2));
    return 0;
  }

  console.log("");
  console.log("[measure] 不变量 1：光标进出块（纵向）…");
  const vertical = await evaluate(cdp, "return await GEOM.measureVertical()", 120_000);
  console.log("[measure] 不变量 3：光标进出标记（横向）…");
  const horizontal = await evaluate(cdp, "return await GEOM.measureHorizontal()", 60_000);
  console.log("[measure] 不变量 2：异步渲染完成…");
  const asyncRows = await evaluate(cdp, "return await GEOM.measureAsync()", 180_000);
  console.log(`[measure] 采集完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  /* ---------------------------------------------------------- 判定 */

  const results = [];
  const push = (invariant, id, label, delta, reason, detail) =>
    results.push({ invariant, id, label, ...judge(delta, reason), detail });

  for (const row of vertical) {
    const reason = !row.outside.markerFound
      ? `光标在块外时标尺 ${row.marker} 不在 DOM 里`
      : !row.inside.markerFound
        ? `光标进块后标尺 ${row.marker} 不在 DOM 里`
        : null;
    push("v", row.id, row.label, row.deltaMarkerTop, reason, row);
  }
  for (const row of asyncRows) {
    const label = row.kind === "math" ? "`$$` 公式块（KaTeX 异步渲染）" : "mermaid 块（异步渲染）";
    /*
     * 第一道、也是最重要的一道：**这次到底有没有测到「渲染前」？**
     *
     * probe 侧已经把 t0 挪到「widget 进 DOM 的那一帧」，但万一渲染在同一帧内就完成了，
     * `t0` 拿到的仍是渲染后的高度 —— 那 Δ 必然是 0，判 PASS 就是**假绿**。
     * 这种情况如实报 UNMEASURED，绝不放过。
     */
    const guard = !row.placeholderSeen
      ? "没有观察到占位态（.is-loading）—— 渲染在 widget 进 DOM 的同一帧内就完成了，本次没测到「渲染前」，不能当通过"
      : !row.settled
        ? `${row.kind} 在 ${row.timeoutMs / 1000}s 内没有渲染完成（.is-loading 一直没清掉）`
        : !row.t1.markerFound
          ? "渲染完成后标尺 CAFTER 不在 DOM 里"
          : null;

    /*
     * 判据只断言**物理上可达**的两件事（推导见 probe.ts 里那段说明）：
     *
     *   2a  渲染完成时，块**自身**的顶边不动 —— 也就是「你的视角没有被甩走」。
     *       占位 47.94px 变成 273.23px 时，块下方内容必然被推走 225px，
     *       那不是缺陷而是必然（渲染前没人知道它多高）；**视口没动、块没动**
     *       才是可保证、也才是用户能感知到的性质。
     *
     *   2b  第二次渲染（内容命中缓存、widget 重建时同步出 HTML）时，
     *       块**下方**也不许动 —— 重复访问零位移。
     *
     * 第一次渲染的「块下方位移」`deltaMarkerTop` 只作参考量打印，不参与判定 ——
     * 把它当判据等于要求「渲染前就知道渲染后的高度」，物理上做不到。
     */
    push("a", `${row.kind}-widget`, `${label} · 块自身顶边不动`, row.deltaWidgetTop, guard, row);
    push(
      "a",
      `${row.kind}-second`,
      `${label} · 第二次渲染（缓存命中）块下方不动`,
      row.deltaMarkerTopSecond,
      guard ?? (row.deltaMarkerTopSecond == null ? "第二次渲染没能测到标尺位置" : null),
      row,
    );
  }
  for (const row of horizontal) {
    const reason = !row.outside.coordsAtText
      ? "光标在段落外时 coordsAtPos 返回 null"
      : !row.inside.coordsAtText
        ? "光标进段落时 coordsAtPos 返回 null"
        : null;
    push("h", row.id, row.label, row.deltaCoordsLeft, reason, row);
  }

  /* ---------------------------------------------------------- 报告 */

  printInvariantHeader("不变量 1 · 切换不位移（纵向）", "光标在块外 → 移进块 → 块下方第一个标记段落的 rect.top 位移");
  for (const r of results.filter((x) => x.invariant === "v")) {
    printRow(r.status, r.label, r.delta, r.status === STATUS.PASS ? "" : r.reason || "");
  }

  printInvariantHeader("不变量 2 · 异步渲染不位移", "挂载瞬间 → 等 .md-math/.md-mermaid 去掉 .is-loading 之后，块下方标记段落的 rect.top 位移");
  for (const r of results.filter((x) => x.invariant === "a")) {
    printRow(r.status, r.label, r.delta, r.status === STATUS.PASS ? "" : r.reason || "");
  }

  printInvariantHeader("不变量 3 · 切换不位移（横向）", "光标在段落外 → 移进段落 → 标记元素文字起点 coordsAtPos().left 的位移");
  for (const r of results.filter((x) => x.invariant === "h")) {
    printRow(r.status, r.label, r.delta, r.status === STATUS.PASS ? "" : r.reason || "");
  }

  /* ---------------------------------------------------------- 明细 */

  const bad = results.filter((r) => r.status !== STATUS.PASS);
  if (bad.length) {
    console.log("");
    console.log("─".repeat(78));
    console.log("明细（「现在坏在哪、坏多少」）");
    console.log("─".repeat(78));
    for (const r of bad) {
      console.log(`\n  [${r.status}] ${r.label}   Δ = ${px(r.delta)} px`);
      if (r.reason) console.log(`        ${r.reason}`);
      const d = r.detail;
      if (r.invariant === "v") {
        console.log(`        标尺 ${d.marker}: top ${d.outside.markerRect?.top ?? "n/a"} → ${d.inside.markerRect?.top ?? "n/a"}`);
        console.log(
          `        块高 ${d.blockHeightOutside ?? "n/a"} → ${d.blockHeightInside ?? "n/a"} px` +
            `   块存在 ${d.outside.blockPresent} → ${d.inside.blockPresent}`,
        );
        console.log(
          `        contentHeight ${d.outside.contentHeight} → ${d.inside.contentHeight} (Δ ${px(d.deltaContentHeight)} px)` +
            `   scrollTop Δ ${px(d.deltaScrollTop)} px   windowScrollY ${d.outside.windowScrollY} → ${d.inside.windowScrollY}`,
        );
      } else if (r.invariant === "a") {
        console.log(
          `        占位高 ${d.placeholderHeight ?? "n/a"} → 渲染后 ${d.renderedHeight ?? "n/a"} px` +
            `   块自身顶边 Δ ${px(d.deltaWidgetTop)} px（判定）` +
            `   渲染完成于 ${d.renderCompletedAtMs ?? "n/a"}ms`,
        );
        // 第一次渲染的块下方位移只作参考 —— 它必然 ≈（渲染后高 − 占位高），
        // 因为渲染前没人知道它多高。判据看的是「块自身顶边」与「第二次渲染」。
        console.log(
          `        标尺 top ${d.t0.markerRect?.top ?? "n/a"} → ${d.t1.markerRect?.top ?? "n/a"}` +
            `   Δ ${px(d.deltaMarkerTop)} px（**参考量，不判定**）`,
        );
        console.log(
          `        第二次渲染（缓存命中）：标尺 Δ ${px(d.deltaMarkerTopSecond)} px（判定）` +
            `   源码态时 widget 还在？${d.inSource?.widgetPresent}   重建后 .is-loading ${d.second?.loading ?? "n/a"}`,
        );
        console.log(`        .is-loading 数量 ${d.t0.loading} → ${d.t1.loading}   渲染完成 ${d.settled}`);
        // 没观察到占位态就是「没测到」，必须显式打出来 —— 不能让它混在别的数字里蒙过去。
        console.log(
          `        观察到占位态（t0 那一刻 .is-loading 在场）${d.placeholderSeen ? "是" : "**否**"}` +
            `   widget 进 DOM 用了 ${d.placeholderWaitMs ?? "n/a"}ms`,
        );
        const tl = d.timeline;
        if (tl.length) {
          const head = tl
            .slice(0, 6)
            .map((s) => `${s.at}ms:${s.markerTop}`)
            .join("  ");
          const tail = tl.length > 6 ? `  …  末帧 ${tl[tl.length - 1].at}ms:${tl[tl.length - 1].markerTop}` : "";
          console.log(`        时间线 top: ${head}${tail}`);
        }
      } else {
        console.log(`        文字起点 left ${d.outside.coordsAtText?.left ?? "n/a"} → ${d.inside.coordsAtText?.left ?? "n/a"}`);
        console.log(
          `        元素 ${d.outside.elementText ? "rect.left " + d.outside.elementRect?.left : "（无元素）"} → ${d.inside.elementRect?.left ?? "n/a"}` +
            `   Δ元素 ${px(d.deltaElementLeft)} px`,
        );
        console.log(
          `        纵向对照 Δ ${px(d.deltaCoordsTop)} px（不属于本不变量）` +
            `   contentHeight Δ ${px(d.deltaContentHeight)}   scrollTop Δ ${px(d.deltaScrollTop)}   windowScrollY Δ ${px(d.deltaWindowScrollY)}`,
        );
        console.log(`        行文本 前: ${d.lineTextOutside}`);
        console.log(`               后: ${d.lineTextInside}`);
      }
    }
  }

  if (VERBOSE) {
    console.log("");
    console.log("─".repeat(78));
    console.log("原始测量数据");
    console.log("─".repeat(78));
    console.log(JSON.stringify({ env, vertical, horizontal, asyncRows }, null, 2));
  }

  /* ---------------------------------------------------------- 汇总 */

  const passed = results.filter((r) => r.status === STATUS.PASS).length;
  const failed = results.filter((r) => r.status === STATUS.FAIL).length;
  const unmeasured = results.filter((r) => r.status === STATUS.UNMEASURED).length;

  console.log("");
  console.log("═".repeat(78));
  const parts = [`${passed} passed`, `${failed} failed`];
  if (unmeasured) parts.push(`${unmeasured} unmeasured`);
  console.log(`汇总: ${parts.join(" / ")}   （共 ${results.length} 条断言，阈值 |Δ| <= ${TOLERANCE_PX}px）`);
  if (unmeasured) console.log("       unmeasured 不计为通过：测不出来就等于判据失效，退出码同样为 1。");
  console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("═".repeat(78));

  if (JSON_OUT) {
    const out = path.resolve(REPO_ROOT, JSON_OUT);
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          env,
          source: { ...fingerprint, ...git },
          vitePort: VITE_PORT,
          cdpPort: CDP_PORT,
          chromeWindow: CHROME_WINDOW,
          tolerancePx: TOLERANCE_PX,
          results: results.map((r) => ({ invariant: r.invariant, id: r.id, label: r.label, status: r.status, delta: r.delta, reason: r.reason })),
          raw: { vertical, horizontal, asyncRows },
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`原始 JSON 已写入 ${out}`);
  }

  return failed > 0 || unmeasured > 0 ? 1 : 0;
}

main()
  .then((code) => {
    cleanup();
    if (code === 0 && runLogDir) {
      try {
        fs.rmSync(runLogDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        /* 删不掉就算了，不影响判定 */
      }
    } else if (runLogDir) {
      console.log(`[cleanup] 保留日志目录（有 FAIL / UNMEASURED）：${runLogDir}`);
    }
    process.exit(code);
  })
  .catch((error) => {
    console.error("");
    console.error("✗ 判据脚本自身失败（这不代表被测代码通过）：");
    console.error(error && error.stack ? error.stack : String(error));
    cleanup();
    if (runLogDir) console.error(`[cleanup] 保留日志目录：${runLogDir}`);
    process.exit(2);
  });
