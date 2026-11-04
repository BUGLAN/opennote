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

import { applyExternalPaths, closeWorkspace, getLibrary, openWorkspace } from "./library";

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
});
