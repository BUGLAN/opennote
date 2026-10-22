/**
 * 工作区同步配置的用例（`docs/执行-三端同步…` §5.3「后端/同步选择的唯一接缝」、§5.1）。
 *
 * ## 这里断言的核心是**退化方向**
 *
 * 同步是**旁路**（§5.1）：不开就不碰网络。所以「读到一个坏值」时的正确退化是**关掉**，
 * 而不是猜一个配置去连。下面每一组坏输入都在验同一件事：
 * **半配好的同步绝不能跑起来** —— 那会往一个没验证过的地址发数据。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISABLED_SYNC, normalizeSyncConfig } from "./workspaces";

const GOOD = { enabled: true, baseUrl: "https://notes.example.com", notebookId: "11111111-2222-4333-8444-555555555555", cryptoMode: "none", accountRef: "acct" };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("§5.3 · 默认关", () => {
  it("没有 `sync` 字段（老记录）⇒ 关", () => {
    expect(normalizeSyncConfig(undefined)).toEqual(DISABLED_SYNC);
    expect(normalizeSyncConfig(null)).toEqual(DISABLED_SYNC);
  });

  it("完全合法的配置 ⇒ 开", () => {
    expect(normalizeSyncConfig(GOOD)).toEqual(GOOD);
  });

  it("`DISABLED_SYNC` 是冻结的默认值（防止调用方改到共享常量）", () => {
    // 至少确认它是「关」且字段齐全。
    expect(DISABLED_SYNC.enabled).toBe(false);
    expect(DISABLED_SYNC.cryptoMode).toBe("none");
  });
});

describe("★ 只有**恰好** `true` 才算开（坏值不许把同步意外打开）", () => {
  it("各种「像真值但不是 `true`」的值都退化成关", () => {
    for (const enabled of ["true", 1, "yes", {}, [], "1"]) {
      expect(normalizeSyncConfig({ ...GOOD, enabled }).enabled, `enabled=${JSON.stringify(enabled)}`).toBe(false);
    }
  });

  it("`enabled: false` 就是关", () => {
    expect(normalizeSyncConfig({ ...GOOD, enabled: false }).enabled).toBe(false);
  });
});

describe("★ 半配好的同步视为**关**（绝不能往没验证过的地址发数据）", () => {
  it("开了但没有 `notebookId` ⇒ 关", () => {
    expect(normalizeSyncConfig({ ...GOOD, notebookId: "" }).enabled).toBe(false);
    expect(normalizeSyncConfig({ ...GOOD, notebookId: "   " }).enabled).toBe(false);
    expect(normalizeSyncConfig({ ...GOOD, notebookId: 42 }).enabled).toBe(false);
  });

  it("开了但没有 `baseUrl` ⇒ 关", () => {
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "" }).enabled).toBe(false);
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "   " }).enabled).toBe(false);
  });

  it("★ 地址不是 http/https ⇒ 关（`javascript:` / `file:` 之类的值不许被当成服务地址）", () => {
    for (const baseUrl of ["javascript:alert(1)", "file:///etc/passwd", "notes.example.com", "ftp://x", "data:text/plain,x", "://坏"]) {
      expect(normalizeSyncConfig({ ...GOOD, baseUrl }).enabled, baseUrl).toBe(false);
    }
  });

  it("`http` 与 `https` **都**可用（本地开发就是 http）", () => {
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "http://localhost:8787" }).enabled).toBe(true);
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "https://notes.example.com" }).enabled).toBe(true);
  });

  it("地址两边的空白被去掉（用户从文档里复制常常带上空格）", () => {
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "  https://notes.example.com  " }).baseUrl).toBe("https://notes.example.com");
  });

  it("★ 尾部斜杠被去掉（带斜杠与不带斜杠是**同一个服务**）", () => {
    /*
     * 真机事故：存储里是带斜杠的地址，账本里是不带斜杠的（createSyncLedger 会剥）。
     * 逐字比较 ⇒ 判成「换了服务器」⇒ 丢账本 ⇒ **每次打开应用把 880 篇全量重推一遍**。
     */
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "http://45.202.241.98:8787/" }).baseUrl).toBe("http://45.202.241.98:8787");
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "https://notes.example.com//" }).baseUrl).toBe("https://notes.example.com");
    // 子路径部署要保留路径，不能把 /notes 一起吃掉。
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "https://example.com/notes/" }).baseUrl).toBe("https://example.com/notes");
    // 剥完仍然是合法地址 ⇒ 同步照常开着。
    expect(normalizeSyncConfig({ ...GOOD, baseUrl: "http://45.202.241.98:8787/" }).enabled).toBe(true);
  });
});

describe("坏形状不许抛（`load()` 是把 JSON 直接断言成记录数组的）", () => {
  it("`sync` 是字符串 / 数字 / 数组 / 函数都不抛，一律退化成关", () => {
    for (const sync of ["yes", 42, [], true, () => undefined]) {
      const normalized = normalizeSyncConfig(sync);
      expect(normalized.enabled, `sync=${String(sync)}`).toBe(false);
      expect(normalized.baseUrl).toBe("");
      expect(normalized.notebookId).toBe("");
    }
  });
});

