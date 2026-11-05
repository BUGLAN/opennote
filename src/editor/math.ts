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

/**
 * 把渲染管线输出的公式占位（`renderMarkdown()` 的 `[data-tex]`，见 `lib/markdown.ts`）排成 KaTeX。
 * 缓存命中的同步替换；其余异步，全部完成后调一次 `onDone`（调用方借此重新量高度）。
 */
export function hydrateMath(root: ParentNode, onDone?: () => void): void {
  const pending: Promise<void>[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-tex]"))) {
    const tex = el.dataset.tex ?? "";
    const display = el.classList.contains("math-block");
    const cached = mathHtmlSync(tex, display);
    if (cached) {
      el.innerHTML = cached;
      continue;
    }
    pending.push(
      renderMath(tex, display).then((html) => {
        el.innerHTML = html;
      }),
    );
  }
  if (pending.length && onDone) void Promise.all(pending).then(onDone);
}
