/**
 * 信封 → 文件字节的确定性映射（契约 §3.2 / §3.3.3 / §3.5、附录 A.2）。
 *
 * 字节级模板（`\n` = LF，文件末尾恰好一个换行）：
 *
 * ```text
 * ---
 * source: <url 或 省略该行>
 * source_title: <网页标题 或 省略该行>
 * source_site: <站点名 或 省略该行>
 * author: <作者 或 省略该行>
 * published_at: <ISO8601 或 省略该行>
 * captured_at: <ISO8601>
 * tags: [<t1>, <t2>]
 * opennote_import_id: <importId>
 * ---
 *
 * # <title>
 *
 * <body>
 * ```
 *
 * 三条最容易踩的坑，全部来自既有代码的事实：
 * 1. `deriveTitle()`（`src/lib/utils.ts:61`）**不读 front-matter**，只认正文第一个标题行 ——
 *    所以正文首行必须是 `# {title}`，写 `title:` 键完全无效；
 * 2. `deriveTags()`（`:132`）只认 `tags: [a, b]` 行内数组或 `- ` 块序列，且**只有 `tags`
 *    会被应用解析**，其余 7 个键都是惰性元数据（仍要写，供换机器/换编辑器不丢来源）；
 * 3. `---` 必须在**文件最开头**（`splitFrontMatter()` 的正则是 `^\uFEFF?---\r?\n…`），
 *    前面不能有任何空行，否则整段 front-matter 会被当成正文、标签丢失。
 */

import { formatStamp } from "../../fs/paths";
import { normalizeEol } from "../utils";
import type { ImportEnvelope } from "./envelope";

/** 固定的 8 键顺序（契约 §3.2 规则 4）：保证同一信封产出的字节完全一致。 */
export const FRONT_MATTER_KEYS = [
  "source",
  "source_title",
  "source_site",
  "author",
  "published_at",
  "captured_at",
  "tags",
  "opennote_import_id",
] as const;

/** YAML 标量转义（契约 §3.2 规则 8）。 */
export function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (
    /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff ._/:@+-]*$/.test(value) &&
    !value.endsWith(" ") &&
    !value.includes(" #")
  ) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 标签行内数组：`tags: [a, b]`（`deriveTags()` 的第一种识别形式）。
 * 标签若匹配 `/^[\p{L}\p{N}_\-\/]+$/u` 则裸写，**否则双引号包裹**（契约 §3.2 规则 9；
 * `normalizeTag()` 会去掉引号，所以加引号是安全的）。
 * 全部标签都被丢弃时返回 `null`，调用方省略整行。
 */
export function renderTagLine(tags: string[]): string | null {
  if (!tags.length) return null;
  const rendered = tags.map((tag) =>
    /^[\p{L}\p{N}_\-/]+$/u.test(tag) ? tag : `"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `[${rendered.join(", ")}]`;
}

/** front-matter 段（含首行 `---`，以换行结尾，不含尾随空行）。 */
export function renderFrontMatter(envelope: ImportEnvelope): string {
  const lines: string[] = ["---"];
  const { source } = envelope;
  // 值为 null 的键**整行省略**（不写 `source: null`）。
  if (source.url) lines.push(`source: ${yamlScalar(source.url)}`);
  if (source.title) lines.push(`source_title: ${yamlScalar(source.title)}`);
  if (source.site) lines.push(`source_site: ${yamlScalar(source.site)}`);
  if (source.author) lines.push(`author: ${yamlScalar(source.author)}`);
  if (source.publishedAt) lines.push(`published_at: ${yamlScalar(source.publishedAt)}`);
  lines.push(`captured_at: ${yamlScalar(source.capturedAt)}`);
  const tagLine = renderTagLine(envelope.tags);
  if (tagLine) lines.push(`tags: ${tagLine}`);
  lines.push(`opennote_import_id: ${yamlScalar(envelope.importId)}`);
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/**
 * 正文里第一个非空行若本身已是 H1，降级为 H2（只降级一次，不做全局改写）。
 * 理由：避免同一文件出现两个 H1（`deriveTitle()` 只取第一个标题行）。
 */
export function downgradeLeadingH1(body: string): string {
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const match = /^#\s+(.*)$/.exec(lines[index]);
    if (match) lines[index] = `## ${match[1]}`;
    return lines.join("\n");
  }
  return body;
}

/** 正文块：`# {title}\n\n{body}`（没有正文时只有 H1 行）。 */
export function renderBodyBlock(title: string, body: string): string {
  const normalized = downgradeLeadingH1(normalizeEol(body));
  return normalized ? `# ${title}\n\n${normalized}` : `# ${title}`;
}

/**
 * 完整文件文本：front-matter + 恰好一个空行 + H1 + 正文，末尾恰好一个 `\n`，无 BOM，
 * 全文无 `\r`（契约 §3.2 / §3.5）。
 */
export function renderMarkdown(envelope: ImportEnvelope, body: string): string {
  const text = `${renderFrontMatter(envelope)}\n${renderBodyBlock(envelope.title, body)}`;
  return `${normalizeEol(text).trimEnd()}\n`;
}

/**
 * `append` 的写入形态（契约 §3.3.3）：
 * ```text
 * separator = "\n\n---\n\n"
 * stamp     = "> 再次剪藏于 " + formatStamp(capturedAt) + "\n"
 * next      = normalizeEol(existing).trimEnd() + separator + stamp + "\n" + renderBody(V)
 * ```
 * 追加是**纯文本拼接**，不改动已有内容 —— 这是「不许静默改用户文件」的最低限度满足。
 */
export function renderAppended(existing: string, envelope: ImportEnvelope, body: string, capturedAtMs?: number): string {
  const separator = "\n\n---\n\n";
  const stamp = `> 再次剪藏于 ${formatStamp(capturedAtMs ?? Date.now())}\n`;
  const next = `${normalizeEol(existing).trimEnd()}${separator}${stamp}\n${renderBodyBlock(envelope.title, body)}`;
  return `${normalizeEol(next).trimEnd()}\n`;
}

/** 从正文抽取 `# {title}` 行（供日志与 UI 展示；不改写正文）。 */
export function firstHeading(body: string): string | null {
  for (const line of normalizeEol(body).split("\n")) {
    const match = /^#\s+(.*)$/.exec(line.trim());
    if (match) return match[1] || null;
  }
  return null;
}
