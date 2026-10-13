import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterSaveToOptions } from "./InboxPanel";
import { highlightRanges, substringRanges } from "../lib/fuzzy";

/**
 * 两个「选目录」控件的护栏（2026-10-13 用户三条反馈）：
 *
 * ① 「图1 此页面搜索文件夹, 页面高度会变, 希望固定头部, 类似于设置一样」——
 *    「移动到…」（`Overlays.tsx` 的 `FolderDialog`）改成 `.dialog--tall` 定高，
 *    说明句 + 搜索框钉住，**只有列表滚**；
 * ② 「图2 需增加类似图1的搜索文件夹」—— 收件箱「保存到」下拉（`InboxPanel.tsx` 的
 *    `SaveToPicker`）加上同一个搜索框；
 * ③ 「图3 文件树需进行样式优化」—— 搜索结果行**顶格**（不再按 depth 缩进成一截楼梯）、
 *    名字与完整路径两行各自截断、命中处上 `<mark class="hit">`。
 *
 * 这三条都是**布局**事实：真实的观感要在浏览器里量（作者证据见
 * `docs/verify/`），这里守的是「别改回去」—— 与 `treeSelection.test.ts`、
 * `paletteLayout.test.ts` 同一套做法：读源码文本，先剥注释。
 */

const read = (name: string): string =>
  readFileSync(new URL(name, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\r\n/g, "\n");

const overlays = read("./Overlays.tsx");
const inbox = read("./InboxPanel.tsx");
const app = read("../styles/app.css");

/**
 * 取一条顶层规则的声明块（选择器前面必须是行首 / `}` / `,`，与 `shellLayout.test.ts` 同款）。
 * 逗号到 `{` 之间允许再挂别的选择器 —— 分组选择器（`.a > .b,\n.a > .c { … }`）里的
 * 第一条也得取得到。
 */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("「移动到…」：定高 + 头部钉住", () => {
  it("对话框走 `.dialog--tall`（与设置 / 收件箱同一个高度常量）", () => {
    const dialog = overlays.slice(overlays.indexOf("function FolderDialog("));
    // `tall` 是 `Modal` 的布尔属性：写了它才有 `.dialog--tall` 的定高。
    expect(dialog).toMatch(/<Modal[\s\S]*?\btall\b/);
  });

  it("只有列表滚：搜索框 `flex: none`，列表 `flex: 1` + `min-height: 0`", () => {
    // 钉子被挤扁的那个坑（命令面板 48px → 20px）不该在弹窗里重演。
    expect(rule(app, ".folder-picker__search")).toMatch(/flex:\s*none/);
    const picker = rule(app, ".folder-picker");
    expect(picker).toMatch(/flex:\s*1 1 auto/);
    expect(picker).toMatch(/min-height:\s*0/);
    expect(picker).toMatch(/overflow-y:\s*auto/);
    // 行内样式（上一版的 `margin: 10px 0`）已经搬进 CSS —— 组件里不再有它。
    expect(overlays).not.toContain('style={{ margin: "10px 0" }}');
  });

  it("空结果占住列表那一格并居中（定高之后不留半块空白）", () => {
    expect(rule(app, ".folder-picker__empty")).toMatch(/flex:\s*1 1 auto/);
    expect(overlays).toContain("folder-picker__empty");
  });
});

describe("目录选择器：搜索结果行的排版", () => {
  it("搜索结果**顶格**：不再按 `depth` 缩进（拍平列表里那截楼梯是假层级）", () => {
    expect(overlays).toContain("paddingLeft: stacked ? 6 : 6 + choice.depth * 13");
  });

  it("名字与完整路径两行，各自截断（`.tree__label-main` 才吃得到省略号）", () => {
    expect(overlays).toContain('className="tree__label-main"');
    const main = rule(app, ".tree__label-main");
    expect(main).toMatch(/text-overflow:\s*ellipsis/);
    expect(main).toMatch(/white-space:\s*nowrap/);
  });

  it("图标 / caret 顶到第一行的中线上（不是两行之间）", () => {
    expect(rule(app, ".tree__row--stacked > .tree__caret")).toMatch(/margin-top:/);
    expect(rule(app, ".tree__row--stacked > .tree__icon")).toMatch(/margin-top:/);
  });

  it("行**不许被 flex 压缩**：`.tree` 同时是滚动容器时，压扁的是行、滚不动的是容器", () => {
    // 根因实测：14 条两行结果时行高被压到 27px，而内容有 33.74px（第二行被裁）。
    expect(rule(app, ".tree__row")).toMatch(/flex:\s*none/);
  });

  it("命中高亮与过滤**同一口径**（子串包含，不是模糊子序列）", () => {
    expect(overlays).toContain("substringRanges");
    expect(overlays).toContain('className="hit"');
  });
});

describe("「保存到」：搜索文件夹", () => {
  const options = [
    { value: "", label: "笔记本根目录" },
    { value: "剪藏", label: "剪藏" },
    { value: "剪藏/技术/排版", label: "剪藏 / 技术 / 排版" },
    { value: "看过的书/gopl-zh", label: "看过的书 / gopl-zh" },
  ];

  it("空关键字 = 全部（列表不该一打开就是空的）", () => {
    expect(filterSaveToOptions(options, "")).toEqual(options);
    expect(filterSaveToOptions(options, "   ")).toEqual(options);
  });

  it("按名字 / 标签命中，大小写不敏感", () => {
    expect(filterSaveToOptions(options, "gopl").map((option) => option.value)).toEqual(["看过的书/gopl-zh"]);
    expect(filterSaveToOptions(options, "排版").map((option) => option.value)).toEqual(["剪藏/技术/排版"]);
    expect(filterSaveToOptions(options, "OPL")).toHaveLength(1);
  });

  it("也认**真路径**：标签里斜杠两侧有空格，用户照着磁盘敲 `剪藏/技术` 也得命中", () => {
    expect(filterSaveToOptions(options, "剪藏/技术").map((option) => option.value)).toEqual(["剪藏/技术/排版"]);
  });

  it("没命中就是空数组（面板据此说「没有找到」）", () => {
    expect(filterSaveToOptions(options, "不存在的目录")).toEqual([]);
  });

  it("命中处能被上色：过滤说命中的，高亮必须找得到（同口径）", () => {
    for (const option of options) {
      for (const query of ["gopl", "排版", "根目录"]) {
        const hit = filterSaveToOptions([option], query).length > 0;
        const painted = highlightRanges(option.label, substringRanges(option.label, query)).some((part) => part.hit);
        // 两种情况都合法，但必须是**说得出理由**的：要么标签上有高亮，
        // 要么只在真路径上命中（那种情况下完整路径由预览原样给出）。
        expect(hit ? painted || option.value.toLowerCase().includes(query) : !painted).toBe(true);
      }
    }
  });

  it("浮层：搜索框钉住、列表自己滚（`.save-to__panel` 是同一个边框盒）", () => {
    expect(inbox).toContain('className="field field--search save-to__search"');
    expect(inbox).toContain('aria-label="搜索文件夹"');
    // 逐字文案（`03` 的 `UI-03/C25`）：占位与无命中那句都与「移动到…」的搜索框**同一份说法**。
    expect(inbox).toContain('placeholder="搜索文件夹…"');
    expect(inbox).toContain("没有找到「{query.trim()}」。");
    const panel = rule(app, ".save-to__panel");
    expect(panel).toMatch(/flex-direction:\s*column/);
    expect(panel).toMatch(/overflow:\s*hidden/);
    expect(rule(app, ".save-to__search")).toMatch(/flex:\s*none/);
    // 边框 / 背景 / 阴影 / 弹出动画都在面板那一层：列表再抢一份就会画出双边框。
    const list = rule(app, ".save-to__list");
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).not.toMatch(/border:/);
    expect(list).not.toMatch(/box-shadow:/);
  });

  it("列表只渲染筛选后的候选项，且回车只结算**看得见**的那一项", () => {
    expect(inbox).toContain("matches.map((option) => {");
    expect(inbox).toContain("if (index >= 0) settle(active);");
    // `↑/↓` / `Home` / `End` 也走同一份可见行。
    expect(inbox).toContain("matches[(Math.max(index, 0) + step) % matches.length]");
  });
});
