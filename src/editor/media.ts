import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { EditorView } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { imageNameForPaste } from "../data/assets";
import { saveImage } from "../data/library";
import { blobToDataUrl } from "../lib/utils";
import { editorSettingsField } from "./settings";

/**
 * Screenshots and dragged files become real files: pasted images are written into
 * the note's own `<note name>.assets/` directory and referenced with a relative
 * markdown path, so the folder stays portable and the images follow the note when
 * it is moved. Users who prefer a single self-contained file can switch to inline
 * data URLs in settings.
 *
 * 落点按**笔记名**派生 ⇒ 这里要的是**笔记路径**（`editorSettingsField.notePath`）。
 * 曾经传的是 `baseDir`（笔记所在目录）：两个参数都是 `string`，类型检查一个字都拦不住，
 * 图片于是被写进了 `未命名.assets/`（`assetsDirFor("")` 的产物），而且不报错。
 *
 * `src/lib/import.ts` 的两条**旧布局/无归属**路径（zip 导入、单独导入一张图片）仍写公共
 * `<目录>/assets/`，那是「没有笔记可跟」的例外，与本文件的粘贴/拖拽路径无关 —— 这里写的
 * 一定是**当前笔记自己的** `<笔记名>.assets/`。
 */
export interface AttachmentOptions {
  /** 最终笔记路径（`归档/foo 2.md`）；空串 = 没有打开的笔记，此时**不猜**，如实提示。 */
  notePath: string;
  imageMode: "asset" | "inline";
  notify: (message: string) => void;
}

/**
 * 把一批附件落盘并生成要插入的 markdown 片段。
 *
 * 与 CodeMirror 视图无关（只要一个笔记路径 + 磁盘后端），所以粘贴/拖拽这条链路可以在单测里
 * 直接跑，不需要 DOM；插入位置与选区仍由 `mediaHandlers` 负责。
 */
export async function insertFileSnippets(files: File[], options: AttachmentOptions): Promise<string[]> {
  const snippets: string[] = [];
  let reportedNoNote = false;
  for (const file of files) {
    const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name);
    try {
      if (options.imageMode === "inline") {
        const dataUrl = await blobToDataUrl(file);
        snippets.push(isImage ? `![${file.name}](${dataUrl})` : `[${file.name}](${dataUrl})`);
        continue;
      }
      // 没有笔记就没有「笔记名」可派生：不编一个名字糊过去，也不偷偷退回公共 assets/。
      if (!options.notePath) {
        if (!reportedNoNote) {
          reportedNoNote = true;
          options.notify("还没有打开笔记，附件没有落点");
        }
        continue;
      }
      const saved = await saveImage(file, file.name || imageNameForPaste(file), options.notePath);
      snippets.push(isImage ? `![${file.name || "图片"}](${saved.markdown})` : `[${file.name}](${saved.markdown})`);
    } catch (error) {
      console.error("[opennote] 附件保存失败", error);
      options.notify(`附件保存失败：${file.name}`);
    }
  }
  return snippets;
}

export function mediaHandlers(options: {
  imageMode: () => "asset" | "inline";
  notify: (message: string) => void;
}): Extension {
  const insertFiles = async (view: EditorView, files: File[], at: number) => {
    const notePath = view.state.field(editorSettingsField, false)?.notePath ?? "";
    const snippets = await insertFileSnippets(files, {
      notePath,
      imageMode: options.imageMode(),
      notify: options.notify,
    });
    if (!snippets.length) return;
    const text = snippets.join("\n");
    const pos = Math.min(at, view.state.doc.length);
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    options.notify(files.length > 1 ? `已插入 ${files.length} 个附件` : "已插入附件");
  };

  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const data = event.clipboardData;
      if (!data) return false;
      const files: File[] = [];
      for (const item of Array.from(data.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (!files.length) {
        const dropped = Array.from(data.files ?? []);
        files.push(...dropped);
      }
      if (!files.length) return false;
      event.preventDefault();
      const at = view.state.selection.main.from;
      void insertFiles(view, files, at);
      return true;
    },
    drop: (event, view) => {
      const data = event.dataTransfer;
      if (!data?.files?.length) return false;
      event.preventDefault();
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
      void insertFiles(view, Array.from(data.files), position);
      return true;
    },
    dragover: (event) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
      return false;
    },
  });
}

/** Cmd/Ctrl-click follows a link without leaving the writing surface. */
export function linkClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".md-wikilink, a")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const url = findLinkAt(view.state, pos);
      if (!url) return false;
      event.preventDefault();
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    },
  });
}

/** Blocks whose text is code, not prose — URLs inside them are not links. */
const CODE_NODES = /^(?:InlineCode|FencedCode|CodeBlock)$/;

function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * The URL under `pos`, or null when there is nothing to open there. The syntax
 * tree decides first — it knows a link's own URL, and it knows that a URL inside
 * inline code or a fenced block is just text. A scan of the line covers raw
 * autolinks and bare URLs the tree does not mark up.
 */
export function findLinkAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  const inner = tree.resolveInner(pos, 1);
  for (let node: SyntaxNode | null = inner; node; node = node.parent) {
    if (CODE_NODES.test(node.name)) return null;
  }
  for (let node: SyntaxNode | null = inner; node; node = node.parent) {
    if (node.name !== "Link" && node.name !== "Image") continue;
    const url = node.getChild("URL");
    if (!url) continue;
    const raw = state.sliceDoc(url.from, url.to);
    if (raw) return normalizeUrl(raw);
  }

  const line = state.doc.lineAt(pos);
  const text = state.sliceDoc(line.from, line.to);
  const offset = pos - line.from;
  const patterns = [/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, /<(https?:\/\/[^>\s]+)>/g, /(https?:\/\/[^\s)]+)/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        const url = match[1] ?? match[0];
        return normalizeUrl(url);
      }
    }
  }
  return null;
}
