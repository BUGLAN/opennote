import { Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import type { ThemeId } from "../data/types";

/** Options the editor field needs that live outside CodeMirror's document state. */
export interface EditorSettings {
  theme: ThemeId;
  appearance: "light" | "dark";
  focus: boolean;
  typewriter: boolean;
  imageMode: "asset" | "inline";
  spellcheck: boolean;
  /** Folder of the note being edited — relative image paths resolve against it. */
  baseDir: string;
}

export const defaultEditorSettings: EditorSettings = {
  theme: "paper",
  appearance: "light",
  focus: false,
  typewriter: false,
  imageMode: "asset",
  spellcheck: true,
  baseDir: "",
};

export const setEditorSettings = StateEffect.define<Partial<EditorSettings>>();
/** Force one decoration rebuild (used after lazy assets or diagrams resolve). */
export const refreshDecorations = StateEffect.define<null>();

export const editorSettingsFacet = Facet.define<EditorSettings, EditorSettings>({
  combine: (values) => values[0] ?? defaultEditorSettings,
});

export const editorSettingsField: StateField<EditorSettings> = StateField.define<EditorSettings>({
  create: (state) => state.facet(editorSettingsFacet),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setEditorSettings)) next = { ...next, ...effect.value };
    }
    // If the facet itself was reconfigured, its values win — but never let the
    // facet default clobber settings applied through effects.
    const before = tr.startState.facet(editorSettingsFacet);
    const after = tr.state.facet(editorSettingsFacet);
    if (before !== after) next = { ...after, ...next };
    return next;
  },
});

export function editorSettings(settings: Partial<EditorSettings>): Extension {
  return [editorSettingsFacet.of({ ...defaultEditorSettings, ...settings }), editorSettingsField];
}
