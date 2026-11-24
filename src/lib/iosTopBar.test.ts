import { describe, expect, it, vi } from "vitest";
import { installIosTopBar, isIosStandalone, nudgeTopBar, topScroller } from "./iosTopBar";

/** 把 rAF 回调攒起来，一帧一帧地跑。 */
function frames() {
  let queue: (() => void)[] = [];
  const raf = (cb: () => void) => queue.push(cb);
  const step = () => {
    const now = queue;
    queue = [];
    for (const cb of now) cb();
  };
  return { raf, step };
}

function fakeWin(standalone: boolean, ios: boolean) {
  return {
    matchMedia: (q: string) => ({ matches: q === "(display-mode: standalone)" && standalone }),
    CSS: { supports: (p: string, v: string) => p === "-webkit-touch-callout" && v === "none" && ios },
  };
}

class FakeClassList {
  private set = new Set<string>();
  add(name: string) {
    this.set.add(name);
  }
  remove(name: string) {
    this.set.delete(name);
  }
  contains(name: string) {
    return this.set.has(name);
  }
}

interface FakeEl {
  parentElement: FakeEl | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  classList: FakeClassList;
}

function el(parent: FakeEl | null, overflowY = "visible", scrollHeight = 100): FakeEl {
  return { parentElement: parent, scrollTop: 0, scrollHeight, clientHeight: 100, overflowY, classList: new FakeClassList() };
}

/** 一份假的 document：body > 滚动区 > 内容（屏幕中间命中内容），外加顶部实色层。 */
function fakeDoc(opts: { scrollable?: boolean; bar?: boolean; elementFromPoint?: boolean } = {}) {
  const body = el(null);
  const area = el(body, "auto", opts.scrollable === false ? 100 : 1000);
  const inner = el(area);
  const bar = opts.bar === false ? null : el(body);
  const view = {
    innerWidth: 400,
    innerHeight: 800,
    getComputedStyle: (node: FakeEl) => ({ overflowY: node.overflowY }),
  };
  const doc = {
    body,
    documentElement: null,
    defaultView: view,
    querySelector: (sel: string) => (sel === ".ios-top-edge" ? bar : null),
    ...(opts.elementFromPoint === false ? {} : { elementFromPoint: () => inner }),
  } as unknown as Document;
  return { doc, area, bar };
}

describe("isIosStandalone", () => {
  it("standalone 而且是 iOS 才算", () => {
    expect(isIosStandalone(fakeWin(true, true) as unknown as Window)).toBe(true);
    expect(isIosStandalone(fakeWin(false, true) as unknown as Window)).toBe(false); // Safari 里打开
    expect(isIosStandalone(fakeWin(true, false) as unknown as Window)).toBe(false); // Android、桌面装的 PWA
    expect(isIosStandalone({} as Window)).toBe(false);
  });
});

describe("nudgeTopBar", () => {
  it("实色层高 1px 停两帧再还原", () => {
    const { doc, bar } = fakeDoc();
    const f = frames();
    nudgeTopBar(doc, f.raf);
    expect(bar!.classList.contains("is-nudge")).toBe(true);
    f.step();
    expect(bar!.classList.contains("is-nudge")).toBe(true);
    f.step();
    expect(bar!.classList.contains("is-nudge")).toBe(false);
  });

  it("内容能滚、停在最上面：滚 1px，下一帧滚回", () => {
    const { doc, area } = fakeDoc();
    const f = frames();
    nudgeTopBar(doc, f.raf);
    expect(area.scrollTop).toBe(1);
    f.step();
    expect(area.scrollTop).toBe(0);
  });

  it("人已经往下滚过：不改位置", () => {
    const { doc, area } = fakeDoc();
    area.scrollTop = 300;
    const f = frames();
    nudgeTopBar(doc, f.raf);
    f.step();
    expect(area.scrollTop).toBe(300);
  });

  it("滚回之前人自己滚了：不拉回去", () => {
    const { doc, area } = fakeDoc();
    const f = frames();
    nudgeTopBar(doc, f.raf);
    area.scrollTop = 80;
    f.step();
    expect(area.scrollTop).toBe(80);
  });

  it("内容不能滚、没有 elementFromPoint、没有实色层时不出错", () => {
    expect(topScroller(fakeDoc({ scrollable: false }).doc)).toBeNull();
    expect(topScroller(fakeDoc({ elementFromPoint: false }).doc)).toBeNull();
    const { doc } = fakeDoc({ bar: false, scrollable: false });
    expect(() => nudgeTopBar(doc, frames().raf)).not.toThrow();
  });
});

describe("installIosTopBar", () => {
  function win(standalone: boolean, ios: boolean) {
    return {
      ...fakeWin(standalone, ios),
      document: { addEventListener: vi.fn(), visibilityState: "visible" },
      requestAnimationFrame: vi.fn(),
      setTimeout: vi.fn(),
      addEventListener: vi.fn(),
    };
  }

  it("不是 iOS 主屏安装版时什么都不做", () => {
    for (const w of [win(true, false), win(false, true)]) {
      installIosTopBar(w as unknown as Window);
      expect(w.requestAnimationFrame).not.toHaveBeenCalled();
      expect(w.setTimeout).not.toHaveBeenCalled();
      expect(w.addEventListener).not.toHaveBeenCalled();
      expect(w.document.addEventListener).not.toHaveBeenCalled();
    }
  });

  it("iOS 主屏安装版：启动后、隔一会儿、切回前台时各动一次", () => {
    const w = win(true, true);
    installIosTopBar(w as unknown as Window);
    expect(w.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(w.setTimeout.mock.calls.map((c) => c[1])).toEqual([800, 2500]);
    expect(w.addEventListener.mock.calls.map((c) => c[0])).toEqual(["pageshow"]);
    expect(w.document.addEventListener.mock.calls.map((c) => c[0])).toEqual(["visibilitychange"]);
  });
});
