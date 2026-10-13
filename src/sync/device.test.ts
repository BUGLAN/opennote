/**
 * `deviceId` 与 `.opennote/` 同步边界（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.7、§5.4 第 4 条）。
 *
 * 这里钉住的是两条**很容易被将来的改动破坏**的纪律：
 *   1. `deviceId` 只存站点存储，**绝不进 `.opennote/`**（跨端会让两台设备共用一个检查点）；
 *   2. 凭据材料与本机专属字段不许落进笔记本目录（红线 3）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_ID_KEY,
  createDeviceId,
  getDeviceId,
  isDeviceIdEphemeral,
  isValidDeviceId,
  resetDeviceIdForTests,
  setDeviceIdForTests,
} from "./device";
import {
  assertSafeLocalMetaPayload,
  findCredentialKeys,
  findLocalOnlyKeys,
  isMetaPath,
  isSyncableMetaPath,
} from "./boundary";

/** 一个最小的 localStorage 替身（`ui.ts` 用的也是同一套「可能抛」的语义）。 */
function installStorage(): Storage {
  const map = new Map<string, string>();
  const store = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  vi.stubGlobal("localStorage", store);
  return store;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetDeviceIdForTests();
});

describe("deviceId · 形状与生成", () => {
  it("生成的是 32 位小写十六进制，且通过形状校验", () => {
    const id = createDeviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidDeviceId(id)).toBe(true);
  });

  it("两次生成不相同（CSPRNG，不是 Math.random）", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createDeviceId()));
    expect(seen.size).toBe(200);
  });

  it("形状校验拒绝明显不对的值", () => {
    for (const bad of ["", "abc", "A".repeat(32), "0".repeat(31), "0".repeat(33), "z".repeat(32), null, 42, undefined]) {
      expect(isValidDeviceId(bad)).toBe(false);
    }
  });

  it("没有 crypto.getRandomValues 时明确报错，不悄悄退化", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createDeviceId()).toThrow(/getRandomValues/);
  });
});

describe("deviceId · 存放位置（绝不进 .opennote/）", () => {
  it("存进站点存储的固定键，且读回同一个值", () => {
    installStorage();
    const first = getDeviceId();
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(first);
    expect(isDeviceIdEphemeral()).toBe(false);
    // 清掉模块内缓存但**保留存储**：模拟「重开应用」，必须还是同一个设备。
    resetDeviceIdForTests({ clearStorage: false });
    expect(getDeviceId()).toBe(first);
  });

  it("站点存储里的坏值被覆盖，而不是原样拿来用", () => {
    const store = installStorage();
    store.setItem(DEVICE_ID_KEY, "手改过的坏值");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = getDeviceId();
    expect(isValidDeviceId(id)).toBe(true);
    expect(store.getItem(DEVICE_ID_KEY)).toBe(id);
  });

  it("站点存储不可用（企业策略/嵌入式 WebView）时退回本会话临时值，而不是抛", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = getDeviceId();
    expect(isValidDeviceId(id)).toBe(true);
    expect(isDeviceIdEphemeral()).toBe(true);
    // 同一次运行内必须稳定（否则「我同步到哪了」这条路会断）。
    expect(getDeviceId()).toBe(id);
  });

  it("localStorage 的 getter 直接抛时也不能把应用带崩", () => {
    vi.stubGlobal(
      "localStorage",
      Object.defineProperty({}, "getItem", {
        get() {
          throw new Error("SecurityError");
        },
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isValidDeviceId(getDeviceId())).toBe(true);
    expect(isDeviceIdEphemeral()).toBe(true);
  });

  it("测试夹具只接受合法形状（防止用例里塞进一个假 id 掩盖真实约束）", () => {
    expect(() => setDeviceIdForTests("not-a-device-id")).toThrow();
    setDeviceIdForTests("a".repeat(32));
    expect(getDeviceId()).toBe("a".repeat(32));
  });
});

describe(".opennote/ 同步边界表", () => {
  it("整个 .opennote/ 都不跨端", () => {
    for (const path of [
      ".opennote",
      ".opennote/state.json",
      ".opennote/trash/旧笔记.md",
      ".opennote/history/笔记/2026-01-01-abcd.md",
      ".opennote/inbox/剪藏.md",
      ".opennote/sync.json",
      ".opennote/github.json",
      ".opennote/import-index.json",
    ]) {
      expect(isSyncableMetaPath(path)).toBe(false);
    }
  });

  it("普通笔记与附件照常跨端（别把整棵库都判死）", () => {
    for (const path of ["notes/a.md", "assets/x.png", "日记/2026-10-13.md", "a..b.md"]) {
      expect(isSyncableMetaPath(path)).toBe(true);
      expect(isMetaPath(path)).toBe(false);
    }
    expect(isMetaPath(".opennote/state.json")).toBe(true);
  });

  it("前缀匹配不会误伤名字相似的东西", () => {
    // `.opennett/` 不是 `.opennote/`。
    expect(isSyncableMetaPath(".opennett/x.md")).toBe(true);
    expect(isMetaPath(".opennett/x.md")).toBe(false);
  });
});

describe("凭据与本机专属字段的闸门", () => {
  it("凭据材料在任意深度都能被抓到（红线 3）", () => {
    const payload = { version: 1, account: { nested: { accountKey: "deadbeef" } }, auth_token: "x" };
    const hits = findCredentialKeys(payload);
    expect(hits.map((h) => h.key).sort()).toEqual(["accountKey", "auth_token"]);
    expect(hits.find((h) => h.key === "accountKey")?.at).toBe("$.account.nested.accountKey");
  });

  it("本机专属字段（deviceId / did 映射）能被抓到", () => {
    const hits = findLocalOnlyKeys({ ledger: { deviceId: "a".repeat(32) }, didMap: { "h:1": "a.md" } });
    expect(hits.map((h) => h.key).sort()).toEqual(["deviceId", "didMap"]);
  });

  it("assertSafeLocalMetaPayload 命中即抛，并说清是哪一个字段、为什么", () => {
    expect(() => assertSafeLocalMetaPayload({ version: 1, deviceId: "a".repeat(32) }, "sync.json")).toThrow(
      /本机专属/,
    );
    expect(() => assertSafeLocalMetaPayload({ encRoot: "x" }, "sync.json")).toThrow(/凭据材料/);
  });

  it("干净载荷不抛（别把正常账本也拦住）", () => {
    expect(() =>
      assertSafeLocalMetaPayload(
        {
          version: 1,
          baseUrl: "https://notes.example.com",
          notebookId: "nb-abc",
          files: { "notes/a.md": { hash: "sha256:…", rev: "3-abc", did: "f:bm90ZXMvYS5tZA" } },
        },
        "sync.json",
      ),
    ).not.toThrow();
  });

  it("数组与 null 不会让扫描器崩掉", () => {
    expect(findCredentialKeys([null, undefined, 1, "x", [{ accountKey: "a" }]])).toHaveLength(1);
    expect(findCredentialKeys(null)).toEqual([]);
    expect(findLocalOnlyKeys("just a string")).toEqual([]);
  });
});
