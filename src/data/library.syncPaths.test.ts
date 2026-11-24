/**
 * `applyExternalPaths`（同步拉取落盘后刷 UI）对**非笔记文件**的处理。
 *
 * 同步的拉取范围与推送一致之后，`.py` / `Dockerfile` / 图片也会经这里进来。
 * `exists()` 对文件也答 true，以前它们会被当成「外部新建的目录」挂进侧栏树。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "./workspaces";
import { createHarness, drainTimers } from "./libraryTestHarness";

const harness = createHarness();
const { backends, records } = harness;

vi.mock("./workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async (record: WorkspaceRecord) => backends.get(record.id),
  setActiveWorkspace: () => undefined,
}));

import { imageUrlStore, resolveImageSrc } from "./assets";
import { applyExternalPaths, closeWorkspace, getLibrary, openNote, openWorkspace } from "./library";

beforeEach(async () => {
  harness.reset();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await closeWorkspace().catch(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("applyExternalPaths · 非笔记文件", () => {
  it("拉下来的 .py / Dockerfile 不变成侧栏里的文件夹；真目录照常补节点", async () => {
    const backend = harness.scenario("A", (b) => b.seed("a.md", "# a"));
    await openWorkspace(records.get("A")!, { silent: true });

    backend.seed("代码/1.py", "print(1)\n");
    backend.seed("Dockerfile", "FROM node:11\n");
    const done = applyExternalPaths(["代码/1.py", "Dockerfile", "代码"]);
    await drainTimers();
    await done;

    const folders = getLibrary().folders;
    expect(folders["代码/1.py"]).toBeUndefined();
    expect(folders["Dockerfile"]).toBeUndefined();
    expect(folders["代码"]).toBeDefined();
  });

  it("笔记先到、图片后到：已显示 missing 的图片在 asset 落地后自愈", async () => {
    const backend = harness.scenario("A", (b) => b.seed("笔记.md", "![图](./笔记.assets/图.png)"));
    await openWorkspace(records.get("A")!, { silent: true });
    openNote("笔记.md");

    const path = "笔记.assets/图.png";
    const ref = "./笔记.assets/图.png";
    expect(await resolveImageSrc(ref, "")).toBeNull();
    expect(imageUrlStore.get()[path]).toBeUndefined();

    let updates = 0;
    const unsubscribe = imageUrlStore.subscribe(() => {
      updates += 1;
    });
    try {
      backend.seed(path, "png");
      const done = applyExternalPaths([path]);
      await done;

      const cached = imageUrlStore.get()[path];
      expect(cached).toMatch(/^blob:/);
      expect(await resolveImageSrc(ref, "")).toBe(cached);
      expect(updates).toBe(1);
      expect(getLibrary().folders[path]).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("图片先到：共享 .assets 里的图片先缓存，笔记随后落地即可直接显示", async () => {
    const backend = harness.scenario("A", () => undefined);
    await openWorkspace(records.get("A")!, { silent: true });

    const first = ".assets/图 一.png";
    const second = ".assets/图 二.png";
    backend.seed(first, "one");
    backend.seed(second, "two");

    let updates = 0;
    const unsubscribe = imageUrlStore.subscribe(() => {
      updates += 1;
    });
    try {
      const done = applyExternalPaths([first, second, first]);
      await done;

      const cached = imageUrlStore.get()[first];
      expect(cached).toMatch(/^blob:/);
      expect(imageUrlStore.get()[second]).toMatch(/^blob:/);
      // 同一批图片只发布一次，EditorPane 不必逐文件重建装饰。
      expect(updates).toBe(1);

      backend.seed("甲.md", "![一](./.assets/图 一.png)");
      await applyExternalPaths(["甲.md"]);

      expect(getLibrary().notes["甲.md"].content).toContain(".assets/图 一.png");
      expect(await resolveImageSrc("./.assets/图 一.png", "")).toBe(cached);
      expect(getLibrary().folders[".assets"]).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
