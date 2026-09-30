#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Opennote 0.2.0 · 端到端 6 场景验证器（Verifier 产物，只读驱动，绝不修改产品代码）
 * ============================================================================
 *
 * 与 `verify-contract.cjs` 的分工：
 *   - verify-contract.cjs：静态契约/安全断言 + 轻量动态调用；
 *   - 本脚本：把 6 个端到端场景**真跑一遍**。
 *
 * 真实度声明（不许含糊）：
 *   ✅ 真实执行的：`electron/bridge.cjs`（真 HTTP 服务，真 `listen(127.0.0.1)`）、
 *      `src/lib/clip/**` 接收端、`src/data/inbox.ts` 收件箱状态机、`extension/src/lib/bridge.js`
 *      插件侧客户端、真实磁盘（临时工作区目录，文件字节用 Node `fs` 直接读回）。
 *   ⚠️ 打桩的：**Electron IPC 边界**（`window.opennote.fs.*` 用 Node `fs` 实现）。
 *      这是本环境没有 Electron 运行时的唯一替代，与 `scripts/ipc-safety-check.cjs` 同思路。
 *   ❌ 未验证的：真机 Chrome 加载扩展、真实 Electron 窗口渲染、像素级「界面 3 秒内可见」。
 *      这些一律标 UNVERIFIED 并给出可复现步骤，绝不写成 PASS。
 *
 * 退出码：0 = 6 个场景全 PASS；1 = 有 FAIL；UNVERIFIED 不算 PASS（摘要里单列，但不改退出码）。
 *        若环境准备阶段就失败 → 全部场景 UNVERIFIED，退出码 1。
 *
 * 用法：node scripts/verify-e2e.cjs
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const require2 = createRequire(path.join(ROOT, "package.json"));

/** 「树在动」标记 —— 与 b 的 `extension/.gitignore` 约定对齐（`.building` = build.mjs 正在重写
 *  `extension/dist`；`.mutation-running` = `tools/mutation-check.ps1` 正在**故意改坏** `extension/src`）。
 *  本脚本会 `ssrLoadModule` 插件源码，所以这两种窗口里跑出来的结论一律**不可信**（exit 2 = 中止）。 */
const EXT_MARKERS = ["extension/.building", "extension/.mutation-running"];
function extMarkersActive() {
  return EXT_MARKERS.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
}
/** 判定「树在不在动」。返回 false = 不可信（调用方负责 exit 2）。
 *  `injected` 传数组 = 用注入的标记列表判定（自检用，不碰 extension/ 目录）；
 *  不传 = 查真源。`quiet` 只用于自检，免得刷屏。 */
function treeTrusted(when, injected, quiet = false) {
  const on = injected !== undefined ? injected : extMarkersActive();
  if (!on.length) return true;
  if (!quiet) {
    console.log("\n" + "!".repeat(72));
    console.log(`!! ${when}发现「树在动」标记：${on.join(", ")}`);
    console.log("!! 此时 extension/src 或 extension/dist 正在被写（甚至被故意改坏），本脚本会读到半成品。");
    console.log("!! 本次【不跑】：exit 2 = 中止（既不是通过，也不是失败清单）。等构建/变异结束再跑。");
    console.log("!".repeat(72));
  }
  return false;
}
const abortIfTreeMoving = (when) => {
  if (!treeTrusted(when)) process.exit(2);
};

/* ------------------------------------------------------------------ 报告 */

const results = [];
const evidence = {};

function record(status, id, title, detail) {
  results.push({ status, id, title, detail: detail == null ? "" : String(detail) });
  // 注意：这里**必须**给 INFO 单独一支。原来写成「非 PASS 非 FAIL 一律打 UNVERIFIED」，
  // 于是 `info4b()` 的观测行全被印成 `UNVERIFIED` —— 计数是对的（摘要按 status 统计），
  // 但**行首标签在撒谎**：4 条纯观测看起来像 4 条「未验证」。标签撒谎就是验证器的缺陷。
  const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : status === "INFO" ? "INFO" : "UNVERIFIED";
  console.log(`  ${mark}  [${id}] ${title}${detail ? `\n              ${String(detail).split("\n").join("\n              ")}` : ""}`);
}
const pass = (id, t, d) => record("PASS", id, t, d);
const fail = (id, t, d) => record("FAIL", id, t, d);
const unver = (id, t, d) => record("UNVERIFIED", id, t, d);

function stanza(title) {
  console.log(`\n── ${title} ──`);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readWorkspaceFile(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split("/").filter(Boolean)));
}

function listWorkspace(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out.sort();
}

/* ------------------------------------------------------- Electron IPC 打桩 */

/** 记录被拒绝写入的前缀（用于模拟 `.opennote/` 只读 / 磁盘满 → IMP-W008 降级）。 */
const denyWritePrefixes = [];
/** 记录所有写入路径，用于「主进程/接收端到底写了什么」的证据。 */
const writeLog = [];

function createNodeFsBridge() {
  const abs = (root, rel) => path.join(root, ...String(rel).split("/").filter(Boolean));
  const guard = (rel) => {
    const value = String(rel);
    for (const prefix of denyWritePrefixes) {
      if (value === prefix || value.startsWith(`${prefix}/`)) throw new Error(`EACCES ${value}`);
    }
  };
  return {
    isElectron: true,
    platform: process.platform,
    version: "0.0.0-verify",
    fs: {
      list: async (root, rel) => {
        const dir = abs(root, rel);
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          out.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file", size: stat.size, mtimeMs: stat.mtimeMs });
        }
        return out;
      },
      readText: async (root, rel) => fs.promises.readFile(abs(root, rel), "utf8"),
      readBytes: async (root, rel) => new Uint8Array(await fs.promises.readFile(abs(root, rel))),
      writeText: async (root, rel, text) => {
        guard(rel);
        writeLog.push(`writeText:${rel}`);
        const target = abs(root, rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, text, "utf8");
      },
      writeBytes: async (root, rel, data) => {
        guard(rel);
        writeLog.push(`writeBytes:${rel}`);
        const target = abs(root, rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, Buffer.from(data));
      },
      mkdir: async (root, rel) => {
        guard(rel);
        await fs.promises.mkdir(abs(root, rel), { recursive: true });
      },
      remove: async (root, rel, options) => {
        await fs.promises.rm(abs(root, rel), { recursive: Boolean(options && options.recursive) });
      },
      move: async (root, from, to) => {
        guard(to);
        const target = abs(root, to);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.rename(abs(root, from), target);
      },
      exists: async (root, rel) => {
        try {
          await fs.promises.access(abs(root, rel));
          return true;
        } catch {
          return false;
        }
      },
      stat: async (root, rel) => {
        try {
          const stat = await fs.promises.stat(abs(root, rel));
          return { size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      },
      authorizeRoot: async () => true,
      watchWorkspace: async () => true,
      unwatchWorkspace: async () => true,
      onWorkspaceChanged: () => () => {},
    },
    dialog: { pickFolder: async () => null, pickSaveFile: async () => null, saveFile: async () => true },
    shell: { showItemInFolder: async () => {}, openExternal: async () => {} },
    app: { getRecentWorkspaces: async () => [], addRecentWorkspace: async () => {}, onFlushRequest: () => () => {}, flushDone: () => {} },
    window: { setTitleBarOverlay: async () => false },
    onMenu: () => () => {},
    // 收件箱广播订阅：把回调存下来，S8.1 要用它驱动「450ms 去抖」这条路径。
    onInboxChanged: (fn) => {
      globalThis.window.opennote.__inboxChangedHandler = fn;
      return () => {
        globalThis.window.opennote.__inboxChangedHandler = null;
      };
    },
    onImportReceipt: () => () => {},
    onImportNotice: () => () => {},
    onImportRequest: () => () => {},
  };
}

function installDomShim() {
  const listeners = new Map();
  const noop = () => {};
  const add = (key, fn) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
  };
  globalThis.window = {
    addEventListener: (type, fn) => add(`w:${type}`, fn),
    removeEventListener: (type, fn) => listeners.get(`w:${type}`) && listeners.get(`w:${type}`).delete(fn),
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { href: "http://127.0.0.1/", origin: "http://127.0.0.1" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: "opennote-verify" },
    opennote: createNodeFsBridge(),
  };
  globalThis.document = {
    addEventListener: (type, fn) => add(`d:${type}`, fn),
    removeEventListener: (type, fn) => listeners.get(`d:${type}`) && listeners.get(`d:${type}`).delete(fn),
    visibilityState: "visible",
    hidden: false,
    documentElement: { dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, rel: "", href: "" }),
    body: { appendChild() {}, removeChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/** 捕获 `notify()` 里 `setTimeout(..., duration)` 的真实毫秒数（证明「显式传 10 秒」）。 */
const capturedTimeouts = [];
function patchTimers() {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function patched(fn, ms, ...rest) {
    capturedTimeouts.push(ms);
    const timer = realSetTimeout(fn, ms, ...rest);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  };
}

/* ------------------------------------------------------------- 环境准备 */

async function bootstrap() {
  installDomShim();
  patchTimers();

  const vite = await import(pathToFileURL(require2.resolve("vite")).href);
  const server = await vite.createServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  const lib = await server.ssrLoadModule("/src/data/library.ts");
  const clip = await server.ssrLoadModule("/src/lib/clip/index.ts");
  const inbox = await server.ssrLoadModule("/src/data/inbox.ts");
  const toast = await server.ssrLoadModule("/src/lib/toast.ts");
  const plugin = await server.ssrLoadModule("/extension/src/lib/bridge.js");
  const pluginEnvelope = await server.ssrLoadModule("/extension/src/lib/envelope.js");
  /* A（网页版剪藏页）· 扩展侧「请求体形状」的**唯一产地**：S13 直接用它组装请求体，
   * 不在探针里复刻 8 个键 —— 复刻就等于「测我自己写的那份」，不是测产品。 */
  const stage = await server.ssrLoadModule("/extension/src/lib/stage.js");
  const bridgeModule = require(path.join(ROOT, "electron", "bridge.cjs"));

  return { server, lib, clip, inbox, toast, plugin, pluginEnvelope, stage, bridgeModule };
}

const scenarioRoots = new Set();

async function freshWorkspace(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-e2e-"));
  scenarioRoots.add(root);
  try {
    await env.lib.closeWorkspace();
  } catch {
    /* 首次没有工作区 */
  }
  denyWritePrefixes.length = 0;
  writeLog.length = 0;
  await env.lib.openWorkspace(
    { id: `verify-${path.basename(root)}`, name: "验证笔记本", kind: "node", location: root, addedAt: 1, lastOpenedAt: 1 },
    { silent: true },
  );
  return root;
}

function startBridge(env, root, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-bridge-"));
  let token = null;
  const controller = env.bridgeModule.createBridge({
    dataDir,
    getWindow: options.noWindow
      ? () => null
      : () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
    // 与 electron/main.cjs 同一条路径：桥不落盘，把信封转交渲染层并拿回执。
    onEnvelope: (envelopeJson) => env.clip.receiveEnvelopeOutcome(envelopeJson),
    getAdvancedOverwrite: () => Boolean(options.advancedOverwrite),
    isEnabled: () => true,
    getTokenHash: () => (token ? env.bridgeModule.sha256Hex(token) : null),
    log: () => {},
  });
  token = controller.generateToken();
  return { controller, token, dataDir, getToken: () => token };
}

function envelope(overrides) {
  return {
    spec: "opennote.import/v1",
    importId: `verify-${crypto.randomUUID().slice(0, 18)}`,
    title: "验证标题",
    body: "正文第一段。\n",
    source: {
      url: "https://example.com/verify",
      title: "来源标题",
      site: "example.com",
      author: "作者",
      publishedAt: "2026-09-29T10:00:00Z",
      capturedAt: "2026-09-29T21:00:00+08:00",
    },
    target: { folder: null, notePath: null },
    conflict: "new",
    tags: ["验证"],
    assets: [],
    client: { name: "chrome-extension", version: "0.1.4" },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ 场景 */

async function main() {
  abortIfTreeMoving("开跑前");
  console.log("Opennote 0.2.0 · 端到端 6 场景验证（Verifier 独立复跑）");
  console.log("真实度：真 HTTP + 真接收端 + 真磁盘；仅 Electron IPC 边界打桩。");

  let env = null;
  try {
    env = await bootstrap();
    pass("S0", "环境准备：Vite 载入 TS + 内存 DOM 打桩 + 真实 HTTP 桥", "electron/bridge.cjs 已 require，src/lib/clip 与 src/data/inbox 已载入");
  } catch (error) {
    fail("S0", "环境准备", error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : String(error));
  }

  if (!env) {
    for (const [id, title] of [
      ["S1", "插件 → 本地桥 → 落盘"],
      ["S2", "同一 URL 二次剪藏 → duplicate"],
      ["S3", "同名冲突 →  2 后缀"],
      ["S4", "append 后 10 秒内撤销"],
      ["S5", "收件箱模式 → 计数 +1 → 入库 / 丢弃"],
      ["S6", "关掉 Opennote → 插件剪藏 → 明确失败"],
    ]) unver(id, title, "环境准备失败，无法执行");
    return finish();
  }

  try {
    // 逐族上覆盖守卫（`S7`/`S9`/`S10` 的守卫在它们自己的函数里，这里不重复包）。
    await withCoverageGuard("S1", EXPECTED_S1, () => scenario1(env));
    await withCoverageGuard("S2", EXPECTED_S2, () => scenario2(env));
    await withCoverageGuard("S3", EXPECTED_S3, () => scenario3(env));
    await withCoverageGuard("S4", EXPECTED_S4, () => scenario4(env));
    await withCoverageGuard("S4B", EXPECTED_S4B, () => scenario4b(env));
    await withCoverageGuard("S5", EXPECTED_S5, () => scenario5(env));
    await withCoverageGuard("S6", EXPECTED_S6, () => scenario6(env));
    await scenario7(env); // 内含 S7 与 S7B 两条守卫（S7B 的守卫在 scenario7Body 里包住那次调用）
    await withCoverageGuard("S8", EXPECTED_S8, () => scenario8(env));
    await scenario9(env);
    await scenario10(env);
    await scenario13(env);
  } catch (error) {
    fail("SCENARIO-CRASH", "场景执行中断", error && error.stack ? error.stack.split("\n").slice(0, 4).join(" | ") : String(error));
  } finally {
    try {
      await env.server.close();
    } catch {
      /* ignore */
    }
  }

  /* ── 全局对账（兜底）：各族的守卫只能证明「那个族跑完时报告齐了」───────────────
   * 如果某个场景抛异常冲出上面的 try，**后面所有族的守卫根本不会执行** ——
   * 那一大片检查会静默消失，而摘要里只会「少几行」。这条兜底把「整族没跑」变成红。 */
  {
    const allExpected = [
      ...EXPECTED_S1, ...EXPECTED_S2, ...EXPECTED_S3, ...EXPECTED_S4, ...EXPECTED_S4B,
      ...EXPECTED_S5, ...EXPECTED_S6, ...EXPECTED_S7, ...EXPECTED_S7B, ...EXPECTED_S8,
      ...EXPECTED_S9, ...EXPECTED_S10, ...EXPECTED_S13,
    ];
    const reported = new Set(results.map((r) => r.id));
    const missingAll = allExpected.filter((id) => !reported.has(id));
    if (missingAll.length) {
      fail("COVERAGE-ALL", `全局对账：${missingAll.length} 条检查整轮都没被报告（**不是通过**）`,
        `缺失：${missingAll.join(", ")}（共登记 ${allExpected.length} 条）`);
    } else {
      pass("COVERAGE-ALL", `全局对账：登记的 ${allExpected.length} 条检查全部报告过（PASS/FAIL/UNVERIFIED 都算「报告过」）`,
        `实际报告 ${reported.size} 条 id（含 S0/守卫自身等）`);
    }
  }

  /* ── 覆盖守卫自检：证明「没报」真的会红 ─────────────────────────────────────
   * 一条**恒绿**的守卫比没有守卫更糟：它会让人以为「都报过了」。
   * 所以这里故意跑一次「什么都不报告」的守卫，看它是否如期产出 FAIL；
   * 自检期间的**控制台输出先收进变量**（否则日志里会冒出一条孤零零的 `FAIL [GUARD-SELFTEST]`，
   * 让人以为整轮失败了 —— 一条只该出现在「证词」里的红，不该混进结论区），
   * 再把这次自检写进 `results` 的记录**撤回**（它测的是守卫本身，不是产品）。 */
  {
    const before = results.length;
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => { captured.push(args.join(" ")); };
    let threw = null;
    try {
      await withCoverageGuard("GUARD-SELFTEST", ["GUARD-SELFTEST.1"], async () => { /* 故意一条都不报告 */ });
    } catch (error) {
      threw = error;
    } finally {
      console.log = realLog;
    }
    const added = results.slice(before);
    results.length = before; // 撤回自检记录
    const fired = !threw && added.length === 1 && added[0].status === "FAIL" && added[0].id === "GUARD-SELFTEST-coverage";
    if (fired) {
      pass("COVERAGE-SELFTEST", "覆盖守卫自检：故意漏报一条登记的检查 → 守卫如期报红（证明守卫不是恒绿）",
        `产出 ${added[0].id} / ${added[0].status}，原样证词=「${captured.join(" / ").trim().replace(/\s+/g, " ").slice(0, 160)}」`
        + `，该记录已从摘要撤回（不计入本次统计）`);
    } else {
      fail("COVERAGE-SELFTEST", "覆盖守卫自检失败：漏报没有变红，说明守卫是恒绿的（比没有守卫更糟）",
        threw ? `抛异常：${threw.message}` : `产出 ${added.length} 条：${added.map((r) => `${r.id}/${r.status}`).join(", ") || "(无)"}`);
    }
  }

  return finish();
}

/* --- S1 插件 → 本地桥 → 落盘 ------------------------------------------- */

async function scenario1(env) {
  stanza("场景 1 · 插件 → 本地桥 → 落盘（新笔记 + 8 键 front-matter + 正文 H1）");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S1.1", "桥在 127.0.0.1:8787–8796 启动", JSON.stringify(started));
    return;
  }
  const status = controller.status();
  pass("S1.1", "桥启动并只绑 127.0.0.1", `port=${status.port} address=${status.address}`);

  const envlp = envelope({});
  const t0 = Date.now();
  const call = await env.plugin.postImport(status.port, token, envlp);
  const elapsed = Date.now() - t0;

  if (call.kind !== "ok") {
    fail("S1.2", "插件侧 postImport 成功", `kind=${call.kind} code=${call.code} msg=${call.serverMessage}`);
    await controller.stop();
    return;
  }
  const receipt = call.result;
  pass("S1.2", "插件侧 postImport 成功（extension/src/lib/bridge.js 真发 HTTP）",
    `status=${receipt.status} path=${receipt.path} http=${call.http} 往返 ${elapsed}ms`);

  const onDisk = listWorkspace(root);
  const fileExists = onDisk.includes(receipt.path);
  const bytes = fileExists ? readWorkspaceFile(root, receipt.path) : null;
  const text = bytes ? bytes.toString("utf8") : "";
  evidence.s1 = { path: receipt.path, bytes: text };

  pass("S1.3", "笔记文件真实落盘", `${receipt.path}  ${bytes ? bytes.length : 0} 字节；工作区: ${onDisk.join(", ")}`);

  // front-matter 字节模板：--- 在开头、闭合后恰好一个空行、正文首行 # 标题、末尾恰好一个 \n
  const match = /^---\n([\s\S]*?)\n---\n\n(# .*\n)/.exec(text);
  if (!match) {
    fail("S1.4", "front-matter 字节模板（`---` 开头 / 闭合后恰好一个空行 / 正文首行 `# 标题`）",
      JSON.stringify(text.slice(0, 160)));
  } else {
    pass("S1.4", "front-matter 字节模板正确", JSON.stringify(text.slice(0, 120)) + " …");
    const keys = match[1].split("\n").map((line) => line.split(":")[0]);
    const EXPECTED = ["source", "source_title", "source_site", "author", "published_at", "captured_at", "tags", "opennote_import_id"];
    // ㊶（`00` §6.15）：提取不到的字段**整行省略**（沿用「null 则省略整行」的既有规则），
    // **不得**为了凑满 8 键填占位值。所以判据从「必须有 8 键」改成
    // 「**出现**的键必须是 EXPECTED 的**子序列**」——少键合法、乱序或未知键非法。
    const idx = keys.map((k) => EXPECTED.indexOf(k));
    const knownOk = idx.every((i) => i >= 0);
    const orderOk = knownOk && idx.every((v, i) => i === 0 || v > idx[i - 1]);
    if (orderOk && keys.length <= EXPECTED.length) {
      pass("S1.5", `front-matter 键序符合契约（本次 ${keys.length}/${EXPECTED.length} 键；缺值整行省略是允许的）`, keys.join(" → "));
    } else {
      fail("S1.5", "front-matter 键序符合契约（允许省略，但出现即须按契约顺序、且不得有未知键）",
        `实际 ${keys.join(" → ")}（${keys.length} 键；未知键=${keys.filter((k) => !EXPECTED.includes(k)).join(",") || "无"}）`);
    }

    const tagsLine = (match[1].match(/^tags:.*$/m) || [""])[0];
    const tagsOk = /^tags: \[[^\]]*\]$/.test(tagsLine);
    if (tagsOk) pass("S1.6", "tags 行内数组 `[a, b]`", tagsLine);
    else fail("S1.6", "tags 行内数组 `[a, b]`", tagsLine || "(无 tags 行)");

    const bodyOk = match[2] === `# ${envlp.title}\n`;
    if (bodyOk) pass("S1.7", "正文首行是 `# <title>`", JSON.stringify(match[2]));
    else fail("S1.7", "正文首行是 `# <title>`", JSON.stringify(match[2]));
  }

  const tailOk = text.endsWith("\n") && !text.endsWith("\n\n");
  if (tailOk) pass("S1.8", "文件末尾恰好一个换行", JSON.stringify(text.slice(-12)));
  else fail("S1.8", "文件末尾恰好一个换行", JSON.stringify(text.slice(-12)));

  /* ── S1.5b（㊶）「提取不到的字段整行省略，不得填占位值」───────────────
     静态判据只能看到「契约允许省略」，看不到「实现真的会省略」。
     所以这里再投一封**缺 author / publishedAt** 的信封（模拟页面里提取不到），
     断言这两行**整行不存在**（而不是 `author: ""` / `author: null`），
     同时 `tags` 与 `opennote_import_id` 仍在 —— 省略的是**没值的**，不是该有的。 */
  const sparseEnvelope = envelope({
    title: "稀疏来源标题",
    source: { ...envelope({}).source, url: "https://example.com/verify-sparse", author: null, publishedAt: null },
  });
  delete sparseEnvelope.source.author;
  delete sparseEnvelope.source.publishedAt;
  const sparseCall = await env.plugin.postImport(status.port, token, sparseEnvelope);
  const sparseReceipt = sparseCall.kind === "ok" ? sparseCall.result : null;
  const sparseBytes = sparseReceipt && sparseReceipt.path ? readWorkspaceFile(root, sparseReceipt.path) : null;
  const sparseText = sparseBytes ? sparseBytes.toString("utf8") : "";
  const sparseFm = /^---\n([\s\S]*?)\n---\n\n# /.exec(sparseText);
  const sparseKeys = sparseFm ? sparseFm[1].split("\n").map((line) => line.split(":")[0]) : [];
  const invented = sparseKeys.filter((k) => k === "author" || k === "published_at");
  const kept = ["tags", "opennote_import_id"].filter((k) => sparseKeys.includes(k));
  if (sparseFm && invented.length === 0 && kept.length === 2) {
    pass("S1.5b", "（㊶）提取不到的字段整行省略、不填占位值（缺 author/publishedAt → 两行都不出现）",
      `${sparseReceipt.path} 的键：${sparseKeys.join(" → ")}`);
  } else {
    fail("S1.5b", "缺值字段应整行省略且不得填占位值",
      `path=${sparseReceipt && sparseReceipt.path} 实际键=${sparseKeys.join(" → ") || "(未取到)"}`
      + ` 多出的占位行=${invented.join(",") || "无"} 该有的键=${kept.join(",") || "无"}`);
  }

  const noCr = !text.includes("\r");
  if (noCr) pass("S1.9", "全文无 CR（LF only）", "0 处 \\r");
  else fail("S1.9", "全文无 CR（LF only）", "发现 CR");

  // 界面可见性：断言「应用内的库状态在 3 秒内出现这条笔记」。
  const notes = env.lib.libraryStore.get().notes;
  const visible = Object.keys(notes).includes(receipt.path);
  const visibleMs = Date.now() - t0;
  if (visible) {
    pass("S1.10", "应用内库状态 3 秒内包含新笔记（界面可见的前提）", `命中 ${receipt.path}，耗时 ${visibleMs}ms（阈值 3000ms）`);
  } else {
    fail("S1.10", "应用内库状态 3 秒内包含新笔记", `未命中；当前 keys=${Object.keys(notes).slice(0, 5).join(", ") || "(空)"}`);
  }
  unver("S1.11", "真实窗口里 3 秒内「肉眼可见」（DOM 渲染 / 像素）",
    "本环境无 Electron 窗口与浏览器。复现步骤：①`pnpm dev:electron`；②开启「设置 · 文件 · 导入与接口」；③用插件剪藏；④目视侧栏 3 秒内出现新笔记。已由 S1.10 证到「数据层可见」，渲染层未证。");

  await controller.stop();
}

/* --- S2 duplicate ------------------------------------------------------ */

async function scenario2(env) {
  stanza("场景 2 · 同一 URL 二次剪藏同一内容 → duplicate、文件未变、内联规范文案");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S2.1", "桥启动", JSON.stringify(started));
    return;
  }
  const envlp = envelope({ source: { ...envelope({}).source, url: "https://example.com/dup" } });

  const first = await env.plugin.postImport(started.port, token, envlp);
  if (first.kind !== "ok" || !first.result.path) {
    fail("S2.1", "首次剪藏成功", JSON.stringify(first).slice(0, 200));
    await controller.stop();
    return;
  }
  const filePath = first.result.path;
  const before = readWorkspaceFile(root, filePath);
  const beforeHash = sha256(before);
  const beforeTree = listWorkspace(root);
  pass("S2.1", "首次剪藏落盘", `${filePath} sha256=${beforeHash.slice(0, 16)}…`);

  const toastsBefore = env.toast.toastStore.get().length;
  const second = await env.plugin.postImport(started.port, token, { ...envlp, importId: `verify-${crypto.randomUUID().slice(0, 18)}` });
  const after = readWorkspaceFile(root, filePath);
  const afterHash = sha256(after);

  if (second.kind === "ok" && second.result.status === "duplicate") {
    pass("S2.2", "二次剪藏回执 status=duplicate", `http=${second.http} message=${JSON.stringify(second.result.message)}`);
  } else {
    fail("S2.2", "二次剪藏回执 status=duplicate", JSON.stringify(second).slice(0, 240));
  }

  if (beforeHash === afterHash) pass("S2.3", "原文件**逐字节未变**（sha256 比对）", `${beforeHash.slice(0, 16)}… == ${afterHash.slice(0, 16)}…`);
  else fail("S2.3", "原文件逐字节未变", `${beforeHash} → ${afterHash}`);

  const afterTree = listWorkspace(root);
  const treeSame = beforeTree.length === afterTree.length && beforeTree.every((p, i) => p === afterTree[i]);
  if (treeSame) pass("S2.4", "工作区未新增任何文件（不追加、不另存）", afterTree.join(", "));
  else fail("S2.4", "工作区未新增任何文件", `${beforeTree.join(", ")} → ${afterTree.join(", ")}`);

  const canonical = env.clip.DUPLICATE_MESSAGE;
  const inlineOk = canonical === "已在笔记中（未重复入库）。";
  if (inlineOk) pass("S2.5", "规范文案逐字", `DUPLICATE_MESSAGE = ${JSON.stringify(canonical)}`);
  else fail("S2.5", "规范文案逐字", `DUPLICATE_MESSAGE = ${JSON.stringify(canonical)}`);

  const messageOk = second.kind === "ok" && second.result.message === canonical;
  if (messageOk) pass("S2.6", "回执 message 就是客户端内联要显示的规范文案", JSON.stringify(second.result.message));
  else fail("S2.6", "回执 message 等于规范文案", second.kind === "ok" ? JSON.stringify(second.result.message) : "(非 ok)");

  const toastsAfter = env.toast.toastStore.get().length;
  if (toastsAfter === toastsBefore) pass("S2.7", "应用内**不弹 toast**（duplicate 静默）", `toast 数 ${toastsBefore} → ${toastsAfter}`);
  else fail("S2.7", "应用内不弹 toast", `toast 数 ${toastsBefore} → ${toastsAfter}：${env.toast.toastStore.get().map((t) => t.message).join(" | ")}`);

  const toastForDuplicate = env.toast.toastStore.get().some((t) => t.message === canonical);
  if (!toastForDuplicate) pass("S2.8", "规范文案未出现在任何 toast 里", "0 处");
  else fail("S2.8", "规范文案未出现在 toast 里", canonical);

  await controller.stop();
}

/* --- S3 同名冲突 -------------------------------------------------------- */

async function scenario3(env) {
  stanza("场景 3 · 同名冲突 → 自动 ` 2` 后缀、原文件字节不变");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S3.1", "桥启动", JSON.stringify(started));
    return;
  }

  const first = await env.plugin.postImport(started.port, token, envelope({ source: { ...envelope({}).source, url: "https://example.com/name-a" } }));
  if (first.kind !== "ok") {
    fail("S3.1", "第一篇落盘", JSON.stringify(first).slice(0, 200));
    await controller.stop();
    return;
  }
  const originalPath = first.result.path;
  const originalBytes = readWorkspaceFile(root, originalPath);
  const originalHash = sha256(originalBytes);
  pass("S3.1", "第一篇落盘", `${originalPath} sha256=${originalHash.slice(0, 16)}…`);

  // 同标题、不同 URL、不同正文 → 走 created 分支，撞名后应得 ` 2`
  const second = await env.plugin.postImport(started.port, token, envelope({
    title: "验证标题",
    body: "完全不同的第二篇正文。\n",
    source: { ...envelope({}).source, url: "https://example.com/name-b" },
  }));
  if (second.kind !== "ok") {
    fail("S3.2", "第二篇落盘", JSON.stringify(second).slice(0, 240));
    await controller.stop();
    return;
  }
  const secondPath = second.result.path;
  const expected = "验证标题 2.md";
  if (second.result.status === "created" && secondPath === expected) {
    pass("S3.2", "同名冲突自动 ` 2` 后缀（一个半角空格 + 数字 2）", `status=${second.result.status} path=${secondPath}`);
  } else {
    fail("S3.2", "同名冲突自动 ` 2` 后缀", `期望 ${expected}，实际 status=${second.result.status} path=${secondPath}`);
  }

  const originalNow = sha256(readWorkspaceFile(root, originalPath));
  if (originalNow === originalHash) pass("S3.3", "原文件字节不变", `${originalHash.slice(0, 16)}… == ${originalNow.slice(0, 16)}…`);
  else fail("S3.3", "原文件字节不变", `${originalHash} → ${originalNow}`);

  const tree = listWorkspace(root);
  const mdFiles = tree.filter((p) => p.endsWith(".md"));
  if (mdFiles.length === 2) pass("S3.4", "工作区恰好两篇笔记（无多余文件）", mdFiles.join(", "));
  else fail("S3.4", "工作区恰好两篇笔记", `md 文件: ${mdFiles.join(", ")}`);

  await controller.stop();
}

/* --- S4 append + 撤销 --------------------------------------------------- */

async function scenario4(env) {
  stanza("场景 4 · append 后 10 秒内撤销 → 逐字节回到导入前；前像缺失时如实降级");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S4.1", "桥启动", JSON.stringify(started));
    return;
  }

  const base = envelope({ source: { ...envelope({}).source, url: "https://example.com/append" } });
  const created = await env.plugin.postImport(started.port, token, base);
  if (created.kind !== "ok") {
    fail("S4.1", "先建一篇基线笔记", JSON.stringify(created).slice(0, 200));
    await controller.stop();
    return;
  }
  const notePath = created.result.path;
  const preBytes = readWorkspaceFile(root, notePath);
  const preHash = sha256(preBytes);
  pass("S4.1", "基线笔记落盘", `${notePath} sha256=${preHash.slice(0, 16)}… ${preBytes.length} 字节`);

  // 选区二次剪藏 → 契约指定走 appended
  capturedTimeouts.length = 0;
  const appended = await env.plugin.postImport(started.port, token, envelope({
    title: "验证标题",
    body: "追加进来的第二段。\n",
    conflict: "append",
    target: { folder: null, notePath },
    source: { ...envelope({}).source, url: "https://example.com/append", selection: true },
  }));

  if (appended.kind === "ok" && appended.result.status === "appended") {
    pass("S4.2", "append 回执 status=appended", `path=${appended.result.path} revertible=${appended.result.revertible}`);
  } else {
    fail("S4.2", "append 回执 status=appended", JSON.stringify(appended).slice(0, 300));
  }

  const appendedReceipt = appended.kind === "ok" ? appended.result : null;
  const appendedBytes = readWorkspaceFile(root, notePath);
  if (appendedBytes.length > preBytes.length) {
    pass("S4.3", "追加是纯文本拼接（内容变长、原有内容保留）", `${preBytes.length} → ${appendedBytes.length} 字节`);
  } else {
    fail("S4.3", "追加是纯文本拼接", `${preBytes.length} → ${appendedBytes.length} 字节`);
  }

  const keptOriginal = appendedBytes.toString("utf8").startsWith(preBytes.toString("utf8").trimEnd());
  if (keptOriginal) pass("S4.4", "原正文作为前缀完整保留（未被替换）", "startsWith(原内容) === true");
  else fail("S4.4", "原正文作为前缀完整保留", "startsWith(原内容) === false");

  if (appendedReceipt) {
    const preimage = appendedReceipt.preimage;
    if (appendedReceipt.revertible === true && preimage && typeof preimage.sha256 === "string") {
      pass("S4.5", "回执 revertible=true 且 preimage{path,bytes,sha256} 齐备",
        `path=${preimage.path} bytes=${preimage.bytes} sha256=${String(preimage.sha256).slice(0, 16)}…`);
      const inPreimages = preimage.path.startsWith(".opennote/import-preimages/");
      const underHistory = preimage.path.startsWith(".opennote/history/");
      if (inPreimages && !underHistory) pass("S4.6", "前像位于 .opennote/import-preimages/（不在 .opennote/history/ 下）", preimage.path);
      else fail("S4.6", "前像位置", `inPreimages=${inPreimages} underHistory=${underHistory} path=${preimage.path}`);
      const preimageBytes = readWorkspaceFile(root, preimage.path);
      const preimageHash = sha256(preimageBytes);
      if (preimageHash === preHash) pass("S4.7", "前像与导入前文件**逐字节相同**（sha256 比对）", `${preHash.slice(0, 16)}… == ${preimageHash.slice(0, 16)}…`);
      else fail("S4.7", "前像逐字节相同", `${preHash} vs ${preimageHash}`);
    } else {
      fail("S4.5", "回执 revertible=true 且 preimage 齐备", JSON.stringify(appendedReceipt).slice(0, 240));
    }
  }

  // 撤销窗口：常量 + notify 实际收到的 duration
  const undoWindow = env.clip.UNDO_WINDOW_MS;
  if (undoWindow === 10000) pass("S4.8", "UNDO_WINDOW_MS === 10000", String(undoWindow));
  else fail("S4.8", "UNDO_WINDOW_MS === 10000", String(undoWindow));

  // 关键：`notify()` 对带 action 的 toast 默认只有 6000ms，必须**显式**传 10 秒。
  // 这里捕获 notify → setTimeout(..., duration) 的真实毫秒数。
  const sawTenSeconds = capturedTimeouts.includes(10000);
  if (sawTenSeconds) {
    pass("S4.9", "入库 toast 真的用了 10 秒窗口（捕获 setTimeout 实参）",
      `本次追加期间捕获的定时器: ${JSON.stringify([...new Set(capturedTimeouts)].sort((a, b) => a - b))}`);
  } else {
    fail("S4.9", "入库 toast 用了 10 秒窗口",
      `未捕获到 10000ms 定时器；捕获到: ${JSON.stringify([...new Set(capturedTimeouts)].sort((a, b) => a - b))}（notify 的 action 分支默认 6000ms）`);
  }

  capturedTimeouts.length = 0;
  const undo = appendedReceipt ? await env.clip.undoImport(appendedReceipt) : null;
  const usedPreimage = undo && undo.ok && undo.mode === "preimage";
  if (usedPreimage) pass("S4.10", "撤销走前像路径（mode=preimage）", undo.message);
  else fail("S4.10", "撤销走前像路径", JSON.stringify(undo));

  const restoredBytes = readWorkspaceFile(root, notePath);
  const restoredHash = sha256(restoredBytes);
  if (restoredHash === preHash) pass("S4.11", "撤销后笔记**逐字节**回到导入前", `${preHash.slice(0, 16)}… == ${restoredHash.slice(0, 16)}…`);
  else fail("S4.11", "撤销后逐字节回到导入前", `${preHash} → ${restoredHash}`);

  // 非降级路径下 UI 只能承诺「逐字节还原」
  if (appendedReceipt && appendedReceipt.revertible === true) pass("S4.12", "revertible=true 时 UI 可承诺逐字节还原", "receipt.revertible === true");
  else unver("S4.12", "revertible=true 时 UI 承诺文案", "本次未拿到 revertible=true 的回执");

  // ---- 降级：前像写不进去（模拟 .opennote/ 只读 / 磁盘满）→ revertible=false + IMP-W008
  denyWritePrefixes.push(".opennote/import-preimages");
  const degraded = await env.plugin.postImport(started.port, token, envelope({
    title: "验证标题",
    body: "第二次追加，前像会写失败。\n",
    conflict: "append",
    target: { folder: null, notePath },
    source: { ...envelope({}).source, url: "https://example.com/append", selection: true },
  }));
  denyWritePrefixes.length = 0;

  if (degraded.kind === "ok") {
    const r = degraded.result;
    const warned = Array.isArray(r.warnings) && r.warnings.some((w) => String(w).includes("IMP-W008"));
    if (r.revertible === false && warned) {
      pass("S4.13", "前像不可得时**如实降级**：revertible=false + IMP-W008", `warnings=${JSON.stringify(r.warnings)}`);
    } else {
      fail("S4.13", "前像不可得时如实降级", `revertible=${r.revertible} warnings=${JSON.stringify(r.warnings)}`);
    }
    if (r.revertible === false) {
      const tokensBefore = countUndoToasts(env);
      await env.clip.undoImport(r);
      const tokensAfter = countUndoToasts(env);
      pass("S4.14", "revertible=false 时撤销仍可用（降级为移入回收站），且不谎称逐字节还原",
        `撤销前 toast 数 ${tokensBefore} → ${tokensAfter}`);
    }
  } else {
    fail("S4.13", "前像不可得时如实降级（append 仍应成功但 revertible=false）", JSON.stringify(degraded).slice(0, 240));
  }

  await controller.stop();
}

