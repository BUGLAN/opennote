/**
 * 「把工作区接上同步」的用例（`docs/执行-三端同步…` §5.1、§5.3、§5.5、§1.5 流程②）。
 *
 * ## 这里几乎每一条都在验「**宁可什么都不做**」
 *
 * 接线层的失败方式与别处不同：它不会算错什么，它会**做了不该做的事** ——
 * 往用户没同意的地址发数据、发一个没有凭证的请求、
 * 或者最糟的：**把本该加密的内容以明文发出去**。
 *
 * 所以下面每一条都在试「怎么让它退化成更糟的行为」，并断言它没有。
 */
import { describe, expect, it, vi } from "vitest";
import { attachWorkspaceSync } from "./attach";
import { createSyncLedger } from "./state";
import { encodeAccountKey, createRegistrationMaterial } from "./accountKey";
import { DISABLED_SYNC, type WorkspaceRecord, type WorkspaceSyncConfig } from "../data/workspaces";
import type { FileSystemBackend } from "../fs/types";

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";

/** 一份合法的账号密钥文本。 */
function keyText(): string {
  const material = createRegistrationMaterial();
  return encodeAccountKey({ accountId: material.accountId, accountKey: material.accountKey });
}

function recordWith(sync: WorkspaceSyncConfig): WorkspaceRecord {
  return { id: "w1", name: "笔记", kind: "node", location: "/tmp/x", addedAt: 0, lastOpenedAt: 0, sync };
}

function enabled(overrides: Partial<WorkspaceSyncConfig> = {}): WorkspaceSyncConfig {
  return { enabled: true, baseUrl: "https://notes.example.com", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a", ...overrides };
}

function emptyBackend(): FileSystemBackend {
  return {
    kind: "node",
    label: "假",
    canWrite: true,
    list: async () => [],
    readText: async () => "",
    readBytes: async () => new Uint8Array(),
    writeText: async () => undefined,
    writeBytes: async () => undefined,
    mkdir: async () => undefined,
    remove: async () => undefined,
    move: async () => undefined,
    exists: async () => true,
    stat: async () => null,
  } as unknown as FileSystemBackend;
}

function ledger() {
  return createSyncLedger({ baseUrl: "https://notes.example.com", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 });
}

/** 一个不会真的发请求的 provider 桩。 */
function stubProvider() {
  return {
    name: "stub",
    tree: async () => ({ entries: [], truncated: false }),
    changes: async () => ({ changes: [], cursor: null, truncated: false, resync: false }),
    read: async () => null,
    put: async () => ({ conflict: false as const }),
    delete: async () => ({ gone: true as const }),
    checkpoint: async () => undefined,
    purgeBefore: async () => 0,
  } as never;
}

async function attach(overrides: Partial<Parameters<typeof attachWorkspaceSync>[0]> = {}) {
  return attachWorkspaceSync({
    record: recordWith(enabled()),
    backend: emptyBackend(),
    ledger: ledger(),
    accountKeyText: keyText(),
    provider: stubProvider(),
    ...overrides,
  });
}

/* ============================================================================
   ★ 三处「宁可什么都不做」
   ============================================================================ */

describe("★ §5.1 · 关掉就**连 provider 都不建**", () => {
  it("`enabled: false` ⇒ `disabled`，且**一次网络请求都不发**", async () => {
    /*
     * 建了 provider 就有可能被别处顺手用上 —— 所以这里根本不建。
     * 断言的是「没发请求」，不是「返回了 ok:false」。
     */
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await attach({ record: recordWith({ ...DISABLED_SYNC }), provider: undefined });
      expect(result).toEqual({ ok: false, reason: "disabled", message: expect.any(String) });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("没有 `sync` 字段（老记录）⇒ 也当 `disabled`", async () => {
    const result = await attach({ record: { id: "w", name: "n", kind: "node", location: "/x", addedAt: 0, lastOpenedAt: 0 }, provider: undefined });
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("半配好（缺 notebookId）⇒ `incomplete`，不发请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await attach({ record: recordWith(enabled({ notebookId: "" })), provider: undefined });
      expect(result).toMatchObject({ ok: false, reason: "incomplete" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("★ 缺密钥 ⇒ 明确说「缺密钥」，**不静默降级**", () => {
  it("没有账号密钥 ⇒ `no-account-key`（而不是发一个没有凭证的请求）", async () => {
    /*
     * 「先连上试试」会发出一个无凭证请求，服务端只能回 401 ——
     * 用户看到「同步失败」，一个指向错误方向的报错（真因是「还没导入密钥」）。
     */
    const result = await attach({ accountKeyText: null, provider: undefined });
    expect(result).toMatchObject({ ok: false, reason: "no-account-key" });
    expect((result as { message: string }).message).toContain("密钥");
  });

  it("密钥损坏 ⇒ 也报「密钥」而不是「网络」", async () => {
    const result = await attach({ accountKeyText: "坏掉的内容", provider: undefined });
    expect(result).toMatchObject({ ok: false, reason: "no-account-key" });
    expect((result as { message: string }).message).toContain("损坏");
  });
});

describe("★★ E2EE 拿不到 notebookKey ⇒ **抛**，绝不退回明文", () => {
  it("★ 抛，而不是「明文也能跑」", async () => {
    /*
     * 这是整个文件里唯一「宁可炸也不降级」的地方。
     *
     * 退回明文意味着**把本该加密的内容以明文发出去**，而用户以为自己开着 E2EE ——
     * 那不是「功能少了一点」，那是**安全承诺被静默违背**。
     */
    await expect(attach({ record: recordWith(enabled({ cryptoMode: "user-key" })), provider: stubProvider() })).rejects.toThrow(/不会.*退回明文/);
  });

  it("给了 notebookKey 就能接上", async () => {
    const result = await attach({
      record: recordWith(enabled({ cryptoMode: "user-key" })),
      notebookKeyForNotebook: () => new Uint8Array(32).fill(7),
      provider: stubProvider(),
    });
    expect(result.ok).toBe(true);
  });
});

/* ============================================================================
   接上了之后
   ============================================================================ */

describe("接上之后", () => {
  it("正常配置 ⇒ 拿到一个 controller（可以 start/stop/resume）", async () => {
    const result = await attach();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.controller.start).toBe("function");
    expect(typeof result.controller.stop).toBe("function");
    expect(typeof result.controller.resume).toBe("function");
  });

  it("`realtime: false` ⇒ 不订阅实时，但仍然能同步", async () => {
    const opened: string[] = [];
    const result = await attach({
      realtime: false,
      openEventStream: (url) => {
        opened.push(url);
        return { close: () => undefined, addEventListener: () => undefined };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.controller.start();
    // 没建流。
    expect(opened).toEqual([]);
    result.controller.stop();
  });

  it("★ 建流时令牌走**查询串**（`EventSource` 不能设置请求头 —— §4.7 第 529 行）", async () => {
    const opened: string[] = [];
    const result = await attach({
      openEventStream: (url) => {
        opened.push(url);
        return { close: () => undefined, addEventListener: () => undefined };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.controller.start();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/v1/events?nb=");
    expect(opened[0]).toContain("authToken=");
    result.controller.stop();
  });
});
