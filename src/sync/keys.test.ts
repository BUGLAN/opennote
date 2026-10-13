/**
 * 本机密钥保管的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.9、§5.2、§5.5）。
 *
 * ## 这个文件里最要紧的一条
 *
 * §3.9 对网页端写得很直白：`localStorage` **可被 XSS 读**，这是网页端 E2EE 的固有弱点，
 * 「UI 必须写明」。所以有一条用例断言 **网页端的 `readableByPageScript` 必须是 `true`**。
 *
 * 它看着像在断言一个「缺点」，但方向是对的：如果哪天有人把它改成 `false`
 * （因为「看起来更安全」），那条用例会红 —— 因为那等于**对用户撒谎**。
 * 密钥该不该存在 `localStorage` 是一个产品决定；**谎报它的暴露面**不是。
 */
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_KEY_STORAGE_KEY,
  createDesktopKeyStore,
  createMemoryKeyStore,
  createWebKeyStore,
  describeKeyStorage,
  resolveAccountKeyStore,
  type DesktopKeyBridge,
  type WebStorageLike,
} from "./keys";
import { encodeAccountKey } from "./accountKey";

/** 一份合法的密钥文本（固定值，断言才稳定）。 */
const VALID_KEY = encodeAccountKey({
  accountId: "00112233445566778899aabbccddeeff",
  accountKey: Uint8Array.from({ length: 32 }, (_, index) => index),
});
/** 另一份合法但不同的。 */
const OTHER_KEY = encodeAccountKey({
  accountId: "ffffffffffffffffffffffffffffffff",
  accountKey: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
});

/** 一个内存版 `localStorage`（也用来模拟「配额满」）。 */
function fakeStorage(options: { failWrites?: boolean } = {}): WebStorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failWrites) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key) => void map.delete(key),
  };
}

/* ============================================================================
   内存实现
   ============================================================================ */