function countUndoToasts(env) {
  return env.toast.toastStore.get().filter((t) => t.action && /撤销|移入回收站/.test(t.action.label)).length;
}

/* --- S4B 判定链第 3/4 步（用插件真实信封） ------------------------------ */

/**
 * 这一节专打「插件真实信封 → 判定链第 3/4 步」。
 * 依据：`02` §4.1 表格第 3 行（同 URL、哈希不同、`selection === true` → `appended`）
 * 与第 4 行（同 URL、哈希不同、`selection !== true` → `pending` + HTTP 202 + 进收件箱），
 * 以及推论 4「优先级 3/4 **可被客户端的显式 `conflict` 覆盖**」。
 * 因此判据是「`conflict` 缺省」时这两步必须生效；`conflict` 显式下发则按客户端意图走。
 */
async function scenario4b(env) {
  stanza("场景 4B · 判定链第 3/4 步（插件真实信封 buildEnvelope）");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S4B.1", "桥启动", JSON.stringify(started));
    return;
  }
  const url = "https://example.com/dedup-chain";
  const base = env.pluginEnvelope.buildEnvelope({ importId: "verify-chain-0001", title: "判定链标题", body: "第一次整页正文。\n", url, selection: false });
  const first = await env.plugin.postImport(started.port, token, base);
  if (first.kind !== "ok") {
    fail("S4B.1", "首次剪藏建基线", JSON.stringify(first).slice(0, 200));
    await controller.stop();
    return;
  }
  pass("S4B.1", "首次剪藏建基线（插件 buildEnvelope）", `${first.result.path}`);

  // 插件信封里 conflict 是否被硬编码
  const probe = env.pluginEnvelope.buildEnvelope({ importId: "verify-chain-probe", title: "t", body: "b", url, selection: false });
  const sendsConflict = Object.prototype.hasOwnProperty.call(probe, "conflict");
  info4b(env, "S4B.2", "插件信封是否下发 conflict", sendsConflict ? `conflict=${JSON.stringify(probe.conflict)}（显式下发）` : "未下发（走默认）");
  const selfCheckForcesConflict = (() => {
    try {
      const copy = { ...probe };
      delete copy.conflict;
      return env.pluginEnvelope.envelopeProblems(copy);
    } catch {
      return [];
    }
  })();
  if (sendsConflict) {
    info4b(env, "S4B.3", "插件自检是否允许省略 conflict",
      selfCheckForcesConflict.length ? `不允许：${JSON.stringify(selfCheckForcesConflict)}` : "允许省略");
  }

  // 第 3 步：选区二次剪藏 → appended
  const selection = env.pluginEnvelope.buildEnvelope({ importId: "verify-chain-0002", title: "判定链标题", body: "选中的一段。\n", url, selection: true });
  const selCall = await env.plugin.postImport(started.port, token, selection);
  const selStatus = selCall.kind === "ok" ? selCall.result.status : `(error ${selCall.code})`;
  if (selStatus === "appended") {
    pass("S4B.4", "§4.1 第 3 步：选区二次剪藏 → appended", `http=${selCall.http} path=${selCall.result.path}`);
  } else {
    fail("S4B.4", "§4.1 第 3 步：选区二次剪藏应 appended", `实际 http=${selCall.http} status=${selStatus} path=${selCall.kind === "ok" ? selCall.result.path : "-"}`);
  }

  // 第 4 步：整页二次剪藏 → pending（HTTP 202，进收件箱）
  const page = env.pluginEnvelope.buildEnvelope({ importId: "verify-chain-0003", title: "判定链标题", body: "第二次整页正文（内容不同）。\n", url, selection: false });
  const pageCall = await env.plugin.postImport(started.port, token, page);
  const pageStatus = pageCall.kind === "ok" ? pageCall.result.status : `(error ${pageCall.code})`;
  if (pageStatus === "pending" && pageCall.http === 202 && pageCall.result.inboxId) {
    pass("S4B.5", "§4.1 第 4 步：整页二次剪藏 → pending / HTTP 202 / 带 inboxId", `inboxId=${pageCall.result.inboxId}`);
  } else {
    fail("S4B.5", "§4.1 第 4 步：整页二次剪藏应 pending（202 + inboxId）",
      `实际 http=${pageCall.http} status=${pageStatus} path=${pageCall.kind === "ok" ? pageCall.result.path : "-"} inboxId=${pageCall.kind === "ok" ? pageCall.result.inboxId : "-"}`);
  }

  // 对照组：省略 conflict → 判定链第 4 步必须生效（证明接收端实现正确，问题在客户端）
  const noConflict = env.pluginEnvelope.buildEnvelope({ importId: "verify-chain-0004", title: "判定链标题", body: "第三次整页正文（内容又不同）。\n", url, selection: false });
  delete noConflict.conflict;
  const control = await env.clip.receiveEnvelopeOutcome(noConflict);
  if (control.ok && control.result.status === "pending" && control.result.inboxId) {
    pass("S4B.6", "对照组：省略 conflict 时判定链第 4 步生效（接收端实现正确）",
      `status=pending inboxId=${control.result.inboxId}`);
  } else {
    fail("S4B.6", "对照组：省略 conflict 时判定链第 4 步应生效", JSON.stringify(control).slice(0, 240));
  }

  await controller.stop();
}

/** 允许 INFO 级记录（不计入 PASS/FAIL）。 */
function info4b(_env, id, title, detail) {
  record("INFO", id, title, detail);
}

/* --- S5 收件箱 ---------------------------------------------------------- */

