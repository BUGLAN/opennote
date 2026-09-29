import type { OpennoteBridge } from "../desktop/bridge";
import { assertSafeRelative } from "./paths";
import type { FileSystemBackend } from "./types";

/**
 * Desktop backend: the renderer talks to Node's `fs` through the Electron
 * preload bridge, so a workspace is a real folder on the user's disk.
 */
export function createNodeBackend(rootPath: string, bridge: OpennoteBridge): FileSystemBackend {
  const safe = (relPath: string): string => assertSafeRelative(relPath);

  return {
    kind: "node",
    label: "本机磁盘",
    canWrite: true,

    list: (relPath) => bridge.fs.list(rootPath, safe(relPath)),
    readText: (relPath) => bridge.fs.readText(rootPath, safe(relPath)),
    readBytes: (relPath) => bridge.fs.readBytes(rootPath, safe(relPath)),
    writeText: (relPath, text) => bridge.fs.writeText(rootPath, safe(relPath), text),
    writeBytes: async (relPath, data) => {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      await bridge.fs.writeBytes(rootPath, safe(relPath), bytes);
    },
    mkdir: (relPath) => bridge.fs.mkdir(rootPath, safe(relPath)),
    remove: (relPath, options) => bridge.fs.remove(rootPath, safe(relPath), options),
    move: (from, to) => bridge.fs.move(rootPath, safe(from), safe(to)),
    exists: (relPath) => bridge.fs.exists(rootPath, safe(relPath)),
    stat: (relPath) => bridge.fs.stat(rootPath, safe(relPath)),
  };
}
