/**
 * 网页版页面载体（`src/lib/pageStage.ts`）的用例。
 *
 * 这里只测**判定逻辑**，不测真的 Service Worker（那个由 `pnpm probe:page` 的
 * 真实 Electron 探针与 `pnpm build` 的产物共同覆盖）。
 *
 * 被钉住的核心是一条纪律：**失败要按真实原因说，不许假装成功**。
 * 假装成功的形态很具体 —— 返回一个 URL、iframe 永远转圈或永远空白，而界面上什么都不说。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROLLER_WAIT_MS, PAGE_ROUTE_PREFIX, PAGE_STAGE_MESSAGE, pageRouteUrl, releasePage, stagePage, waitForController } from "./pageStage";

const realNavigator = globalThis.navigator;

/** 造一个假 `navigator.serviceWorker`（只实现这些用例用到的部分）。 */
function fakeServiceWorker(options: { controller?: unknown; onPostMessage?: (message: unknown) => void } = {}) {
  const listeners = new Set<(event: { source?: unknown; data?: unknown }) => void>();
  const container = {
    controller: options.controller ?? null,
    addEventListener: (_type: string, listener: (event: { source?: unknown; data?: unknown }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { source?: unknown; data?: unknown }) => void) => listeners.delete(listener),
  };
  const controller = {
    postMessage(message: unknown) {
      options.onPostMessage?.(message);
    },
  };
  return { container, controller, listeners };
}

function withNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: realNavigator, configurable: true });
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.useRealTimers();
});

describe("pageRouteUrl", () => {
  it("拼在应用 base 下面（子路径部署也要正确）", () => {
    expect(pageRouteUrl("abc", "/")).toBe("/__page/abc");
    expect(pageRouteUrl("abc", "/opennote/")).toBe("/opennote/__page/abc");
    // base 少了结尾斜杠也要拼对（不能拼出 /opennote__page/）
    expect(pageRouteUrl("abc", "/opennote")).toBe("/opennote/__page/abc");
  });

  it("token 会被编码（不让它偷偷变成路径层级）", () => {
    expect(pageRouteUrl("a/b", "/")).toBe("/__page/a%2Fb");
  });

  it("前缀常量与串起来的 URL 一致（改一处不改另一处会被这条抓住）", () => {
    expect(PAGE_ROUTE_PREFIX).toBe("/__page/");
    expect(pageRouteUrl("x", "/")).toContain(PAGE_ROUTE_PREFIX);
  });
});