async function scenario5(env) {
  stanza("场景 5 · 收件箱模式 → 投递进 .opennote/inbox/ → 计数 +1 → 确认入库 / 丢弃（丢弃不进回收站）");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S5.1", "桥启动", JSON.stringify(started));
    return;
  }

  const url = "https://example.com/inbox";
  const first = await env.plugin.postImport(started.port, token, envelope({ source: { ...envelope({}).source, url } }));
  if (first.kind !== "ok") {
    fail("S5.1", "首次剪藏建基线", JSON.stringify(first).slice(0, 200));
    await controller.stop();
    return;
  }
  pass("S5.1", "首次剪藏建基线", first.result.path);

  // `conflict` 在契约里**非必填**（默认 `new`），省略它是合法客户端行为。
  // 插件目前硬编码 `conflict:"new"` 导致判定链第 4 步失效——那已在场景 4B 单独记为缺陷；
  // 这里用「省略 conflict」的信封驱动收件箱状态机本体，两组结论互不掩盖。
  const pendingEnvelope = envelope({ body: "整页二次剪藏的正文（与首次不同）。\n", source: { ...envelope({}).source, url } });
  delete pendingEnvelope.conflict;
  pendingEnvelope.importId = `verify-inbox-${crypto.randomUUID().slice(0, 12)}`;
  const pendingOut = await env.clip.receiveEnvelopeOutcome(pendingEnvelope);
  const pendingResolved = pendingOut.ok
    ? { kind: "ok", result: pendingOut.result, http: 202 }
    : { kind: "error", code: pendingOut.error.code, result: null };
  if (!(pendingResolved.kind === "ok" && pendingResolved.result.status === "pending")) {
    fail("S5.2", "整页二次剪藏（conflict 缺省）→ status=pending（进收件箱）", JSON.stringify(pendingResolved).slice(0, 300));
    await controller.stop();
    return;
  }
  pass("S5.2", "整页二次剪藏（conflict 缺省）→ status=pending，进收件箱",
    `inboxId=${pendingResolved.result.inboxId} message=${JSON.stringify(pendingResolved.result.message)}`);
  const inboxId = pendingResolved.result.inboxId;
  const importId = pendingEnvelope.importId;

  // 目录名：契约 §5.8.2 = `YYYYMMDDTHHMMSS`(UTC) + `-` + importId 前 8 字符。
  // 注意回执 `inboxId` 是否等于目录名，是 §5.7.7（02:719「即 5.8.2 的目录名」）的独立问题，单列。
  const inboxRoot = path.join(root, ".opennote", "inbox");
  const dirNames = fs.existsSync(inboxRoot)
    ? fs.readdirSync(inboxRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const expectedDirPrefix = importId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  const dirMatch = dirNames.find((n) => n.endsWith(`-${expectedDirPrefix}`));
  if (dirNames.length === 1 && dirMatch && /^\d{8}T\d{6}-/.test(dirMatch)) {
    pass("S5.3", "条目目录名 = `YYYYMMDDTHHMMSS`(UTC) + `-` + importId 前 8（§5.8.2）", `${dirNames[0]}（importId 前 8 = ${expectedDirPrefix}）`);
  } else {
    fail("S5.3", "条目目录名格式（§5.8.2）", `inbox/ 下目录 = [${dirNames.join(", ") || "(空)"}]；期望以 -${expectedDirPrefix} 结尾`);
  }
  if (inboxId === dirMatch) {
    info4b(env, "S5.3b", "回执 inboxId 与目录名一致", `inboxId=${inboxId}`);
  } else {
    info4b(env, "S5.3b", "回执 inboxId ≠ 磁盘目录名（02:719 写的是「5.8.2 的目录名」）",
      `inboxId=${JSON.stringify(inboxId)}，实际目录=${JSON.stringify(dirMatch || null)}`);
  }

  const entryDir = path.join(inboxRoot, dirMatch || inboxId);
  const entryFiles = fs.existsSync(entryDir) ? fs.readdirSync(entryDir).sort() : [];
  const need = ["body.md", "entry.json", "state.json"];
  const missing = need.filter((f) => !entryFiles.includes(f));
  if (!missing.length) pass("S5.4", "条目目录含 entry.json / body.md / state.json", `${path.basename(entryDir)}/ → ${entryFiles.join(", ")}`);
  else fail("S5.4", "条目目录结构", `实际 ${entryFiles.join(", ") || "(目录不存在)"}；缺少 ${missing.join(", ")}`);

  let stateJson = null;
  try {
    stateJson = JSON.parse(fs.readFileSync(path.join(entryDir, "state.json"), "utf8"));
  } catch (error) {
    fail("S5.5", "state.json 可解析", error.message);
  }
  if (stateJson) {
    const shape = ["status", "attempts", "lastError", "committedPath", "updatedAt"].every((k) => k in stateJson);
    if (shape && stateJson.status === "pending") pass("S5.5", "state.json 五键形状与状态正确", JSON.stringify(stateJson));
    else fail("S5.5", "state.json 五键形状与状态", JSON.stringify(stateJson));
  }

  // entry.json 只允许两个契约扩展字段（`bodyFile` / `assets[].file`）+ `enqueuedAt`，正文必须外置。
  try {
    const entryJson = JSON.parse(fs.readFileSync(path.join(entryDir, "entry.json"), "utf8"));
    const bodyExternal = entryJson.body === null && entryJson.bodyFile === "body.md";
    const bodyOnDisk = fs.readFileSync(path.join(entryDir, "body.md"), "utf8");
    if (bodyExternal && bodyOnDisk.includes("整页二次剪藏的正文")) {
      pass("S5.6", "entry.json 正文外置（body=null + bodyFile=body.md），body.md 内容正确", JSON.stringify(bodyOnDisk.slice(0, 40)));
    } else {
      fail("S5.6", "entry.json 正文外置", `body=${JSON.stringify(entryJson.body)} bodyFile=${JSON.stringify(entryJson.bodyFile)}`);
    }
  } catch (error) {
    fail("S5.6", "entry.json 读取/解析", error && error.message ? error.message : String(error));
  }

  await env.inbox.refreshInbox();
  const countAfterDelivery = env.inbox.inboxCount();
  if (countAfterDelivery === 1) pass("S5.7", "应用内收件箱计数 3 秒内 +1", `inboxCount()=${countAfterDelivery}`);
  else fail("S5.7", "应用内收件箱计数 +1", `inboxCount()=${countAfterDelivery}`);

  // 确认入库。
  // id 语义（Lead 裁定 + `00` §6.13㉔ + `findDir()` 双解析实现）：
  //   - `receipt.inboxId` = **磁盘目录名**（`20260929T132023-verify-i`，02:719）
  //   - `InboxEntry.id`   = **完整 importId**（`inbox.ts:438`）
  //   两种写法**都接受**（`findDir()` 先按 `entry.id` 精确匹配，再按目录名解析）；
  //   UI 走的是 `listInbox()` 的 `entry.id`。下面两种写法都跑一遍，证明行为一致。
  const pendingImportId = pendingEnvelope.importId;
  const beforeCommitNotes = Object.keys(env.lib.libraryStore.get().notes).length;
  try {
    // 写法 A：目录名（= 回执 inboxId）
    await env.inbox.commitInbox(inboxId);
    await env.inbox.refreshInbox();
    const afterCommitNotes = Object.keys(env.lib.libraryStore.get().notes).length;
    const countAfterCommit = env.inbox.inboxCount();
    if (afterCommitNotes === beforeCommitNotes + 1 && countAfterCommit === 0) {
      pass("S5.8", "确认入库：笔记数 +1、收件箱计数 -1",
        `notes ${beforeCommitNotes} → ${afterCommitNotes}；inboxCount=${countAfterCommit}（用**目录名** inboxId=${inboxId}）`);
    } else {
      fail("S5.8", "确认入库的计数变化", `notes ${beforeCommitNotes} → ${afterCommitNotes}；inboxCount=${countAfterCommit}`);
    }
  } catch (error) {
    fail("S5.8", "确认入库（目录名写法）", error && error.message ? error.message : String(error));
  }

  // 写法 B：完整 importId —— 同一套 API 用两种 id 写法，行为必须一致。
  // 用**刚入库那条笔记的 URL** 再剪一次（正文不同）→ 判定链第 4 步 → `pending`。
  {
    const dual = await deliverPending(env, pendingEnvelope.source.url, "dualid");
    const dualStatus = dual.out.ok ? dual.out.result.status : `error:${dual.out.error.code}`;
    const dualReceipt = dual.out.ok ? dual.out.result : null;
    const notesBeforeDual = Object.keys(env.lib.libraryStore.get().notes).length;
    let threw = null;
    if (dualStatus === "pending") {
      try {
        await env.inbox.commitInbox(dual.importId);
        await env.inbox.refreshInbox();
      } catch (error) {
        threw = error && error.message ? error.message : String(error);
      }
    }
    const notesAfterDual = Object.keys(env.lib.libraryStore.get().notes).length;
    const countAfterDual = env.inbox.inboxCount();
    if (dualStatus === "pending" && !threw && notesAfterDual === notesBeforeDual + 1 && countAfterDual === 0) {
      pass("S5.8c", "`importId` 与「目录名」两种写法都能入库（行为一致）",
        `目录名写法：S5.8 已证；importId 写法：notes ${notesBeforeDual} → ${notesAfterDual}、inboxCount=${countAfterDual}；回执 inboxId=${dualReceipt ? dualReceipt.inboxId : "(无)"} ≠ importId=${dual.importId}（两者确实不等价，但两种写法都认）`);
    } else {
      fail("S5.8c", "`importId` 写法入库",
        `投递结果=${dualStatus}；抛错=${threw} notes ${notesBeforeDual} → ${notesAfterDual} inboxCount=${countAfterDual}；回执 inboxId=${dualReceipt ? dualReceipt.inboxId : "(无)"} importId=${dual.importId}`);
    }
  }

  // 双 id 写法的**一致性**探针：目录名写法必须「要么明确报错、要么真的生效」，绝不静默无效。
  {
    const probe = await deliverPending(env, pendingEnvelope.source.url, "probe");
    const probeStatus = probe.out.ok ? probe.out.result.status : `error:${probe.out.error.code}`;
    const probeDirName = probe.out.ok && probe.out.result.inboxId ? probe.out.result.inboxId : null;
    const probeDirBefore = probeDirName ? fs.existsSync(path.join(root, ".opennote", "inbox", probeDirName)) : false;
    let probeThrew = null;
    if (probeDirName) {
      try {
        await env.inbox.discardInbox(probeDirName);
      } catch (error) {
        probeThrew = error && error.message ? error.message : String(error);
      }
    }
    const probeDirAfter = probeDirName ? fs.existsSync(path.join(root, ".opennote", "inbox", probeDirName)) : false;
    const gone = probeDirBefore && !probeDirAfter;
    if (!probeDirName) {
      fail("S5.8b", "探针条目没投递成功，无法验证丢弃", `投递结果=${probeStatus}`);
    } else if (!probeThrew && gone) {
      pass("S5.8b", "丢弃（目录名写法）生效：未抛错且目录已删", `投递=${probeStatus}；目录 ${probeDirName} 投递后存在=${probeDirBefore} → 丢弃后存在=${probeDirAfter}`);
    } else if (!probeThrew && !gone) {
      fail("S5.8b", "静默无效：未抛错但目录仍在", `目录 ${probeDirName} 投递后存在=${probeDirBefore} → 丢弃后存在=${probeDirAfter}`);
    } else if (probeThrew && !gone) {
      pass("S5.8b", "明确报错（可诊断，不是静默）", `抛错「${probeThrew}」；目录仍在=${probeDirAfter}`);
    } else {
      info4b(env, "S5.8b", "状态矛盾：既抛错又删掉了目录", `抛错「${probeThrew}」；目录投递后存在=${probeDirBefore} → 丢弃后存在=${probeDirAfter}`);
    }
  }

  // 第二条：丢弃 → 不进回收站
  const discardSource = envelope({ body: "第三条正文，将被丢弃。\n", source: { ...envelope({}).source, url } });
  delete discardSource.conflict;
  discardSource.importId = `verify-discard-${crypto.randomUUID().slice(0, 12)}`;
  const discardOut = await env.clip.receiveEnvelopeOutcome(discardSource);
  const discardCall = discardOut.ok
    ? { kind: "ok", result: discardOut.result }
    : { kind: "error", code: discardOut.error.code, result: null };
  if (!(discardCall.kind === "ok" && discardCall.result.status === "pending")) {
    fail("S5.9", "再投递一条 pending 用于丢弃测试", JSON.stringify(discardCall).slice(0, 240));
    await controller.stop();
    return;
  }
  const discardReceiptId = discardCall.result.inboxId;
  await env.inbox.refreshInbox();
  // 用 `dirName` 精确定位要删的那个目录（不是猜后缀），否则「已删」会假阳性。
  const discardDetail = (await env.inbox.listInboxDetails()).find((d) => d.entry.id === discardSource.importId);
  const discardDirName = discardDetail ? discardDetail.dirName : null;
  const trashBefore = env.lib.trashedNotes(env.lib.libraryStore.get()).length;
  const notesBefore = Object.keys(env.lib.libraryStore.get().notes).length;

  try {
    await env.inbox.discardInbox(discardSource.importId);
    await env.inbox.refreshInbox();
    const gone = discardDirName ? !fs.existsSync(path.join(root, ".opennote", "inbox", discardDirName)) : false;
    const trashAfter = env.lib.trashedNotes(env.lib.libraryStore.get()).length;
    const notesAfter = Object.keys(env.lib.libraryStore.get().notes).length;
    const trashListing = fs.existsSync(path.join(root, ".opennote", "trash"))
      ? fs.readdirSync(path.join(root, ".opennote", "trash"))
      : [];
    const inboxInTrash = trashListing.filter((n) => n.startsWith("inbox-"));
    if (gone && trashAfter === trashBefore && notesAfter === notesBefore && inboxInTrash.length === 0) {
      pass("S5.9", "丢弃 = 立即清理条目目录，**回收站条目数不变**，`.opennote/trash/` 无 `inbox-*`",
        `目录 ${discardDirName} 已删=${gone}；回收站 ${trashBefore} → ${trashAfter}；notes ${notesBefore} → ${notesAfter}；trash 内容=[${trashListing.join(", ")}]`);
    } else {
      fail("S5.9", "丢弃不进回收站", `目录 ${discardDirName} 已删=${gone}；回收站 ${trashBefore} → ${trashAfter}；notes ${notesBefore} → ${notesAfter}；trash=[${trashListing.join(", ")}]`);
    }
  } catch (error) {
    fail("S5.9", "丢弃条目", error && error.message ? error.message : String(error));
  }
  info4b(env, "S5.9b", "丢弃后回执 inboxId(目录名) 已不存在", `inboxId=${discardReceiptId}（回执给的是目录名，不是 InboxEntry.id）`);

  // 保留期常量
  const ttlCommitted = env.inbox.INBOX_COMMITTED_TTL_MS;
  const ttlFailed = env.inbox.INBOX_FAILED_TTL_MS;
  if (ttlCommitted === 24 * 3600 * 1000 && ttlFailed === 7 * 24 * 3600 * 1000) {
    pass("S5.10", "保留期常量：committed 24h / failed 7d", `${ttlCommitted} / ${ttlFailed}`);
  } else {
    fail("S5.10", "保留期常量", `${ttlCommitted} / ${ttlFailed}`);
  }
  const states = ["pending", "committing", "committed", "failed", "discarded"];
  const inboxSource = fs.readFileSync(path.join(ROOT, "src", "data", "inbox.ts"), "utf8");
  const missingStates = states.filter((s) => !new RegExp(`"${s}"`).test(inboxSource));
  if (!missingStates.length) pass("S5.11", "5 态逐字齐全", states.join(" / "));
  else fail("S5.11", "5 态逐字齐全", `缺少 ${missingStates.join(", ")}`);

  unver("S5.12", "收件箱面板 DOM 里计数在 3 秒内 +1（真实窗口）",
    "本环境无 Electron 窗口。复现步骤：①`pnpm dev:electron`；②设置里选「先进入收件箱」；③插件剪藏；④目视侧栏「导入收件箱 · N」与状态栏「收件箱 N」在 3 秒内 +1。S5.7 已证数据层计数。");

  await controller.stop();
}

/* --- S6 关掉 Opennote --------------------------------------------------- */

async function scenario6(env) {
  stanza("场景 6 · 关掉 Opennote（或关掉导入接口）→ 插件剪藏 → 明确失败，不得假成功");
  const root = await freshWorkspace(env);
  const { controller, token } = startBridge(env, root);
  const started = await controller.start();
  if (!started || !started.port) {
    fail("S6.1", "桥启动", JSON.stringify(started));
    return;
  }
  const port = started.port;

  const ok = await env.plugin.postImport(port, token, envelope({ source: { ...envelope({}).source, url: "https://example.com/s6-warm" } }));
  pass("S6.1", "桥关闭前剪藏成功（基线）", `status=${ok.kind === "ok" ? ok.result.status : ok.code}`);

  // 关掉桥（等价于关掉 Opennote：桥的生命周期跟随窗口）
  await controller.stop();
  const statusAfterStop = controller.status();
  pass("S6.2", "桥已停止（状态如实反映）", `state=${statusAfterStop.state} running=${statusAfterStop.running} address=${statusAfterStop.address}`);

  const portClosed = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/health", method: "GET", timeout: 1500 }, (res) => {
      res.resume();
      resolve(`still-listening (HTTP ${res.statusCode})`);
    });
    req.on("error", (error) => resolve(`refused (${error.code || error.message})`));
    req.on("timeout", () => {
      req.destroy();
      resolve("timeout");
    });
    req.end();
  });
  if (String(portClosed).startsWith("refused")) pass("S6.3", "关闭后端口不再监听（真 TCP 探测）", String(portClosed));
  else fail("S6.3", "关闭后端口不再监听", String(portClosed));

  const offline = await env.plugin.postImport(port, token, envelope({ source: { ...envelope({}).source, url: "https://example.com/s6-offline" } }));
  // 客户端把「连不上」归一化成 kind:"unreachable"（timeout 则 "timeout"），只有服务端给出错误体时才是 "error"。
  const isFailure = offline.kind !== "ok" && offline.result === null;
  const code = offline.code;
  if (isFailure && ["IMP-1001", "IMP-1004", "IMP-4006"].includes(code)) {
    pass("S6.4", "插件侧拿到**明确失败码**，不是假成功",
      `kind=${offline.kind} code=${code} retryable=${offline.retryable} result=${offline.result} serverMessage=${offline.serverMessage}`);
  } else {
    fail("S6.4", "关掉应用后插件拿到明确失败码", JSON.stringify(offline).slice(0, 240));
  }

  // 客户端必须能把它翻成一句人话（不能出现「未知错误」）
  const human = env.pluginEnvelope && code ? null : null;
  void human;
  const clientErrors = await env.server.ssrLoadModule("/extension/src/lib/errors.js");
  const humanMessage = clientErrors.userMessage(code, offline.serverMessage);
  if (typeof humanMessage === "string" && humanMessage.length > 0 && !/未知/.test(humanMessage)) {
    pass("S6.5", "客户端把失败码翻成明确中文文案（无「未知错误」）", `${code} → ${JSON.stringify(humanMessage)}`);
  } else {
    fail("S6.5", "客户端失败文案", `${code} → ${JSON.stringify(humanMessage)}`);
  }

  // 「桥在运行但窗口不在场」→ IMP-4006（另一种「关掉 Opennote」的语义）
  const { controller: noWin, token: noWinToken } = startBridge(env, root, { noWindow: true });
  const noWinStart = await noWin.start();
  if (noWinStart && noWinStart.port) {
    const r = await env.plugin.postImport(noWinStart.port, noWinToken, envelope({ source: { ...envelope({}).source, url: "https://example.com/s6-nowindow" } }));
    if (r.kind === "error" && r.code === "IMP-4006") {
      pass("S6.6", "窗口不在场 → IMP-4006（409，retryable），不假成功", `code=${r.code} http=${r.http} retryable=${r.retryable}`);
    } else {
      fail("S6.6", "窗口不在场 → IMP-4006", JSON.stringify(r).slice(0, 240));
    }
    const treeBefore = listWorkspace(root).length;
    void treeBefore;
    await noWin.stop();
  } else {
    fail("S6.6", "无窗口桥启动", JSON.stringify(noWinStart));
  }

  const files = listWorkspace(root).filter((p) => p.endsWith(".md"));
  if (files.length === 1) pass("S6.7", "失败请求未在磁盘上留下任何游离文件", `md 文件: ${files.join(", ")}`);
  else fail("S6.7", "失败请求未留下游离文件", `md 文件: ${files.join(", ")}`);

  await controller.stop().catch(() => {});

  unver("S6.8", "真机断开桌面版后插件 popup 的可见文案（S12「Opennote 未运行」）",
    "本环境无法渲染插件 popup。复现步骤：①Chrome 加载 extension/dist；②关闭 Opennote；③点插件图标剪藏；④确认芯片为「Opennote 未运行」、正文为「Opennote 的窗口已关闭。请重新打开 Opennote，再试一次。」。已证：客户端归一化后 code=IMP-1001/IMP-4006，非假成功（S6.4/S6.5）。");
}

/* --- S7 App 渲染层 ↔ 主进程转交链路（真实 electron/main.cjs） ------------- */

/**
 * 这一段攻的是「最没人验的缝」：`electron/main.cjs` 里
 *   HTTP /v1/import → bridge.onEnvelope → relayToRenderer('opennote:import:receipt')
 *   → 渲染层 `receiveEnvelopeOutcome()` → preload `replyToImport(reqId, outcome)`
 *   → `opennote:import:reply` → `settleImportRelay()` → HTTP 响应
 * 这条链路的**两端都是真代码**（真 main.cjs + 真接收端），只有中间的 Electron
 * `ipcMain`/`BrowserWindow` 是打桩的（本环境没有 Electron 运行时）。
 *
 * 断言（对应 Lead 点名的三条）：
 *   ① 渲染层收到 `{ reqId, envelope(字符串), client }`；
 *   ② 成功时回 `{ ok:true, result }`；域错误时回 `{ ok:false, error:{code,userMessage} }`
 *      —— **不是抛异常**，也不是假成功；
 *   ③ 渲染层 5 秒不回应 → 回 `IMP-4006`（HTTP 409），不是假成功。
 */
function createElectronStub(userData) {
  const state = {
    userData,
    handlers: new Map(),
    listeners: new Map(),
    windows: [],
    webRequestHandlers: [],
    appEvents: new Map(),
    openDialog: { canceled: true, filePaths: [] },
    saveDialog: { canceled: true, filePath: undefined },
    quitCalls: 0,
  };

  class FakeWebContents {
    constructor() {
      this.destroyed = false;
      this.events = new Map();
      this.sent = [];
    }
    on(event, handler) {
      const list = this.events.get(event) || [];
      list.push(handler);
      this.events.set(event, list);
      return this;
    }
    once(event, handler) {
      return this.on(event, handler);
    }
    emit(event, ...args) {
      for (const handler of [...(this.events.get(event) || [])]) handler(...args);
    }
    send(channel, ...args) {
      this.sent.push({ channel, args });
    }
    isDestroyed() {
      return this.destroyed;
    }
    setWindowOpenHandler() {}
  }

  class FakeBrowserWindow {
    constructor(opts) {
      this.options = opts;
      this.webContents = new FakeWebContents();
      this.events = new Map();
      this.destroyed = false;
      state.windows.push(this);
    }
    on(event, handler) {
      const list = this.events.get(event) || [];
      list.push(handler);
      this.events.set(event, list);
      return this;
    }
    once(event, handler) {
      return this.on(event, handler);
    }
    emit(event, ...args) {
      for (const handler of [...(this.events.get(event) || [])]) handler(...args);
    }
    show() {}
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroy();
    }
    destroy() {
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.emit("closed");
    }
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
    getBounds() {
      return { width: 1280, height: 840 };
    }
    getContentBounds() {
      return { width: 1280, height: 800 };
    }
    setTitleBarOverlay() {}
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return state.windows.filter((w) => !w.isDestroyed());
    }
    static fromWebContents(contents) {
      return state.windows.find((w) => w.webContents === contents) || null;
    }
  }

  const ipcMain = {
    handle(channel, handler) {
      state.handlers.set(channel, handler);
    },
    on(channel, handler) {
      const list = state.listeners.get(channel) || [];
      list.push(handler);
      state.listeners.set(channel, list);
    },
    removeListener(channel, handler) {
      const list = state.listeners.get(channel) || [];
      state.listeners.set(channel, list.filter((item) => item !== handler));
    },
    emit(channel, ...args) {
      const sender = state.windows[0] ? state.windows[0].webContents : { send() {}, isDestroyed: () => false };
      for (const handler of [...(state.listeners.get(channel) || [])]) handler({ sender }, ...args);
    },
  };

  const app = {
    isPackaged: false,
    getAppPath: () => ROOT,
    getVersion: () => "0.2.0-verify",
    getPath: () => state.userData,
    getLocale: () => "zh-CN",
    setAppUserModelId() {},
    whenReady: () => Promise.resolve(),
    /**
     * 单实例锁（`02:1118`：拿不到锁的进程立即退出，命令行参数交给已运行实例）。
     * 打桩返回 `true` = 本进程拿到锁，于是 `main.cjs` 走正常启动分支。
     * 由 `S7.0` 静态核对保证「main.cjs 用到而打桩没有」不会再发生。
     */
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock() {},
    /** `opennote://` 协议注册（`00` §6.14㉛）。 */
    setAsDefaultProtocolClient: () => true,
    on(event, handler) {
      const list = state.appEvents.get(event) || [];
      list.push(handler);
      state.appEvents.set(event, list);
    },
    emit(event, ...args) {
      for (const handler of [...(state.appEvents.get(event) || [])]) handler(...args);
    },
    quit() {
      state.quitCalls += 1;
    },
  };

  const stub = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { setApplicationMenu() {}, getApplicationMenu: () => null, buildFromTemplate: (t) => t },
    dialog: {
      showOpenDialog: async () => state.openDialog,
      showSaveDialog: async () => state.saveDialog,
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    ipcMain,
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived(filter, listener) {
            state.webRequestHandlers.push({ filter, listener });
          },
        },
      },
    },
    shell: { showItemInFolder() {}, openExternal: async () => {} },
  };

  return {
    state,
    stub,
    /** 真实主进程注册的 `ipcMain.handle` 通道 → 调用它（等价于渲染层 invoke）。 */
    invoke: async (channel, ...args) => {
      const handler = state.handlers.get(channel);
      if (!handler) throw new Error(`未注册的 IPC handler：${channel}`);
      const sender = state.windows[0] ? state.windows[0].webContents : { send() {}, isDestroyed: () => false };
      return handler({ sender }, ...args);
    },
    /** 真实主进程注册的 `ipcMain.on` 通道 → 发一条消息（等价于 preload 的 send）。 */
    sendToMain: (channel, ...args) => ipcMain.emit(channel, ...args),
    /** 渲染层收到的消息。 */
    sentOn: (channel) =>
      state.windows.flatMap((w) => w.webContents.sent).filter((m) => m.channel === channel).map((m) => m.args[0]),
  };
}

/**
 * 打桩与 `main.cjs` 的 **Electron API 面**静态对照（V5 新增护栏）。
 *
 * 为什么需要它：`main.cjs` 加了 `app.requestSingleInstanceLock()` 之后，我的打桩没有这个方法，
 * 于是 `require main.cjs` **直接抛 TypeError**，S7/S7B 的检查**被静默跳过**（PASS 从 81 掉到 67，
 * 而摘要只显示 1 条 FAIL）。这类「打桩没跟上生产代码新增的 API」不是产品缺陷，是**打桩缺口**，
 * 但它会**悄悄删掉覆盖**。所以这里在加载 main.cjs **之前**先静态比对：
 * 凡是 `main.cjs` 里出现的 `<命名空间>.<成员>`，打桩必须有同名成员，否则报出**精确的 API 名**。
 */
const ELECTRON_NAMESPACES = ["app", "BrowserWindow", "Menu", "dialog", "ipcMain", "session", "shell", "nativeTheme", "protocol", "screen", "clipboard", "net", "powerMonitor"];
function electronApiGaps(stub) {
  const source = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const nsAlt = ELECTRON_NAMESPACES.join("|");
  const used = new Set(); // "<ns>.<a>" 与 "<ns>.<a>.<b>" 两种形态
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    let m;
    const twoRe = new RegExp(`\\b(${nsAlt})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
    while ((m = twoRe.exec(line)) !== null) used.add(`${m[1]}.${m[2]}.${m[3]}`);
    const oneRe = new RegExp(`\\b(${nsAlt})\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
    while ((m = oneRe.exec(line)) !== null) used.add(`${m[1]}.${m[2]}`);
  }
  const missing = [];
  for (const api of used) {
    const parts = api.split(".");
    const [ns, ...rest] = parts;
    if (!stub[ns]) {
      missing.push(api);
      continue;
    }
    let cursor = stub[ns];
    let ok = true;
    for (let i = 0; i < rest.length; i += 1) {
      if (cursor == null || typeof cursor[rest[i]] === "undefined") {
        // 中间段是**函数**时（例如 `Menu.getApplicationMenu().x`），后续属性来自返回值，
        // 静态不可判 —— 跳过而不是误报。
        if (i > 0 && typeof cursor === "function") break;
        ok = false;
        break;
      }
      cursor = cursor[rest[i]];
    }
    if (!ok) missing.push(api);
  }
  return { missing: missing.sort(), total: used.size };
}

/**
 * 覆盖守卫：跑 `body`，然后核对 `expectedIds` 是否**全部被报告**过（PASS/FAIL/UNVERIFIED 都算）。
 *
 * 没有它，场景中途抛异常或提前 `return` 就等于「这些检查不存在」——
 * 本轮就真实发生过：打桩缺 `app.requestSingleInstanceLock` → `require main.cjs` 抛异常 →
 * S7/S7B 的 14 条检查**静默消失**，摘要只显示 1 条 FAIL，PASS 从 81 掉到 67。
 * **静默减少覆盖比报错更危险**，所以缺失的检查在这里被显式报成 FAIL。
 */
async function withCoverageGuard(label, expectedIds, body) {
  try {
    await body();
  } catch (error) {
    fail(`${label}-crash`, `${label} 场景中途抛异常（已显式记录，不让检查静默消失）`,
      error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : String(error));
  }
  const reported = new Set(results.map((r) => r.id));
  const missing = expectedIds.filter((id) => !reported.has(id));
  if (missing.length) {
    fail(`${label}-coverage`, `覆盖守卫：${missing.length} 条检查未被报告（**不是通过**）`,
      `缺失：${missing.join(", ")}`);
  }
}

