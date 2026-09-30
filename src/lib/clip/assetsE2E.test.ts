/**
 * 端到端（可复跑）：带 `assets[]` 的信封 → **收件箱**（资产在 `entry/assets/`）→ `commitInboxResult` 到 `{folder}`
 * → 笔记与 `<笔记名>.assets/` 都在最终目录、正文相对引用指得对、源目录无残留。
 *
 * 这个文件**不 mock 收件箱**（用 `src/data/inbox.ts` 的真模块 + 真 `commitInboxResult`），
 * 只 mock 工作区后端（内存盘）——它跑的就是用户点「确认入库」时的那条路：
 *
 *   receiveEnvelopeOutcome(local-bridge, 默认落点偏好 = 收件箱)
 *     → enqueueInbox（c2：entry.json + body.md + assets/）
 *       → commitInboxResult(id, { folder })（c2：把条目交回接收端）
 *         → receiveEnvelope(channel="inbox")（c1：写笔记 + 写 <笔记名>.assets/ + 改写正文引用）
 *
 * 断言写成**命名无关的不变量**：`join(笔记所在目录, 正文里的引用)` 恰好等于磁盘上的资产文件。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "./testing/memoryBackend";
import type { WorkspaceRecord } from "../../data/workspaces";

let testBackend: MemoryBackend;

vi.mock("../../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { openWorkspace } from "../../data/library";
import { commitInboxResult, discardInbox, refreshInbox, INBOX_DIR } from "../../data/inbox";
import { resetImportIndexCache } from "../../data/importLog";
import { encodeBase64 } from "./envelope";
import { receiveEnvelope, resetImportChannelContext, resetImportLandingPreference, setImportChannelContext, setImportNotifications } from "./receive";

const RECORD: WorkspaceRecord = { id: "test", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };
const CAPTURED = "2026-09-29T21:04:11+08:00";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x02]);

/** 每个用例一个**新的** importId：收件箱模块的缓存是按 id 建键的（同一 id 会命中上一条）。 */
let seq = 0;
function nextId(): string {
  seq += 1;
  return `0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e${String(seq).padStart(2, "0")}`;
}

function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    spec: "opennote.import/v1",
    importId: nextId(),
    title: "带图的剪藏",
    body: "看图：\n\n![图](./assets/diagram.png)\n\n![动图](./assets/anim.gif)\n",
    target: { folder: null, notePath: null },
    tags: ["剪藏"],
    client: { name: "cli", version: "0.3.0" },
    ...overrides,
    source: { url: "https://example.com/posts/local-first", site: "example.com", capturedAt: CAPTURED, ...((overrides.source as object) ?? {}) },
    assets: (overrides.assets as unknown[] | undefined) ?? [
      { name: "diagram.png", mime: "image/png", dataBase64: encodeBase64(PNG) },
      { name: "anim.gif", mime: "image/gif", dataBase64: encodeBase64(GIF) },
    ],
  });
}

/** 与 Markdown 查看器同构：`join(笔记所在目录, ref)`。 */
function resolveRef(notePath: string, ref: string): string {
  const segments = notePath.split("/").slice(0, -1);
  for (const segment of ref.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function imageRefs(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim());
}

/** 工作区里的笔记（`.opennote/` 之外）。 */
function notes(): string[] {
  return testBackend.paths().filter((path) => path.endsWith(".md") && !path.startsWith(".opennote/"));
}

/** 工作区里 `.opennote/` 之外的资产文件。 */
function assetsOutsideMeta(): string[] {
  return testBackend.paths().filter((path) => !path.endsWith(".md") && !path.startsWith(".opennote/"));
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  seq = 0;
  resetImportIndexCache();
  resetImportChannelContext();
  resetImportLandingPreference();
  setImportNotifications(false);
  await openWorkspace(RECORD, { silent: true });
  // 收件箱模块有一份**模块级缓存**（`details`）：换了后端必须重新同步，否则会拿上一条用例的条目。
  await refreshInbox();
});

