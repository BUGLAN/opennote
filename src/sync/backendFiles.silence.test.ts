/**
 * ★ 「同步自己的写入不触发下一轮」—— 否则同步会自我驱动。
 *
 * ## 它防的是什么
 *
 * 后端的写入通知（`src/fs/writeLog.ts`）是**所有产地共用**的：拉取落地走的也是
 * 同一个 `FileSystemBackend`。不静默的话就是：
 *
 * ```
 * 一轮同步 → 拉下 3 篇 → 3 条写入通知 → 去抖 → 又一轮同步 → …
 * ```
 *
 * 单飞会合并掉一部分，但「每拉一轮就多跑一轮空同步」是确定的资源浪费，
 * 而在大笔记本上这会变成「界面一直在同步中」。
 *
 * ## 为什么断言点在这里（`createBackendSyncFiles`）而不是 `appSync`
 *
 * 因为这里才是「同步往本地写」的**唯一出口**（`write` / `remove` 两个方法）。
 * `attach` 只负责接线；把静默放在出口，将来多一个调用方也不会漏。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackendSyncFiles } from "./backendFiles";
import type { EntryInfo, FileSystemBackend } from "../fs/types";
import { observeWrites } from "../fs/writeObserver";
import { onWorkspaceWrite, resetWriteLogForTests, silencedPaths } from "../fs/writeLog";

/** 只够跑同步写入的假后端（**包在 `observeWrites` 里** —— 真实应用就是这样）。 */
function observedBackend() {
  const written: string[] = [];
  const removed: string[] = [];
  const backend = observeWrites({
    kind: "node",
    label: "假",
    canWrite: true,
    list: async (): Promise<EntryInfo[]> => [],
    readText: async () => "",
    readBytes: async () => new Uint8Array(),
    writeText: async (relPath: string) => void written.push(relPath),
    writeBytes: async (relPath: string) => void written.push(relPath),
    mkdir: async () => undefined,
    remove: async (relPath: string) => void removed.push(relPath),
    move: async () => undefined,
    exists: async () => true,
    stat: async () => null,
  } as unknown as FileSystemBackend);
  return { backend, written, removed };
}

let paths: string[];
let off: (() => void) | null = null;

beforeEach(() => {
  resetWriteLogForTests();
  paths = [];
  off = onWorkspaceWrite((write) => paths.push(...write.paths));
});

afterEach(() => {
  off?.();
  off = null;
  resetWriteLogForTests();
});

describe("★ 同步自身的写入必须静默", () => {
  it("★ `write`（拉取落地）不产生写入通知", async () => {
    const { backend, written } = observedBackend();
    const files = createBackendSyncFiles({ backend });

    await files.write("笔记/a.md", new TextEncoder().encode("# A"));

    // 字节确实落盘了……
    expect(written).toEqual(["笔记/a.md"]);
    // ……但同步层不该因此再跑一轮（否则一次拉取会无限自我驱动）。
    expect(paths).toEqual([]);
  });

  it("★ `remove`（远端确认删除）不产生写入通知", async () => {
    const { backend, removed } = observedBackend();
    const files = createBackendSyncFiles({ backend });

    await files.remove("笔记/b.md");

    expect(removed).toEqual(["笔记/b.md"]);
    expect(paths).toEqual([]);
  });

  it("静默是**按路径**的：拉取期间用户另存的那一篇照常触发", async () => {
    /*
     * 这条是整套设计的关键。一次全量拉取要写几百篇、持续十几秒，
     * 期间用户很可能正在打字。如果静默是「整轮开关」，
     * 用户那次保存会被吞掉 —— 症状与本次要修的 bug 一模一样。
     */
    const { backend } = observedBackend();
    const files = createBackendSyncFiles({ backend });

    await files.write("拉下来的.md", new TextEncoder().encode("# 远端"));
    // 用户在这期间保存了自己的一篇（不经过同步的写方法）
    await backend.writeText("用户自己.md", "# 本地");

    expect(paths).toEqual(["用户自己.md"]);
  });

  it("两个写方法结束后静默表为空（没有残留窗口）", async () => {
    const { backend } = observedBackend();
    const files = createBackendSyncFiles({ backend });

    await files.write("a.md", new Uint8Array());
    await files.remove("b.md");

    expect(silencedPaths()).toEqual([]);
  });

  it("写失败时也要解除静默（否则那条路径从此永久静默）", async () => {
    const failing = observeWrites({
      kind: "node",
      label: "假",
      canWrite: true,
      list: async () => [],
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
      writeText: async () => undefined,
      writeBytes: async () => {
        throw new Error("磁盘满了");
      },
      mkdir: async () => undefined,
      remove: async () => undefined,
      move: async () => undefined,
      exists: async () => true,
      stat: async () => null,
    } as unknown as FileSystemBackend);
    const files = createBackendSyncFiles({ backend: failing });

    await expect(files.write("a.md", new Uint8Array())).rejects.toThrow("磁盘满了");
    expect(silencedPaths()).toEqual([]);
  });
});

describe("对照：不是同步写的那些调用照常通知", () => {
  it("同一条路径由**别的产地**写入 ⇒ 必须通知（静默只属于同步自己那一段）", async () => {
    const { backend } = observedBackend();
    const files = createBackendSyncFiles({ backend });

    await files.write("共享.md", new TextEncoder().encode("远端版本"));
    paths = [];
    // 用户随后编辑了同一篇 —— 这一次必须推上去（否则本地改动永远上不去）。
    await backend.writeText("共享.md", "本地版本");

    expect(paths).toEqual(["共享.md"]);
  });
});
