/**
 * 传输层的用例：**客户端限速器**与 429 的全局冷却（`http.ts` 模块头）。
 *
 * 这两条是 2026-10-22 那次「满屏 429、B 设备永远同步不完」的直接修复，所以要钉住：
 *
 * 1. 请求是**平滑**放出去的（不是 8 个 worker 一起冲，十几秒把服务端的桶打空）；
 * 2. 429 是**全局**事件：所有 worker 一起停到 `Retry-After` 结束，而不是各睡各的、
 *    醒来又一起冲（那正是「每 60 秒一波 429」的成因）。
 */
import { describe, expect, it } from "vitest";
import { fetchSend, HttpTransport, Pacer, resetSharedPacersForTests, sharedPacerCount, type HttpSend } from "./http";

/** 假时钟：`sleep` 直接把时间推过去（于是用例可以断言「等了多久」）。 */
function clocked() {
  let clock = 0;
  const slept: number[] = [];
  return {
    get clock() {
      return clock;
    },
    slept,
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
  };
}

function ok() {
  return { status: 200, headers: {}, bytes: new Uint8Array() };
}

describe("★ Pacer：把请求平滑放出去", () => {
  it("专用例：`requestsPerSecond <= 0` ⇒ 完全不限速", async () => {
    const time = clocked();
    const pacer = new Pacer(0, 1, time.now, time.sleep);
    for (let index = 0; index < 100; index += 1) await pacer.acquire();
    expect(time.slept).toHaveLength(0);
  });

  it("突发容量内立刻放行，之后按速率排队", async () => {
    const time = clocked();
    // 每秒 10 个、桶容量 2。
    const pacer = new Pacer(10, 2, time.now, time.sleep);
    await pacer.acquire();
    await pacer.acquire();
    expect(time.slept).toHaveLength(0);
    await pacer.acquire();
    // 第 3 个要等攒出一个令牌：1/10 秒 = 100ms。
    expect(time.slept).toEqual([100]);
  });

  it("★ 429 的冷却对**所有** acquire 生效（不是谁被限流谁自己睡）", async () => {
    const time = clocked();
    const pacer = new Pacer(10, 4, time.now, time.sleep);
    pacer.penalize(2000);
    // 冷却结束后**放一个**（Retry-After 的语义就是「到那时候可以重试」）。
    await pacer.acquire();
    expect(time.clock).toBe(2000);
    // 第二个就要按（减半后的）速率排队了。
    await pacer.acquire();
    expect(time.clock).toBe(2200);
    expect(time.slept).toEqual([2000, 200]);
  });

  it("★ 被限流 ⇒ 速率减半（我们比服务端的桶快）；成功之后慢慢加回去", async () => {
    const time = clocked();
    const pacer = new Pacer(20, 1, time.now, time.sleep);
    pacer.penalize(1000);
    await pacer.acquire(); // 冷却结束那一个
    // 速率已经从 20/s 掉到 10/s：下一个等 100ms。
    await pacer.acquire();
    expect(time.slept).toEqual([1000, 100]);
    // 成功 50 次之后回到配置值 20/s（下一个只等 50ms）。
    for (let index = 0; index < 50; index += 1) pacer.reward();
    await pacer.acquire();
    expect(time.slept.at(-1)).toBe(50);
  });

  it("速率有下限（2/秒）：连撞多次也不会慢到「几乎不同步」", async () => {
    const time = clocked();
    const pacer = new Pacer(16, 1, time.now, time.sleep);
    for (let index = 0; index < 10; index += 1) pacer.penalize(1000);
    await pacer.acquire(); // 把冷却过掉
    await pacer.acquire();
    // 2/秒 ⇒ 500ms 一个，而不是 16/秒。
    expect(time.slept.at(-1)).toBe(500);
  });
});

