/**
 * 导入收件箱 `.opennote/inbox/`（`src/data/inbox.ts`）的回归测试。
 *
 * 覆盖验收清单：enqueue→pending、5 态迁移、commit→committed + notePath、
 * discard→立即消失且**不产生回收站条目**、保留期清理（24h / 7d / 不设期限）、
 * 原子写（`*.tmp` 不残留）、`inboxCount()`、500 上限、同 id 去重（IMP-4017）、
 * 以及「手工往 inbox 里放一个条目 → 刷新后计数 +1」的外部投递场景。
 *
 * 后端是内存实现（同 `library.files.test.ts` 的做法），并通过 `vi.mock("./workspaces")`
 * 让 `library.ts` 使用它——收件箱读写全部走既有的 `FileSystemBackend`，不碰真实磁盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveWorkspacePath } from "./assets";
import { baseName, joinPath, parentPath } from "../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import type { ImportResult } from "../desktop/bridge";
import type { WorkspaceRecord } from "./workspaces";

let testBackend: MemoryBackend;
vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { flushAll, flushMeta, getLibrary, openWorkspace } from "./library";
import {
  INBOX_DIR,
  INBOX_FULL_MESSAGE,
  INBOX_LIMIT,
  InboxError,
  cleanupInbox,
  commitInbox,
  commitInboxResult,
  discardInbox,
  enqueueInbox,
  inboxCount,
  inboxFailureMessage,
  inboxWatchMode,
  listInbox,
  listInboxDetails,
  readInboxEntry,
  refreshInbox,
  resolveInboxFolder,
  setInboxReceiver,
  setInboxStatus,
  startInboxWatch,
  stopInboxWatch,
} from "./inbox";

/* ------------------------------ 内存后端 ------------------------------- */

class MemoryBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "模拟磁盘";
  readonly canWrite = true;
  readonly dirs = new Set([""]);
  readonly files = new Map<string, string | Uint8Array>();
  readonly calls: string[] = [];

  seed(path: string, text: string): void {
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }

  seedBytes(path: string, bytes: Uint8Array): void {
    this.mkdirSync(parentPath(path));
    this.files.set(path, bytes);
  }

  private mkdirSync(path: string): void {
    if (!path || this.dirs.has(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.add(path);
  }

  /** 目录树里的全部文件路径（断言「条目内容是否真的被删掉」用）。 */
  pathsUnder(dir: string): string[] {
    return [...this.files.keys()].filter((path) => path === dir || path.startsWith(`${dir}/`));
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    this.mkdirSync(path);
  }
  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirEntries = [...this.dirs]
      .filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: 1 }));
    const fileEntries = [...this.files]
      .filter(([candidate]) => parentPath(candidate) === path)
      .map(([candidate, value]) => ({
        name: baseName(candidate),
        kind: "file" as const,
        size: typeof value === "string" ? value.length : value.length,
        mtimeMs: 1,
      }));
    return [...dirEntries, ...fileEntries];
  }
  async readText(path: string): Promise<string> {
    this.calls.push(`read:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    this.calls.push(`read:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    // 二进制必须**逐字节**往返：早先这里写成 `encode(await readText())`，0x89 这种
    // 非法 UTF-8 单字节会被解码成 U+FFFD 再编码回 3 字节 —— 图片就被悄悄改坏了。
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  }
  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`write:${path}`);
    this.mkdirSync(parentPath(path));
    this.files.set(path, text);
  }
  async writeBytes(path: string, bytes: Uint8Array | Blob): Promise<void> {
    this.calls.push(`write:${path}`);
    this.mkdirSync(parentPath(path));
    this.files.set(path, bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes);
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
    this.calls.push(`move:${from}->${to}`);
    if (await this.exists(to)) throw new Error(`EEXIST ${to}`);
    this.mkdirSync(parentPath(to));
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      return;
    }
    if (!this.dirs.has(from)) throw new Error(`ENOENT ${from}`);
    for (const [path, content] of [...this.files]) {
      if (path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, content);
      }
    }
    for (const path of [...this.dirs].filter((dir) => dir === from || dir.startsWith(`${from}/`))) {
      this.dirs.delete(path);
      this.dirs.add(`${to}${path.slice(from.length)}`);
    }
  }
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const hasChildren = [...this.files.keys(), ...this.dirs].some((entry) => entry.startsWith(`${path}/`));
    if (hasChildren && !options?.recursive) throw new Error(`ENOTEMPTY ${path}`);
    for (const entry of [...this.files.keys()]) if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry);
  }
}

/* -------------------------------- 夹具 --------------------------------- */

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
    author: "小林",
    capturedAt: "2026-09-29T14:26:00+08:00",
    selection: false,
  },
  target: { folder: "读书笔记", notePath: null },
  conflict: "new",
  tags: ["排版", "网页剪藏"],
  client: { name: "chrome-extension", version: "0.3.0" },
};

const META = {
  title: "中文排版指北",
  sourceUrl: "https://example.com/typography-cn",
  tags: ["排版"],
  targetFolder: null as string | null,
  bodyHash: "sha256:1a7f0c93b4e28d51",
};

const DAY = 24 * 60 * 60 * 1000;

function importResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    status: "created",
    importId: ENVELOPE.importId,
    path: "读书笔记/中文排版指北.md",
    inboxId: null,
    deduped: false,
    dedupedBy: null,
    revertible: true,
    preimage: null,
    assets: [],
    tags: ["排版"],
    warnings: [],
    ...overrides,
  };
}

/** 一个「像 C1 那样」把信封落盘的接收端：写笔记 + 返回回执。 */
function installReceiver(result: Partial<ImportResult> = {}) {
  const calls: { envelope: Record<string, unknown>; meta: { channel: "inbox" } }[] = [];
  setInboxReceiver(async (envelopeJson, meta) => {
    const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
    calls.push({ envelope, meta });
    const folder = String((envelope.target as { folder?: string | null } | undefined)?.folder ?? "");
    const path = joinPath(folder, `${String(envelope.title)}.md`);
    testBackend.seed(path, `# ${String(envelope.title)}\n`);
    return importResult({ ...result, path });
  });
  return calls;
}

function statePath(dirName: string): string {
  return joinPath(INBOX_DIR, dirName, "state.json");
}

function readState(dirName: string): Record<string, unknown> {
  const raw = testBackend.files.get(statePath(dirName));
  if (typeof raw !== "string") throw new Error(`没有 state.json：${dirName}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

async function firstDirName(): Promise<string> {
  const { dirName } = (await listInboxDetails())[0];
  return dirName;
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  testBackend.seed("读书笔记/已有笔记.md", "# 已有笔记\n正文");
  setInboxReceiver(null);
  await openWorkspace(record, { silent: true });
});

afterEach(async () => {
  stopInboxWatch();
  setInboxReceiver(null);
  await flushAll();
  await flushMeta();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------- 投递 ---------------------------------- */

describe("enqueueInbox：投递即 pending", () => {
  it("按契约写出条目目录、entry.json（正文外置）、body.md 与 state.json", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);

    expect(entry.status).toBe("pending");
    expect(entry.id).toBe(ENVELOPE.importId);
    expect(entry.title).toBe("中文排版指北");
    expect(entry.sourceUrl).toBe("https://example.com/typography-cn");
    expect(entry.targetFolder).toBe("读书笔记");
    expect(entry.tags).toEqual(["排版", "网页剪藏"]);
    expect(entry.notePath).toBeNull();
    expect(entry.committedPath).toBeNull();
    expect(entry.message).toBeNull();
    expect(entry.attempts).toBe(0);

    // 目录名 = YYYYMMDDTHHMMSS（UTC）- importId 前 8 位。
    const { dirName } = (await listInboxDetails())[0];
    expect(dirName).toMatch(/^\d{8}T\d{6}-8f2c1d40$/);
    expect(entry.envelopePath).toBe(`${INBOX_DIR}/${dirName}/entry.json`);

    // entry.json：正文外置，只允许 bodyFile / assets[].file / enqueuedAt 三个扩展字段。
    const rawEntry = testBackend.files.get(`${INBOX_DIR}/${dirName}/entry.json`);
    expect(typeof rawEntry).toBe("string");
    const envelope = JSON.parse(rawEntry as string) as Record<string, unknown>;
    expect(envelope.body).toBeNull();
    expect(envelope.bodyFile).toBe("body.md");
    expect(envelope.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(envelope.spec).toBe("opennote.import/v1");
    expect(envelope.importId).toBe(ENVELOPE.importId);
    // 只允许 bodyFile / assets[].file / enqueuedAt 这三个契约扩展字段，不得自造字段名。
    expect(Object.keys(envelope).sort()).toEqual(
      ["spec", "importId", "title", "body", "bodyFile", "source", "target", "conflict", "tags", "assets", "client", "enqueuedAt"].sort(),
    );
    expect((envelope.target as { folder: string }).folder).toBe("读书笔记");
    expect((envelope.source as { capturedAt: string }).capturedAt).toBe("2026-09-29T14:26:00+08:00");

    // body.md 是正文原文。
    expect(testBackend.files.get(`${INBOX_DIR}/${dirName}/body.md`)).toBe(ENVELOPE.body);

    // state.json 只有契约的五个键。
    const state = readState(dirName);
    expect(Object.keys(state).sort()).toEqual(["attempts", "committedPath", "lastError", "status", "updatedAt"]);
    expect(state).toMatchObject({ status: "pending", attempts: 0, lastError: null, committedPath: null });
    expect(typeof state.updatedAt).toBe("string");

    // 界面计数 +1，且列表能读出这条。
    expect(inboxCount()).toBe(1);
    const list = await listInbox();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("pending");

    // 原子写：不留 *.tmp。
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}`).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("同 importId 再投一次是幂等的（不新建第二个目录）", async () => {
    const first = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const second = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    expect(second.envelopePath).toBe(first.envelopePath);
    expect(await listInbox()).toHaveLength(1);
  });

  it("缺 importId 时用 meta.bodyHash 当幂等键", async () => {
    const envelope = { ...ENVELOPE, importId: "" };
    const entry = await enqueueInbox(JSON.stringify(envelope), { ...META, bodyHash: "sha256:deadbeef12345678" });
    expect(entry.id).toBe("sha256:deadbeef12345678");
    expect((await listInboxDetails())[0].dirName).toMatch(/-sha256de$/);
  });

  it("内联附件落到条目自己的 assets/ 下（内容哈希前缀 + 去掉 dataBase64）", async () => {
    const bytes = new TextEncoder().encode("pixels");
    const base64 = btoa("pixels");
    const envelope = {
      ...ENVELOPE,
      assets: [{ name: "diagram.png", mime: "image/png", dataBase64: base64 }],
    };
    const entry = await enqueueInbox(JSON.stringify(envelope), META);
    const { dirName, assets } = (await listInboxDetails()).find((item) => item.entry.id === entry.id)!;
    expect(assets).toHaveLength(1);
    expect(assets[0].file).toMatch(/^assets\/[0-9a-f]{8}-diagram\.png$/);
    expect(assets[0].size).toBe(bytes.byteLength);
    const raw = JSON.parse(testBackend.files.get(`${INBOX_DIR}/${dirName}/entry.json`) as string) as {
      assets: { file?: string; dataBase64?: string }[];
    };
    expect(raw.assets[0].dataBase64).toBeUndefined();
    expect(raw.assets[0].file).toBe(assets[0].file);
  });

  it("spec 不是 opennote.import/v1 时拒绝（IMP-4002）", async () => {
    await expect(
      enqueueInbox(JSON.stringify({ ...ENVELOPE, spec: "opennote.import/v2" }), META),
    ).rejects.toMatchObject({ code: "IMP-4002" });
  });

  it("没有打开笔记本时如实失败（IMP-4007），不假装投递成功", async () => {
    const { closeWorkspace } = await import("./library");
    await closeWorkspace();
    await expect(enqueueInbox(JSON.stringify(ENVELOPE), META)).rejects.toBeInstanceOf(InboxError);
  });

  it("总量达到 500 时拒绝新投递（IMP-4013）并给出满额提示", async () => {
    for (let index = 0; index < INBOX_LIMIT; index += 1) {
      const id = `seed-${String(index).padStart(5, "0")}`;
      const dirName = `20260101T0000${String(index % 60).padStart(2, "0")}-${id.slice(0, 8)}-${index}`;
      testBackend.seed(
        `${INBOX_DIR}/${dirName}/entry.json`,
        JSON.stringify({
          spec: "opennote.import/v1",
          importId: id,
          title: `条目 ${index}`,
          body: null,
          bodyFile: "body.md",
          source: { url: null, capturedAt: "2026-01-01T00:00:00Z" },
        }),
      );
      testBackend.seed(`${INBOX_DIR}/${dirName}/body.md`, "正文");
      testBackend.seed(`${INBOX_DIR}/${dirName}/state.json`, JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: "2026-01-01T00:00:00.000Z" }));
    }
    await refreshInbox();
    expect(await listInbox()).toHaveLength(INBOX_LIMIT);
    await expect(enqueueInbox(JSON.stringify(ENVELOPE), META)).rejects.toMatchObject({
      code: "IMP-4013",
      userMessage: INBOX_FULL_MESSAGE,
    });
    expect(INBOX_FULL_MESSAGE).toBe("收件箱已满（500 条），请先处理一些条目。");
  });
});

