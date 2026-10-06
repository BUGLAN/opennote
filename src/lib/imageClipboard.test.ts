import { describe, expect, it, vi } from "vitest";
import { copyImage, type ImageCopyAdapters } from "./imageClipboard";

/** 一张假的「图片字节」：管线只看 `type` 是不是 `image/png`，不需要真图。 */
function blobOf(type: string, bytes = [1, 2, 3]): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

interface Fake extends ImageCopyAdapters {
  written: Blob[];
  readLocalCalls: { src: string; baseDir: string }[];
  rendered: (Blob | string)[];
}

function fakeAdapters(overrides: Partial<ImageCopyAdapters> = {}): Fake {
  const written: Blob[] = [];
  const readLocalCalls: { src: string; baseDir: string }[] = [];
  const rendered: (Blob | string)[] = [];
  const base: ImageCopyAdapters = {
    readLocal: async (src, baseDir) => {
      readLocalCalls.push({ src, baseDir });
      return null;
    },
    resolveSrc: async () => null,
    rasterize: async (source) => {
      rendered.push(source);
      return blobOf("image/png", [9, 9, 9]);
    },
    writePng: async (png) => {
      written.push(png);
    },
  };
  return Object.assign(base, overrides, { written, readLocalCalls, rendered });
}

const REQUEST = { src: "./备注.assets/图.png", notePath: "归档/备注.md" };

describe("copyImage：本地 PNG 原样进剪贴板", () => {
  it("不重编码：写进去的就是读出来的那个 Blob，也不经过画布", async () => {
    const png = blobOf("image/png", [0x89, 0x50, 0x4e, 0x47]);
    const rasterize = vi.fn(async () => blobOf("image/png"));
    const adapters = fakeAdapters({ readLocal: async () => png, rasterize });

    const result = await copyImage(REQUEST, adapters);

    expect(result).toEqual({ ok: true, mode: "original" });
    expect(adapters.written).toEqual([png]);
    expect(adapters.written[0]).toBe(png);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("相对地址的基准目录由**笔记路径**换算（不另收一份 baseDir）", async () => {
    const adapters = fakeAdapters();
    await copyImage({ src: "./图.png", notePath: "归档/子目录/备注 2.md" }, adapters);
    expect(adapters.readLocalCalls).toEqual([{ src: "./图.png", baseDir: "归档/子目录" }]);
  });
});

describe("copyImage：非 PNG 一律过画布转 PNG", () => {
  it("本地 JPEG：拿本地字节光栅化，写进剪贴板的是 PNG", async () => {
    const jpeg = blobOf("image/jpeg");
    const rasterized = blobOf("image/png", [9, 9, 9]);
    const rasterize = vi.fn(async () => rasterized);
    const adapters = fakeAdapters({ readLocal: async () => jpeg, rasterize });

    const result = await copyImage(REQUEST, adapters);

    expect(result).toEqual({ ok: true, mode: "rasterized" });
    expect(rasterize).toHaveBeenCalledWith(jpeg);
    expect(adapters.written).toEqual([rasterized]);
    expect(adapters.written[0]).toBe(rasterized);
  });

  it("本地读不出字节（远程图 / data: 图）：退到地址那条路，仍然复制成功", async () => {
    const adapters = fakeAdapters({
      readLocal: async () => null,
      resolveSrc: async (src, baseDir) => {
        expect(src).toBe(REQUEST.src);
        expect(baseDir).toBe("归档");
        return "blob:opennote/abc";
      },
    });

    const result = await copyImage(REQUEST, adapters);

    expect(result).toEqual({ ok: true, mode: "rasterized" });
    expect(adapters.rendered).toEqual(["blob:opennote/abc"]);
    expect(adapters.written).toHaveLength(1);
  });

  it("读文件抛异常（图被删/后端出错）不是崩溃，而是改走地址那条路", async () => {
    const adapters = fakeAdapters({
      readLocal: async () => {
        throw new Error("ENOENT");
      },
      resolveSrc: async () => "blob:opennote/cached",
    });

    await expect(copyImage(REQUEST, adapters)).resolves.toEqual({ ok: true, mode: "rasterized" });
    expect(adapters.rendered).toEqual(["blob:opennote/cached"]);
  });
});

describe("copyImage：失败要说得出是哪一种失败", () => {
  it("图片根本找不到：不写剪贴板，如实说找不到", async () => {
    const adapters = fakeAdapters();
    const result = await copyImage(REQUEST, adapters);
    expect(result).toEqual({ ok: false, message: "图片没有找到，复制不了" });
    expect(adapters.written).toEqual([]);
  });

  it("剪贴板被拒（没聚焦 / 没权限）：与「图读不出来」分开报，用户能做的事不一样", async () => {
    const adapters = fakeAdapters({
      readLocal: async () => blobOf("image/png"),
      writePng: async () => {
        throw new DOMException("Document is not focused", "NotAllowedError");
      },
    });

    const result = await copyImage(REQUEST, adapters);

    expect(result).toEqual({ ok: false, message: "浏览器拒绝了剪贴板访问" });
  });

  it("剪贴板其它错误：带上真实原因，不吞成一句「失败」", async () => {
    const adapters = fakeAdapters({
      readLocal: async () => blobOf("image/png"),
      writePng: async () => {
        throw new Error("剪贴板忙");
      },
    });

    const result = await copyImage(REQUEST, adapters);

    expect(result).toEqual({ ok: false, message: "复制图片失败：剪贴板忙" });
  });

  it("图读不出来（画布说不清 / 远程图没有 CORS）：不假装复制成功，也不写剪贴板", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adapters = fakeAdapters({
        readLocal: async () => blobOf("image/webp"),
        rasterize: async () => {
          throw new Error("图片加载失败");
        },
      });

      const result = await copyImage(REQUEST, adapters);

      expect(result).toEqual({ ok: false, message: "这张图片没法复制（浏览器读不出它的内容）" });
      expect(adapters.written).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
