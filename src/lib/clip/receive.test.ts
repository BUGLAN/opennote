import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitFrontMatter } from "../utils";
import { MemoryBackend } from "./testing/memoryBackend";
import type { WorkspaceRecord } from "../../data/workspaces";

let testBackend: MemoryBackend;

vi.mock("../../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

const inboxCalls = vi.hoisted(() => [] as { json: string; meta: Record<string, unknown> }[]);
/** 让某个用例注入 `enqueueInbox` 的失败（域错误对象 / 普通 Error）。 */
const inboxState = vi.hoisted(() => ({
  failWith: null as unknown,
  /** 收件箱里的条目（id = 完整 importId）。复刻 C2 的 `enqueueInbox` 幂等语义。 */
  entries: [] as { id: string; status: string; tags: string[] }[],
}));

/** 复刻 `src/data/inbox.ts` 的目录名规则（§5.8.2）：`<UTC YYYYMMDDTHHMMSS>-<importId 前 8 位>`。 */
const inboxDirName = (importId: string): string =>
  `20260929T131011-${importId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8)}`;

/** 复刻 `InboxError` 的形状：**不是** `ImportRejection`，`name` 也不是它（第三次同类缝的现场）。 */
function inboxError(code: string, userMessage: string, message = userMessage): Error {
  const error = new Error(message);
  error.name = "InboxError";
  return Object.assign(error, { code, userMessage });
}

vi.mock("../../data/inbox", () => ({
  // `InboxEntry.id` = 条目身份（完整 importId）；`dirName` 只在磁盘侧的视图里（InboxDetail）。
  // `enqueueInbox` 的两条真实语义必须复刻：① 同 importId 已有条目 → **返回既有条目**（幂等，
  // 不产生第二条）；② 查不到时 `readInboxDetail` 抛 `IMP-4017`（§6.13㉔，不能靠 dirName 兜底）。
  enqueueInbox: async (json: string, meta: Record<string, unknown>) => {
    if (inboxState.failWith) throw inboxState.failWith;
    inboxCalls.push({ json, meta });
    const parsed = JSON.parse(json) as { importId: string; tags?: string[] };
    const existing = inboxState.entries.find((entry) => entry.id === parsed.importId);
    if (existing) return { ...existing };
    const created = { id: parsed.importId, status: "pending", tags: Array.isArray(parsed.tags) ? parsed.tags : [] };
    inboxState.entries.push(created);
    return { ...created };
  },
  readInboxDetail: async (id: string) => {
    const entry = inboxState.entries.find((item) => item.id === id);
    if (!entry) throw inboxError("IMP-4017", "没有找到这条导入记录。");
    return { entry: { ...entry }, dirName: inboxDirName(entry.id) };
  },
}));

import { closeWorkspace, openWorkspace, updateNoteContent } from "../../data/library";
import { resetImportIndexCache } from "../../data/importLog";
import { toastStore } from "../toast";
import type { ImportResult } from "../../desktop/bridge";
import { encodeBase64, IMPORT_ERRORS, ImportRejection, importProblem } from "./envelope";
import { DUPLICATE_MESSAGE, getImportLandingPreference, receiveEnvelope, receiveEnvelopeOutcome, resetImportChannelContext, resetImportLandingPreference, setImportChannelContext, setImportConflictResolver, setImportLandingPreference, setImportNotifications, setRemoteImageSource, undoImport, type ImportLandingPreference, type ImportReceipt } from "./receive";

const RECORD: WorkspaceRecord = {
  id: "test",
  name: "临时笔记本",
  kind: "node",
  location: "unused",
  addedAt: 1,
  lastOpenedAt: 1,
};

const ID1 = "0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e88";
const ID2 = "1a2b3c4d-5e6f-4a7e-9d31-5b0f2a7c1e99";
const ID3 = "2b3c4d5e-6f70-4a7e-9d31-5b0f2a7c1eaa";
const URL_A = "https://example.com/posts/local-first";
const CAPTURED = "2026-09-29T21:04:11+08:00";

function raw(overrides: Record<string, unknown> = {}): string {
  const source = {
    url: URL_A,
    title: "Local-first notes for engineers",
    site: "example.com",
    author: "张三",
    publishedAt: "2026-08-14T09:30:00+08:00",
    capturedAt: CAPTURED,
    selection: false,
    ...((overrides.source as Record<string, unknown> | undefined) ?? {}),
  };
  const envelope: Record<string, unknown> = {
    spec: "opennote.import/v1",
    importId: ID1,
    title: "测试标题",
    body: "第一段",
    target: { folder: null, notePath: null },
    // 真实客户端常常不带 conflict：缺省 = 走判定链第 3/4 步（绝不能当成显式 new）。
    conflict: undefined,
    tags: ["剪藏"],
    assets: [],
    client: { name: "cli", version: "0.3.0" },
    ...overrides,
  };
  envelope.source = source;
  return JSON.stringify(envelope);
}

function notePaths(): string[] {
  return testBackend.paths().filter((path) => path.endsWith(".md") && !path.startsWith(".opennote/"));
}

/**
 * 「图片跟笔记走」的**命名无关**不变量：像 Markdown 查看器那样解析正文里的相对引用，
 * `join(笔记所在目录, ref)` 必须**恰好等于**磁盘上的资产路径（`join` 用测试自己写的一版，
 * 不借生产代码，免得两处同时错还互相印证）。
 */
function resolveRef(notePath: string, ref: string): string {
  const segments = notePath.split("/").slice(0, -1);
  for (const segment of ref.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** 正文里的图片引用（`![alt](ref)` 的 `ref`），用来做上面那条不变量。 */

beforeEach(async () => {
  testBackend = new MemoryBackend();
  resetImportIndexCache();
  resetImportChannelContext();
  resetImportLandingPreference();
  setImportConflictResolver(null);
  setImportNotifications(false);
  // ③ 远程配图兜底下载：默认**没装**（web / CLI / 单测）——每个用例自己装。
  setRemoteImageSource(null);
  inboxCalls.length = 0;
  inboxState.failWith = null;
  inboxState.entries.length = 0;
  await openWorkspace(RECORD, { silent: true });
});

describe("L2 接收端 · 新建落盘（契约 §3）", () => {
  it("落点 = folder + sanitizeName(title).md，目录逐段创建，正文以 # 标题 开头", async () => {
    const receipt = await receiveEnvelope(raw({ target: { folder: "剪藏/技术", notePath: null } }));
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("剪藏/技术/测试标题.md");
    expect(receipt.deduped).toBe(false);
    expect(receipt.dedupedBy).toBeNull();
    expect(receipt.revertible).toBe(true);
    expect(receipt.preimage).toBeNull();
    expect(receipt.assets).toEqual([]);
    expect(receipt.tags).toEqual(["剪藏"]);
    expect(receipt.warnings).toEqual([]);
    expect(receipt.inboxId).toBeNull();
    expect(receipt.message).toBe("已从网页剪藏：测试标题。");

    const text = testBackend.text("剪藏/技术/测试标题.md");
    expect(text).not.toBeNull();
    expect(text!.startsWith("---\n")).toBe(true);
    expect(text).toContain("\n---\n\n# 测试标题\n\n第一段\n");
    expect(text!.endsWith("\n")).toBe(true);
    expect(text!.includes("\r")).toBe(false);
  });

  it("落点默认是工作区根目录（不存在「收件箱」落点目录）", async () => {
    const receipt = await receiveEnvelope(raw({ target: undefined }));
    expect(receipt.path).toBe("测试标题.md");
  });

  it("同名文件已存在于磁盘但不在内存 → 仍产出「标题 2.md」（D03 回归）", async () => {
    testBackend.seed("测试标题.md", "# 外来的同名文件\n");
    const receipt = await receiveEnvelope(raw());
    expect(receipt.path).toBe("测试标题 2.md");
    expect(testBackend.text("测试标题.md")).toContain("外来的同名文件");
    // 必须真的探测过磁盘，不能只看内存。
    expect(testBackend.calls).toContain("exists:测试标题.md");
  });

  it("再导一次（同名不同 importId、不同 URL）→ 标题 3.md", async () => {
    testBackend.seed("测试标题.md", "# 一\n");
    testBackend.seed("测试标题 2.md", "# 二\n");
    const receipt = await receiveEnvelope(raw({ importId: ID2, source: { url: "https://other.test/x", capturedAt: CAPTURED } }));
    expect(receipt.path).toBe("测试标题 3.md");
  });

  it("title 里的非法字符走 sanitizeName 语义；全非法 → 未命名.md", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, title: "a/b:c*d" }));
    expect(a.path).toBe("a b c d.md");
    const b = await receiveEnvelope(
      raw({ importId: ID2, title: "***", body: "另一段", source: { url: "https://other.test/x", capturedAt: CAPTURED } }),
    );
    expect(b.path).toBe("未命名.md");
  });

  it("tags 过滤后的集合写进 front-matter 的 tags: [a, b]", async () => {
    const receipt = await receiveEnvelope(raw({ tags: ["剪藏", "123", "a,b", "本地优先！"] }));
    expect(receipt.tags).toEqual(["剪藏", "本地优先"]);
    expect(receipt.warnings).toContain("IMP-W007 部分标签不符合规则，已忽略。");
    expect(testBackend.text(receipt.path!)).toContain("tags: [剪藏, 本地优先]");
  });
});