describe("端到端 · 收件箱入库带着图片一起走", () => {
  it("信封 → 收件箱（资产在 entry/assets/）→ commitInboxResult({folder}) → 笔记与 .assets/ 都在最终目录", async () => {
    setImportChannelContext({ channel: "local-bridge" });
    const pending = await receiveEnvelope(raw());
    expect(pending.status).toBe("pending");
    expect(pending.path).toBeNull();
    const inboxId = pending.inboxId!;
    expect(inboxId).toBeTruthy();

    // ① 待确认期间：正文与资产都在**条目自己**的目录里（`entry/assets/`）。
    const entryDir = `${INBOX_DIR}/${inboxId}`;
    const staged = testBackend.paths().filter((path) => path.startsWith(`${entryDir}/assets/`));
    expect(staged).toHaveLength(2);
    expect(testBackend.files.has(`${entryDir}/body.md`)).toBe(true);
    expect(testBackend.text(`${entryDir}/body.md`)).toContain("assets/diagram.png");
    // 磁盘上还没有任何笔记/资产落点（确认之前不写正文）。
    expect(notes()).toEqual([]);
    expect(assetsOutsideMeta()).toEqual([]);

    // ② 确认入库到「归档」。
    const result = await commitInboxResult(inboxId, { folder: "归档" });
    expect(result?.status).toBe("created");
    expect(result?.path).toBe("归档/带图的剪藏.md");

    // ③ 笔记与附件目录**都在最终目录**。
    const notePath = result!.path!;
    const text = testBackend.text(notePath)!;
    expect(text.startsWith("---\n")).toBe(true);
    const refs = imageRefs(text);
    expect(refs).toHaveLength(2);
    // 每条引用都指向**笔记同级**的 `<笔记名>.assets/`（不是公共 `assets/`）。
    for (const ref of refs) expect(ref, `引用应该指向 带图的剪藏.assets/：${ref}`).toMatch(/^带图的剪藏\.assets\/[^/]+$/);
    const resolved = refs.map((ref) => resolveRef(notePath, ref)).sort();
    for (const path of resolved) {
      expect(testBackend.files.has(path), `资产应该在最终目录里：${path}`).toBe(true);
      expect(path.startsWith("归档/带图的剪藏.assets/")).toBe(true);
    }
    // 图片内容逐字节保真。
    expect([...testBackend.bytes(resolved.find((path) => path.endsWith(".png"))!)!]).toEqual([...PNG]);
    expect([...testBackend.bytes(resolved.find((path) => path.endsWith(".gif"))!)!]).toEqual([...GIF]);

    // ④ 源目录无残留：工作区根目录没有同名笔记/附件目录（没有「先落盘再搬」的中间态）。
    expect(notes()).toEqual([notePath]);
    expect(testBackend.paths().some((path) => path.startsWith("带图的剪藏.assets/"))).toBe(false);
    expect(await testBackend.exists("带图的剪藏.md")).toBe(false);
  });

  it("重复确认是幂等的：第二次返回 null，不产生第二篇笔记、不产生 `-2` 资产", async () => {
    setImportChannelContext({ channel: "local-bridge" });
    const pending = await receiveEnvelope(raw());
    const inboxId = pending.inboxId!;
    const first = await commitInboxResult(inboxId, { folder: "归档" });
    expect(first?.status).toBe("created");
    const snapshot = testBackend.paths().slice().sort();

    const second = await commitInboxResult(inboxId, { folder: "归档" });
    expect(second).toBeNull();
    expect(testBackend.paths().slice().sort()).toEqual(snapshot);
  });

  it("条目 discarded 后：条目目录（含 entry/assets/）整棵消失，工作区不留孤儿", async () => {
    setImportChannelContext({ channel: "local-bridge" });
    const pending = await receiveEnvelope(raw());
    const inboxId = pending.inboxId!;
    const entryDir = `${INBOX_DIR}/${inboxId}`;
    expect(testBackend.paths().some((path) => path.startsWith(`${entryDir}/assets/`))).toBe(true);

    await discardInbox(inboxId);

    expect(await testBackend.exists(entryDir)).toBe(false);
    expect(testBackend.paths().some((path) => path.startsWith(entryDir))).toBe(false);
    expect(notes()).toEqual([]);
    expect(assetsOutsideMeta()).toEqual([]);
  });

  it("保留期清理：committed 条目（含它的 assets/）24 小时后被删，不留孤儿副本", async () => {
    setImportChannelContext({ channel: "local-bridge" });
    const pending = await receiveEnvelope(raw());
    const inboxId = pending.inboxId!;
    const entryDir = `${INBOX_DIR}/${inboxId}`;
    await commitInboxResult(inboxId, { folder: "归档" });

    const { cleanupInbox, INBOX_COMMITTED_TTL_MS } = await import("../../data/inbox");
    const removed = await cleanupInbox(Date.now() + INBOX_COMMITTED_TTL_MS + 1000);
    expect(removed).toBe(1);
    expect(testBackend.paths().some((path) => path.startsWith(entryDir))).toBe(false);
    // 最终落点的图**不受**清理影响。
    expect(testBackend.paths().some((path) => path.startsWith("归档/带图的剪藏.assets/"))).toBe(true);
  });
});

