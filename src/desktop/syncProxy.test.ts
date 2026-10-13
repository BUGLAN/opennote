/**
 * 桌面端同步代理的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.5）。
 *
 * ## 这个文件几乎全是**反证**
 *
 * §5.5 唯一强调的事是：「**只允许『配置好的 base URL + 相对路径』**——
 * 不能做成通用 `fetch(url)`，否则**一次 XSS 就能借它把笔记外发**」。
 *
 * 这句话描述的失败**不会让任何正常功能坏掉**：代理照样工作，测试照样绿。
 * 区别只在攻击者手里 —— 一个「帮我请求这个地址」的 IPC 等于把主进程变成
 * **带你的凭证的出网代理**：攻击者不必偷 `authToken`，只要让主进程把笔记 POST 到自己的服务器。
 *
 * 所以这里每一条都在试**怎么把它变成通用 fetch**，并断言失败。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
const { SyncProxyError, assertSafeRelPath, createSyncProxy, normalizeBaseUrl, sanitizeHeaders } = requireCjs("../../electron/sync.cjs") as {
  SyncProxyError: new (message: string) => Error;
  assertSafeRelPath: (input: unknown) => string;
  normalizeBaseUrl: (input: string) => { origin: string; path: string; base: string };
  sanitizeHeaders: (raw: unknown) => Record<string, string>;
  createSyncProxy: (options: Record<string, unknown>) => {
    request: (input: Record<string, unknown>) => Promise<{ status: number; body: Uint8Array; headers: Record<string, string> }>;
    baseUrl: string;
    origin: string;
  };
};

const BASE = "https://notes.example.com";
/** 一个记录调用并回固定响应的假 fetch。 */
function fakeFetch(response: { status?: number; body?: string } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return {
      status: response.status ?? 200,
      headers: new Headers({ "content-type": "application/json" }),
      arrayBuffer: async () => new TextEncoder().encode(response.body ?? "{}").buffer,
    };
  };
  return { calls, fetchImpl };
}

/* ============================================================================
   ★ 不许变成通用 fetch
   ============================================================================ */

describe("★ §5.5 · 不许变成通用 `fetch(url)`", () => {
  it("正常用法：base URL + 相对路径", async () => {
    const stub = fakeFetch();
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: stub.fetchImpl });
    await proxy.request({ method: "GET", relPath: "/v1/tree?nb=x" });
    expect(stub.calls[0]!.url).toBe("https://notes.example.com/v1/tree?nb=x");
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it("★ `relPath` 里塞绝对 URL ⇒ 拒（这是「通用 fetch」最直接的写法）", async () => {
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: fakeFetch().fetchImpl });
    for (const relPath of ["https://evil.com/steal", "http://evil.com/x", "file:///etc/passwd", "data:text/plain,x"]) {
      await expect(proxy.request({ method: "GET", relPath }), relPath).rejects.toThrow(SyncProxyError);
    }
  });

  it("★ 协议相对 `//evil.com/x` ⇒ 拒（`new URL` 会把它当成换主机）", async () => {
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: fakeFetch().fetchImpl });
    await expect(proxy.request({ method: "GET", relPath: "//evil.com/x" })).rejects.toThrow(/不能以 \/\/ 开头/);
  });

  it("★ `..` 逃逸 ⇒ 拒（含编码过的 `%2e%2e`）", async () => {
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: fakeFetch().fetchImpl });
    for (const relPath of ["/../../evil", "/v1/../../evil", "/%2e%2e/evil", "/%2E%2E/evil", "/.%2e/evil", "/%2e./evil"]) {
      await expect(proxy.request({ method: "GET", relPath }), relPath).rejects.toThrow(SyncProxyError);
    }
  });

  it("★ 反斜杠 ⇒ 拒（Windows 上 `\\` 会被某些解析器当成路径分隔）", async () => {
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: fakeFetch().fetchImpl });
    await expect(proxy.request({ method: "GET", relPath: "/v1\\..\\evil" })).rejects.toThrow(/反斜杠/);
  });

  it("★ 方法白名单：`TRACE` / `HEAD` / `OPTIONS` 都不行", async () => {
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: fakeFetch().fetchImpl });
    for (const method of ["TRACE", "HEAD", "OPTIONS", "PATCH", "CONNECT"]) {
      await expect(proxy.request({ method, relPath: "/v1/x" }), method).rejects.toThrow(/不允许的方法/);
    }
  });

  it("★ 渲染层不许自己带 `Authorization`（凭证由主进程贴）", async () => {
    /*
     * 否则渲染层就能借这个代理用**别的**凭证发请求 ——
     * 「凭证在主进程」这条纪律就白设了。
     */
    const proxy = createSyncProxy({ baseUrl: BASE, fetchImpl: fakeFetch().fetchImpl });
    for (const header of ["Authorization", "authorization", "Cookie", "Host", "Origin", "Referer"]) {
      await expect(proxy.request({ method: "GET", relPath: "/v1/x", headers: { [header]: "x" } }), header).rejects.toThrow(/不许自己设置/);
    }
  });

  it("★ 主进程自己把 `authToken` 贴上（渲染层不传它也能鉴权）", async () => {
    const stub = fakeFetch();
    const proxy = createSyncProxy({ baseUrl: BASE, authToken: () => "tok_123", fetchImpl: stub.fetchImpl });
    await proxy.request({ method: "GET", relPath: "/v1/tree" });
    expect(stub.calls[0]!.headers.Authorization).toBe("Bearer tok_123");
  });

  it("★ `startsWith` 的经典漏洞被 origin 比对挡住（`a.com.evil.com`）", async () => {
    /*
     * §5.5 说「断言 `startsWith(syncBaseUrl)`」。裸 `startsWith` 有一个经典漏洞：
     * base 是 `https://a.com` 时，`https://a.com.evil.com/` **也** `startsWith("https://a.com")`。
     * 这里比的是 `URL` 解析后的 **origin**，所以过不去。
     */
    const proxy = createSyncProxy({ baseUrl: "https://a.com", fetchImpl: fakeFetch().fetchImpl });
    // `@` 是把用户信息塞进 authority 的经典手法（`https://a.com@evil.com`）。
    await expect(proxy.request({ method: "GET", relPath: "https://a.com@evil.com/x" })).rejects.toThrow(SyncProxyError);
    // 正常请求仍然通。
    await expect(proxy.request({ method: "GET", relPath: "/v1/tree" })).resolves.toBeTruthy();
  });
});

