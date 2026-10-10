import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { blockPad } from "./blockPad";
import { markdownCommands, setHeading, toggleLinePrefix } from "./commands";
import { slashCompletion, tagCompletion, wikiCompletion } from "./completion";
import { livePreviewField } from "./livePreview";
import { markdownSupport } from "./markdown";
import { linkClickHandler, mediaHandlers } from "./media";
import { editorSettingsField, type EditorSettings } from "./settings";
import { editorTheme } from "./theme";
import { unwrapKeymap } from "./unwrap";

export interface EditorHooks {
  settings: Partial<EditorSettings>;
  getTitles(): string[];
  getTags(): string[];
  /** 只读锁（标签栏）。构建时读一次，之后由 EditorPane 经 `readOnlyCompartment` 切换。 */
  readOnly(): boolean;
  onChange(doc: string): void;
  onCursor(info: { line: number; column: number; selected: number }): void;
  onSave(): void;
  notify(message: string): void;
  imageMode(): "asset" | "inline";
}

function runSlashCommand(id: string, view: EditorView): void {
  if (id === "date") {
    const now = new Date();
    const text = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    view.dispatch({
      changes: { from: view.state.selection.main.from, insert: text },
      userEvent: "input.format",
    });
    view.focus();
    return;
  }
  const command = markdownCommands[id];
  if (command) command(view);
}

/**
 * 视口上下各多少比例算「边缘」。光标落在中间这段安全带里就不去动滚动。
 * 0.25 表示中间 50% 是安全带。
 */
const TYPEWRITER_EDGE_BAND = 0.25;

/**
 * Keeps the caret vertically centred — the iA-Writer-style typewriter mode.
 *
 * 只在光标**真的接近视口边缘**时才把它拉回中间。
 *
 * 原来每次选区/文档变化都无条件派发一个 `scrollIntoView`，有两个代价：
 *   1. 它持续重置 CodeMirror 自己的滚动锚定 —— `measure()` 里一旦有待处理的
 *      `scrollTarget` 就**放弃补偿**（见 `@codemirror/view` 的 measure 循环），
 *      于是任何装饰引起的高度变化都不会被兜住；
 *   2. 每敲一个字都多一次事务 + 一帧 rAF。
 *
 * 「光标居中」与「位置绝对稳定」本来就互相冲突：iA Writer 的官方支持页里，
 * 这一节的标题就叫 **"Jumping Screen When Editing?"**，并建议编辑阶段关掉该模式。
 * 这里取折中 —— 保住打字机的观感，同时不再每敲一个字就和滚动锚定打架。
 */
const typewriterScroll = ViewPlugin.fromClass(
  class {
    private frame: number | null = null;

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      const settings = update.state.field(editorSettingsField, false);
      if (!settings?.typewriter) return;
      const view = update.view;
      const head = update.state.selection.main.head;
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (!view.dom.isConnected) return;
        // 光标仍在中央安全带里 ⇒ 什么都不做。这一步就是「别去抢滚动锚定」。
        const coords = view.coordsAtPos(head);
        if (!coords) return;
        const scroller = view.scrollDOM.getBoundingClientRect();
        if (scroller.height <= 0) return;
        const relative = (coords.top - scroller.top) / scroller.height;
        if (relative >= TYPEWRITER_EDGE_BAND && relative <= 1 - TYPEWRITER_EDGE_BAND) return;
        view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
      });
    }

    destroy() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    }
  },
);

/** Lets the host toggle spellcheck without rebuilding the editor. */
export const spellcheckCompartment = new Compartment();

/**
 * 只读锁（0.4.0 标签栏的锁按钮）：`EditorState.readOnly` 挡住一切改动事务，
 * `EditorView.editable:false` 连光标都不显示 —— 是「查看」而不是「待输入」。
 * 用 Compartment 切换，不重建编辑器（切笔记的 undo 历史得以保留）。
 */
export const readOnlyCompartment = new Compartment();

export function readOnlyExtensions(locked: boolean): Extension {
  return readOnlyCompartment.of([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]);
}

function contentAttributes(spellcheck: boolean): Extension {
  return spellcheckCompartment.of(
    EditorView.contentAttributes.of({
      spellcheck: String(spellcheck),
      autocapitalize: "off",
      "data-placeholder": "开始写下这一刻…",
    }),
  );
}

export function buildEditorExtensions(hooks: EditorHooks): Extension[] {
  const customKeys = [
    { key: "Mod-b", run: markdownCommands.bold, preventDefault: true },
    { key: "Mod-i", run: markdownCommands.italic, preventDefault: true },
    { key: "Mod-e", run: markdownCommands.inlineCode, preventDefault: true },
    { key: "Mod-Shift-k", run: markdownCommands.link, preventDefault: true },
    { key: "Mod-Shift-x", run: markdownCommands.strike, preventDefault: true },
    { key: "Mod-Shift-h", run: markdownCommands.highlight, preventDefault: true },
    { key: "Mod-Shift-q", run: toggleLinePrefix("quote"), preventDefault: true },
    { key: "Mod-Shift-c", run: markdownCommands.codeBlock, preventDefault: true },
    { key: "Mod-Shift-t", run: markdownCommands.table, preventDefault: true },
    { key: "Mod-Shift-m", run: markdownCommands.mathBlock, preventDefault: true },
    { key: "Mod-Shift-g", run: markdownCommands.mermaid, preventDefault: true },
    { key: "Mod-Shift-7", run: toggleLinePrefix("ordered"), preventDefault: true },
    { key: "Mod-Shift-8", run: toggleLinePrefix("bullet"), preventDefault: true },
    { key: "Mod-Shift-9", run: toggleLinePrefix("task"), preventDefault: true },
    { key: "Mod-1", run: setHeading(1), preventDefault: true },
    { key: "Mod-2", run: setHeading(2), preventDefault: true },
    { key: "Mod-3", run: setHeading(3), preventDefault: true },
    { key: "Mod-4", run: setHeading(4), preventDefault: true },
    { key: "Mod-5", run: setHeading(5), preventDefault: true },
    { key: "Mod-6", run: setHeading(6), preventDefault: true },
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        hooks.onSave();
        return true;
      },
    },
  ];

  return [
    editorTheme(),
    livePreviewField,
    // 块级内容换形态时把高度差补成留白（见 `blockPad.ts`）—— 必须在 livePreviewField 之后。
    blockPad,
    markdownSupport,
    history(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    closeBrackets(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    readOnlyExtensions(hooks.readOnly()),
    contentAttributes(hooks.settings.spellcheck ?? true),
    editorSettingsField,
    autocompletion({
      override: [
        slashCompletion(runSlashCommand),
        wikiCompletion(hooks.getTitles),
        tagCompletion(hooks.getTags),
      ],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
      maxRenderedOptions: 24,
    }),
    mediaHandlers({ imageMode: hooks.imageMode, notify: hooks.notify }),
    linkClickHandler(),
    typewriterScroll,
    // 「光标停在边界按删除 ⇒ 先拆开这一段」——必须排在 defaultKeymap 之前抢下 Backspace/Delete。
    unwrapKeymap,
    keymap.of([
      ...customKeys,
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) hooks.onChange(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main;
        const line = update.state.doc.lineAt(range.head);
        hooks.onCursor({
          line: line.number,
          column: range.head - line.from + 1,
          selected: range.to - range.from,
        });
      }
    }),
  ];
}
