/**
 * iOS 26/27 主屏 PWA 顶部的系统级模糊。
 *
 * index.html 里贴顶的实色层（`.ios-top-edge`）让 iOS 不再画模糊，但 iOS 只在某些时候重新认它：
 * 首次打开时还是模糊，人滑一下内容才变清楚，之后一直清楚到退出重开。这里替人做那一下：
 * 启动后、隔一会儿、从后台切回时，让实色层高 1px 停两帧再还原；屏幕中间的内容能滚、
 * 又停在最上面时，悄悄滚 1px 再滚回（人已经滚过就不动）。
 *
 * 只在 iOS 的 standalone 下做（与 index.html 里 `.ios-top-edge` 的条件一样）：Safari 普通页、
 * Android、桌面版、Capacitor 什么都不做。
 */

type Raf = (cb: () => void) => unknown;

/** iOS 主屏安装版：standalone + 只有 iOS 的 WebKit 认的 `-webkit-touch-callout`。 */
export function isIosStandalone(w: Window): boolean {
  const standalone = w.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const css = (w as Window & { CSS?: { supports?: (prop: string, value: string) => boolean } }).CSS;
  const ios = css?.supports?.("-webkit-touch-callout", "none") ?? false;
  return standalone && ios;
}

/** 顶栏下面第一个能上下滚的元素（正文、阅读视图、文件树……）：从屏幕中间那个元素往上找。 */
export function topScroller(doc: Document): HTMLElement | null {
  const w = doc.defaultView;
  if (!w || typeof doc.elementFromPoint !== "function") return null;
  let el = doc.elementFromPoint(w.innerWidth / 2, w.innerHeight / 2) as HTMLElement | null;
  for (; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const overflowY = w.getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/** 让 iOS 重新认一次顶部实色层。 */
export function nudgeTopBar(doc: Document, raf: Raf): void {
  const bar = doc.querySelector<HTMLElement>(".ios-top-edge");
  if (bar) {
    bar.classList.add("is-nudge");
    raf(() => raf(() => bar.classList.remove("is-nudge")));
  }
  const el = topScroller(doc);
  // 人已经往下滚过（scrollTop > 0）就不动：这时模糊已经好了，也不能改人的位置
  if (el && el.scrollTop === 0) {
    el.scrollTop = 1;
    raf(() => {
      // 这一帧里人自己滚了，就不拉回去
      if (el.scrollTop === 1) el.scrollTop = 0;
    });
  }
}

/**
 * 启动时调用一次。笔记本要等 OPFS / 文件夹读完才有能滚的内容，所以除了首帧之后，
 * 再隔 0.8 秒、2.5 秒各做一次；从后台切回时也做（iOS 回到主屏应用不一定重新加载页面）。
 */
export function installIosTopBar(w: Window): void {
  if (!isIosStandalone(w)) return;
  const raf: Raf = (cb) => w.requestAnimationFrame(cb);
  const run = () => nudgeTopBar(w.document, raf);
  raf(() => raf(run));
  for (const ms of [800, 2500]) w.setTimeout(run, ms);
  w.addEventListener("pageshow", run);
  w.document.addEventListener("visibilitychange", () => {
    if (w.document.visibilityState === "visible") w.setTimeout(run, 50);
  });
}