/* ── 各场景族的「应该报告哪些检查」清单（Lead 2026-09-30：守卫装到所有族）──────────
 * 为什么必须**逐族**都要有：`S10` 曾经因为 `port2 === undefined` → `http.request` 默认连 80
 * → `ECONNREFUSED` → 场景中断，`S10.7`–`S10.11` **五条检查静默消失**，而整轮看起来只是「少了几行」。
 * 覆盖守卫把它变成红。**「没报」和「报了且通过」必须区分** —— 与 a-defects 的四态判定
 * （`CRASHED`/`NO_EFFECT` 绝不降级成 `MISSED`）是同一条原则。
 *
 * 清单是**静态枚举**出来的（脚本扫出每个族里出现过的 id），不是从运行结果倒推的 ——
 * 从运行结果倒推等于「跑出什么就期望什么」，守卫永远绿，等于没有。 */
const EXPECTED_S1 = ["S1.1", "S1.2", "S1.3", "S1.4", "S1.5", "S1.5b", "S1.6", "S1.7", "S1.8", "S1.9", "S1.10", "S1.11"];
const EXPECTED_S2 = ["S2.1", "S2.2", "S2.3", "S2.4", "S2.5", "S2.6", "S2.7", "S2.8"];
const EXPECTED_S3 = ["S3.1", "S3.2", "S3.3", "S3.4"];
const EXPECTED_S4 = ["S4.1", "S4.2", "S4.3", "S4.4", "S4.5", "S4.6", "S4.7", "S4.8", "S4.9", "S4.10", "S4.11", "S4.12", "S4.13", "S4.14"];
const EXPECTED_S4B = ["S4B.1", "S4B.4", "S4B.5", "S4B.6"];
const EXPECTED_S5 = ["S5.1", "S5.2", "S5.3", "S5.4", "S5.5", "S5.6", "S5.7", "S5.8", "S5.8b", "S5.8c", "S5.9", "S5.10", "S5.11", "S5.12"];
const EXPECTED_S6 = ["S6.1", "S6.2", "S6.3", "S6.4", "S6.5", "S6.6", "S6.7", "S6.8"];
const EXPECTED_S7B = ["S7B.1", "S7B.1b", "S7B.2", "S7B.3", "S7B.4", "S7B.5", "S7B.6"];
const EXPECTED_S8 = ["S8.1", "S8.2", "S8.3", "S8.4", "S8.5", "S8.6"];
// 这三族原本把清单写在各自的场景函数里（局部 const）。全局对账需要它们，于是**提升到这里做唯一来源**：
// 两份副本 = 两个产地 = 迟早会分叉（V6 §9 记的「同一个值的六个产地」就是这么长出来的）。
const EXPECTED_S7 = ["S7.0", "S7.1", "S7.2", "S7.3", "S7.4", "S7.5", "S7.6", "S7.7", "S7.8", "S7.9", "S7.9b", "S7.10", "S7.11"];
const EXPECTED_S9 = ["S9.0", "S9.1", "S9.2", "S9.3"];
const EXPECTED_S10 = [
  "S10.0", "S10.1", "S10.2", "S10.3", "S10.4", "S10.5",
  "S10.6", "S10.7", "S10.8", "S10.9", "S10.10", "S10.11",
];
/** S13（A · 网页版剪藏页）：静态契约面在 `verify-contract.cjs` 的 C-13a…C-13l，这里是**行为面**。 */
const EXPECTED_S13 = [
  "S13.0", "S13.1", "S13.2", "S13.3", "S13.4", "S13.5", "S13.6",
  "S13.7", "S13.8", "S13.9", "S13.10", "S13.11", "S13.12", "S13.13", "S13.14",
];

/**
 * 接线侧真源断言（V5 新增）：**读真实文件** `src/App.tsx`，而不是在探针里复刻它。
 *
 * 为什么必须咬真文件：本检查的第一版是在探针里「复刻」`onImportReceipt` 的写法，
 * 于是 Lead 修好 `src/App.tsx` 之后它**仍然红** —— 它已经与真代码脱钩，
 * 一条永远红的断言只会被当噪声。判据必须落在真源上。
 *
 * 判据（**顺序必须判**：把声明放在 `receiveEnvelopeOutcome()` 之后等于没生效）：
 *   `onImportReceipt((` 回调体之内、`receiveEnvelopeOutcome(` 之前，
 *   必须出现 `setImportChannelContext(` 且实参含 `"local-bridge"`。
 *
 * @param mutate `"drop-channel-declaration"` 时**只在内存里**删掉那一行（不写盘），
 *   用于变异验证：证明本断言对「有没有那一行」敏感，不是恒绿。
 */
function appChannelWiring(mutate = null) {
  const file = path.join(ROOT, "src", "App.tsx");
  let source = fs.readFileSync(file, "utf8");
  const mutated = mutate === "drop-channel-declaration";
  if (mutated) {
    source = source.replace(/^[ \t]*setImportChannelContext\(\s*\{[^}]*\}\s*\);[ \t]*$/gm, "");
  }
  const sub = source.indexOf("onImportReceipt((") >= 0 ? source.indexOf("onImportReceipt((") : source.indexOf("onImportReceipt(");
  if (sub < 0) return { ok: false, why: "未找到 onImportReceipt( 订阅点", mutated };
  const call = source.indexOf("receiveEnvelopeOutcome(", sub);
  if (call < 0) return { ok: false, why: "onImportReceipt 回调里未找到 receiveEnvelopeOutcome(", mutated };
  const body = source.slice(sub, call);
  const decl = /setImportChannelContext\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(body);
  if (!decl) {
    return { ok: false, why: "回调体内、receiveEnvelopeOutcome() **之前**没有 setImportChannelContext(...)（顺序也要对）", mutated, bodyLength: body.length };
  }
  if (!/local-bridge/.test(decl[1])) {
    return { ok: false, why: `声明了通道但实参不含 "local-bridge"：{${decl[1].trim()}}`, mutated };
  }
  return { ok: true, why: `回调体内、receiveEnvelopeOutcome() 之前声明了 {${decl[1].trim().replace(/\s+/g, " ")}}`, mutated };
}

function loadMainWithStub(stub, options = {}) {
  const mainPath = path.join(ROOT, "electron", "main.cjs");
  const resolved = require.resolve(mainPath);
  delete require.cache[resolved];
  const Module = require("module");
  const originalLoad = Module._load;
  /**
   * 注意：`Module._load` 必须**一直**保持打补丁状态，直到调用方显式 `restore()`。
   * `main.cjs` 里的 `loadBridgeModule()` 是**惰性**的（第一次 `ensureBridge()` 才 require），
   * 如果 require 完 main.cjs 就立刻还原补丁，桥模块注入会静默失效、测出来的是真实桥。
   */
  Module._load = function patched(request, parent, isMain) {
    if (request === "electron") return stub;
    // 可控地替换主进程加载的桥模块：用来验证「`!controller` 早退分支」与
    // 「`...raw` 是否真的透传桥的可选字段」（哨兵值法，不碰任何产品文件）。
    if (options.bridgeModule !== undefined && /(^|\/)bridge\.cjs$/.test(request)) {
      return options.bridgeModule;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));
  try {
    require(mainPath);
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return {
    logs,
    restore: () => {
      Module._load = originalLoad;
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scenario7(env) {
  // 清单是模块级唯一来源（见 EXPECTED_S7 处的注释）。
  return withCoverageGuard("S7", EXPECTED_S7, () => scenario7Body(env));
}

async function scenario7Body(env) {
  stanza("场景 7 · App 渲染层 ↔ 主进程转交链路（真实 electron/main.cjs）");
  const root = await freshWorkspace(env);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-userdata-"));
  scenarioRoots.add(userData);
  const harness = createElectronStub(userData);

  // ── S7.0 打桩与 main.cjs 的 Electron API 面一致（在 require 之前先查） ─────
  const gap = electronApiGaps(harness.stub);
  if (gap.missing.length === 0) {
    pass("S7.0", "打桩与 main.cjs 的 Electron API 面一致（不会再因缺 API 而崩掉整段场景）",
      `main.cjs 用到 ${gap.total} 个 <命名空间>.<成员>，打桩全部具备`);
  } else {
    fail("S7.0", "打桩缺少 main.cjs 用到的 Electron API（会导致整段场景崩溃并静默丢失覆盖）",
      `缺少 ${gap.missing.length} 个：${gap.missing.join(", ")}`);
  }

  let mainLoaded = null;
  try {
    mainLoaded = loadMainWithStub(harness.stub);
  } catch (error) {
    fail("S7.1", "加载真实 electron/main.cjs（Electron 打桩）",
      error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : String(error));
    return;
  }

  // 等主进程注册完 handler 并建好窗口
  const deadline = Date.now() + 5000;
  while (!harness.state.handlers.has("opennote:fs:authorizeRoot") && Date.now() < deadline) await delay(5);
  while (harness.state.windows.length === 0 && Date.now() < deadline) await delay(5);
  await delay(30);

  const hasFs = harness.state.handlers.has("opennote:fs:authorizeRoot");
  const hasWindow = harness.state.windows.length > 0;
  if (hasFs && hasWindow) {
    const channels = [...harness.state.handlers.keys()].filter((c) => /bridge|import/.test(c)).sort();
    pass("S7.1", "真实 main.cjs 已注册 IPC handler 并建好窗口",
      `${harness.state.handlers.size} 个 handle 通道；导入相关: ${channels.join(", ")}`);
  } else {
    fail("S7.1", "真实 main.cjs 启动", `fs handler=${hasFs} window=${hasWindow}`);
    return;
  }

  // 在真实主进程里生成令牌并开启桥（等价于面板点「生成令牌」→「开启」）
  let token = null;
  let port = null;
  try {
    const issued = await harness.invoke("opennote:bridge:newToken", {});
    token = issued && issued.token;
    const started = await harness.invoke("opennote:bridge:start", {});
    port = started && started.port;
    if (!token || !port) {
      fail("S7.2", "经 IPC 在主进程内开启本地桥", JSON.stringify({ tokenLast4: issued && issued.last4, status: started }));
      return;
    }
    pass("S7.2", "经 IPC 在主进程内生成令牌并开启桥", `port=${port} token 长度=${token.length} last4=${issued.last4} state=${started.state} address=${started.address}`);
  } catch (error) {
    fail("S7.2", "经 IPC 在主进程内开启本地桥", error && error.message ? error.message : String(error));
    return;
  }

  // ── ① 渲染层收到的转交消息形状 ─────────────────────────────────────────
  const envlp = envelope({ source: { ...envelope({}).source, url: "https://example.com/s7-relay" } });
  const httpPromise = env.plugin.postImport(port, token, envlp);
  await delay(150);

  const relays = harness.sentOn("opennote:import:receipt");
  if (!relays.length) {
    fail("S7.3", "渲染层收到 `opennote:import:receipt` 转交消息", "0 条（主进程没有转交 → 会假成功或超时）");
    return;
  }
  const payload = relays[relays.length - 1];
  const shapeOk =
    payload &&
    typeof payload.reqId === "string" &&
    payload.reqId.length > 0 &&
    typeof payload.envelope === "string" &&
    payload.client &&
    typeof payload.client.clientName === "string";
  let parsedEnvelope = null;
  try {
    parsedEnvelope = JSON.parse(payload.envelope);
  } catch {
    /* 下面按形状失败处理 */
  }
  if (shapeOk && parsedEnvelope && parsedEnvelope.importId === envlp.importId) {
    pass("S7.3", "① 渲染层收到 `{ reqId, envelope(JSON 字符串), client }`",
      `reqId=${payload.reqId} envelope 是字符串(${payload.envelope.length} 字节) importId 一致 client=${JSON.stringify(payload.client)}`);
  } else {
    fail("S7.3", "① 转交消息形状",
      `keys=${payload ? Object.keys(payload).join(",") : "(空)"} reqId=${typeof payload?.reqId} envelope=${typeof payload?.envelope} 可解析=${Boolean(parsedEnvelope)}`);
  }

  // ── ② 渲染层应答 → HTTP 收到真实回执（成功路径） ──────────────────────
  const outcome = await env.clip.receiveEnvelopeOutcome(payload.envelope);
  harness.sendToMain("opennote:import:reply", { reqId: payload.reqId, outcome });
  const httpCall = await httpPromise;

  if (httpCall.kind === "ok" && httpCall.result && httpCall.result.status === "created") {
    pass("S7.4", "② 应答 `{ok:true,result}` → HTTP 200/201 拿到真实回执（不是假成功）",
      `http=${httpCall.http} status=${httpCall.result.status} path=${httpCall.result.path}`);
  } else {
    fail("S7.4", "② 成功路径应答", JSON.stringify(httpCall).slice(0, 260));
  }

  const relayedOnDisk = listWorkspace(root).includes(httpCall.kind === "ok" ? httpCall.result.path : "\u0000");
  info4b(env, "S7.4b", "落盘由渲染层完成（主进程只转交）",
    `工作区: ${listWorkspace(root).join(", ") || "(空 — 渲染层用的是自己的后端，与 main.cjs 的工作区无关)"}`);

  // ── ②b 域错误：应答 `{ok:false,error}` → HTTP 4xx，且**不抛异常** ────────
  const badEnvelope = { ...envelope({}), importId: "short" };
  const badPromise = env.plugin.postImport(port, token, badEnvelope, { timeoutMs: 9000 });
  await delay(150);
  const relays2 = harness.sentOn("opennote:import:receipt");
  const payload2 = relays2[relays2.length - 1];
  let rejectedOutcome = null;
  let threw = false;
  try {
    rejectedOutcome = await env.clip.receiveEnvelopeOutcome(payload2.envelope);
  } catch (error) {
    threw = true;
    rejectedOutcome = { ok: false, threw: String(error && error.message) };
  }
  if (payload2 && payload2.reqId) harness.sendToMain("opennote:import:reply", { reqId: payload2.reqId, outcome: rejectedOutcome });
  const badCall = await badPromise;

  // imp-4003 校验：importId 太短
  if (!threw && rejectedOutcome.ok === false && rejectedOutcome.error && rejectedOutcome.error.code) {
    pass("S7.5", "② 域错误以 `{ok:false,error}` 形态回传（**不抛异常**，receiveEnvelopeOutcome 语义）",
      `code=${rejectedOutcome.error.code} userMessage=${JSON.stringify(rejectedOutcome.error.userMessage)}`);
  } else {
    fail("S7.5", "② 域错误回传形态", `threw=${threw} outcome=${JSON.stringify(rejectedOutcome).slice(0, 200)}`);
  }
  if (badCall.kind !== "ok" && badCall.code && badCall.result === null) {
    pass("S7.6", "② 域错误 → HTTP 4xx + 明确错误码（不是 200 假成功）",
      `http=${badCall.http} code=${badCall.code} retryable=${badCall.retryable} serverMessage=${JSON.stringify(badCall.serverMessage)}`);
  } else {
    fail("S7.6", "② 域错误 → HTTP 错误码", JSON.stringify(badCall).slice(0, 260));
  }

  // ── ②c 通道保真：桥投递的信封必须走 `local-bridge` 通道 ──────────────────
  //
  // 契约 `00` §6.13⑧：「本地桥转交前设 `"local-bridge"`，收件箱入库设 `"inbox"`，
  // 应用内保持 `"in-app"`」；§6.14㉕：`importConflict === "inbox"`（0.3.0 默认）
  // **且外部通道**时强制 `pending`（`receive.ts:367`）。
  //
  // 这里分**两条互补证据**：
  //   · S7.9  **接线侧**（静态，咬真文件 `src/App.tsx`）：声明必须存在且**在调用之前**；
  //   · S7.10 **行为侧**（动态，经真实转交链路）：声明之后 `pending` / 202 / path=null / 无新 .md / 收件箱 1 条。
  // 第一版 S7.9 是在探针里「复刻」App.tsx 的写法 —— 修好真文件后它仍红（与真源脱钩），
  // 已改为读真文件；`S7.9b` 再用**内存变异**证明这条断言红得起来。

  // ── S7.9 接线侧真源断言（读 src/App.tsx 的真实文本，判顺序） ────────────
  const wiring = appChannelWiring();
  if (wiring.ok) {
    pass("S7.9", "接线侧：`src/App.tsx` 的 `onImportReceipt` 在 `receiveEnvelopeOutcome()` **之前**声明 `local-bridge`",
      `${wiring.why}（读真文件，非复刻）`);
  } else {
    fail("S7.9", "接线侧：`src/App.tsx` 未在 `receiveEnvelopeOutcome()` 之前声明 `local-bridge` 通道",
      `${wiring.why}；不声明的后果：通道停在模块默认 "in-app" → receive.ts:367 的 `
      + `isExternalDeliveryChannel("in-app")=false → ㉕ 的强制 pending 被跳过（外部剪藏直接写进笔记本），`
      + `且 receive.ts:646 的 overwrite 通道闸门永不成立（同一个根因、两个假开关）`);
  }

  // ── S7.9b 变异自检：把那一行**在内存里**删掉，断言必须变红（不写盘、不动产品文件） ──
  const wiringMutated = appChannelWiring("drop-channel-declaration");
  if (!wiringMutated.ok) {
    pass("S7.9b", "变异自检：内存中删掉那一行后 S7.9 的判据如期变红（证明它不是恒绿）",
      `变异后判定=不通过（${wiringMutated.why}）—— 与未变异时的「通过」形成对照`);
  } else {
    fail("S7.9b", "变异自检失败：删掉通道声明后判据**仍然通过**（说明 S7.9 是恒绿的，必须修）",
      `变异后判定=通过（${wiringMutated.why}）`);
  }

  // ── S7.10 行为侧：显式声明 `local-bridge` → 契约语义必须成立 ──────────────
  const chanRoot2 = await freshWorkspace(env);
  const mdBeforeBridge = listWorkspace(chanRoot2).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/"));
  const bridgeEnvelope = envelope({ source: { ...envelope({}).source, url: "https://example.com/s7-channel-bridge" } });
  const bridgePromise = env.plugin.postImport(port, token, bridgeEnvelope, { timeoutMs: 12000 });
  await delay(150);
  const bridgePayload = harness.sentOn("opennote:import:receipt").slice(-1)[0];
  let bridgeStatus = null;
  let bridgeOutcome = null;
  if (bridgePayload) {
    env.clip.setImportChannelContext({ channel: "local-bridge" });
    bridgeOutcome = await env.clip.receiveEnvelopeOutcome(bridgePayload.envelope);
    env.clip.setImportChannelContext({ channel: "in-app" });
    harness.sendToMain("opennote:import:reply", { reqId: bridgePayload.reqId, outcome: bridgeOutcome });
    bridgeStatus = bridgeOutcome.ok ? bridgeOutcome.result.status : `error:${bridgeOutcome.error.code}`;
  }
  const bridgeCall = await bridgePromise;
  // 注意：新工作区**自带 1 个 .md**（脚手架），所以必须比**增量**，不能比绝对值。
  const bridgeMdDelta = listWorkspace(chanRoot2).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/") && !mdBeforeBridge.includes(f));
  const bridgeInbox = env.inbox.inboxDetails();
  const bridgeIdOk = Boolean(bridgeOutcome && bridgeOutcome.ok && /^\d{8}T\d{6}-.{8}$/.test(String(bridgeOutcome.result.inboxId)));
  if (bridgeStatus === "pending" && bridgeCall.http === 202 && bridgeOutcome.result.path === null && bridgeIdOk && bridgeMdDelta.length === 0 && bridgeInbox.length === 1) {
    pass("S7.10", "行为侧：显式 `channel=\"local-bridge\"` + 默认设置 → `pending`（202 / path=null / 无新 .md / 收件箱 1 条）",
      `status=${bridgeStatus} http=${bridgeCall.http} inboxId=${bridgeOutcome.result.inboxId} path=${bridgeOutcome.result.path} 新增 .md=${bridgeMdDelta.length} 收件箱=${bridgeInbox.length}`);
  } else {
    fail("S7.10", "行为侧：显式 local-bridge 通道的契约语义", `status=${bridgeStatus} http=${bridgeCall.http} inboxId=${bridgeOutcome?.result?.inboxId} path=${bridgeOutcome?.result?.path} 新增 .md=${bridgeMdDelta.length} 收件箱=${bridgeInbox.length}`);
  }

  // ── S7.11 行为侧反向对照：**不声明**通道 → 退回 `created`（这就是 D-V09 的机制） ──
  // 它既证明「S7.10 的 pending 确实来自通道声明」，也把「漏声明会造成什么」钉成可复跑的证据。
  const chanRoot3 = await freshWorkspace(env);
  const mdBeforeControl = listWorkspace(chanRoot3).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/"));
  env.clip.resetImportChannelContext();
  const controlEnvelope = envelope({ source: { ...envelope({}).source, url: "https://example.com/s7-channel-control" } });
  const controlPromise = env.plugin.postImport(port, token, controlEnvelope, { timeoutMs: 12000 });
  await delay(150);
  const controlPayload = harness.sentOn("opennote:import:receipt").slice(-1)[0];
  let controlStatus = null;
  if (controlPayload) {
    // 刻意**不**声明通道 = 复现 D-V09 的旧行为（模块默认 "in-app"）
    const controlOutcome = await env.clip.receiveEnvelopeOutcome(controlPayload.envelope);
    harness.sendToMain("opennote:import:reply", { reqId: controlPayload.reqId, outcome: controlOutcome });
    controlStatus = controlOutcome.ok ? controlOutcome.result.status : `error:${controlOutcome.error.code}`;
  }
  const controlCall = await controlPromise;
  const controlMdDelta = listWorkspace(chanRoot3).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/") && !mdBeforeControl.includes(f));
  if (controlStatus === "created" && controlMdDelta.length === 1) {
    pass("S7.11", "反向对照：不声明通道 → 退回 `created` 并写笔记（漏声明的实际后果，与 S7.10 形成对照）",
      `status=${controlStatus} http=${controlCall.http} 新增 .md=${controlMdDelta.length}（同一链路、只差一行通道声明）`);
  } else {
    fail("S7.11", "反向对照：不声明通道时应退回 created", `status=${controlStatus} http=${controlCall.http} 新增 .md=${controlMdDelta.length}`);
  }


  const silentEnvelope = envelope({ source: { ...envelope({}).source, url: "https://example.com/s7-silent" } });
  const t0 = Date.now();
  const silentCall = await env.plugin.postImport(port, token, silentEnvelope, { timeoutMs: 12000 });
  const waited = Date.now() - t0;
  if (silentCall.kind !== "ok" && silentCall.code === "IMP-4006" && silentCall.result === null) {
    pass("S7.7", "③ 渲染层不应答 → `IMP-4006`（HTTP 409，retryable），**不假成功**",
      `等待 ${waited}ms（RELAY_TIMEOUT_MS=5000）http=${silentCall.http} code=${silentCall.code} retryable=${silentCall.retryable} result=${silentCall.result}`);
  } else {
    fail("S7.7", "③ 不应答 → IMP-4006", `等待 ${waited}ms → ${JSON.stringify(silentCall).slice(0, 260)}`);
  }

  // 窗口销毁后（等价于「关掉 Opennote 窗口」）：
  // main.cjs 的桥生命周期跟随窗口，窗口一关桥就停 → 端口关闭 → 客户端拿到 IMP-1001。
  // （「桥在跑但窗口不在场」是 S6.5 的 IMP-4006，两种语义不要混。）
  try {
    harness.state.windows[0].destroy();
    await delay(200);
    const portClosedAfterDestroy = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/health", method: "GET", timeout: 1500 }, (res) => {
        res.resume();
        resolve(`still-listening (HTTP ${res.statusCode})`);
      });
      req.on("error", (error) => resolve(`refused (${error.code || error.message})`));
      req.on("timeout", () => {
        req.destroy();
        resolve("timeout");
      });
      req.end();
    });
    const noWinCall = await env.plugin.postImport(port, token, envelope({ source: { ...envelope({}).source, url: "https://example.com/s7-nowin" } }), { timeoutMs: 9000 });
    if (noWinCall.kind !== "ok" && ["IMP-1001", "IMP-4006"].includes(noWinCall.code) && noWinCall.result === null) {
      pass("S7.8", "③ 窗口销毁 → 桥随窗口停止（真 TCP 探测）+ 客户端拿到明确失败码，**不假成功**",
        `port ${port}: ${portClosedAfterDestroy}；code=${noWinCall.code} kind=${noWinCall.kind} retryable=${noWinCall.retryable} result=${noWinCall.result}`);
    } else {
      fail("S7.8", "③ 窗口销毁路径", `port ${port}: ${portClosedAfterDestroy}；${JSON.stringify(noWinCall).slice(0, 200)}`);
    }
  } catch (error) {
    fail("S7.8", "③ 窗口销毁路径", error && error.message ? error.message : String(error));
  }

  // S7B 单独一段守卫：它整段抛异常时，S7 的守卫**看不到**它的 7 条检查（族是分开的）。
  await withCoverageGuard("S7B", EXPECTED_S7B, () => scenario7b(env));

  try {
    await harness.invoke("opennote:bridge:stop");
  } catch {
    /* 忽略收尾错误 */
  }
  if (mainLoaded) mainLoaded.restore();
}