describe("L2 接收端 · 幂等与去重判定链（契约 §4.1）", () => {
  it("同 importId → deduped：完全不写盘、返回首次落点、静默", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1 }));
    const bytes = testBackend.bytes(first.path!)!;
    const log = testBackend.text(".opennote/import-log.json");
    const index = testBackend.text(".opennote/import-index.json");

    const second = await receiveEnvelope(raw({ importId: ID1, title: "换了个标题" }));
    expect(second.status).toBe("deduped");
    expect(second.path).toBe(first.path);
    expect(second.deduped).toBe(true);
    expect(second.dedupedBy).toBe("importId");
    expect(second.message).toBe("");
    expect(second.revertible).toBe(true);
    // 再次投递没有产生任何字节变化。
    expect(testBackend.bytes(first.path!)).toEqual(bytes);
    expect(testBackend.text(".opennote/import-log.json")).toBe(log);
    expect(testBackend.text(".opennote/import-index.json")).toBe(index);
    expect(notePaths()).toHaveLength(1);
  });

  it("同 URL 且正文哈希相同 → duplicate：不追加、不写盘，文案逐字", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "同一段" }));
    const bytes = testBackend.bytes(first.path!)!;
    const second = await receiveEnvelope(raw({ importId: ID2, body: "同一段" }));
    expect(second.status).toBe("duplicate");
    expect(second.path).toBe(first.path);
    expect(second.deduped).toBe(true);
    expect(second.dedupedBy).toBe("contentHash");
    expect(second.message).toBe("已在笔记中（未重复入库）。");
    expect(DUPLICATE_MESSAGE).toBe("已在笔记中（未重复入库）。");
    expect(testBackend.bytes(first.path!)).toEqual(bytes);
    expect(notePaths()).toHaveLength(1);
    // 进导入日志，可事后追溯（00 号 §6.12①）。
    const log = JSON.parse(testBackend.text(".opennote/import-log.json")!) as { entries: { importId: string; op: string }[] };
    expect(log.entries.some((entry) => entry.importId === ID2 && entry.op === "duplicate")).toBe(true);
  });

  it("URL 都是 null 且正文相同 → duplicate（不产生副本）", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "同一段", source: { url: null, capturedAt: CAPTURED } }));
    const second = await receiveEnvelope(raw({ importId: ID2, body: "同一段", source: { url: null, capturedAt: CAPTURED } }));
    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicate");
    expect(notePaths()).toHaveLength(1);
  });

  it("URL 都是 null、正文不同 → 第 6 步新建（null 不是可追加的来源）", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段", source: { url: null, capturedAt: CAPTURED } }));
    const second = await receiveEnvelope(
      raw({ importId: ID2, body: "第二段", source: { url: null, capturedAt: CAPTURED, selection: true } }),
    );
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(second.path).not.toBe(first.path);
    expect(notePaths()).toHaveLength(2);
  });

  it("同 URL 不同内容 + selection=true → appended（带分隔线与时间戳，留前像）", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const before = testBackend.bytes(first.path!)!;
    const second = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));

    expect(second.status).toBe("appended");
    expect(second.path).toBe(first.path);
    expect(second.revertible).toBe(true);
    expect(second.undoSeconds).toBe(10);
    expect(second.preimage).toEqual({
      path: `.opennote/import-preimages/${ID2}.md`,
      bytes: before.byteLength,
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{16}$/) as unknown as string,
    });
    // 前像**不在** .opennote/history/ 之下（00 号 §6.10①）。
    expect(second.preimage!.path.startsWith(".opennote/history/")).toBe(false);
    expect(testBackend.bytes(second.preimage!.path)).toEqual(before);

    const text = testBackend.text(first.path!)!;
    expect(text).toContain("第一段");
    expect(text).toContain("第二段");
    expect(text).toContain("\n\n---\n\n> 再次剪藏于 ");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("同 URL 不同内容 + selection 缺省 → pending（进收件箱，不写正文）", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const second = await receiveEnvelope(raw({ importId: ID2, body: "整页改版后" }));
    expect(second.status).toBe("pending");
    expect(second.path).toBeNull();
    // D-V04：`inboxId` 必须是**收件箱目录名**（`<UTC 时间戳>-<importId 前 8 位>`），
    // 不是 `InboxEntry.id`（完整 importId）—— 客户端只能拿目录名去拼路径。
    expect(second.inboxId).toMatch(/^\d{8}T\d{6}-.{8}$/);
    expect(second.inboxId).not.toBe(ID2);
    expect(second.inboxId).not.toBe(second.importId);
    expect(second.inboxId!.endsWith(ID2.slice(0, 8))).toBe(true);
    expect(second.inboxId).toBe(inboxDirName(ID2));
    expect(second.deduped).toBe(false);
    expect(second.dedupedBy).toBeNull();
    expect(notePaths()).toEqual([first.path]);
    // 投递的 queue json 必须自带正文（收件箱重启后还能读回来）。
    expect(inboxCalls).toHaveLength(1);
    expect(JSON.parse(inboxCalls[0].json)).toMatchObject({ importId: ID2, body: "整页改版后" });
    expect(inboxCalls[0].meta.bodyHash).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("收件箱拿不到目录名时如实报 IMP-4014，绝不拿条目 id 冒充（D-V04 反例）", async () => {
    const inboxModule = (await import("../../data/inbox")) as { readInboxDetail?: unknown };
    const original = inboxModule.readInboxDetail;
    // 模拟「磁盘视图读不到」：不抛、返回 null。回执不允许退化成完整 importId。
    (inboxModule as { readInboxDetail: unknown }).readInboxDetail = async () => null;
    try {
      await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
      await expect(receiveEnvelope(raw({ importId: ID2, body: "第二段" }))).rejects.toMatchObject({
        code: "IMP-4014",
        http: 500,
      });
    } finally {
      (inboxModule as { readInboxDetail: unknown }).readInboxDetail = original;
    }
  });

  it("仅正文哈希相同、URL 不同 → 两条独立笔记", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "同一段", source: { url: "https://a.test/x", capturedAt: CAPTURED } }));
    const b = await receiveEnvelope(raw({ importId: ID2, body: "同一段", source: { url: "https://b.test/x", capturedAt: CAPTURED } }));
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(a.path).not.toBe(b.path);
    expect(notePaths()).toHaveLength(2);
  });

  it("显式 conflict=new 覆盖第 3/4 步：同 URL 也新开一份", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "new" }));
    expect(b.status).toBe("created");
    expect(b.path).toBe("测试标题 2.md");
    expect(testBackend.text(a.path!)).not.toContain("第二段");
  });

  it("显式 conflict=append 覆盖第 4 步：整页也强制追加", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "append" }));
    expect(b.status).toBe("appended");
    expect(b.path).toBe(a.path);
  });

  it("conflict=skip 命中既有笔记 → skipped、静默、一个字都不写", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const before = testBackend.bytes(a.path!)!;
    const log = testBackend.text(".opennote/import-log.json");
    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "skip" }));
    expect(b.status).toBe("skipped");
    expect(b.warnings).toEqual([]);
    expect(b.path).toBe(a.path);
    expect(testBackend.bytes(a.path!)).toEqual(before);
    expect(testBackend.text(".opennote/import-log.json")).toBe(log);
    expect(notePaths()).toHaveLength(1);
  });

  it("conflict=skip 但没有既有笔记 → 正常新建", async () => {
    const receipt = await receiveEnvelope(raw({ importId: ID1, conflict: "skip" }));
    expect(receipt.status).toBe("created");
  });

  it("target.notePath 指向不存在的文件 + append → IMP-4009", async () => {
    await expect(
      receiveEnvelope(raw({ conflict: "append", target: { folder: null, notePath: "没有这篇.md" } })),
    ).rejects.toMatchObject({ code: "IMP-4009", http: 404 });
  });

  it("append 找不到任何目标 → 新建 + IMP-W003", async () => {
    const receipt = await receiveEnvelope(raw({ conflict: "append" }));
    expect(receipt.status).toBe("created");
    expect(receipt.warnings).toContain("IMP-W003 没找到要追加的笔记，已新建一篇。");
  });

  it("target.notePath 直接指定既有笔记 → 追加到它（不依赖来源索引）", async () => {
    testBackend.seed("别的目录/已有笔记.md", "# 已有笔记\n\n原有内容\n");
    await openWorkspace(RECORD, { silent: true });
    const receipt = await receiveEnvelope(
      raw({ importId: ID1, conflict: "append", target: { folder: null, notePath: "别的目录/已有笔记.md" } }),
    );
    expect(receipt.status).toBe("appended");
    expect(receipt.path).toBe("别的目录/已有笔记.md");
    const text = testBackend.text("别的目录/已有笔记.md")!;
    expect(text).toContain("原有内容");
    expect(text).toContain("第一段");
  });

  it("索引缺失时用 front-matter 的 opennote_import_id 降级判定（§4.3.3）", async () => {
    testBackend.seed(
      "已入库.md",
      `---\nsource: ${URL_A}\ncaptured_at: ${CAPTURED}\ntags: [剪藏]\nopennote_import_id: ${ID1}\n---\n\n# 已入库\n\n第一段\n`,
    );
    await openWorkspace(RECORD, { silent: true });
    const receipt = await receiveEnvelope(raw({ importId: ID1 }));
    expect(receipt.status).toBe("deduped");
    expect(receipt.path).toBe("已入库.md");
  });
});

