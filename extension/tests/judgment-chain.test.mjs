/**
 * 判定链集成测试（BLOCK-1 回归闸门）。
 *
 * 为什么必须有这个文件：`conflict` 这个键的**缺省 vs 显式 `new`** 只差一个字段，
 * 但它决定接收端 `src/lib/clip/envelope.ts` 的 `conflictExplicit`，
 * 进而决定 `src/lib/clip/receive.ts` 的第 3 步（选区二次剪藏 → `appended`）
 * 与第 4 步（整页二次剪藏 → `pending` 进收件箱）会不会发生。
 * 只断言「键不存在」是不够的——必须**真跑接收端**，看它到底返回什么。
 *
 * 真实度（不含糊）：
 *   ✅ 真实执行：`src/lib/clip/**` 接收端（经 Vite ssrLoadModule 载入真 TS 源码）、
 *      我们的 `extension/src/lib/envelope.js`（真 buildEnvelope）、真磁盘（临时工作区，用 fs 读回字节）。
 *   ⚠️ 打桩：Electron IPC 边界（`window.opennote.fs.*` 用 Node fs 实现）——本环境没有 Electron 运行时。
 *   ❌ 未覆盖：真机 Chrome 里的 `chrome.*` 通道（另见 README「真机验证」一节）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEnvelope } from "../src/lib/envelope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));

/* ── Electron IPC 边界打桩：与 scripts/verify-e2e.cjs 同一套思路 ───────── */

function createNodeFsBridge() {
  const abs = (root, rel) => path.join(root, ...String(rel).split("/").filter(Boolean));
  return {
    isElectron: true,
    platform: process.platform,
    version: "0.0.0-extension-test",
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
        const target = abs(root, rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, text, "utf8");
      },
      writeBytes: async (root, rel, data) => {
        const target = abs(root, rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, Buffer.from(data));
      },
      mkdir: async (root, rel) => {
        await fs.promises.mkdir(abs(root, rel), { recursive: true });
      },
      remove: async (root, rel, options) => {
        await fs.promises.rm(abs(root, rel), { recursive: Boolean(options && options.recursive), force: true });
      },
      move: async (root, from, to) => {
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
  };
}

