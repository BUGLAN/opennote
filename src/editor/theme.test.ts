/**
 * 光标「偏下」（用户 0.5.0 实测：「光标偏移? 偏下」）这一条**只在真实浏览器里能量**：几何依赖
 * 字体度量，而本仓库的测试环境是 node（`vitest.config.ts` 的 `environment: "node"`），量不出布局。
 *
 * 所以这里守的是**这条规则的性质**，不是像素：
 *   - 补偿必须按光标**自身高度的百分比**（`translateY` 的百分比按元素自身高度算，而 CodeMirror
 *     给的高度正是这一行的字体盒）⇒ 任意字号、任意标题级别、任意字体预设下都等于要补的那 0.12em；
 *   - **不许写死像素**：`-2px` 在 16.5px 正文上刚好、在 H1（30px 光标）上补不够、在小字号上又补过头 ——
 *     这是这个 bug 的修法最容易走偏的地方，所以专门咬住它。
 *
 * 真实现场与量法（Windows / 默认字体栈 / 16.5px 正文 / 夜读主题，网页版截图上按像素量的）：
 *   正文汉字行：墨迹 y 100–115，字体盒（= 光标框）101–117 ⇒ 补偿后 100–114，上下各露 1px；
 *   H1 汉字行：墨迹 181–209，字体盒 185–214 ⇒ 补偿后 181–209，上下各 0px；
 *   拉丁行：墨迹 131–147，字体盒也是 131–147（本来就对齐）⇒ 补偿后仍在字母上下沿内。
 * 复核办法写在 `DESIGN.md` 的「光标」那一行。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("./theme.ts", import.meta.url), "utf8");

/** 光标那条规则本体：从选择器起到它的 `}`（注释里的举例不算规则）。 */
const CURSOR_RULE = (SOURCE.match(/"\.cm-cursor, \.cm-dropCursor":\s*\{[\s\S]*?\n  \},/) || [])[0] || "";

describe("editorTheme 的光标规则", () => {
  it("规则在（删掉它，汉字行的光标又会拖到字脚下面）", () => {
    expect(CURSOR_RULE).not.toBe("");
  });

  it("上移补偿按自身高度的百分比算，不写死像素", () => {
    expect(CURSOR_RULE).toMatch(/transform: "translateY\(-\d+(?:\.\d+)?%\)"/);
    expect(CURSOR_RULE).not.toMatch(/translateY\(-\d+(?:\.\d+)?px\)/);
  });

  it("强调色与 2px 宽度不变（DESIGN.md 的「光标」那一行）", () => {
    expect(CURSOR_RULE).toMatch(/borderLeft: "2px solid var\(--accent\)"/);
    expect(CURSOR_RULE).toMatch(/borderRadius: "1px"/);
  });
});
