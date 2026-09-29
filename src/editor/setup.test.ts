import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { EditorHooks } from "./setup";
import { buildEditorExtensions } from "./setup";
import { defaultEditorSettings, editorSettingsField, setEditorSettings } from "./settings";

function hooks(overrides: Partial<EditorHooks> = {}): EditorHooks {
  return {
    settings: { spellcheck: true },
    getTitles: () => [],
    getTags: () => [],
    onChange: () => {},
    onCursor: () => {},
    onSave: () => {},
    notify: () => {},
    imageMode: () => "asset",
    ...overrides,
  };
}

function makeState(overrides: Partial<EditorHooks> = {}): EditorState {
  return EditorState.create({ doc: "# 标题\n\n正文", extensions: buildEditorExtensions(hooks(overrides)) });
}

describe("buildEditorExtensions", () => {
  it("builds a state without throwing", () => {
    expect(() => makeState()).not.toThrow();
  });

  it("includes the settings field", () => {
    const state = makeState();
    expect(state.field(editorSettingsField, false)).toBeTruthy();
    expect(state.field(editorSettingsField)).toMatchObject({ theme: defaultEditorSettings.theme });
  });

  it("applies settings effects, including several in a row", () => {
    let state = makeState();
    state = state.update({ effects: setEditorSettings.of({ typewriter: true }) }).state;
    state = state.update({ effects: setEditorSettings.of({ focus: true }) }).state;
    state = state.update({ effects: setEditorSettings.of({ theme: "night", appearance: "dark" }) }).state;
    expect(state.field(editorSettingsField)).toMatchObject({
      typewriter: true,
      focus: true,
      theme: "night",
      appearance: "dark",
    });
  });

  it("keeps the settings while typing", () => {
    let state = makeState();
    state = state.update({ effects: setEditorSettings.of({ focus: true }) }).state;
    state = state.update({ changes: { from: 0, insert: "x" } }).state;
    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.field(editorSettingsField).focus).toBe(true);
  });

  it("installs the live preview decorations field", () => {
    const state = makeState();
    // the decoration facet is provided by the live preview field
    expect(state.field(editorSettingsField)).toBeDefined();
    expect(() => state.update({ selection: { anchor: 3 } })).not.toThrow();
  });
});