/* ============================================================================
   单点函数
   ============================================================================ */

describe("`assertSafeRelPath` / `normalizeBaseUrl` / `sanitizeHeaders`", () => {
  it("合法相对路径原样返回", () => {
    for (const relPath of ["/v1/tree", "/v1/file?nb=a&did=b", "v1/tree", "/"]) {
      expect(assertSafeRelPath(relPath)).toBe(relPath);
    }
  });

  it("非字符串 / 空 / 空字节 ⇒ 拒", () => {
    for (const bad of [null, undefined, 42, {}, "", "/a\0b"]) {
      expect(() => assertSafeRelPath(bad), String(bad)).toThrow(SyncProxyError);
    }
  });

  it("base URL 必须是 http/https，且不带查询串或片段", () => {
    expect(normalizeBaseUrl("https://a.com").origin).toBe("https://a.com");
    expect(normalizeBaseUrl("http://localhost:8787").base).toBe("http://localhost:8787");
    // 末尾斜杠统一去掉，拼接才可预测。
    expect(normalizeBaseUrl("https://a.com/").base).toBe("https://a.com");
    expect(normalizeBaseUrl("https://a.com/sub/").base).toBe("https://a.com/sub");
    for (const bad of ["ftp://a.com", "file:///x", "a.com", "", "https://a.com?x=1", "https://a.com#f"]) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(SyncProxyError);
    }
  });

  it("`sanitizeHeaders` 只放行字符串值，并拒掉凭证类头", () => {
    expect(sanitizeHeaders({ "X-Opennote-Hash": "abc", "Content-Type": "application/json" })).toEqual({
      "X-Opennote-Hash": "abc",
      "Content-Type": "application/json",
    });
    expect(() => sanitizeHeaders({ authorization: "Bearer x" })).toThrow(/不许自己设置/);
    // 非字符串值被丢掉（不抛）——它们只会是调用方的笔误。
    expect(sanitizeHeaders({ "X-N": 42 })).toEqual({});
    expect(sanitizeHeaders(null)).toEqual({});
  });

  it("base URL 带子路径时，请求必须落在那个子路径之下", async () => {
    const stub = fakeFetch();
    const proxy = createSyncProxy({ baseUrl: "https://a.com/opennote", fetchImpl: stub.fetchImpl });
    await proxy.request({ method: "GET", relPath: "/v1/tree" });
    expect(stub.calls[0]!.url).toBe("https://a.com/opennote/v1/tree");
  });
});