describe("L2 接收端 · overwrite 的四道闸门（00 号 §6.7①）", () => {
  // 这组用例验的是 **0.2.0 的 overwrite 语义**：闸门代码与 0.2.0 一字不差。
  // 0.3.0 的默认偏好是 `"inbox"`（00 §6.14㉕），而 `pref === "inbox"` 时第 1 步之后直接进收件箱、
  // **根本走不到 overwrite 分支**（㉕.2 已裁定「设置优先于客户端下发的 conflict」）。
  // 所以这里把偏好显式设成 `"new"`（= 用户没选「先进入收件箱」），才是这四个闸门的有效场景。
  beforeEach(() => setImportLandingPreference("new"));

  it("默认通道（in-app）+ 未开启开关 → 降级为 new + IMP-4011，原文件不动", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const before = testBackend.bytes(a.path!)!;
    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "overwrite" }));
    expect(b.status).toBe("created");
    expect(b.path).toBe("测试标题 2.md");
    expect(b.warnings.some((item) => item.startsWith("IMP-4011 覆盖未生效"))).toBe(true);
    expect(testBackend.bytes(a.path!)).toEqual(before);
  });

  it("channel=local-bridge 但设置未开启 → 仍然降级", async () => {
    await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    setImportChannelContext({ channel: "local-bridge", overwriteEnabled: false });
    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "overwrite" }));
    expect(b.status).toBe("created");
    expect(b.warnings.some((item) => item.startsWith("IMP-4011"))).toBe(true);
  });

  it("四道闸门全满足 → 覆盖生效，留下前像，undo 逐字节还原", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const before = testBackend.bytes(a.path!)!;
    setImportChannelContext({ channel: "local-bridge", overwriteEnabled: true });

    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "overwrite" }));
    expect(b.status).toBe("created");
    expect(b.path).toBe(a.path);
    expect(b.revertible).toBe(true);
    expect(b.preimage?.path).toBe(`.opennote/import-preimages/${ID2}.md`);
    expect(b.undoSeconds).toBe(10);

    const text = testBackend.text(a.path!)!;
    expect(text).toContain("第二段");
    expect(text).not.toContain("第一段");
    expect(text).not.toContain("> 再次剪藏于");

    const undone = await undoImport(b);
    expect(undone.mode).toBe("preimage");
    expect(testBackend.bytes(a.path!)).toEqual(before);
  });

  it("前像写不出来（.opennote 只读）→ 降级为 new，不用历史快照顶替", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const before = testBackend.bytes(a.path!)!;
    setImportChannelContext({ channel: "local-bridge", overwriteEnabled: true });
    testBackend.denyWrite.add(".opennote/import-preimages");

    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "overwrite" }));
    expect(b.status).toBe("created");
    expect(b.path).not.toBe(a.path);
    expect(b.warnings.some((item) => item.startsWith("IMP-4011"))).toBe(true);
    expect(testBackend.bytes(a.path!)).toEqual(before);
    // 没有任何"快照"被拿来冒充前像。
    expect(testBackend.paths().filter((path) => path.startsWith(".opennote/history/"))).toEqual([]);
  });

  it("overwrite 不会落在正在编辑的笔记上", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    updateNoteContent(a.path!, "# 测试标题\n\n第一段\n\n用户没保存的字");
    setImportChannelContext({ channel: "local-bridge", overwriteEnabled: true });
    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "overwrite" }));
    expect(b.path).not.toBe(a.path);
    expect(b.warnings.some((item) => item.startsWith("IMP-4011"))).toBe(true);
  });
});