describe("内存保管（也是「不记住」模式）", () => {
  it("往返一致；`clear()` 之后就没有了", async () => {
    const store = createMemoryKeyStore();
    expect(await store.load()).toBeNull();
    await store.save(VALID_KEY);
    expect(await store.load()).toBe(VALID_KEY);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("构造时可以给初值（用于测试与「本次会话已经有密钥」的场景）", async () => {
    expect(await createMemoryKeyStore(OTHER_KEY).load()).toBe(OTHER_KEY);
  });

  it("`save` **校验形状**：坏的值不进存储（失败要发生在边界上）", async () => {
    /*
     * 一个坏值进了存储，失败会推迟到「用户下次打开应用」——
     * 而那时的报错离「保存的时候就已经错了」很远。所以必须在边界上挡住。
     */
    const store = createMemoryKeyStore();
    await expect(store.save("不是密钥")).rejects.toThrow();
    await expect(store.save("")).rejects.toThrow();
    // 坏值没有留下任何痕迹。
    expect(await store.load()).toBeNull();
  });
});

/* ============================================================================
   网页实现（localStorage）
   ============================================================================ */

describe("网页保管（`localStorage`）", () => {
  it("往返一致，且写进的是**约定好的键名**（带版本号）", async () => {
    const storage = fakeStorage();
    const store = createWebKeyStore(storage);
    await store.save(VALID_KEY);
    expect(storage.map.get(ACCOUNT_KEY_STORAGE_KEY)).toBe(VALID_KEY);
    expect(await store.load()).toBe(VALID_KEY);
    expect(store.persisted()).toBe(true);
  });

  it("★ **`readableByPageScript` 必须是 `true`**（网页端的固有弱点，不许谎报）", () => {
    /*
     * 这条断言的方向是刻意的：它锁住「我们如实告诉用户风险」这件事。
     * 把它改成 false 不会让密钥变安全，只会让 UI 少说一句警告。
     */
    expect(createWebKeyStore(fakeStorage()).readableByPageScript).toBe(true);
    expect(createWebKeyStore(fakeStorage()).host).toBe("browser-local-storage");
  });

  it("`clear()` 真的把存储里的那条删掉（不是只清内存）", async () => {
    const storage = fakeStorage();
    const store = createWebKeyStore(storage);
    await store.save(VALID_KEY);
    await store.clear();
    expect(storage.map.has(ACCOUNT_KEY_STORAGE_KEY)).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("存储写不进去（配额满 / 隐私模式）时**不抛**，退回「只在本页有效」并如实报 `persisted()=false`", async () => {
    /*
     * 抛出去会让整个引导流程卡在第一步 —— 而那是不必要的：用户仍然可以当场用，
     * 只是刷新后要重新导入。所以这里降级，并把事实报给 UI。
     */
    const store = createWebKeyStore(fakeStorage({ failWrites: true }));
    await expect(store.save(VALID_KEY)).resolves.toBeUndefined();
    expect(store.persisted()).toBe(false);
    // 本页仍然能用（内存里那份在）。
    expect(await store.load()).toBe(VALID_KEY);
  });

  it("完全没有 `localStorage` 时也能用（只是不持久）", async () => {
    const store = createWebKeyStore(undefined);
    // 在 node 环境里 `localStorage` 不存在 ⇒ backing 为 null。
    await store.save(VALID_KEY);
    expect(store.persisted()).toBe(false);
    expect(await store.load()).toBe(VALID_KEY);
  });

  it("`save` 同样校验形状（坏值不写进存储）", async () => {
    const storage = fakeStorage();
    const store = createWebKeyStore(storage);
    await expect(store.save("opennote-key-v1.垃圾")).rejects.toThrow();
    expect(storage.map.size).toBe(0);
  });

  it("读被拒（某些浏览器的隐私模式）时退回内存而不是崩", async () => {
    const storage: WebStorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const store = createWebKeyStore(storage);
    await store.save(VALID_KEY);
    expect(await store.load()).toBe(VALID_KEY);
  });
});

/* ============================================================================
   桌面实现（转发到主进程）
   ============================================================================ */

describe("桌面保管（转发到主进程）", () => {
  function fakeBridge(initial: string | null = null, persisted = true): DesktopKeyBridge & { value: string | null; cleared: boolean } {
    const bridge = {
      value: initial,
      cleared: false,
      async load() {
        return bridge.value;
      },
      async save(text: string) {
        bridge.value = text;
      },
      async clear() {
        bridge.value = null;
        bridge.cleared = true;
      },
      async persisted() {
        return persisted;
      },
    };
    return bridge;
  }

  it("往返一致，并且**转发**给了主进程（渲染层不自己存）", async () => {
    const bridge = fakeBridge();
    const store = createDesktopKeyStore({ bridge });
    await store.save(VALID_KEY);
    // 值真的到了「主进程」那一侧。
    expect(bridge.value).toBe(VALID_KEY);
    expect(await store.load()).toBe(VALID_KEY);
    await store.clear();
    expect(bridge.cleared).toBe(true);
    expect(await store.load()).toBeNull();
  });

  it("★ **`readableByPageScript` 必须是 `false`**（密钥在主进程，渲染层拿不到原文）", () => {
    expect(createDesktopKeyStore({ bridge: fakeBridge() }).readableByPageScript).toBe(false);
    expect(createDesktopKeyStore({ bridge: fakeBridge() }).host).toBe("desktop-main");
  });

  it("主进程报告「没有 safeStorage」时，`onPersistence` 收到 false（UI 要据此如实说明）", async () => {
    const seen: boolean[] = [];
    const store = createDesktopKeyStore({ bridge: fakeBridge(null, false), onPersistence: (value) => void seen.push(value) });
    await store.save(VALID_KEY);
    expect(seen).toEqual([false]);
  });

  it("磁盘上的值被手工改坏 ⇒ 当「没有」处理（让用户重新导入，而不是在派生时炸）", async () => {
    const store = createDesktopKeyStore({ bridge: fakeBridge("被手工改坏的内容") });
    expect(await store.load()).toBeNull();
  });

  it("`save` 校验形状（坏值不落到主进程）", async () => {
    const bridge = fakeBridge();
    await expect(createDesktopKeyStore({ bridge }).save("坏值")).rejects.toThrow();
    expect(bridge.value).toBeNull();
  });
});

/* ============================================================================
   宿主选择
   ============================================================================ */

describe("按宿主挑实现", () => {
  it("`window.opennote.syncKeys` 在 ⇒ 走主进程（桌面优先）", () => {
    const scope = globalThis as { window?: unknown };
    const saved = scope.window;
    scope.window = { opennote: { isElectron: true, syncKeys: { load: async () => null, save: async () => undefined, clear: async () => undefined, persisted: async () => true } } };
    try {
      expect(resolveAccountKeyStore().host).toBe("desktop-main");
    } finally {
      scope.window = saved;
    }
  });

  it("没有桌面桥 ⇒ 走 `localStorage`", () => {
    expect(resolveAccountKeyStore({ storage: fakeStorage() }).host).toBe("browser-local-storage");
  });

  it("有 `isElectron` 但**没有** `syncKeys`（旧版 preload）⇒ 退回 `localStorage`，不崩", () => {
    const scope = globalThis as { window?: unknown };
    const saved = scope.window;
    scope.window = { opennote: { isElectron: true } };
    try {
      expect(resolveAccountKeyStore({ storage: fakeStorage() }).host).toBe("browser-local-storage");
    } finally {
      scope.window = saved;
    }
  });
});

/* ============================================================================
   给 UI 的说明
   ============================================================================ */

describe("§3.9 · 「密钥存在哪、有什么风险」必须说得准", () => {
  it("网页端**必须**给出 XSS 警告（这是文档明确要求的）", () => {
    const described = describeKeyStorage(createWebKeyStore(fakeStorage()));
    expect(described.risk).toBeTruthy();
    expect(described.risk).toContain("恶意脚本");
    // 而且要给用户一条出路（「不记住」），不能只是吓唬。
    expect(described.risk).toContain("不记住");
  });

  it("桌面端**不该**报一个它没有的风险（错报风险与瞒报一样有害）", () => {
    const described = describeKeyStorage(
      createDesktopKeyStore({
        bridge: { load: async () => null, save: async () => undefined, clear: async () => undefined, persisted: async () => true },
      }),
    );
    expect(described.risk).toBeNull();
    expect(described.where).toContain("主进程");
  });

  it("内存（不记住）模式说清「刷新后要重新导入」", () => {
    const described = describeKeyStorage(createMemoryKeyStore());
    expect(described.where).toContain("重新导入");
    expect(described.risk).toBeNull();
  });

  it("四个宿主都有说明（`switch` 没有漏分支）", () => {
    const hosts = [
      createMemoryKeyStore(),
      createWebKeyStore(fakeStorage()),
      createDesktopKeyStore({ bridge: { load: async () => null, save: async () => undefined, clear: async () => undefined, persisted: async () => true } }),
    ];
    for (const store of hosts) {
      const described = describeKeyStorage(store);
      expect(described.where.length).toBeGreaterThan(4);
    }
  });
});

/* ============================================================================
   一条「界面文案」的守卫：不许出现 emoji
   ============================================================================ */

describe("界面文案纪律", () => {
  it("`describeKeyStorage` 的文案里没有 emoji（产品规则：界面文案无 emoji）", async () => {
    /*
     * 这条是**产品级规则**（`verify-contract.cjs` 的 U-8）在单元层面的前哨：
     * 我第一版在风险文案里放了 ⚠️，被 U-8 咬住了。与其等那个大检查器报，
     * 不如在这里就有一道 —— 它跑得快，而且报错时直接指向这几句文案。
     */
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src", "sync", "keys.ts"), "utf8");
    // 剥掉注释（注释里的 emoji 不算界面文案）。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const emoji = code.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu);
    expect(emoji, `界面文案里出现了 emoji：${emoji?.join("")}`).toBeNull();
    void vi;
  });
});
