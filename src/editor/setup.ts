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
import { markdownCommands, setHeading, toggleLinePrefix } from "./commands";
import { slashCompletion, tagCompletion, wikiCompletion } from "./completion";
import { livePreviewField } from "./livePreview";
import { markdownSupport } from "./markdown";
import { linkClickHandler, mediaHandlers } from "./media";
import { editorSettingsField, type EditorSettings } from "./settings";
import { editorTheme } from "./theme";

export interface EditorHooks {
  settings: Partial<EditorSettings>;
  getTitles(): string[];
  getTags(): string[];
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

/** Keeps the caret vertically centred — the iA-Writer-style typewriter mode. */
const typewriterScroll = ViewPlugin.fromClass(
  class {
    private frame: number | null = null;

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      const settings = update.state.field(editorSettingsField, false);
      if (!settings?.typewriter) return;
      const head = update.state.selection.main.head;
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (!update.view.dom.isConnected) return;
        update.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
      });
    }

    destroy() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    }
  },
);

/** Lets the host toggle spellcheck without rebuilding the editor. */
export const spellcheckCompartment = new Compartment();

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
