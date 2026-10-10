import { beforeEach, describe, expect, it } from "vitest";
import {
  clearImagePool,
  imageSizeFor,
  markImageLoaded,
  normalizeImageKey,
  parkImageElement,
  pooledImageElement,
  poolStats,
  rememberImageSize,
  rememberSourceSize,
  sourceSizeFor,
} from "./imagePool";

/** node 环境没有 DOM：池子只读 `isConnected`，一个最小桩就够了。 */
function fakeImg(connected = false): HTMLImageElement {
  return { isConnected: connected } as unknown as HTMLImageElement;
}

describe("imagePool：已解码 <img> 的借还池（切笔记不重解码、不闪图）", () => {
  beforeEach(() => {
    // 池子是模块级单例：每条用例从空池开始。
    clearImagePool();
  });

  it("没触发过 load 的元素不许入池（坏图不能被复用）", () => {
    const img = fakeImg();
    parkImageElement("a.png", img);
    expect(poolStats().idle).toBe(0);
    expect(pooledImageElement("a.png")).toBeNull();
  });

  it("借出的是同一个元素；借空后返回 null", () => {
    const img = fakeImg();
    markImageLoaded(img);
    parkImageElement("a.png", img);
    expect(poolStats().idle).toBe(1);
    expect(pooledImageElement("a.png")).toBe(img);
    expect(pooledImageElement("a.png")).toBeNull();
  });

  it("同一个元素重复还池只算一份", () => {
    const img = fakeImg();
    markImageLoaded(img);
    parkImageElement("a.png", img);
    parkImageElement("a.png", img);
    expect(poolStats().idle).toBe(1);
  });

  it("还挂在文档上的元素不接单（它还是别的 widget 的命根子）", () => {
    const img = fakeImg(true);
    markImageLoaded(img);
    parkImageElement("a.png", img);
    expect(poolStats().idle).toBe(0);
  });

  it("借出时跳过仍连在文档上的元素", () => {
    const img = fakeImg();
    markImageLoaded(img);
    parkImageElement("a.png", img);
    (img as unknown as { isConnected: boolean }).isConnected = true;
    expect(pooledImageElement("a.png")).toBeNull();
    // 旧 widget 销毁后重新还池，就又能借了
    (img as unknown as { isConnected: boolean }).isConnected = false;
    parkImageElement("a.png", img);
    expect(pooledImageElement("a.png")).toBe(img);
  });

  it("同一张图最多留 4 个空闲元素（同图在一篇里出现多次也够用）", () => {
    for (let i = 0; i < 6; i += 1) {
      const img = fakeImg();
      markImageLoaded(img);
      parkImageElement("a.png", img);
    }
    expect(poolStats().idle).toBe(4);
    for (let i = 0; i < 4; i += 1) {
      expect(pooledImageElement("a.png")).not.toBeNull();
    }
    expect(pooledImageElement("a.png")).toBeNull();
  });

  it("全局上限 64：超出按最早入池的桶淘汰，失效 URL 的旧桶自然排干", () => {
    for (let i = 0; i < 40; i += 1) {
      const img = fakeImg();
      markImageLoaded(img);
      parkImageElement(`batch-${i}.png`, img);
    }
    expect(poolStats().idle).toBeLessThanOrEqual(64);
    // 最早的「排水」URL 已被挤掉
    expect(pooledImageElement("a.png")).toBeNull();
    const img = fakeImg();
    markImageLoaded(img);
    parkImageElement("batch-39.png", img);
    expect(pooledImageElement("batch-39.png")).toBe(img);
  });

  it("尺寸表：0 尺寸不记，先量到的为准", () => {
    rememberImageSize("a.png", 0, 600);
    rememberImageSize("a.png", 800, 0);
    expect(imageSizeFor("a.png")).toBeNull();
    rememberImageSize("a.png", 800, 600);
    expect(imageSizeFor("a.png")).toEqual({ width: 800, height: 600 });
    rememberImageSize("a.png", 1, 1); // 已有记录不覆盖
    expect(imageSizeFor("a.png")).toEqual({ width: 800, height: 600 });
    expect(imageSizeFor("missing.png")).toBeNull();
  });
});

/**
 * 「尺寸的第二个产地」：按 markdown 引用串记。它存在的唯一理由是**首次插入**——
 * URL 尺寸要等加载完才有，而粘贴那一刻 `File` 就在手里（见 `media.ts` 的 `readImageSize`）。
 * 这一组用例守的是「widget 建出来的第一帧就能拿到尺寸」这条性质。
 */
describe("imagePool：按引用串记的尺寸（首次插入就能占位）", () => {
  beforeEach(() => {
    clearImagePool();
  });

  it("记进去就能同步查到 —— 不必等任何异步", () => {
    rememberSourceSize("./note.assets/a.png", 1200, 800);
    expect(sourceSizeFor("./note.assets/a.png")).toEqual({ width: 1200, height: 800 });
  });

  it("0 或负数尺寸不记（量失败不该塞进一个 0 高的占位盒）", () => {
    rememberSourceSize("a.png", 0, 600);
    rememberSourceSize("a.png", 800, 0);
    rememberSourceSize("a.png", -1, 600);
    expect(sourceSizeFor("a.png")).toBeNull();
    expect(poolStats().sourceSizes).toBe(0);
  });

  it("先量到的为准：同一个文件重复粘贴不覆盖", () => {
    rememberSourceSize("a.png", 800, 600);
    rememberSourceSize("a.png", 1, 1);
    expect(sourceSizeFor("a.png")).toEqual({ width: 800, height: 600 });
  });

  it("角括号与裸形式是同一把钥匙（markdownRef 对含空格的路径会加 <>）", () => {
    rememberSourceSize("<./备注 2.assets/a.png>", 640, 480);
    expect(sourceSizeFor("./备注 2.assets/a.png")).toEqual({ width: 640, height: 480 });

    rememberSourceSize("b.png", 100, 200);
    expect(sourceSizeFor("<b.png>")).toEqual({ width: 100, height: 200 });
  });

  it("normalizeImageKey 只剥最外层的一对角括号，并去掉首尾空白", () => {
    expect(normalizeImageKey("  <a.png>  ")).toBe("a.png");
    expect(normalizeImageKey("a.png")).toBe("a.png");
    // 只剥一层：里面那对留着（它属于路径本身）
    expect(normalizeImageKey("<<a.png>>")).toBe("<a.png>");
    // 只有一边有括号就不算角括号形式
    expect(normalizeImageKey("<a.png")).toBe("<a.png");
  });

  it("两张表互不干扰：URL 的尺寸查不到引用串上，反之亦然", () => {
    rememberImageSize("blob:xyz", 800, 600);
    rememberSourceSize("./a.png", 320, 240);
    expect(sourceSizeFor("blob:xyz")).toBeNull();
    expect(imageSizeFor("./a.png")).toBeNull();
    expect(poolStats().sourceSizes).toBe(1);
    expect(poolStats().sizes).toBe(1);
  });

  it("clearImagePool 把两张表一起清掉（单例在用例之间不留残留）", () => {
    rememberImageSize("blob:xyz", 800, 600);
    rememberSourceSize("./a.png", 320, 240);
    clearImagePool();
    expect(poolStats().sizes).toBe(0);
    expect(poolStats().sourceSizes).toBe(0);
  });
});
