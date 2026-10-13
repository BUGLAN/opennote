/**
 * 桌面端传输分支的用例（`docs/执行-三端同步…` §5.5、§5.3）。
 *
 * ## 这一层要做的事看着很平凡：把绝对 URL 翻成相对路径
 *
 * 但它**是安全相关的**：主进程的代理只接受相对路径（那是防止一次 XSS
 * 借主进程把笔记外发的核心）。所以这里必须断言请求没有跑出配置的 base ——
 * 而**错误必须在这里就报出来**：主进程那道是最后一道防线，
 * 它抛的「跑出了 base」离根因（provider 拼错了 URL）很远。
 */
import { describe, expect, it, vi } from "vitest";
import { desktopSend, desktopSyncBridge, resolveSend, type DesktopSyncBridge } from "./http";

const BASE = "https://notes.example.com";

/** 一个记录调用并回固定响应的假代理。 */
function fakeBridge(response: { status?: number; body?: number[]; headers?: Record<string, string> } = {}) {
  const calls: { method: string; relPath: string; headers: Record<string, string>; body?: number[] }[] = [];
  const configured: string[] = [];
  const tokens: string[] = [];
  const bridge: DesktopSyncBridge = {
    async configure(baseUrl) {
      configured.push(baseUrl);
      return { baseUrl, changed: true };
    },
    async setAuthToken(token) {
      tokens.push(token);
      return true;
    },
    async request(input) {
      calls.push(input);
      return { status: response.status ?? 200, headers: response.headers ?? {}, body: response.body ?? [] };
    },
  };
  return { bridge, calls, configured, tokens };
}

/** 把 `window.opennote` 装上 / 拆掉。 */
function withWindow(opennote: unknown, run: () => void | Promise<void>): void | Promise<void> {
  const scope = globalThis as { window?: unknown };
  const saved = scope.window;
  scope.window = { opennote };
  try {
    return run();
  } finally {
    scope.window = saved;
  }
}

/* ============================================================================
   绝对 URL → 相对路径
   ============================================================================ */

describe("§5.5 · 桌面端把绝对 URL 翻成**相对**路径", () => {
  it("只把路径 + 查询串送过去（origin 不进去）", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, BASE);
    await send({ method: "GET", url: "https://notes.example.com/v1/tree?nb=abc", headers: {} });
    expect(stub.calls[0]!.relPath).toBe("/v1/tree?nb=abc");
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it("请求体以**普通数组**过 IPC（结构化克隆对 `Uint8Array` 的支持各宿主不一）", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, BASE);
    await send({ method: "PUT", url: `${BASE}/v1/file?did=x`, headers: { "X-Opennote-Hash": "h" }, body: new Uint8Array([1, 2, 3]) });
    expect(stub.calls[0]!.body).toEqual([1, 2, 3]);
    expect(stub.calls[0]!.headers).toEqual({ "X-Opennote-Hash": "h" });
  });

  it("字符串请求体也转成字节", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, BASE);
    await send({ method: "POST", url: `${BASE}/v1/x`, headers: {}, body: "ab" });
    expect(stub.calls[0]!.body).toEqual([97, 98]);
  });

  it("响应体从数组还原成字节", async () => {
    const stub = fakeBridge({ status: 200, body: [104, 105] });
    const send = desktopSend(stub.bridge, BASE);
    const response = await send({ method: "GET", url: `${BASE}/v1/file`, headers: {} });
    expect(response.status).toBe(200);
    expect(Array.from(response.bytes)).toEqual([104, 105]);
  });

  it("没有请求体时**不传** `body` 键（`undefined` 过 IPC 会变成 `null`）", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, BASE);
    await send({ method: "GET", url: `${BASE}/v1/tree`, headers: {} });
    expect("body" in stub.calls[0]!).toBe(false);
  });
});

/* ============================================================================
   ★ 冗余的越界检查
   ============================================================================ */

