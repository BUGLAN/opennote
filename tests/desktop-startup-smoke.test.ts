import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  defaultDesktopExecutable,
  findFatalStartupError,
  rendererStateProblems,
} from "../scripts/smoke-desktop.mjs";

describe("desktop startup smoke", () => {
  it("finds the unpacked executable on each supported platform", () => {
    const root = join("repo");
    expect(defaultDesktopExecutable({ root, platform: "win32", arch: "x64" })).toBe(
      join(root, "release", "win-unpacked", "Opennote.exe"),
    );
    expect(defaultDesktopExecutable({ root, platform: "darwin", arch: "arm64" })).toBe(
      join(root, "release", "mac-arm64", "Opennote.app", "Contents", "MacOS", "Opennote"),
    );
    expect(defaultDesktopExecutable({ root, platform: "linux", arch: "arm64" })).toBe(
      join(root, "release", "linux-arm64-unpacked", "opennote"),
    );
  });

  it("fails only on fatal startup paths, not optional-module fallbacks", () => {
    expect(findFatalStartupError("[opennote] desktop ready 0.16.1")).toBeNull();
    expect(
      findFatalStartupError(
        "[opennote] @parcel/watcher 不可用，使用 node:fs 监听： Cannot find module '@parcel/watcher'",
      ),
    ).toBeNull();
    expect(findFatalStartupError("noise\n[opennote] 加载失败 file:///app/dist/index.html: ERR_FILE_NOT_FOUND (-6)")).toBe(
      "[opennote] 加载失败 file:///app/dist/index.html: ERR_FILE_NOT_FOUND (-6)",
    );
    expect(findFatalStartupError("Unable to load preload script: /app/preload.cjs")).toBe(
      "Unable to load preload script: /app/preload.cjs",
    );
  });

  it("requires rendered DOM, a usable preload bridge, and a working IPC path", () => {
    const healthy = {
      bridge: true,
      bridgeType: "object",
      isElectron: true,
      hasFsList: true,
      ipc: true,
      rootChildren: 2,
    };
    expect(rendererStateProblems(healthy)).toEqual([]);
    expect(rendererStateProblems({ ...healthy, bridge: false, bridgeType: "undefined" })).toContain(
      "window.opennote 不可用（bridgeType=undefined）",
    );
    expect(rendererStateProblems({ ...healthy, ipc: false, ipcError: "No handler registered" })).toContain(
      "窗口 IPC 调用失败：No handler registered",
    );
    expect(rendererStateProblems({ ...healthy, rootChildren: 0 })).toContain(
      "#root 没有渲染内容（children=0）",
    );
  });
});