describe("L2 接收端 · 前像与撤销（契约 §3.3.3 / §10.3）", () => {
  it("连续两次 append：第二次的 undo 回到第一次 append 之后的状态", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const afterCreate = testBackend.bytes(first.path!)!;
    const second = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    const afterFirstAppend = testBackend.bytes(first.path!)!;
    const third = await receiveEnvelope(raw({ importId: ID3, body: "第三段", source: { selection: true, capturedAt: CAPTURED } }));

    expect(second.status).toBe("appended");
    expect(third.status).toBe("appended");
    expect(testBackend.bytes(second.preimage!.path)).toEqual(afterCreate);
    expect(testBackend.bytes(third.preimage!.path)).toEqual(afterFirstAppend);

    const undone = await undoImport(third);
    expect(undone.mode).toBe("preimage");
    expect(testBackend.bytes(first.path!)).toEqual(afterFirstAppend);
    expect(testBackend.text(first.path!)).toContain("第二段");
  });

  it("前像写不出来时 append 仍然成功，但 revertible=false + IMP-W008，undo 走回收站", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    testBackend.denyWrite.add(".opennote/import-preimages");
    const second = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    expect(second.status).toBe("appended");
    expect(second.revertible).toBe(false);
    expect(second.preimage).toBeNull();
    expect(second.warnings).toContain("IMP-W008 本次追加没有留下可回退的前像，撤销将只把笔记移入回收站。");
    expect(second.undoSeconds).toBeUndefined();
    expect(testBackend.text(first.path!)).toContain("第二段");

    const undone = await undoImport(second);
    expect(undone.mode).toBe("trash");
    expect(undone.ok).toBe(true);
    // 降级撤销的文案必须如实说明「只是移入回收站」，不能承诺恢复原样。
    expect(undone.message).toBe("已把《测试标题》移入回收站，可以再找回来。");
    await expect(testBackend.exists(first.path!)).resolves.toBe(false);
  });

  it("新建的导入撤销 → 文件进回收站，mode=trash", async () => {
    const receipt = await receiveEnvelope(raw({ importId: ID1 }));
    const undone = await undoImport(receipt);
    expect(undone.ok).toBe(true);
    expect(undone.mode).toBe("trash");
    await expect(testBackend.exists(receipt.path!)).resolves.toBe(false);
    expect(testBackend.paths().some((path) => path.startsWith(".opennote/trash/"))).toBe(true);
  });

  it("undo 会在导入日志里打 undoneAt 标记", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const second = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    await undoImport(second);
    const log = JSON.parse(testBackend.text(".opennote/import-log.json")!) as {
      entries: { importId: string; undoneAt: string | null }[];
    };
    expect(log.entries.find((entry) => entry.importId === ID2)?.undoneAt).toEqual(expect.any(String));
    expect(log.entries.find((entry) => entry.importId === ID1)?.undoneAt).toBeNull();
    await expect(testBackend.exists(first.path!)).resolves.toBe(true);
  });
});

describe("L2 接收端 · 不丢字与外部改动（D08 / 00 号 §6.3）", () => {
  it("用户正在编辑（有未写入的改动）→ 先落盘再追加，用户的字一个不丢", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    updateNoteContent(first.path!, "# 测试标题\n\n第一段\n\n用户刚打的字");
    const second = await receiveEnvelope(raw({ importId: ID2, body: "追加段", source: { selection: true, capturedAt: CAPTURED } }));
    expect(second.status).toBe("appended");
    const text = testBackend.text(first.path!)!;
    expect(text).toContain("用户刚打的字");
    expect(text).toContain("追加段");
    expect(text).toContain("> 再次剪藏于");
  });

  it("目标笔记被应用外改过 → 不追加，另存新文件 + IMP-W004", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    testBackend.seed(first.path!, "# 别人改的标题\n\n别人改的内容\n");
    const second = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    expect(second.status).toBe("created");
    expect(second.path).not.toBe(first.path);
    expect(second.warnings).toContain("IMP-W004 目标笔记有外部改动，已另存为新文件以免覆盖。");
    expect(testBackend.text(first.path!)).toContain("别人改的内容");
  });

  it("resolveAvailablePath 命中磁盘上外部新建的文件（D03）", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, title: "撞名", body: "第一段" }));
    expect(first.path).toBe("撞名.md");
    // 应用外新建同名文件（内存里从来没有过它）。
    testBackend.seed("撞名.md", "# 外部新建\n");
    const second = await receiveEnvelope(raw({ importId: ID2, title: "撞名", body: "另一段", source: { url: "https://other.test/y", capturedAt: CAPTURED } }));
    expect(second.path).toBe("撞名 2.md");
    expect(testBackend.text("撞名.md")).toBe("# 外部新建\n");
  });
});

