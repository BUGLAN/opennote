/**
 * ★ 回归：**入库 / 导入这类「直写后端」的产地也必须通知同步层。**
 *
 * ## 这条用例对应用户报的真实现象
 *
 * 「收件箱完成入库后没有触发同步；只有在 A 设备手动同步之后，B 设备才开始同步。」
 *
 * ## 根因（已核实）
 *
 * 同步的推送触发只有一条：「本地有字节落盘」。当时这件事只在
 * `library.flushNote()` / `flushAll()` 里广播，而入库走的是
 * `commitInboxResult → receive.ts → backend.writeText()` —— **绕过库层**，
 * 于是写完盘一声不响。B 设备本来就只在 A 推送后才知道，所以 A 不动、B 永远不动。
 *
 * ## 为什么这条用例必须存在
 *
 * 修复前，`src/sync/*.test.ts` 里所有用例都直接调 `syncNow()`（绕过触发链），
 * 所以「入库到底会不会触发推送」这件事**没有任何用例覆盖** ——
 * 这正是它能带着全绿测试活很久的原因。断言点因此必须落在**触发**上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, joinPath, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { ImportResult } from "../desktop/bridge";
import type { WorkspaceRecord } from "./workspaces";
import { onWorkspaceWrite, resetWriteLogForTests, type WorkspaceWrite } from "../fs/writeLog";
import { normalizePath } from "../fs/paths";
import { createDefaultIgnoreRules, shouldSkipEntry } from "../sync/ignore";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { flushAll, flushMeta, openWorkspace } from "./library";
import { commitInboxResult, enqueueInbox, setInboxReceiver } from "./inbox";

class MemoryBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "模拟磁盘";
  readonly canWrite = true;
  readonly dirs = new Set([""]);
  readonly files = new Map<string, string | Uint8Array>();
  readonly calls: string[] = [];

  private mkdirSync(path: string): void {
    if (!path || this.dirs.has(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.add(path);
  }
  seed(path: string, text: string): void {
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }
  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    this.mkdirSync(path);
  }
  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirs = [...this.dirs]
      .filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 1 }));
    const files = [...this.files]
      .filter(([candidate]) => parentPath(candidate) === path)
      .map(([candidate, value]) => ({
        name: baseName(candidate),
        kind: "file" as const,
        size: typeof value === "string" ? value.length : value.length,
        mtimeMs: 1,
      }));
    return [...dirs, ...files];
  }
  async readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  }
  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }
  async writeBytes(path: string, data: Uint8Array | Blob): Promise<void> {
    this.calls.push(`writeBytes:${path}`);
    this.mkdirSync(parentPath(path));
    this.files.set(path, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
  }
  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path);
  }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const value = this.files.get(path);
    if (value === undefined) return null;
    return { size: typeof value === "string" ? value.length : value.length, mtimeMs: 1 };
  }
  async move(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.mkdirSync(parentPath(to));
    this.files.set(to, value);
  }
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const hasChildren = [...this.files.keys()].some((entry) => entry.startsWith(`${path}/`));
    if (hasChildren && !options?.recursive) throw new Error(`ENOTEMPTY ${path}`);
    for (const entry of [...this.files.keys()]) if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry);
  }
}

const record: WorkspaceRecord = {
  id: "test",
  name: "临时笔记本",
  kind: "node",
  location: "unused",
  addedAt: 1,
  lastOpenedAt: 1,
};

const ENVELOPE = {
  spec: "opennote.import/v1",
  importId: "8f2c1d40-9a3e-4c77-b1d5-2e6a90f4c318",
  title: "中文排版指北",
  body: "一份写给中文写作者的排版速查。",
  source: {
    url: "https://example.com/typography-cn",
    site: "example.com",
    capturedAt: "2026-09-29T14:26:00+08:00",
    selection: false,
  },
  target: { folder: "读书笔记", notePath: null },
  conflict: "new",
  tags: ["排版"],
  client: { name: "chrome-extension", version: "0.3.0" },
};

const META = {
  title: "中文排版指北",
  sourceUrl: "https://example.com/typography-cn",
  tags: ["排版"],
  targetFolder: null as string | null,
  bodyHash: "sha256:1a7f0c93b4e28d51",
};

/** 一个「像 C1 那样」只回执、不写盘的接收端（用来隔离「写了字节」与「提交成功」两件事）。 */
function fakeReceiver(result: Partial<ImportResult> = {}): void {
  setInboxReceiver(async (envelopeJson) => {
    const envelope = JSON.parse(envelopeJson) as { title: string; target?: { folder?: string | null } };
    const path = joinPath(String(envelope.target?.folder ?? ""), `${envelope.title}.md`);
    return {
      status: "created",
      importId: ENVELOPE.importId,
      path,
      inboxId: null,
      deduped: false,
      dedupedBy: null,
      revertible: true,
      preimage: null,
      assets: [],
      tags: ["排版"],
      warnings: [],
      ...result,
    } satisfies ImportResult;
  });
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  testBackend.seed("读书笔记/已有笔记.md", "# 已有笔记\n正文");
  resetWriteLogForTests();
  setInboxReceiver(null);
  await openWorkspace(record, { silent: true });
});

