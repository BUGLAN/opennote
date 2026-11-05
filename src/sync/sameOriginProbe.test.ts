import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../shared/contract";

/** 网页版由同步服务器同源托管时（issue #1），登录表单预填「服务器地址」用的探测。 */
async function load() {
  vi.resetModules();
  return import("./account");
}

function healthBody() {
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    couchVersion: null,
    registration: "invite",
    auth: { password: true, github: false },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeSameOriginServer（issue #1）", () => {
  it("同源就是同步服务时返回这个源与健康信息", async () => {
    vi.stubGlobal("location", { protocol: "https:", origin: "https://notes.example.com" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(healthBody()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { probeSameOriginServer } = await load();

    const found = await probeSameOriginServer();
    expect(found?.server).toBe("https://notes.example.com");
    expect(found?.health.ok).toBe(true);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("https://notes.example.com/v1/health");
  });

  it("同源不是同步服务（GitHub Pages 的 404 页）时安静地返回 null", async () => {
    vi.stubGlobal("location", { protocol: "https:", origin: "https://buglan.github.io" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })));
    const { probeSameOriginServer } = await load();

    await expect(probeSameOriginServer()).resolves.toBeNull();
  });

  it("网络失败 / 超时都返回 null，不抛错", async () => {
    vi.stubGlobal("location", { protocol: "https:", origin: "https://notes.example.com" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { probeSameOriginServer } = await load();

    await expect(probeSameOriginServer(20)).resolves.toBeNull();
  });

  it("file:// 之类的非 http 源直接返回 null，不发请求", async () => {
    vi.stubGlobal("location", { protocol: "file:", origin: "null" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { probeSameOriginServer } = await load();

    await expect(probeSameOriginServer()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