/* ------------------------------ 状态迁移 ------------------------------- */

describe("setInboxStatus：5 态", () => {
  it("pending → committing → committed 会同步写 state.json 与视图", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();

    await setInboxStatus(entry.id, "committing", { attempts: 1 });
    expect(readState(dirName)).toMatchObject({ status: "committing", attempts: 1 });
    expect((await readInboxEntry(entry.id))!.status).toBe("committing");

    await setInboxStatus(entry.id, "committed", { notePath: "读书笔记/中文排版指北.md" });
    const committed = (await readInboxEntry(entry.id))!;
    expect(committed.status).toBe("committed");
    expect(committed.notePath).toBe("读书笔记/中文排版指北.md");
    // 契约键的镜像与 UI 落点一致。
    expect(committed.committedPath).toBe(committed.notePath);
    expect(readState(dirName)).toMatchObject({
      status: "committed",
      committedPath: "读书笔记/中文排版指北.md",
    });
  });

  it("failed 记 lastError，界面文案取该 code 的中文文案", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "failed", { lastError: "IMP-4012" });
    const failed = (await readInboxEntry(entry.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("IMP-4012");
    expect(failed.message).toBe("有一个附件无法导入（格式不支持或太大）。");
    expect(failed.committedPath).toBeNull();
  });

  it("committed 与 failed 都保留在收件箱里（队列保留期，不是回收站）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "committed", { notePath: "读书笔记/中文排版指北.md" });
    expect(await listInbox()).toHaveLength(1);
  });
});

/* -------------------------------- 入库 --------------------------------- */

