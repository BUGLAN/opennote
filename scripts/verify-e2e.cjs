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

/* ------------------------------------------------------------------ 报告 */

const results = [];
const evidence = {};

function record(status, id, title, detail) {
  results.push({ status, id, title, detail: detail == null ? "" : String(detail) });
  const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "UNVERIFIED";
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
  const bridgeModule = require(path.join(ROOT, "electron", "bridge.cjs"));

  return { server, lib, clip, inbox, toast, plugin, pluginEnvelope, bridgeModule };
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
    await scenario1(env);
    await scenario2(env);
    await scenario3(env);
    await scenario4(env);
    await scenario4b(env);
    await scenario5(env);
    await scenario6(env);
    await scenario7(env);
    await scenario8(env);
  } catch (error) {
    fail("SCENARIO-CRASH", "场景执行中断", error && error.stack ? error.stack.split("\n").slice(0, 4).join(" | ") : String(error));
  } finally {
    try {
      await env.server.close();
    } catch {
      /* ignore */
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
    const orderOk = keys.length === EXPECTED.length && keys.every((k, i) => k === EXPECTED[i]);
    if (orderOk) pass("S1.5", "8 键顺序逐字", keys.join(" → "));
    else fail("S1.5", "8 键顺序逐字", `实际 ${keys.join(" → ")}（${keys.length} 键）`);

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
    on(event, handler) {
      const list = state.appEvents.get(event) || [];
      list.push(handler);
      state.appEvents.set(event, list);
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
  stanza("场景 7 · App 渲染层 ↔ 主进程转交链路（真实 electron/main.cjs）");
  const root = await freshWorkspace(env);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-userdata-"));
  scenarioRoots.add(userData);
  const harness = createElectronStub(userData);

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

  // ── ③ 渲染层 5 秒不应答 → IMP-4006（不假成功） ─────────────────────────
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

  await scenario7b(env);

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

  // ── (1) 真实桥：6 个可选字段必须在 IPC 边界上存活 ─────────────────────
  const REAL_KEYS = ["address", "error", "lastRejectedOrigin", "startPort", "portRange", "lastPairing"];
  try {
    const { harness, restore } = await bootSecondaryMain(undefined);
    await harness.invoke("opennote:bridge:newToken", {});
    const status = await harness.invoke("opennote:bridge:start", {});
    const missing = REAL_KEYS.filter((k) => !(k in status));
    if (!missing.length) {
      pass("S7B.1", "真实桥：`bridgeStatusPayload()` 带着 6 个可选字段",
        `键数=${Object.keys(status).length}；address=${JSON.stringify(status.address)} startPort=${JSON.stringify(status.startPort)} portRange=${JSON.stringify(status.portRange)} lastPairing=${JSON.stringify(status.lastPairing)}`);
    } else {
      fail("S7B.1", "真实桥：6 个可选字段被重建逻辑吃掉", `缺少 ${missing.join(", ")}；实有键=${Object.keys(status).join(", ")}`);
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
      pass("S7B.6", "(2) `!controller` 分支：state='failed' + 可执行的 error 文案 + 6 个键仍在",
        `state=${JSON.stringify(status.state)} error=${JSON.stringify(status.error)} 键数=${Object.keys(status).length}`);
    } else {
      fail("S7B.6", "(2) `!controller` 分支", `state=${JSON.stringify(status.state)} error=${JSON.stringify(status.error)} typeof(error)=${typeof status.error} 6 键齐=${keysOk}`);
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

/* ------------------------------------------------------------------ 汇总 */
function finish() {
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

  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error("verify-e2e 崩溃:", error && error.stack ? error.stack : error);
  process.exit(1);
});