describe("L2 接收端 · 附件（契约 §3.4）", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("落盘到工作区根的 `.assets/<uuid>.<ext>`，正文引用被改写成相对路径", async () => {
    const body = "看图：\n\n![图](./assets/diagram.png)\n";
    const receipt = await receiveEnvelope(
      raw({ importId: ID1, title: "带图", body, assets: [{ name: "diagram.png", mime: "image/png", dataBase64: encodeBase64(png) }] }),
    );
    expect(receipt.assets).toHaveLength(1);
    // 落点是**整库共用的** `.assets/`（0.4.0 用户裁定），文件名是内容派生的 uuid。
    expect(receipt.assets[0]).toMatch(/^\.assets\/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/);
    expect(testBackend.bytes(receipt.assets[0])).toEqual(png);
    const text = testBackend.text(receipt.path!)!;
    const ref = `.assets/${receipt.assets[0].slice(".assets/".length)}`;
    expect(text).toContain(`![图](${ref})`);
    expect(receipt.warnings).toEqual([]);
    expect(resolveRef(receipt.path!, ref)).toBe(receipt.assets[0]);
  });

  it("重试不产生「 2」垃圾：同名附件命中同一内容哈希路径", async () => {
    const asset = { name: "diagram.png", mime: "image/png", dataBase64: encodeBase64(png) };
    const a = await receiveEnvelope(raw({ importId: ID1, title: "带图", body: "第一段\n\n![图](./assets/diagram.png)\n", assets: [asset] }));
    const b = await receiveEnvelope(
      raw({
        importId: ID2,
        title: "带图",
        body: "第二段\n\n![图](./assets/diagram.png)\n",
        source: { selection: true, capturedAt: CAPTURED },
        assets: [asset],
      }),
    );
    expect(b.status).toBe("appended");
    expect(b.assets[0]).toBe(a.assets[0]);
    expect(testBackend.paths().filter((path) => path.includes(".assets/"))).toHaveLength(1);
  });

  it("附件失败时把已写入的路径放在 partial 里（IMP-4012）", async () => {
    await expect(
      receiveEnvelope(
        raw({
          importId: ID1,
          title: "带图",
          body: "![图](./assets/a.png)",
          assets: [
            { name: "a.png", mime: "image/png", dataBase64: encodeBase64(png) },
            { name: "evil.svg", mime: "image/svg+xml", dataBase64: encodeBase64(new TextEncoder().encode("<svg><script>alert(1)</script></svg>")) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "IMP-4012" });
    // 已写入的附件被如实报告，正文没有落盘。
    expect(notePaths()).toEqual([]);
  });

  it("未知附件引用 → IMP-W002，正文原样保留", async () => {
    const receipt = await receiveEnvelope(raw({ importId: ID1, body: "看图：\n\n![图](./assets/未声明的图.png)\n" }));
    expect(receipt.status).toBe("created");
    expect(receipt.warnings).toContain("IMP-W002 正文里有未声明的本地附件引用，已原样保留。");
    expect(testBackend.text(receipt.path!)).toContain("./assets/未声明的图.png");
  });
});

describe("L2 接收端 · 桥的 HTTP 状态码（契约 §4.1 的 HTTP 列）", () => {
  it("created → 201、pending → 202、其余 → 200（桥优先用回执给的这个数字）", async () => {
    const created = await receiveEnvelopeOutcome(raw({ importId: ID1, body: "第一段" }));
    expect(created).toMatchObject({ ok: true, status: 201 });
    // 同 URL 同正文、新 importId → duplicate（200）
    const duplicate = await receiveEnvelopeOutcome(raw({ importId: ID2, body: "第一段" }));
    expect(duplicate).toMatchObject({ ok: true, status: 200 });
    // 同 importId → deduped（200）
    const deduped = await receiveEnvelopeOutcome(raw({ importId: ID1, body: "第一段" }));
    expect(deduped).toMatchObject({ ok: true, status: 200 });
    // 同 URL 不同正文 + 选区 → appended（200）
    const appended = await receiveEnvelopeOutcome(
      raw({ importId: ID3, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }),
    );
    expect(appended).toMatchObject({ ok: true, status: 200 });
    // 同 URL 不同正文 + 整页 → pending（202，契约 §4.1 第 4 步）
    const pending = await receiveEnvelopeOutcome(raw({ importId: "3c4d5e6f-7081-4a7e-9d31-5b0f2a7c1ebb", body: "第三段" }));
    expect(pending).toMatchObject({ ok: true, status: 202 });
    // skipped（200）
    const skipped = await receiveEnvelopeOutcome(
      raw({ importId: "4d5e6f70-8192-4a7e-9d31-5b0f2a7c1ecc", body: "第四段", conflict: "skip" }),
    );
    expect(skipped).toMatchObject({ ok: true, status: 200 });
  });

  it("错误分支不带数字 status（桥用自己的错误表），错误体形状不变", async () => {
    await closeWorkspace();
    const outcome = await receiveEnvelopeOutcome(raw());
    expect(outcome).toMatchObject({ ok: false, error: { code: "IMP-4007", http: 409 } });
    expect(outcome).not.toHaveProperty("status");
    await openWorkspace(RECORD, { silent: true });
  });
});

describe("L2 接收端 · 跨模块域错误的透传（第三次同类缝）", () => {
  const FULL = "收件箱已满（500 条），请先处理一些条目。";
  /** 走到第 4 步（同 URL、正文不同、非选区）→ 进收件箱，即 `enqueueInbox` 必然被调用。 */
  const toInbox = (importId: string, body: string) => raw({ importId, body });

  it("收件箱满（InboxError/IMP-4013）→ 原样透传，绝不包成 IMP-5001", async () => {
    await receiveEnvelope(toInbox(ID1, "第一段"));
    inboxState.failWith = inboxError("IMP-4013", FULL);
    const outcome = await receiveEnvelopeOutcome(toInbox(ID2, "第二段"));
    expect(outcome).toMatchObject({ ok: false, error: { code: "IMP-4013", userMessage: FULL, http: 413 } });
    // 原因和下一步都不能指错：不能说「磁盘可能已满」。
    expect(JSON.stringify(outcome)).not.toContain("IMP-5001");
    expect(JSON.stringify(outcome)).not.toContain("磁盘");
    // 抛出版本也要带上原码（应用内调用方按 code 分支）。
    await expect(receiveEnvelope(toInbox(ID2, "第二段"))).rejects.toMatchObject({
      code: "IMP-4013",
      userMessage: FULL,
      http: 413,
    });
  });

  it("无后端（IMP-4007）等其它域错误同样原样透传（不认类、只认结构）", async () => {
    await receiveEnvelope(toInbox(ID1, "第一段"));
    inboxState.failWith = inboxError("IMP-4007", "Opennote 里还没有打开笔记本，请先打开一个文件夹（或新建浏览器笔记本）。");
    const outcome = await receiveEnvelopeOutcome(toInbox(ID2, "第二段"));
    expect(outcome).toMatchObject({ ok: false, error: { code: "IMP-4007", http: 409, retryable: true } });
  });

  it("不变量：同一个码 + 同一份文案，换成 ImportRejection 或任意结构相同的对象，透传结果逐字段一致", async () => {
    await receiveEnvelope(toInbox(ID1, "第一段"));
    const template = importProblem("IMP-4013");
    // 结构完全等价的两个错误：只差「是不是 ImportRejection 这个类」。
    inboxState.failWith = inboxError("IMP-4013", FULL, template.message);
    const viaInboxError = await receiveEnvelopeOutcome(toInbox(ID2, "第二段"));

    inboxState.failWith = new ImportRejection({ ...template, userMessage: FULL });
    const viaRejection = await receiveEnvelopeOutcome(toInbox(ID2, "第二段"));

    expect(viaInboxError).toEqual(viaRejection);
    expect(viaInboxError).toMatchObject({ ok: false, error: { code: "IMP-4013", userMessage: FULL } });
  });

  it("非域错误（普通 Error / 字符串）**仍然**归 IMP-5001，并带内部 reason（这条别改坏）", async () => {
    await receiveEnvelope(toInbox(ID1, "第一段"));
    inboxState.failWith = new Error("EACCES: 磁盘炸了");
    const outcome = await receiveEnvelopeOutcome(toInbox(ID2, "第二段"));
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "IMP-5001", http: 500, retryable: true },
    });
    expect((outcome as { error: { detail?: Record<string, unknown> } }).error.detail).toMatchObject({
      reason: "inbox-enqueue-failed",
    });
    // 只有 IMP-#### + userMessage 齐全才算域错误：码形状不对、缺文案都归 5001。
    inboxState.failWith = Object.assign(new Error("nope"), { code: "IMP-40", userMessage: "文案" });
    expect(await receiveEnvelopeOutcome(toInbox(ID2, "第三段"))).toMatchObject({ ok: false, error: { code: "IMP-5001" } });
    inboxState.failWith = Object.assign(new Error("nope"), { code: "IMP-4013" });
    expect(await receiveEnvelopeOutcome(toInbox(ID2, "第四段"))).toMatchObject({ ok: false, error: { code: "IMP-5001" } });
  });
});

