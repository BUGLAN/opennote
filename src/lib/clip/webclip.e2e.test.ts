/**
 * 端到端（Lead 终检用的那条线）：**真桥** → **真渲染层接收端** → **真落盘**。
 *
 * 为什么非要有这个文件：`scripts/bridge-smoke.cjs` 的 ⑭ 段用的是**替身** `onEnvelope`
 * （断言信封形状逐字段正确），独立验证者的 `verify-e2e.cjs` S13 也是真桥 + 真 HTTP + 真磁盘、
 * 但 renderer 侧同样是替身。于是「**commit 交下来的信封，真接收端认不认**」这一环
 * 在两条门禁里都是**空白**（交接文档的 `T-04`：真机 Electron 从未跑过）。
 * 这里把这段空白填上：HTTP 请求进来 → 桥 → 真 `receiveEnvelopeOutcome()` → 内存磁盘。
 *
 * 判据盯的是**用户看得见的那条路径**：
 *   ① 落点选「收件箱」→ 收件箱条目真的在盘上，正文 = 页面里提交的那一份；
 *   ② 落点选「归档」→ `归档/<标题>.md` 真的在盘上，正文 = 页面里提交的那一份；
 *   ③ 落点填一个不存在的目录 → 明确 4xx，且**磁盘上没有被凭空造出那个目录**。
 * 不盯「我以为它在用的那个函数」。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "../../data/workspaces";
import { MemoryBackend } from "./testing/memoryBackend";

let testBackend: MemoryBackend;

vi.mock("../../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { openWorkspace } from "../../data/library";
import { INBOX_DIR, refreshInbox } from "../../data/inbox";
import { resetImportIndexCache } from "../../data/importLog";
import { receiveEnvelopeOutcome, resetImportChannelContext, resetImportLandingPreference, setImportChannelContext, setImportNotifications } from "./receive";

const requireCjs = createRequire(import.meta.url);

/** 需要用到的那部分桥控制面（真正的实现在 `electron/bridge.cjs`，这里不复制它）。 */
interface BridgeController {
  regenerateToken(): string;
  getSessionPlaintext(): string | null;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  getListeningPort(): number | null;
}
interface BridgeModule {
  createBridge(options: Record<string, unknown>): BridgeController;
}

const RECORD: WorkspaceRecord = { id: "test", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };
/** 扩展来源（`chrome-extension://<id>`）；桥按**类型**放行，不再有配对白名单。 */
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let bridge: BridgeController;
let token = "";
let port = 0;
let base = "";
let dataDir = "";
/** 每个用例一份新的正文，用来证明「落盘的就是页面上提交的那一份」。 */
let mark = "";

