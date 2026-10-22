import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_WIDTH_STORAGE_KEY, readContentWidthPreference, writeContentWidthPreference } from "./contentWidth";

/**
 * 自定义正文宽度的持久化（`localStorage` 里的独立键）。
 *
 * 这里守的是**记录的生命周期**：值合法才认、换了「栏宽」预设就作废、坏 JSON 不炸页面。
 * 真正的布局（拖拽换宽度）在 `lib/contentWidth.test.ts` 与浏览器里验。
 */
class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("正文宽度持久化", () => {
  it("没存过 → null（默认按栏宽预设布局）", () => {
    expect(readContentWidthPreference("normal")).toBeNull();
  });

  it("存了再读，宽度取整、预设一并记住", () => {
    writeContentWidthPreference(912.4, "normal");
    expect(readContentWidthPreference("normal")).toBe(912);
    expect(localStorage.getItem(CONTENT_WIDTH_STORAGE_KEY)).toContain('"preset":"normal"');
  });

  it("换了栏宽预设 → 旧记录作废并被删掉（设置里的切换必须立刻可见）", () => {
    writeContentWidthPreference(912, "normal");
    expect(readContentWidthPreference("wide")).toBeNull();
    expect(localStorage.getItem(CONTENT_WIDTH_STORAGE_KEY)).toBeNull();
  });

  it("写 null = 清除（双击拖拽条恢复默认）", () => {
    writeContentWidthPreference(912, "normal");
    writeContentWidthPreference(null, "normal");
    expect(readContentWidthPreference("normal")).toBeNull();
  });

  it("坏 JSON / 手改的坏值不会抛异常，按「没设置」处理", () => {
    localStorage.setItem(CONTENT_WIDTH_STORAGE_KEY, "{ not json");
    expect(readContentWidthPreference("normal")).toBeNull();
    localStorage.setItem(CONTENT_WIDTH_STORAGE_KEY, JSON.stringify({ width: "abc", preset: "normal" }));
    expect(readContentWidthPreference("normal")).toBeNull();
    localStorage.setItem(CONTENT_WIDTH_STORAGE_KEY, JSON.stringify({ width: -5, preset: "normal" }));
    expect(readContentWidthPreference("normal")).toBeNull();
  });

  it("localStorage 整个不可用（隐私模式）时读写都不抛", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    });
    expect(() => writeContentWidthPreference(900, "normal")).not.toThrow();
    expect(readContentWidthPreference("normal")).toBeNull();
  });
});