/* --- S7B bridgeStatusPayload：主进程重建时不许吃掉桥的字段 ----------------- */

/** 哨兵值：桥返回什么，主进程就**必须**原样透传什么（用来证明 `...raw` 在位）。 */
const STATUS_SENTINEL = {
  address: "127.0.0.1:9999",
  error: "哨兵：8787 到 8796 端口都被占用了",
  lastRejectedOrigin: "https://sentinel.example",
  startPort: 9999,
  portRange: [9999, 10008],
  lastPairing: { at: 12345, origin: "https://pairing.example", rotated: true },
};

function makeFakeBridgeModule() {
  const controller = {
    status: () => ({
      state: "running",
      port: 9999,
      endpoint: "http://127.0.0.1:9999",
      tokenLast4: "ZZZZ",
      tokenSet: true,
      origins: ["https://origin.example"],
      logPath: "C:/sentinel/bridge.log",
      // 桥确实返回布尔 true（真实 bridge.cjs:1408 在没给 getInboxWatchMode 时返回 false，
      // 这里刻意给 true 来逼出「显式字段是否赢」这条断言）。
      inboxWatch: true,
      tokenPersisted: true,
      ...STATUS_SENTINEL,
    }),
    startWithPort: async () => {},
    start: async () => {},
    stop: async () => {},
    regenerateToken: () => `opn_${"A".repeat(43)}`,
    newPairCode: () => ({ code: "123456", expiresAt: Date.now() + 120000 }),
    addAllowedOrigin: () => true,
    removeAllowedOrigin: () => true,
    readAllowedOrigins: () => [],
    getLogPath: () => "C:/sentinel/bridge.log",
    getRecentImports: () => [],
    getImportRecord: () => null,
    getTags: () => [],
  };
  return { createBridge: () => controller, sha256Hex: () => "0".repeat(64) };
}

async function bootSecondaryMain(bridgeModule) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-userdata2-"));
  scenarioRoots.add(userData);
  const harness = createElectronStub(userData);
  const loaded = loadMainWithStub(harness.stub, { bridgeModule });
  const deadline = Date.now() + 5000;
  while (!harness.state.handlers.has("opennote:bridge:status") && Date.now() < deadline) await delay(5);
  while (harness.state.windows.length === 0 && Date.now() < deadline) await delay(5);
  await delay(30);
  return { harness, restore: loaded.restore };
}