describe("★ 越界的 URL 在这一层就报错（主进程那道是最后一道）", () => {
  it("★ origin 不同 ⇒ 抛（而且错误指向「跑出了配置的服务地址」）", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, BASE);
    await expect(send({ method: "GET", url: "https://evil.com/v1/tree", headers: {} })).rejects.toThrow(/跑出了配置的服务地址/);
    // 而且**没有**发出去。
    expect(stub.calls).toHaveLength(0);
  });

  it("★ 前缀伪装（`notes.example.com.evil.com`）也过不去", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, BASE);
    await expect(send({ method: "GET", url: "https://notes.example.com.evil.com/v1/tree", headers: {} })).rejects.toThrow(/跑出了配置的服务地址/);
  });

  it("base 带子路径时，子路径之外的请求 ⇒ 抛", async () => {
    const stub = fakeBridge();
    const send = desktopSend(stub.bridge, "https://a.com/opennote");
    await expect(send({ method: "GET", url: "https://a.com/v1/tree", headers: {} })).rejects.toThrow(/跑出了配置的子路径/);
    // 子路径之内的正常通过。
    await send({ method: "GET", url: "https://a.com/opennote/v1/tree", headers: {} });
    expect(stub.calls[0]!.relPath).toBe("/opennote/v1/tree");
  });
});

/* ============================================================================
   宿主选择
   ============================================================================ */

describe("§5.3 · 按宿主挑发送函数", () => {
  it("有 `window.opennote.syncProxy` ⇒ 走代理，并**先把 base 与令牌登记过去**", async () => {
    const stub = fakeBridge();
    await withWindow({ isElectron: true, syncProxy: stub.bridge }, async () => {
      const send = await resolveSend({ baseUrl: BASE, authToken: "tok_1" });
      // 登记过了（换主机时主进程会弹原生确认框）。
      expect(stub.configured).toEqual([BASE]);
      expect(stub.tokens).toEqual(["tok_1"]);
      await send({ method: "GET", url: `${BASE}/v1/tree`, headers: {} });
      expect(stub.calls).toHaveLength(1);
    });
  });

  it("没有桌面桥 ⇒ 真的走 `fetch`（网页 / 移动端）", async () => {
    /*
     * ⚠️ 我第一版这条断言写成 `expect(send).toBe(fetchSend)` —— **错的**：
     * `fetchSend` 是**工厂**，每次调用返回一个新函数，身份比较永远不等。
     * 而且那个断言即使「恰好」通过也说明不了什么 —— 它没验证任何**行为**。
     * 改成真的拦住 `globalThis.fetch` 看它有没有被调到。
     */
    const stub = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      await withWindow(undefined, async () => {
        const send = await resolveSend({ baseUrl: BASE, authToken: "tok" });
        await send({ method: "GET", url: `${BASE}/v1/tree`, headers: {} });
      });
      expect(stub).toHaveBeenCalledTimes(1);
      expect(stub.mock.calls[0]![0]).toBe(`${BASE}/v1/tree`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("有 `isElectron` 但**没有** `syncProxy`（旧版 preload）⇒ 退回 `fetch`，不崩", async () => {
    const stub = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", stub);
    try {
      await withWindow({ isElectron: true }, async () => {
        expect(desktopSyncBridge()).toBeNull();
        const send = await resolveSend({ baseUrl: BASE, authToken: "t" });
        await send({ method: "GET", url: `${BASE}/v1/tree`, headers: {} });
      });
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("★ 用户拒绝了地址确认 ⇒ `resolveSend` 抛，同步**不会开始**（这是正确行为）", async () => {
    /*
     * 主进程在换主机时弹原生确认框。用户点「取消」意味着「不要把笔记发到这个地址」——
     * 那时同步**必须不开始**，而不是「先同步着、回头再说」。
     */
    const bridge: DesktopSyncBridge = {
      async configure() {
        throw new Error("用户取消了同步服务地址的更改");
      },
      async setAuthToken() {
        return true;
      },
      async request() {
        return { status: 200, headers: {}, body: [] };
      },
    };
    await withWindow({ isElectron: true, syncProxy: bridge }, async () => {
      await expect(resolveSend({ baseUrl: BASE, authToken: "t" })).rejects.toThrow(/取消/);
    });
    void vi;
  });
});