/**
 * Lead 裁定②：**统一到 `<笔记名>.assets/`，但不迁移旧数据** ——
 * 老笔记的图留在公共 `<目录>/assets/` 里，正文照旧引用 `./assets/x.png`，**照样能读**。
 *
 * 这一组守的就是这条承诺最容易被违反的方式：**新路径顺手把公共目录也改了 / 迁移了 / 清掉了**。
 */
describe("端到端 · 不迁移旧数据（老笔记 + 公共 assets/ 必须一个字节不动）", () => {
  const LEGACY_NOTE = "归档/老笔记.md";
  const LEGACY_IMAGE = "归档/assets/old.png";
  const LEGACY_BODY = "# 老笔记\n\n编辑器早年贴的图：\n\n![老图](./assets/old.png)\n";
  const LEGACY_BYTES = new TextEncoder().encode("编辑器早年贴的图，逐字节不许动");

  /** 夹具：一篇「老世界」的笔记 —— 图在公共 `归档/assets/`，正文按老写法引用，索引里没有它。 */
  function seedLegacy(): void {
    testBackend.seed(LEGACY_NOTE, LEGACY_BODY);
    testBackend.seedBytes(LEGACY_IMAGE, LEGACY_BYTES);
  }

  /** 老数据没被动过的三条硬断言。 */
  function expectLegacyUntouched(): void {
    expect(testBackend.text(LEGACY_NOTE), "老笔记正文被改动了").toBe(LEGACY_BODY);
    expect(testBackend.bytes(LEGACY_IMAGE), "老图的字节被改动了").toEqual(LEGACY_BYTES);
    // 公共目录里既没多出文件（没往里塞新图），也没少掉文件（没被清理/迁移）。
    expect(testBackend.paths().filter((path) => path.startsWith("归档/assets/"))).toEqual([LEGACY_IMAGE]);
    // 老引用仍然指得到那张图。
    expect(testBackend.files.has(resolveRef(LEGACY_NOTE, "./assets/old.png"))).toBe(true);
  }

  it("收件箱入库到已有老数据的目录：老笔记/老图逐字节不动，新图只进 `<笔记名>.assets/`", async () => {
    seedLegacy();
    setImportChannelContext({ channel: "local-bridge" });
    const pending = await receiveEnvelope(raw());
    const result = await commitInboxResult(pending.inboxId!, { folder: "归档" });
    expect(result?.status).toBe("created");
    expect(result?.path).toBe("归档/带图的剪藏.md");

    expectLegacyUntouched();
    // 新图只进新笔记自己的目录，公共 `assets/` 一个字节都没被写过。
    const refs = imageRefs(testBackend.text(result!.path!)!);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      const path = resolveRef(result!.path!, ref);
      expect(path.startsWith("归档/带图的剪藏.assets/")).toBe(true);
      expect(testBackend.files.has(path)).toBe(true);
    }
    expect(assetsOutsideMeta().filter((path) => path.startsWith("归档/assets/"))).toEqual([LEGACY_IMAGE]);
  });

  it("直接落盘（不经收件箱）到同一目录：老数据同样一个字节不动", async () => {
    seedLegacy();
    const receipt = await receiveEnvelope(
      JSON.stringify({
        spec: "opennote.import/v1",
        importId: nextId(),
        title: "直接剪藏",
        body: "看图：\n\n![图](./assets/diagram.png)\n",
        target: { folder: "归档", notePath: null },
        source: { url: "https://example.com/direct", site: "example.com", capturedAt: CAPTURED },
        assets: [{ name: "diagram.png", mime: "image/png", dataBase64: encodeBase64(PNG) }],
      }),
    );
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("归档/直接剪藏.md");
    expect(receipt.assets[0].startsWith("归档/直接剪藏.assets/")).toBe(true);

    expectLegacyUntouched();
    const ref = imageRefs(testBackend.text(receipt.path!)!)[0];
    expect(resolveRef(receipt.path!, ref)).toBe(receipt.assets[0]);
  });
});