describe("commitInbox：确认入库", () => {
  it("调接收端（channel: inbox）→ committed + notePath，并在工作区里可见", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const calls = installReceiver();

    await commitInbox(entry.id);

    expect(calls).toHaveLength(1);
    expect(calls[0].meta).toEqual({ channel: "inbox" });
    // 交给接收端的是**内联**信封：正文回来了、bodyFile 消失。
    expect(calls[0].envelope.body).toBe(ENVELOPE.body);
    expect(calls[0].envelope.bodyFile).toBeUndefined();
    expect((calls[0].envelope.source as { capturedAt: string }).capturedAt).toBe("2026-09-29T14:26:00+08:00");

    const committed = (await readInboxEntry(entry.id))!;
    expect(committed.status).toBe("committed");
    expect(committed.notePath).toBe("读书笔记/中文排版指北.md");
    expect(committed.committedPath).toBe(committed.notePath);
    expect(committed.attempts).toBe(1);

    // 入库后界面 3 秒内可见：工作区已重扫，笔记在内存里。
    expect(Object.keys(getLibrary().notes)).toContain("读书笔记/中文排版指北.md");
    expect(inboxCount()).toBe(0);
  });

  it("再次 commit 已入库的条目是幂等的（不重复调接收端）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const calls = installReceiver();
    await commitInbox(entry.id);
    await commitInbox(entry.id);
    expect(calls).toHaveLength(1);
  });

  it("commitInboxResult 交回接收端的 ImportResult（IPC 转交层要的形状）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    installReceiver();
    const result = await commitInboxResult(entry.id);
    expect(result).toMatchObject({ status: "created", path: "读书笔记/中文排版指北.md", importId: ENVELOPE.importId });
    // 幂等：第二次返回 null（已入库，不重复写盘）。
    expect(await commitInboxResult(entry.id)).toBeNull();
  });

  it("并发护栏：两次同时入库只跑一遍接收端，第二次 IMP-4020", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    setInboxReceiver(async () => {
      calls += 1;
      await gate;
      return importResult();
    });

    const first = commitInbox(entry.id);
    const second = commitInbox(entry.id).catch((error: unknown) => error);
    // 第二次立刻被同进程护栏挡住，不需要等 gate。
    const failure = await second;
    expect(failure).toBeInstanceOf(InboxError);
    expect((failure as InboxError).code).toBe("IMP-4020");

    release();
    await first;
    expect(calls).toBe(1);
    expect((await readInboxEntry(entry.id))!.status).toBe("committed");
  });

  it("入库途中被丢弃：不复活条目目录、不写 state.json", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    let reached = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setInboxReceiver(async () => {
      reached = true;
      await gate;
      return importResult();
    });

    const running = commitInbox(entry.id);
    for (let tick = 0; tick < 200 && !reached; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(reached).toBe(true);
    await discardInbox(entry.id);
    release();
    await running.catch(() => undefined);

    // 目录树必须保持「被丢弃」的样子：没有 state.json / entry.json / body.md。
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}`)).toEqual([]);
    expect(await listInbox()).toHaveLength(0);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
  });

  it("入库时条目已不存在 → IMP-4017（幂等丢弃之后不留悬空状态）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await discardInbox(entry.id);
    await expect(commitInbox(entry.id)).rejects.toMatchObject({ code: "IMP-4017" });
  });

  it("接收端抛 ImportRejection 时：状态 failed + lastError 记 code，并把错误抛给界面", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(async () => {
      throw Object.assign(new Error("boom"), { code: "IMP-4012", userMessage: "有一个附件无法导入（格式不支持或太大）。" });
    });

    const failure = await commitInbox(entry.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InboxError);
    expect((failure as InboxError).code).toBe("IMP-4012");

    const dirName = await firstDirName();
    expect(readState(dirName)).toMatchObject({ status: "failed", lastError: "IMP-4012", attempts: 1 });
    const failed = (await readInboxEntry(entry.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.message).toBe("有一个附件无法导入（格式不支持或太大）。");
    // 条目仍在收件箱里，用户可以重试或丢弃。
    expect(await listInbox()).toHaveLength(1);
  });

  it("没有注册接收端时走 C1 的真实接收端（`src/lib/clip/receive.ts`），笔记真的落盘", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(null);

    await commitInbox(entry.id);

    const committed = (await readInboxEntry(entry.id))!;
    expect(committed.status).toBe("committed");
    expect(committed.notePath).toBe("读书笔记/中文排版指北.md");
    expect(committed.committedPath).toBe(committed.notePath);
    expect(testBackend.files.has("读书笔记/中文排版指北.md")).toBe(true);
    expect(Object.keys(getLibrary().notes)).toContain("读书笔记/中文排版指北.md");
  });

  it("接收端抛普通异常（无 code）时归到 IMP-5001，并把条目留在收件箱里", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(async () => {
      throw new Error("ENOSPC");
    });
    await expect(commitInbox(entry.id)).rejects.toMatchObject({ code: "IMP-5001" });
    const failed = (await readInboxEntry(entry.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("IMP-5001");
    expect(failed.message).toBe("写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。");
  });
});

/* --------------------- 落点覆盖（00 §6.14㉜） --------------------- */

/**
 * 「在收件箱里把文件保存到相应的位置」：`commitInboxResult(id, { folder })`
 * 覆盖信封的 `target.folder`。不传 = 0.2.0 行为；`null`/`""` = 根；非法 = `IMP-4008`
 * 且**一个字节都不写**（走 `normalizeFolder` = `assertSafeRelative` + 逐段 sanitize）。
 */
describe("commitInboxResult(id, { folder })：入库前选落点", () => {
  const ILLEGAL = [
    "../逃逸",
    "a/../../逃逸",
    "/etc/passwd",
    "C:/Windows",
    "C:ws",
    "\\\\server\\share",
    "剪藏:ADS",
    "a\\b",
    "a\0b",
    "剪藏/../../../etc",
  ];

  it("① 指定目录 → 笔记落到该目录（目录不存在时与信封同一套规则：逐段创建）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(null); // 走 C1 的真实接收端

    const result = await commitInboxResult(entry.id, { folder: "剪藏/新目录" });

    expect(result).toMatchObject({ status: "created", path: "剪藏/新目录/中文排版指北.md" });
    const committed = (await readInboxEntry(entry.id))!;
    expect(committed.status).toBe("committed");
    expect(committed.notePath).toBe("剪藏/新目录/中文排版指北.md");
    expect(committed.committedPath).toBe(committed.notePath);
    expect(readState(await firstDirName()).committedPath).toBe("剪藏/新目录/中文排版指北.md");
    expect(testBackend.files.has("剪藏/新目录/中文排版指北.md")).toBe(true);
    expect(testBackend.dirs.has("剪藏/新目录")).toBe(true);
    expect(Object.keys(getLibrary().notes)).toContain("剪藏/新目录/中文排版指北.md");
    // 信封里的 读书笔记 没有被写入。
    expect(testBackend.files.has("读书笔记/中文排版指北.md")).toBe(false);
  });

  it("② { folder: null } 与 { folder: \"\" } → 工作区根目录", async () => {
    for (const folder of [null, ""] as const) {
      const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
      const calls = installReceiver();
      await commitInboxResult(entry.id, { folder });
      const envelope = calls[0].envelope as { target: { folder: string | null } };
      expect(envelope.target.folder, `folder=${JSON.stringify(folder)}`).toBeNull();
      const committed = (await readInboxEntry(entry.id))!;
      expect(committed.notePath).toBe("中文排版指北.md");
      expect(testBackend.files.has("中文排版指北.md")).toBe(true);
      expect(testBackend.files.has("读书笔记/中文排版指北.md")).toBe(false);
      await discardInbox(entry.id);
    }
  });

  it("③ 不传 folder → 与 0.2.0 完全一致（沿用信封 target.folder）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const calls = installReceiver();
    await commitInboxResult(entry.id);
    expect((calls[0].envelope as { target: { folder: string | null } }).target.folder).toBe("读书笔记");
    expect((await readInboxEntry(entry.id))!.notePath).toBe("读书笔记/中文排版指北.md");
  });

  it("③b commitInbox(id) 签名与行为不变（只能沿用信封）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const calls = installReceiver();
    await commitInbox(entry.id);
    expect((calls[0].envelope as { target: { folder: string | null } }).target.folder).toBe("读书笔记");
    expect((await readInboxEntry(entry.id))!.notePath).toBe("读书笔记/中文排版指北.md");
  });

  it("④ 非法落点一律 IMP-4008：不写盘、不调接收端、条目仍 pending", async () => {
    for (const folder of ILLEGAL) {
      const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
      const dirName = await firstDirName();
      const receiverCalls = installReceiver();
      const filesBefore = [...testBackend.files.keys()].sort();
      const dirsBefore = [...testBackend.dirs].sort();
      const stateBefore = readState(dirName);
      const mark = testBackend.calls.length;

      await expect(commitInboxResult(entry.id, { folder }), `folder=${JSON.stringify(folder)}`).rejects.toMatchObject({
        code: "IMP-4008",
        userMessage: "目标目录不合法：不能使用 ..、绝对路径或系统保留字符。",
      });

      // 一个字节都没写：文件、目录、state.json、接收端调用次数全部不变。
      expect([...testBackend.files.keys()].sort(), folder).toEqual(filesBefore);
      expect([...testBackend.dirs].sort(), folder).toEqual(dirsBefore);
      expect(readState(dirName), folder).toEqual(stateBefore);
      expect(testBackend.calls.slice(mark), folder).toEqual([]);
      expect(receiverCalls, folder).toHaveLength(0);
      const after = (await readInboxEntry(entry.id))!;
      expect(after.status, folder).toBe("pending");
      expect(after.attempts, folder).toBe(0);
      // 越界串绝不进任何路径。
      expect([...testBackend.files.keys()].some((path) => path.includes("逃逸") || path.includes("etc/passwd"))).toBe(false);
      await discardInbox(entry.id);
    }
  });

  it("④e 纵深防御：就算本层预校验被绕过，接收端的落点层也会拒（02 §7.3）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(null); // C1 的真实接收端
    const filesBefore = [...testBackend.files.keys()].sort();
    await expect(commitInboxResult(entry.id, { folder: "../逃逸" })).rejects.toMatchObject({ code: "IMP-4008" });
    // 没有任何笔记落到工作区外（内存后端里连一条带 `..` 的路径都不该出现）。
    expect([...testBackend.files.keys()].sort()).toEqual(filesBefore);
    expect([...testBackend.files.keys()].some((path) => path.includes(".."))).toBe(false);
    expect((await readInboxEntry(entry.id))!.status).toBe("pending");
  });

  it("④b resolveInboxFolder：合法值按信封同一套规则规范化，根目录统一成 \"\"", () => {
    expect(resolveInboxFolder("剪藏//技术/")).toBe("剪藏/技术");
    expect(resolveInboxFolder("./剪藏/./技术")).toBe("剪藏/技术");
    expect(resolveInboxFolder(null)).toBe("");
    expect(resolveInboxFolder(undefined)).toBe("");
    expect(resolveInboxFolder("")).toBe("");
    expect(resolveInboxFolder("   ")).toBe("");
    for (const folder of ILLEGAL) {
      expect(() => resolveInboxFolder(folder), folder).toThrow(InboxError);
    }
    // 层级上限 10（契约 §2.4）。
    expect(() => resolveInboxFolder(Array.from({ length: 11 }, (_, index) => `d${index}`).join("/"))).toThrow(/不合法/);
  });

  it("④c 覆盖值与信封值走同一套规范化：两种写法的落点一致", async () => {
    const byEnvelope = await enqueueInbox(
      JSON.stringify({
        ...ENVELOPE,
        importId: "env-0001-aaaa",
        title: "第一篇",
        body: "第一篇的正文。",
        source: { ...ENVELOPE.source, url: "https://example.com/first" },
        target: { folder: "读书笔记//技术", notePath: null },
      }),
      { ...META, title: "第一篇", sourceUrl: "https://example.com/first", bodyHash: "sha256:env-0001" },
    );
    const byOption = await enqueueInbox(
      JSON.stringify({
        ...ENVELOPE,
        importId: "opt-0002-bbbb",
        title: "第二篇",
        body: "第二篇的正文，和第一篇不同。",
        source: { ...ENVELOPE.source, url: "https://example.com/second" },
        target: { folder: null, notePath: null },
      }),
      { ...META, title: "第二篇", sourceUrl: "https://example.com/second", targetFolder: null, bodyHash: "sha256:opt-0002" },
    );
    setInboxReceiver(null);

    await commitInbox(byEnvelope.id);
    await commitInboxResult(byOption.id, { folder: "读书笔记/技术" });

    const first = (await readInboxEntry(byEnvelope.id))!;
    const second = (await readInboxEntry(byOption.id))!;
    expect(first.notePath).toBe("读书笔记/技术/第一篇.md");
    expect(second.notePath).toBe("读书笔记/技术/第二篇.md");
    expect(parentPath(first.notePath!)).toBe(parentPath(second.notePath!));
  });

  it("④d 覆盖落点后 IP 转发层的返回形状不变（ImportResult.path = 实际落点）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const calls = installReceiver();
    const result = await commitInboxResult(entry.id, { folder: "速记" });
    expect(result).toMatchObject({ status: "created", importId: ENVELOPE.importId, path: "速记/中文排版指北.md" });
    expect(calls).toHaveLength(1);
  });
});

/* ------------------ 资产随笔记一起入库（task-31：图片跟笔记走） ------------------ */

/**
 * 设计（0.4.0 用户裁定）：图片统一落在**工作区根**的共享 `.assets/`（整库一个目录，
 * git 里不再每篇笔记多一个目录），正文引用是**按笔记所在目录层数**算出来的相对路径；
 * 从收件箱确认入库到 `{folder}` 时，引用必须跟着新位置重算。
 *
 * 端到端断言咬的是**性质**而不是散落的字面量：
 * ① 资产落点在共享 `.assets/` 里（不是条目目录、也不是按笔记名派生的目录）；
 * ② `正文里的相对引用` 按查看器语义（吃掉 `..`）解析后**恰好等于**那个资产文件。
 * 这两条正是「图片指得准」的定义 —— 「没搬资产」「搬了资产但正文没重写」「退回公共
 * `assets/`」三种情况都会红。落盘目录名由 C1 的 `landing.ts` 决定，字面断言在那边。
 */
describe("资产随笔记一起入库（task-31）", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2a, 0x2b, 0x2c, 0x2d]);
  const PNG_BASE64 = Buffer.from(PNG).toString("base64");
  const ASSET_NAME = "diagram.png";

  function assetEnvelope(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({
      ...ENVELOPE,
      title: "带图笔记",
      body: "看图：\n\n![图](./assets/diagram.png)\n",
      source: { ...ENVELOPE.source, url: "https://example.com/with-image" },
      target: { folder: null, notePath: null },
      assets: [{ name: ASSET_NAME, mime: "image/png", dataBase64: PNG_BASE64 }],
      ...patch,
    });
  }
  const assetMeta = () => ({
    ...META,
    title: "带图笔记",
    sourceUrl: "https://example.com/with-image",
    bodyHash: "sha256:with-image",
  });

  /** 正文里的第一个图片引用（`![…](ref)`）。 */
  const firstImageRef = (body: string) => /!\[[^\]]*\]\(([^)]+)\)/.exec(body)?.[1] ?? "";
  const bytesAt = (path: string) => new Uint8Array(testBackend.files.get(path) as Uint8Array);

  it("端到端：入到 {folder} → 笔记在目标目录、资产在共享 `.assets/`，正文引用指得准（① ②）", async () => {
    const entry = await enqueueInbox(assetEnvelope(), assetMeta());
    const dirName = await firstDirName();
    // 待确认期间：资产在条目自己的 `assets/` 下，`entry.json` 的 `assets[].file` 是条目相对路径。
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}/assets`)).toHaveLength(1);
    setInboxReceiver(null); // C1 的真实接收端

    const result = await commitInboxResult(entry.id, { folder: "剪藏/技术" });
    const notePath = result?.path ?? "";

    expect(notePath).toBe("剪藏/技术/带图笔记.md");
    // ① 资产落进**共享** `.assets/`（不是留在收件箱、不是按笔记名派生的目录），字节原样。
    expect(result?.assets).toHaveLength(1);
    const assetPath = result!.assets[0];
    expect(parentPath(assetPath)).toBe(".assets");
    expect(bytesAt(assetPath)).toEqual(PNG);
    // ② 正文里的引用是相对路径，且按查看器语义解析后**恰好**是那个资产文件。
    //    笔记在 `剪藏/技术/` 下两层 ⇒ 引用带两条 `../`，少了就是裂图（而且不报错）。
    const ref = firstImageRef(String(testBackend.files.get(notePath)));
    expect(ref).not.toBe("");
    expect(ref.startsWith("/")).toBe(false);
    expect(ref.startsWith("../../.assets/")).toBe(true);
    expect(resolveWorkspacePath(ref, parentPath(notePath))).toBe(assetPath);
    // 源目录无残留：条目里的**暂存副本**已删（条目本身按 24h 保留期留着当记录）。
    expect(testBackend.dirs.has(`${INBOX_DIR}/${dirName}/assets`)).toBe(false);
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}/assets`)).toEqual([]);
    // 没落到信封的旧落点，也没落到工作区根。
    expect(testBackend.files.has("读书笔记/带图笔记.md")).toBe(false);
    expect(testBackend.files.has("带图笔记.md")).toBe(false);
  });

  it("② 的敏感性：正文引用一个不存在的资产名 → 引用指不到真实文件（该断言会红）", async () => {
    const entry = await enqueueInbox(
      assetEnvelope({ body: "看图：\n\n![图](./assets/wrong-name.png)\n" }),
      assetMeta(),
    );
    setInboxReceiver(null);
    const result = await commitInboxResult(entry.id, { folder: "剪藏/技术" });
    const notePath = result!.path!;
    const ref = firstImageRef(String(testBackend.files.get(notePath)));
    const resolved = joinPath(parentPath(notePath), ref.replace(/^\.\//, ""));

    expect(resolved).not.toBe(result!.assets[0]);
    expect(testBackend.files.has(resolved)).toBe(false); // 断图 —— 正是 ② 要盖住的东西
  });

  it("幂等：重复提交不重复搬、不留第二份资产、不留孤儿目录", async () => {
    const entry = await enqueueInbox(assetEnvelope(), assetMeta());
    setInboxReceiver(null);
    const first = await commitInboxResult(entry.id, { folder: "剪藏/技术" });
    const assetPath = first!.assets[0];
    const treeBefore = testBackend.pathsUnder("剪藏").sort();
    const mark = testBackend.calls.length;

    const second = await commitInboxResult(entry.id, { folder: "剪藏/技术" });

    expect(second).toBeNull(); // 已入库 → 幂等返回，不重复写盘
    expect(testBackend.pathsUnder("剪藏").sort()).toEqual(treeBefore); // 没有第二份、没有 ` 2`
    expect(bytesAt(assetPath)).toEqual(PNG);
    expect(testBackend.calls.slice(mark).filter((call) => call.startsWith("write:"))).toEqual([]);
  });

  it("③ discarded：资产随条目立即删除，不进回收站", async () => {
    const entry = await enqueueInbox(assetEnvelope(), assetMeta());
    const dirName = await firstDirName();
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}/assets`)).toHaveLength(1);

    await discardInbox(entry.id);

    expect(testBackend.pathsUnder(INBOX_DIR)).toEqual([]);
    expect([...testBackend.dirs, ...testBackend.files.keys()].filter((path) => path.startsWith(".opennote/trash"))).toEqual([]);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
  });

  it("③b 已入库的条目被丢弃：只删条目记录，笔记与资产都留着", async () => {
    const entry = await enqueueInbox(assetEnvelope(), assetMeta());
    setInboxReceiver(null);
    const result = await commitInboxResult(entry.id, { folder: "剪藏/技术" });
    const notePath = result!.path!;
    const assetPath = result!.assets[0];

    await discardInbox(entry.id);

    expect(testBackend.pathsUnder(INBOX_DIR)).toEqual([]); // 记录没了
    expect(testBackend.files.has(notePath)).toBe(true); // 笔记还在
    expect(testBackend.files.has(assetPath)).toBe(true); // 资产跟着笔记走，不跟着记录走
  });

  it("④ 资产路径逃逸（`../`、绝对路径）：就地 IMP-4012 如实拒，接收端一次都不调", async () => {
    for (const file of ["../逃逸.png", "assets/../../逃逸.png", "/etc/逃逸.png", "C:/逃逸.png"]) {
      const entry = await enqueueInbox(assetEnvelope(), assetMeta());
      const dirName = await firstDirName();
      // 手工写坏 entry.json（真实投递路径会经过 validateEnvelope，这里模拟被改坏的条目）。
      const entryPath = `${INBOX_DIR}/${dirName}/entry.json`;
      const envelope = JSON.parse(String(testBackend.files.get(entryPath))) as Record<string, unknown>;
      envelope.assets = [{ name: ASSET_NAME, mime: "image/png", file }];
      testBackend.files.set(entryPath, JSON.stringify(envelope));
      const receiverCalls = installReceiver();
      const mark = testBackend.calls.length;

      await expect(commitInboxResult(entry.id), file).rejects.toMatchObject({ code: "IMP-4012" });

      // 下游一次都没被调用：那个语义含糊的 `file` 没有流到接收端。
      expect(receiverCalls, file).toHaveLength(0);
      // 也绝没有把条目相对路径当成**工作区根**路径去读（`resolveAssetBytes` 的基准差异）。
      expect(testBackend.calls.slice(mark).filter((call) => call.includes("..")), file).toEqual([]);
      // 如实失败：状态、错误码、中文文案都对得上，不是静默成功。
      const after = (await readInboxEntry(entry.id))!;
      expect(after.status, file).toBe("failed");
      expect(after.lastError, file).toBe("IMP-4012");
      expect(after.message, file).toBe("有一个附件无法导入（格式不支持或太大）。");
      await discardInbox(entry.id);
    }
  });

  it("④b 资产文件缺失（file 指向条目里不存在的文件）→ 同样 IMP-4012 如实失败", async () => {
    const entry = await enqueueInbox(assetEnvelope(), assetMeta());
    const dirName = await firstDirName();
    const entryPath = `${INBOX_DIR}/${dirName}/entry.json`;
    const envelope = JSON.parse(String(testBackend.files.get(entryPath))) as Record<string, unknown>;
    envelope.assets = [{ name: ASSET_NAME, mime: "image/png", file: "assets/不存在.png" }];
    testBackend.files.set(entryPath, JSON.stringify(envelope));
    const receiverCalls = installReceiver();

    await expect(commitInboxResult(entry.id)).rejects.toMatchObject({ code: "IMP-4012" });

    expect(receiverCalls).toHaveLength(0);
    const after = (await readInboxEntry(entry.id))!;
    expect(after.status).toBe("failed");
    expect(after.lastError).toBe("IMP-4012");
    // 暂存资产还在 → 用户修好之后可以重试。
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}/assets`)).toHaveLength(1);
  });

  it("面板：有附件时如实显示数量（不画点不动的按钮）", async () => {
    await enqueueInbox(assetEnvelope(), assetMeta());
    const html = await renderPanel();
    expect(html).toContain("附件 · 1");
    expect(html).toContain(ASSET_NAME);
  });
});

/* -------------------------------- 丢弃 --------------------------------- */

describe("discardInbox：立即清理、不进回收站", () => {
  it("条目目录与内容立即消失，trash 条目数不变（0）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    const trashBefore = [...testBackend.dirs, ...testBackend.files.keys()].filter((path) => path.startsWith(".opennote/trash"));
    expect(trashBefore).toEqual([]);

    await discardInbox(entry.id);

    // 目录、entry.json、body.md、state.json、assets 全部没了。
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}`)).toEqual([]);
    expect(testBackend.dirs.has(`${INBOX_DIR}/${dirName}`)).toBe(false);
    expect(await listInbox()).toHaveLength(0);
    expect(inboxCount()).toBe(0);

    // 不进回收站：没有 trash 目录/文件，也没有任何 move 到 trash 的调用。
    expect([...testBackend.dirs, ...testBackend.files.keys()].filter((path) => path.startsWith(".opennote/trash"))).toEqual([]);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
    // 正文没有被「救」到别处。
    expect(testBackend.pathsUnder(INBOX_DIR)).toEqual([]);
  });

  it("重复丢弃：第二次明确抛 IMP-4017，绝不静默返回", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await discardInbox(entry.id);
    await expect(discardInbox(entry.id)).rejects.toMatchObject({
      code: "IMP-4017",
      userMessage: "没有找到这条导入记录。",
    });
    expect(await listInbox()).toHaveLength(0);
  });

  it("丢弃不存在的名字：抛 IMP-4017（静默成功是 §8 反模式）", async () => {
    await expect(discardInbox("20260101T000000-deadbeef")).rejects.toBeInstanceOf(InboxError);
    await expect(discardInbox("不存在的名字")).rejects.toMatchObject({ code: "IMP-4017" });
    expect(await listInbox()).toHaveLength(0);
  });

  it("setInboxStatus(id, \"discarded\") 等价于丢弃（销毁动作，不写状态）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    await setInboxStatus(entry.id, "discarded");
    expect(testBackend.files.has(statePath(dirName))).toBe(false);
    expect(await listInbox()).toHaveLength(0);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
  });

  it("丢弃一条 failed 条目同样不进回收站", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "failed", { lastError: "IMP-5001" });
    await discardInbox(entry.id);
    expect(await listInbox()).toHaveLength(0);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
  });
});

