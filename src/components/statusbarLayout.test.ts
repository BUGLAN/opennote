import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 底栏（`.statusbar`）窄窗降级的源码契约。
 *
 * 这不是可以靠单测算出来的东西（几何要真浏览器，见 `scripts/statusbar-fit-probe.mjs` 与
 * `docs/verify/A2-状态栏窄窗-作者证据.md`），但**降级的机制**是源码里写死的：
 *
 * - 用户 2026-10-10 的截图（视口 1264 @2x、侧栏 293、底栏只有 971px、内容要 1170px）里，
 *   「历史 / 夜读 / 设置」被 `overflow: hidden` 整颗裁掉 —— 因为降级规则判的是**视口**
 *   （`@media (max-width: 1180px)`）而底栏住在 `.main` 里（视口 − 侧栏 − 大纲）。
 * - 修法有两条腿：①结构上让**按钮组永不收缩**、信息组可以被压到 0（按钮绝不被裁，与阈值
 *   标定准不准无关）；②按**底栏自身宽度**分档整项隐藏信息。
 *
 * 这里守的就是这两条腿别再被改回去。口径与 `src/data/shellLayout.test.ts` 一致：直接读源码
 * 文本，且**先剥注释**，免得注释里的示例 CSS 被当成真规则。
 */

const readCss = (name: string): string =>
  readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r\n/g, "\n");

/** 取一条**顶层**规则的声明块（选择器前面必须是行首 / `}` / `,`）。 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

/** 取所有 `@container statusbar (max-width: Npx) { … }`（含嵌套块，用花括号配平扫）。 */
function containerTiers(css: string): { max: number; body: string }[] {
  const tiers: { max: number; body: string }[] = [];
  const pattern = /@container\s+statusbar\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css))) {
    let depth = 1;
    let index = pattern.lastIndex;
    for (; index < css.length && depth > 0; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
    }
    tiers.push({ max: Number(match[1]), body: css.slice(pattern.lastIndex, index - 1) });
    pattern.lastIndex = index;
  }
  return tiers;
}

/** 取所有 `@media … { … }` 块。 */
function mediaBlocks(css: string): string[] {
  const blocks: string[] = [];
  const pattern = /@media[^{]*\{/g;
  while (pattern.exec(css)) {
    let depth = 1;
    let index = pattern.lastIndex;
    for (; index < css.length && depth > 0; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
    }
    blocks.push(css.slice(pattern.lastIndex, index - 1));
    pattern.lastIndex = index;
  }
  return blocks;
}

/** 一个分档块里被隐藏的选择器（展开逗号分组，去掉 `display: none` 之外的花样）。 */
function hiddenSelectors(body: string): string[] {
  const out: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (!/display:\s*none/.test(match[2])) continue;
    for (const part of match[1].split(",")) {
      const selector = part.trim();
      if (selector) out.push(selector);
    }
  }
  return out;
}

const app = readCss("app.css");
const tiers = containerTiers(app);

/** 允许在窄窗里被隐藏的东西：全是**信息**，一个按钮都没有。 */
const DROPPABLE = [
  ".statusbar__item--compact", // 文件数、字数统计
  ".statusbar__item--folder", // 当前文件夹
  ".statusbar__label", // 按钮文字（图标留着）
  ".statusbar__item--cursor", // 行列
  ".statusbar__save-ago", // 保存状态里的「· N 分钟前」
  ".statusbar__item--path", // 存放位置
  ".statusbar__save-text", // 保存状态最后只剩圆点
];

describe("底栏：按钮永不裁切，信息按底栏自身宽度分档降级", () => {
  it("降级基准是底栏自己的宽度（容器查询），不再按视口判", () => {
    expect(block(app, ".statusbar")).toMatch(/container:\s*statusbar\s*\/\s*inline-size/);
    // 视口断点里不许再出现底栏的降级规则：视口 1264 时底栏可能只有 971px（用户截图那组参数）。
    for (const media of mediaBlocks(app)) {
      expect(media).not.toMatch(/statusbar/);
    }
  });

  it("结构保险：按钮组永不收缩，信息组可以被压到 0", () => {
    expect(block(app, ".statusbar__actions")).toMatch(/flex:\s*none/);
    const info = block(app, ".statusbar__info");
    expect(info).toMatch(/flex:\s*1 1 auto/);
    expect(info).toMatch(/min-width:\s*0/);
    expect(info).toMatch(/overflow:\s*hidden/);
    // 信息项默认不收缩；唯二的例外是两段长文本（存放位置 / 当前文件夹），
    // 它们可以缩到 0 —— 文字外面那层 `.statusbar__ellipsis` 负责渲染省略号。
    expect(block(app, ".statusbar__item")).toMatch(/flex:\s*none/);
    expect(block(app, ".statusbar__item--path")).toMatch(/flex:\s*0 1 auto/);
    expect(block(app, ".statusbar__item--folder")).toMatch(/flex:\s*0 1 auto/);
    expect(block(app, ".statusbar__ellipsis")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("分档从宽到窄、阈值严格递减，六个档位一个不少", () => {
    expect(tiers.length).toBe(6);
    const widths = tiers.map((tier) => tier.max);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(new Set(widths).size).toBe(widths.length);
    // 最窄的一档必须能兜住「窗口 900 + 侧栏拖到上限 520」= 底栏 380px（内容盒 356px）。
    expect(Math.min(...widths)).toBeLessThanOrEqual(440);
    // 最宽的一档换掉了旧版那条 `@media (max-width: 1180px)`：同样是 1180，只是改成按底栏宽度判。
    expect(Math.max(...widths)).toBeLessThanOrEqual(1180);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(1000);
  });

  it("任何一档都不许隐藏按钮或保存圆点", () => {
    for (const tier of tiers) {
      for (const selector of hiddenSelectors(tier.body)) {
        expect(selector).not.toMatch(/--button/);
        expect(selector).not.toMatch(/statusbar__dot/);
        expect(DROPPABLE).toContain(selector);
      }
    }
  });

  it("被隐藏的项恰好是那七样：宽窗下全部照常显示", () => {
    const hidden = tiers.flatMap((tier) => hiddenSelectors(tier.body));
    expect([...new Set(hidden)].sort()).toEqual([...DROPPABLE].sort());
  });

  it("按钮文字是单独一段（能只丢文字、留图标），且窄窗里确实会丢", () => {
    expect(block(app, ".statusbar__label")).toMatch(/white-space:\s*nowrap/);
    expect(tiers.some((tier) => hiddenSelectors(tier.body).includes(".statusbar__label"))).toBe(true);
  });
});
