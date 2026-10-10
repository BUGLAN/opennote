import { beforeEach, describe, expect, it } from "vitest";
import {
  clearImagePool,
  imageSizeFor,
  markImageLoaded,
  parkImageElement,
  pooledImageElement,
  poolStats,
  rememberImageSize,
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