describe("L2 接收端 · 外置形态与错误（契约 §2.6 / §6.2）", () => {
  it("body 与 bodyFile 两种形态产出的正文块逐字节相同", async () => {
    testBackend.seed("clip/body.txt", "第一行\r\n第二行");
    const viaInline = await receiveEnvelope(raw({ importId: ID1, title: "两种形态", body: "第一行\n第二行" }));
    const viaFile = await receiveEnvelope(
      raw({ importId: ID2, title: "两种形态", body: null, bodyFile: "clip/body.txt", source: { url: "https://other.test/z", capturedAt: CAPTURED } }),
    );
    expect(viaInline.status).toBe("created");
    expect(viaFile.status).toBe("created");
    const inline = splitFrontMatter(testBackend.text(viaInline.path!)!);
    const external = splitFrontMatter(testBackend.text(viaFile.path!)!);
    expect(external.body).toBe(inline.body);
  });

  it("外置正文过大 → IMP-4004", async () => {
    testBackend.seed("clip/huge.txt", "字".repeat(3 * 1024 * 1024)); // 9 MiB UTF-8
    await expect(receiveEnvelope(raw({ importId: ID1, body: null, bodyFile: "clip/huge.txt" }))).rejects.toMatchObject({
      code: "IMP-4004",
      http: 413,
    });
  });

  it("未打开笔记本 → IMP-4007；receiveEnvelopeOutcome 不抛、给结构化错误", async () => {
    await closeWorkspace();
    await expect(receiveEnvelope(raw())).rejects.toMatchObject({ code: "IMP-4007", http: 409, retryable: true });

    const outcome = await receiveEnvelopeOutcome(raw());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("IMP-4007");
      expect(outcome.error.http).toBe(409);
      expect(outcome.error.userMessage).toContain("还没有打开笔记本");
    }
  });

  it("JSON 解析失败 / 空请求体 / 顶层非对象", async () => {
    await expect(receiveEnvelope("{ 不是 JSON")).rejects.toMatchObject({ code: "IMP-3002", http: 400 });
    await expect(receiveEnvelope("   ")).rejects.toMatchObject({ code: "IMP-3003" });
    await expect(receiveEnvelope("[]")).rejects.toMatchObject({ code: "IMP-4001" });
    const outcome = await receiveEnvelopeOutcome("null");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("IMP-4001");
  });

  it("信封非法（folder 越界）→ IMP-4008，且工作区里没有任何新文件", async () => {
    await expect(receiveEnvelope(raw({ target: { folder: "../../etc", notePath: null } }))).rejects.toMatchObject({ code: "IMP-4008" });
    expect(testBackend.paths()).toEqual([]);
  });

  it("正文超过 8 MiB → IMP-4004", async () => {
    await expect(receiveEnvelope(raw({ importId: ID1, body: "字".repeat(3 * 1024 * 1024) }))).rejects.toMatchObject({ code: "IMP-4004" });
  });

  it("请求体超过 16 MiB → IMP-4005（解析之前就拒）", async () => {
    const huge = `{"spec":"opennote.import/v1","padding":"${"x".repeat(17 * 1024 * 1024)}"}`;
    await expect(receiveEnvelope(huge)).rejects.toMatchObject({ code: "IMP-4005", http: 413 });
  });

  it("非法 JSON 字符串也走同一个通道（传对象同样可用）", async () => {
    const receipt = await receiveEnvelope(JSON.parse(raw({ importId: ID1 })) as unknown);
    expect(receipt.status).toBe("created");
  });
});

describe("L2 接收端 · 冻结接口的回执形状", () => {
  it("ImportReceipt 结构上可赋给桥的 ImportResult（字段名逐字一致，编译期验证）", () => {
    const toResult = (receipt: ImportReceipt): ImportResult => receipt;
    expect(typeof toResult).toBe("function");
  });

  it("created 回执字段清单（契约 §4.5，逐一核对没有改名）", async () => {
    const receipt = await receiveEnvelope(raw({ importId: ID1 }));
    expect(Object.keys(receipt).sort()).toEqual([
      "assets",
      "deduped",
      "dedupedBy",
      "importId",
      "inboxId",
      "message",
      "path",
      "preimage",
      "revertible",
      "status",
      "tags",
      "warnings",
    ]);
    expect(typeof receipt.importId).toBe("string");
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("测试标题.md");
  });

  it("appended 回执多出 undoSeconds（10 秒显式窗口）", async () => {
    await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const receipt = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    expect(Object.keys(receipt).sort()).toContain("undoSeconds");
    expect(receipt.undoSeconds).toBe(10);
  });

  it("重复投递：duplicate 不写索引，所以再投一次仍然是 duplicate（可重复、无副作用）", async () => {
    await receiveEnvelope(raw({ importId: ID1, body: "同一段" }));
    const a = await receiveEnvelope(raw({ importId: ID2, body: "同一段" }));
    const b = await receiveEnvelope(raw({ importId: ID2, body: "同一段" }));
    expect(a.status).toBe("duplicate");
    expect(b.status).toBe("duplicate");
    expect(b.path).toBe(a.path);
    expect(b.message).toBe(a.message);
    expect(notePaths()).toHaveLength(1);
  });
});

describe("L2 接收端 · 入库 toast（UI-05 / 00 号 §6.7④）", () => {
  /** 打开通知 + 假定时器，抓 `notify()` 的真实入参与延时，跑完把全局状态还原。 */
  async function withToasts(run: () => Promise<void>): Promise<{ delays: (number | undefined)[] }> {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    setImportNotifications(true);
    let delays: (number | undefined)[] = [];
    try {
      await run();
      // 必须先抓下来：mockRestore() 会连同调用记录一起清掉。
      delays = spy.mock.calls.map((call) => call[1]);
    } finally {
      setImportNotifications(false);
      toastStore.set([]);
      spy.mockRestore();
      vi.useRealTimers();
    }
    return { delays };
  }

  it("成功 toast = 「已从网页剪藏：标题。」+ 撤销动作 + 显式 10 秒窗口", async () => {
    const { delays } = await withToasts(async () => {
      await receiveEnvelope(raw({ importId: ID1 }));
      const toast = toastStore.get().at(-1);
      expect(toast?.message).toBe("已从网页剪藏：测试标题。");
      expect(toast?.detail).toBeUndefined();
      expect(toast?.action?.label).toBe("撤销");
      expect(toast?.kind).toBe("info");
    });
    // notify() 对 action 分支的默认值是 6000ms，撤销窗口必须显式覆盖它。
    expect(delays).toContain(10_000);
  });

  it("不可回退时主文案照旧、降级说明进 detail 小字行，动作换成「移入回收站」", async () => {
    await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    testBackend.denyWrite.add(".opennote/import-preimages");
    const { delays } = await withToasts(async () => {
      const receipt = await receiveEnvelope(
        raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }),
      );
      expect(receipt.revertible).toBe(false);
      const toast = toastStore.get().at(-1);
      // 标题不能因为降级而消失：主文案保持完整，降级说明独立成小字行（UI-05 补充）。
      expect(toast?.message).toBe("已把新片段追加到《测试标题》。");
      expect(toast?.detail).toBe("内容已合并进已有笔记，撤销会把整篇移入回收站。");
      expect(toast?.action?.label).toBe("移入回收站");
    });
    expect(delays).toContain(10_000);
    expect(delays).not.toContain(6000);
  });

  it("deduped / duplicate / skipped 一律不弹 toast（只有客户端内联文案）", async () => {
    await receiveEnvelope(raw({ importId: ID1, body: "同一段" }));
    const { delays } = await withToasts(async () => {
      const duplicate = await receiveEnvelope(raw({ importId: ID2, body: "同一段" }));
      const deduped = await receiveEnvelope(raw({ importId: ID1, body: "同一段" }));
      const skipped = await receiveEnvelope(raw({ importId: ID3, body: "另一段", conflict: "skip" }));
      expect([duplicate.status, deduped.status, skipped.status]).toEqual(["duplicate", "deduped", "skipped"]);
      expect(toastStore.get()).toEqual([]);
    });
    expect(delays).not.toContain(10_000);
  });
});

