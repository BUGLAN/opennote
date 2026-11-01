import { createStore } from "../lib/store";
import type { CursorInfo } from "./EditorPane";

/**
 * 活跃编辑器的光标（行 / 列 / 选中字数）。
 *
 * 单独成一个 store 而不是 App 的 state：光标每移一格都会报一次，放在 App 根上就是
 * 整棵树（侧栏文件树、标签栏、状态栏、大纲）跟着重渲染一遍。现在只有订阅它的
 * 两处小组件（状态栏的行列、大纲的当前标题）会动。
 */
export const cursorStore = createStore<CursorInfo>({ line: 1, column: 1, selected: 0 });

/** 值没变就不发通知（切标签、聚焦时编辑器会重复报同一个位置）。 */
export function reportCursor(info: CursorInfo): void {
  const prev = cursorStore.get();
  if (prev.line === info.line && prev.column === info.column && prev.selected === info.selected) return;
  cursorStore.set(info);
}
