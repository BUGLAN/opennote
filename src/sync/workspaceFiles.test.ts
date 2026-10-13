/**
 * 工作区适配层的用例（`docs/执行-三端同步…` §3.11 红线 8、§3.9、§5.3）。
 *
 * ## 最要紧的一组：**同步范围 = 忽略规则，不多不少**（红线 8）
 *
 * 这里几乎每一条都在验「**不该同步的东西没有溜进去**」，因为：
 *
 * - 同步 `.git/` 会跨设备搬 `objects`/`index`，**把仓库搞坏**（§3.11）；
 * - `.opennote/` 里有基线、密钥引用、历史，**绝不能跨端**；
 * - 而「漏了一条」的症状不是报错，是**几周后另一个设备上仓库坏了**。
 *
 * 特别是 §3.11 那条最反直觉的规则：**用户在 `.gitignore` 里写 `!/.git/` 也必须被拒绝** ——
 * 内置集**先判**，命中就直接排除，不再看 `.gitignore`。
 */
import { describe, expect, it, vi } from "vitest";
import { createIgnoreRules } from "./ignore";
import { createWorkspaceEngineDeps, openRemoteBytes, selectSyncableEntries, type LocalEntry, type SyncFileBackend } from "./workspaceFiles";
import { deriveNotebookKey, toHex } from "./accountKey";
import { sealContent, notebookKeysFrom } from "./crypto";
import { sha256 } from "@noble/hashes/sha2.js";

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";
const NOTEBOOK_KEY = deriveNotebookKey(Uint8Array.from({ length: 32 }, (_, index) => index), NOTEBOOK);

/** 一个内存后端。 */
function memoryBackend(files: Record<string, string>): SyncFileBackend & { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  const store = new Map(Object.entries(files));
  return {
    written,
    removed,
    async list(): Promise<LocalEntry[]> {
      const out: LocalEntry[] = [];
      for (const path of store.keys()) {
        // 补上中间目录（真实后端会列出来）。
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
          out.push({ path: parts.slice(0, index).join("/"), isDir: true });
        }
        out.push({ path, isDir: false });
      }
      return out;
    },
    async read(path) {
      const value = store.get(path);
      if (value === undefined) throw new Error(`没有这个文件：${path}`);
      return new TextEncoder().encode(value);
    },
    async write(path, bytes) {
      written.push(path);
      store.set(path, new TextDecoder().decode(bytes));
    },
    async remove(path) {
      removed.push(path);
      store.delete(path);
    },
  };
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function depsFor(files: Record<string, string>, options: { gitignore?: string; cryptoMode?: "none" | "user-key" } = {}) {
  const backend = memoryBackend(files);
  const deps = createWorkspaceEngineDeps({
    backend,
    rules: createIgnoreRules(options.gitignore ?? ""),
    cryptoMode: options.cryptoMode ?? "none",
    ...(options.cryptoMode === "user-key" ? { notebookKey: NOTEBOOK_KEY } : {}),
    knownPaths: async () => ["notes/a.md"],
  });
  return { backend, deps };
}

/* ============================================================================
   ★ 同步范围
   ============================================================================ */

