import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 侧栏文件树「选中态只有一份」的护栏。
 *
 * 用户报过一个缺陷（截图里文件夹行与笔记行**同时**亮着同一个底色）：
 * 「文件和文件夹能够被同时选中, 这不是预期的」。
 *
 * 根因是两种**不同**的状态共用了一个类：
 *   - `scope`（文件夹 = 新建笔记的落点；星标 / 回收站 = 正在看的集合）→ `FolderBranch` / `ScopeRow`
 *   - `activeId`（编辑器里打开的那篇笔记）→ `NoteRow`
 * 两处都写 `.tree__row.is-active`，于是树上可以同时出现两行 `--accent-soft` 底 + 550 字重，
 * 看上去就是「同时选中了两个」。
 *
 * 现在的口径：**整棵树的选中底色（`is-active`，S-C8）只属于笔记行**；
 * 落点 / 当前集合走 `is-current`（左侧 2px 强调条 + 强调色图标 + `--ink` 的 550 字重，
 * **没有底色**）。真实观感要在浏览器里看（截图见提交说明），这里守的是别把它改回去。
 *
 * 口径与 `shellLayout.test.ts` 一致：读源码文本，**先剥注释**，免得注释里的示例被当成真规则。
 */

const read = (name: string): string =>
  readFileSync(new URL(name, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\r\n/g, "\n");

const sidebar = read("../components/Sidebar.tsx");
const app = read("../styles/app.css");

/**
 * 取一个函数的函数体（含最外层花括号）。
 *
 * 从 `function NAME(` 开始数括号：**只有圆括号配平之后遇到的第一个 `{` 才是函数体** ——
 * 否则 `function FolderBranch({ folder, depth, ... })` 会被当成函数体从解构参数就开了头。
 */
function bodyOf(source: string, name: string): string {
  const head = source.indexOf(`function ${name}(`);
  if (head < 0) throw new Error(`源码里找不到 function ${name}()`);
  let bodyStart = -1;
  let parens = 0;
  for (let i = source.indexOf("(", head); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") parens += 1;
    else if (ch === ")") parens -= 1;
    else if (ch === "{" && parens === 0) {
      bodyStart = i;
      break;
    }
  }
  if (bodyStart < 0) throw new Error(`${name}() 没有函数体`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`${name}() 的花括号不配对`);
}

/** 取一条顶层规则的声明块（选择器前面必须是行首 / `}` / `,`，与 `shellLayout.test.ts` 同款）。 */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("侧栏文件树：同一时刻只有一行是选中态", () => {
  it("文件夹行 / 集合行 / 标签行不再是选中态（`is-active` → `is-current`）", () => {
    for (const name of ["FolderBranch", "ScopeRow", "TagsBody"]) {
      const body = bodyOf(sidebar, name);
      expect(body, `${name} 应当挂 is-current`).toContain("is-current");
      expect(body, `${name} 不许再挂 is-active（那是笔记行的选中态）`).not.toContain("is-active");
    }
  });

  it("文件夹行不是树上的「选中项」：`aria-selected` 为 false，用 `aria-current` 说落点", () => {
    const body = bodyOf(sidebar, "FolderBranch");
    expect(body).toContain("aria-selected={false}");
    expect(body).toContain('aria-current={current ? "true" : undefined}');
  });

  it("选中底色（S-C8）只由笔记行产出", () => {
    expect(bodyOf(sidebar, "NoteRow")).toContain('"is-active"');
    // 树上另外那处 `is-active` 是搜索结果的平铺列表，判据同样是 `activeId`（同一篇笔记）。
    expect(bodyOf(sidebar, "SearchBody")).toContain('activeId === hit.note.id && "is-active"');
  });

  it("`is-current` 里不许有底色（有底色就又变回「选中」了）", () => {
    const block = rule(app, ".tree__row.is-current");
    expect(block).not.toBe("");
    expect(block).not.toMatch(/background(-color)?\s*:/);
  });

  it("`is-current` 用「左侧强调条 + 强调色图标」说话", () => {
    expect(rule(app, ".tree__row.is-current")).toMatch(/position:\s*relative/);
    expect(rule(app, ".tree__row.is-current::before")).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(app, ".tree__row.is-current .tree__icon")).toMatch(/color:\s*var\(--accent\)/);
  });

  it("真·选中态仍是 S-C8：`--accent-soft` 底（这条不许被顺手改掉）", () => {
    expect(rule(app, ".tree__row.is-active")).toMatch(/background:\s*var\(--accent-soft\)/);
  });
});
