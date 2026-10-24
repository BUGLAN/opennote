/**
 * 「写入通知」与两个原语的回归用例（`src/fs/writeLog.ts`、`src/fs/writeObserver.ts`）。
 *
 * 这一组的存在理由是**一次真实的漏**：收件箱入库之后 A 设备不推送、
 * B 设备要等 A 手动同步。根因不是网络，而是「入库直写后端」这条产地
 * 从来没通知过同步层 —— 而同期所有同步用例都直接调 `syncNow()`，
 * 于是触发链本身**一条用例都没有**，带着全绿测试活了很久。
 *
 * 所以这里的断言点刻意放在**触发**上，不是「同步能跑通」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseName, parentPath } from "./paths";
import type { EntryInfo, FileSystemBackend } from "./types";
import { observeWrites, isObserved } from "./writeObserver";
import {
  emitWorkspaceWrite,
  onWorkspaceWrite,
  reportWorkspaceWrite,
  resetWriteLogForTests,
  silencedPaths,
  silenceWrites,
  workspaceWriteListenerCount,
  type WorkspaceWrite,
} from "./writeLog";

/** 只够测装饰器的最小后端（所有方法都记一笔，便于断言「透传没改动语义」）。 */
class RecordingBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "记录用磁盘";
  readonly canWrite = true;
  readonly dirs = new Set([""]);
  readonly files = new Map<string, string | Uint8Array>();
  readonly calls: string[] = [];

  seed(path: string, text: string | Uint8Array): void {
    if (path) this.dirs.add(parentPath(path));
    this.files.set(path, text);
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    if (path) this.dirs.add(path);
  }
  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    return [...this.files.entries()]
      .filter(([candidate]) => parentPath(candidate) === path)
      .map(([candidate, value]) => ({
        name: baseName(candidate),
        kind: "file" as const,
        size: String(value).length,
        mtimeMs: 1,
      }));
  }
  async readText(path: string): Promise<string> {
    this.calls.push(`readText:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return String(value);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    this.calls.push(`readBytes:${path}`);
    return new TextEncoder().encode(await this.readText(path));
  }
  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`writeText:${path}`);
    this.seed(path, text);
  }
  async writeBytes(path: string, data: Uint8Array | Blob): Promise<void> {
    this.calls.push(`writeBytes:${path}`);
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    this.seed(path, bytes);
  }
  async exists(path: string): Promise<boolean> {
    this.calls.push(`exists:${path}`);
    return this.files.has(path) || this.dirs.has(path);
  }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    this.calls.push(`stat:${path}`);
    const value = this.files.get(path);
    return value === undefined ? null : { size: String(value).length, mtimeMs: 1 };
  }
  async move(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.seed(to, typeof value === "string" ? value : new Uint8Array(value));
  }
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}${options?.recursive ? ":recursive" : ""}`);
    if (this.files.delete(path)) return;
    for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
  }
}

let backend: RecordingBackend;
let writes: WorkspaceWrite[];
let off: (() => void) | null = null;

beforeEach(() => {
  backend = new RecordingBackend();
  resetWriteLogForTests();
  writes = [];
  off = onWorkspaceWrite((write) => writes.push(write));
});

afterEach(() => {
  off?.();
  off = null;
  resetWriteLogForTests();
});

/* ============================================================================
   原语本身
   ============================================================================ */

describe("写入通知原语", () => {
  it("没有订阅者时报告不抛（写盘不能因为没人听而失败）", () => {
    off?.();
    off = null;
    expect(workspaceWriteListenerCount()).toBe(0);
    expect(() => emitWorkspaceWrite({ paths: ["a.md"], content: true })).not.toThrow();
  });

  it("一个订阅者抛错不连累其它订阅者", () => {
    const seen: string[] = [];
    const offBoom = onWorkspaceWrite(() => {
      throw new Error("boom");
    });
    const offOk = onWorkspaceWrite((write) => seen.push(...write.paths));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      emitWorkspaceWrite({ paths: ["a.md"], content: true });
    } finally {
      offBoom();
      offOk();
    }
    expect(seen).toEqual(["a.md"]);
  });

  it("空路径不广播（`.opennote` 内部写盘里那些没有路径的动作不该产生事件）", () => {
    emitWorkspaceWrite({ paths: [], content: true });
    expect(writes).toHaveLength(0);
  });

  it("退订之后不再收到（关工作区必须真的断干净）", () => {
    off?.();
    off = null;
    emitWorkspaceWrite({ paths: ["a.md"], content: true });
    expect(writes).toHaveLength(0);
  });
});

/* ============================================================================
   按路径静默
   ============================================================================ */

