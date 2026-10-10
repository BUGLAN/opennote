/**
 * The editor is a CodeMirror view; the rest of the app is React. Widgets and
 * key handlers talk to the app through this tiny bridge instead of prop-drilling
 * callbacks through extensions.
 */
export interface EditorBridge {
  /** Follow a `[[wiki link]]`; create the note when it does not exist yet. */
  openWikiLink(title: string): void;
  /** Open an external http(s) link. */
  openExternal(url: string): void;
  /** Show a transient message (toast). */
  notify(message: string): void;
  /** Ask the host where an image should live after a paste. */
  imageMode(): "asset" | "inline";
  /** Does a note with this title exist? Drives wiki-link styling. */
  hasNote(title: string): boolean;
  /**
   * 右键一张**渲染出来的图片**（视口坐标）。菜单长什么样、能做什么由宿主决定 ——
   * 编辑器不认识「剪贴板」，只负责把「哪张图、属于哪篇笔记」如实交出去。
   *
   * - `source` 是**完整的 `![说明](引用)`**（不是只有引用串）；
   * - `from` 是**被右键的那一个**在文档里的起点（取不到时为 `-1`）。
   *
   * 两个都要：宿主靠 `findImageSource(state, source, from)` 定位范围。只给 `source`
   * 的话，同一张图被引用两次时会命中第一处 —— 删错地方。
   */
  openImageMenu(
    x: number,
    y: number,
    target: { src: string; notePath: string; source: string; from: number },
  ): void;
}

export const bridge: EditorBridge = {
  openWikiLink: () => {},
  openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  notify: () => {},
  imageMode: () => "asset",
  hasNote: () => false,
  openImageMenu: () => {},
};

export function setBridge(next: Partial<EditorBridge>): () => void {
  const previous = { ...bridge };
  Object.assign(bridge, next);
  return () => Object.assign(bridge, previous);
}
