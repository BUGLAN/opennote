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
}

export const bridge: EditorBridge = {
  openWikiLink: () => {},
  openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  notify: () => {},
  imageMode: () => "asset",
  hasNote: () => false,
};

export function setBridge(next: Partial<EditorBridge>): () => void {
  const previous = { ...bridge };
  Object.assign(bridge, next);
  return () => Object.assign(bridge, previous);
}