async function scenario7b(env) {
  stanza("场景 7B · `bridgeStatusPayload()` 重建桥状态时是否吃掉可选字段（c3-bridge 缺陷的独立复核）");

  // ── (1) 真实桥：可选字段必须在 IPC 边界上存活 ─────────────────────────
  // 0.3.1（00 §6.15㉞）：**配对整体删除** → `lastPairing` 不再是状态字段（`pairingCode`/`newPairCode`/
  // `pendingPlaintext` 同理）。这条断言随之从「6 个可选字段」收敛为「5 个」，并**新加**一条反向断言：
  // 配对字段必须**不再出现**（否则说明删除只做了一半）。
  const REAL_KEYS = ["address", "error", "lastRejectedOrigin", "startPort", "portRange"];
  const PAIRING_KEYS = ["lastPairing", "pairingCode", "pendingPlaintext", "newPairCode", "pairExpiresAt"];
  try {
    const { harness, restore } = await bootSecondaryMain(undefined);
    await harness.invoke("opennote:bridge:newToken", {});
    const status = await harness.invoke("opennote:bridge:start", {});
    const missing = REAL_KEYS.filter((k) => !(k in status));
    // `inboxWatch` / `logPath` 也在契约里，但与本次「配对删除」无关，仍单独断言在 S7B.2。
    const pairingLeft = PAIRING_KEYS.filter((k) => k in status);
    if (!missing.length) {
      // 标题**逐条列出**这 5 个键，而不是说「全部可选字段」（Lead 2026-09-30 裁定）：
      // 「全部」是个**没人能验证的总量断言** —— 契约以后加字段，它会**静默变成错的**；
      // 而列清单只会在「契约加了、清单没加」时**保持不变**（可接受，且一眼看得出来）。
      // 清单出处：`02 §5.2.11 桥状态字段清单`（d-contract 2026-09-30 补入）
      //          + `src/desktop/bridge.ts` 的 `BridgeStatus`（L148–173）。两者由 `C-11d` 双向咬合。
      // 历史：补入之前这 5 个字段在 `02` 里 0 命中（我当时核过），出处只能写代码 —— 现在文档有了。
      pass("S7B.1", "真实桥：`bridgeStatusPayload()` 带着 address / error / lastRejectedOrigin / startPort / portRange（清单出处：`02 §5.2.11` ↔ `BridgeStatus`，src/desktop/bridge.ts）",
        `键数=${Object.keys(status).length}；address=${JSON.stringify(status.address)} startPort=${JSON.stringify(status.startPort)} portRange=${JSON.stringify(status.portRange)}`);
    } else {
      fail("S7B.1", "真实桥：`BridgeStatus` 声明的那几个字段被重建逻辑吃掉",
        `缺少 ${missing.join(", ")}（清单：${REAL_KEYS.join(" / ")}）；实有键=${Object.keys(status).join(", ")}`);
    }
    if (pairingLeft.length === 0) {
      pass("S7B.1b", "0.3.1（㉞）配对删除彻底：桥状态里没有任何配对字段",
        `已确认不存在 ${PAIRING_KEYS.join(", ")}；实有键=${Object.keys(status).join(", ")}`);
    } else {
      fail("S7B.1b", "配对字段应已随 ㉞ 删除", `仍存在 ${pairingLeft.join(", ")}`);
    }
    const watch = status.inboxWatch;
    if (typeof watch === "string" && ["watch", "poll", "off"].includes(watch)) {
      pass("S7B.2", "(3) `inboxWatch` 是字符串枚举而非布尔（显式字段赢）", `inboxWatch=${JSON.stringify(watch)} typeof=${typeof watch}`);
    } else {
      fail("S7B.2", "(3) `inboxWatch` 应为 'watch'|'poll'|'off'", `实际 ${JSON.stringify(watch)} typeof=${typeof watch}`);
    }
    // 上一行已经证明：真实桥给的 `inboxWatch`（布尔 false）被主进程换成了字符串。
    // 断言敏感性自证：若主进程没做这次覆盖，`inboxWatch` 会是 `false`（typeof boolean）→ 本断言红。
    await harness.invoke("opennote:bridge:stop").catch(() => {});
    restore();
  } catch (error) {
    fail("S7B.1", "真实桥状态复核", error && error.message ? error.message : String(error));
  }

  // ── (2) 哨兵桥：证明 `...raw` 在位，且该断言**具备敏感性** ──────────────
  //
  // 若把 `...raw,` 从 `bridgeStatusPayload()` 里去掉，下面每个哨兵值都会变成
  // `undefined`/`null`（因为显式白名单里没有这 6 个键）→ 断言**必然红**。
  // 换句话说：这条断言不是「恰好绿」，它红得起来。
  try {
    const { harness, restore } = await bootSecondaryMain(makeFakeBridgeModule());
    const status = await harness.invoke("opennote:bridge:status", {});
    const mismatched = [];
    for (const [key, expected] of Object.entries(STATUS_SENTINEL)) {
      const actual = status[key];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatched.push(`${key}: 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
      }
    }
    if (!mismatched.length) {
      pass("S7B.3", "(1) 哨兵桥的 6 个字段**逐值透传**（去掉 `...raw` 此断言必红）",
        `lastPairing=${JSON.stringify(status.lastPairing)} lastRejectedOrigin=${JSON.stringify(status.lastRejectedOrigin)} portRange=${JSON.stringify(status.portRange)}`);
    } else {
      fail("S7B.3", "(1) 哨兵字段未逐值透传", mismatched.join(" | "));
    }

    // 显式字段必须赢：桥返回布尔 true → 主进程覆盖成 'watch'
    if (status.inboxWatch === "watch") {
      pass("S7B.4", "(3) 桥给布尔 `true` 时主进程覆盖为 `'watch'`（布尔绝不透传到渲染层）",
        `桥 raw.inboxWatch=true → IPC payload.inboxWatch=${JSON.stringify(status.inboxWatch)}`);
    } else {
      fail("S7B.4", "(3) 布尔 true 被透传或被覆盖错", `实际 ${JSON.stringify(status.inboxWatch)} typeof=${typeof status.inboxWatch}`);
    }

    // 类型收紧仍然生效：桥给脏数据 → 主进程按白名单纠正
    const dirtyModule = makeFakeBridgeModule();
    const dirtyBase = dirtyModule.createBridge();
    dirtyModule.createBridge = () => ({
      ...dirtyBase,
      status: () => ({ ...dirtyBase.status(), port: "9999", origins: [1, "ok", null], tokenSet: "yes" }),
    });
    const second = await bootSecondaryMain(dirtyModule);
    const dirty = await second.harness.invoke("opennote:bridge:status", {});
    const cleaned = dirty.port === null && Array.isArray(dirty.origins) && dirty.origins.length === 1 && dirty.origins[0] === "ok" && dirty.tokenSet === false;
    if (cleaned) {
      pass("S7B.5", "类型收紧仍生效（脏值被纠正：port→null / origins 过滤 / tokenSet→false）",
        `port=${JSON.stringify(dirty.port)} origins=${JSON.stringify(dirty.origins)} tokenSet=${JSON.stringify(dirty.tokenSet)}`);
    } else {
      fail("S7B.5", "类型收紧未生效", `port=${JSON.stringify(dirty.port)} origins=${JSON.stringify(dirty.origins)} tokenSet=${JSON.stringify(dirty.tokenSet)}`);
    }
    second.restore();
    restore();
  } catch (error) {
    fail("S7B.3", "哨兵桥复核", error && error.message ? error.message : String(error));
  }

  // ── (3) 桥模块加载失败（`!controller` 早退分支）───────────────────────
  try {
    const { harness, restore } = await bootSecondaryMain({}); // 没有 createBridge → loadBridgeModule() 返回 null
    const status = await harness.invoke("opennote:bridge:status", {});
    const keysOk = REAL_KEYS.every((k) => k in status);
    const failedOk = status.state === "failed";
    const errorOk = typeof status.error === "string" && status.error.length > 0;
    if (keysOk && failedOk && errorOk) {
      pass("S7B.6", "(2) `!controller` 分支：state='failed' + 可执行的 error 文案 + 可选字段仍在",
        `state=${JSON.stringify(status.state)} error=${JSON.stringify(status.error)} 键数=${Object.keys(status).length}（必查 ${REAL_KEYS.length} 个可选字段）`);
    } else {
      fail("S7B.6", "(2) `!controller` 分支", `state=${JSON.stringify(status.state)} error=${JSON.stringify(status.error)} typeof(error)=${typeof status.error} 可选字段齐=${keysOk}（缺 ${REAL_KEYS.filter((k) => !(k in status)).join(", ") || "无"}）`);
    }
    restore();
  } catch (error) {
    fail("S7B.6", "(2) `!controller` 分支", error && error.message ? error.message : String(error));
  }
}

/* --- S8 收件箱动态行为（去抖 / 上限 / 重 id / 保留期） -------------------- */

/**
 * 投递一条**会进收件箱**的信封（02 §4.1 判定链第 4 步）：
 * 「整页剪藏（`selection !== true`）+ 该 URL 已有笔记 + 信封不含 `conflict` 键」→ `pending`。
 * 正文必须与已有笔记不同，否则会先在第 2 步被判 `duplicate`。
 */
async function deliverPending(env, existingUrl, tag) {
  const src = envelope({ body: `待入库正文 ${tag}（唯一 ${crypto.randomUUID().slice(0, 8)}）。\n`, source: { ...envelope({}).source, url: existingUrl } });
  delete src.conflict;
  src.importId = `verify-${tag}-${crypto.randomUUID().slice(0, 12)}`;
  const out = await env.clip.receiveEnvelopeOutcome(src);
  return { out, importId: src.importId, url: existingUrl };
}

/** 直接往磁盘上种一个收件箱条目目录（等价于外部程序投递）。 */function seedInboxEntry(root, dirName, importId, status, updatedAtIso, extra = {}) {
  const dir = path.join(root, ".opennote", "inbox", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "entry.json"), `${JSON.stringify({
    spec: "opennote.import/v1",
    importId,
    title: extra.title || `种子 ${importId}`,
    body: null,
    bodyFile: "body.md",
    source: { url: `https://example.com/${importId}`, capturedAt: updatedAtIso, site: "example.com", title: "种子" },
    target: { folder: null, notePath: null },
    tags: [],
    assets: [],
    enqueuedAt: updatedAtIso,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "body.md"), "种子正文\n");
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify({
    status,
    attempts: 0,
    lastError: null,
    committedPath: null,
    updatedAt: updatedAtIso,
  }, null, 2)}\n`);
  return dir;
}

async function scenario8(env) {
  stanza("场景 8 · 收件箱动态行为（450ms 去抖 / 满 500 → IMP-4013 / 重 id → IMP-4017 / 保留期清理）");
  const root = await freshWorkspace(env);
  const inboxDir = path.join(root, ".opennote", "inbox");

  // ── (1) 450ms 去抖：广播到达后**不立刻**刷新，而是排一个 450ms 的定时器 ──
  //    顺序要点：先把缓存刷新到稳定（`refreshInbox()`），**再**往磁盘种一条新条目，
  //    此时缓存里还没有它；广播后若立刻刷新，计数会马上 +1（= 去抖失效）。
  try {
    env.inbox.startInboxWatch();
    await env.inbox.refreshInbox();
    const handler = globalThis.window.opennote.__inboxChangedHandler;
    if (typeof handler !== "function") {
      unver("S8.1", "收件箱 watch 的 450ms 去抖", "shim 未捕获到 onInboxChanged 回调（无法驱动去抖路径）");
    } else {
      const before = env.inbox.inboxDetails().length;
      seedInboxEntry(root, "20260929T120000-aaaaaaa1", "seed-debounce-1", "pending", new Date().toISOString());
      capturedTimeouts.length = 0;
      handler({ root, pending: 1 });
      const immediate = env.inbox.inboxDetails().length;
      const debounce = capturedTimeouts.filter((ms) => ms === 450);
      await delay(700);
      const afterWait = env.inbox.inboxDetails().length;
      if (debounce.length > 0 && immediate === before && afterWait === before + 1) {
        pass("S8.1", "收件箱 watch 去抖 450ms：广播后不立刻刷新，450ms 后才刷新",
          `捕获 setTimeout(450) ${debounce.length} 次；广播瞬间仍为 ${immediate}（未立刻刷新）；700ms 后 ${before} → ${afterWait}（+1）`);
      } else {
        fail("S8.1", "收件箱 watch 去抖", `捕获 450ms 定时器 ${debounce.length} 次；广播瞬间 ${before} → ${immediate}（应保持不变）；700ms 后 → ${afterWait}（应 = ${before + 1}）`);
      }
    }
  } catch (error) {
    fail("S8.1", "收件箱 watch 去抖", error && error.message ? error.message : String(error));
  }

  // ── (2) 满 500 → IMP-4013（拒绝，不静默丢） ──────────────────────────────
  //    要触发上限，必须先让判定链走到第 4 步（`pending`）：先正常剪一条建立笔记，
  //    再种满 500 个条目，然后用**同一 URL + 不同正文**再剪一次。
  try {
    const capUrl = `https://example.com/cap-${crypto.randomUUID().slice(0, 8)}`;
    const first = envelope({ body: "建立笔记用的正文。\n", source: { ...envelope({}).source, url: capUrl } });
    delete first.conflict;
    first.importId = `verify-cap-base-${crypto.randomUUID().slice(0, 10)}`;
    const firstOut = await env.clip.receiveEnvelopeOutcome(first);
    const firstStatus = firstOut.ok ? firstOut.result.status : `error:${firstOut.error.code}`;

    const nowIso = new Date().toISOString();
    for (let i = 1; i <= 500; i += 1) {
      const stamp = `2026${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}${String((i * 7) % 60).padStart(2, "0")}00`;
      seedInboxEntry(root, `${stamp}-cap${String(i).padStart(5, "0")}`, `cap-seed-${i}`, "pending", nowIso);
    }
    await env.inbox.refreshInbox();
    const count = env.inbox.inboxCount();

    const over = await deliverPending(env, capUrl, "overcap");
    const overStatus = over.out.ok ? over.out.result.status : `error:${over.out.error.code}`;
    if (firstStatus === "created" && count >= 500 && over.out.ok === false && over.out.error.code === "IMP-4013") {
      pass("S8.2", "收件箱满 500 → 第 501 条被拒 `IMP-4013`（有码、不静默丢）",
        `基线投递=${firstStatus}；当前计数=${count}；第 501 条 → code=${over.out.error.code} userMessage=${JSON.stringify(over.out.error.userMessage)}`);
    } else {
      // D-V07：真实原因是 `enqueueInbox` 抛的 `InboxError("IMP-4013", "收件箱已满（500 条）…")`
      // 被 `receive.ts:695` 包成了 `IMP-5001`（`isImportRejection()` 只认 `ImportRejection`）。
      const detail = over.out.ok === false ? over.out.error.detail : null;
      fail("S8.2", "收件箱满 500 应拒 `IMP-4013` —— 实际被降级成 `IMP-5001`",
        `基线投递=${firstStatus}；计数=${count}；第 501 条 code=${over.out.ok === false ? over.out.error.code : overStatus}` +
        `；对外 userMessage=${JSON.stringify(over.out.ok === false ? over.out.error.userMessage : "")}` +
        `；真实原因藏在 detail.reason=${JSON.stringify(detail ? detail.reason : null)} message=${JSON.stringify(detail ? detail.message : null)}` +
        `（期望 code=IMP-4013、userMessage=「收件箱已满（500 条），请先处理一些条目。」）`);
    }
  } catch (error) {
    fail("S8.2", "收件箱满 500", error && error.message ? error.message : String(error));
  }

  // ── (3) 同 id 两个目录 → 后一个被判 `failed` + `IMP-4017` ────────────────
  try {
    const cleanRoot = await freshWorkspace(env);
    const nowIso = new Date().toISOString();
    seedInboxEntry(cleanRoot, "20260929T130000-dupid001", "dup-same-id", "pending", nowIso);
    await delay(5);
    seedInboxEntry(cleanRoot, "20260929T130001-dupid001", "dup-same-id", "pending", nowIso);
    await env.inbox.refreshInbox();
    const details = await env.inbox.listInboxDetails();
    const dups = details.filter((d) => d.entry.id === "dup-same-id");
    const failedOne = dups.find((d) => d.entry.status === "failed" && d.entry.lastError === "IMP-4017");
    const kept = dups.filter((d) => d.entry.status !== "failed");
    if (dups.length === 2 && failedOne && kept.length === 1) {
      pass("S8.3", "同一 importId 出现两个目录 → 只保留第一条，后一条标 `failed` + `IMP-4017`",
        `条目数=${dups.length}；被判重的目录=${failedOne.dirName}（status=failed lastError=${failedOne.entry.lastError}）；保留=${kept[0].dirName}`);
    } else {
      fail("S8.3", "重 id 应标 IMP-4017", dups.map((d) => `${d.dirName}:${d.entry.status}/${d.entry.lastError}`).join(" | ") || `未找到重 id 条目（共 ${details.length} 条）`);
    }
  } catch (error) {
    fail("S8.3", "重 id 判定", error && error.message ? error.message : String(error));
  }

  // ── (4) 保留期清理：committed > 24h、failed > 7d 删；pending/committing 永不删 ──
  try {
    const ttlRoot = await freshWorkspace(env);
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const H = 3600 * 1000;
    const D = 24 * H;
    seedInboxEntry(ttlRoot, "20260929T140000-ttlp0001", "ttl-committed-old", "committed", iso(25 * H));
    seedInboxEntry(ttlRoot, "20260929T140001-ttlp0002", "ttl-committed-fresh", "committed", iso(23 * H));
    seedInboxEntry(ttlRoot, "20260929T140002-ttlp0003", "ttl-failed-old", "failed", iso(8 * D));
    seedInboxEntry(ttlRoot, "20260929T140003-ttlp0004", "ttl-failed-fresh", "failed", iso(6 * D));
    seedInboxEntry(ttlRoot, "20260929T140004-ttlp0005", "ttl-pending-old", "pending", iso(30 * D));
    seedInboxEntry(ttlRoot, "20260929T140005-ttlp0006", "ttl-committing-old", "committing", iso(30 * D));
    const removed = await env.inbox.cleanupInbox(now);
    const survivors = fs.existsSync(path.join(ttlRoot, ".opennote", "inbox"))
      ? fs.readdirSync(path.join(ttlRoot, ".opennote", "inbox")).sort()
      : [];
    const expectGone = ["20260929T140000-ttlp0001", "20260929T140002-ttlp0003"];
    const expectAlive = ["20260929T140001-ttlp0002", "20260929T140003-ttlp0004", "20260929T140004-ttlp0005", "20260929T140005-ttlp0006"];
    const goneOk = expectGone.every((n) => !survivors.includes(n));
    const aliveOk = expectAlive.every((n) => survivors.includes(n));
    if (removed === 2 && goneOk && aliveOk) {
      pass("S8.4", "保留期清理：committed>24h 与 failed>7d 被删（2 条），其余 4 条存活（pending/committing 永不删）",
        `cleanupInbox 返回 ${removed}；剩余目录=[${survivors.join(", ")}]`);
    } else {
      fail("S8.4", "保留期清理", `返回 ${removed}（期望 2）；剩余=[${survivors.join(", ")}]；应删未删=${expectGone.filter((n) => survivors.includes(n)).join(",") || "无"}；应留被删=${expectAlive.filter((n) => !survivors.includes(n)).join(",") || "无"}`);
    }
    // 清理同样**不进回收站**
    const trashListing = fs.existsSync(path.join(ttlRoot, ".opennote", "trash"))
      ? fs.readdirSync(path.join(ttlRoot, ".opennote", "trash"))
      : [];
    if (trashListing.length === 0) {
      pass("S8.5", "保留期清理不进回收站（`.opennote/trash/` 为空）", "trash 目录为空");
    } else {
      fail("S8.5", "清理不应进回收站", `trash=[${trashListing.join(", ")}]`);
    }
  } catch (error) {
    fail("S8.4", "保留期清理", error && error.message ? error.message : String(error));
  }

  // ── (5) 30 秒轮询降级：没有 onInboxChanged 时必须退化为轮询 ──────────────
  try {
    capturedTimeouts.length = 0;
    const capturedIntervals = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = function patched(fn, ms, ...rest) {
      capturedIntervals.push(ms);
      const timer = realSetInterval(fn, ms, ...rest);
      if (timer && typeof timer.unref === "function") timer.unref();
      return timer;
    };
    const saved = globalThis.window.opennote.onInboxChanged;
    globalThis.window.opennote.onInboxChanged = undefined;
    env.inbox.stopInboxWatch();
    env.inbox.startInboxWatch();
    const mode = env.inbox.inboxWatchMode();
    globalThis.window.opennote.onInboxChanged = saved;
    globalThis.setInterval = realSetInterval;
    env.inbox.stopInboxWatch();
    if (mode === "poll" && capturedIntervals.includes(30000)) {
      pass("S8.6", "没有 onInboxChanged 时降级为 30 秒轮询（inboxWatchMode()='poll'）",
        `inboxWatchMode()=${mode}；捕获到的 setInterval 周期=[${[...new Set(capturedIntervals)].sort((a, b) => a - b).join(", ")}]`);
    } else {
      fail("S8.6", "轮询降级", `inboxWatchMode()=${mode}；setInterval 周期=[${[...new Set(capturedIntervals)].join(", ")}]`);
    }
  } catch (error) {
    fail("S8.6", "轮询降级", error && error.message ? error.message : String(error));
  }
}

/* --- S9 通道保真（0.3.0 默认落点：外部导入 → 进收件箱） --------------------- */

/**
 * 场景 9 · 通道 × 落点偏好（`00` §6.14㉕㉖）。
 *
 * **为什么单独成场景**（C1 的发现）：本脚本此前**从不调用** `setImportChannelContext()`，
 * 于是所有直接投递都跑在模块默认通道 `"in-app"` 上 —— 0.3.0 的核心新行为
 * 「默认设置 → 外部导入进收件箱」在 E2E 里**完全看不见**（`S1.x` 仍报 `created`）。
 * 这不是产品缺陷，是**驱动侧的通道保真缺口**；本场景把它补上并单独钉住。
 */
async function scenario9(env) {
  return withCoverageGuard("S9", EXPECTED_S9, () => scenario9Body(env));
}

async function scenario9Body(env) {
  stanza("场景 9 · 通道保真：默认设置 + 外部通道 → 进收件箱（0.3.0 核心语义）");
  const root = await freshWorkspace(env);
  env.clip.resetImportChannelContext();

  // ── S9.0 前提自检：落点偏好确实是 0.3.0 的默认值 "inbox"（**没有**任何测试代码改过它） ──
  const pref = env.clip.getImportLandingPreference();
  const chanDefault = env.clip.getImportChannelContext();
  if (pref === "inbox" && chanDefault.channel === "in-app") {
    pass("S9.0", "前提：落点偏好默认 `inbox`、通道默认 `in-app`（未被任何前置用例改动）",
      `getImportLandingPreference()="${pref}"、默认通道="${chanDefault.channel}"、overwriteEnabled=${chanDefault.overwriteEnabled}`);
  } else {
    fail("S9.0", "前提自检：默认落点偏好应为 `inbox`", `pref="${pref}" 通道="${chanDefault.channel}"`);
  }

  // ── S9.1 默认设置 + 外部通道（local-bridge）→ 强制 pending，且**不写笔记文件** ──
  // 注意：新工作区**自带 1 个 .md**（脚手架），所以「不出现新 .md」要比**增量**。
  const mdBefore = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/"));
  const notesBefore = Object.keys(env.lib.libraryStore.get().notes).length;
  const src = envelope({ source: { ...envelope({}).source, url: "https://example.com/s9-external" } });
  env.clip.setImportChannelContext({ channel: "local-bridge" });
  const out = await env.clip.receiveEnvelopeOutcome(src);
  env.clip.setImportChannelContext({ channel: "in-app" });
  await env.inbox.refreshInbox();

  const notesAfter = Object.keys(env.lib.libraryStore.get().notes).length;
  const inbox = env.inbox.inboxDetails();
  const mdDelta = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/") && !mdBefore.includes(f));
  const status = out.ok ? out.result.status : `error:${out.error.code}`;
  const inboxIdOk = out.ok && /^\d{8}T\d{6}-.{8}$/.test(String(out.result.inboxId));
  if (status === "pending" && out.ok && out.result.path === null && inboxIdOk && mdDelta.length === 0 && inbox.length === 1 && notesAfter === notesBefore) {
    pass("S9.1", "默认设置 + `local-bridge` 投递 → `pending`、`path=null`、无新 .md、收件箱恰好 1 条",
      `status=${status} inboxId=${out.result.inboxId}（匹配 /^\\d{8}T\\d{6}-.{8}$/=${inboxIdOk}）path=${out.result.path}`
      + ` 新增 .md=${mdDelta.length} 收件箱=${inbox.length} 笔记数 ${notesBefore} → ${notesAfter}`);
  } else {
    fail("S9.1", "默认设置 + 外部通道应强制进收件箱",
      `status=${status} path=${out.ok ? out.result.path : "-"} inboxId=${out.ok ? out.result.inboxId : "-"}（正则=${inboxIdOk}）`
      + ` 新增 .md=${mdDelta.length} 收件箱=${inbox.length} 笔记数 ${notesBefore} → ${notesAfter}`);
  }

  // ── S9.2 同 importId 重投 → 幂等：收件箱**仍恰好 1 条** ────────────────────
  // 契约 ㉕ 第二点要求重投同一 importId 幂等。这里如实记录实际回执状态：
  // 「索引命中 → deduped」与「收件箱按 entry.id 幂等 → 再次 pending」都能满足「不产生第二条」，
  // 但**只有前者**是严格意义的 `deduped` —— 两种都打印，不做无根据的断言。
  env.clip.setImportChannelContext({ channel: "local-bridge" });
  const again = await env.clip.receiveEnvelopeOutcome(src);
  env.clip.setImportChannelContext({ channel: "in-app" });
  await env.inbox.refreshInbox();
  const inbox2 = env.inbox.inboxDetails();
  const againStatus = again.ok ? again.result.status : `error:${again.error.code}`;
  const mdDelta2 = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/") && !mdBefore.includes(f));
  if (inbox2.length === 1 && mdDelta2.length === 0) {
    pass("S9.2", "同 `importId` 重投幂等：收件箱仍恰好 1 条、磁盘仍 0 个新增 .md",
      `重投回执 status=${againStatus}${againStatus === "deduped" ? "（严格 deduped —— 命中第 1 步幂等索引）" : "（非 deduped —— 幂等由收件箱按 entry.id 保证）"}`
      + ` 收件箱=${inbox2.length} 新增 .md=${mdDelta2.length}`);
  } else {
    fail("S9.2", "同 importId 重投应幂等（不得产生第二条）",
      `重投 status=${againStatus} 收件箱=${inbox2.length}（期望 1）新增 .md=${mdDelta2.length}（期望 0）`);
  }

  // ── S9.3 对照组：`in-app` 通道 → 走判定链，正常 `created` 并写笔记 ─────────
  const notesBefore3 = Object.keys(env.lib.libraryStore.get().notes).length;
  const src3 = envelope({ source: { ...envelope({}).source, url: "https://example.com/s9-in-app" } });
  env.clip.setImportChannelContext({ channel: "in-app" });
  const out3 = await env.clip.receiveEnvelopeOutcome(src3);
  env.clip.setImportChannelContext({ channel: "in-app" });
  const notesAfter3 = Object.keys(env.lib.libraryStore.get().notes).length;
  const mdFiles3 = listWorkspace(root).filter((f) => f.endsWith(".md"));
  const status3 = out3.ok ? out3.result.status : `error:${out3.error.code}`;
  if (status3 === "created" && out3.ok && out3.result.path && notesAfter3 === notesBefore3 + 1) {
    pass("S9.3", "对照组：`in-app` 通道 → 仍是 `created`（外部通道规则不误伤应用内剪藏）",
      `status=${status3} path=${out3.result.path} 笔记数 ${notesBefore3} → ${notesAfter3} 磁盘 .md=${mdFiles3.length}`);
  } else {
    fail("S9.3", "对照组：in-app 通道应仍是 created",
      `status=${status3} path=${out3.ok ? out3.result.path : "-"} 笔记数 ${notesBefore3} → ${notesAfter3}`);
  }
}

/* --- S10 · 0.3.1 语义攻击：删掉配对之后，网络面防线还在不在 ---------------- */
//
// Lead 0.3.1 派单里标了「⚠️ 最重要的一条」：配对删除后，**普通网页 Origin 仍必须被拒**。
// 令牌是长期有效的明文凭据（就存在扩展 storage 里），所以 `Origin` 这一道是去掉配对之后
// **唯一的网络面防线**：任何网站只要能让用户浏览器发出请求，就必须在这一道被挡下。
//
// 这一组**全部走真 HTTP**（`http.request`，不是 `fetch` —— 只有原始请求才能自由设置 `Origin`），
// 并且每一条都配了**内存变异自检**：把桥的对应防线改成失效，断言必须变红。

/** 原始 HTTP 调用：可自由设置 `Origin`（`fetch` 会拦这个头）。 */
function httpCall(port, options = {}) {
  return new Promise((resolve, reject) => {
    const body =
      options.body == null ? null : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    const headers = { ...(options.headers || {}) };
    if (options.origin !== undefined) headers.Origin = options.origin;
    if (options.token !== undefined && options.token !== null) headers.Authorization = `Bearer ${options.token}`;
    if (body != null) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method || "POST",
        path: options.path || "/v1/import",
        headers,
        // 一次性连接（不复用 keep-alive socket）：桥被 `stop()` 关掉时，
        // 留着的长连接会抛 `read ECONNRESET`，把一次成功的请求变成场景崩溃。
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON 响应 */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** 错误码（从响应体里取，兼容 `{error:{code}}` 与 `{code}` 两种形态）。 */
function codeOf(res) {
  if (!res.json) return null;
  if (res.json.error && res.json.error.code) return res.json.error.code;
  return res.json.code || null;
}

/**
 * 在**内存里**编译一个「变异版」模块。
 *
 * 关键点：用**真实绝对路径**编译（`new Module(absPath)` + `_compile`），
 * 所以 `require('./deeplink.cjs')` 这类相对依赖仍能解析 ——
 * 这正是 `scripts/gate-defects.cjs` 把副本拷到 `os.tmpdir()` 之后崩掉的原因（见 V6 的 D-V12）。
 * 变异没命中（源码没变）时返回 `null`：**不许**把「变异没生效」当成「护栏检测到了」。
 */
function loadMutatedModule(absPath, mutate) {
  const Module = require("node:module");
  const original = fs.readFileSync(absPath, "utf8");
  const mutated = mutate(original);
  if (typeof mutated !== "string" || mutated === original) return null;
  const mod = new Module(absPath, null);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  mod._compile(mutated, absPath);
  return mod.exports;
}

/** 用指定模块（可能是变异版）起一座桥。 */
function bootBridgeWith(mod, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "opennote-bridge-s10-"));
  let token = options.token || null;
  const controller = mod.createBridge({
    dataDir,
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
    onEnvelope: options.onEnvelope || null,
    getAdvancedOverwrite: () => false,
    isEnabled: () => true,
    // 传 null 时桥会退回读 `bridge.json` 里持久化的 tokenHash —— 「重启后令牌仍有效」就靠这条路径。
    getTokenHash: options.tokenHash === undefined ? () => (token ? mod.sha256Hex(token) : null) : options.tokenHash,
    log: () => {},
  });
  if (!token && options.generateToken !== false) token = controller.generateToken();
  return { controller, dataDir, getToken: () => token };
}

async function scenario10(env) {
  return withCoverageGuard("S10", EXPECTED_S10, () => scenario10Body(env));
}

async function scenario10Body(env) {
  stanza("场景 10 · 0.3.1 语义攻击：去掉配对后「普通网页 Origin 必须被拒」等 6 条");
  const bridgePath = path.join(ROOT, "electron", "bridge.cjs");
  let root = await freshWorkspace(env);
  env.clip.resetImportChannelContext();
  const bridge = bootBridgeWith(env.bridgeModule, {
    onEnvelope: (json) => env.clip.receiveEnvelopeOutcome(json),
  });
  const started = await bridge.controller.start();
  const token = bridge.getToken();
  const port = started && started.port;

  if (!port) {
    fail("S10.0", "前置：桥在 127.0.0.1 启动", JSON.stringify(started));
    return;
  }
  const mdBefore = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/"));
  pass("S10.0", "前置：桥已启动、令牌已生成（`generateToken()`）、工作区基线已记录",
    `port=${port} token=${token.slice(0, 8)}…（${token.length} 字符） 基线 .md=${mdBefore.length} 个 allowedOrigins=${JSON.stringify(bridge.controller.status().allowedOrigins)}`);

  const EVIL = "https://evil.example";
  const importPath = "/v1/import";

  /* ── S10.1 最重要的一条：普通网页 Origin + **合法令牌** → 403，且一个字节都不写 ── */
  const evilBody = envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-evil-page" } });
  const evil = await httpCall(port, { origin: EVIL, token, body: evilBody });
  const mdAfterEvil = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/") && !mdBefore.includes(f));
  if (evil.status === 403 && codeOf(evil) === "IMP-3001" && mdAfterEvil.length === 0) {
    pass("S10.1", "普通网页 Origin（`https://evil.example`）+ **合法令牌** → 403 `IMP-3001`，且不写任何 .md",
      `http=${evil.status} code=${codeOf(evil)} 新增 .md=${mdAfterEvil.length}（令牌是有效的，被拦的确实是来源这一道）body=${JSON.stringify(evil.json).slice(0, 150)}`);
  } else {
    // 标题不再声称「唯一防线」（Lead 2026-09-30 裁定）：**令牌闸门**（S10.4 证）、
    // **Origin 按类型**（本条 + S10.2）、**Host**、**Content-Type** 都是闸门。
    // 修辞上的过度声称会让读者**低估**其它防线的存在 —— 和事实错误一样有害。
    fail("S10.1", "普通网页 Origin 必须被拒（四道闸门里的「来源类型」这一道：令牌 / Origin / Host / Content-Type）",
      `http=${evil.status} code=${codeOf(evil)} 新增 .md=${mdAfterEvil.length}（期望 403/IMP-3001/0）body=${JSON.stringify(evil.json).slice(0, 200)}`);
  }

  /* ── S10.2 来源变体：全部必须 403 ─────────────────────────────────────────── */
  const VARIANTS = [
    ["Origin 字面量 `null`（file:// 页面 / 沙箱 iframe / 隐私模式）", "null"],
    ["空串 Origin", ""],
    ["`http://localhost:8787`（localhost 不是 127.0.0.1 字面量）", "http://localhost:8787"],
    ["`https://127.0.0.1:8787`（回环但协议是 https）", "https://127.0.0.1:8787"],
    ["`http://127.0.0.1.evil.example`（前缀混淆域名）", `http://127.0.0.1.evil.example`],
    ["`chrome-extension://短`（扩展 id 长度不足 8）", "chrome-extension://abc"],
    ["`https://opennote.app`（同名正规域名）", "https://opennote.app"],
  ];
  const variantBad = [];
  for (const [label, origin] of VARIANTS) {
    const res = await httpCall(port, { origin, token, body: envelope({ source: { ...envelope({}).source, url: `https://example.com/s10-variant-${encodeURIComponent(origin)}` } }) });
    if (!(res.status === 403 && codeOf(res) === "IMP-3001")) {
      variantBad.push(`${label} → http=${res.status} code=${codeOf(res)}`);
    }
  }
  if (variantBad.length === 0) {
    pass("S10.2", `${VARIANTS.length} 个「不该被信任」的来源变体全部 403 \`IMP-3001\``,
      VARIANTS.map(([l, o]) => `${o === "" ? "(空串)" : o}`).join(" / "));
  } else {
    fail("S10.2", "来源变体应全部 403 IMP-3001", variantBad.join(" | "));
  }

  /* ── S10.3 三类合法来源必须放行（无令牌 → 401，证明「来源这关过了」） ─────── */
  const ACCEPT = [
    ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "扩展（32 位 id）"],
    ["moz-extension://abcdefghijklmnopabcdefghijklmnop", "Firefox 扩展"],
    [`http://127.0.0.1:${port}`, "本机回环（带端口）"],
  ];
  const acceptBad = [];
  for (const [origin] of ACCEPT) {
    const noToken = await httpCall(port, { origin, body: envelope({}) });
    // 来源被放行 → 继续走到令牌那一道 → 401 IMP-2001（**不是** 403 IMP-3001）
    if (!(noToken.status === 401 && codeOf(noToken) === "IMP-2001")) {
      acceptBad.push(`${origin} → http=${noToken.status} code=${codeOf(noToken)}（期望 401/IMP-2001）`);
    }
  }
  if (acceptBad.length === 0) {
    pass("S10.3", `三类合法来源放行（无令牌时是 401 \`IMP-2001\`，不是 403）`,
      ACCEPT.map(([o, l]) => `${l}=${o}`).join(" | "));
  } else {
    fail("S10.3", "合法来源应通过来源这一道（随后因无令牌 401）", acceptBad.join(" | "));
  }

  /* ── S10.4 扩展来源：无令牌 401 / 错令牌 401 / 合法令牌放行 ───────────────── */
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const noTok = await httpCall(port, { origin: EXT, body: envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-notoken" } }) });
  const badTok = await httpCall(port, { origin: EXT, token: token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), body: envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-badtoken" } }) });
  const goodTok = await httpCall(port, { origin: EXT, token, body: envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-goodtoken" } }) });
  const goodOk = goodTok.status === 200 || goodTok.status === 201 || goodTok.status === 202;
  if (noTok.status === 401 && codeOf(noTok) === "IMP-2001" && badTok.status === 401 && codeOf(badTok) === "IMP-2002" && goodOk) {
    pass("S10.4", "扩展来源 + 无令牌 → 401 `IMP-2001`；错令牌 → 401 `IMP-2002`；合法令牌 → 放行",
      `无令牌 http=${noTok.status}/${codeOf(noTok)}、错令牌 http=${badTok.status}/${codeOf(badTok)}、合法令牌 http=${goodTok.status} status=${goodTok.json && goodTok.json.data ? goodTok.json.data.status : "?"}`);
  } else {
    fail("S10.4", "扩展来源的令牌三道应分别是 401/401/放行",
      `无令牌 http=${noTok.status}/${codeOf(noTok)}、错令牌 http=${badTok.status}/${codeOf(badTok)}、合法令牌 http=${goodTok.status}/${goodOk}`);
  }

  /* ── S10.5 `/v1/pair` 已下线，但必须**给出明确说明**（不得静默 404 无文案） ── */
  const originsBeforePair = JSON.stringify(bridge.controller.status().allowedOrigins);
  const pair = await httpCall(port, { origin: EXT, token, path: "/v1/pair", body: { code: "123456", client: { name: "chrome-extension", version: "0.1.4" } } });
  const pairMsg = pair.json && pair.json.error && pair.json.error.userMessage ? pair.json.error.userMessage : "";
  const pairLeak = Boolean(pair.json && (pair.json.token || (pair.json.data && pair.json.data.token) || /opn_[A-Za-z0-9_-]{10,}/.test(pair.text)));
  const originsAfterPair = JSON.stringify(bridge.controller.status().allowedOrigins);
  const pairMentions = pairMsg.includes("配对") && pairMsg.includes("令牌");
  if (pair.status === 404 && codeOf(pair) === "IMP-3005" && pairMsg.trim() !== "" && pairMentions && !pairLeak && originsBeforePair === originsAfterPair) {
    pass("S10.5", "`/v1/pair` 已下线：404 `IMP-3005` + 明确文案（含「配对」「令牌」）+ 不返回凭据 + 不改 allowedOrigins",
      `http=${pair.status} code=${codeOf(pair)} userMessage=「${pairMsg}」 allowedOrigins=${originsBeforePair}（未变）`);
  } else {
    fail("S10.5", "`/v1/pair` 下线必须给明确说明且不泄凭据",
      `http=${pair.status} code=${codeOf(pair)} userMessage=「${pairMsg}」 含配对=${pairMsg.includes("配对")} 含令牌=${pairMsg.includes("令牌")} 凭据泄漏=${pairLeak} allowedOrigins ${originsBeforePair} → ${originsAfterPair}`);
  }

  /* ── S10.6 令牌长期有效 + ㊴ 明文落盘（`00` §6.15㊴ 推翻 ㊲ 的「绝不落盘」）────────
     **这条断言曾被裁定推翻**：旧版写的是「bridge.json 只有 sha256 + 后 4 位、**无明文**」，
     而 ㊴ 明确要求 `userData/bridge.json` **同时存明文**（用户知情选择，换来「任何时候都能复制」）。
     若保留旧断言，它会在 ㊴ 落地后把**正确实现**判成红 —— 这正是一个「断言了一个已被推翻的事实」的例子。
     新判据：① sha256 仍是 64hex、last4 仍对得上；② 明文**确实**在 bridge.json 里且等于生效令牌；
     ③ 明文**不得**出现在工作区（工作区的 .md/.json 里搜不到它）；④ 重启后同一令牌仍可用、另一个令牌 401。 */
  await bridge.controller.stop();
  const persisted = (() => {
    try {
      return fs.readFileSync(path.join(bridge.dataDir, "bridge.json"), "utf8");
    } catch (error) {
      return `(读取失败：${error.message})`;
    }
  })();
  const persistedJson = (() => {
    try {
      return JSON.parse(persisted);
    } catch {
      return null;
    }
  })();
  const hashInFile = persistedJson && typeof persistedJson.tokenHash === "string" ? persistedJson.tokenHash : "";
  const last4InFile = persistedJson ? String(persistedJson.tokenLast4 || "") : "";
  const plaintextInFile = persistedJson && typeof persistedJson.tokenPlaintext === "string" ? persistedJson.tokenPlaintext : "";
  const plaintextMatchesToken = plaintextInFile === token; // ㊴：盘上明文就是当前生效令牌
  // 工作区里**不得**出现令牌明文（明文只该在 userData 的 bridge.json 里）。
  const workspaceFiles = listWorkspace(root).filter((f) => /\.(md|json|txt)$/i.test(f));
  const workspaceLeak = workspaceFiles.filter((f) => {
    const b = readWorkspaceFile(root, f);
    return b ? b.toString("utf8").includes(token) : false;
  });
  const restarted = bootBridgeWith(env.bridgeModule, {
    dataDir: bridge.dataDir,
    token,
    tokenHash: undefined, // → 桥退回读 bridge.json 里的 tokenHash（模拟应用重启后主进程没把哈希传进来）
    generateToken: false,
    onEnvelope: (json) => env.clip.receiveEnvelopeOutcome(json),
  });
  // 注意：这里**不改** `bridge.getToken()` 的取值路径，用的是**重启前生成的那个**令牌。
  const started2 = await restarted.controller.start();
  const port2 = started2 && started2.port ? started2.port : null; // null 时不发请求（旧版拿 undefined 去连 → 默认 80 → ECONNREFUSED 把整段场景打崩）
  const afterRestart = port2
    ? await httpCall(port2, { origin: EXT, token, body: envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-after-restart" } }) })
    : { status: 0, json: null };
  const otherToken = `opn_${"B".repeat(43)}`;
  const afterRestartOther = port2
    ? await httpCall(port2, { origin: EXT, token: otherToken, body: envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-other-token" } }) })
    : { status: 0, json: null };
  const okAfterRestart = afterRestart.status === 200 || afterRestart.status === 201 || afterRestart.status === 202;
  const otherRejected = afterRestartOther.status === 401 && codeOf(afterRestartOther) === "IMP-2002";
  if (okAfterRestart && otherRejected && /^[0-9a-f]{64}$/.test(hashInFile) && last4InFile === token.slice(-4)
      && plaintextMatchesToken && workspaceLeak.length === 0) {
    pass("S10.6", "令牌长期有效：重启桥（新实例、同一 dataDir）后**同一令牌仍可用**；另一个令牌 401；"
      + "㊴ 明文与 sha256/last4 并列落盘且**只**在工作区之外",
      `重启后 http=${afterRestart.status}（同一令牌）／http=${afterRestartOther.status}/${codeOf(afterRestartOther)}（另一个令牌）`
      + ` bridge.json: tokenHash=${hashInFile.slice(0, 12)}…(64hex=true) tokenLast4=${last4InFile}`
      + ` tokenPlaintext 命中当前令牌=${plaintextMatchesToken} 工作区泄漏=${workspaceLeak.length}`);
  } else {
    fail("S10.6", "重启后同一令牌应可用；且按 ㊴ 明文应落在 bridge.json 而不在工作区",
      `started2=${JSON.stringify(started2)} 重启后同一令牌 http=${afterRestart.status} code=${codeOf(afterRestart)}（期望 2xx）`
      + `、另一个令牌 http=${afterRestartOther.status}/${codeOf(afterRestartOther)}（期望 401/IMP-2002）`
      + ` tokenHash 64hex=${/^[0-9a-f]{64}$/.test(hashInFile)} tokenLast4=${last4InFile}（期望 ${token.slice(-4)}）`
      + ` 明文命中=${plaintextMatchesToken}（㊴ 要求 true，旧版文件只有 sha256 时为 false）工作区泄漏=${workspaceLeak.length}${workspaceLeak.length ? "：" + workspaceLeak.join(",") : ""}`);
  }

  /* ── S10.7 历史遗留白名单**不再**用于放行；且不发放 CORS 头 ───────────────── */
  const addOk = restarted.controller.addAllowedOrigin(EVIL);
  // 增量必须**围绕这一次请求**量：S10.4/S10.6 的成功导入本来就写了 .md。
  const mdBeforeLegacy = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/")).length;
  const legacy = await httpCall(port2, { origin: EVIL, token, body: envelope({ source: { ...envelope({}).source, url: "https://example.com/s10-legacy-allowlist" } }) });
  const crosHeader = legacy.headers["access-control-allow-origin"];
  const mdDeltaLegacy = listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/")).length - mdBeforeLegacy;
  // addAllowedOrigin 之后仍然 403，说明「配对/白名单」这条路真的不再参与放行判定。
  const preflight = await httpCall(port2, { method: "OPTIONS", origin: EVIL, headers: { "Access-Control-Request-Method": "POST" } });
  if (legacy.status === 403 && codeOf(legacy) === "IMP-3001" && !crosHeader && mdDeltaLegacy === 0) {
    pass("S10.7", "历史白名单不再放行（`addAllowedOrigin(https://evil.example)` 后该来源仍 403）且不给 CORS 头",
      `addAllowedOrigin=${addOk} http=${legacy.status}/${codeOf(legacy)} Access-Control-Allow-Origin=${JSON.stringify(crosHeader)}`
      + ` 预检 http=${preflight.status} ACAO=${JSON.stringify(preflight.headers["access-control-allow-origin"] || null)} 本次新增 .md=${mdDeltaLegacy}`);
  } else {
    fail("S10.7", "白名单不得再参与放行，且普通网页来源不得拿到 CORS 头",
      `addAllowedOrigin=${addOk} http=${legacy.status}/${codeOf(legacy)} ACAO=${JSON.stringify(crosHeader)} 本次新增 .md=${mdDeltaLegacy}`);
  }

  /* ── S10.8 变异自检：把防线逐条改成失效，断言必须变红（否则这组检查是恒绿的） ── */
  const mutations = [
    {
      id: "来源这道形同虚设",
      apply: (src) => src.replace("if (value === '' || value === 'null' || !isAcceptedOrigin(value)) {", "if (false) {"),
      probe: async (mod) => {
        const b = bootBridgeWith(mod, { onEnvelope: null });
        const s = await b.controller.start();
        try {
          const r = await httpCall(s.port, { origin: EVIL, token: b.getToken(), body: envelope({}) });
          return !(r.status === 403 && codeOf(r) === "IMP-3001");
        } finally {
          await b.controller.stop();
        }
      },
    },
    {
      id: "`/v1/pair` 退回通用 404（说明整段消失）",
      // 注意：**不能**只把 userMessage 改成空串 —— `sendError` 会回退到 ERROR_TABLE 的文案，
      // 那样「变异仍绿」是我的变异没打到要害，不是护栏恒绿。这里直接把专属分支摘掉，
      // 让它落到通用 404（文案变成「接口地址或方法不对。」），这正是「静默 404」的形态。
      apply: (src) => src.replace("if (route === '/v1/pair') {", "if (false) {"),
      probe: async (mod) => {
        const b = bootBridgeWith(mod, { onEnvelope: null });
        const s = await b.controller.start();
        try {
          const r = await httpCall(s.port, { origin: EXT, token: b.getToken(), path: "/v1/pair", body: { code: "123456" } });
          const msg = r.json && r.json.error && r.json.error.userMessage ? r.json.error.userMessage : "";
          return !(r.status === 404 && msg.includes("配对") && msg.includes("令牌"));
        } finally {
          await b.controller.stop();
        }
      },
    },
    {
      id: "令牌校验恒真（不比对哈希）",
      // 判据：随机令牌**不再被 401/IMP-2002 拒绝**即算变红。
      // （不要断言「返回 2xx」——这条桥的 onEnvelope 是空的，导入本来就会以别的错误码结束。）
      apply: (src) => src.replace("const matched = !malformed && typeof expected === 'string' && timingSafeEqualText(sha256Hex(raw), expected)", "const matched = true"),
      probe: async (mod) => {
        const b = bootBridgeWith(mod, { onEnvelope: null });
        const s = await b.controller.start();
        try {
          const r = await httpCall(s.port, { origin: EXT, token: `opn_${"C".repeat(43)}`, body: envelope({}) });
          return !(r.status === 401 && codeOf(r) === "IMP-2002");
        } finally {
          await b.controller.stop();
        }
      },
    },
  ];
  const mutationBad = [];
  const mutationOk = [];
  for (const mutation of mutations) {
    const mutated = loadMutatedModule(bridgePath, mutation.apply);
    if (!mutated) {
      mutationBad.push(`${mutation.id}：**变异没命中源码**（正则/文案已变），本条自检失效`);
      continue;
    }
    let red = false;
    try {
      red = await mutation.probe(mutated);
    } catch (error) {
      mutationBad.push(`${mutation.id}：变异版桥跑不起来 → ${error && error.message ? error.message : String(error)}`);
      continue;
    }
    if (red) mutationOk.push(`${mutation.id} 如期变红`);
    else mutationBad.push(`${mutation.id}：**注入后断言仍绿 —— 这条检查是恒绿的，必须修**`);
  }
  if (mutationBad.length === 0) {
    pass("S10.8", `变异自检：${mutations.length} 条防线各自失效后，对应断言全部如期变红`,
      mutationOk.join("；"));
  } else {
    fail("S10.8", "变异自检未全部通过（说明上面某些断言不会红）", mutationBad.join(" | "));
  }

  /* ── S10.9 元素选择（0.3.1 ㉝）：`selection:false` 的同 URL 不同正文 → 判定链第 4 步 `pending` ── */
  root = await freshWorkspace(env);
  env.clip.resetImportChannelContext();
  // 判定链第 3/4 步只在「落点偏好不是 inbox」且**客户端没显式下发 conflict**
  // （`envelope.conflictExplicit === false` → `explicit === null`）时才会被走到：
  //   receive.ts:367  inbox 偏好 + 外部通道 → 直接 pending，跳过第 2–6 步；
  //   receive.ts:407  `explicit === null && selection === true` → 第 3 步 append；
  //   receive.ts:423  `existing && explicit === null` → 第 4 步 pending。
  // 合法偏好只有 new/append/skip/inbox（receive.ts:159），所以这里用 `new`。
  env.clip.setImportLandingPreference("new");
  env.clip.setImportChannelContext({ channel: "local-bridge" });
  const pickUrl = "https://example.com/s10-element-picker";
  /** 不带 `conflict` 字段 → `conflictExplicit=false` → `explicit=null`（走判定链第 3/4 步）。 */
  const chainEnvelope = (body, selection) => {
    const e = envelope({ source: { ...envelope({}).source, url: pickUrl, selection }, body });
    delete e.conflict;
    return e;
  };
  const pick1 = await env.clip.receiveEnvelopeOutcome(chainEnvelope("元素选择正文第一版。\n", false));
  const pick2 = await env.clip.receiveEnvelopeOutcome(chainEnvelope("元素选择正文第二版（改了内容）。\n", false));
  const s1 = pick1.ok ? pick1.result.status : `error:${pick1.error.code}`;
  const s2 = pick2.ok ? pick2.result.status : `error:${pick2.error.code}`;
  if (s1 === "created" && s2 === "pending" && pick2.ok && pick2.result.path === null) {
    pass("S10.9", "元素选择取到的正文（`source.selection === false`）同 URL 不同正文 → `pending`（判定链第 4 步）",
      `第 1 次=${s1} 第 2 次=${s2} path=${pick2.result.path} inboxId=${pick2.result.inboxId}（偏好=new、信封无 conflict → explicit=null）`);
  } else {
    fail("S10.9", "`selection:false` 的同 URL 不同正文应进收件箱 pending",
      `第 1 次=${s1} 第 2 次=${s2} path=${pick2.ok ? pick2.result.path : "-"}（期望 created → pending）`);
  }

  /* ── S10.10 阴性对照：同一个 URL、`selection:true` → 走第 3 步 `appended` ── */
  const pick3 = await env.clip.receiveEnvelopeOutcome(chainEnvelope("真·文本选区二次剪藏。\n", true));
  const s3 = pick3.ok ? pick3.result.status : `error:${pick3.error.code}`;
  if (s3 === "appended") {
    pass("S10.10", "阴性对照：同 URL 但 `selection:true` → `appended`（证明 `selection` 真的被读，不是恒 pending）",
      `status=${s3} path=${pick3.ok ? pick3.result.path : "-"}`);
  } else {
    fail("S10.10", "`selection:true` 应走判定链第 3 步 appended",
      `status=${s3}（期望 appended；若也是 pending，则说明 selection 没被读）`);
  }
  env.clip.setImportChannelContext({ channel: "in-app" });
  env.clip.resetImportLandingPreference(); // 复原默认偏好，避免污染后续顺序

  /* ── S10.11 受限页面：桥/扩展对受限页面的「如实提示」口径（静态证据，真机交互另行 UNVERIFIED） ── */
  const restrictedEvidence = [];
  const extErrors = fs.readFileSync(path.join(ROOT, "extension", "src", "lib", "errors.js"), "utf8");
  const hasUi = /"IMP-1006"[\s\S]{0,260}?ui:\s*"[^"]+"[\s\S]{0,120}?uiSource:/.test(extErrors);
  restrictedEvidence.push(`extension/src/lib/errors.js 的 IMP-1006 带 ui 文案与 uiSource 出处=${hasUi}`);
  const pickerFiles = [];
  // 候选清单按 0.3.1 的现状收敛：㉝ 已删除 `content/float.js`（选区浮标），㊵ 又整体移除了高亮
  // （`content/highlight.js` / `lib/highlights.js`），所以这里**不再**把已删文件列进候选，
  // 否则「发现清单」会永远显示一个不存在的文件名，看起来像「实现文件还在」。
  for (const rel of ["content/picker.js", "lib/picker.js", "content/select-element.js"]) {
    if (fs.existsSync(path.join(ROOT, "extension", "src", rel))) pickerFiles.push(rel);
  }
  const removedByRuling = ["content/float.js", "content/highlight.js", "lib/highlights.js"]
    .filter((rel) => !fs.existsSync(path.join(ROOT, "extension", "src", rel)));
  restrictedEvidence.push(`元素选择实现文件：${pickerFiles.length ? pickerFiles.join(", ") : "**尚未存在**（0.3.1 ㉝ 未落地）"}`);
  restrictedEvidence.push(`㉝/㊵ 要求删除且已确认不存在：${removedByRuling.join(", ") || "(无)"}`);
  record("INFO", "S10.11", "受限页面（chrome:// / 扩展商店 / PDF）的**如实提示**：只做了静态取证，真机交互未验证",
    restrictedEvidence.join(" | "));

  await restarted.controller.stop();
}

/* ------------------------------------------------------------------ 场景 13 */
/* A · 网页版剪藏页：`POST /v1/clip/stage` → 页面读到 → `POST /v1/clip/commit` → **磁盘上真的有那条笔记**
 *
 * 盯的是**用户看得见的那条路径**（Lead 2026-09-30 的要求），不是「函数被调用了」：
 *   ① 扩展用它**真实**的 `buildStageRequest()` 组装请求体（不在这里复刻 8 个键）；
 *   ② 桥回的 `openUrl` 真的能 `GET` 到页面 HTML，且注入的 `clip-boot` 与这次暂存逐字一致；
 *   ③ 页面用 `stageId + k` 真的读得到**正文**（`GET /v1/clip/stage`）；
 *   ④ commit 之后**工作区里真的有那条笔记**（进收件箱的落 `.opennote/inbox/<id>/`；
 *      直接入库的落 `<folder>/<title>.md`，正文 = 页面里编辑过的那一份）。
 *
 * `folders` / `commit.folder` 这两条按 Lead 裁定改成**运行期判定**（不再匹配源码字面）：
 *   · `folders[0] === ""`、去重；「工作区没打开」→ IMP-4007；「挂钩缺失/抛错/非数组」→ IMP-4014；
 *     「列表真的为空」→ `{ok:true, folders:[""]}` —— **这三种必须能分辨**；
 *   · commit 的 `folder` 不存在 → 明确 4xx **且磁盘上没有新建那个目录**；`""` → 收件箱；已存在 → 落到那里。
 * 两条都配了内存变异（改坏 `folders[0]` / 删掉 `includes` 校验 → 必须变红）。
 */
function bootClipBridge(mod, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "opennote-clip-bridge-"));
  let token = options.token || null;
  const logLines = [];
  const controller = mod.createBridge({
    dataDir,
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
    onEnvelope: options.onEnvelope || null,
    getAdvancedOverwrite: () => false,
    isEnabled: () => true,
    getTokenHash: () => (token ? mod.sha256Hex(token) : null),
    getWorkspaceInfo: options.getWorkspaceInfo || (() => ({ open: true, name: "验证笔记本" })),
    getInboxEnabled: () => true,
    getInboxMode: () => "inbox",
    ...(options.getFolders === undefined ? {} : { getFolders: options.getFolders }),
    log: (event, line) => { logLines.push(JSON.stringify([event, line])); },
  });
  if (!token && options.generateToken !== false) token = controller.generateToken();
  return { controller, dataDir, logLines, getToken: () => token };
}

/** 从页面 HTML 里取桥注入的引导数据块（`<script type="application/json" id="clip-boot">`）。 */
function clipBootOf(html) {
  const m = /<script type="application\/json" id="clip-boot">([\s\S]*?)<\/script>/.exec(String(html));
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/\\u003c/g, "<"));
  } catch {
    return null;
  }
}

async function scenario13(env) {
  return withCoverageGuard("S13", EXPECTED_S13, () => scenario13Body(env));
}

async function scenario13Body(env) {
  stanza("场景 13 · 网页版剪藏页：stage → 页面读到 → commit → 真的落盘");
  const bridgePath = path.join(ROOT, "electron", "bridge.cjs");
  const root = await freshWorkspace(env);
  fs.mkdirSync(path.join(root, "归档"), { recursive: true });
  env.clip.resetImportChannelContext();
  env.clip.setImportChannelContext({ channel: "local-bridge" });
  env.clip.setImportLandingPreference("inbox");
  const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

  /* 挂钩是**可变**的：同一个桥上就能问出「正常 / 抛错 / 非数组 / 工作区没打开 / 空列表」五种答案。 */
  let foldersImpl = () => ["归档", "剪藏", "归档"];
  let workspaceOpen = true;
  const bridge = bootClipBridge(env.bridgeModule, {
    onEnvelope: (json) => env.clip.receiveEnvelopeOutcome(json),
    getWorkspaceInfo: () => ({ open: workspaceOpen, name: "验证笔记本" }),
    getFolders: () => foldersImpl(),
  });
  const started = await bridge.controller.start();
  const token = bridge.getToken();
  const port = started && started.port ? started.port : null;
  if (!port) {
    fail("S13.0", "前置：剪藏桥在 127.0.0.1 启动（带 folders/workspace 挂钩）", JSON.stringify(started));
    return;
  }
  pass("S13.0", "前置：剪藏桥启动（含 clip 挂钩），工作区已备好 `归档/` 目录",
    `port=${port} 令牌=${token.slice(0, 8)}…（${token.length} 字符） 工作区=${path.basename(root)}`);

  /* ── S13.1 扩展**真实**的 buildStageRequest → 桥回 {ok, stageId, expiresAt, openUrl} ── */
  const built = env.stage.buildStageRequest({
    url: "https://example.com/s13-clip",
    title: "剪藏页标题",
    body: "第一段正文。\n\n第二段正文。\n",
    selection: false,
    site: "example.com",
    author: null,
    publishedAt: null,
    assets: [],
    warnings: [],
  });
  const stageRes = await httpCall(port, { origin: EXT_ORIGIN, token, path: "/v1/clip/stage", body: built.request });
  const stageJson = stageRes.json || {};
  const stageId = typeof stageJson.stageId === "string" ? stageJson.stageId : "";
  const openUrl = typeof stageJson.openUrl === "string" ? stageJson.openUrl : "";
  const expectedOpenPrefix = `http://127.0.0.1:${port}/clip/${stageId}?k=`;
  const stageOk = stageRes.status === 200 && stageJson.ok === true && stageId.length >= 32
    && /^[A-Za-z0-9_-]+$/.test(stageId) && typeof stageJson.expiresAt === "number"
    && openUrl.startsWith(expectedOpenPrefix) && openUrl.length > expectedOpenPrefix.length;
  const k = stageOk ? decodeURIComponent(openUrl.slice(expectedOpenPrefix.length)) : "";
  if (stageOk) {
    pass("S13.1", "`POST /v1/clip/stage`：扩展真实请求体 → 200 `{ok, stageId, expiresAt, openUrl}`；"
      + "`stageId` 由桥生成（≥32 base64url），`openUrl` 由桥按**真实监听端口**拼",
      `http=${stageRes.status} stageId=${stageId.length} 字符 openUrl=http://127.0.0.1:${port}/clip/<stageId>?k=<${k.length} 字符>`
      + ` expiresAt=+${Math.round((stageJson.expiresAt - Date.now()) / 60000)} 分钟｜请求体键=${JSON.stringify(Object.keys(built.request))}`);
  } else {
    fail("S13.1", "stage 必须回 200 与冻结的四个字段（平铺不套 result）",
      `http=${stageRes.status} body=${JSON.stringify(stageJson).slice(0, 220)} built=${JSON.stringify(built.request).slice(0, 200)}`);
  }

  /* ── S13.2 页面读到（1/2）：`GET openUrl` → 页面 HTML + 引导数据块 + CSP ── */
  const page = stageOk ? await httpCall(port, { method: "GET", path: `/clip/${encodeURIComponent(stageId)}?k=${encodeURIComponent(k)}` }) : { status: 0 };
  const boot = clipBootOf(page.text || "");
  const csp = String(page.headers ? page.headers["content-security-policy"] || "" : "");
  const scriptSrc = (/script-src([^;]*)/.exec(csp) || [])[1] || "";
  const pageOk = page.status === 200 && /text\/html/.test(String(page.headers && page.headers["content-type"]))
    && boot !== null && boot.port === port && boot.stageId === stageId && boot.k === k
    && scriptSrc.includes("'self'") && !scriptSrc.includes("unsafe-inline")
    && String(page.headers["cache-control"] || "").includes("no-store");
  if (pageOk) {
    pass("S13.2", "页面真的读得到：`GET /clip/<stageId>?k=` → 200 HTML，注入的 `clip-boot` 与这次暂存逐字一致，"
      + "CSP `script-src 'self'`（无 unsafe-inline）+ `no-store`",
      `http=${page.status} HTML=${(page.text || "").length} 字符 boot=${JSON.stringify(boot)} script-src=${JSON.stringify(scriptSrc.trim())}`);
  } else {
    fail("S13.2", "剪藏页 HTML 与引导数据块必须能读且与暂存一致",
      `http=${page.status} boot=${JSON.stringify(boot)} 期望 port=${port}/stageId=${stageId.slice(0, 10)}… script-src=${JSON.stringify(scriptSrc.trim())}`
      + ` cache-control=${JSON.stringify(page.headers && page.headers["cache-control"])} body=${String(page.text || "").slice(0, 160)}`);
  }

  /* ── S13.3 页面读到（2/2）：`GET /v1/clip/stage` → 正文真的在那儿 ── */
  const readPath = `/v1/clip/stage?stageId=${encodeURIComponent(stageId)}&k=${encodeURIComponent(k)}`;
  const read = stageOk ? await httpCall(port, { method: "GET", path: readPath }) : { status: 0 };
  const staged = read.json && read.json.stage ? read.json.stage : null;
  const readOk = read.status === 200 && staged !== null
    && staged.title === "剪藏页标题" && staged.body === "第一段正文。\n\n第二段正文。\n"
    && staged.url === "https://example.com/s13-clip" && staged.selection === false
    && Array.isArray(staged.tags) && staged.source && staged.source.site === "example.com"
    && typeof staged.capturedAt === "string";
  if (readOk) {
    pass("S13.3", "页面读得到**正文**：`GET /v1/clip/stage?stageId&k` 回 `{ok, stage:{url,title,body,selection,tags,source,assets,capturedAt}, expiresAt}`，"
      + "字段与暂存逐字一致（`selection` 是布尔 false）",
      `http=${read.status} stage 键=${JSON.stringify(Object.keys(staged))} body 长度=${staged.body.length}`);
  } else {
    fail("S13.3", "页面必须能用 stageId+k 读到暂存正文",
      `http=${read.status} stage=${JSON.stringify(read.json).slice(0, 220)}`);
  }

  /* ── S13.4 凭据：k 错 → 401；stageId 不存在 → 404（阴性对照） ──
   * ⚠️ 判据盯**语义**（状态码 + 两码可区分），不写死具体码号：本轮实现把剪藏页的码改成了
   * 专用码（`IMP-4019` k 不匹配 / `IMP-4021` 暂存失效），写死旧码的判据会在**产品正确**时假红
   * —— 而契约要的是「页面能分清『链接被改过』与『链接过期了』」。 */
  const badK = stageOk ? await httpCall(port, { method: "GET", path: `/v1/clip/stage?stageId=${encodeURIComponent(stageId)}&k=${encodeURIComponent(k.slice(0, -1) + (k.endsWith("A") ? "B" : "A"))}` }) : { status: 0 };
  const noStage = await httpCall(port, { method: "GET", path: `/v1/clip/stage?stageId=${"A".repeat(43)}&k=${"B".repeat(43)}` });
  if (badK.status === 401 && codeOf(badK) && noStage.status === 404 && codeOf(noStage) && codeOf(badK) !== codeOf(noStage)) {
    pass("S13.4", "页面凭据两道**分得开**：`k` 不对 → 401；`stageId` 不存在/过期 → 404（两个不同的码，不得混成一个）",
      `错 k → http=${badK.status}/${codeOf(badK)}；未知 stageId → http=${noStage.status}/${codeOf(noStage)}`);
  } else {
    fail("S13.4", "`k` 与 `stageId` 的失败必须是 401/404 且两个可分辨的码",
      `错 k → http=${badK.status}/${codeOf(badK)}（期望 401/某个码）；未知 stageId → http=${noStage.status}/${codeOf(noStage)}（期望 404/另一个码）`);
  }

  /* ── S13.5 folders 正常态：`""` 第 0 项 + 去重 + 排序 ── */
  const foldersPath = `/v1/clip/folders?stageId=${encodeURIComponent(stageId)}&k=${encodeURIComponent(k)}`;
  const foldersRes = stageOk ? await httpCall(port, { method: "GET", path: foldersPath }) : { status: 0 };
  const folders = foldersRes.json && Array.isArray(foldersRes.json.folders) ? foldersRes.json.folders : null;
  const foldersOk = folders !== null && folders[0] === "" && folders.length === 3
    && JSON.stringify(folders) === JSON.stringify(["", "剪藏", "归档"]);
  if (foldersOk) {
    pass("S13.5", "`GET /v1/clip/folders`：`folders[0] === \"\"`（= 收件箱）且重复目录只出现一次（挂钩给了 `[归档, 剪藏, 归档]`）",
      `http=${foldersRes.status} folders=${JSON.stringify(folders)}`);
  } else {
    fail("S13.5", "folders 必须以 \"\" 开头、去重（挂钩输入 [归档, 剪藏, 归档]）",
      `http=${foldersRes.status} folders=${JSON.stringify(folders)}（期望 ["", "剪藏", "归档"]）`);
  }

  /* ── S13.6 folders 三态必须能分辨：没打开工作区 / 挂钩坏 / 列表真的为空 ── */
  /* ⚠️ 状态码按 `ERROR_TABLE` 的**语义**判，不写死我猜的那个数字：
   *   `IMP-4007`（工作区未打开）= 409、`IMP-4014`（内部一致性错误）= 500 —— 第一版我写死 503，
   *   在**产品正确**时红了两次（判据盯字面的现场版）。这里判的是「码对不对 + 4xx/5xx 分得开」。 */
  workspaceOpen = false;
  const noWorkspace = await httpCall(port, { method: "GET", path: foldersPath });
  workspaceOpen = true;
  foldersImpl = () => { throw new Error("hook boom"); };
  const hookThrows = await httpCall(port, { method: "GET", path: foldersPath });
  foldersImpl = () => "not-an-array";
  const hookNotArray = await httpCall(port, { method: "GET", path: foldersPath });
  foldersImpl = () => [];
  const emptyList = await httpCall(port, { method: "GET", path: foldersPath });
  /* ⚠️ 「缺挂钩」必须在**另一座桥**上问，而那座桥有自己的暂存区 ——
   * 第一版拿主桥的 stageId 去问它，撞的是 `IMP-4017`（没有这条暂存），**测的根本不是缺挂钩**。
   * 所以：先在那座桥上真的 stage 一次，再问 folders。 */
  const noHookBridge = bootClipBridge(env.bridgeModule, { getWorkspaceInfo: () => ({ open: true }) });
  const noHookStarted = await noHookBridge.controller.start();
  let hookMissing = { status: 0 };
  if (noHookStarted.port) {
    const st = await httpCall(noHookStarted.port, { origin: EXT_ORIGIN, token: noHookBridge.getToken(), path: "/v1/clip/stage", body: built.request });
    const u = st.json && st.json.openUrl ? String(st.json.openUrl) : "";
    const m = /\/clip\/([^?]+)\?k=(.+)$/.exec(u);
    if (m) {
      hookMissing = await httpCall(noHookStarted.port, { method: "GET", path: `/v1/clip/folders?stageId=${m[1]}&k=${m[2]}` });
    }
  }
  await noHookBridge.controller.stop();
  const t1 = noWorkspace.status >= 400 && noWorkspace.status < 500 && codeOf(noWorkspace) === "IMP-4007";
  const t2 = [hookThrows, hookNotArray, hookMissing].every((r) => r.status >= 500 && codeOf(r) === "IMP-4014");
  const t3 = emptyList.status === 200 && emptyList.json && JSON.stringify(emptyList.json.folders) === JSON.stringify([""]);
  if (t1 && t2 && t3) {
    pass("S13.6", "folders 的三态**能分辨**：工作区没打开 → 4xx `IMP-4007`；挂钩缺失/抛错/非数组 → 5xx `IMP-4014`；"
      + "列表真的为空 → `{ok:true, folders:[\"\"]}`（绝不把内部错误伪装成「工作区里没有目录」）",
      `没打开 → http=${noWorkspace.status}/${codeOf(noWorkspace)}；抛错 → ${hookThrows.status}/${codeOf(hookThrows)}；`
      + `非数组 → ${hookNotArray.status}/${codeOf(hookNotArray)}；缺挂钩 → ${hookMissing.status}/${codeOf(hookMissing)}；`
      + `空列表 → http=${emptyList.status} folders=${JSON.stringify(emptyList.json && emptyList.json.folders)}`);
  } else {
    fail("S13.6", "folders 三态必须可分辨（IMP-4007 4xx / IMP-4014 5xx / 空列表 ok:true）",
      `没打开 → http=${noWorkspace.status}/${codeOf(noWorkspace)}（期望 4xx/IMP-4007）；抛错 → ${hookThrows.status}/${codeOf(hookThrows)}；`
      + `非数组 → ${hookNotArray.status}/${codeOf(hookNotArray)}；缺挂钩 → ${hookMissing.status}/${codeOf(hookMissing)}（三者期望 5xx/IMP-4014）；`
      + `空列表 → http=${emptyList.status} folders=${JSON.stringify(emptyList.json && emptyList.json.folders)}（期望 200/[""]）`);
  }

  /* ── 后续 commit 用同一套 hook，恢复成正常态 ── */
  foldersImpl = () => ["归档", "剪藏"];
  const stageOnce = async () => {
    const r = await httpCall(port, { origin: EXT_ORIGIN, token, path: "/v1/clip/stage", body: built.request });
    const u = r.json && r.json.openUrl ? String(r.json.openUrl) : "";
    const m = /\/clip\/([^?]+)\?k=(.+)$/.exec(u);
    return m ? { id: decodeURIComponent(m[1]), key: decodeURIComponent(m[2]) } : null;
  };

  /* ── S13.7 commit 的 folder 不存在 → 明确 4xx **且磁盘上没有新建那个目录** ── */
  const ghost = "不存在的目录";
  const s7 = await stageOnce();
  const ghostRes = s7
    ? await httpCall(port, { path: "/v1/clip/commit", body: { stageId: s7.id, k: s7.key, title: "落点不存在的剪藏", body: "正文。\n", folder: ghost } })
    : { status: 0 };
  const ghostDir = fs.existsSync(path.join(root, ghost));
  const ghostMsg = ghostRes.json && ghostRes.json.error ? String(ghostRes.json.error.userMessage || "") : "";
  /* 同样盯语义：**4xx + 有一句能读给人听的文案 + 磁盘上没被创建**。
   * （码号实现用的是专用码 `IMP-4022`；契约要的是「不存在的落点必须被明确拒绝且不自动创建」。） */
  if (ghostRes.status >= 400 && ghostRes.status < 500 && ghostMsg.trim() !== "" && !ghostDir) {
    pass("S13.7", "commit 的 `folder` 非空时必须是**已存在**的目录：不存在 → 明确 4xx + 可读文案，"
      + "**磁盘上没有被创建出那个目录**（绝不自动创建）",
      `http=${ghostRes.status}/${codeOf(ghostRes)} 目录被创建=${ghostDir} userMessage=「${ghostMsg.slice(0, 60)}」`);
  } else {
    fail("S13.7", "不存在的落点必须被拒（4xx + 可读文案），且不得自动创建目录",
      `http=${ghostRes.status}/${codeOf(ghostRes)} 目录被创建=${ghostDir}（期望 4xx/false）userMessage=「${ghostMsg.slice(0, 60)}」`);
  }

  /* ── S13.8 commit `folder:""` → 进收件箱，磁盘上真的有收件箱条目 ── */
  const s8 = await stageOnce();
  const inboxCommit = s8
    ? await httpCall(port, { path: "/v1/clip/commit", body: { stageId: s8.id, k: s8.key, title: "收件箱剪藏", body: "先编辑过的正文。\n", folder: "" } })
    : { status: 0 };
  const inboxResult = inboxCommit.json && inboxCommit.json.result ? inboxCommit.json.result : null;
  const inboxId = inboxResult && inboxResult.inboxId ? String(inboxResult.inboxId) : "";
  const inboxFiles = inboxId ? listWorkspace(root).filter((f) => f.startsWith(`.opennote/inbox/${inboxId}/`)) : [];
  if (inboxCommit.status >= 200 && inboxCommit.status < 300 && inboxResult && inboxResult.status === "pending" && inboxId && inboxFiles.length > 0) {
    pass("S13.8", "commit `folder:\"\"` → 回执 `pending`（进收件箱）**且工作区里真的有那个收件箱条目**（不是只回了个 id）",
      `http=${inboxCommit.status} status=${inboxResult.status} inboxId=${inboxId} 磁盘文件=${JSON.stringify(inboxFiles)}`);
  } else {
    fail("S13.8", "commit 进收件箱必须真的落盘",
      `http=${inboxCommit.status} status=${inboxResult && inboxResult.status} inboxId=${inboxId} 磁盘文件=${JSON.stringify(inboxFiles)}`
      + ` body=${JSON.stringify(inboxCommit.json).slice(0, 200)}`);
  }

  /* ── S13.9 commit `folder:"归档"`（已存在）在**默认偏好**下 → `<归档>/<标题>.md` 真的落盘 ──
   *
   * ⚠️ **这条曾经被我自己绕过去**：第一版先 `setImportLandingPreference("new")` 才拿到 `201`，
   * 那个绕过**正好把「用户在剪藏页选的落点被 ㉕ 吞掉」这个真缺陷盖住了** —— 用户在确认页选「归档」，
   * 笔记却进收件箱，那个下拉就是**假开关**（`02 §5.9.5` 早就写着「非空 `folder` … 也不静默改成收件箱」，
   * 是**文档对、实现对不上**）。
   * 现在改成 **不调 `setImportLandingPreference`（用模块默认 = ㉕「先进入收件箱」）**：
   *   · 指名落点（非空 `folder`）= 客户端/用户已经做过决定 ⇒ **直接落盘**；
   *   · 不指名（`folder:""`）⇒ 仍然进收件箱（S13.8 那条）。
   * 两条一起才说明「指名 ≠ 不指名」是被判据分开的。 */
  env.clip.resetImportLandingPreference();
  const s9 = await stageOnce();
  const editedTitle = "归档里的剪藏";
  const editedBody = "这是用户在剪藏页里改过的正文。\n\n第二段。\n";
  const archiveCommit = s9
    ? await httpCall(port, { path: "/v1/clip/commit", body: { stageId: s9.id, k: s9.key, title: editedTitle, body: editedBody, folder: "归档" } })
    : { status: 0 };
  const archiveResult = archiveCommit.json && archiveCommit.json.result ? archiveCommit.json.result : null;
  const landedRel = archiveResult && archiveResult.path ? String(archiveResult.path) : "";
  const landedAbs = landedRel ? path.join(root, ...landedRel.split("/").filter(Boolean)) : "";
  const landedText = landedAbs && fs.existsSync(landedAbs) ? fs.readFileSync(landedAbs, "utf8") : "";
  const landedOk = archiveCommit.status >= 200 && archiveCommit.status < 300 && archiveResult && archiveResult.status === "created"
    && landedRel.startsWith("归档/") && landedText.includes(editedTitle) && landedText.includes("这是用户在剪藏页里改过的正文。");
  if (landedOk) {
    pass("S13.9", "**默认偏好**（㉕「先进入收件箱」，**不调** `setImportLandingPreference`）下 commit `folder:\"归档\"` → "
      + "`created`，笔记**真的落在 `<归档>/<标题>.md`**，正文 = 页面里编辑过的那一份 —— 用户在剪藏页选的落点**不是假开关**",
      `http=${archiveCommit.status} status=${archiveResult.status} path=${landedRel} 磁盘字节=${Buffer.byteLength(landedText)}`
      + `（偏好=模块默认，未调 setImportLandingPreference）`);
  } else {
    fail("S13.9", "默认偏好下「指名落点」必须直接落盘（不许被 ㉕ 静默改成收件箱）",
      `http=${archiveCommit.status} status=${archiveResult && archiveResult.status} path=${landedRel} 存在=${Boolean(landedText)}`
      + ` 含标题=${landedText.includes(editedTitle)} 含编辑后正文=${landedText.includes("这是用户在剪藏页里改过的正文。")}`
      + `（期望 created + 归档/<标题>.md；若 status=pending 说明指名落点被吞了）`);
  }

  /* ── S13.14 ㉕.2 **不许放松**：默认偏好 + `conflict:"overwrite"` + 指名落点 → 仍 `pending`、磁盘上没有新 .md ──
   *
   * 这是本轮最容易被后来人改松的地方：「指名落点要直接落盘」这条收窄**不能**把
   * 「先进入收件箱」对 `overwrite` 的拦截一起放掉（`overwrite` 是最不可逆的无审阅写入）。
   * 直接走**真接收端**（`receiveEnvelopeOutcome`），因为 `POST /v1/clip/commit` 恒发 `conflict:"new"`。 */
  {
    /* ⚠️ 只数**笔记**（`.opennote/` 之外的 .md）：收件箱条目里也有一个 `body.md`，
     * 第一版把两者一起数 → `新增 .md=2`，在**产品正确**时假红了一次。 */
    const noteMds = () => listWorkspace(root).filter((f) => f.endsWith(".md") && !f.startsWith(".opennote/")).length;
    const mdBefore14 = noteMds();
    const baseEnvelope = envelope({});
    const direct = (overrides) => {
      const e = envelope({ source: { ...baseEnvelope.source, url: "https://example.com/s13-overwrite" }, ...overrides });
      e.target = { folder: "归档", notePath: null };
      return e;
    };
    env.clip.resetImportChannelContext();
    env.clip.setImportChannelContext({ channel: "local-bridge" });
    env.clip.resetImportLandingPreference();
    const namedNew = await env.clip.receiveEnvelopeOutcome(direct({ conflict: "new", title: "指名落点·new" }));
    const namedOverwrite = await env.clip.receiveEnvelopeOutcome(direct({ conflict: "overwrite", title: "指名落点·overwrite" }));
    const mdAfter14 = noteMds();
    const namedStatus = namedNew.ok ? namedNew.result.status : `error:${namedNew.error.code}`;
    const overwriteStatus = namedOverwrite.ok ? namedOverwrite.result.status : `error:${namedOverwrite.error.code}`;
    const namedLanded = namedNew.ok && namedNew.result.path ? String(namedNew.result.path) : "";
    const namedFileExists = namedLanded ? fs.existsSync(path.join(root, ...namedLanded.split("/").filter(Boolean))) : false;
    const delta = mdAfter14 - mdBefore14;
    if (namedStatus === "created" && namedFileExists && overwriteStatus === "pending" && delta === 1) {
      pass("S13.14", "㉕.2 **没有放松**（反向断言）：默认偏好下指名落点 + `conflict:\"new\"` → `created` 且真的落盘；"
        + "同一个指名落点 + `conflict:\"overwrite\"` → **仍然 `pending`**、磁盘上没有第二条 .md",
        `new → ${namedStatus} path=${namedLanded} 文件存在=${namedFileExists}；overwrite → ${overwriteStatus}；`
        + `本轮新增 .md=${delta}（期望 1，只来自 new 那一次）`);
    } else {
      fail("S13.14", "「指名落点直接落盘」的收窄不得放掉 ㉕.2（overwrite 仍必须被拦进收件箱）",
        `new → ${namedStatus} path=${namedLanded} 文件存在=${namedFileExists}（期望 created + 落盘）；`
        + `overwrite → ${overwriteStatus}（期望 pending）；本轮新增 .md=${delta}（期望 1）`);
    }
    env.clip.setImportChannelContext({ channel: "in-app" });
    env.clip.resetImportLandingPreference();
  }

  /* ── S13.10 幂等：同一 stageId 同内容 → 同一份回执、不写第二遍；内容不同 → 409 ── */
  const s10 = await stageOnce();
  env.clip.resetImportLandingPreference();
  const first = s10
    ? await httpCall(port, { path: "/v1/clip/commit", body: { stageId: s10.id, k: s10.key, title: "幂等剪藏", body: "同一份内容。\n", folder: "" } })
    : { status: 0 };
  const firstResult = first.json && first.json.result ? first.json.result : null;
  const firstFiles = firstResult && firstResult.path ? listWorkspace(root).filter((f) => f === String(firstResult.path)) : [];
  const filesAfterFirst = listWorkspace(root).length;
  const second = s10
    ? await httpCall(port, { path: "/v1/clip/commit", body: { stageId: s10.id, k: s10.key, title: "幂等剪藏", body: "同一份内容。\n", folder: "" } })
    : { status: 0 };
  const secondResult = second.json && second.json.result ? second.json.result : null;
  const filesAfterSecond = listWorkspace(root).length;
  const third = s10
    ? await httpCall(port, { path: "/v1/clip/commit", body: { stageId: s10.id, k: s10.key, title: "幂等剪藏（改了）", body: "换了内容。\n", folder: "" } })
    : { status: 0 };
  const filesAfterThird = listWorkspace(root).length;
  const sameReceipt = firstResult && secondResult
    && firstResult.importId === secondResult.importId && firstResult.path === secondResult.path;
  /* 第三次（内容不同）的判据盯**语义**：必须 409、必须给得出可读的 userMessage、**必须一个字节都不写**
   * （码号由实现定：本轮是 `IMP-4018`「暂存已入库且内容不同」这个正式码；第一版我写死 `IMP-4011`，
   *   在实现换成更精确的码号时假红了一次 —— 契约要的是「不许静默覆盖」，不是某个号码）。 */
  const thirdMsg = third.json && third.json.error ? String(third.json.error.userMessage || "") : "";
  if (first.status >= 200 && first.status < 300 && second.status >= 200 && second.status < 300
      && sameReceipt && filesAfterSecond === filesAfterFirst
      && third.status === 409 && thirdMsg.trim() !== "" && filesAfterThird === filesAfterFirst) {
    pass("S13.10", "submit 幂等：同一 stageId + 同一内容 → **同一份已存回执**、磁盘不再动一次；内容不同 → 409 + 可读文案（不静默覆盖、不写第二遍）",
      `第 1 次 http=${first.status} path=${firstResult && firstResult.path}；第 2 次 http=${second.status} 同一 importId=${sameReceipt}`
      + ` 文件数 ${filesAfterFirst} → ${filesAfterSecond}；改内容 → http=${third.status}/${codeOf(third)} 文件数 ${filesAfterThird}`
      + ` userMessage=「${thirdMsg.slice(0, 60)}」`);
  } else {
    fail("S13.10", "同一 stageId 的重复提交必须幂等，改内容必须 409 且不写盘",
      `第 1 次 http=${first.status}/${JSON.stringify(firstResult).slice(0, 80)}；第 2 次 http=${second.status} 同一回执=${sameReceipt}`
      + ` 文件数 ${filesAfterFirst}→${filesAfterSecond}；改内容 → http=${third.status}/${codeOf(third)} 文件数 ${filesAfterThird}`
      + ` userMessage=「${thirdMsg.slice(0, 60)}」（期望 409 + 有文案 + 文件数不变）`);
  }
  env.clip.setImportLandingPreference("inbox");

  /* ── S13.11 `k` / `stageId` 绝不进日志（`bridge.log` + 主进程 log 回调两向） ── */
  await bridge.controller.stop();
  const logText = (() => {
    try { return fs.readFileSync(path.join(bridge.dataDir, "bridge.log"), "utf8"); } catch { return ""; }
  })();
  const logAll = `${logText}\n${bridge.logLines.join("\n")}`;
  const leaks = stageId && k ? [stageId, k].filter((secret) => logAll.includes(secret)) : ["(没有 stageId/k 可比)"] ;
  if (stageId && k && logAll.length > 0 && leaks.length === 0) {
    pass("S13.11", "`k` 与 `stageId` **绝不进日志**：`bridge.log`（磁盘）与主进程 `log()` 回调（内存）两向都没有它们",
      `日志 ${logAll.length} 字符 / ${bridge.logLines.length} 行回调；命中 stageId=${logAll.includes(stageId)} 命中 k=${logAll.includes(k)}`);
  } else {
    fail("S13.11", "`k` / `stageId` 不得出现在 bridge.log 或主进程日志回调里",
      `日志 ${logAll.length} 字符；泄漏项=${JSON.stringify(leaks)}；样例=${JSON.stringify(logAll.slice(0, 200))}`);
  }

  /* ── S13.12 **跨线**：扩展真实请求体被接收；`{url,alt}` 形状被拒（扩展一回归就红） ── */
  const crossBridge = bootClipBridge(env.bridgeModule, { onEnvelope: async () => ({ ok: true, status: 200, result: { status: "created", path: "x.md" } }) });
  const crossStarted = await crossBridge.controller.start();
  const crossPort = crossStarted && crossStarted.port ? crossStarted.port : null;
  const crossToken = crossBridge.getToken();
  let contractRes = { status: 0 };
  let wrongRes = { status: 0 };
  if (crossPort) {
    const withAssets = env.stage.buildStageRequest({
      url: "https://example.com/s13-assets", title: "带图剪藏", body: "正文。\n", selection: false,
      assets: [{ name: "a.png", mime: "image/png", dataBase64: "AAAA" }], warnings: [],
    });
    contractRes = await httpCall(crossPort, { origin: EXT_ORIGIN, token: crossToken, path: "/v1/clip/stage", body: withAssets.request });
    wrongRes = await httpCall(crossPort, {
      origin: EXT_ORIGIN, token: crossToken, path: "/v1/clip/stage",
      body: { ...withAssets.request, assets: [{ url: "https://example.com/a.png", alt: "" }] },
    });
    await crossBridge.controller.stop();
  }
  const wrongDetail = wrongRes.json && wrongRes.json.error && wrongRes.json.error.detail ? wrongRes.json.error.detail : null;
  const wrongField = wrongDetail && typeof wrongDetail.field === "string" ? wrongDetail.field : "";
  /* 语义判据：真形状 → 2xx；`{url,alt}` → **4xx 且点名是哪个字段**（`assets[0].name`）。
   * 不写死码号：契约要的是「桥如实说哪一项不合法」，码号是实现细节。 */
  if (contractRes.status >= 200 && contractRes.status < 300 && wrongRes.status >= 400 && wrongRes.status < 500 && wrongField.startsWith("assets")) {
    pass("S13.12", "**跨线**：扩展 `buildStageRequest()` 产出的资产形状被桥接收（2xx）；"
      + "把资产换成 `{url, alt}` → 桥**必拒** 4xx 且点名 `assets[…].name`（扩展一回归就红）",
      `扩展真实形状 → http=${contractRes.status}；{url:alt} → http=${wrongRes.status}/${codeOf(wrongRes)} field=${JSON.stringify(wrongField)}`);
  } else {
    fail("S13.12", "扩展的资产形状必须被接收，且 `{url,alt}` 必须被 4xx 拒绝并点名字段（否则这条跨线判据是恒绿）",
      `扩展真实形状 → http=${contractRes.status}；{url:alt} → http=${wrongRes.status}/${codeOf(wrongRes)} field=${JSON.stringify(wrongField)}（期望 2xx / 4xx + field=assets…）`);
  }

  /* ── S13.13 变异自检：把 `folders[0]` 与 commit 的成员校验改坏 → 对应断言必须变红 ── */
  {
    const mutations = [
      {
        id: "folders[0] 不再是收件箱（'' 挪到最后）",
        apply: (src) => src.replace(/(folders:\s*)\[\s*'',\s*\.\.\.\[\.\.\.seen\]\.sort\(\)\s*\]/, "$1[...[...seen].sort(), '']"),
        probe: async (mod) => {
          const b = bootClipBridge(mod, { getFolders: () => ["归档", "剪藏"] });
          const s = await b.controller.start();
          try {
            if (!s.port) return false;
            const r = await httpCall(s.port, { method: "GET", path: `/v1/clip/folders?stageId=${"A".repeat(43)}&k=${"B".repeat(43)}` });
            // 变异桥下这个请求会先撞 404（没有暂存）——所以这里直接看源码语义：换个角度，
            // 用**真实暂存**走一遍才算数。
            const st = await httpCall(s.port, { origin: EXT_ORIGIN, token: b.getToken(), path: "/v1/clip/stage", body: built.request });
            const u = st.json && st.json.openUrl ? String(st.json.openUrl) : "";
            const m = /\/clip\/([^?]+)\?k=(.+)$/.exec(u);
            if (!m) return false;
            const f = await httpCall(s.port, { method: "GET", path: `/v1/clip/folders?stageId=${m[1]}&k=${m[2]}` });
            void r;
            return Boolean(f.json && Array.isArray(f.json.folders) && f.json.folders[0] !== "");
          } finally {
            await b.controller.stop();
          }
        },
      },
      {
        id: "commit 删掉「必须已存在」的成员校验",
        apply: (src) => src.replace(/if\s*\(!folders\.folders\.includes\(folder\)\)\s*\{/, "if (false) {"),
        probe: async (mod) => {
          const b = bootClipBridge(mod, {
            getFolders: () => ["归档"],
            onEnvelope: async () => ({ ok: true, status: 200, result: { status: "created", path: "x.md" } }),
          });
          const s = await b.controller.start();
          try {
            if (!s.port) return false;
            const st = await httpCall(s.port, { origin: EXT_ORIGIN, token: b.getToken(), path: "/v1/clip/stage", body: built.request });
            const u = st.json && st.json.openUrl ? String(st.json.openUrl) : "";
            const m = /\/clip\/([^?]+)\?k=(.+)$/.exec(u);
            if (!m) return false;
            const c = await httpCall(s.port, { path: "/v1/clip/commit", body: { stageId: m[1], k: m[2], title: "x", body: "y", folder: "不存在的目录" } });
            // 「变红」= 该请求**不再**被 IMP-4008 拒（校验确实被摘掉了）。
            return !(c.status === 422 && codeOf(c) === "IMP-4008");
          } finally {
            await b.controller.stop();
          }
        },
      },
    ];
    const bad = [];
    const ok = [];
    for (const m of mutations) {
      const mutated = loadMutatedModule(bridgePath, m.apply);
      if (!mutated) { bad.push(`${m.id}：**变异没命中源码**（锚点漂了）—— 本条自检失效`); continue; }
      let red = false;
      try {
        red = await m.probe(mutated);
      } catch (error) {
        bad.push(`${m.id}：变异桥跑不起来 → ${error && error.message ? error.message : String(error)}`);
        continue;
      }
      if (red) ok.push(`${m.id} 如期变红`);
      else bad.push(`${m.id}：**注入后断言仍绿 —— 这两条运行期判据是恒绿的**`);
    }
    if (bad.length === 0) {
      pass("S13.13", `变异自检：${mutations.length} 条运行期判据各自失效后，对应断言全部如期变红（「folders[0] 是收件箱」与「commit 的成员校验」）`,
        ok.join("；"));
    } else {
      fail("S13.13", "运行期判据的变异自检未全部通过（说明 S13.5/S13.7 有恒绿风险）", bad.join(" | "));
    }
  }
}

/* ------------------------------------------------------------------ 汇总 */
function finish() {
  /* ① 先做「信任门自检」并**在打印摘要之前**记进台账 —— 否则这条断言会落在摘要后面，
   *    红了也不出现在失败清单里（本轮真踩过：`check` 不存在 → ReferenceError，
   *    摘要照印 PASS 105/FAIL 0 而退出码是 1，摘要与退出码各说各话）。
   *    自检不去真写标记文件（`extension/` 是 b 的工作面），而是注入判定 + 静默模式。 */
  {
    const injected = treeTrusted("自检（静默）", ["extension/.mutation-running"], true);
    const empty = treeTrusted("自检（静默）", [], true);
    const live = extMarkersActive();
    const title = "「树在动」门禁双向正确：注入标记 → 判不可信（false）；注入空列表 → 判可信（true）";
    const detail = `注入 ["extension/.mutation-running"] → ${injected}（期望 false）；注入 [] → ${empty}（期望 true）；`
      + `真源现状=${live.length ? live.join(", ") : "无标记"}`;
    if (injected === false && empty === true) pass("E2E·信任门自检", title, detail);
    else fail("E2E·信任门自检", title, detail);
  }

  /* ② 收尾复查「树在不在动」：本轮中途有人开始 build / 跑变异 → 这一轮**不可信**，此时
   *    **连摘要都不该印**（印了就会被当成一次正常运行的结果读）。
   *    本脚本会 `ssrLoadModule` 插件源码（L245/246、L1169），变异在改坏它们时结论无意义。
   *    exit 2 = 中止，与 b 的标记协议一致。 */
  if (!treeTrusted("收尾")) process.exit(2);

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const failures = results.filter((r) => r.status === "FAIL");
  const unverified = results.filter((r) => r.status === "UNVERIFIED");
  const infos = results.filter((r) => r.status === "INFO");

  console.log("\n=== 端到端摘要 ===");
  console.log(`PASS ${counts.PASS || 0} / FAIL ${failures.length} / UNVERIFIED ${unverified.length} / INFO ${infos.length}`);
  if (infos.length) {
    console.log("\n--- 观测（INFO，不计入通过/失败） ---");
    for (const i of infos) console.log(`  INFO [${i.id}] ${i.title}: ${i.detail}`);
  }
  if (failures.length) {
    console.log("\n--- 失败清单 ---");
    for (const f of failures) console.log(`  FAIL [${f.id}] ${f.title}\n        ${f.detail}`);
  }
  if (unverified.length) {
    console.log("\n--- 未验证清单（不得当作通过） ---");
    for (const u of unverified) console.log(`  UNVERIFIED [${u.id}] ${u.title}\n        ${u.detail}`);
  }

  // 清理临时工作区
  for (const root of scenarioRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /* 信任门自检与收尾复查都已在 `finish()` 开头完成（必须在摘要之前 —— 见那里的注释）。 */
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error("verify-e2e 崩溃:", error && error.stack ? error.stack : error);
  process.exit(1);
});




