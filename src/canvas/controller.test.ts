import { describe, expect, it } from "vitest";
import {
  activeCanvasIds,
  getActiveCanvasApi,
  registerActiveCanvas,
  unregisterActiveCanvas,
  type CanvasViewApi,
} from "./controller";

function api(tag: string): CanvasViewApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fitView: () => calls.push(`fitView:${tag}`),
    resetZoom: () => calls.push(`resetZoom:${tag}`),
    focusNode: (nodeId: string) => calls.push(`focusNode:${tag}:${nodeId}`),
  };
}

describe("controller 注册表", () => {
  it("注册后可按 id 取回，卸载后移除", () => {
    const a = api("a");
    registerActiveCanvas("c1", a);
    expect(activeCanvasIds()).toContain("c1");
    expect(getActiveCanvasApi("c1")).toBe(a);

    unregisterActiveCanvas("c1");
    expect(activeCanvasIds()).not.toContain("c1");
    expect(getActiveCanvasApi("c1")).toBeNull();
  });

  it("同一 id 重复注册以后者为准（重挂载场景）", () => {
    const first = api("first");
    const second = api("second");
    registerActiveCanvas("c2", first);
    registerActiveCanvas("c2", second);
    expect(getActiveCanvasApi("c2")).toBe(second);
    expect(activeCanvasIds().filter((id) => id === "c2")).toHaveLength(1);
  });

  it("卸载未注册的 id 是 no-op", () => {
    expect(() => unregisterActiveCanvas("never-registered")).not.toThrow();
    expect(getActiveCanvasApi("never-registered")).toBeNull();
  });

  it("多个画布并存、互不影响", () => {
    const a = api("a");
    const b = api("b");
    registerActiveCanvas("c3", a);
    registerActiveCanvas("c4", b);
    unregisterActiveCanvas("c3");
    expect(getActiveCanvasApi("c3")).toBeNull();
    const kept = getActiveCanvasApi("c4");
    expect(kept).toBe(b);
    kept?.focusNode("n1");
    expect(b.calls).toEqual(["focusNode:b:n1"]);
  });
});
