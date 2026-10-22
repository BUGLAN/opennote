/**
 * 桌面端的实时推送适配（`desktopStream.ts`）。
 *
 * 这里钉三件事，每一件都是「看起来能用、其实坏了」的类型：
 * ① `relPath` 必须是**相对** base 的（不能带 origin）——否则渲染层就能左右目的地；
 * ② 主进程推来的 `open` / `ready` / `change` / `heartbeat` 必须**原样**转发（`data` 不能丢）；
 * ③ `close()` 必须同时退订与断流（少一半就会留下一条没人读还在跑的连接）。
 */
import { describe, expect, it } from "vitest";
import { createDesktopEventStream, supportsDesktopStream, type DesktopStreamBridge } from "./desktopStream";

function fakeBridge() {
  const emitted: { type: string; data?: string }[] = [];
  let listener: ((message: { type: string; data?: string }) => void) | null = null;
  let opened: string | null = null;
  let closed = 0;
  const bridge: DesktopStreamBridge = {
    openStream(relPath) {
      opened = relPath;
      return Promise.resolve(true);
    },
    closeStream() {
      closed += 1;
      return Promise.resolve(true);
    },
    onStreamEvent(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return {
    bridge,
    push(type: string, data?: string) {
      listener?.(data === undefined ? { type } : { type, data });
    },
    opened: () => opened,
    closedCount: () => closed,
    emitted,
    hasListener: () => listener !== null,
  };
}

describe("桌面端实时流：只交相对路径、事件原样转发", () => {
  it("交给主进程的是 path + query（不带 origin），令牌仍走查询串", () => {
    const harness = fakeBridge();
    createDesktopEventStream({
      url: "https://notes.example.com/v1/events?nb=abc&authToken=deadbeef",
      bridge: harness.bridge,
    });
    expect(harness.opened()).toBe("/v1/events?nb=abc&authToken=deadbeef");
    // ★ 绝不能把 origin 带过去：主进程的 base 是配置定的，渲染层不该能改目的地。
    expect(harness.opened()!.startsWith("/")).toBe(true);
    expect(harness.opened()).not.toContain("http");
  });

  it("open / ready / change / heartbeat 逐条转发，data 不丢", () => {
    const harness = fakeBridge();
    const stream = createDesktopEventStream({ url: "/v1/events", bridge: harness.bridge });
    const seen: { type: string; data?: string }[] = [];
    for (const type of ["open", "ready", "change", "heartbeat"]) {
      stream.addEventListener(type, (event) => seen.push({ type, ...(event.data === undefined ? {} : { data: event.data }) }));
    }

    harness.push("open");
    harness.push("ready", '{"cursor":"5"}');
    harness.push("change", '{"cursor":"7","count":2}');
    harness.push("heartbeat", "{}");

    expect(seen).toEqual([
      { type: "open" },
      { type: "ready", data: '{"cursor":"5"}' },
      { type: "change", data: '{"cursor":"7","count":2}' },
      { type: "heartbeat", data: "{}" },
    ]);
  });

  it("close() 同时退订与断流（少一半就会留下没人读还在跑的连接）", () => {
    const harness = fakeBridge();
    const stream = createDesktopEventStream({ url: "/v1/events", bridge: harness.bridge });
    expect(harness.hasListener()).toBe(true);

    stream.close();
    expect(harness.hasListener()).toBe(false);
    expect(harness.closedCount()).toBe(1);

    // 退订之后主进程再推事件，不该再冒出来。
    const seen: string[] = [];
    stream.addEventListener("change", () => seen.push("change"));
    harness.push("change", "{}");
    expect(seen).toEqual([]);

    // 重复 close 不该重复断流。
    stream.close();
    expect(harness.closedCount()).toBe(1);
  });

  it("开流失败 ⇒ 发出 error 事件（上层据此退避重连）", async () => {
    const harness = fakeBridge();
    harness.bridge.openStream = () => Promise.reject(new Error("HTTP 503"));
    const stream = createDesktopEventStream({ url: "/v1/events", bridge: harness.bridge });
    const errors: (string | undefined)[] = [];
    stream.addEventListener("error", (event) => errors.push(event.data));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(["HTTP 503"]);
  });

  it("旧版 preload（没有这三个方法）⇒ supportsDesktopStream 为假，退回 EventSource", () => {
    expect(supportsDesktopStream({ configure: () => {}, setAuthToken: () => {}, request: () => {} })).toBe(false);
    expect(supportsDesktopStream(null)).toBe(false);
    expect(supportsDesktopStream("nope")).toBe(false);
    expect(
      supportsDesktopStream({ openStream: () => {}, closeStream: () => {}, onStreamEvent: () => () => {} }),
    ).toBe(true);
  });
});
