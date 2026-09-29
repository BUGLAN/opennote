import { escapeHtml } from "../lib/utils";
import type { ThemeId } from "../data/types";

type MermaidModule = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidModule | null> | null = null;
let initializedFor: string | null = null;
const cache = new Map<string, string>();
let counter = 0;

function readVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

async function loadMermaid(theme: ThemeId, appearance: "light" | "dark"): Promise<MermaidModule | null> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then((mod) => ((mod as unknown as { default?: MermaidModule }).default ?? (mod as unknown as MermaidModule)) ?? null)
      .catch((error) => {
        console.warn("[opennote] Mermaid 加载失败", error);
        return null;
      });
  }
  const mermaid = await mermaidPromise;
  if (!mermaid) return null;
  if (initializedFor !== theme) {
    const paper = readVar("--paper-2", appearance === "dark" ? "#1c1915" : "#fffdf9");
    const ink = readVar("--ink", appearance === "dark" ? "#eae3d7" : "#221d17");
    const rule = readVar("--rule-strong", appearance === "dark" ? "#413930" : "#d7cbb8");
    const accent = readVar("--accent", "#b23a2e");
    const accentSoft = readVar("--paper-3", appearance === "dark" ? "#262119" : "#f2ece1");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "inherit",
      themeVariables: {
        background: paper,
        primaryColor: accentSoft,
        primaryTextColor: ink,
        primaryBorderColor: rule,
        secondaryColor: paper,
        tertiaryColor: paper,
        lineColor: rule,
        textColor: ink,
        mainBkg: accentSoft,
        nodeBorder: rule,
        clusterBkg: paper,
        clusterBorder: rule,
        edgeLabelBackground: paper,
        fontSize: "15px",
        accent,
      },
    });
    initializedFor = theme;
  }
  return mermaid;
}

export function mermaidHtmlSync(code: string, theme: ThemeId): string | null {
  return cache.get(`${theme}::${code}`) ?? null;
}

export async function renderMermaid(
  code: string,
  theme: ThemeId,
  appearance: "light" | "dark",
): Promise<{ html: string; error: string | null }> {
  const key = `${theme}::${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return { html: hit, error: null };
  const mermaid = await loadMermaid(theme, appearance);
  if (!mermaid) {
    return { html: `<div class="mermaid-error">Mermaid 未能加载（可能处于离线状态）</div>`, error: "load" };
  }
  try {
    counter += 1;
    const { svg } = await mermaid.render(`opennote-mermaid-${counter}`, code);
    cache.set(key, svg);
    return { html: svg, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const html = `<div class="mermaid-error">图表语法有误：\n${escapeHtml(message)}</div>`;
    return { html, error: message };
  }
}