function url(path: string): string {
  return `${base}${path}`;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function stageOnce(title: string, body: string): Promise<{ stageId: string; k: string; openUrl: string }> {
  const response = await postJson(
    "/v1/clip/stage",
    {
      spec: "opennote.clip/v1",
      url: "https://example.com/posts/webclip",
      title,
      body,
      selection: false,
      tags: ["剪藏"],
      source: { site: "example.com", author: null, publishedAt: null },
      assets: [],
    },
    { Authorization: `Bearer ${token}` },
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { ok: boolean; stageId: string; openUrl: string };
  expect(payload.ok).toBe(true);
  // `openUrl` 由**接口**给：扩展不许自己拼端口或 stageId。这里把 k 从 URL 里取出来，
  // 与页面完全一样（页面也只从 URL 拿 k）。
  const parsed = new URL(payload.openUrl);
  expect(parsed.origin).toBe(base);
  return { stageId: payload.stageId, k: parsed.searchParams.get("k") ?? "", openUrl: payload.openUrl };
}

function inboxEntriesOnDisk(): string[] {
  return testBackend.paths().filter((path) => path === `${INBOX_DIR}` || path.startsWith(`${INBOX_DIR}/`));
}

/** 工作区里 `.opennote/` 之外的笔记。 */
function notesOnDisk(): string[] {
  return testBackend.paths().filter((path) => path.endsWith(".md") && !path.startsWith(".opennote/"));
}

beforeAll(async () => {
  const { createBridge } = requireCjs("../../../electron/bridge.cjs") as BridgeModule;
  dataDir = mkdtempSync(join(tmpdir(), "opennote-webclip-e2e-"));
  bridge = createBridge({
    dataDir,
    log: () => undefined,
    // 窗口在场：桥的生命周期跟随窗口，`getWindow()` 回 null 会一律 IMP-4006。
    getWindow: () => ({ id: 1 }),
    isEnabled: () => true,
    getWorkspaceInfo: () => ({ open: true, name: "临时笔记本" }),
    getFolders: () => ["归档", "剪藏/技术"],
    getInboxEnabled: () => true,
    /**
     * **这条就是被测的那一环**：桥把信封原样交回渲染层，渲染层跑**真**接收端
     * （与 `App.tsx:166-190` 的 `onImportReceipt` 处理逐字同构）。
     */
    onEnvelope: async (envelopeJson: string) => {
      setImportChannelContext({ channel: "local-bridge" });
      return await receiveEnvelopeOutcome(envelopeJson);
    },
  });
  bridge.regenerateToken();
  token = bridge.getSessionPlaintext() ?? "";
  expect(token).toMatch(/^opn_/);
  await bridge.start();
  port = bridge.getListeningPort() ?? 0;
  expect(port).toBeGreaterThan(0);
  base = `http://127.0.0.1:${port}`;
});

/*
 * 桥**每个文件起一次**，不是每个用例起一次：`beforeEach` 里 start/stop 会让端口在
 * 8787–8796 里反复回收复用，而 Node 的 `fetch` 连接池握着上一条已断的 keep-alive 连接
 * ⇒ 下一条用例的第一次请求随机 `ECONNRESET`（实测 6 个用例里红了 4 个，且**时好时坏**）。
 * 那不是产品缺陷，是夹具在自伤。stage 按 stageId 建键，用例之间不会串。
 */
beforeEach(async () => {
  testBackend = new MemoryBackend();
  resetImportIndexCache();
  resetImportChannelContext();
  resetImportLandingPreference();
  setImportNotifications(false);
  await openWorkspace(RECORD, { silent: true });
  await refreshInbox();
  mark = `页面里改过的正文-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  resetImportChannelContext();
  resetImportLandingPreference();
});

afterAll(async () => {
  await bridge.stop().catch(() => undefined);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("网页版剪藏页 · 真桥 → 真接收端 → 真落盘", () => {
  it("stage：令牌鉴权通过后 stageId 与 openUrl 都由接口给（扩展不拼 URL、不推端口）", async () => {
    const staged = await stageOnce("网页版剪藏标题", `正文：${mark}`);
    expect(staged.stageId.length).toBeGreaterThanOrEqual(32);
    expect(staged.k.length).toBeGreaterThanOrEqual(32);
    expect(staged.openUrl).toBe(`${base}/clip/${staged.stageId}?k=${staged.k}`);

    // 没有令牌 / 令牌不对：一律拒绝，绝不放行。
    const anonymous = await postJson("/v1/clip/stage", { spec: "opennote.clip/v1", url: "https://e.com", title: "t", body: "b" });
    expect(anonymous.status).toBe(401);
    const wrongToken = await postJson(
      "/v1/clip/stage",
      { spec: "opennote.clip/v1", url: "https://e.com", title: "t", body: "b" },
      { Authorization: "Bearer opn_0000000000000000000000000000000000000000000" },
    );
    expect(wrongToken.status).toBe(401);
  });

  it("页面：`GET /clip/<stageId>?k=` 回产物原文 + clip-boot JSON 数据块 + 严格 CSP（没构建则如实 503）", async () => {
    const staged = await stageOnce("网页版剪藏标题", `正文：${mark}`);
    const response = await fetch(staged.openUrl);
    const html = await response.text();

    if (existsSync("dist-clip/clip/index.html")) {
      expect(response.status).toBe(200);
      expect(html).toContain('id="clip-boot"');
      const boot = /<script type="application\/json" id="clip-boot">([\s\S]*?)<\/script>/.exec(html);
      expect(boot, `页面里没有 clip-boot 数据块：${html.slice(0, 200)}`).not.toBeNull();
      expect(JSON.parse(boot![1])).toEqual({ port, stageId: staged.stageId, k: staged.k });
      // 数据块不是可执行脚本 ⇒ `script-src` 不需要 `unsafe-inline`（用注入换安全边界是不划算的）。
      // 断言要**按指令**看，不能对整条 CSP 做 `includes` —— `style-src` 里的
      // `'unsafe-inline'` 是有意的（页面样式），对整串做否定断言会在产品正确时假红
      // （我第一次就是这么写的，被这条用例自己抓出来了）。
      const csp = response.headers.get("content-security-policy") ?? "";
      const directives = new Map(
        csp
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const [name, ...rest] = part.split(/\s+/);
            return [name, rest.join(" ")];
          }),
      );
      expect(directives.get("script-src")).toBe("'self'");
      expect(directives.get("default-src")).toBe("'self'");
      expect(directives.get("object-src")).toBe("'none'");
      // 页面里不许有内联可执行脚本（否则 CSP 会把它挡掉，用户看到白屏）。
      expect(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>[\s\S]*?<\/script>/i.test(html)).toBe(false);
    } else {
      // 没跑 `pnpm build:clip` 的分支也必须**如实失败**，绝不回一个空 200。
      expect(response.status).toBe(503);
      expect(html).toContain("IMP-5003");
    }

    // k 不对 / stage 不存在：都要能分辨（页面要能如实说「链接过期了」还是「链接不对」）。
    const wrongKey = await fetch(`${base}/clip/${staged.stageId}?k=${"x".repeat(staged.k.length)}`);
    expect(wrongKey.status).toBe(401);
    const missingStage = await fetch(`${base}/clip/${"y".repeat(staged.stageId.length)}?k=${staged.k}`);
    expect(missingStage.status).toBe(404);
  });

  it("落点候选：`folders[0] === \"\"`（收件箱）+ 去重，且页面拿得到", async () => {
    const staged = await stageOnce("网页版剪藏标题", `正文：${mark}`);
    const response = await fetch(url(`/v1/clip/folders?stageId=${staged.stageId}&k=${staged.k}`));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; folders: string[] };
    expect(payload.folders[0]).toBe("");
    expect(payload.folders).toEqual(["", "剪藏/技术", "归档"]);
  });

  it("落点 = 收件箱：条目真的在盘上，正文就是**页面提交的那一份**（不是抽取原文）", async () => {
    const staged = await stageOnce("网页版剪藏标题", `正文：${mark}`);
    const response = await postJson("/v1/clip/commit", {
      stageId: staged.stageId,
      k: staged.k,
      title: "网页版剪藏标题",
      body: `正文：${mark}`,
      folder: "",
    });
    expect([200, 201, 202]).toContain(response.status);
    const receipt = (await response.json()) as { ok: boolean; result?: { status?: string }; status?: string };
    expect(receipt.ok).toBe(true);

    // 收件箱条目的 `body.md` 必须是页面上那一份（「先编辑、确认后再入库」的全部意义所在）。
    const bodies = inboxEntriesOnDisk().filter((path) => path.endsWith("/body.md"));
    expect(bodies.length, `收件箱条目没落盘：${inboxEntriesOnDisk().join(", ")}`).toBe(1);
    expect(testBackend.text(bodies[0])).toContain(mark);
  });

  it("落点 = 已有目录：`归档/<标题>.md` 真的落盘，正文是页面提交的那一份", async () => {
    const staged = await stageOnce("网页版剪藏标题", `正文：${mark}`);
    const response = await postJson("/v1/clip/commit", {
      stageId: staged.stageId,
      k: staged.k,
      title: "网页版剪藏标题",
      body: `正文：${mark}`,
      folder: "归档",
    });
    expect(response.status).toBe(201);
    expect(notesOnDisk()).toContain("归档/网页版剪藏标题.md");
    expect(testBackend.text("归档/网页版剪藏标题.md")).toContain(mark);
    // 走的是真接收端 ⇒ front-matter 也真的写了（替身断言看不到这一层）。
    expect(testBackend.text("归档/网页版剪藏标题.md")).toContain("source:");
  });

  it("落点 = 不存在的目录：明确 4xx，且**磁盘上没有被凭空造出那个目录**", async () => {
    const staged = await stageOnce("网页版剪藏标题", `正文：${mark}`);
    const response = await postJson("/v1/clip/commit", {
      stageId: staged.stageId,
      k: staged.k,
      title: "网页版剪藏标题",
      body: `正文：${mark}`,
      folder: "我瞎写的目录",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(testBackend.paths().some((path) => path.startsWith("我瞎写的目录"))).toBe(false);
    expect(notesOnDisk()).toEqual([]);
  });
});
