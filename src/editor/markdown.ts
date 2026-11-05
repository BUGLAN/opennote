import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { opennoteMarkdown } from "./mdExtensions";

export const markdownSupport = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: opennoteMarkdown,
  addKeymap: true,
});

/**
 * front matter 的增量解析补丁（审查报告 B5c）。
 *
 * 「文件头是不是 front matter」取决于**后面某一行**（收尾的 `---`）。lezer 的增量解析会复用
 * 没被改动的开头那块 —— 在 2KB 之外补上收尾的 `---`，开头仍按旧树当分隔线，与全量解析、
 * 与阅读视图都对不上（显示取决于编辑历史）。
 *
 * 所以：文件以 `---` 开头、且这次改动碰到了一行「像围栏」的内容（增删了 `-` 或换行）时，
 * 顺手把开头那三个字符「原样替换」一次 —— 文本不变，但解析器认为开头被改过，第一块重新解析。
 */
const FENCE_TOUCH = /-|\n/;
export const frontMatterReparse = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const doc = tr.newDoc;
  if (doc.length < 4) return tr;
  const head = doc.sliceString(0, 4).replace(/^\uFEFF/, "");
  if (!head.startsWith("---")) return tr;
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    if (fromB < 3) return; // 开头本身被改过，解析器自己就会重来
    if (FENCE_TOUCH.test(inserted.toString()) || FENCE_TOUCH.test(tr.startState.sliceDoc(fromA, toA))) touched = true;
  });
  if (!touched) return tr;
  const offset = doc.sliceString(0, 1) === "\uFEFF" ? 1 : 0;
  return [tr, { changes: { from: offset, to: offset + 3, insert: "---" }, sequential: true }];
});
