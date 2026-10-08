import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectImagePaths, resolveWorkspacePath } from "../data/assets";
import type { WorkspaceRecord } from "../data/workspaces";
import { parentPath } from "../fs";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";
import { assetFinalName } from "../lib/clip/landing";
import { renderMarkdown } from "../lib/markdown";
import { findLinkAt } from "./media";
import { markdownSupport } from "./markdown";
import { editorSettings, editorSettingsField } from "./settings";

let testBackend: MemoryBackend;
vi.mock("../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { flushAll, openWorkspace, saveImage } from "../data/library";
import { insertFileSnippets } from "./media";

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownSupport] });
}

/** Find the URL under the first occurrence of `needle`. */
function linkAt(doc: string, needle: string, offset = 0): string | null {
  const at = doc.indexOf(needle);
  expect(at, `needle ${needle} not found`).toBeGreaterThanOrEqual(0);
  return findLinkAt(stateFor(doc), at + offset);
}

describe("D27 findLinkAt 跳过代码里的 URL", () => {
  it("does not open a URL inside inline code", () => {
    expect(linkAt("用 `https://example.com/a` 表示", "https://example.com/a")).toBeNull();
  });

  it("does not open a URL inside a fenced code block", () => {
    expect(linkAt("```\nhttps://example.com/b\n```\n", "https://example.com/b")).toBeNull();
  });

  it("does not open a URL inside a fenced block with a language", () => {
    expect(linkAt("```js\n// https://example.com/c\n```\n", "https://example.com/c")).toBeNull();
  });

  it("does not open a URL inside an indented code block", () => {
    expect(linkAt("    缩进 https://example.com/d\n", "https://example.com/d")).toBeNull();
  });

  it("does not open a markdown link written inside inline code", () => {
    expect(linkAt("语法是 `[文字](https://example.com/e)`", "https://example.com/e")).toBeNull();
  });
});