/* ----------------------------- 保留期清理 ------------------------------ */

/* ------------------- inboxId = 目录名（契约 §5.8.2） ------------------- */

/**
 * `02:719` 逐字规定：回执里的 `inboxId` **就是 §5.8.2 的条目目录名**，
 * 因此目录名是客户端唯一的抓手，必须能被四个入口原样接受；
 * 认不出来时**必须报 `IMP-4017`**，不能静默成功（§8 反模式）。
 */
describe("inboxId（条目目录名）也是合法抓手", () => {
  async function dirNameOf(id: string): Promise<string> {
    return (await listInboxDetails()).find((detail) => detail.entry.id === id)!.dirName;
  }

  it("readInboxEntry(目录名) 与 readInboxEntry(importId) 结果一致", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await dirNameOf(entry.id);
    const byId = (await readInboxEntry(entry.id))!;
    const byDir = (await readInboxEntry(dirName))!;
    expect(byDir.id).toBe(byId.id);
    expect(byDir.envelopePath).toBe(byId.envelopePath);
    expect(byDir.envelopePath).toBe(`${INBOX_DIR}/${dirName}/entry.json`);
  });

  it("setInboxStatus(目录名, …) 生效", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await dirNameOf(entry.id);
    await setInboxStatus(dirName, "committing", { attempts: 2 });
    expect(readState(dirName)).toMatchObject({ status: "committing", attempts: 2 });
    expect((await readInboxEntry(entry.id))!.status).toBe("committing");
  });

  it("commitInbox(目录名) 成功入库（Verifier 探针 S5.8b 的场景）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await dirNameOf(entry.id);
    installReceiver();
    await commitInbox(dirName);
    const committed = (await readInboxEntry(entry.id))!;
    expect(committed.status).toBe("committed");
    expect(committed.notePath).toBe("读书笔记/中文排版指北.md");
    expect(committed.committedPath).toBe(committed.notePath);
    expect(testBackend.files.has("读书笔记/中文排版指北.md")).toBe(true);
  });

  it("discardInbox(目录名)：条目目录整棵消失、不进回收站", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await dirNameOf(entry.id);
    await discardInbox(dirName);
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${dirName}`)).toEqual([]);
    expect(testBackend.dirs.has(`${INBOX_DIR}/${dirName}`)).toBe(false);
    expect(await listInbox()).toHaveLength(0);
    expect(inboxCount()).toBe(0);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
  });

  it("两条路径行为一致：一条按 importId 丢、一条按目录名丢", async () => {
    const first = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const second = await enqueueInbox(JSON.stringify({ ...ENVELOPE, importId: "second-id-0001" }), META);
    const firstDir = await dirNameOf(first.id);
    const secondDir = await dirNameOf(second.id);
    await discardInbox(first.id); // 按 importId
    await discardInbox(secondDir); // 按目录名
    expect(await listInbox()).toHaveLength(0);
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${firstDir}`)).toEqual([]);
    expect(testBackend.pathsUnder(`${INBOX_DIR}/${secondDir}`)).toEqual([]);
  });

  it("目录名必须是精确匹配：前缀/加后缀不算命中，报 IMP-4017", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await dirNameOf(entry.id);
    await expect(discardInbox(`${dirName}-x`)).rejects.toMatchObject({ code: "IMP-4017" });
    await expect(commitInbox(`${dirName}0`)).rejects.toMatchObject({ code: "IMP-4017" });
    // 仍然在收件箱里，没有被误丢。
    expect((await readInboxEntry(entry.id))!.status).toBe("pending");
  });
});

