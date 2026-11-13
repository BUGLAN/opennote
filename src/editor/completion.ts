import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

/* --------------------------------------------------------------- wiki links */

export function wikiCompletion(getTitles: () => string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]]*$/);
    if (!before) return null;
    const query = before.text.slice(2).toLowerCase();
    const titles = getTitles();
    const options: Completion[] = titles
      .filter((title) => !query || title.toLowerCase().includes(query))
      .slice(0, 40)
      .map((title) => ({
        label: `[[${title}]]`,
        displayLabel: title,
        type: "text",
        detail: "笔记",
      }));
    if (!options.length) return null;
    return {
      from: before.from,
      options,
      validFor: /^\[\[[^[\]]*$/,
    };
  };
}

/* ------------------------------------------------------------------- slash */

export interface SlashItem {
  id: string;
  label: string;
  detail: string;
  keywords: string;
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "h1", label: "标题 1", detail: "一级标题", keywords: "heading h1 title" },
  { id: "h2", label: "标题 2", detail: "二级标题", keywords: "heading h2" },
  { id: "h3", label: "标题 3", detail: "三级标题", keywords: "heading h3" },
  { id: "bullet", label: "无序列表", detail: "• 项目符号", keywords: "bullet list ul" },
  { id: "ordered", label: "有序列表", detail: "1. 编号", keywords: "ordered list ol" },
  { id: "task", label: "任务列表", detail: "□ 待办", keywords: "task todo checkbox" },
  { id: "quote", label: "引用", detail: "> 引用块", keywords: "quote blockquote" },
  { id: "codeBlock", label: "代码块", detail: "``` 围栏代码", keywords: "code fence" },
  { id: "mathBlock", label: "公式块", detail: "$$ LaTeX $$", keywords: "math katex latex formula" },
  { id: "mermaid", label: "图表", detail: "Mermaid 流程图", keywords: "mermaid diagram chart graph" },
  { id: "table", label: "表格", detail: "3 × 2 表格", keywords: "table grid" },
  { id: "hr", label: "分割线", detail: "---", keywords: "hr divider rule" },
  { id: "link", label: "链接", detail: "[文字](url)", keywords: "link url" },
  { id: "wikiLink", label: "笔记链接", detail: "[[笔记标题]]", keywords: "wiki link note" },
  { id: "date", label: "当前日期", detail: "插入今天的日期", keywords: "date today" },
];

export function slashCompletion(run: (id: string, view: EditorView) => void): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/^[ \t]*\/[\p{L}\p{N}]*$/u);
    if (!before || before.from === context.pos) return null;
    const query = before.text.replace(/^[ \t]*\//, "").toLowerCase();
    const options: Completion[] = SLASH_ITEMS.filter(
      (item) =>
        !query ||
        item.label.includes(query) ||
        item.detail.toLowerCase().includes(query) ||
        item.keywords.includes(query),
    ).map((item) => ({
      label: `/${item.id}`,
      displayLabel: item.label,
      detail: item.detail,
      type: "keyword",
      apply: (view, _completion, from, to) => {
        view.dispatch({ changes: { from, to, insert: "" } });
        run(item.id, view);
      },
    }));
    if (!options.length) return null;
    return { from: before.from, options, validFor: /^[ \t]*\/[\p{L}\p{N}]*$/u };
  };
}

/* -------------------------------------------------------------------- tags */

export function tagCompletion(getTags: () => string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    if (context.state.selection.main.from !== context.pos) return null;
    const before = context.matchBefore(/(?<=\s)#[\p{L}\p{N}_/-]*$/u);
    if (!before) return null;
    const from = before.from + before.text.indexOf("#") + 1;
    const query = context.state.sliceDoc(from, context.pos);
    const tags = getTags().filter((tag) => !query || tag.toLowerCase().includes(query.toLowerCase()));
    if (!tags.length) return null;
    return {
      from,
      options: tags.slice(0, 20).map((tag) => ({ label: tag, type: "keyword", detail: "标签" })),
      validFor: /^[\p{L}\p{N}_/-]*$/u,
    };
  };
}

/** Headings of the current note, offered when the line starts with `#`. */
export function headingCompletion(getHeadings: () => string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/(?:^|\s)\[\[?$/);
    if (!before) return null;
    void getHeadings;
    return null;
  };
}