/** 规范文案的字节级断言（00 号 §6.12① 唯一写法）。 */

describe("L2 接收端 · 冲突对话框挂钩（UI-06/S3）", () => {
  it("装了 resolver 时，正在编辑的笔记会先问人", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    updateNoteContent(first.path!, "# 测试标题\n\n第一段\n\n没保存的字");
    const asked: string[] = [];
    setImportConflictResolver((prompt) => {
      asked.push(`${prompt.kind}:${prompt.path}`);
      return "new";
    });
    const receipt = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    expect(asked).toEqual([`editing:${first.path}`]);
    expect(receipt.status).toBe("created");
    expect(receipt.path).not.toBe(first.path);
  });

  it("resolver 选 inbox → 进收件箱，不写正文", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    updateNoteContent(first.path!, "# 测试标题\n\n第一段\n\n没保存的字");
    setImportConflictResolver(() => "inbox");
    const receipt = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));
    expect(receipt.status).toBe("pending");
    expect(inboxCalls).toHaveLength(1);
  });
});

/* =====================================================================================
 * 0.3.0：落点偏好 = `UiSettings.importConflict` 的**行为层输入**（00 §6.14㉕㉖㉗）
 *
 * 0.2.0 的病：`importConflict` 只被设置面板改 UI 值，`receive.ts` 从不读它 —— 假开关（第 4 例）。
 * 这组用例就是「它现在是真输入」的证据，且每一条都能独立红（回退实现即失败）。
 * ===================================================================================== */