describe("★ §3.11 红线 8 · 同步范围 = 忽略规则", () => {
  it("普通笔记会进 `listLocal`", async () => {
    const { deps } = depsFor({ "notes/a.md": "# A", "notes/b.md": "# B" });
    const listed = await deps.listLocal();
    expect(listed.map((item) => item.path).sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("★ 内置集：`.git/` 与 `.opennote/` **永远**不进（不管 `.gitignore` 怎么写）", async () => {
    const { deps } = depsFor({
      "notes/a.md": "# A",
      ".git/config": "[core]",
      ".git/objects/ab/cdef": "二进制",
      ".opennote/baseline.json": "{}",
      ".opennote/keys.json": "{}",
    });
    const listed = await deps.listLocal();
    expect(listed.map((item) => item.path)).toEqual(["notes/a.md"]);
  });

  it("★★ 用户写 `!/.git/` 想「把 git 目录也同步」⇒ **必须被拒绝**（§3.11 原文场景）", async () => {
    /*
     * §3.11 原文：「如果用户在 `.gitignore` 里写 `!/.git/`（想『把 git 目录也同步』），
     * **必须被拒绝** —— 同步 `.git/` 会跨设备搬 `objects`/`index`，**把仓库搞坏**。」
     *
     * 这条靠「内置集先判，命中就直接排除，不再看 `.gitignore`」实现。
     */
    const { deps } = depsFor(
      { "notes/a.md": "# A", ".git/config": "[core]", ".opennote/baseline.json": "{}" },
      { gitignore: "!/.git/\n!/.opennote/" },
    );
    expect((await deps.listLocal()).map((item) => item.path)).toEqual(["notes/a.md"]);
  });

  it("`.gitignore` 里的规则照常生效", async () => {
    const { deps } = depsFor({ "notes/a.md": "# A", "build/out.js": "x", "draft.md": "y" }, { gitignore: "build/\n*.tmp" });
    const listed = await deps.listLocal();
    expect(listed.map((item) => item.path)).toEqual(["notes/a.md", "draft.md"]);
  });

  it("`.gitignore` 文件本身**不同步**（它是本机配置，跨端搬会改别人的行为）", async () => {
    const { deps } = depsFor({ "notes/a.md": "# A", ".gitignore": "build/" });
    expect((await deps.listLocal()).map((item) => item.path)).toEqual(["notes/a.md"]);
  });

  it("目录本身不进列表（同步的是内容）", async () => {
    const { deps } = depsFor({ "notes/a.md": "# A" });
    for (const item of await deps.listLocal()) expect(item.path).not.toBe("notes");
  });

  it("`selectSyncableEntries` 对路径先**规范化**再判定（`.git/./config` 这类写法绕不过内置集）", () => {
    const entries: LocalEntry[] = [
      { path: ".git/./config", isDir: false },
      { path: "./.opennote/baseline.json", isDir: false },
      { path: "notes/./a.md", isDir: false },
    ];
    expect(selectSyncableEntries(entries, createIgnoreRules("")).map((item) => item.path)).toEqual(["notes/a.md"]);
  });

  it("`bytes` 是真实字节数（不是字符数 —— 中文一条三字节）", async () => {
    const { deps } = depsFor({ "notes/a.md": "中文" });
    expect((await deps.listLocal())[0]!.bytes).toBe(6);
  });
});

/* ============================================================================
   两种模式
   ============================================================================ */

describe("§3.9 · 明文与 E2EE 的差别**只在这一层**", () => {
  it("明文：`hash` 就是 `sha256(bytes)`，`did` 是可逆的 `f:`", async () => {
    const { deps } = depsFor({ "notes/a.md": "# A" });
    const listed = await deps.listLocal();
    expect(listed[0]!.hash).toBe(toHex(sha256(enc("# A"))));
    expect(deps.didOf("notes/a.md").startsWith("f:")).toBe(true);
  });

  it("★ E2EE：`hash` 是 `ehash`（**不等于** `sha256`），`did` 是不可逆的 `h:`", async () => {
    const { deps } = depsFor({ "notes/a.md": "# A" }, { cryptoMode: "user-key" });
    const listed = await deps.listLocal();
    expect(listed[0]!.hash).not.toBe(toHex(sha256(enc("# A"))));
    expect(listed[0]!.hash).toHaveLength(64);
    expect(deps.didOf("notes/a.md")).toMatch(/^h:[0-9a-f]{64}$/);
    // 同一份内容在两种模式下**内容标识不同**（这正是 E2EE 想要的）。
    const plain = depsFor({ "notes/a.md": "# A" });
    expect(listed[0]!.hash).not.toBe((await plain.deps.listLocal())[0]!.hash);
  });

  it("★ E2EE 但没给 `notebookKey` ⇒ **早失败**（不是等到写盘那一刻）", () => {
    /*
     * 到写盘那一刻才报「密钥没给」会让用户以为同步成功了 ——
     * 而那时可能已经往远端写了一半。
     */
    expect(() =>
      createWorkspaceEngineDeps({
        backend: memoryBackend({}),
        rules: createIgnoreRules(""),
        cryptoMode: "user-key",
        knownPaths: async () => [],
      }),
    ).toThrow(/必须提供 notebookKey/);
  });
});

/* ============================================================================
   透传与规范化
   ============================================================================ */

describe("透传与路径规范化", () => {
  it("`knownPaths` 直接透传（引擎靠它把远端 did 翻回本机路径）", async () => {
    const { deps } = depsFor({});
    expect(await deps.knownPaths()).toEqual(["notes/a.md"]);
  });

  it("`readLocal` / `writeLocal` / `removeLocal` 都先规范化路径", async () => {
    const { backend, deps } = depsFor({ "notes/a.md": "# A" });
    await deps.readLocal("./notes/a.md");
    await deps.writeLocal("notes/./b.md", enc("# B"));
    await deps.removeLocal("notes/./a.md");
    expect(backend.written).toEqual(["notes/b.md"]);
    expect(backend.removed).toEqual(["notes/a.md"]);
  });

  it("`log` 只在给了的时候挂上（不凭空造一个）", () => {
    const without = createWorkspaceEngineDeps({ backend: memoryBackend({}), rules: createIgnoreRules(""), cryptoMode: "none", knownPaths: async () => [] });
    expect(without.log).toBeUndefined();
    const log = vi.fn();
    const withLog = createWorkspaceEngineDeps({ backend: memoryBackend({}), rules: createIgnoreRules(""), cryptoMode: "none", knownPaths: async () => [], log });
    withLog.log?.("tree", { count: 1 });
    expect(log).toHaveBeenCalledOnce();
  });
});

/* ============================================================================
   远端内容的打开
   ============================================================================ */

describe("§3.9 · 远端来的内容：明文直通，E2EE 要解开", () => {
  it("明文模式直接返回原字节", () => {
    const bytes = enc("# 远端");
    expect(openRemoteBytes({ cryptoMode: "none", notebookId: NOTEBOOK, did: "f:x", path: "notes/a.md", bytes })).toBe(bytes);
  });

  it("E2EE 模式解出原文", () => {
    const keys = notebookKeysFrom(NOTEBOOK_KEY);
    const sealed = sealContent(keys, NOTEBOOK, "notes/a.md", enc("# 远端"));
    const opened = openRemoteBytes({ cryptoMode: "user-key", notebookKey: NOTEBOOK_KEY, notebookId: NOTEBOOK, did: sealed.did, path: "notes/a.md", bytes: sealed.bytes });
    expect(new TextDecoder().decode(opened)).toBe("# 远端");
  });

  it("★ E2EE 且 did 与路径对不上 ⇒ 抛（映射过期，而不是静默写错内容）", () => {
    const keys = notebookKeysFrom(NOTEBOOK_KEY);
    const sealed = sealContent(keys, NOTEBOOK, "notes/a.md", enc("# 远端"));
    expect(() =>
      openRemoteBytes({ cryptoMode: "user-key", notebookKey: NOTEBOOK_KEY, notebookId: NOTEBOOK, did: sealed.did, path: "notes/b.md", bytes: sealed.bytes }),
    ).toThrow(/对不上/);
  });
});
