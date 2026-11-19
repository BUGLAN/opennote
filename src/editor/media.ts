import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { EditorView } from "@codemirror/view";
import { StateEffect, StateField, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { imageNameForPaste } from "../data/assets";
import { saveImage } from "../data/library";
import { parentPath } from "../fs/paths";
import { resolveWorkspacePath } from "../fs/workspaceRef";
import { blobToDataUrl } from "../lib/utils";
import { bridge } from "./bridge";
import { rememberSourceSize } from "./imagePool";
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
        if (isImage) await rememberSizeFor(dataUrl, file);
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
      if (isImage) await rememberSizeFor(saved.markdown, file);
      snippets.push(isImage ? `![${file.name || "图片"}](${saved.markdown})` : `[${file.name}](${saved.markdown})`);
    } catch (error) {
      console.error("[opennote] 附件保存失败", error);
      options.notify(`附件保存失败：${file.name}`);
    }
  }
  return snippets;
}

/**
 * 把一张待插入图片的**像素尺寸**按它在 markdown 里的引用串记下来。
 *
 * 为什么必须在这里做：`imagePool` 的尺寸表是**加载之后**才填的，救不了「第一次插入」——
 * 粘贴一张新图，从没加载过 ⇒ 没有尺寸 ⇒ widget 先塌成 0、解码完再把下方内容推下去。
 * 而粘贴这一刻 `File` 就在手里，尺寸当场可量；在 `view.dispatch()` **之前**记好，
 * widget 建出来的第一帧就已经是最终高度的盒子。
 *
 * 量不出来（不是图片、浏览器不支持、文件损坏）就安静跳过：这只是提前占位，
 * 失败就退回原来的「解码完成再撑开」路径，不该让粘贴本身失败。
 */
async function rememberSizeFor(src: string, file: File): Promise<void> {
  const size = await readImageSize(file);
  if (size) rememberSourceSize(src, size.width, size.height);
}

/** 读一张图片的像素尺寸。任何失败都返回 `null`，绝不抛 —— 调用方只拿它做提前占位。 */
async function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      if (size.width > 0 && size.height > 0) return size;
    } catch {
      // 落到下面的 <img> 兜底
    }
  }
  // node（单测）里没有 `Image`：这一支直接返回 null，粘贴链路照旧只做落盘。
  if (typeof Image !== "function" || typeof URL?.createObjectURL !== "function") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = objectUrl;
    });
    return img.naturalWidth > 0 && img.naturalHeight > 0
      ? { width: img.naturalWidth, height: img.naturalHeight }
      : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* ------------------------------------------------------------ 插入位置跟踪 */

interface AttachmentInsertRange {
  from: number;
  to: number;
}

/**
 * 附件落盘是异步的：读文件、写盘、量尺寸都可能耗时。用户在这段时间里继续编辑时，原先记下的
 * 绝对位置早已失效。这里把待插入的 `[from, to)` 登记进文档状态，让 CodeMirror 每次改动都替
 * 我们映射它；附件回来后再从这个映射后的区间插入（有选区就替换选区）。
 */
export const trackAttachmentInsertion = StateEffect.define<{ id: number; from: number; to: number }>();
const untrackAttachmentInsertion = StateEffect.define<number>();

export const pendingAttachmentInsertions = StateField.define<ReadonlyMap<number, AttachmentInsertRange>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) {
      const mapped = new Map<number, AttachmentInsertRange>();
      for (const [id, range] of value) {
        // 两端都用 -1：用户在插入点或选区边缘继续输入时，新输入的字属于用户，不能被稍后回来的
        // 附件吞掉。这也是「光标没动」判据能区分「还在原位」与「刚在这里打了字」的关键。
        const from = tr.changes.mapPos(range.from, -1);
        mapped.set(id, { from, to: Math.max(from, tr.changes.mapPos(range.to, -1)) });
      }
      next = mapped;
    }
    for (const effect of tr.effects) {
      if (effect.is(trackAttachmentInsertion)) {
        const tracked = new Map(next);
        tracked.set(effect.value.id, {
          from: effect.value.from,
          to: effect.value.to,
        });
        next = tracked;
      } else if (effect.is(untrackAttachmentInsertion) && next.has(effect.value)) {
        next = new Map(next);
        (next as Map<number, AttachmentInsertRange>).delete(effect.value);
      }
    }
    return next;
  },
});

let nextAttachmentInsertionId = 1;

/**
 * 附件落盘完成后的插入事务。区间来自 `pendingAttachmentInsertions`，已经跟随等待期间的编辑
 * 移动过；这里只负责替换它并移除登记。
 *
 * 只有当前主选区仍等于映射后的原选区，才把光标放到附件后面。用户已经移动光标或继续输入时
 * 不传 `selection`，交给 CodeMirror 映射当前选区，避免把光标拽走。
 */
