import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A tiny fake DOM: mermaid's renderer is the only thing that touches it, and the
 * point of the test is which elements survive a render — sticking a real DOM
 * implementation in just to check that is unnecessary weight.
 */
const h = vi.hoisted(() => ({
  elements: new Map<string, { id: string; remove: () => void }>(),
  calls: [] as string[],
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (id: string, code: string) => {
      h.calls.push(code);
      // like the real thing: a measuring container appears in the document …
      h.elements.set(`d${id}`, { id: `d${id}`, remove: () => h.elements.delete(`d${id}`) });
      if (code.includes("BROKEN")) throw new Error("Parse error on line 1");
      // … and is removed again when rendering succeeded
      h.elements.delete(`d${id}`);
      return { svg: `<svg id="${id}">${code}</svg>` };
    },
  },
}));

const { MERMAID_CACHE_LIMIT, mermaidHtmlSync, renderMermaid } = await import("./mermaid");

function fakeDocument() {
  return {
    documentElement: {},
    body: { appendChild: () => {} },
    createElement: () => ({ id: "", setAttribute: () => {} }),
    getElementById: (id: string) => h.elements.get(id) ?? null,
  };
}

function temporaryContainers(): string[] {
  return [...h.elements.keys()].filter((id) => id.startsWith("dopennote-mermaid"));
}

beforeEach(() => {
  h.elements.clear();
  h.calls.length = 0;
  vi.stubGlobal("document", fakeDocument());
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("D23 mermaid 渲染不泄漏临时容器", () => {
  it("removes the measuring container when rendering throws", async () => {
    const result = await renderMermaid("graph TD\nBROKEN", "paper", "light");
    expect(result.error).toContain("Parse error");
    expect(temporaryContainers()).toEqual([]);
  });

  it("removes the measuring container after several failures", async () => {
    await renderMermaid("BROKEN one", "paper", "light");
    await renderMermaid("BROKEN two", "paper", "light");
    await renderMermaid("BROKEN three", "paper", "light");
    expect(temporaryContainers()).toEqual([]);
  });

  it("still returns the rendered svg and caches it", async () => {
    const first = await renderMermaid("graph TD\nA-->B", "paper", "light");
    expect(first.error).toBeNull();
    expect(first.html).toContain("<svg");
    expect(temporaryContainers()).toEqual([]);
    const callsAfterFirst = h.calls.length;

    const second = await renderMermaid("graph TD\nA-->B", "paper", "light");
    expect(second.html).toBe(first.html);
    expect(h.calls.length).toBe(callsAfterFirst); // served from the cache
    expect(mermaidHtmlSync("graph TD\nA-->B", "paper")).toBe(first.html);
  });
});

describe("D23 mermaid 缓存有上限", () => {
  it("evicts the least recently used diagram", async () => {
    const code = (i: number) => `lru-graph-${i} --> B`;
    for (let i = 0; i < MERMAID_CACHE_LIMIT + 3; i += 1) {
      await renderMermaid(code(i), "paper", "light");
    }
    expect(mermaidHtmlSync(code(0), "paper")).toBeNull();
    expect(mermaidHtmlSync(code(1), "paper")).toBeNull();
    expect(mermaidHtmlSync(code(MERMAID_CACHE_LIMIT + 2), "paper")).not.toBeNull();

    const calls = h.calls.length;
    await renderMermaid(code(MERMAID_CACHE_LIMIT + 2), "paper", "light");
    expect(h.calls.length).toBe(calls); // still cached
    await renderMermaid(code(0), "paper", "light");
    expect(h.calls.length).toBe(calls + 1); // evicted, so rendered again
  });

  it("keeps reading recently used entries cached", async () => {
    const code = (i: number) => `keep-graph-${i} --> B`;
    for (let i = 0; i < MERMAID_CACHE_LIMIT; i += 1) await renderMermaid(code(i), "paper", "light");
    // touching the oldest keeps it alive while one new diagram arrives
    expect(mermaidHtmlSync(code(0), "paper")).not.toBeNull();
    await renderMermaid(code(MERMAID_CACHE_LIMIT), "paper", "light");
    expect(mermaidHtmlSync(code(0), "paper")).not.toBeNull();
    expect(mermaidHtmlSync(code(1), "paper")).toBeNull();
  });
});
