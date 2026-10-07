import { afterEach, describe, expect, it } from "vitest";
import { appVersion } from "./appVersion";

/**
 * 版本号产地的判据：桌面桥优先（描述正在运行的二进制），网页退到构建常量，
 * 两处都没有 → null（调用方如实显示「版本未知」，绝不拿别的版本号冒充）。
 *
 * vitest 是 node 环境：`window` 与 `__OPENNOTE_VERSION__` 都不存在，
 * 测试通过 globalThis 临时伪造这两个入口（未限定标识符会查到 globalThis，
 * 与 Vite `define` 在构建期的字面量替换是同一个消费口）。
 */

const globalScope = globalThis as Record<string, unknown>;

afterEach(() => {
  delete globalScope.__OPENNOTE_VERSION__;
  delete globalScope.window;
});

describe("appVersion", () => {
  it("桌面桥优先：window.opennote.version 是运行时权威，压过构建常量", () => {
    globalScope.window = { opennote: { version: "9.9.9" } };
    globalScope.__OPENNOTE_VERSION__ = "0.7.3";
    expect(appVersion()).toBe("9.9.9");
  });

  it("没有桌面桥（网页版）→ 用构建时烧进包的版本号", () => {
    globalScope.__OPENNOTE_VERSION__ = "0.7.3";
    expect(appVersion()).toBe("0.7.3");
  });

  it("两处都读不到 → null（调用方如实显示「版本未知」）", () => {
    expect(appVersion()).toBeNull();
  });

  it("空字符串版本不算数", () => {
    globalScope.__OPENNOTE_VERSION__ = "";
    expect(appVersion()).toBeNull();
  });

  it("桥上没有 version 字段（或类型不对）→ 退到构建常量，而不是崩溃", () => {
    globalScope.window = { opennote: { isElectron: true } };
    globalScope.__OPENNOTE_VERSION__ = "0.7.3";
    expect(appVersion()).toBe("0.7.3");
  });
});