describe("按路径静默（同步自己的写入）", () => {
  it("静默一条路径 ⇒ 它的通知被吞，**别的路径照常**", async () => {
    await silenceWrites(["a.md"], async () => {
      reportWorkspaceWrite({ paths: ["a.md"], content: true });
      reportWorkspaceWrite({ paths: ["别人的.md"], content: true });
    });
    /*
     * 这一条是整套设计的关键：全量拉取要写几百篇、持续十几秒，
     * 期间用户很可能正在打字。一个「整轮静默」的开关会把用户那次保存一起吞掉，
     * 症状与要修的 bug 一模一样 —— 所以静默只认路径。
     */
    expect(writes.map((write) => write.paths)).toEqual([["别人的.md"]]);
  });

  it("静默目录 ⇒ 整棵子树被吞，同级的另一个目录不受影响", async () => {
    await silenceWrites(["docs"], async () => {
      reportWorkspaceWrite({ paths: ["docs/a.md"], content: true });
      reportWorkspaceWrite({ paths: ["docs/深/一层.md"], content: true });
      reportWorkspaceWrite({ paths: ["docs2/b.md"], content: true });
    });
    expect(writes.map((write) => write.paths)).toEqual([["docs2/b.md"]]);
  });

  it("静默结束后立刻恢复（窗口跟着 await 走，不是 setTimeout）", async () => {
    await silenceWrites(["a.md"], async () => undefined);
    expect(silencedPaths()).toEqual([]);
    reportWorkspaceWrite({ paths: ["a.md"], content: true });
    expect(writes.map((write) => write.paths)).toEqual([["a.md"]]);
  });

  it("嵌套静默按计数解（同一路径被并发写两次，只解一层不该放行）", async () => {
    await silenceWrites(["a.md"], async () => {
      await silenceWrites(["a.md"], async () => undefined);
      // 内层已退出、外层还在 ⇒ 仍然静默
      reportWorkspaceWrite({ paths: ["a.md"], content: true });
    });
    expect(writes).toHaveLength(0);
  });

  it("写入本身抛错也要解除静默（否则那条路径从此永久静默）", async () => {
    await expect(
      silenceWrites(["a.md"], async () => {
        throw new Error("写盘失败");
      }),
    ).rejects.toThrow("写盘失败");
    expect(silencedPaths()).toEqual([]);
    reportWorkspaceWrite({ paths: ["a.md"], content: true });
    expect(writes.map((write) => write.paths)).toEqual([["a.md"]]);
  });
});

/* ============================================================================
   装饰器：转发语义不变 + 只报写
   ============================================================================ */

describe("observeWrites：只加通知，不改语义", () => {
  it("★ 写成功之后才通知（失败不产生通知）", async () => {
    const wrapped = observeWrites(backend);
    await wrapped.writeText("a.md", "# A");
    expect(writes.map((write) => write.paths)).toEqual([["a.md"]]);

    writes = [];
    // 只换掉写方法：其余能力由同一个记录后端提供（展开会丢方法原型，类型也对不上）。
    const broken: FileSystemBackend = Object.assign(Object.create(backend) as FileSystemBackend, {
      writeText: async () => {
        throw new Error("磁盘满了");
      },
    });
    const failing = observeWrites(broken);
    await expect(failing.writeText("b.md", "# B")).rejects.toThrow("磁盘满了");
    // 没写成功 = 没有字节落盘 = 不该触发推送。
    expect(writes).toHaveLength(0);
  });

  it("读方法完全不通知（扫描时读几百个文件，报告一次读就会自己触发自己）", async () => {
    backend.seed("a.md", "# A");
    const wrapped = observeWrites(backend);
    await wrapped.list("");
    await wrapped.readText("a.md");
    await wrapped.readBytes("a.md");
    await wrapped.stat("a.md");
    await wrapped.exists("a.md");
    expect(writes).toHaveLength(0);
  });

  it("remove 报 content: true（同步层要靠它推墓碑），move 报源与目标两条", async () => {
    const wrapped = observeWrites(backend);
    backend.seed("a.md", "# A");
    await wrapped.remove("a.md");
    backend.seed("b.md", "# B");
    await wrapped.move("b.md", "c.md");
    expect(writes).toEqual([
      { paths: ["a.md"], content: true },
      { paths: ["b.md", "c.md"], content: true },
    ]);
  });

  it("mkdir 报 content: false（目录不过同步，不该单独触发一轮推送）", async () => {
    const wrapped = observeWrites(backend);
    await wrapped.mkdir("新目录");
    expect(writes).toEqual([{ paths: ["新目录"], content: false }]);
  });

  it("三个只读字段原样透出（library 按 kind 分支：opfs 不做 focus 重扫）", () => {
    const wrapped = observeWrites(backend);
    expect(wrapped.kind).toBe(backend.kind);
    expect(wrapped.label).toBe(backend.label);
    expect(wrapped.canWrite).toBe(backend.canWrite);
  });

  it("返回值与异常原样透传（本层不该改变任何调用方语义）", async () => {
    backend.seed("a.md", "# A");
    const wrapped = observeWrites(backend);
    await expect(wrapped.readText("a.md")).resolves.toBe("# A");
    await expect(wrapped.readText("不存在.md")).rejects.toThrow("ENOENT");
    await expect(wrapped.exists("a.md")).resolves.toBe(true);
    await expect(wrapped.stat("不存在.md")).resolves.toBeNull();
  });

  it("订阅者抛错不会让写盘失败（通知是事后的事）", async () => {
    off?.();
    off = null;
    const offBoom = onWorkspaceWrite(() => {
      throw new Error("订阅者炸了");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const wrapped = observeWrites(backend);
      await expect(wrapped.writeText("a.md", "# A")).resolves.toBeUndefined();
      expect(backend.files.get("a.md")).toBe("# A");
    } finally {
      offBoom();
    }
  });

  it("包过的后端可以被识别（防包两层 ⇒ 一次写入报两次）", () => {
    const wrapped = observeWrites(backend);
    expect(isObserved(wrapped)).toBe(true);
    expect(isObserved(backend)).toBe(false);
  });
});