describe("cleanupInbox：保留期", () => {
  it("committed 超过 24 小时被清、24 小时内保留", async () => {
    const old = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const fresh = await enqueueInbox(JSON.stringify({ ...ENVELOPE, importId: "fresh-id-0001" }), META);
    const now = Date.now();
    await setInboxStatus(old.id, "committed", { notePath: "a.md", updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() });
    await setInboxStatus(fresh.id, "committed", { notePath: "b.md", updatedAt: new Date(now - 60 * 60 * 1000).toISOString() });

    expect(await cleanupInbox(now)).toBe(1);
    const left = await listInbox();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(fresh.id);
  });

  it("failed 超过 7 天被清、7 天内保留", async () => {
    const old = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const fresh = await enqueueInbox(JSON.stringify({ ...ENVELOPE, importId: "fresh-id-0002" }), META);
    const now = Date.now();
    await setInboxStatus(old.id, "failed", { lastError: "IMP-5001", updatedAt: new Date(now - 8 * DAY).toISOString() });
    await setInboxStatus(fresh.id, "failed", { lastError: "IMP-5001", updatedAt: new Date(now - 6 * DAY).toISOString() });

    expect(await cleanupInbox(now)).toBe(1);
    const left = await listInbox();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(fresh.id);
  });

  it("pending 与 committing 不设期限：再久也不清", async () => {
    const pending = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const committing = await enqueueInbox(JSON.stringify({ ...ENVELOPE, importId: "committing-id-1" }), META);
    const long = new Date(Date.now() - 400 * DAY).toISOString();
    await setInboxStatus(pending.id, "pending", { updatedAt: long });
    await setInboxStatus(committing.id, "committing", { attempts: 3, updatedAt: long });

    expect(await cleanupInbox(Date.now())).toBe(0);
    expect(await listInbox()).toHaveLength(2);
  });

  it("清理也不进回收站", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const now = Date.now();
    await setInboxStatus(entry.id, "committed", { notePath: "a.md", updatedAt: new Date(now - 30 * 60 * 60 * 1000).toISOString() });
    await cleanupInbox(now);
    expect(testBackend.calls.filter((call) => call.includes(".opennote/trash"))).toEqual([]);
  });
});

/* ------------------------------- 原子写 -------------------------------- */

describe("原子写", () => {
  it("state.json / entry.json 写完不留 *.tmp，且始终是可解析的 JSON", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    await setInboxStatus(entry.id, "committing", { attempts: 1 });
    await setInboxStatus(entry.id, "failed", { lastError: "IMP-5001" });
    await setInboxStatus(entry.id, "pending");
    installReceiver();
    await commitInbox(entry.id);

    const paths = testBackend.pathsUnder(`${INBOX_DIR}/${dirName}`);
    expect(paths.filter((path) => path.endsWith(".tmp"))).toEqual([]);
    for (const path of paths) {
      if (!path.endsWith(".json")) continue;
      expect(() => JSON.parse(testBackend.files.get(path) as string)).not.toThrow();
    }
  });

  it("上一次崩溃留下的陈旧 *.tmp 会被写盘路径清掉", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    testBackend.seed(`${statePath(dirName)}.tmp`, "{ 半截的 ");
    await setInboxStatus(entry.id, "committing");
    expect(testBackend.files.has(`${statePath(dirName)}.tmp`)).toBe(false);
  });

  it("state.json 被写坏时备份为 .corrupt-*，条目按 pending 继续（不静默丢内容）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    testBackend.seed(statePath(dirName), "{ 这不是 JSON");

    const detail = (await readInboxDetailById(entry.id))!;
    expect(detail.entry.status).toBe("pending");
    const backups = testBackend.pathsUnder(`${INBOX_DIR}/${dirName}`).filter((path) => path.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(testBackend.files.get(statePath(dirName)) as string)).toMatchObject({ status: "pending" });
  });
});

async function readInboxDetailById(id: string) {
  const { readInboxDetail } = await import("./inbox");
  return readInboxDetail(id);
}

/* ---------------------------- 外部投递场景 ----------------------------- */