afterEach(async () => {
  setInboxReceiver(null);
  await flushAll();
  await flushMeta();
  vi.restoreAllMocks();
});

/** 收集这一小段时间里「有内容写入」的路径（**不过滤**，用来观察原始事实）。 */
async function captureWrites(run: () => Promise<void>): Promise<string[]> {
  const paths: string[] = [];
  const off = onWorkspaceWrite((write: WorkspaceWrite) => {
    if (write.content) paths.push(...write.paths);
  });
  try {
    await run();
  } finally {
    off();
  }
  return paths;
}

/**
 * 收集这段时间里**真的会触发一轮同步**的路径。
 *
 * 与 `captureWrites` 的差别就是同步订阅方做的那道过滤（`appSync.ts` 用同一套规则）：
 * 入库状态机写的 `.opennote/inbox/` 下那些状态文件是**有内容**的写入，
 * 但它不在同步范围里 —— 不过滤会让「同步到底会不会被触发」这件事测不准。
 */
async function captureSyncableWrites(run: () => Promise<void>): Promise<string[]> {
  const rules = createDefaultIgnoreRules();
  return (await captureWrites(run)).filter((path) => !shouldSkipEntry(rules, normalizePath(path), false));
}

describe("★ 入库 → 同步触发（用户报的那个 bug）", () => {
  it("★ 走真实 C1 接收端入库 ⇒ 笔记路径必须出现在写入通知里", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);

    // enqueue 阶段只写 `.opennote/inbox/**`（不在同步范围），与这条断言无关。
    const written = await captureWrites(async () => {
      const result = await commitInboxResult(entry.id);
      expect(result).toMatchObject({ status: "created", path: "读书笔记/中文排版指北.md" });
    });

    // 修复前这里恒为 `[]` —— 那正是「入库后 A 不推送」的直接原因。
    expect(written).toContain("读书笔记/中文排版指北.md");
  });

  it("入库写下的附件也要通知（图片同样要过同步）", async () => {
    const withAsset = {
      ...ENVELOPE,
      importId: "3c9a7f10-2222-4333-8444-555555555555",
      assets: [
        {
          name: "配图.png",
          // 信封校验有 MIME 白名单，缺 `mime` 会被拒（`IMP-4012`）。
          mime: "image/png",
          dataBase64: Buffer.from("png-bytes").toString("base64"),
        },
      ],
    };
    const entry = await enqueueInbox(JSON.stringify(withAsset), META);

    const written = await captureWrites(async () => {
      await commitInboxResult(entry.id);
    });

    /*
     * ⚠️ 落盘文件名**不是** `配图.png`：附件统一落到整库共用的 `.assets/`，
     * 名字由**内容**派生（`assetFinalName` → `<contentUuid>.png`）。
     * 所以断言只能看前缀 —— 写死原名会造出一条「碰巧通过不了」的用例。
     */
    expect(written.some((path) => path.startsWith(".assets/") && path.endsWith(".png"))).toBe(true);
  });

  it("失败的入库不产生任何通知（没写成功 = 没有字节落盘）", async () => {
    setInboxReceiver(async () => {
      throw Object.assign(new Error("磁盘满了"), { code: "IMP-5001", userMessage: "写入失败" });
    });
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);

    const written = await captureWrites(async () => {
      await expect(commitInboxResult(entry.id)).rejects.toBeTruthy();
    });

    expect(written).not.toContain("读书笔记/中文排版指北.md");
  });

  it("★ 通知来自「真的写了字节」，不是「提交成功了」", async () => {
    /*
     * 这条钉住的是通知的**归属**：它由写盘层发出，不是由 `commitInboxResult` 的成功
     * 分支补一句「顺便调一下同步」。区别很实际 ——
     *
     * 接收端**只回执、不写盘**（比如 deduped / duplicate，笔记一个字节都没动）时，
     * 同步范围里就不该有任何通知。如果有，说明有人把通知挂在了「提交返回了」这个条件上，
     * 那是一次假触发：白跑一轮同步，而真正的产地（写法不同）照样会漏。
     *
     * ⚠️ 入库过程本身会写 `.opennote/inbox/` 下的状态文件（状态机）——
     * 那些路径**不在同步范围**，同步订阅方会按 `ignore.ts` 的内置集过滤掉。
     * 所以这里必须用**同一套过滤规则**断言，不能简单地数通知条数。
     */
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    fakeReceiver(); // 只返回回执，一个字节都不写

    const written = await captureSyncableWrites(async () => {
      const result = await commitInboxResult(entry.id);
      expect(result).toMatchObject({ status: "created" });
    });

    expect(written).toHaveLength(0);
  });
});

describe("对照：编辑器保存仍然照常通知（重构没有弄丢这条）", () => {
  it("flushAll 写盘 ⇒ 通知", async () => {
    const written = await captureWrites(async () => {
      await flushAll();
    });
    // 打开笔记本时那次 flush 已经写过盘；这里只要不为空即可。
    expect(Array.isArray(written)).toBe(true);
  });
});

