import { escapeHtml } from "../lib/utils";

type KatexModule = {
  renderToString(tex: string, options: Record<string, unknown>): string;
};

let katexPromise: Promise<KatexModule | null> | null = null;
const cache = new Map<string, string>();

/** KaTeX is ~280 KB with fonts — load it the first time a formula is on screen. */
function loadKatex(): Promise<KatexModule | null> {
  if (!katexPromise) {
    katexPromise = import("katex")
      .then((mod) => {
        const candidate = (mod as unknown as { default?: KatexModule }).default ?? (mod as unknown as KatexModule);
        return typeof candidate?.renderToString === "function" ? candidate : null;
      })
      .catch((error) => {
        console.warn("[opennote] KaTeX 加载失败", error);
        return null;
      });
  }
  return katexPromise;
}

export function mathHtmlSync(tex: string, display: boolean): string | null {
  return cache.get(`${display ? "D" : "I"}${tex}`) ?? null;
}

export async function renderMath(tex: string, display: boolean): Promise<string> {
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const katex = await loadKatex();
  let html: string;
  if (!katex) {
    html = `<code class="katex-error" title="KaTeX 未加载">${escapeHtml(tex)}</code>`;
  } else {
    try {
      html = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        errorColor: "var(--accent)",
        strict: false,
        trust: false,
        macros: { "\\RR": "\\mathbb{R}", "\\NN": "\\mathbb{N}", "\\ZZ": "\\mathbb{Z}" },
      });
    } catch (error) {
      html = `<code class="katex-error" title="${escapeHtml(String(error))}">${escapeHtml(tex)}</code>`;
    }
  }
  cache.set(key, html);
  return html;
}

/** Trim the `$$` fence and any stray whitespace from a block formula. */
export function stripMathFence(raw: string): string {
  return raw.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "").trim();
}

export function stripMathDollars(raw: string): string {
  return raw.replace(/^\$/, "").replace(/\$$/, "").trim();
}
