import { describe, expect, it } from "vitest";
import { newCanvasEdgeId, newCanvasNodeId } from "./ids";

describe("画布 id 生成", () => {
  it("形态与 Obsidian 一致：16 位小写十六进制", () => {
    expect(newCanvasNodeId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newCanvasEdgeId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("批量生成不撞号", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(newCanvasNodeId());
      seen.add(newCanvasEdgeId());
    }
    expect(seen.size).toBe(4000);
  });

  it("对已占用 id 让位", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 200; i += 1) existing.add(newCanvasNodeId(existing));
    expect(existing.size).toBe(200);
    // 已经占用的不会再被发出来
    for (let i = 0; i < 50; i += 1) expect(existing.has(newCanvasNodeId(existing))).toBe(false);
  });
});
