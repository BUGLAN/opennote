import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { imageNameForPaste } from "../data/assets";
import { saveImage } from "../data/library";
import { blobToDataUrl } from "../lib/utils";
import { editorSettingsField } from "./settings";

/**
 * Screenshots and dragged files become real files: pasted images are written
 * next to the note (`<note dir>/assets/…`) and referenced with a relative
 * markdown path, so the folder stays portable. Users who prefer a single
 * self-contained file can switch to inline data URLs in settings.
 */
export function mediaHandlers(options: {
  imageMode: () => "asset" | "inline";
  notify: (message: string) => void;
}): Extension {
  const insertFiles = async (view: EditorView, files: File[], at: number) => {
    const baseDir = view.state.field(editorSettingsField, false)?.baseDir ?? "";
    const snippets: string[] = [];
    for (const file of files) {
      const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name);
      try {
        if (options.imageMode() === "inline") {
          const dataUrl = await blobToDataUrl(file);
          snippets.push(isImage ? `![${file.name}](${dataUrl})` : `[${file.name}](${dataUrl})`);
          continue;
        }
        const saved = await saveImage(file, file.name || imageNameForPaste(file), baseDir);
        snippets.push(isImage ? `![${file.name || "图片"}](${saved.markdown})` : `[${file.name}](${saved.markdown})`);
      } catch (error) {
        console.error("[opennote] 附件保存失败", error);
        options.notify(`附件保存失败：${file.name}`);
      }
    }
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
      const url = findLinkAt(view, pos);
      if (!url) return false;
      event.preventDefault();
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    },
  });
}

function findLinkAt(view: EditorView, pos: number): string | null {
  const state = view.state;
  const line = state.doc.lineAt(pos);
  // Prefer the syntax tree, fall back to a scan of the line for raw autolinks.
  const text = state.sliceDoc(line.from, line.to);
  const offset = pos - line.from;
  const patterns = [/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, /<(https?:\/\/[^>\s]+)>/g, /(https?:\/\/[^\s)]+)/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        const url = match[1] ?? match[0];
        return /^https?:\/\//i.test(url) ? url : `https://${url}`;
      }
    }
  }
  return null;
}