describe("外部投递（Verifier 的手工场景）", () => {
  /** 手工构造一个条目目录，等价于「别的程序往 .opennote/inbox/ 里投了一个信封」。 */
  function seedExternalEntry(options: { dirName: string; importId: string; title?: string }): void {
    const dir = `${INBOX_DIR}/${options.dirName}`;
    testBackend.seed(
      `${dir}/entry.json`,
      JSON.stringify(
        {
          spec: "opennote.import/v1",
          importId: options.importId,
          title: options.title ?? "离线剪藏",
          body: null,
          bodyFile: "body.md",
          source: { url: "https://example.com/a", site: "example.com", capturedAt: "2026-09-29T21:10:11+08:00" },
          target: { folder: "剪藏", notePath: null },
          conflict: "new",
          tags: ["剪藏"],
          client: { name: "cli", version: "0.3.0" },
          enqueuedAt: "2026-09-29T21:10:11+08:00",
        },
        null,
        2,
      ),
    );
    testBackend.seed(`${dir}/body.md`, "在应用没运行时投递的正文。");
    testBackend.seed(
      `${dir}/state.json`,
      JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: "2026-09-29T21:10:11.000Z" }),
    );
  }

  it("刷新后计数 +1，字段与客户端口径正确", async () => {
    expect(inboxCount()).toBe(0);
    seedExternalEntry({ dirName: "20260929T131011-8c2f1e40", importId: "8c2f1e40-1b77-4a0e-9c53-6d1a2b3c4d5e" });

    await refreshInbox();

    expect(inboxCount()).toBe(1);
    const detail = (await listInboxDetails())[0];
    expect(detail.dirName).toBe("20260929T131011-8c2f1e40");
    expect(detail.entry.title).toBe("离线剪藏");
    expect(detail.entry.status).toBe("pending");
    expect(detail.entry.targetFolder).toBe("剪藏");
    expect(detail.entry.envelopePath).toBe(`${INBOX_DIR}/20260929T131011-8c2f1e40/entry.json`);
    expect(detail.site).toBe("example.com");
    expect(detail.capturedAt).toBe(Date.parse("2026-09-29T21:10:11+08:00"));
    expect(detail.clientName).toBe("cli");
    expect(detail.clientLabel).toBe("命令行");
    expect(detail.clientVersion).toBe("0.3.0");
    // 客户端身份可识别时不加「外部」小字；只有身份不明的信封才加。
    expect(detail.external).toBe(false);
    expect(detail.conflict).toBe("new");

    // 外置正文按需读出。
    const withBody = await readInboxDetailById(detail.entry.id);
    expect(withBody?.bodyText).toContain("在应用没运行时投递的正文。");
  });

  it("同 importId 的第二个条目只处理第一个：第二个标 failed + IMP-4017，且不反复写盘", async () => {
    seedExternalEntry({ dirName: "20260929T131011-8c2f1e40", importId: "dup-id-0001" });
    seedExternalEntry({ dirName: "20260929T131522-c41d9f77", importId: "dup-id-0001" });

    await refreshInbox();
    expect(await listInbox()).toHaveLength(2);
    const second = readState("20260929T131522-c41d9f77");
    expect(second).toMatchObject({ status: "failed", lastError: "IMP-4017" });

    const writesBefore = testBackend.calls.filter((call) => call === `write:${statePath("20260929T131522-c41d9f77")}`).length;
    await refreshInbox();
    const writesAfter = testBackend.calls.filter((call) => call === `write:${statePath("20260929T131522-c41d9f77")}`).length;
    expect(writesAfter).toBe(writesBefore);
  });

  it("overwrite 不渲染：收件箱通道一律忽略它", async () => {
    const dir = `${INBOX_DIR}/20260929T140000-abcdef01`;
    testBackend.seed(
      `${dir}/entry.json`,
      JSON.stringify({
        spec: "opennote.import/v1",
        importId: "abcdef01-0000-0000-0000-000000000000",
        title: "覆盖请求",
        body: "正文",
        source: { url: "https://example.com/x", capturedAt: "2026-09-29T14:00:00+08:00" },
        conflict: "overwrite",
      }),
    );
    testBackend.seed(`${dir}/state.json`, JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: "2026-09-29T14:00:00.000Z" }));
    await refreshInbox();
    expect((await listInboxDetails())[0].conflict).toBe("new");
    // 信封里没有 `client` → 身份不明，列表要打「外部」小字。
    expect((await listInboxDetails())[0].clientName).toBe("other");
    expect((await listInboxDetails())[0].external).toBe(true);
  });
});

/* ------------------------------ 面板渲染 ------------------------------- */

/**
 * `InboxPanel` 在 node 环境下用 `react-dom/server` 渲染：
 * `src/lib/store.ts` 的 `useStore` 传了 `getServerSnapshot`，所以这里能拿到**真实 DOM 字符串**
 * 逐字核对文案（`effect` 不跑、点击模拟不了，因此只覆盖首屏分支）。
 *
 * `filter` 走面板的 `initialFilter`：默认「待确认」（0.3.3 用户要求 #1），失败条目与已入库
 * 条目只出现在「全部」栏里 —— 没有这个入参，那两条分支的首屏文案就一条也盖不到。
 */
async function renderPanel(filter?: "all" | "pending"): Promise<string> {
  const [{ createElement }, { renderToStaticMarkup }, { InboxPanel }] = await Promise.all([
    import("react"),
    import("react-dom/server"),
    import("../components/InboxPanel"),
  ]);
  return renderToStaticMarkup(
    createElement(InboxPanel, { open: true, onClose: () => undefined, initialFilter: filter }),
  );
}