describe("L2 接收端 · 落点偏好（00 §6.14㉕㉖）", () => {
  it("默认值就是 inbox：外部通道（local-bridge）**没说落点**的投递 → pending，磁盘上不出现新 .md", async () => {
    expect(getImportLandingPreference()).toBe("inbox");
    setImportChannelContext({ channel: "local-bridge" });

    const receipt = await receiveEnvelope(raw({ target: { folder: null, notePath: null } }));

    expect(receipt.status).toBe("pending");
    expect(receipt.path).toBeNull();
    expect(receipt.inboxId).toMatch(/^\d{8}T\d{6}-.{8}$/);
    expect(receipt.deduped).toBe(false);
    expect(receipt.dedupedBy).toBeNull();
    expect(receipt.revertible).toBe(true);
    expect(receipt.preimage).toBeNull();
    expect(receipt.assets).toEqual([]);
    // 关键：「不写盘」= 一个笔记文件都没有（收件箱条目在 `.opennote/inbox/` 下，不是笔记）。
    expect(notePaths()).toEqual([]);
    expect(testBackend.paths().filter((path) => path.endsWith(".md"))).toEqual([]);
    expect(inboxCalls).toHaveLength(1);
    // 附件/目标目录没被解析成落点，也就不会创建空目录。
    expect(testBackend.paths().some((path) => path.startsWith("剪藏/"))).toBe(false);
  });

  /*
   * 0.3.3 收窄（Lead 裁定，`00` 号 §6.16（52））：**偏好管的是「没有指明落点的投递」**。
   *
   * 这一条原来断言的是「外部通道 + `target.folder = "剪藏/技术"` 也照样进收件箱」。
   * 那个口径让**网页版剪藏页的落点下拉变成假开关**（用户在确认页上选了「归档」，笔记还是进收件箱）——
   * 用**真接收端**跑端到端时才露出来：桥的替身回 `created`，真接收端回 `pending`。
   * 用户原话「先编辑，确认后再入库」「支持移动到收件箱或者说其他目录」是这条收窄的依据；
   * 而 ㉕ 自己的措辞也是「剪藏落点**默认**进收件箱」—— 默认 ≠ 客户端明确指名。
   */
  it("指名落点 = 已经做过决定：外部通道 + `target.folder` 非空 → **直接落盘**，不进收件箱", async () => {
    setImportChannelContext({ channel: "local-bridge" });

    const receipt = await receiveEnvelope(raw({ target: { folder: "剪藏/技术", notePath: null } }));

    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("剪藏/技术/测试标题.md");
    expect(receipt.inboxId).toBeNull();
    expect(testBackend.text("剪藏/技术/测试标题.md")).toContain("第一段");
    expect(inboxCalls).toHaveLength(0);
  });

  it("㉕.2 一条都不放松：指名落点 + 客户端下发 `overwrite` 仍**强制进收件箱**（不可被绕过）", async () => {
    setImportChannelContext({ channel: "local-bridge" });

    const receipt = await receiveEnvelope(
      raw({ conflict: "overwrite", target: { folder: "剪藏/技术", notePath: null } }),
    );

    expect(receipt.status).toBe("pending");
    expect(receipt.path).toBeNull();
    expect(notePaths()).toEqual([]);
  });

  it("同 importId 重投两次 → 第二次 deduped，收件箱里只有 1 条（㉕「第 1 步依然优先」）", async () => {
    setImportChannelContext({ channel: "local-bridge" });

    const first = await receiveEnvelope(raw());
    expect(first.status).toBe("pending");
    const second = await receiveEnvelope(raw());

    expect(second.status).toBe("deduped");
    expect(second.deduped).toBe(true);
    expect(second.dedupedBy).toBe("importId");
    expect(second.inboxId).toBe(first.inboxId);
    expect(second.path).toBeNull();
    expect(second.message).toBe("");
    expect(inboxState.entries).toHaveLength(1);
    expect(inboxCalls).toHaveLength(1);
    expect(notePaths()).toEqual([]);
  });

  it("channel=in-app 不受影响：仍然直接落盘 + 可撤销", async () => {
    expect(getImportLandingPreference()).toBe("inbox");
    setImportChannelContext({ channel: "in-app" });

    const receipt = await receiveEnvelope(raw());
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("测试标题.md");
    expect(receipt.revertible).toBe(true);
    expect(notePaths()).toEqual(["测试标题.md"]);
    expect(inboxCalls).toEqual([]);
  });

  it("channel=inbox（用户在收件箱里点「确认入库」）不被强制回收件箱（㉕.1，反死循环）", async () => {
    const first = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    // C2 的确认入库：`setImportChannelContext({ channel: "inbox" })` + 复投同一封信封。
    setImportChannelContext({ channel: "inbox" });
    const committed = await receiveEnvelope(raw({ importId: ID2, body: "第二段", source: { selection: true, capturedAt: CAPTURED } }));

    expect(committed.status).toBe("appended");
    expect(committed.path).toBe(first.path);
    expect(inboxCalls).toEqual([]);
  });

  it("pref === 'new' 时与 0.2.0 完全一致（同一封信封 → 回执逐字段相同）", async () => {
    const baseline = await receiveEnvelope(raw({ target: { folder: "剪藏", notePath: null } }));

    // 换一个干净工作区、清空收件箱，用同一封信封、改成外部通道 + pref="new" 再跑一次。
    testBackend = new MemoryBackend();
    resetImportIndexCache();
    inboxState.entries.length = 0;
    inboxCalls.length = 0;
    await openWorkspace(RECORD, { silent: true });
    setImportLandingPreference("new");
    setImportChannelContext({ channel: "local-bridge" });

    const withNew = await receiveEnvelope(raw({ target: { folder: "剪藏", notePath: null } }));
    expect(withNew).toEqual(baseline);
    expect(withNew.status).toBe("created");

    // 判定链第 4 步（整页二次剪藏 → pending）在 pref="new" 下照旧。
    const second = await receiveEnvelope(raw({ importId: ID2, body: "整页改版后" }));
    expect(second.status).toBe("pending");
  });

  it("pref === 'inbox' 优先于客户端的 conflict:'overwrite'（㉕.2）；四闸门齐备也不覆盖", async () => {
    const a = await receiveEnvelope(raw({ importId: ID1, body: "第一段" }));
    const before = testBackend.bytes(a.path!)!;
    setImportLandingPreference("inbox");
    setImportChannelContext({ channel: "local-bridge", overwriteEnabled: true });

    const b = await receiveEnvelope(raw({ importId: ID2, body: "第二段", conflict: "overwrite" }));

    expect(b.status).toBe("pending");
    expect(b.path).toBeNull();
    expect(b.warnings).toEqual([]);
    expect(testBackend.bytes(a.path!)).toEqual(before);
    expect(notePaths()).toEqual([a.path]);
  });

  it("页面内桥（channel=inpage）同样强制进收件箱", async () => {
    setImportChannelContext({ channel: "inpage" });
    const receipt = await receiveEnvelope(raw());
    expect(receipt.status).toBe("pending");
    expect(notePaths()).toEqual([]);
  });

  it("脏值不采信：非法偏好被忽略并告警，当前值不变", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      setImportLandingPreference("inbox");
      setImportLandingPreference("bogus" as ImportLandingPreference);
      setImportLandingPreference(undefined as unknown as ImportLandingPreference);
      expect(getImportLandingPreference()).toBe("inbox");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("resetImportLandingPreference() 复位成 'inbox'（不是 'new'）", async () => {
    setImportLandingPreference("new");
    resetImportLandingPreference();
    expect(getImportLandingPreference()).toBe("inbox");
    // 复位后行为也真的跟着回来（不是只改了个变量）。
    setImportChannelContext({ channel: "local-bridge" });
    const receipt = await receiveEnvelope(raw());
    expect(receipt.status).toBe("pending");
  });

  it("三个入口都从 barrel 导出（task-14 只 import 这一个入口）", async () => {
    const barrel = await import("./index");
    expect(typeof barrel.setImportLandingPreference).toBe("function");
    expect(typeof barrel.getImportLandingPreference).toBe("function");
    expect(typeof barrel.resetImportLandingPreference).toBe("function");
    expect(barrel.setImportLandingPreference).toBe(setImportLandingPreference);
  });

  it("㉗ 逐字：IMP-4007 的新文案（并禁止旧措辞）+ IMP-4006 三态区分", () => {
    expect(IMPORT_ERRORS["IMP-4007"].userMessage).toBe(
      "Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。",
    );
    expect(IMPORT_ERRORS["IMP-4006"].userMessage).toBe("Opennote 没有在运行。请先打开 Opennote，再试一次。");
    // ㉗「禁止再用」的两句旧措辞：一个字都不许留。
    const all = Object.values(IMPORT_ERRORS).map((item) => item.userMessage).join("\n");
    expect(all).not.toContain("还没有打开笔记本，");
    expect(all).not.toContain("请先打开一个文件夹");
    expect(all).not.toContain("新建浏览器笔记本");
  });
});


describe("③ 剪藏配图兜底下载（0.4.0：主进程代下，桌面 CSP 不放行远程图）", () => {
  const REMOTE = "https://cdn.test/photo.png";
  /** 最小 PNG 头（魔数校验只看开头）。 */
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

  it("真回环 + 真下载器 + 真入库：图片落进共享 `.assets/`，引用指得对", async () => {
    // 这一条不 mock 下载器：起一个真 127.0.0.1 服务端，用主进程那个**真的**下载器
    // （`electron/fetch-images.cjs`）取字节，再走真的落盘管线 —— ① 在应用侧的
    // 「网络 → 字节 → 落盘 → 正文改写」整条链一次跑通。
    const { createServer } = await import("node:http");
    const require = (await import("node:module")).createRequire(import.meta.url);
    const { downloadImages } = require("../../../electron/fetch-images.cjs") as {
      downloadImages: (options: { urls: string[] }) => Promise<Array<{ url: string; ok: boolean; base64?: string }>>;
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from(PNG));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const remote = `http://127.0.0.1:${port}/photo.png`;
    try {
      setRemoteImageSource((urls) => downloadImages({ urls }));
      const receipt = await receiveEnvelope(raw({ body: `看图：\n\n![图](${remote})` }));
      expect(receipt.status).toBe("created");
      const text = testBackend.text(receipt.path!)!;
      expect(text).not.toContain(remote);
      const refs = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
      expect(refs).toHaveLength(1);
      expect(testBackend.files.has(resolveRef(receipt.path!, refs[0]))).toBe(true);
      expect(Buffer.from(testBackend.bytes(resolveRef(receipt.path!, refs[0]))!).equals(Buffer.from(PNG))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("正文里的远程图片：装上下载器 → 落盘到共享 `.assets/` + 引用改写", async () => {
    const asked: string[][] = [];
    setRemoteImageSource(async (urls) => {
      asked.push(urls);
      return [{ url: REMOTE, ok: true, base64: encodeBase64(PNG), byteLength: PNG.length, mime: "image/png" }];
    });
    const receipt = await receiveEnvelope(raw({ body: `看图：\n\n![图](${REMOTE})` }));
    expect(receipt.status).toBe("created");
    expect(asked).toEqual([[REMOTE]]);
    const text = testBackend.text(receipt.path!)!;
    expect(text).not.toContain(REMOTE);
    const refs = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(refs).toHaveLength(1);
    expect(refs[0].startsWith(".assets/")).toBe(true);
    expect(testBackend.files.has(resolveRef(receipt.path!, refs[0]))).toBe(true);
    expect(receipt.assets).toHaveLength(1);
  });

  it("下载失败：引用原样保留 + 一句汇总 warning（绝不静默）", async () => {
    setRemoteImageSource(async () => [{ url: REMOTE, ok: false, error: "服务器返回 403" }]);
    const receipt = await receiveEnvelope(raw({ body: `![图](${REMOTE})` }));
    expect(testBackend.text(receipt.path!)).toContain(REMOTE);
    expect(receipt.warnings.some((item) => item.includes("没能下载到本地"))).toBe(true);
    expect(receipt.assets).toEqual([]);
  });

  it("没装下载器（web / CLI / 单测）：一个字节都不动，行为与 0.3.x 一致", async () => {
    setRemoteImageSource(null);
    const receipt = await receiveEnvelope(raw({ body: `![图](${REMOTE})` }));
    expect(testBackend.text(receipt.path!)).toContain(REMOTE);
    expect(receipt.assets).toEqual([]);
  });

  it("客户端已自带字节的图（扩展侧抓到了）不会再下一遍：正文里没有远程 URL", async () => {
    let called = 0;
    setRemoteImageSource(async () => {
      called += 1;
      return [];
    });
    const receipt = await receiveEnvelope(
      raw({
        body: "![图](assets/photo.png)",
        assets: [{ name: "photo.png", mime: "image/png", dataBase64: encodeBase64(PNG) }],
      }),
    );
    expect(called).toBe(0);
    const text = testBackend.text(receipt.path!)!;
    expect(text).not.toContain(REMOTE);
    expect(receipt.assets).toHaveLength(1);
  });
});