export function attachmentInsertion(
  state: EditorState,
  id: number,
  snippets: string[],
): TransactionSpec | null {
  const pending = state.field(pendingAttachmentInsertions, false)?.get(id);
  if (!pending || !snippets.length) return null;
  const start = Math.min(pending.from, state.doc.length);
  const end = Math.min(Math.max(start, pending.to), state.doc.length);
  const text = `${snippets.join("\n")}\n`;
  const main = state.selection.main;
  const cursorUntouched = main.from === start && main.to === end;
  return {
    changes: { from: start, to: end, insert: text },
    ...(cursorUntouched ? { selection: { anchor: start + text.length } } : {}),
    effects: untrackAttachmentInsertion.of(id),
  };
}

/**
 * 剪贴板同时给了纯文字和文件时，Office/WPS 常把选中的文字另做一张 PNG 放进来。纯文字且
 * 没有 `Files` 类型时交还默认文字粘贴；有 `Files` 时仍按附件处理。
 */
export function shouldUseNativeTextPaste(types: readonly string[], plainText: string): boolean {
  return plainText.length > 0 && !types.includes("Files");
}

export function mediaHandlers(options: {
  imageMode: () => "asset" | "inline";
  notify: (message: string) => void;
}): Extension {
  const insertFiles = async (view: EditorView, files: File[], from: number, to: number) => {
    const notePath = view.state.field(editorSettingsField, false)?.notePath ?? "";
    const id = nextAttachmentInsertionId++;
    view.dispatch({ effects: trackAttachmentInsertion.of({ id, from, to }) });
    const snippets = await insertFileSnippets(files, {
      notePath,
      imageMode: options.imageMode(),
      notify: options.notify,
    });
    // 视图可能在落盘期间被销毁（关标签）：状态随之消失，什么都不插。
    if (!view.dom.isConnected) return;
    if (!snippets.length) {
      view.dispatch({ effects: untrackAttachmentInsertion.of(id) });
      return;
    }
    const insertion = attachmentInsertion(view.state, id, snippets);
    if (!insertion) return;
    view.dispatch({ ...insertion, userEvent: "input.paste", scrollIntoView: true });
    options.notify(files.length > 1 ? `已插入 ${files.length} 个附件` : "已插入附件");
  };

  return [
    pendingAttachmentInsertions,
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const data = event.clipboardData;
        if (!data) return false;
        if (shouldUseNativeTextPaste(Array.from(data.types), data.getData("text/plain"))) return false;
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
        const { from, to } = view.state.selection.main;
        void insertFiles(view, files, from, to);
        return true;
      },
      drop: (event, view) => {
        const data = event.dataTransfer;
        if (!data?.files?.length) return false;
        event.preventDefault();
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
        void insertFiles(view, Array.from(data.files), position, position);
        return true;
      },
      dragover: (event) => {
        if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
        return false;
      },
    }),
  ];
}

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "local"; path: string };

/** Cmd/Ctrl-click follows a link without leaving the writing surface. */
export function linkClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".md-wikilink, a")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const link = findLinkAt(view.state, pos);
      if (!link) return false;
      event.preventDefault();
      if (link.kind === "local") bridge.openLocalLink(link.path);
      else bridge.openExternal(link.url);
      return true;
    },
  });
}

/** Blocks whose text is code, not prose — URLs inside them are not links. */
const CODE_NODES = /^(?:InlineCode|FencedCode|CodeBlock)$/;

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function classifyLink(raw: string, notePath: string): LinkTarget | null {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!value || value.startsWith("#")) return null;
  if (/^https?:\/\//i.test(value) || URL_SCHEME.test(value)) {
    return { kind: "external", url: value };
  }
  if (/^www\./i.test(value)) return { kind: "external", url: `https://${value}` };
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  const path = resolveWorkspacePath(decoded, parentPath(notePath));
  return path ? { kind: "local", path } : null;
}

/**
 * The typed link target under `pos`, or null when there is nothing to open
 * there. The syntax tree decides first — it knows a link's own URL, and it
 * knows that a URL inside inline code or a fenced block is just text. A scan of
 * the line covers raw autolinks and bare URLs the tree does not mark up.
 */
export function findLinkAt(state: EditorState, pos: number): LinkTarget | null {
  const notePath = state.field(editorSettingsField, false)?.notePath ?? "";
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
    if (raw) return classifyLink(raw, notePath);
  }

  const line = state.doc.lineAt(pos);
  const text = state.sliceDoc(line.from, line.to);
  const offset = pos - line.from;
  const patterns = [
    /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g,
    /<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi,
    /([a-z][a-z0-9+.-]*:[^\s)]+)/gi,
    /(www\.[^\s)]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        const url = match[1] ?? match[0];
        return classifyLink(url, notePath);
      }
    }
  }
  return null;
}
