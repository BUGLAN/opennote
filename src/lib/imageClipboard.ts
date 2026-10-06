import { readLocalImageBlob, resolveImageSrc } from "../data/assets";
import { parentPath } from "../fs";

/**
 * 把编辑器里的一张图片放进系统剪贴板（右键图片 →「复制图片」的实际动作）。
 *
 * 为什么不能「读出文件字节直接写剪贴板」了事：Chromium 的 `navigator.clipboard.write()`
 * **只认 `image/png`**（键写 `image/jpeg` 会当场抛 NotAllowedError），而笔记目录里的图
 * 什么格式都有 —— 截图是 png、照片是 jpg、图标可能是 svg。所以分两条路：
 *   1. 本地文件读得出字节、而且本来就是 PNG ⇒ **原样**写进剪贴板，一个像素都不重编码；
 *   2. 其余（jpg/webp/gif/svg、以及远程或 data: 图）⇒ 过一遍画布转成 PNG 再写。
 *      gif 会变成静态一帧、svg 会变成位图，这是剪贴板格式所限，不是静默丢数据（文案里不说假话）。
 *
 * 全程**不 fetch**：桌面构建的 CSP 是 `connect-src 'self' file:`，`blob:` 与 `data:` 都不在其中，
 * fetch 会被挡下来；而 `img-src` 恰好放行 `blob:`/`data:`，所以走 `<img>` + 画布这条路。
 *
 * 纯逻辑与 DOM/剪贴板分开（{@link ImageCopyAdapters}）：谁读字节、谁光栅化、谁写剪贴板都能在
 * 单测里逐条替换，管线本身不需要 DOM 就能跑。
 */
export interface ImageCopyRequest {
  /** `![]()` 括号里的原始地址（相对路径 / `http(s):` / `data:`）。 */
  src: string;
  /**
   * 图片所属笔记的**路径**（`归档/foo.md`）。相对地址的基准目录由它换算 ——
   * 不收第二份 `baseDir`：两个 string 参数摆在一起正是「传混了也不报错」那类缺陷的温床。
   */
  notePath: string;
}

export type ImageCopyResult =
  /** `original` = 原字节直写；`rasterized` = 过了画布转 PNG。 */
  | { ok: true; mode: "original" | "rasterized" }
  | { ok: false; message: string };

/** 四个外部动作，单测里逐条替换。 */
export interface ImageCopyAdapters {
  /** 本地文件字节（远程 / `data:` / `blob:` 返回 null）。 */
  readLocal(src: string, baseDir: string): Promise<Blob | null>;
  /** 地址 → 能直接放进 `<img>` 的 URL（本地图拿到的是 blob URL）。 */
  resolveSrc(src: string, baseDir: string): Promise<string | null>;
  /** 任意图片（字节或地址）→ PNG。 */
  rasterize(source: Blob | string): Promise<Blob>;
  /** 把一张 PNG 写进系统剪贴板。 */
  writePng(png: Blob): Promise<void>;
}

const MISSING = "图片没有找到，复制不了";
const UNREADABLE = "这张图片没法复制（浏览器读不出它的内容）";

export async function copyImage(
  request: ImageCopyRequest,
  adapters: ImageCopyAdapters = browserAdapters,
): Promise<ImageCopyResult> {
  const baseDir = parentPath(request.notePath);
  // 读文件失败（文件被删/被移走）不是错误分支，而是「本地这条路走不通」⇒ 交给地址那条路。
  const local = await adapters.readLocal(request.src, baseDir).catch(() => null);

  if (local && local.type === "image/png") {
    return writeClipboard(adapters, local, "original");
  }

  let png: Blob;
  try {
    if (local) {
      png = await adapters.rasterize(local);
    } else {
      const url = await adapters.resolveSrc(request.src, baseDir);
      if (!url) return { ok: false, message: MISSING };
      png = await adapters.rasterize(url);
    }
  } catch (error) {
    console.error("[opennote] 图片转 PNG 失败", error);
    return { ok: false, message: UNREADABLE };
  }
  return writeClipboard(adapters, png, "rasterized");
}

async function writeClipboard(
  adapters: ImageCopyAdapters,
  png: Blob,
  mode: "original" | "rasterized",
): Promise<ImageCopyResult> {
  try {
    await adapters.writePng(png);
    return { ok: true, mode };
  } catch (error) {
    return { ok: false, message: clipboardRefusal(error) };
  }
}

/**
 * 「剪贴板被拒」（没聚焦、没权限、非安全上下文）与其它失败分开报：用户能做的事不一样 ——
 * 前者再点一次或切回窗口就好，后者是这张图本身读不出来。
 */
function clipboardRefusal(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "浏览器拒绝了剪贴板访问";
  return `复制图片失败：${error instanceof Error ? error.message : String(error)}`;
}

/* ------------------------------------------------------------ 浏览器实现 */

const browserAdapters: ImageCopyAdapters = {
  readLocal: readLocalImageBlob,
  resolveSrc: resolveImageSrc,
  rasterize: rasterizeToPng,
  writePng: writePngToClipboard,
};

/**
 * 任意图片 → PNG。远程地址必须带 `crossorigin="anonymous"`，否则画布被污染、`toBlob()` 抛
 * SecurityError；没有 CORS 头的服务器会连图都加载不出来 —— 那也是如实失败，不假装复制成功。
 */
async function rasterizeToPng(source: Blob | string): Promise<Blob> {
  const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
  const url = objectUrl ?? (source as string);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    // 没有内在尺寸的图（没写 width/height 的 svg）画出来是一张空白 —— 宁可如实失败，
    // 也不要往剪贴板里塞一张看不见的空图然后说「已复制」。
    if (!width || !height) throw new Error("图片没有可用的尺寸");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建画布");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("PNG 编码失败");
    return png;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:/i.test(url)) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}

/** Chromium 的 `ClipboardItem` 写图片只认 `image/png`；环境不支持就如实报错，不静默吞掉。 */
async function writePngToClipboard(png: Blob): Promise<void> {
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") {
    throw new Error("当前环境不支持把图片写进剪贴板");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
