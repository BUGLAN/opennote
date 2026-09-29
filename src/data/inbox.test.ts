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
  inboxWatchMode,
  listInbox,
  listInboxDetails,
  readInboxEntry,
  refreshInbox,
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
    return new TextEncoder().encode(await this.readText(path));
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
    expect(withBody?.bodyPreview).toContain("在应用没运行时投递的正文。");
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
 * 逐字核对文案（`effect` 不跑，因此只覆盖首屏分支）。
 */
async function renderPanel(): Promise<string> {
  const [{ createElement }, { renderToStaticMarkup }, { InboxPanel }] = await Promise.all([
    import("react"),
    import("react-dom/server"),
    import("../components/InboxPanel"),
  ]);
  return renderToStaticMarkup(createElement(InboxPanel, { open: true, onClose: () => undefined }));
}

describe("InboxPanel 首屏（逐字文案冻结）", () => {
  it("有待确认条目：工具行计数、列表、落点、动作文案", async () => {
    await enqueueInbox(JSON.stringify(ENVELOPE), META);
    const html = await renderPanel();

    expect(html).toContain("导入收件箱");
    expect(html).toContain("全部 1");
    expect(html).toContain("待确认 1");
    expect(html).toContain("失败 0");
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
    // 丢弃是销毁动作：面板里不得出现任何「恢复」入口。
    expect(html).not.toContain("恢复");
    expect(html).not.toMatch(/30\s*天/);
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

  it("失败条目：code 的中文文案 + 「还有 {n} 天」，主按钮禁用", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    await setInboxStatus(entry.id, "failed", { lastError: "IMP-4013" });
    const html = await renderPanel();
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

  it("已入库：次级文字「已入库 · {相对时间}」，主按钮改成「查看」", async () => {
    const entry = await enqueueInbox(JSON.stringify(ENVELOPE), META);
    setInboxReceiver(async () => importResult());
    await commitInbox(entry.id);
    const html = await renderPanel();
    expect(html).toContain("已入库 · ");
    expect(html).toContain("查看");
    // 已入库条目不再提供「丢弃」，免得被读成「删掉这篇笔记」。
    expect(html).not.toContain("跳过这次");
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
