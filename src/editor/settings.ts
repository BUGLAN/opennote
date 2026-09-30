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
  /**
   * 正在编辑的笔记**路径**（`归档/foo 2.md`）—— 路径本身就是「哪一篇笔记」这一个事实的产地，
   * 没有笔记打开时是空串。
   *
   * 为什么不是「笔记所在目录」：附件落点是**按笔记名派生**的
   * （`saveImage(file, name, notePath)` → `assetsDirFor(notePath)` → `<目录>/<笔记名>.assets/`），
   * 而相对引用的基准是**目录**。两个需求各取所需：需要目录的一方自己 `parentPath(notePath)`
   * 换算（`src/editor/widgets.ts` 的 `ImageWidget` 就是这么做的，`resolveImageSrc(src, baseDir)`
   * 的「基准 = 目录」语义一字未改）。
   *
   * 这个字段曾经叫 `baseDir` 且装的是目录：两者类型都是 `string`，类型检查拦不住，
   * 粘贴的图片于是静默写进了 `未命名.assets/`。**名字必须说出它装的是什么**。
   */
  notePath: string;
}

export const defaultEditorSettings: EditorSettings = {
  theme: "paper",
  appearance: "light",
  focus: false,
  typewriter: false,
  imageMode: "asset",
  spellcheck: true,
  notePath: "",
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
