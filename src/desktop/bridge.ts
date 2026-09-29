/**
 * The Electron preload bridge (see `electron/preload.cjs`). Everything is
 * optional: in a plain browser `window.opennote` is simply undefined and the
 * app falls back to the File System Access API or OPFS.
 */

export interface DesktopEntry {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface OpennoteBridge {
  isElectron: true;
  platform: string;
  version: string;
  fs: {
    list(root: string, relPath: string): Promise<DesktopEntry[]>;
    readText(root: string, relPath: string): Promise<string>;
    readBytes(root: string, relPath: string): Promise<Uint8Array>;
    writeText(root: string, relPath: string, text: string): Promise<void>;
    writeBytes(root: string, relPath: string, data: Uint8Array): Promise<void>;
    mkdir(root: string, relPath: string): Promise<void>;
    remove(root: string, relPath: string, options?: { recursive?: boolean }): Promise<void>;
    move(root: string, from: string, to: string): Promise<void>;
    exists(root: string, relPath: string): Promise<boolean>;
    stat(root: string, relPath: string): Promise<{ size: number; mtimeMs: number } | null>;
    /**
     * Re-authorise a workspace root for this session. The main process only
     * accepts roots it already trusts (picked through the native dialog, or
     * listed in its persisted recent-workspaces.json); everything else resolves
     * to `false`. Every `fs` call for an unauthorised root is rejected with
     * 「未授权的工作区目录」.
     */
    authorizeRoot(root: string): Promise<boolean>;
    /** Start watching an authorised workspace for external changes (debounced). */
    watchWorkspace(root: string): Promise<boolean>;
    /** Stop watching a workspace. */
    unwatchWorkspace(root: string): Promise<boolean>;
    /** Subscribe to debounced workspace-change events; returns an unsubscribe function. */
    onWorkspaceChanged(callback: (root: string) => void): () => void;
  };
  dialog: {
    pickFolder(): Promise<string | null>;
    pickSaveFile(options: { defaultName: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    saveFile(absolutePath: string, data: Uint8Array | string): Promise<boolean>;
  };
  shell: {
    showItemInFolder(absolutePath: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  app: {
    getRecentWorkspaces(): Promise<string[]>;
    /** Only roots the main process already trusts can be added (see fs.authorizeRoot). */
    addRecentWorkspace(absolutePath: string): Promise<void>;
    /**
     * The main process is closing the window and asks the renderer to flush
     * pending writes. Call `flushDone()` when finished (or immediately when
     * there is nothing to flush); the main process gives up after ~1500ms
     * anyway, so a missing handler never blocks the close.
     */
    onFlushRequest(callback: () => void): () => void;
    /** Tell the main process the flush finished (idempotent). */
    flushDone(): void;
  };
  window: {
    /** Overlay colours for the frameless title bar (false on macOS). */
    setTitleBarOverlay(colors: { color: string; symbolColor: string }): Promise<boolean>;
  };
  onMenu(callback: (command: string) => void): () => void;
}

export function desktopBridge(): OpennoteBridge | null {
  if (typeof window === "undefined") return null;
  const value = (window as unknown as { opennote?: OpennoteBridge }).opennote;
  return value?.isElectron ? value : null;
}

export function isDesktop(): boolean {
  return desktopBridge() !== null;
}
