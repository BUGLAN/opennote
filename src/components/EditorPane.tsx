import { useEffect, useRef, type ReactNode } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { imageUrlStore } from "../data/assets";
import type { Id, UiSettings } from "../data/types";
import { editorSettingsField, refreshDecorations, setEditorSettings, type EditorSettings } from "../editor/settings";
import { buildEditorExtensions, spellcheckCompartment } from "../editor/setup";
import { notify } from "../lib/toast";
import { cn } from "../lib/utils";

export interface CursorInfo {
  line: number;
  column: number;
  selected: number;
}

interface EditorPaneProps {
  noteId: Id | null;
  content: string;
  hidden: boolean;
  baseDir: string;
  settings: UiSettings;
  onDocChange(doc: string): void;
  onCursor(info: CursorInfo): void;
  onSave(): void;
  onReady(view: EditorView | null): void;
  getTitles(): string[];
  getTags(): string[];
}

/**
 * One CodeMirror instance for the whole session; switching notes swaps the
 * document (with history annotations so undo never leaks across notes).
 */
export function EditorPane(props: EditorPaneProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const loadedRef = useRef<Id | null>(null);
  const expectedRef = useRef<string>("");
  const cursorMemory = useRef(new Map<Id, number>());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: buildEditorExtensions({
          settings: { ...propsRef.current.settings },
          getTitles: () => propsRef.current.getTitles(),
          getTags: () => propsRef.current.getTags(),
          onChange: (doc) => {
            expectedRef.current = doc;
            propsRef.current.onDocChange(doc);
          },
          onCursor: (info) => propsRef.current.onCursor(info),
          onSave: () => propsRef.current.onSave(),
          notify: (message) => notify(message),
          imageMode: () => propsRef.current.settings.imageMode,
        }),
      }),
    });
    viewRef.current = view;
    if (import.meta.env.DEV) {
      // handy for debugging the live-preview tree from the console
      (window as unknown as Record<string, unknown>).__opennote = {
        view,
        settings: () => view.state.field(editorSettingsField, false),
        apply: (patch: Partial<EditorSettings>) => view.dispatch({ effects: setEditorSettings.of(patch) }),
        dump: () => {
          const lines: string[] = [];
          syntaxTree(view.state).iterate({
            enter: (node) => {
              lines.push(
                `${node.name} ${node.from}-${node.to} ${JSON.stringify(view.state.sliceDoc(node.from, Math.min(node.to, node.from + 40)))}`,
              );
            },
          });
          return lines.join("\n");
        },
      };
    }
    propsRef.current.onReady(view);
    return () => {
      view.destroy();
      viewRef.current = null;
      propsRef.current.onReady(null);
    };
  }, []);

  /* swap the document when the active note changes */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = loadedRef.current;

    if (props.noteId === null) {
      loadedRef.current = null;
      expectedRef.current = "";
      if (view.state.doc.length) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
          annotations: Transaction.addToHistory.of(false),
        });
      }
      return;
    }

    if (previous === props.noteId) {
      // content changed outside the editor (snapshot restore, import, sync)
      if (props.content !== expectedRef.current && props.content !== view.state.doc.toString()) {
        expectedRef.current = props.content;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: props.content },
          annotations: Transaction.addToHistory.of(false),
        });
      }
      return;
    }

    if (previous) cursorMemory.current.set(previous, view.state.selection.main.head);
    loadedRef.current = props.noteId;
    expectedRef.current = props.content;
    const anchor = Math.min(cursorMemory.current.get(props.noteId) ?? 0, props.content.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.content },
      selection: { anchor, head: anchor },
      effects: EditorView.scrollIntoView(0, { y: "start" }),
      annotations: Transaction.addToHistory.of(false),
    });
    view.focus();
  }, [props.noteId, props.content]);

  /* push appearance / mode settings into the editor state */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setEditorSettings.of({
        theme: props.settings.theme,
        appearance: props.settings.appearance,
        focus: props.settings.focus,
        typewriter: props.settings.typewriter,
        imageMode: props.settings.imageMode,
        baseDir: props.baseDir,
      }),
    });
  }, [
    props.settings.theme,
    props.settings.appearance,
    props.settings.focus,
    props.settings.typewriter,
    props.settings.imageMode,
    props.baseDir,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: spellcheckCompartment.reconfigure(
        EditorView.contentAttributes.of({
          spellcheck: String(props.settings.spellcheck),
          autocapitalize: "off",
          "data-placeholder": "开始写下这一刻…",
        }),
      ),
    });
  }, [props.settings.spellcheck]);

  /* images resolve lazily from disk — redraw the document when they arrive */
  useEffect(() => {
    return imageUrlStore.subscribe(() => {
      const view = viewRef.current;
      if (view) view.dispatch({ effects: refreshDecorations.of(null) });
    });
  }, []);

  /* the editor stays mounted while no note is open (keeps undo history), so it
     has to be re-measured when it becomes visible again */
  useEffect(() => {
    if (props.hidden) return;
    const view = viewRef.current;
    if (!view) return;
    requestAnimationFrame(() => view.requestMeasure());
  }, [props.hidden]);

  return (
    <div
      className={cn(
        "editor-host",
        props.hidden && "editor-host--hidden",
        props.settings.typewriter && "md-typewriter",
        props.settings.focus && "md-focus-mode",
        props.content === "" && "md-empty",
      )}
      ref={hostRef}
    />
  );
}
