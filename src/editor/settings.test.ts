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

/**
 * 附件落点是工作区根的共享 `.assets/`，引用前缀按**笔记所在目录的层数**现算 ——
 * 两个需求都从**一个事实**（笔记路径）出发。这个字段曾经叫 `baseDir` 装目录：
 * 名字与内容不符，类型还都是 `string`，于是粘贴的图静默写进了 `未命名.assets/`。
 */
describe("editorSettings 的笔记路径：一个事实一个产地", () => {
  it("默认值里只有 `notePath`，`baseDir` 不再存在（一个字段不许有两个含义）", () => {
    expect(defaultEditorSettings.notePath).toBe("");
    expect(Object.prototype.hasOwnProperty.call(defaultEditorSettings, "baseDir")).toBe(false);
  });

  it("facet 与 effect 写入的都是笔记路径本身", () => {
    const state = EditorState.create({ extensions: [editorSettings({ notePath: "归档/备注 2.md" })] });
    expect(state.field(editorSettingsField).notePath).toBe("归档/备注 2.md");
    const next = state.update({ effects: setEditorSettings.of({ notePath: "备注 2.md" }) }).state;
    expect(next.field(editorSettingsField).notePath).toBe("备注 2.md");
  });
});
