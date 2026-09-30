import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 装配层与红线的守卫。
 * DOM 层不许引 jsdom（vitest 是 node 环境），所以"预览渲染的是编辑区内容""提交发的是当前表单"
 * 这两条只能锚在 `app.tsx` 的源码上 —— 它们盯的是意图（读的是哪份数据），不是函数名的字面。
 */
const CLIP_HTML = new URL("../../clip/index.html", import.meta.url);
const WEB_DIR = fileURLToPath(new URL(".", import.meta.url));

function readWeb(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

/** 本页的所有源码（含测试）：无 emoji 这条红线连注释一起管。 */
function webSources(): string[] {
  return readdirSync(WEB_DIR)
    .filter((name) => /\.(?:ts|tsx|css)$/.test(name))
    .sort();
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const EMOJI = /[\p{Extended_Pictographic}\uFE0F]/u;

describe("clip/index.html：CSP 与不白屏", () => {
  it("没有任何内联可执行脚本，且只有一个指向页面入口的 module 脚本", () => {
    const html = readFileSync(CLIP_HTML, "utf8");
    const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi)].map((match) => match[0]);
    expect(inline, "桥下发的是 script-src 'self'，内联脚本会被拦下").toEqual([]);

    const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('type="module"');
    expect(tags[0]).toContain('src="../src/clip-web/main.tsx"');
  });

  it("脚本没跑起来时页面也有一句人话和一条可照做的指引（不白屏）", () => {
    const html = readFileSync(CLIP_HTML, "utf8");
    expect(html).toContain("正在读取这次剪藏");
    expect(html).toMatch(/<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/);
    expect(html).toContain("重新发起剪藏");
  });
});

describe("红线：无 emoji / 新增令牌 0 / 零新依赖", () => {
  it("src/clip-web 与 clip/index.html 里都没有 emoji（注释也算）", () => {
    const offenders: string[] = [];
    for (const name of webSources()) {
      const found = EMOJI.exec(readWeb(name));
      if (found) offenders.push(`${name} 里有 ${JSON.stringify(found[0])}`);
    }
    const htmlFound = EMOJI.exec(readFileSync(CLIP_HTML, "utf8"));
    if (htmlFound) offenders.push(`clip/index.html 里有 ${JSON.stringify(htmlFound[0])}`);
    expect(offenders).toEqual([]);
  });

  it("clip.css 一个令牌都不新增（只用 tokens.css 里已有的）", () => {
    const css = stripComments(readWeb("clip.css"));
    const declared = [...css.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/gm)].map((match) => match[1]);
    expect(declared).toEqual([]);
  });
});

describe("一个事实一个产地", () => {
  it("页面自己不引渲染库：预览只能走 ../lib/markdown", () => {
    for (const name of webSources()) {
      expect(stripComments(readWeb(name)), `${name} 直接引了渲染库；渲染规则只许来自 ../lib/markdown`).not.toMatch(
        /from\s+"(?:markdown-it|dompurify)"/,
      );
    }
  });

  it("stage.selection 只当布尔用：整个 src/clip-web 里没有把 selection 当字符串的地方", () => {
    // 契约（02 §2.3 / 00 §6.15㉝）：selection 回答的是"正文是不是来自文本选区"，
    // 选中的那段文字本身走 body。把它当字符串用 = 一个字段两个含义，而且会让正文多一个来源。
    const STRING_OP =
      /selection\s*(?:\.\s*(?:trim|slice|startsWith|endsWith|includes|split|replace|charAt|substring|substr|indexOf|lastIndexOf|match|matchAll|repeat|padStart|padEnd|toLowerCase|toUpperCase|localeCompare|at|length)\b|\+|`)/g;
    const offenders: string[] = [];
    for (const name of webSources()) {
      const code = stripComments(readWeb(name));
      for (const match of code.matchAll(STRING_OP)) offenders.push(`${name}: ${match[0].replace(/\s+/g, " ")}`);
    }
    expect(offenders, "selection 是布尔，不是选中的文字；正文只许从 body 来").toEqual([]);

    // 类型声明本身也钉住：写成 string 时这条会红（更强的编译期判据在 contract.test.ts）。
    expect(stripComments(readWeb("contract.ts"))).toMatch(/selection:\s*boolean/);
  });

  it("requests.ts 里每一个 fetch 都带 AbortSignal.timeout", () => {
    const code = stripComments(readWeb("requests.ts"));
    const fetches = (code.match(/\bfetch\s*\(/g) ?? []).length;
    const timeouts = (code.match(/AbortSignal\.timeout\s*\(/g) ?? []).length;
    expect(fetches).toBeGreaterThan(0);
    expect(timeouts, "多了一个没有超时的 fetch：一次性页面里那就是永久等待").toBe(fetches);
  });
});

describe("装配层读的是哪一份数据", () => {
  it("main.tsx 从 #clip-boot 读启动信息，不是写死 stageId", () => {
    const code = stripComments(readWeb("main.tsx"));
    expect(code).toContain('document.getElementById("clip-boot")');
    expect(code).toMatch(/parseBoot\(/);
  });

  it("app.tsx：预览渲染的是编辑区的内容，提交发的是当前表单", () => {
    const code = stripComments(readWeb("app.tsx"));

    const previewCalls = (code.match(/\brenderPreview\s*\(/g) ?? []).length;
    const formPreviewCalls = (code.match(/\brenderPreview\(\s*state\.form\.body\s*\)/g) ?? []).length;
    expect(previewCalls).toBeGreaterThan(0);
    expect(formPreviewCalls, "预览必须渲染编辑区里的内容（渲染暂存原值 = 用户改了看不到）").toBe(previewCalls);

    const commitCalls = (code.match(/\bcommitClip\s*\(/g) ?? []).length;
    const formCommitCalls = (code.match(/\bcommitClip\(\s*boot\s*,\s*state\.form\s*[,)]/g) ?? []).length;
    expect(commitCalls).toBeGreaterThan(0);
    expect(formCommitCalls, "提交必须发当前表单（发暂存原值 = 用户的编辑白改）").toBe(commitCalls);
  });
});