describe("`cryptoMode` 只认两个值，缺省是 `none`", () => {
  it("`user-key` 透传", () => {
    expect(normalizeSyncConfig({ ...GOOD, cryptoMode: "user-key" }).cryptoMode).toBe("user-key");
  });

  it("别的值（含缺失、大小写不同）都退化成 `none`", () => {
    for (const cryptoMode of [undefined, null, "", "NONE", "userkey", "user_key", 1, {}]) {
      expect(normalizeSyncConfig({ ...GOOD, cryptoMode }).cryptoMode, String(cryptoMode)).toBe("none");
    }
  });
});

describe("`accountRef` 是引用而不是密钥", () => {
  it("透传字符串；非字符串退化成空串", () => {
    expect(normalizeSyncConfig({ ...GOOD, accountRef: "abc" }).accountRef).toBe("abc");
    expect(normalizeSyncConfig({ ...GOOD, accountRef: 42 }).accountRef).toBe("");
  });

  it("★ 规范化结果里**没有**任何像密钥的字段（它要进 `localStorage`）", () => {
    /*
     * 工作区记录会写进 `localStorage` —— 一个可被 XSS 读的地方。
     * 所以这里只许有「指向账号的引用」，不许有 `accountKey` / `authToken` 之类。
     */
    const normalized = normalizeSyncConfig({ ...GOOD, accountKey: "不该在这里", authToken: "也不该", wrappedEncRoot: "也不该" });
    const keys = Object.keys(normalized).sort();
    expect(keys).toEqual(["accountRef", "baseUrl", "cryptoMode", "enabled", "notebookId"]);
    expect(JSON.stringify(normalized)).not.toContain("不该在这里");
  });
});

/* ============================================================================
   `load()` 真的会规范化持久化的记录（上面测的是纯函数，这里测接线）
   ============================================================================ */

describe("新建的工作区**显式**带一份「关掉的同步」", () => {
  it("★ 记录落盘就是完整形状（别的读它的地方不必各自处理「字段可能不存在」）", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.resetModules();
    try {
      const mod = await import("./workspaces");
      // `rememberWorkspace` 是**所有**创建路径（node / fsa / capacitor）最后都走的那一个。
      const created = mod.rememberWorkspace({ name: "新笔记本", kind: "node", location: "/tmp/x" });
      expect(created.sync).toEqual(DISABLED_SYNC);
      expect(created.sync!.enabled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("`load()` 的接线：坏记录在**读的时候**就被规范化", () => {
  it("★ 存了一份坏 `sync` 的记录 ⇒ 读出来是「关」，且不抛", async () => {
    /*
     * `load()` 把 `localStorage` 里的 JSON **直接断言**成 `WorkspaceRecord[]`
     * （没有逐字段校验）。加了一个嵌套对象之后，一个坏记录会让
     * `record.sync.enabled` 在运行期炸或悄悄变成 `undefined`。
     *
     * 所以这条用例走**真实入口**：写一份坏记录 → 重新加载模块 → 看注册表里的值。
     */
    const stored = {
      workspaces: [
        { id: "w1", name: "坏记录", kind: "node", location: "/tmp/x", addedAt: 1, lastOpenedAt: 2, sync: "yes" },
        {
          id: "w2",
          name: "半配好",
          kind: "node",
          location: "/tmp/y",
          addedAt: 1,
          lastOpenedAt: 3,
          // 开了但没有 notebookId ⇒ 必须退化成关。
          sync: { enabled: true, baseUrl: "https://notes.example.com", notebookId: "" },
        },
        {
          id: "w3",
          name: "合法",
          kind: "node",
          location: "/tmp/z",
          addedAt: 1,
          lastOpenedAt: 4,
          sync: { enabled: true, baseUrl: "https://notes.example.com", notebookId: "nb-1", cryptoMode: "none", accountRef: "a" },
        },
      ],
      activeId: "w3",
    };
    const backing = new Map<string, string>([["opennote.workspaces.v1", JSON.stringify(stored)]]);
    const fakeLocalStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    };
    vi.stubGlobal("localStorage", fakeLocalStorage);
    vi.resetModules();
    try {
      const mod = await import("./workspaces");
      const byId = new Map(mod.listWorkspaces().map((record) => [record.id, record]));
      // 坏形状 ⇒ 关，而且**不抛**。
      expect(byId.get("w1")!.sync).toEqual(DISABLED_SYNC);
      // 半配好 ⇒ 关（这是最要紧的一条）。
      expect(byId.get("w2")!.sync!.enabled).toBe(false);
      // 合法的照常开。
      expect(byId.get("w3")!.sync!.enabled).toBe(true);
      expect(byId.get("w3")!.sync!.notebookId).toBe("nb-1");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
