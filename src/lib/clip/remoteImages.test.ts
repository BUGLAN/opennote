/**
 * 主进程图片下载器（`electron/fetch-images.cjs`）单测。
 *
 * 为什么值得单独测：这是「图片一起保存」唯一能真正拿到**跨站**字节的地方
 * （桌面 CSP 不放行远程图、扩展 host_permissions 只有 127.0.0.1 十条），
 * 而它同时是唯一一个**由主进程对用户给的 URL 发请求**的入口 —— 地址、重定向、
 * 上限、超时、协议白名单、魔数校验每一条都得钉住。
 *
 * `lookupImpl` / `requestImpl` 可注入：不联网、不起服务端也能把成功与各类失败逐条验。
 */
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { downloadImages, requestOnce, sniffMime, isPublicIp, MAX_BYTES, MAX_ITEMS } = require(
  "../../../electron/fetch-images.cjs",
) as {
  downloadImages: (options: Record<string, unknown>) => Promise<
    Array<{ url: string; ok: boolean; base64?: string; mime?: string | null; error?: string }>
  >;
  requestOnce: (
    url: URL,
    address: { address: string; family: number },
    headers: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<FakeResponse>;
  sniffMime: (bytes: Uint8Array) => string | null;
  isPublicIp: (address: string) => boolean;
  MAX_BYTES: number;
  MAX_ITEMS: number;
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const PUBLIC_IP = "93.184.216.34";

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
}

const response = (
  bytes: Uint8Array,
  init: {
    status?: number;
    contentType?: string;
    contentLength?: number | null;
    headers?: Record<string, string>;
  } = {},
): FakeResponse => {
  const headers: Record<string, string> = {
    ...(init.contentLength === null ? {} : { "content-length": String(init.contentLength ?? bytes.length) }),
    ...(init.contentType ? { "content-type": init.contentType } : {}),
    ...init.headers,
  };
  return {
    status: init.status ?? 200,
    headers,
    stream: Readable.from([Buffer.from(bytes)]),
  };
};

const redirect = (location: string, status = 302): FakeResponse => ({
  status,
  headers: { location },
  stream: Readable.from([]),
});

const publicLookup = async () => [{ address: PUBLIC_IP, family: 4 }];

describe("主进程图片下载器", () => {
  it("成功：公网地址 + 字节 + 魔数判定的 mime（不轻信 Content-Type）", async () => {
    const seen: Array<{ address: string; headers: Record<string, string> }> = [];
    const out = await downloadImages({
      urls: ["https://cdn.test/a.png"],
      lookupImpl: publicLookup,
      requestImpl: async (
        _url: URL,
        address: { address: string; family: number },
        headers: Record<string, string>,
      ) => {
        seen.push({ address: address.address, headers });
        return response(PNG, { contentType: "text/html" });
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ url: "https://cdn.test/a.png", ok: true, mime: "image/png" });
    expect(Buffer.from(out[0].base64!, "base64").equals(Buffer.from(PNG))).toBe(true);
    expect(seen[0].address).toBe(PUBLIC_IP);
  });

  it("底层 http.request 使用钉死的 lookup 连接（不会再次解析到别处）", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from(PNG));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await requestOnce(
        new URL(`http://pinned.test:${port}/photo.png`),
        { address: "127.0.0.1", family: 4 },
        {},
      );
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
      expect(result.status).toBe(200);
      expect(Buffer.concat(chunks).equals(Buffer.from(PNG))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("非 http(s) 一律不下载（协议白名单）", async () => {
    let called = 0;
    const out = await downloadImages({
      urls: ["file:///etc/passwd", "data:image/png;base64,AAAA", ""],
      lookupImpl: publicLookup,
      requestImpl: async () => {
        called += 1;
        return response(PNG);
      },
    });
    expect(called).toBe(0);
    expect(out.map((item) => item.ok)).toEqual([false, false, false]);
    expect(out[0].error).toContain("http(s)");
  });

  it.each([
    "http://127.0.0.1/x.png",
    "http://localhost/x.png",
    "http://0.0.0.0/x.png",
    "http://10.0.0.1/x.png",
    "http://100.64.0.1/x.png",
    "http://172.16.0.1/x.png",
    "http://172.31.255.255/x.png",
    "http://192.168.0.1/x.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://198.51.100.1/x.png",
    "http://203.0.113.1/x.png",
    "http://[::1]/x.png",
    "http://[::ffff:127.0.0.1]/x.png",
    "http://[fc00::1]/x.png",
    "http://[fd12:3456::1]/x.png",
    "http://[fe80::1]/x.png",
  ])("私网/回环/链路本地/保留地址直连被拒绝：%s", async (url) => {
    let requested = 0;
    const out = await downloadImages({
      urls: [url],
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      requestImpl: async () => {
        requested += 1;
        return response(PNG);
      },
    });
    expect(requested).toBe(0);
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].error).toContain("公网");
  });

  it("DNS 返回多条记录时，只要有一条不是公网就整条拒绝（正反顺序都验）", async () => {
    for (const records of [
      [
        { address: PUBLIC_IP, family: 4 },
        { address: "10.0.0.2", family: 4 },
      ],
      [
        { address: "10.0.0.2", family: 4 },
        { address: PUBLIC_IP, family: 4 },
      ],
    ]) {
      let requested = 0;
      const out = await downloadImages({
        urls: ["https://cdn.test/a.png"],
        lookupImpl: async () => records,
        requestImpl: async () => {
          requested += 1;
          return response(PNG);
        },
      });
      expect(requested).toBe(0);
      expect(out[0]).toMatchObject({ ok: false });
      expect(out[0].error).toContain("公网");
    }
  });

  it("公网 URL 重定向到私网：第二跳在发请求前被拒绝", async () => {
    const requested: string[] = [];
    const out = await downloadImages({
      urls: ["https://cdn.test/a.png"],
      lookupImpl: publicLookup,
      requestImpl: async (url: URL) => {
        requested.push(url.toString());
        return redirect("http://127.0.0.1/secret.png");
      },
    });
    expect(requested).toEqual(["https://cdn.test/a.png"]);
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].error).toContain("公网");
    expect(out[0].base64).toBeUndefined();
  });

  it("最多跟随 5 次重定向：第 6 条明确失败，不返回最后一跳的响应体", async () => {
    let requested = 0;
    const out = await downloadImages({
      urls: ["https://cdn.test/0.png"],
      lookupImpl: publicLookup,
      requestImpl: async () => {
        requested += 1;
        return redirect(`https://cdn.test/${requested}.png`);
      },
    });
    expect(requested).toBe(6);
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].error).toContain("5 次");
    expect(out[0].base64).toBeUndefined();
  });

  it("恰好跟随 5 次后拿到公网图片仍能成功", async () => {
    let requested = 0;
    const out = await downloadImages({
      urls: ["https://cdn.test/0.png"],
      lookupImpl: publicLookup,
      requestImpl: async () => {
        requested += 1;
        return requested <= 5 ? redirect(`https://cdn.test/${requested}.png`) : response(PNG);
      },
    });
    expect(requested).toBe(6);
    expect(out[0]).toMatchObject({ ok: true, mime: "image/png" });
  });

  it("协议与端口白名单：http 只走 80，https 只走 443", async () => {
    let requested = 0;
    const out = await downloadImages({
      urls: ["http://cdn.test:8080/a.png", "https://cdn.test:8443/a.png"],
      lookupImpl: publicLookup,
      requestImpl: async () => {
        requested += 1;
        return response(PNG);
      },
    });
    expect(requested).toBe(0);
    expect(out.every((item) => item.ok === false)).toBe(true);
    expect(out.every((item) => item.error?.includes("端口"))).toBe(true);
  });

  it("不允许 https 重定向降级到 http", async () => {
    let requested = 0;
    const out = await downloadImages({
      urls: ["https://cdn.test/a.png"],
      lookupImpl: publicLookup,
      requestImpl: async () => {
        requested += 1;
        return redirect("http://cdn.test/a.png");
      },
    });
    expect(requested).toBe(1);
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].error).toContain("https");
  });

  it("服务器报错 / 不是图片 / 超过上限 —— 逐条如实说，且都不返回字节", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/500.png", "https://cdn.test/text.txt", "https://cdn.test/big.png"],
      maxBytes: 1024,
      lookupImpl: publicLookup,
      requestImpl: async (url: URL) => {
        if (url.pathname.endsWith("500.png")) return response(PNG, { status: 500 });
        if (url.pathname.endsWith("text.txt")) return response(new TextEncoder().encode("这不是图片"));
        return response(new Uint8Array(2048), { contentLength: null });
      },
    });
    expect(out.every((item) => item.ok === false)).toBe(true);
    expect(out[0].error).toContain("服务器返回 500");
    expect(out[1].error).toContain("不是支持的图片格式");
    expect(out[2].error).toContain("超过");
    expect(out.every((item) => item.base64 === undefined)).toBe(true);
  });

  it("Content-Length 超过上限时在读取正文前就拒绝", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/big.png"],
      maxBytes: 1024,
      lookupImpl: publicLookup,
      requestImpl: async () => response(PNG, { contentLength: 2048 }),
    });
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].error).toContain("超过");
    expect(out[0].base64).toBeUndefined();
  });

  it("超时：abort 之后报「下载超时」，不挂住整条入库", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/slow.png"],
      timeoutMs: 20,
      lookupImpl: publicLookup,
      requestImpl: (_url: URL, _address: unknown, _headers: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    expect(out[0]).toMatchObject({ ok: false, error: "下载超时" });
  });

  it("件数上限：超出的那几条直接判失败，不再发请求", async () => {
    let called = 0;
    const urls = Array.from({ length: MAX_ITEMS + 2 }, (_, index) => `https://cdn.test/${index}.png`);
    const out = await downloadImages({
      urls,
      lookupImpl: publicLookup,
      requestImpl: async () => {
        called += 1;
        return response(PNG);
      },
    });
    expect(called).toBe(MAX_ITEMS);
    expect(out).toHaveLength(MAX_ITEMS + 2);
    expect(out[MAX_ITEMS].error).toContain("件数上限");
  });

  it("没有可用的下载能力（requestImpl 缺失）→ 如实失败，不抛异常", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/a.png"],
      lookupImpl: publicLookup,
      requestImpl: null,
    });
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].error).toContain("下载能力");
  });

  it("请求头：带浏览器 UA，referer 只在是合法 http(s) 时下发（CDN 防盗链看的就是它）", async () => {
    const seen: Array<Record<string, string>> = [];
    const requestImpl = async (_url: URL, _address: unknown, headers: Record<string, string>) => {
      seen.push(headers ?? {});
      return response(PNG);
    };
    await downloadImages({ urls: ["https://cdn.test/a.png"], referer: "https://page.test/post", lookupImpl: publicLookup, requestImpl });
    expect(seen[0]["user-agent"]).toContain("Mozilla/5.0");
    expect(seen[0].referer).toBe("https://page.test/post");
    await downloadImages({ urls: ["https://cdn.test/a.png"], referer: "不是地址", lookupImpl: publicLookup, requestImpl });
    expect(seen[1].referer).toBeUndefined();
  });

  it("公网地址分类：IPv4/IPv6 的范围判定", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("169.254.169.254")).toBe(false);
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("2001:db8::1")).toBe(false);
  });

  it("嗅探口径：只认图片魔数，认不出的返回 null", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(Buffer.from("not an image at all"))).toBe(null);
    expect(MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