describe("D27 findLinkAt 仍然能打开正常链接", () => {
  it("opens a markdown link from its label, brackets and url", () => {
    const doc = "看 [站点](https://example.com/page) 吧";
    expect(linkAt(doc, "站点", 1)).toBe("https://example.com/page");
    expect(linkAt(doc, "https://example.com/page", 3)).toBe("https://example.com/page");
  });

  it("opens a bare url in prose", () => {
    const doc = "访问 https://a.example/b?x=1 结束";
    expect(linkAt(doc, "https://a.example/b", 5)).toBe("https://a.example/b?x=1");
  });

  it("opens an autolink", () => {
    const doc = "见 <https://auto.example/x> 一节";
    expect(linkAt(doc, "https://auto.example/x", 4)).toBe("https://auto.example/x");
  });

  it("opens an image url", () => {
    const doc = "前 ![图](https://img.example/p.png) 后";
    expect(linkAt(doc, "https://img.example/p.png", 4)).toBe("https://img.example/p.png");
  });

  it("returns null on ordinary text", () => {
    expect(findLinkAt(stateFor("这里没有链接，只有中文。\n"), 4)).toBeNull();
  });

  it("returns null on an empty document", () => {
    expect(findLinkAt(stateFor(""), 0)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 粘贴/拖拽的附件落点：工作区根的共享 `.assets/`
 *
 * 判据盯的是**用户看得见的那条路径**：粘贴一张图之后，磁盘上多出来的文件在哪、
 * 正文里写下的相对引用能不能解析回那个文件。两条一起咬，因为「落盘对了但引用指空」
 * 与「引用对了但落在别处」是同一类缺陷的两面。
 *
 * 这里刻意**不测**「传目录会怎样」当成通过标准 —— 那是缺陷本身；只把它作为
 * 「静默接错来源会被守卫拦下」的负例（见最后一例）。
 * ------------------------------------------------------------------------ */

const record: WorkspaceRecord = {
  id: "test",
  name: "临时笔记本",
  kind: "node",
  location: "unused",
  addedAt: 1,
  lastOpenedAt: 1,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
/** 与 `PNG` 不同字节的第二张图：用来证明「同名不同内容 ⇒ 去重，不静默覆盖」。 */
const OTHER_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);

function pngFile(name: string, bytes = PNG): File {
  return new File([bytes as unknown as BlobPart], name, { type: "image/png" });
}

/** Markdown 引用里 `](...)` 的目标（带 `<…>` 形式时把尖括号剥掉，返回可解析的路径）。 */
function refOf(snippet: string): string {
  const at = snippet.indexOf("](");
  expect(at, `snippet ${snippet} has no markdown link`).toBeGreaterThanOrEqual(0);
  return snippet.slice(at + 2, -1).replace(/^<|>$/g, "");
}

/**
 * 这条判据盯的是**用户看得见的那条路径**：产出的引用在**应用自己的渲染器**里
 * （`src/lib/markdown.ts` 的 markdown-it 管线）到底能不能渲染成 `<img>`。
 *
 * 只断言「引用文本长这样」是不够的 —— 之前就是这么绿的：`./备注 2.assets/截图.png`
 * 里那个空格会**截断链接目标**，markdown-it 原样输出文本、lezer 不产 URL 子节点，
 * 图片在编辑器与预览里都不显示，而且**不报错**。判据盯着「我以为它在用的那个字符串」，
 * 就没看见「用户其实看不到图」。
 */
function rendersAsImage(snippet: string): boolean {
  return /<img\b[^>]*\bsrc=/i.test(renderMarkdown(snippet));
}

describe("粘贴/拖拽的图片：落共享 .assets/，引用能解析回它", () => {
  const notePath = "归档/备注 2.md";

  beforeEach(async () => {
    testBackend = new MemoryBackend();
    await openWorkspace(record, { silent: true });
  });

  afterEach(async () => {
    await flushAll();
    vi.restoreAllMocks();
  });

  it("编辑器字段带的是**笔记路径**；图片落在工作区根的 `.assets/`，引用按笔记所在目录解析回该文件", async () => {
    const state = EditorState.create({ extensions: [editorSettings({ notePath })] });
    const fromField = state.field(editorSettingsField).notePath;
    expect(fromField).toBe(notePath);

    // 落盘名 = 内容派生的 uuid + 扩展名（`assetFinalName` 是唯一产地，这里不抄公式）。
    const asset = await assetFinalName(PNG, "截图.png");
    const snippets = await insertFileSnippets([pngFile("截图.png")], {
      notePath: fromField,
      imageMode: "asset",
      notify: () => undefined,
    });
    // `归档/备注 2.md` 在 `归档/` 下一层 ⇒ 引用带一条 `../`；共享目录与 uuid 名都不含空格，
    // 所以不再需要 `<…>` 形式（`markdownRef` 仍然兜底）。
    expect(snippets).toEqual([`![截图.png](../.assets/${asset})`]);
    expect(rendersAsImage(snippets[0]), `引用没有被渲染成图片：${snippets[0]}`).toBe(true);

    // 引用解析的基准仍是**笔记所在目录**（`resolveImageSrc(src, baseDir)` 的契约没变）：
    // `..` 必须在目录语义下被吃掉，否则图在编辑器里是裂图（而且不报错）。
    const resolved = resolveWorkspacePath(refOf(snippets[0]), parentPath(fromField));
    expect(resolved).toBe(`.assets/${asset}`);
    expect(testBackend.paths()).toEqual([`.assets/${asset}`]);

    // 同一个事实的另一面：新图**不再**进公共 `assets/`，也不会再出现按笔记名派生的目录。
    expect(testBackend.calls.some((call) => call.includes("归档/assets/"))).toBe(false);
    expect(testBackend.paths().some((path) => path.includes("备注 2.assets"))).toBe(false);
  });

  it("笔记在根目录：引用就是 `.assets/<uuid>`（前缀为空）", async () => {
    const asset = await assetFinalName(PNG, "截图.png");
    const snippets = await insertFileSnippets([pngFile("截图.png")], {
      notePath: "备注 2.md",
      imageMode: "asset",
      notify: () => undefined,
    });
    expect(snippets).toEqual([`![截图.png](.assets/${asset})`]);
    expect(resolveWorkspacePath(refOf(snippets[0]), parentPath("备注 2.md"))).toBe(`.assets/${asset}`);
    expect(testBackend.paths()).toEqual([`.assets/${asset}`]);
    // 产出的引用必须在应用自己的渲染器里真的变成 `<img>`。
    expect(rendersAsImage(snippets[0]), `引用没有被渲染成图片：${snippets[0]}`).toBe(true);
  });

  it("没有打开的笔记：一个字节都不写，也不猜笔记名，只如实提示一次", async () => {
    const notices: string[] = [];
    const snippets = await insertFileSnippets([pngFile("a.png"), pngFile("b.png")], {
      notePath: "",
      imageMode: "asset",
      notify: (message) => notices.push(message),
    });
    expect(snippets).toEqual([]);
    expect(notices).toEqual(["还没有打开笔记，附件没有落点"]);
    expect(testBackend.paths()).toEqual([]);
  });

  it("新旧两个位置并存（公共 assets/ 有老图、派生目录里已有同名图）：新图只进派生目录，两个旧位置逐字节不动", async () => {
    // 旧世界留下的图：公共 `归档/assets/` —— 一个字节都不许动（旧数据不迁移）。
    testBackend.seedBytes("归档/assets/老图.png", PNG);
    // 共享目录里已经把同一 uuid 占住了（用户手放的、或极端哈希碰撞）：新图必须去重，绝不静默覆盖。
    const asset = await assetFinalName(OTHER_PNG, "图.png");
    testBackend.seedBytes(`.assets/${asset}`, PNG);

    const snippets = await insertFileSnippets([pngFile("图.png", OTHER_PNG)], {
      notePath: "归档/备注.md",
      imageMode: "asset",
      notify: () => undefined,
    });

    // 去重序号 ` 2` 带空格 ⇒ 必须走 `<…>` 形式，否则空格截断目标、图片不渲染。
    expect(snippets).toEqual([`![图.png](<../.assets/${asset.replace(/\.png$/, " 2.png")}>)`]);
    expect(rendersAsImage(snippets[0]), `引用没有被渲染成图片：${snippets[0]}`).toBe(true);
    expect(testBackend.files.has(`.assets/${asset}`)).toBe(true);
    expect(testBackend.bytes(`.assets/${asset}`)).toEqual(PNG);
    expect(testBackend.files.has(`.assets/${asset.replace(/\.png$/, " 2.png")}`)).toBe(true);
    expect(testBackend.bytes(`.assets/${asset.replace(/\.png$/, " 2.png")}`)).toEqual(OTHER_PNG);
    // 公共目录里**只有**那张老图（新图一个字节都没往那里写）。
    expect(testBackend.paths().filter((path) => path.startsWith("归档/assets/"))).toEqual(["归档/assets/老图.png"]);
    expect(testBackend.bytes("归档/assets/老图.png")).toEqual(PNG);
  });

  it("负例：把**目录**当成笔记路径传进来会被守卫当场拦下，而不是静默写进 `未命名.assets/`", async () => {
    // 这两个参数的**类型都是 string**，编译器一个字都不报 —— 拦它的只有运行期守卫。
    await expect(saveImage(pngFile("x.png"), "x.png", "归档")).rejects.toThrow(/必须是笔记路径/);
    expect(testBackend.paths()).toEqual([]);
  });

  it("预览预载也要认得 `<…>` 形式：两种写法都要被 collectImagePaths 收进来（漏掉第二种是静默的——图一直是空白）", () => {
    const plain = "![a](./备注.assets/a.png)";
    const angled = "![b](<./备注 2.assets/b.png>)";
    const both = collectImagePaths(`${plain}\n\n${angled}\n\n![远程](https://example.com/c.png)\n`);
    expect(both).toContain("./备注.assets/a.png");
    expect(both).toContain("./备注 2.assets/b.png");
    // 远程图仍然不进本地预载队列（它不需要 blob URL）。
    expect(both.some((path) => path.startsWith("https:"))).toBe(false);
  });
});
