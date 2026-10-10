/**
 * 切换笔记 = CodeMirror 整篇替换文档 = 所有 ImageWidget 连同它们的 `<img>` 一起销毁重建
 * （`EditorPane` 的换文档是 `changes: {from: 0, to: doc.length}`，旧装饰连同 widget DOM 全丢）。
 * Blob URL 虽然有缓存（`assets.ts` 的 `imageUrlStore`），但每个**新建的** `<img>` 仍要重新走
 * 「加载 → 解码 → 首绘」：期间高度塌成 0，整篇内容上下跳，解码完又弹回去 —— 大张白底截图
 * 一收一放，就是用户看到的「切换文件整屏闪一下」（2026-10-10 用户报告）。
 *
 * 这里把**已成功加载的 `<img>` 元素本身**池化：同一张图在换笔记（或光标进出把 widget 换成
 * 源码再换回来）时直接把上一个元素搬回来 —— 对浏览器来说它还是那张已解码的位图，零加载、
 * 零解码、零布局塌陷。上限（每 URL 4 个、全局 64 个）让池子只覆盖「来回切换的几篇笔记」，
 * 超出的（以及换工作区后 blob 已失效的旧桶）按 FIFO 交给 GC，不替浏览器做内存管理。
 *
 * 本模块刻意不碰 DOM、不 import 任何东西：元素只是被存取的对象引用，核心逻辑（进池校验、
 * 借还配对、上限裁剪）因此能在 node 环境的单测里直接跑（`imagePool.test.ts`）。
 */

/** 同一张图最多留几个空闲元素（同一张图在一篇笔记里出现几次，就有可能同时要几个）。 */
const PER_URL_CAP = 4;
/** 整个池子的全局上限：只服务「来回切换的几篇笔记」，其余交给 GC。 */
const TOTAL_CAP = 64;

/** URL → 空闲（已从文档摘下）的元素，后进先出。 */
const idle = new Map<string, HTMLImageElement[]>();

/**
 * 只有成功触发过 `load` 的元素才允许进池：坏图（404、文件被删）的 `complete` 同样是
 * `true`，但显示出来是破图 —— 不能靠元素自身状态判断，必须在 load 回调里显式标记。
 */
const loaded = new WeakSet<HTMLImageElement>();

/**
 * URL → 自然尺寸。第一次加载后记下，之后重建的新元素先用 `width`/`height` 属性占住布局
 * （配合编辑区 CSS 的 `max-width: 100%; height: auto`，浏览器会按这两个属性推出宽高比），
 * 解码完成前文档不再塌一下 —— 这是「白图闪屏」的另一半。
 */
const sizes = new Map<string, { width: number; height: number }>();

/** 尺寸表条目很小，但同样不无限长：超过就按记录顺序淘汰最老的。 */
const SIZES_CAP = 512;

export function rememberImageSize(url: string, width: number, height: number): void {
  if (!url || width <= 0 || height <= 0) return;
  if (sizes.has(url)) return; // 第一次量到的为准：同一张图的尺寸不会变
  sizes.set(url, { width, height });
  if (sizes.size > SIZES_CAP) {
    const oldest = sizes.keys().next();
    if (!oldest.done) sizes.delete(oldest.value);
  }
}

export function imageSizeFor(url: string): { width: number; height: number } | null {
  return sizes.get(url) ?? null;
}

/** 图片 `load` 之后调一次：把这个元素标记为「可入池」。 */
export function markImageLoaded(img: HTMLImageElement): void {
  loaded.add(img);
}

/**
 * 借一个同 URL 的已加载元素（有就零成本复用），没有返回 `null`。
 * 仍挂在文档上的元素不借 —— 它还是当前某个 widget 的命根子；等那个 widget 销毁时会把
 * 它还回来。
 */
export function pooledImageElement(url: string): HTMLImageElement | null {
  const bucket = idle.get(url);
  if (!bucket) return null;
  while (bucket.length) {
    const img = bucket.pop()!;
    if (img.isConnected) continue;
    return img;
  }
  return null;
}

/**
 * widget 被拆掉（换笔记 / 光标进出图片行 / 图片 URL 异步到达触发的整轮装饰重建）时，
 * 把元素还池，供下一个同 URL 的 widget 复用。没标记过 load、还挂在文档上、或已经
 * 在池里的，一律安静地忽略 —— 调用方（`ImageWidget.destroy`）不该为它写分支。
 */
export function parkImageElement(url: string, img: HTMLImageElement): void {
  if (!url || !loaded.has(img) || img.isConnected) return;
  let bucket = idle.get(url);
  if (!bucket) {
    bucket = [];
    idle.set(url, bucket);
  }
  if (bucket.includes(img)) return;
  bucket.push(img);
  if (bucket.length > PER_URL_CAP) bucket.shift();
  trimTotal();
}

/** 全局上限裁剪：从最早入池的桶开始按 FIFO 淘汰。失效 URL 的旧桶也由此自然排干。 */
function trimTotal(): void {
  let total = 0;
  for (const bucket of idle.values()) total += bucket.length;
  while (total > TOTAL_CAP) {
    const oldest = idle.keys().next();
    if (oldest.done) break;
    const bucket = idle.get(oldest.value)!;
    bucket.shift();
    if (!bucket.length) idle.delete(oldest.value);
    total -= 1;
  }
}

/** @internal 单测用：看池子现状（入池元素数、URL 桶数、记住的尺寸数）。 */
export function poolStats(): { idle: number; urls: number; sizes: number } {
  let idleCount = 0;
  for (const bucket of idle.values()) idleCount += bucket.length;
  return { idle: idleCount, urls: idle.size, sizes: sizes.size };
}

/** @internal 单测用：清空池子。池子是模块级单例，用例之间需要干净的起点。 */
export function clearImagePool(): void {
  idle.clear();
  sizes.clear();
}