function installDomShim() {
  const noop = () => {};
  globalThis.window = {
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { href: "http://127.0.0.1/", origin: "http://127.0.0.1" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: "opennote-extension-test" },
    opennote: createNodeFsBridge(),
  };
  globalThis.document = {
    addEventListener: noop,
    removeEventListener: noop,
    visibilityState: "visible",
    hidden: false,
    documentElement: { dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {} } },
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, rel: "", href: "" }),
    body: { appendChild() {}, removeChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

let ready = null;

/** 载入真接收端（Vite 负责 TS 转译；用的是仓库根已安装的 vite，不进扩展依赖）。 */
async function bootstrap() {
  if (ready) return ready;
  ready = (async () => {
    installDomShim();
    const vite = await import(pathToFileURL(requireFromRoot.resolve("vite")).href);
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
    return { server, lib, clip };
  })();
  return ready;
}

async function freshWorkspace(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-chain-"));
  try {
    await env.lib.closeWorkspace();
  } catch {
    /* 首次没有工作区 */
  }
  await env.lib.openWorkspace(
    { id: `chain-${path.basename(root)}`, name: "判定链笔记本", kind: "node", location: root, addedAt: 1, lastOpenedAt: 1 },
    { silent: true },
  );
  return root;
}

/** 用**我们自己的** buildEnvelope 造信封，只覆盖来源字段。 */
function pluginEnvelope({ url, body, selection, title }) {
  return buildEnvelope({
    title,
    body,
    url,
    pageTitle: title,
    site: "example.com",
    capturedAt: "2026-09-29T21:04:11+08:00",
    selection,
    tags: ["判定链"],
  });
}

async function receive(env, envelope) {
  // 与 electron/main.cjs 同一条路径：桥把信封转交渲染层接收端并拿回执。
  const json = JSON.stringify(envelope);
  const outcome = await env.clip.receiveEnvelopeOutcome(json);
  return outcome;
}

/** `receiveEnvelopeOutcome()` 返回 HTTP 形状的 `{ok, status, result}`；回执在 `result` 里。 */
function receiptOf(outcome) {
  return outcome && outcome.result ? outcome.result : outcome;
}

test("判定链第 3/4 步在插件信封上真的生效（真接收端 + 真磁盘）", async (t) => {
  const env = await bootstrap();
  const trace = [];
  t.after(async () => {
    t.diagnostic(`判定链轨迹：\n${trace.join("\n")}`);
    try {
      await env.lib.closeWorkspace();
    } catch {
      /* ignore */
    }
    try {
      await env.server.close();
    } catch {
      /* ignore */
    }
  });
  const root = await freshWorkspace(env);
  const url = "https://example.com/judgment-chain";

  // ── 第一次剪藏（选区）：新笔记
  const first = pluginEnvelope({ url, body: "正文第一版。\n", selection: true, title: "判定链标题 1" });
  assert.ok(!("conflict" in first), "插件信封默认不得下发 conflict 键");
  const firstOutcome = await receive(env, first);
  const firstReceipt = receiptOf(firstOutcome);
  trace.push(`① 首次剪藏（selection:true，信封闭包键=${JSON.stringify(Object.keys(first))}）→ HTTP ${firstOutcome.status} status=${firstReceipt.status} path=${firstReceipt.path}`);
  assert.equal(firstOutcome.status, 201, `第一次剪藏应为 HTTP 201，实际 ${firstOutcome.status}`);
  assert.equal(firstReceipt.status, "created", `第一次剪藏应为 created，实际 ${JSON.stringify(firstReceipt)}`);
  const filesAfterFirst = fs.readdirSync(root).filter((name) => name.endsWith(".md"));
  assert.equal(filesAfterFirst.length, 1);

  // ── 第 3 步：同 URL + 正文变了 + selection:true → 追加到既有笔记（不是新建第二篇）
  const second = pluginEnvelope({ url, body: "正文第二版，追加内容。\n", selection: true, title: "判定链标题 2" });
  const secondOutcome = await receive(env, second);
  const secondReceipt = receiptOf(secondOutcome);
  trace.push(`② 选区二次剪藏（同 URL、正文变了、selection:true）→ HTTP ${secondOutcome.status} status=${secondReceipt.status} path=${secondReceipt.path}（期望第 3 步 appended）`);
  assert.equal(secondOutcome.status, 200, `第 3 步应为 HTTP 200，实际 ${secondOutcome.status}：${JSON.stringify(secondReceipt)}`);
  assert.equal(
    secondReceipt.status,
    "appended",
    `选区二次剪藏必须走判定链第 3 步 appended（若这里变成 created，说明信封里被塞了显式 conflict）`,
  );
  assert.equal(secondReceipt.path, firstReceipt.path, "追加必须落在同一篇笔记上");
  const filesAfterSecond = fs.readdirSync(root).filter((name) => name.endsWith(".md"));
  assert.equal(filesAfterSecond.length, 1, `不得新建第二篇：${filesAfterSecond.join(", ")}`);
  const appended = fs.readFileSync(path.join(root, firstReceipt.path), "utf8");
  assert.ok(appended.includes("正文第一版。"), "追加后必须保留原有正文");
  assert.ok(appended.includes("正文第二版，追加内容。"), "追加后必须包含新正文");

  // ── 第 4 步：同 URL + 正文变了 + selection:false（整页二次剪藏）→ 进收件箱，等人工确认
  const third = pluginEnvelope({ url, body: "整页第二版，进收件箱。\n", selection: false, title: "判定链标题 3" });
  const thirdOutcome = await receive(env, third);
  const thirdReceipt = receiptOf(thirdOutcome);
  trace.push(`③ 整页二次剪藏（同 URL、正文变了、selection:false）→ HTTP ${thirdOutcome.status} status=${thirdReceipt.status} inboxId=${thirdReceipt.inboxId}（期望第 4 步 pending）`);
  assert.equal(thirdOutcome.status, 202, `第 4 步应为 HTTP 202，实际 ${thirdOutcome.status}：${JSON.stringify(thirdReceipt)}`);
  assert.equal(
    thirdReceipt.status,
    "pending",
    `整页二次剪藏必须走判定链第 4 步 pending（若这里是 created，插件侧永远进不了收件箱）`,
  );
  assert.ok(thirdReceipt.inboxId, `pending 必须带非空 inboxId，实际 ${JSON.stringify(thirdReceipt.inboxId)}`);
  const filesAfterThird = fs.readdirSync(root).filter((name) => name.endsWith(".md"));
  assert.equal(filesAfterThird.length, 1, "进收件箱不得直接落成笔记文件");

  // ── 对照：显式下发 conflict:"new" 就会**破坏**这两步（证明缺省不是无关紧要的细节）
  const explicitFourth = pluginEnvelope({ url, body: "整页第三版，显式 new。\n", selection: false, title: "判定链标题 4" });
  explicitFourth.conflict = "new";
  const explicitOutcome = await receive(env, explicitFourth);
  const explicitReceipt = receiptOf(explicitOutcome);
  trace.push(`④ 对照组（同信封但显式 conflict:"new"）→ HTTP ${explicitOutcome.status} status=${explicitReceipt.status}（证明显式 new 正是 BLOCK-1 的病灶）`);
  assert.equal(
    explicitReceipt.status,
    "created",
    "对照组：显式 new 会退回「直接新建」，这正是 BLOCK-1 的病灶（因此插件默认不下发该键）",
  );
});