describe("★ HttpTransport：429 的处理", () => {
  it("按 `Retry-After` 冷却后重试，日志里带**限额**与**哪条请求**", async () => {
    const time = clocked();
    const logs: string[] = [];
    const responses = [
      { status: 429, headers: { "retry-after": "2", "x-ratelimit-limit": "600" }, bytes: new TextEncoder().encode('{"code":"too-many"}') },
      ok(),
    ];
    const send: HttpSend = async () => responses.shift()!;
    const transport = new HttpTransport({
      baseUrl: "https://notes.example.com",
      authToken: "t",
      notebookId: "nb",
      send,
      now: time.now,
      sleep: time.sleep,
      log: (line) => logs.push(line),
    });

    const response = await transport.send({ method: "PUT", path: "/v1/file" });
    expect(response.status).toBe(200);
    // ★ 等的是服务端说的 2 秒，而不是自己拍一个指数退避。
    expect(time.slept).toEqual([2000]);
    expect(logs[0]).toContain("429");
    expect(logs[0]).toContain("限额 600");
    // 日志里要能看出是哪条请求 —— 否则只能看到「4 条 429」，不知道撞在哪儿。
    expect(logs[0]).toContain("PUT /v1/file");
  });

  it("重试次数用尽 ⇒ **如实返回 429**（不抛）", async () => {
    const time = clocked();
    const transport = new HttpTransport({
      baseUrl: "https://notes.example.com",
      authToken: "t",
      notebookId: "nb",
      send: async () => ({ status: 429, headers: { "retry-after": "1" }, bytes: new Uint8Array() }),
      maxRetries: 1,
      now: time.now,
      sleep: time.sleep,
    });
    const response = await transport.send({ method: "GET", path: "/v1/tree" });
    expect(response.status).toBe(429);
    // 首次 + 1 次重试 = 2 次请求，1 次冷却。
    expect(time.slept).toEqual([1000]);
  });

  it("★ 正常请求不会被限速器拖慢（突发容量内零等待）", async () => {
    const time = clocked();
    const transport = new HttpTransport({
      baseUrl: "https://notes.example.com",
      authToken: "t",
      notebookId: "nb",
      send: async () => ok(),
      now: time.now,
      sleep: time.sleep,
    });
    for (let index = 0; index < 5; index += 1) await transport.send({ method: "GET", path: "/v1/tree" });
    // 默认桶容量 24 ⇒ 前 5 个不该等。
    expect(time.slept).toHaveLength(0);
  });
});

describe("★ L6 · 网页/移动端的发送必须有超时", () => {
  it("到点必须失败（而不是永远挂住）", async () => {
    const send = fetchSend({
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          const abort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort);
        }),
    });

    await expect(send({ method: "GET", url: "https://notes.example.com/v1/tree", headers: {} })).rejects.toThrow(/abort/i);
  });

  it("正常响应不受影响（超时只是兜底）", async () => {
    const send = fetchSend({
      timeoutMs: 50,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });
    const response = await send({ method: "GET", url: "https://notes.example.com/v1/tree", headers: {} });
    expect(response.status).toBe(200);
    expect([...response.bytes]).toEqual([1, 2, 3]);
  });
});

describe("★ L9 · 同一账号的多个工作区共用令牌桶", () => {
  it("服务地址 + 令牌相同 ⇒ 共用一个桶；不同账号 / 不同服务各一个", () => {
    resetSharedPacersForTests();
    // 生产路径：不注入时钟 ⇒ 共享。
    new HttpTransport({ baseUrl: "https://notes.example.com", authToken: "token-a", notebookId: "nb-1" });
    new HttpTransport({ baseUrl: "https://notes.example.com", authToken: "token-a", notebookId: "nb-2" });
    expect(sharedPacerCount()).toBe(1);

    new HttpTransport({ baseUrl: "https://notes.example.com", authToken: "token-b", notebookId: "nb-3" });
    new HttpTransport({ baseUrl: "https://other.example.com", authToken: "token-a", notebookId: "nb-4" });
    expect(sharedPacerCount()).toBe(3);
    resetSharedPacersForTests();
  });

  it("注入了虚拟时钟 ⇒ **不**共享（否则单测会互相干扰）", () => {
    resetSharedPacersForTests();
    const now = () => 0;
    const sleep = async () => undefined;
    new HttpTransport({ baseUrl: "https://notes.example.com", authToken: "token-a", notebookId: "nb-1", now, sleep });
    new HttpTransport({ baseUrl: "https://notes.example.com", authToken: "token-a", notebookId: "nb-2", now, sleep });
    expect(sharedPacerCount()).toBe(0);
  });
});