describe("InboxPanel 首屏（逐字文案冻结）", () => {
  it("默认停在「待确认」：筛选只剩两栏，条目、落点、动作都在", async () => {
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();

    expect(html).toContain("导入收件箱");
    expect(html).toContain("全部 1");
    expect(html).toContain("待确认 1");
    // 0.3.3：`失败` 那一栏删掉，筛选只有 全部 / 待确认 两个 role="radio"，且默认选中待确认。
    expect(html.match(/role="radio"/g) ?? []).toHaveLength(2);
    expect(html).not.toContain("失败 0");
    expect(html).toMatch(/<button type="button" role="radio" aria-checked="true"[^>]*>待确认 1<\/button>/);
    expect(html).toContain("中文排版指北");
    expect(html).toContain("插件");
    expect(html).toContain("收件箱在 .opennote/inbox/");
    // 落点：目录 / 文件名。
    expect(html).toContain("读书笔记");
    expect(html).toContain("中文排版指北.md");
    // 动作区。
    expect(html).toContain("在浏览器中打开来源");
    expect(html).toContain("跳过这次");
    expect(html).toContain("入库");
    // 「保存到」选择器（0.3.0）：根目录 + 既有文件夹树，最终落点说明句。
    // 0.3.4 起换成自定义下拉：候选项只在**展开时**才渲染，所以首屏只剩触发器，
    // 它显示的是**当前值**（这里 = 信封落点「读书笔记」）。候选项本身由
    // `saveToOptionsFor()` 直接断言（下一条测试）。
    expect(html).toContain("保存到");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("入库到「读书笔记」。");
    // 丢弃是销毁动作：面板里不得出现任何「恢复」入口。
    expect(html).not.toContain("恢复");
    expect(html).not.toMatch(/30\s*天/);
  });

  /*
   * 0.4.x（用户原话「红框所示位置增加两个 tab，默认为第一个预览，第二个为信息」）：
   * 右详情栏从「一条竖着堆到底的长列」改成两个标签页 —— 预览页整栏留给正文（原来正文被压在
   * 最底下、`max-height: 150px`），信息页装落点 / 来源信息 / 标签 / 附件 / 详情那一整套。
   * 下面三条分别咬住：**结构**（默认选中谁、谁带 hidden）、**内容归属**（谁在谁的页里，
   * 判据是 DOM 顺序而不是「字符串在不在」）、以及正文为空时那页不许留空框。
   */
  it("详情栏两个标签页：默认「预览」，正文归预览页、元数据归信息页", async () => {
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();

    // ① 标签行：role=tablist + 恰好两个 role=tab，标签逐字「预览」「信息」。
    expect(html).toContain('role="tablist"');
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>[^<]*<\/button>/g) ?? [];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain(">预览</button>");
    expect(tabs[1]).toContain(">信息</button>");

    // ② 默认停在第一个（预览）；roving tabindex —— 只有选中的那个是 0（`←/→` 才搬得动焦点）。
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('tabindex="-1"');
    expect(tabs[0]).toContain('aria-controls="inbox-panel-preview"');
    expect(tabs[1]).toContain('aria-controls="inbox-panel-info"');

    // ③ 两个面板都在 DOM 里（不卸载：保存到选择器是无状态受控控件，卸载会丢焦点），
    //    非当前页带 `hidden` —— 这一条还顺带盯住 `.inbox__panel[hidden]{display:none}`
    //    那条 CSS：预览页是作者写的 `display:flex`，少了它非当前页会照样显示出来。
    const previewPanel = (html.match(/<div class="inbox__panel inbox__panel--preview"[^>]*>/) ?? [])[0] ?? "";
    const infoPanel = (html.match(/<div class="inbox__panel" id="inbox-panel-info"[^>]*>/) ?? [])[0] ?? "";
    expect(previewPanel).not.toBe("");
    expect(infoPanel).not.toBe("");
    expect(previewPanel).not.toContain("hidden");
    expect(infoPanel).toContain("hidden");

    // ④ 内容归属：**按 DOM 切片**判，而不是「字符串在不在」——
    //    预览面板里只有正文文章，信息面板里只有那一整套元数据，两块互不越界。
    //    （`react-dom/server` 不跑 effect，所以正文还没从 `body.md` 读回来，预览页此刻是空态那一句；
    //    真机上读回来之后进的是同一个 `.inbox__prose` 文章。）
    const previewAt = html.indexOf('id="inbox-panel-preview"');
    const infoAt = html.indexOf('id="inbox-panel-info"');
    expect(previewAt).toBeGreaterThan(-1);
    expect(infoAt).toBeGreaterThan(previewAt);
    const previewSlice = html.slice(previewAt, infoAt);
    const infoSlice = html.slice(infoAt);
    expect(previewSlice).toContain('class="inbox__preview-empty"');
    expect(previewSlice).not.toContain("落点");
    expect(infoSlice).not.toContain("inbox__prose");
    for (const infoText of ["落点", "来源信息", "入库到「读书笔记」。", "标签", "详情"]) {
      expect(infoSlice).toContain(infoText);
    }
    // 「正文预览」这个分组标题随标签页一起退场：页面名就叫「预览」，再来一行分组标题是说两遍。
    expect(html).not.toContain("正文预览");
  });

  /*
   * 0.4.x 用户实测（原话：「预览为什么没有 markdown 预览, 都已经叫预览了, 为啥还展示纯文本」）：
   * 预览页**必须**是渲染后的 markdown，不是纯文本。根因在数据层 —— 上一版 `previewOf()`
   * 把正文压平成 400 字摘要（去掉 `#`、合并空行、截断），标题/列表/表格/代码块全被抹掉，
   * 界面再怎么写都只能显示纯文本。下面两条一条咬数据层（原文 + 不截断）、一条咬界面层（真渲染）。
   */
  it("预览页渲染的是 markdown：标题/加粗/行内代码/列表/引用/代码块都在，标记本身不在", async () => {
    const body = [
      "# 中文排版指北",
      "",
      "一份**写给中文写作者**的排版速查，带 `行内代码`。",
      "",
      "- 行高与字距",
      "- 段落间距",
      "",
      "> 引用一行。",
      "",
      "```js",
      "const a = 1;",
      "```",
    ].join("\n");
    // 用**内联正文**的条目（手工投递的那一类）：`readDir()` 当场就把 `bodyText` 填好，
    // 所以这一帧（`renderToStaticMarkup` 不跑 effect）预览页已经有真内容。
    // 外置 `body.md` 的条目要等 effect 读盘，走下面那条 `readInboxDetail()` 的判据。
    const dir = `${INBOX_DIR}/20261008T120000-markdown1`;
    testBackend.seed(
      `${dir}/entry.json`,
      JSON.stringify({
        spec: "opennote.import/v1",
        importId: "markdown-body-0001",
        title: "中文排版指北",
        body,
        source: { url: "https://example.com/typography-cn", site: "example.com", capturedAt: "2026-09-29T14:26:00+08:00" },
        target: { folder: "读书笔记", notePath: null },
        conflict: "new",
        tags: ["排版"],
        client: { name: "chrome-extension", version: "0.3.0" },
        enqueuedAt: "2026-09-29T14:26:00+08:00",
      }),
    );
    testBackend.seed(
      `${dir}/state.json`,
      JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: "2026-09-29T14:26:00.000Z" }),
    );
    await refreshInbox();
    const html = await renderPanel();
    const previewAt = html.indexOf('id="inbox-panel-preview"');
    const slice = html.slice(previewAt, html.indexOf('id="inbox-panel-info"'));

    // 块级与行内结构真的渲染出来了（`src/lib/markdown.ts` 的同一套管线 + `.prose` 排版）。
    expect(slice).toContain('class="prose inbox__prose"');
    expect(slice).toContain("<h1>中文排版指北</h1>");
    expect(slice).toContain("<strong>写给中文写作者</strong>");
    expect(slice).toContain("<code>行内代码</code>");
    expect(slice).toContain("<li>行高与字距</li>");
    expect(slice).toContain("<blockquote>");
    expect(slice).toContain("<pre>");
    // 反面证据：markdown 标记**不许**以原文出现在预览里 —— 那正是用户报的现象。
    expect(slice).not.toContain("# 中文排版指北");
    expect(slice).not.toContain("**写给中文写作者**");
    expect(slice).not.toContain("`行内代码`");
  });

  it("正文原文：`readInboxDetail()` 交回的是完整 markdown（不压平、不截断到 400 字）", async () => {
    const tail = "尾".repeat(600);
    const body = ["# 标题", "", "**加粗**", "", tail].join("\n");
    await enqueueInbox(JSON.stringify({ ...ENVELOPE, importId: "raw-body-0001", body }), META);
    const detail = await readInboxDetailById("raw-body-0001");

    expect(detail?.bodyText).toContain("# 标题");
    expect(detail?.bodyText).toContain("**加粗**");
    expect(detail?.bodyText).toContain(tail); // 没有被截断（旧实现的 400 字上限）
    // 空行保留（旧实现把连续空行并成一个换行，段落结构随之消失）。
    expect(detail?.bodyText).toContain("# 标题\n\n**加粗**");
  });

  it("预览页右端留一行最终落点句（P4：入库前看得见落点），与信息页同一产地", async () => {
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();
    // 预览页那一行是紧凑写法（`--fs-xs` `--ink-3` + `title` 给全），信息页那一行是完整写法；
    // 两处逐字相同 —— 它们读的是同一个 `hint`，不是两份文案。
    expect(html).toContain('<span class="inbox__tabs-hint" title="入库到「读书笔记」。">入库到「读书笔记」。</span>');
    expect(html).toContain('<p class="inbox__hint">入库到「读书笔记」。</p>');
  });

  it("正文为空的条目：预览页说一句实话，不留空框", async () => {
    await enqueueInbox(JSON.stringify({ ...ENVELOPE, importId: "empty-body-0001", body: "" }), META);
    const html = await renderPanel();
    expect(html).toContain('<p class="inbox__preview-empty">这一条没有正文。</p>');
  });

  /*
   * 预览页里的图片处置（纯函数那一半；DOM 那一半与 `ReadingView` 同款、node 环境下没有 jsdom）。
   * 两条事实：桌面 CSP 是 `img-src 'self' file: data: blob:`（远程图必裂）；
   * `assets/<名>` 在条目里落盘成 `assets/<hash8>-<名>`（靠 `assets[]` 的 name→file 对上）。
   */
  it("预览里的图片：远程图退化成说明、`assets/<名>` 换成条目里的真实文件、data:/blob: 直接用", async () => {
    const { planPreviewImage } = await import("../components/InboxPanel");
    const staged = new Map([["a.png", "assets/ab12cd34-a.png"]]);

    // 远程图：画出来必裂 → 说明句（不是破图）。
    expect(planPreviewImage("https://cdn.test/a.png", staged)).toEqual({ kind: "remote" });
    // 客户端写法 `assets/<名>`（含 `./` 变体）→ 条目里真实落盘的 `<hash8>-<名>`。
    expect(planPreviewImage("assets/a.png", staged)).toEqual({ kind: "local", file: "assets/ab12cd34-a.png" });
    expect(planPreviewImage("./assets/a.png", staged)).toEqual({ kind: "local", file: "assets/ab12cd34-a.png" });
    // 裸名（`rewriteAssetRefs()` 认的第二种写法）同样按 `assets[]` 换名。
    expect(planPreviewImage("a.png", staged)).toEqual({ kind: "local", file: "assets/ab12cd34-a.png" });
    // 未声明的名字原样试读（读不到再由 error/空结果退化成说明，不静默）。
    expect(planPreviewImage("assets/未声明.png", staged)).toEqual({ kind: "local", file: "assets/未声明.png" });
    // `data:` / `blob:` 直接可用。
    expect(planPreviewImage("data:image/png;base64,AAA", staged)).toEqual({ kind: "ready" });
    expect(planPreviewImage("blob:http://127.0.0.1/xyz", staged)).toEqual({ kind: "ready" });
    expect(planPreviewImage("", staged)).toEqual({ kind: "none" });
  });

  it("目录：最高宽度单行截断，完整值挂在 title 上（0.3.3 #2）", async () => {
    testBackend.seed("读书笔记/技术/排版/深路径/占位.md", "# 占位\n");
    await openWorkspace(record, { silent: true });
    await enqueueInbox(
      JSON.stringify({ ...ENVELOPE, target: { folder: "读书笔记/技术/排版/深路径", notePath: null } }),
      META,
    );
    const html = await renderPanel();

    // 值仍然是完整路径（不截数据），截断与悬浮都交给 `.inbox__trunc` + `title`。
    expect(html).toContain('class="inbox__trunc" title="读书笔记/技术/排版/深路径"');
  });

  it("保存到：候选来自既有文件夹树（folderPathLabel 写法）", async () => {
    testBackend.seed("剪藏/技术/占位.md", "# 占位\n");
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();
    // 行由 `.inbox__save-to` 提供样式（app.css），组件里不再写行内样式。
    expect(html).toContain('class="inbox__save-to"');
    expect(html).toContain("<span>保存到</span>");

    // 候选项：根目录 + 树上每个文件夹一个，值是工作区相对路径（标签用 folderPathLabel 的写法）。
    // 自定义下拉的列表只在展开时渲染（`renderToStaticMarkup` 点不了），所以这里直接喂
    // 真实文件夹树给产出候选项的纯函数 —— 断言的仍是**同一条逐字契约**。
    const [{ saveToOptionsFor }, { getLibrary }] = await Promise.all([
      import("../components/InboxPanel"),
      import("./library"),
    ]);
    const options = saveToOptionsFor(getLibrary().folders, "读书笔记");
    expect(options[0]).toEqual({ value: "", label: "笔记本根目录" });
    expect(options).toContainEqual({ value: "剪藏/技术", label: "剪藏 / 技术" });
    // 当前落点（信封里的「读书笔记」）在候选项里。
    expect(options.some((option) => option.value === "读书笔记")).toBe(true);
  });

  it("保存到：信封落点已不在树上时，原样留在候选项里（不吞掉用户的选择）", async () => {
    testBackend.seed("剪藏/占位.md", "# 占位\n");
    // 信封落点指着「已删除的目录」：工作区里根本没有这个文件夹（不在磁盘、也不在树上）。
    await enqueueInbox(
      JSON.stringify({ ...ENVELOPE, target: { folder: "已删除的目录", notePath: null } }),
      { ...META, targetFolder: "已删除的目录" },
    );
    await renderPanel();

    const [{ saveToOptionsFor }, { getLibrary }] = await Promise.all([
      import("../components/InboxPanel"),
      import("./library"),
    ]);
    // 这个目录确实不在文件夹表里 —— 悄悄把它从候选项里拿掉，等于把用户的落点改成别的
    // 目录，而他不会知道。
    expect(getLibrary().folders["已删除的目录"]).toBeUndefined();
    const options = saveToOptionsFor(getLibrary().folders, "已删除的目录");
    expect(options).toContainEqual({ value: "已删除的目录", label: "已删除的目录" });
    // 根目录项永远在第一位，且值为空串（`INBOX_ROOT_VALUE`）。
    expect(options[0].value).toBe("");
  });

  it("保存到：信封落点是根目录时，说明句写「入库到笔记本根目录。」", async () => {
    await enqueueInbox(JSON.stringify({ ...ENVELOPE, target: { folder: null, notePath: null } }), { ...META, targetFolder: null });
    const html = await renderPanel();
    expect(html).toContain("入库到笔记本根目录。");
    expect(html).not.toContain("入库到「");
  });

  it("落点非法（手工写坏的 entry.json）如实提示，且面板不渲染崩", async () => {
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const dirName = await firstDirName();
    const path = `${INBOX_DIR}/${dirName}/entry.json`;
    const envelope = JSON.parse(testBackend.files.get(path) as string) as Record<string, unknown>;
    envelope.target = { folder: "../逃逸", notePath: null };
    testBackend.files.set(path, JSON.stringify(envelope));
    await refreshInbox();

    const html = await renderPanel();

    expect(html).toContain("目标目录不合法：不能使用 ..、绝对路径或系统保留字符。");
    // 用户可见文案里不得出现 Markdown 内联代码标记（字面反引号）。
    expect(html).not.toContain("`");
    // 非法值原样留在选择器里，不被悄悄吞掉；也不出现「会存到根目录」这种错误承诺。
    expect(html).toContain("../逃逸");
    expect(html).not.toContain("入库时会存到根目录");
  });

  it("落点目录不存在：逐字说明句 + 主按钮改成「入库到根目录」", async () => {
    await enqueueInbox(
      JSON.stringify({ ...ENVELOPE, target: { folder: "不存在的目录", notePath: null } }),
      { ...META, targetFolder: null },
    );
    const html = await renderPanel();
    expect(html).toContain("目标目录「不存在的目录」不存在，入库时会存到根目录。");
    expect(html).toContain("入库到根目录");
  });

  it("同名文件已存在：逐字提示另存为《标题 2》", async () => {
    testBackend.seed("读书笔记/中文排版指北.md", "# 中文排版指北\n旧内容");
    await openWorkspace(record, { silent: true });
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();
    expect(html).toContain("同名文件已存在，入库时会另存为《中文排版指北 2》。");
  });

  it("同网址剪藏过：逐字提示会追加到既有笔记", async () => {
    testBackend.seed(
      "读书笔记/旧剪藏.md",
      `---\nsource: https://example.com/typography-cn\ncaptured_at: ${new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()}\n---\n\n# 旧剪藏\n`,
    );
    await openWorkspace(record, { silent: true });
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();
    expect(html).toContain("这个网址之前剪藏过（3 小时前），入库时会追加到《旧剪藏》。");
  });

  it("空收件箱：两条逐字空态文案 + 「知道了」", async () => {
    await refreshInbox();
    const html = await renderPanel();
    expect(html).toContain("收件箱是空的。");
    expect(html).toContain("外部导入若选择「先进入收件箱」，会先出现在这里。");
    expect(html).toContain("知道了");
  });

  it("默认「待确认」只收待确认条目：失败条目不在这一栏，只在「全部」里（0.3.3 #1）", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "failed", { lastError: "IMP-4013" });

    const pending = await renderPanel();
    expect(pending).toContain("全部 1");
    expect(pending).toContain("待确认 0");
    expect(pending).toContain("没有「待确认」的条目。");
    expect(pending).not.toContain("中文排版指北");

    // 条目没有消失：切到「全部」就能看到它、重试或丢弃（03 UI-03/S5）。
    const all = await renderPanel("all");
    expect(all).toContain("中文排版指北");
    expect(all).toContain('class="inbox__item is-active is-error"');
  });

  it("失败条目（全部视图）：code 的中文文案 + 「还有 {n} 天」，主按钮禁用", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "failed", { lastError: "IMP-4013" });
    const html = await renderPanel("all");
    expect(html).toContain("附件太多或太大，请减少后用重新剪藏。");
    expect(html).toContain("还有 7 天");
    expect(html).toContain("稍后处理");
    expect(html).toMatch(/<button[^>]*btn btn--primary[^>]*disabled/);
  });

  it("入库中：条目「正在写入…」+ 主按钮「正在入库…」且禁用", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "committing", { attempts: 1 });
    const html = await renderPanel();
    expect(html).toContain("正在写入…");
    expect(html).toContain("正在入库…");
    expect(html).toContain("busy__spinner");
    expect(html).toMatch(/<button[^>]*btn btn--primary[^>]*disabled/);
  });

  it("已入库（全部视图）：次级文字「已入库 · {相对时间}」，主按钮改成「查看」", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(async () => importResult());
    await commitInbox(entry.id);
    const html = await renderPanel("all");
    expect(html).toContain("已入库 · ");
    expect(html).toContain("查看");
    // 已入库条目不再提供「丢弃」，免得被读成「删掉这篇笔记」。
    expect(html).not.toContain("跳过这次");
    expect(html).not.toContain("稍后处理");
  });

  it("已入库条目：目录/文件名按**实际落盘位置**显示（改过「保存到」也不会说成根目录）", async () => {
    // 用户真机缺陷：信封落点 = 读书笔记，入库前在「保存到」里改成 剪藏/新目录 →
    // 笔记确实落在 剪藏/新目录，但面板仍按信封值显示「读书笔记」，并补一句
    // 「入库时会另存为《… 2》」（其实已经入库完了）。
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(null); // 走 C1 的真实接收端，让 committedPath 就是真实落点
    await commitInboxResult(entry.id, { folder: "剪藏/新目录" });

    const html = await renderPanel("all");
    // 实际落点。
    expect(html).toContain("剪藏/新目录");
    expect(html).toContain("中文排版指北.md");
    // 信封里的旧落点与「将来时」说明句都不许再出现。
    expect(html).not.toContain("读书笔记");
    expect(html).not.toContain("入库时会另存为");
    expect(html).not.toContain("入库到");
  });
});

