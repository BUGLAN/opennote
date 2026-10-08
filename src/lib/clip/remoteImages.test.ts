/**
 * 主进程图片下载器（`electron/fetch-images.cjs`）单测。
 *
 * 为什么值得单独测：这是「图片一起保存」唯一能真正拿到**跨站**字节的地方
 * （桌面 CSP 不放行远程图、扩展 host_permissions 只有 127.0.0.1 十条），
 * 而它同时是唯一一个**由主进程对用户给的 URL 发请求**的入口 —— 上限、
 * 超时、协议白名单、魔数校验每一条都得钉住。
 *
 * 纯函数 + 注入 `fetchImpl`：不联网、不起服务端也能把成功/各类失败逐条验。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { downloadImages, sniffMime, MAX_BYTES, MAX_ITEMS } = require("../../../electron/fetch-images.cjs") as {
  downloadImages: (options: Record<string, unknown>) => Promise<
    Array<{ url: string; ok: boolean; base64?: string; mime?: string | null; error?: string }>
  >;
  sniffMime: (bytes: Uint8Array) => string | null;
  MAX_BYTES: number;
  MAX_ITEMS: number;
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

const response = (bytes: Uint8Array, init: { status?: number; contentType?: string } = {}) => ({
  ok: (init.status ?? 200) < 400,
  status: init.status ?? 200,
  headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(bytes.length) : init.contentType ?? null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

describe("主进程图片下载器", () => {
  it("成功：字节 + 魔数判定的 mime（不轻信 Content-Type）", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/a.png"],
      fetchImpl: async () => response(PNG, { contentType: "text/html" }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ url: "https://cdn.test/a.png", ok: true, mime: "image/png" });
    expect(Buffer.from(out[0].base64!, "base64").equals(Buffer.from(PNG))).toBe(true);
  });

  it("非 http(s) 一律不下载（协议白名单）", async () => {
    let called = 0;
    const out = await downloadImages({
      urls: ["file:///etc/passwd", "data:image/png;base64,AAAA", ""],
      fetchImpl: async () => {
        called += 1;
        return response(PNG);
      },
    });
    expect(called).toBe(0);
    expect(out.map((item) => item.ok)).toEqual([false, false, false]);
    expect(out[0].error).toContain("http(s)");
  });

  it("服务器报错 / 不是图片 / 超过上限 —— 逐条如实说，且都不返回字节", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/500.png", "https://cdn.test/text.txt", "https://cdn.test/big.png"],
      maxBytes: 1024,
      fetchImpl: async (url: string) => {
        if (url.endsWith("500.png")) return response(PNG, { status: 500 });
        if (url.endsWith("text.txt")) return response(new TextEncoder().encode("这不是图片"));
        return response(new Uint8Array(2048));
      },
    });
    expect(out.every((item) => item.ok === false)).toBe(true);
    expect(out[0].error).toContain("服务器返回 500");
    expect(out[1].error).toContain("不是支持的图片格式");
    expect(out[2].error).toContain("超过");
  });

  it("超时：abort 之后报「下载超时」，不挂住整条入库", async () => {
    const out = await downloadImages({
      urls: ["https://cdn.test/slow.png"],
      timeoutMs: 20,
      fetchImpl: (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
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
      fetchImpl: async () => {
        called += 1;
        return response(PNG);
      },
    });
    expect(called).toBe(MAX_ITEMS);
    expect(out).toHaveLength(MAX_ITEMS + 2);
    expect(out[MAX_ITEMS].error).toContain("件数上限");
  });

  it("没有可用的下载能力（fetch 缺失）→ 如实失败，不抛异常", async () => {
    const out = await downloadImages({ urls: ["https://cdn.test/a.png"], fetchImpl: null });
    expect(out[0]).toMatchObject({ ok: false });
  });

  it("请求头：带浏览器 UA，referer 只在是合法 http(s) 时下发（CDN 防盗链看的就是它）", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers ?? {});
      return response(PNG);
    };
    await downloadImages({ urls: ["https://cdn.test/a.png"], referer: "https://page.test/post", fetchImpl });
    expect(seen[0]["user-agent"]).toContain("Mozilla/5.0");
    expect(seen[0].referer).toBe("https://page.test/post");
    await downloadImages({ urls: ["https://cdn.test/a.png"], referer: "不是地址", fetchImpl });
    expect(seen[1].referer).toBeUndefined();
  });

  it("嗅探口径：只认图片魔数，认不出的返回 null", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(Buffer.from("not an image at all"))).toBe(null);
    expect(MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