describe("stagePage：没有 SW 时如实失败", () => {
  it("浏览器没有 serviceWorker ⇒ 给出原因，不返回 URL", async () => {
    withNavigator({});
    const result = await stagePage("<p>x</p>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Service Worker");
  });

  it("手机 App（Capacitor 原生壳）⇒ 立刻说「不支持」，**不**等 8 秒超时", async () => {
    (globalThis as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = { isNativePlatform: () => true };
    withNavigator({ serviceWorker: fakeServiceWorker().container });
    const started = Date.now();
    const result = await stagePage("<p>x</p>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("手机 App");
    // 立刻返回：不允许先等一个超时再报同一个原因
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("有 SW 但没有 controller ⇒ 等满上限后如实说「还没准备好」", async () => {
    vi.useFakeTimers();
    const fake = fakeServiceWorker({ controller: null });
    withNavigator({ serviceWorker: fake.container });
    const promise = stagePage("<p>x</p>", { timeoutMs: 50 });
    /*
     * 要推过**两道**超时：先等 controller（CONTROLLER_WAIT_MS，stagePage 用的是默认值），
     * 再等回执（这里传的 50ms）。只推 60ms 会停在第一道 —— 那正是这条用例第一次写错的地方：
     * 它以为 `timeoutMs` 同时管两件事，而实际上「等接管」与「等回执」是两个不同的上限。
     */
    await vi.advanceTimersByTimeAsync(CONTROLLER_WAIT_MS + 100);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("刷新");
  });

  it("controller 在等待期间接管 ⇒ 继续往下走（不是直接判失败）", async () => {
    const fake = fakeServiceWorker({ controller: null });
    withNavigator({ serviceWorker: fake.container });
    const promise = waitForController({ timeoutMs: 5000 });
    // 模拟 SW 接管：controller 变成对象 + 触发 controllerchange
    fake.container.controller = fake.controller;
    for (const listener of fake.listeners) listener({});
    await expect(promise).resolves.toBe(true);
  });
});

describe("stagePage：SW 有回执时给出可用的 URL", () => {
  it("回执 ok ⇒ 返回 /__page/<token>", async () => {
    const fake = fakeServiceWorker({
      controller: null,
      onPostMessage: (message) => {
        const payload = message as { token: string };
        // 模拟 SW 立刻回执（异步，避免与监听注册的时序打架）
        setTimeout(() => {
          for (const listener of fake.listeners) {
            listener({ source: fake.controller, data: { type: PAGE_STAGE_MESSAGE, token: payload.token, ok: true } });
          }
        }, 0);
      },
    });
    fake.container.controller = fake.controller;
    withNavigator({ serviceWorker: fake.container });
    const result = await stagePage("<p>x</p>", { token: "tok-1", baseUrl: "/" });
    expect(result).toEqual({ ok: true, url: "/__page/tok-1" });
  });

  it("SW 回执 ok:false ⇒ 把 SW 给的原因原样传下去（不自己编文案）", async () => {
    const fake = fakeServiceWorker({
      controller: null,
      onPostMessage: (message) => {
        const payload = message as { token: string };
        setTimeout(() => {
          for (const listener of fake.listeners) {
            listener({
              source: fake.controller,
              data: { type: PAGE_STAGE_MESSAGE, token: payload.token, ok: false, reason: "页面内容太大了" },
            });
          }
        }, 0);
      },
    });
    fake.container.controller = fake.controller;
    withNavigator({ serviceWorker: fake.container });
    const result = await stagePage("<p>x</p>", { token: "tok-2", baseUrl: "/" });
    expect(result).toEqual({ ok: false, reason: "页面内容太大了" });
  });

  it("别人的回执（token 不匹配）不被当成自己的结果", async () => {
    vi.useFakeTimers();
    const fake = fakeServiceWorker({
      controller: null,
      onPostMessage: () => {
        setTimeout(() => {
          for (const listener of fake.listeners) {
            listener({ source: fake.controller, data: { type: PAGE_STAGE_MESSAGE, token: "别的页面", ok: true } });
          }
        }, 0);
      },
    });
    fake.container.controller = fake.controller;
    withNavigator({ serviceWorker: fake.container });
    const promise = stagePage("<p>x</p>", { token: "mine", baseUrl: "/", timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(40);
    const result = await promise;
    expect(result.ok).toBe(false);
  });
});

describe("releasePage", () => {
  it("发一条 html:null 的消息（释放那条内容）", () => {
    const sent: unknown[] = [];
    const fake = fakeServiceWorker({ onPostMessage: (message) => sent.push(message) });
    fake.container.controller = fake.controller;
    withNavigator({ serviceWorker: fake.container });
    releasePage("tok-3");
    expect(sent).toEqual([{ type: PAGE_STAGE_MESSAGE, token: "tok-3", html: null }]);
  });

  it("没有 controller 时静默返回（清理动作不该抛）", () => {
    const fake = fakeServiceWorker({ controller: null });
    withNavigator({ serviceWorker: fake.container });
    expect(() => releasePage("tok-4")).not.toThrow();
  });
});

describe("超时常量", () => {
  it("等 controller 的上限有限（不能是 Infinity，也不能长得像卡死）", () => {
    expect(CONTROLLER_WAIT_MS).toBeGreaterThan(1000);
    expect(CONTROLLER_WAIT_MS).toBeLessThan(30000);
  });
});
