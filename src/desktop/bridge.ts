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
    addRecentWorkspace(absolutePath: string): Promise<void>;
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