/* ------------------------------ 变更检测 ------------------------------- */

describe("变更检测消费端", () => {
  it("浏览器后端没有 watcher：退化为轮询 + 聚焦刷新，模式如实报告", async () => {
    vi.useFakeTimers();
    expect(inboxWatchMode()).toBe("off");
    startInboxWatch();
    expect(inboxWatchMode()).toBe("poll");

    await vi.advanceTimersByTimeAsync(0);
    expect(inboxCount()).toBe(0);

    // 外部投递：浏览器后端只能等轮询（30 秒）发现。
    testBackend.seed(
      `${INBOX_DIR}/20260929T150000-poll0001/entry.json`,
      JSON.stringify({
        spec: "opennote.import/v1",
        importId: "poll-0001",
        title: "轮询发现",
        body: "正文",
        source: { url: null, capturedAt: "2026-09-29T15:00:00+08:00" },
      }),
    );
    testBackend.seed(
      `${INBOX_DIR}/20260929T150000-poll0001/state.json`,
      JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: "2026-09-29T15:00:00.000Z" }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(inboxCount()).toBe(1);

    stopInboxWatch();
    expect(inboxWatchMode()).toBe("off");
  });

  it("startInboxWatch 幂等：重复调用不叠加（模式不变）", () => {
    startInboxWatch();
    startInboxWatch();
    expect(inboxWatchMode()).toBe("poll");
    stopInboxWatch();
  });
});

/* ------------------ 用户文案单一来源（C-6f 多产地护栏） ------------------ */

/**
 * 同一句 `userMessage` 在仓库里有 **N 个产地**：`electron/bridge.cjs` 的 `ERROR_TABLE`、
 * `electron/main.cjs`、`src/lib/clip/envelope.ts` 的 `IMPORT_ERRORS`、本模块的 `MESSAGES`、
 * 扩展的 `errors.js`。`C-6c` 只盖住桥那一张表，`pnpm test` 也盖不住 —— 谁改一份另外几份
 * 不会跟着变。这里直接拿**源码文本**比两份表（`MESSAGES` 是模块私有常量，不导出）。
 *
 * 另有一条更隐蔽的坑（Verifier 的 `C-6f` 抓到）：文档表格单元格里的 `` `..` `` 是 Markdown
 * 内联代码标记，**不是文案的一部分**；抄进 JS 字符串时把反引号一起带过来，用户就会看见
 * 字面反引号。所以下面既比对**剥反引号后**是否一致，也单独断言**实现里一个反引号都不许有**。
 */
describe("MESSAGES 与桥 ERROR_TABLE 逐字一致（同一语义值多产地）", () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");
  /** 去掉注释，避免注释里的示例文案被当成真表项（与 `C-6f` 同口径）。 */
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /** `"IMP-4008": "…"`（本模块的纯字符串映射）。 */
  const plainTable = (text: string) =>
    new Map(
      [...text.matchAll(/["']IMP-(\d{4})["']\s*:\s*(["'])((?:(?!\2)[\s\S])*?)\2/g)].map(
        (match) => [`IMP-${match[1]}`, match[3]] as const,
      ),
    );
  /** 桥的 `ERROR_TABLE`：**一行一条**（`'IMP-4008': { …, userMessage: '…' },`），逐行取。 */
  const bridgeTable = (text: string) =>
    new Map(
      text
        .split(/\r?\n/)
        .flatMap((line) => {
          const code = /["']IMP-(\d{4})["']\s*:\s*\{/.exec(line);
          const copy = code ? /userMessage\s*:\s*(["'])((?:(?!\1)[\s\S])*?)\1/.exec(line) : null;
          return code && copy ? [[`IMP-${code[1]}`, copy[2]] as const] : [];
        }),
    );

  /**
   * `IMP-4011` 一个码覆盖**两个分支**，两个产地的措辞本来就不同：
   * 本模块是 `append` 分支（追加目标不存在）、桥是 `overwrite` 降级分支。
   * 它不参与逐字比对（`C-6e` 同类：一个格子覆盖多种情形），其余码必须逐字一致。
   */
  const BRANCH_CODES = new Set(["IMP-4011"]);

  it("IMP-4008：不含反引号，且与桥 ERROR_TABLE 逐字相等", () => {
    const message = inboxFailureMessage("IMP-4008");
    const bridge = bridgeTable(stripComments(read("electron/bridge.cjs"))).get("IMP-4008");

    expect(message).toBe("目标目录不合法：不能使用 ..、绝对路径或系统保留字符。");
    expect(message).not.toContain("`");
    expect(bridge).toBe(message);
  });

  it("MESSAGES 全表：任何一句用户可见文案都不得含反引号", () => {
    const mine = plainTable(stripComments(read("src/data/inbox.ts")));
    expect(mine.size).toBeGreaterThanOrEqual(20); // 提取逻辑没失效
    const offenders = [...mine].filter(([, copy]) => copy.includes("`")).map(([code, copy]) => `${code}「${copy}」`);
    expect(offenders).toEqual([]);
  });

  it("MESSAGES 与桥共有的码：逐字相等（防止第 N+1 次改动只改一份）", () => {
    const mine = plainTable(stripComments(read("src/data/inbox.ts")));
    const bridge = bridgeTable(stripComments(read("electron/bridge.cjs")));
    const shared = [...mine.keys()].filter((code) => bridge.has(code));
    expect(shared.length).toBeGreaterThanOrEqual(20);

    const drifted = shared
      .filter((code) => !BRANCH_CODES.has(code) && mine.get(code) !== bridge.get(code))
      .map((code) => `${code}: 本模块「${mine.get(code)}」≠ 桥「${bridge.get(code)}」`);
    expect(drifted).toEqual([]);
    // 分支专属文案仍然各自保留（不是漂移，是两种情形）。
    expect(mine.get("IMP-4011")).toBe("「追加」的目标不存在，已改为新建一篇。");
    expect(bridge.get("IMP-4011")).toBe("「覆盖」不可用，已改为新建一篇。");
  });
});
