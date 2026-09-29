import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { defaultEditorSettings, editorSettings, editorSettingsField, setEditorSettings } from "./settings";

function makeState() {
  return EditorState.create({ extensions: [editorSettings({ theme: "night", appearance: "dark" })] });
}

describe("editorSettingsField", () => {
  it("starts from the configured facet", () => {
    const state = makeState();
    expect(state.field(editorSettingsField)).toMatchObject({ theme: "night", appearance: "dark" });
  });

  it("applies an effect", () => {
    const state = makeState().update({ effects: setEditorSettings.of({ typewriter: true }) }).state;
    expect(state.field(editorSettingsField).typewriter).toBe(true);
  });

  it("keeps earlier effects when a later one arrives", () => {
    const first = makeState().update({ effects: setEditorSettings.of({ typewriter: true, theme: "ink" }) }).state;
    const second = first.update({ effects: setEditorSettings.of({ focus: true }) }).state;
    expect(second.field(editorSettingsField)).toMatchObject({
      typewriter: true,
      focus: true,
      theme: "ink",
    });
  });

  it("survives unrelated transactions", () => {
    const first = makeState().update({ effects: setEditorSettings.of({ typewriter: true }) }).state;
    const second = first.update({ changes: { from: 0, insert: "x" } }).state;
    const third = second.update({ selection: { anchor: 1 } }).state;
    expect(third.field(editorSettingsField).typewriter).toBe(true);
  });

  it("can turn a mode off again", () => {
    const on = makeState().update({ effects: setEditorSettings.of({ focus: true }) }).state;
    const off = on.update({ effects: setEditorSettings.of({ focus: false }) }).state;
    expect(off.field(editorSettingsField).focus).toBe(false);
    expect(off.field(editorSettingsField).theme).toBe("night");
  });

  it("never leaks the defaults over applied values", () => {
    let state = makeState();
    for (let i = 0; i < 5; i += 1) {
      state = state.update({ effects: setEditorSettings.of({ imageMode: "inline", spellcheck: false }) }).state;
    }
    expect(state.field(editorSettingsField)).toMatchObject({ imageMode: "inline", spellcheck: false });
    expect(state.field(editorSettingsField).theme).not.toBe(defaultEditorSettings.theme);
  });
});
