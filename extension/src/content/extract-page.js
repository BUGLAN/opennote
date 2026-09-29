/**
 * 页面正文抽取（Readability 风格的本地实现，**不引入任何远程代码**）。
 *
 * 这个文件刻意只有一个顶层声明（下面这个函数），因为 MV3 的
 * `chrome.scripting.executeScript({ func })` 会把函数 `toString()` 后注入页面——
 * 函数体里**不能引用任何模块作用域的标识符**，否则注入后会 `ReferenceError`。
 * `verify.mjs` 会机械校验这条不变量（顶层声明数量 === 1，且没有 import/require）。
 *
 * 硬性约束（02 §5.5 / 03 §UI-05）：只做「去导航/广告等明显噪声」与「Markdown 语法规范化」，
 * **不补写、不摘要、不改写用户原文**。
 */

export function extractPage(options) {
  const opts = options || {};
  const doc = opts.doc || document;
  const win = opts.win || window;
  const includeArticle = opts.includeArticle !== false;

  /* ────────────────────────── 小工具 ────────────────────────── */
  function collapse(text) {
    return String(text == null ? "" : text).replace(/[\t\f\v\u00a0]+/g, " ").replace(/ {2,}/g, " ");
  }

  function textOf(node) {
    if (!node) return "";
    return collapse(node.textContent || "").trim();
  }

  function metaContent(selector) {
    const node = doc.querySelector(selector);
    if (!node) return null;
    const value = node.getAttribute("content") || node.getAttribute("value") || "";
    const trimmed = collapse(value).trim();
    return trimmed || null;
  }

  function absolute(url) {
    if (!url) return null;
    try {
      return new URL(url, doc.baseURI || (win.location && win.location.href) || undefined).href;
    } catch {
      return null;
    }
  }

  function countChars(text) {
    // 中英混排的「字数」：去掉空白后的字符数（与 mockup 的「已选中 214 字」口径一致）
    return String(text || "").replace(/\s+/g, "").length;
  }

  function excerptOf(text, max) {
    const flat = collapse(text).replace(/\n+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  }

  /* ────────────────────── 噪声节点清理 ────────────────────── */
  const NOISE_TAGS = [
    "script", "style", "noscript", "template", "iframe", "canvas", "svg", "form",
    "nav", "header", "footer", "aside", "button", "select", "textarea", "input",
    "dialog", "menu", "video", "audio", "object", "embed",
  ];
  const NOISE_ROLES = ["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "tablist"];
  const NOISE_HINT = /(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|footer|header|comment|comments|share|sharing|social|related|recommend|promo|advert|ads?|banner|cookie|subscribe|newsletter|breadcrumb|pagination|toolbar|modal|popup|paywall|skip-link)([-_ ]|$)/i;

  function isHidden(el) {
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const style = el.getAttribute("style");
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    return false;
  }

  function stripNoise(root) {
    for (const tag of NOISE_TAGS) {
      for (const el of Array.from(root.querySelectorAll(tag))) el.remove();
    }
    for (const role of NOISE_ROLES) {
      for (const el of Array.from(root.querySelectorAll(`[role="${role}"]`))) el.remove();
    }
    for (const el of Array.from(root.querySelectorAll("[hidden],[aria-hidden='true']"))) el.remove();
    for (const el of Array.from(root.querySelectorAll("[class],[id]"))) {
      const hint = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
      if (NOISE_HINT.test(hint)) el.remove();
    }
    for (const el of Array.from(root.querySelectorAll("div,section,span,p"))) {
      if (isHidden(el)) el.remove();
    }
  }

  function linkDensity(el) {
    const total = textOf(el).length;
    if (!total) return 0;
    let linked = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) linked += textOf(a).length;
    return Math.min(1, linked / total);
  }

  /* ────────────────────── 正文候选打分 ────────────────────── */
  const POSITIVE_HINT = /(^|[-_ ])(article|post|entry|content|main|body|markdown|prose|story|text)([-_ ]|$)/i;
  const BLOCK_SELECTOR = "p,pre,blockquote,li,td,dd,figcaption";

  function scoreCandidate(el) {
    let score = 0;
    const blocks = Array.from(el.querySelectorAll(BLOCK_SELECTOR));
    for (const block of blocks) {
      const length = textOf(block).length;
      if (length < 25) continue;
      score += Math.min(length, 600);
    }
    score += Math.min(blocks.length, 60) * 3;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "article") score += 120;
    if (tag === "main") score += 100;
    if (el.getAttribute && el.getAttribute("role") === "main") score += 80;
    const hint = `${(el.getAttribute && el.getAttribute("class")) || ""} ${(el.getAttribute && el.getAttribute("id")) || ""}`;
    if (POSITIVE_HINT.test(hint)) score += 60;
    score *= 1 - linkDensity(el);
    return score;
  }

  function pickRoot(clone) {
    const candidates = Array.from(
      clone.querySelectorAll("article,main,[role='main'],section,div,td,body"),
    );
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const score = scoreCandidate(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (!best || bestScore < 120) return clone.body || clone.documentElement;
    return best;
  }

  /* ──────────────────── HTML → Markdown ──────────────────── */
  function inlineOf(node) {
    if (!node) return "";
    if (node.nodeType === 3) return collapse(node.nodeValue).replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    const tag = (node.tagName || "").toLowerCase();
    const kids = () => Array.from(node.childNodes).map(inlineOf).join("");
    switch (tag) {
      case "br":
        return "  \n";
      case "strong":
      case "b": {
        const inner = kids().trim();
        return inner ? `**${inner}**` : "";
      }
      case "em":
      case "i": {
        const inner = kids().trim();
        return inner ? `*${inner}*` : "";
      }
      case "del":
      case "s":
      case "strike": {
        const inner = kids().trim();
        return inner ? `~~${inner}~~` : "";
      }
      case "code":
      case "kbd":
      case "samp": {
        const inner = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!inner) return "";
        const ticks = inner.includes("`") ? "``" : "`";
        return `${ticks}${inner}${ticks}`;
      }
      case "a": {
        const inner = kids().trim();
        const href = absolute(node.getAttribute("href"));
        if (!href) return inner;
        if (!inner || inner === href) return `<${href}>`;
        return `[${inner}](${href})`;
      }
      case "img": {
        const src = absolute(node.getAttribute("src") || node.getAttribute("data-src"));
        if (!src) return "";
        const alt = collapse(node.getAttribute("alt") || "").trim();
        return `![${alt}](${src})`;
      }
      case "sup":
      case "sub":
      case "mark":
      case "span":
      case "u":
      case "abbr":
      case "time":
      case "small":
      case "label":
      case "cite":
      case "q":
      case "bdi":
      case "bdo":
      case "ruby":
      case "rt":
      case "rp":
        return kids();
      default:
        return kids();
    }
  }

  function listToMarkdown(list, depth, ordered) {
    const lines = [];
    let index = 1;
    for (const item of Array.from(list.children)) {
      if ((item.tagName || "").toLowerCase() !== "li") continue;
      const marker = ordered ? `${index}. ` : "- ";
      index += 1;
      const parts = [];
      const nested = [];
      for (const child of Array.from(item.childNodes)) {
        if (child.nodeType === 1) {
          const tag = (child.tagName || "").toLowerCase();
          if (tag === "ul" || tag === "ol") {
            nested.push(listToMarkdown(child, depth + 1, tag === "ol"));
            continue;
          }
        }
        parts.push(inlineOf(child));
      }
      const body = parts.join("").replace(/\s+/g, " ").trim();
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${marker}${body}`.trimEnd());
      for (const block of nested) lines.push(block);
    }
    return lines.join("\n");
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const cells = rows.map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) => inlineOf(cell).replace(/\s+/g, " ").trim() || " "),
    );
    const width = cells.reduce((max, row) => Math.max(max, row.length), 0);
    if (!width) return "";
    const pad = (row) => {
      const copy = [...row];
      while (copy.length < width) copy.push(" ");
      return `| ${copy.join(" | ")} |`;
    };
    const out = [pad(cells[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`];
    for (const row of cells.slice(1)) out.push(pad(row));
    return `${out.join("\n")}\n\n`;
  }

  function blockOf(node, depth) {
    if (!node) return "";
    if (node.nodeType === 3) return collapse(node.nodeValue);
    if (node.nodeType !== 1) return "";
    const tag = (node.tagName || "").toLowerCase();
    const kids = (nextDepth) =>
      Array.from(node.childNodes)
        .map((child) => blockOf(child, nextDepth === undefined ? depth : nextDepth))
        .join("");
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag.slice(1));
        const text = inlineOf(node).replace(/\s+/g, " ").trim();
        return text ? `${"#".repeat(level)} ${text}\n\n` : "";
      }
      case "p": {
        const text = inlineOf(node).replace(/[ \t]+/g, " ").trim();
        return text ? `${text}\n\n` : "";
      }
      case "br":
        return "\n";
      case "hr":
        return "---\n\n";
      case "blockquote": {
        const inner = kids().trim();
        if (!inner) return "";
        const quoted = inner
          .split("\n")
          .map((line) => (line.trim() ? `> ${line.trim()}` : ">"))
          .join("\n");
        return `${quoted}\n\n`;
      }
      case "pre": {
        const codeNode = node.querySelector("code");
        const raw = (codeNode || node).textContent || "";
        const language = codeNode && codeNode.getAttribute("class")
          ? (codeNode.getAttribute("class").match(/language-([\w+#-]+)/) || [])[1] || ""
          : "";
        const body = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
        return `\`\`\`${language}\n${body}\n\`\`\`\n\n`;
      }
      case "ul":
        return `${listToMarkdown(node, depth, false)}\n\n`;
      case "ol":
        return `${listToMarkdown(node, depth, true)}\n\n`;
      case "table":
        return tableToMarkdown(node);
      case "figure": {
        const caption = node.querySelector("figcaption");
        const captionText = caption ? `*${inlineOf(caption).trim()}*\n\n` : "";
        const rest = Array.from(node.children)
          .filter((child) => (child.tagName || "").toLowerCase() !== "figcaption")
          .map((child) => blockOf(child, depth))
          .join("");
        return `${rest}${captionText}`;
      }
      case "img": {
        const inline = inlineOf(node);
        return inline ? `${inline}\n\n` : "";
      }
      case "dl": {
        const lines = [];
        for (const child of Array.from(node.children)) {
          const childTag = (child.tagName || "").toLowerCase();
          if (childTag === "dt") lines.push(`**${inlineOf(child).trim()}**`);
          if (childTag === "dd") lines.push(`: ${inlineOf(child).trim()}`);
        }
        return lines.length ? `${lines.join("\n")}\n\n` : "";
      }
      default:
        return kids();
    }
  }

  function htmlToMarkdown(root) {
    if (!root) return "";
    const raw = blockOf(root, 0);
    return raw
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
  }

  function fragmentToMarkdown(fragment) {
    const holder = doc.createElement("div");
    holder.appendChild(fragment.cloneNode(true));
    return htmlToMarkdown(holder);
  }

  /* ───────────────────────── 元数据 ───────────────────────── */
  function pageMeta() {
    const ogTitle = metaContent('meta[property="og:title"]') || metaContent('meta[name="twitter:title"]');
    const h1 = doc.querySelector("article h1, main h1, h1");
    const title = ogTitle || (h1 ? textOf(h1) : null) || collapse(doc.title || "").trim() || null;
    return {
      title: title ? title.slice(0, 300) : null,
      site:
        metaContent('meta[property="og:site_name"]') ||
        metaContent('meta[name="application-name"]') ||
        (win.location && win.location.hostname) ||
        null,
      author:
        metaContent('meta[name="author"]') ||
        metaContent('meta[property="article:author"]') ||
        metaContent('meta[name="twitter:creator"]') ||
        (doc.querySelector('[rel="author"]') ? textOf(doc.querySelector('[rel="author"]')) : null) ||
        null,
      publishedAt:
        metaContent('meta[property="article:published_time"]') ||
        metaContent('meta[name="date"]') ||
        metaContent('meta[name="pubdate"]') ||
        metaContent('meta[itemprop="datePublished"]') ||
        (doc.querySelector("time[datetime]") ? doc.querySelector("time[datetime]").getAttribute("datetime") : null) ||
        null,
      url: (win.location && win.location.href) || null,
      pageTitle: collapse(doc.title || "").trim() || null,
    };
  }

  /* ───────────────────────── 选区 ───────────────────────── */
  function selectionInfo() {
    const sel = win.getSelection ? win.getSelection() : null;
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      return { present: false, markdown: "", text: "", chars: 0, ancestorTitle: null };
    }
    const range = sel.getRangeAt(0);
    const text = String(sel.toString() || "").replace(/\r\n?/g, "\n").trim();
    if (!text) {
      return { present: false, markdown: "", text: "", chars: 0, ancestorTitle: null };
    }
    let markdown = "";
    try {
      markdown = fragmentToMarkdown(range.cloneContents());
    } catch {
      markdown = "";
    }
    if (!markdown.trim()) markdown = text;
    let ancestor = range.commonAncestorContainer;
    if (ancestor && ancestor.nodeType === 3) ancestor = ancestor.parentNode;
    let ancestorTitle = null;
    let cursor = ancestor;
    while (cursor && cursor !== doc.body && !ancestorTitle) {
      const heading = cursor.querySelector ? cursor.querySelector("h1,h2") : null;
      if (heading && textOf(heading)) ancestorTitle = textOf(heading);
      cursor = cursor.parentNode;
    }
    if (!ancestorTitle) {
      const h1 = doc.querySelector("h1");
      ancestorTitle = h1 ? textOf(h1) || null : null;
    }
    return { present: true, markdown, text, chars: countChars(text), ancestorTitle };
  }

  /* ─────────────────────── 主流程 ─────────────────────── */
  const meta = pageMeta();
  const selection = selectionInfo();

  // 元素选择（00 §6.15㉝ / 03 §UI-16）：给了 `rootSelector` 就**只抽那个元素及子树**，
  // 不做「整页挑正文容器」的那一步——用户点中的那块**就是**根。
  const pickedRoot = opts.rootSelector
    ? (() => {
        try {
          return doc.querySelector(opts.rootSelector);
        } catch {
          return null;
        }
      })()
    : null;

  let article = null;
  if (includeArticle) {
    let markdown = "";
    if (pickedRoot) {
      const scoped = pickedRoot.cloneNode(true);
      stripNoise(scoped);
      markdown = htmlToMarkdown(scoped);
    } else {
      const clone = doc.documentElement
        ? doc.documentElement.cloneNode(true)
        : doc.body
          ? doc.body.cloneNode(true)
          : null;
      if (clone) {
        stripNoise(clone);
        const root = pickRoot(clone);
        markdown = htmlToMarkdown(root);
      }
      if (!markdown.trim()) markdown = selection.present ? selection.markdown : "";
    }
    const h1 = doc.querySelector("article h1, main h1, h1");
    article = {
      title: (h1 ? textOf(h1) : null) || meta.title,
      markdown,
      text: markdown.replace(/[#*`>\-\[\]()!]/g, " ").replace(/\s+/g, " ").trim(),
      chars: countChars(markdown),
      author: meta.author,
      site: meta.site,
      publishedAt: meta.publishedAt,
      excerpt: excerptOf(markdown, 220),
    };
  }

  return {
    ok: true,
    url: meta.url,
    pageTitle: meta.title,
    site: meta.site,
    author: meta.author,
    publishedAt: meta.publishedAt,
    capturedAt: new Date().toISOString(),
    selection: {
      present: selection.present,
      markdown: selection.markdown,
      text: selection.text,
      chars: selection.chars,
      ancestorTitle: selection.ancestorTitle,
    },
    article,
  };
}
