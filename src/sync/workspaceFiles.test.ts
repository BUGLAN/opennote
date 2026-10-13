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
    notebookId: NOTEBOOK,
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
        notebookId: NOTEBOOK,
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
    const without = createWorkspaceEngineDeps({ backend: memoryBackend({}), rules: createIgnoreRules(""), cryptoMode: "none", notebookId: NOTEBOOK, knownPaths: async () => [] });
    expect(without.log).toBeUndefined();
    const log = vi.fn();
    const withLog = createWorkspaceEngineDeps({ backend: memoryBackend({}), rules: createIgnoreRules(""), cryptoMode: "none", notebookId: NOTEBOOK, knownPaths: async () => [], log });
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

/* ============================================================================
   ★★ E2EE 的正文必须真的加密（这一层忘了加解密是**没有任何报错**的）
   ============================================================================ */

describe("★★ E2EE：`readLocal` 必须给出**密文**、`writeLocal` 必须写**明文**", () => {
  /*
   * ## 为什么这一组要单独存在（它咬出过一个真 bug）
   *
   * `did` 与 `ehash` 都是密文模式的（看起来完全正确），而正文走的是
   * `readLocal`/`writeLocal` 这两个回调 —— 引擎**不知道也不该知道**加解密。
   *
   * 所以如果这一层直通：**没有异常、没有日志、契约校验也全过**，
   * 而正文以**明文**发到了远端。后果是**安全承诺被静默违背**。
   *
   * 端到端那条用例（`session.test.ts`）确实咬住了它，但那条跑得慢、
   * 而且要拉起整个会话。这里补一组**快而局部**的守卫：
   * 将来谁重构了这两个回调，先红的是这一组。
   */
  const PLAINTEXT = "# 机密正文";

  function e2eeDeps() {
    const backend = memoryBackend({ "notes/a.md": PLAINTEXT });
    const deps = createWorkspaceEngineDeps({
      backend,
      rules: createIgnoreRules(""),
      cryptoMode: "user-key",
      notebookId: NOTEBOOK,
      notebookKey: NOTEBOOK_KEY,
      knownPaths: async () => ["notes/a.md"],
    });
    return { backend, deps };
  }

  it("★ `readLocal` 给出的是密文：既不含明文，长度也是 明文+40", async () => {
    const { deps } = e2eeDeps();
    const bytes = await deps.readLocal("notes/a.md");
    const asText = new TextDecoder().decode(bytes);
    expect(asText).not.toContain("机密");
    expect(asText).not.toContain("# ");
    // nonce(24) + tag(16) = 40 字节开销。
    expect(bytes.length).toBe(new TextEncoder().encode(PLAINTEXT).length + 40);
  });

  it("★ 明文模式下 `readLocal` 就是原字节（两种模式的差别**只在这一层**）", async () => {
    const backend = memoryBackend({ "notes/a.md": PLAINTEXT });
    const deps = createWorkspaceEngineDeps({ backend, rules: createIgnoreRules(""), cryptoMode: "none", notebookId: NOTEBOOK, knownPaths: async () => [] });
    expect(new TextDecoder().decode(await deps.readLocal("notes/a.md"))).toBe(PLAINTEXT);
  });

  it("★ `writeLocal` 把密文解回**明文**再落盘（同一条路径）", async () => {
    const { backend, deps } = e2eeDeps();
    const sealed = await deps.readLocal("notes/a.md");
    // 模拟「从远端拉下来这一条，写回它对应的路径」。
    await deps.writeLocal("notes/a.md", sealed);
    expect(new TextDecoder().decode(await backend.read("notes/a.md"))).toBe(PLAINTEXT);
  });

  it("★ 把 A 的密文写到 B 的路径上 ⇒ **解不开**（AAD 绑住了 did，§3.9 第 1 条）", async () => {
    /*
     * 这就是「密文重排攻击」的防线在本层的体现：不绑 did 的话，
     * B 会被静默写成 A 的内容 —— 不报错，只是内容悄悄换了一份。
     *
     * ⚠️ 我第一版这条用例写反了（期望它能写成功），红了之后才发现
     * **是断言错、实现对**。这次不用查文档也看得出来：报错文案自己说了
     * 「或者它是在别的笔记本 / 别的路径下加密的」。
     */
    const { backend, deps } = e2eeDeps();
    const sealed = await deps.readLocal("notes/a.md");
    await expect(deps.writeLocal("notes/b.md", sealed)).rejects.toThrow(/别的路径/);
    await expect(backend.read("notes/b.md")).rejects.toThrow();
  });

  it("★★ `writeLocal` 拿到**解不开的**密文 ⇒ **抛**，绝不把乱码写到盘上", async () => {
    /*
     * 静默写乱码比报错糟得多：用户的笔记**看起来还在**（文件在、大小也对），
     * 打开却是乱码，而且原来的内容已经被覆盖了。
     */
    const { backend, deps } = e2eeDeps();
    await expect(deps.writeLocal("notes/c.md", new Uint8Array(80).fill(9))).rejects.toThrow(/解不开/);
    // 而且没有留下半个文件。
    await expect(backend.read("notes/c.md")).rejects.toThrow();
  });

  it("★ E2EE 缺 `notebookId` ⇒ 早失败（它是内容 AAD 的一半，少了它加密做不了）", () => {
    expect(() =>
      createWorkspaceEngineDeps({
        backend: memoryBackend({}),
        rules: createIgnoreRules(""),
        cryptoMode: "user-key",
        notebookKey: NOTEBOOK_KEY,
        knownPaths: async () => [],
      } as never),
    ).toThrow(/notebookId/);
  });
});
