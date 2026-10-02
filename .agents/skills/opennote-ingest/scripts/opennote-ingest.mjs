#!/usr/bin/env node
/**
 * opennote-ingest —— 把 Agent 生成的 Markdown 文档入库到本机 Opennote。
 *
 * 两条通道，走的是同一份契约 `opennote.import/v1`
 * （`docs/import/02-接口契约-导入信封与通道.md`）：
 *
 *   1. `--channel inbox`（默认）**外部投递**：把条目写进
 *      `<笔记本>/.opennote/inbox/<UTC 时间戳>-<importId 前 8 位>/`
 *      （`entry.json` + `body.md` + `state.json` + 可选 `assets/`），
 *      由**用户在 Opennote 的收件箱里确认后**才落成笔记。
 *      —— 不需要令牌、不需要本地接口，Opennote 没开也能投；打开后立刻出现在收件箱。
 *      形状与 `scripts/verify-e2e.cjs` 的 `seedInboxEntry()`（仓库自己的「等价于外部程序投递」）
 *      以及 `src/data/inbox.ts` 的 `enqueueInbox()` 逐字段一致。
 *
 *   2. `--channel bridge` **本地桥直传**：`POST http://127.0.0.1:8787/v1/import`，
 *      立刻入库（是否先收件箱由**应用侧设置**决定，客户端无法强制）。
 *      需要：Opennote 桌面版正在运行 + 已打开笔记本 + 本地接口已开启 + 令牌。
 *
 * 这个脚本**只投递，不改写原文、不覆盖既有笔记、不猜工作区**。
 * 拿不准的一律如实失败并给出下一步动作，绝不假成功。
 *
 * 零依赖（只用 Node 内置模块），Node ≥ 20。Windows 优先，mac/Linux 亦可用。
 *
 * 退出码（沿用契约 §5.3.4 的 CLI 语义）：
 *   0 成功（含 skipped / deduped）  2 字段校验失败（不要重试，改参数）
 *   3 连不上本地桥                  4 令牌缺失或失效
 *   5 笔记本没打开 / 找不到笔记本   6 被冲突策略跳过
 *   7 被限流                        8 用法错误
 *   9 内部错误（写盘失败等）
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ================================ 常量 ================================= */

const SPEC = "opennote.import/v1";
/** 写进信封 `client.version`，便于在 Opennote 日志/收件箱里认出是哪一版技能投的。 */
const SKILL_VERSION = "0.1.0";
const INBOX_REL = path.join(".opennote", "inbox");
const INBOX_LIMIT = 500;
const INBOX_FULL_MESSAGE = "收件箱已满（500 条），请先处理一些条目。";
const BODY_FILE = "body.md";
const ENTRY_FILE = "entry.json";
const STATE_FILE = "state.json";
const ASSETS_DIR = "assets";

const MAX_TITLE = 200;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TAGS = 32;
const MAX_TAG_CHARS = 32;
const MAX_ASSETS = 32;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSETS_TOTAL = 24 * 1024 * 1024;
const MAX_SOURCE_FIELD = 120;
const MAX_SOURCE_TITLE = 300;

/** 本地桥端口（契约 §5.2.1：8787–8796，客户端依次探测）。 */
const PORTS = [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796];

/** 附件 MIME 白名单（契约 §2.5）。 */
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

const EXIT = {
  ok: 0,
  validation: 2,
  connect: 3,
  auth: 4,
  workspace: 5,
  skipped: 6,
  ratelimit: 7,
  usage: 8,
  internal: 9,
};

/* ============================== 小工具 ================================ */

const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");

/** `YYYY-MM-DDTHH:MM:SS±HH:MM`（契约 §2.3：capturedAt 必须含时区，保留用户当地时间）。 */
function localIso(at = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offsetMin = -at.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

/** 收件箱条目目录名的时间戳段：`YYYYMMDDTHHMMSS`（**UTC** 秒级，与 `inboxStamp()` 同源）。 */
function inboxStamp(at = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  );
}

/** 与 `src/fs/paths.ts` 的 `sanitizeName()` 同语义（文件名安全化，CJK 保持可读）。 */
function sanitizeName(value, fallback = "未命名") {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned) return fallback;
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

/**
 * 标签清洗：**逐条复刻** `src/lib/clip/envelope.ts` 的 `sanitizeTags()`，
 * 这样脚本报告的标签与真正落盘的完全一致（被丢掉的会如实标出来）。
 */
function sanitizeTags(input) {
  const list = Array.isArray(input) ? input : [];
  const dropped = [];
  const tags = [];
  for (const raw of list.slice(0, MAX_TAGS)) {
    if (typeof raw !== "string") {
      // 应用侧（`sanitizeTags()`）对非字符串同样只置 `dropped=true`，这里如实记下来。
      dropped.push(JSON.stringify(raw));
      continue;
    }
    let tag = raw.trim().replace(/^#+/, "").trim();
    if (!tag) continue;
    if (/[,\n\r[\]{}"']/.test(tag)) {
      dropped.push(raw);
      continue;
    }
    if (tag.length > MAX_TAG_CHARS) {
      dropped.push(raw);
      continue;
    }
    if (/^\d+$/.test(tag)) {
      dropped.push(raw);
      continue;
    }
    const tightened = tag.replace(/[^\p{L}\p{N}_\-/]/gu, "");
    if (tightened !== tag) dropped.push(raw);
    tag = tightened;
    if (!tag || /^\d+$/.test(tag) || tag.length > MAX_TAG_CHARS) continue;
    if (!tags.includes(tag)) tags.push(tag);
  }
  // 超过 32 个标签：应用侧是截断 + warning（`envelope.ts` 的 `truncated`）。这里如实报数。
  return { tags, dropped, truncated: Math.max(0, list.length - MAX_TAGS) };
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/** 极简 glob（只认 `*` 与 `?`），够用于 `--match "*.md"` / `--exclude "*.tmp"`。 */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(name, globs) {
  return globs.some((g) => globToRegExp(g).test(name));
}

/** 文本 -> 安全文件名（`entry.json` 里 `assets[].file` 用得到）。 */
function entryAssetName(bytes, name) {
  return `${sha256Hex(bytes).slice(0, 8)}-${sanitizeName(name, "attachment")}`;
}

/** SVG 净化（契约 §7.2）：拒 `<script`、`on*=` 事件属性、`javascript:`、外链 href。 */
function isSafeSvg(text) {
  const lower = text.toLowerCase();
  if (lower.includes("<script")) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  if (lower.includes("javascript:")) return false;
  if (/(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?\/\//i.test(text)) return false;
  if (lower.includes("<!entity")) return false;
  return true;
}

/* ============================ 命令行解析 ============================== */

const HELP = `opennote-ingest —— 把 Agent 生成的文档入库到 Opennote

用法
  node opennote-ingest.mjs <文件...> [选项]          单篇 / 多篇显式文件
  node opennote-ingest.mjs --dir <目录> [选项]       批量：目录下每个匹配文件各投一条
  node opennote-ingest.mjs --check                   只做前置检查（不改盘、不写盘）

通道
  --channel <inbox|bridge>   默认 inbox（进收件箱等用户确认）；bridge = 本地桥直接入库

落点与元数据
  --workspace <路径>         笔记本根目录（缺省自动发现，见 --check）
  --allow-recent             桥不可用/没开笔记本时，允许采用 recent-workspaces 的唯一候选
                             （默认**不允许**：那个文件是「最近打开过」，不等于「当前打开」）
  --folder <相对目录>        入库后的落点目录；默认空 = 笔记本根目录
                             逐段按契约校验（拒 ..、绝对路径、反斜杠、段内冒号、超 10 层、单段超 80 字）
  --title <标题>             仅单篇时使用；默认取 front-matter 的 title: 或正文首个 H1
  --tags <a,b>               追加标签（会与文档 front-matter 里的 tags 合并）
  --url <url>                来源 URL（生成物一般没有，留空即可）
  --source-title <t>         来源标题，默认写源文件路径（便于回溯）
  --site <s>  --author <a>  --published <iso>
  --attach <文件>            附件（图片），可重复；正文里用 ./assets/<文件名> 引用
  --auto-assets              自动把正文里指向本地存在文件的图片链接收成附件
  --client-name <cli|mcp|manual|other>  默认 cli
  --import-id <幂等键>       覆盖内容哈希生成的 importId（排障 / 对接外部系统）

批量
  --dir <目录>               批量源目录
  --match <glob,...>         默认 *.md；支持 * 与 ?
  --recursive                递归子目录
  --exclude <glob,...>       额外排除（默认已排除 .opennote/**、node_modules/**、.git/**）

行为
  --dry-run                  只打印将要提交的信封，不写盘、不请求
  --force                    既有条目不可用（例如上次入库 failed）时的重投：**会用一个新 importId**
                             再投一条（同 importId 的第二个条目会被应用标 failed + IMP-4017）
  --keep-front-matter        把源文件的 front-matter 原样留在正文里（默认剥离并继承 tags）
  --json                     输出机器可读 JSON（推荐给 Agent 用）
  --quiet                    只输出汇总
  --token <t>  --endpoint <url>   bridge 通道用；令牌默认取 OPENNOTE_TOKEN 或 bridge.json
  -h, --help                 显示本帮助
`;

function parseArgs(argv) {
  const opts = {
    files: [],
    channel: "inbox",
    dir: null,
    match: ["*.md"],
    exclude: [],
    recursive: false,
    workspace: null,
    allowRecent: false,
    folder: "",
    title: null,
    tags: [],
    url: null,
    sourceTitle: null,
    site: null,
    author: null,
    published: null,
    attach: [],
    autoAssets: false,
    clientName: "cli",
    importId: null,
    dryRun: false,
    force: false,
    keepFrontMatter: false,
    json: false,
    quiet: false,
    token: null,
    endpoint: null,
    check: false,
    help: false,
  };
  const need = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} 缺少取值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--channel": opts.channel = need(arg, i); i += 1; break;
      case "--dir": opts.dir = need(arg, i); i += 1; break;
      case "--match": opts.match = need(arg, i).split(",").map((s) => s.trim()).filter(Boolean); i += 1; break;
      case "--exclude": opts.exclude = need(arg, i).split(",").map((s) => s.trim()).filter(Boolean); i += 1; break;
      case "--recursive": opts.recursive = true; break;
      case "--workspace": opts.workspace = need(arg, i); i += 1; break;
      case "--allow-recent": opts.allowRecent = true; break;
      case "--folder": opts.folder = need(arg, i); i += 1; break;
      case "--title": opts.title = need(arg, i); i += 1; break;
      case "--tags": opts.tags = need(arg, i).split(",").map((s) => s.trim()).filter(Boolean); i += 1; break;
      case "--url": opts.url = need(arg, i); i += 1; break;
      case "--source-title": opts.sourceTitle = need(arg, i); i += 1; break;
      case "--site": opts.site = need(arg, i); i += 1; break;
      case "--author": opts.author = need(arg, i); i += 1; break;
      case "--published": opts.published = need(arg, i); i += 1; break;
      case "--attach": opts.attach.push(need(arg, i)); i += 1; break;
      case "--auto-assets": opts.autoAssets = true; break;
      case "--client-name": opts.clientName = need(arg, i); i += 1; break;
      case "--import-id": opts.importId = need(arg, i); i += 1; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "--keep-front-matter": opts.keepFrontMatter = true; break;
      case "--json": opts.json = true; break;
      case "--quiet": opts.quiet = true; break;
      case "--token": opts.token = need(arg, i); i += 1; break;
      case "--endpoint": opts.endpoint = need(arg, i); i += 1; break;
      case "--check": opts.check = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (arg.startsWith("--")) throw new UsageError(`未知选项 ${arg}`);
        opts.files.push(arg);
        break;
    }
  }
  if (!["inbox", "bridge"].includes(opts.channel)) throw new UsageError(`--channel 只能是 inbox 或 bridge（收到 ${opts.channel}）`);
  if (!["cli", "mcp", "manual", "other"].includes(opts.clientName)) {
    throw new UsageError(`--client-name 只能是 cli / mcp / manual / other（收到 ${opts.clientName}）`);
  }
  return opts;
}

class UsageError extends Error {}
class IngestError extends Error {
  constructor(code, exit, message, extra = {}) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.extra = extra;
  }
}

/* ========================== 文档 → 信封字段 ============================ */

/** 拆 front-matter（与 `splitFrontMatter()` 的语义一致：`---` 必须在文件最开头）。 */
function splitFrontMatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontMatter: null, body: text };
  return { frontMatter: match[1], body: text.slice(match[0].length) };
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

/** 只认我们真正需要的几个键：title / tags / url / source / site / author / published_at|date。 */
function readFrontMatter(frontMatter) {
  const out = { title: null, tags: [], url: null, site: null, author: null, publishedAt: null };
  if (!frontMatter) return out;
  const lines = frontMatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2];
    if (key === "tags" || key === "tag") {
      if (value.trim()) {
        const inline = value.trim().replace(/^\[|\]$/g, "");
        out.tags.push(...inline.split(",").map((s) => unquote(s)).filter(Boolean));
      } else {
        // 块列表：后续以 `- x` 开头的行
        for (let j = i + 1; j < lines.length; j += 1) {
          const item = /^\s*-\s*(.+)$/.exec(lines[j]);
          if (!item) break;
          out.tags.push(unquote(item[1]));
          i = j;
        }
      }
    } else if (key === "title") out.title = unquote(value) || null;
    else if (key === "url" || key === "source") out.url = unquote(value) || null;
    else if (key === "site") out.site = unquote(value) || null;
    else if (key === "author") out.author = unquote(value) || null;
    else if (key === "published_at" || key === "published" || key === "date") out.publishedAt = unquote(value) || null;
  }
  return out;
}

/** 正文首个 H1 的行号（跳过空行；不认围栏代码里的 `#`）。 */
function findLeadingH1(lines) {
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) continue;
    return /^#\s+(.+?)\s*$/.test(line) ? { index: i, text: RegExp.$1.trim() } : null;
  }
  return null;
}

/** 首个非空行的纯文本（去掉常见 Markdown 标记），用作兜底标题。 */
function firstMeaningfulLine(lines) {
  for (const line of lines) {
    const text = line
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * 把一个源文件解析成信封需要的字段。
 *
 * 关键规矩（契约 §1.2① / §2.6）：**笔记标题由应用写进正文首个 H1**，
 * 所以标题必须交在 `title` 字段里，正文里那份同名 H1 要去掉，否则会落成
 * `# 标题` + `## 标题` 两层重复标题。
 */
function parseDocument(file, rawText, opts) {
  const text = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { frontMatter, body: bodyAfterFm } = splitFrontMatter(text);
  const fm = readFrontMatter(frontMatter);
  const lines = bodyAfterFm.split("\n");
  const h1 = findLeadingH1(lines);

  let title = (opts.title || fm.title || (h1 && h1.text) || firstMeaningfulLine(lines) || path.basename(file).replace(/\.[^.]+$/, "") || "").trim();
  if (!title) throw new IngestError("IMP-4003", EXIT.validation, `无法从 ${file} 定出标题：请用 --title 指定。`);
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE);

  // 若正文首个 H1 与最终标题同名，去掉这一行（应用会自己写 `# 标题`）。
  let body = bodyAfterFm;
  if (h1 && h1.text.trim() === title.trim()) {
    lines.splice(h1.index, /^\s*$/.test(lines[h1.index + 1] ?? "") ? 2 : 1);
    body = lines.join("\n");
  }
  if (opts.keepFrontMatter && frontMatter) body = `---\n${frontMatter}\n---\n\n${body}`;

  body = body.replace(/^\n+/, "").replace(/\s+$/, "");
  if (body) body += "\n";
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new IngestError("IMP-4004", EXIT.validation, `正文超过 8 MiB（${bytes} 字节）：请拆分后再入库。`);
  }

  const tagInput = [...(opts.tags ?? []), ...fm.tags];
  const { tags, dropped, truncated } = sanitizeTags(tagInput);
  const url = opts.url || fm.url || null;
  if (url && !/^https?:\/\//i.test(url)) {
    throw new IngestError("IMP-4003", EXIT.validation, `来源 URL 必须是 http(s)（收到 ${url}）。`);
  }
  const sourceTitle = opts.sourceTitle || path.resolve(file);

  return { title, body, tags, adjustedTags: dropped, url, site: opts.site || fm.site || null, author: opts.author || fm.author || null, publishedAt: opts.published || fm.publishedAt || null, sourceTitle };
}

/** 收集附件：显式 `--attach` + 可选 `--auto-assets`（正文里指向本地存在文件的图片链接）。 */
function collectAssets(file, body, opts) {
  const picked = new Map();
  for (const item of opts.attach) {
    const resolved = path.resolve(item);
    if (!fs.existsSync(resolved)) throw new IngestError("IMP-4012", EXIT.validation, `附件不存在：${resolved}`);
    picked.set(resolved, path.basename(resolved));
  }
  if (opts.autoAssets) {
    const dir = path.dirname(path.resolve(file));
    const re = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
    let match;
    while ((match = re.exec(body)) !== null) {
      const target = match[1];
      if (/^(https?:|data:|#)/i.test(target)) continue;
      const ext = path.extname(target).toLowerCase();
      if (!MIME_BY_EXT[ext]) continue;
      const resolved = path.resolve(dir, decodeURIComponent(target));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) picked.set(resolved, path.basename(resolved));
    }
  }
  if (picked.size > MAX_ASSETS) throw new IngestError("IMP-4013", EXIT.validation, `附件超过 ${MAX_ASSETS} 个。`);

  const assets = [];
  let total = 0;
  for (const [source, name] of picked) {
    const bytes = fs.readFileSync(source);
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new IngestError("IMP-4012", EXIT.validation, `附件过大（${name}，${bytes.byteLength} 字节）。`);
    total += bytes.byteLength;
    if (total > MAX_ASSETS_TOTAL) throw new IngestError("IMP-4013", EXIT.validation, "附件合计超过 24 MiB。");
    const ext = path.extname(name).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) throw new IngestError("IMP-4012", EXIT.validation, `不支持的附件格式：${name}`);
    if (mime === "image/svg+xml" && !isSafeSvg(bytes.toString("utf8"))) {
      throw new IngestError("IMP-4012", EXIT.validation, `SVG 未通过净化（含脚本或外链）：${name}`);
    }
    assets.push({ source, name, mime, bytes, file: path.posix.join(ASSETS_DIR, entryAssetName(bytes, name)) });
  }
  return assets;
}

/** 幂等键：内容确定性哈希 → 同一份文档重复投递不会产生第二条。 */
function importIdOf({ title, body, folder, url }) {
  const digest = sha256Hex(`${title}\n${folder}\n${url ?? ""}\n${body}`).slice(0, 16);
  return `agent-${digest}`;
}

const FOLDER_ERROR_MESSAGE = "目标目录不合法：不能使用 ..、绝对路径或系统保留字符。";

/**
 * 落点目录的本地校验：**逐条镜像** `src/lib/clip/envelope.ts` 的 `normalizeFolder()`
 * （`assertSafeRelative()` 的拒绝项 + 深度/段长上限 + 逐段 `sanitizeName()`）。
 *
 * 为什么脚本必须自己先跑一遍：收件箱通道是**纯文件协议**，应用要到用户点「导入」时才校验
 * 落点——那时条目会变成 `failed`，用户白等一次；桥通道则由桥拦（`rejectIllegalFolder()`）。
 * 先在本地拦掉，才能做到「落点不合法 → exit 2 + `IMP-4008`」，而不是把一条注定失败的条目
 * 塞进收件箱。
 */
function normalizeFolderStrict(input) {
  const value = String(input ?? "").trim();
  if (!value) return "";
  const bad = () => new IngestError("IMP-4008", EXIT.validation, FOLDER_ERROR_MESSAGE);
  if (value.includes("\0")) throw bad();
  // `normalizeFolder()` 显式拒绝反斜杠：分隔符只认 `/`（Windows 路径要写成 `a/b`）。
  if (value.includes("\\")) throw bad();
  if (/^([a-zA-Z]:|[\\/])/.test(value)) throw bad();
  const rawSegments = value.split("/");
  if (rawSegments.some((segment) => segment.includes(":"))) throw bad();
  if (rawSegments.includes("..")) throw bad();
  const segments = rawSegments.filter(Boolean);
  if (segments.length > 10) throw bad();
  const cleaned = [];
  for (const segment of segments) {
    if (segment.length > 80) throw bad();
    const name = sanitizeName(segment, "文件夹");
    if (!name || name === "." || name === "..") throw bad();
    cleaned.push(name);
  }
  return cleaned.join("/");
}

function buildEnvelope(doc, assets, opts, at) {
  const folder = normalizeFolderStrict(opts.folder);
  const importId = importIdOf({ title: doc.title, body: doc.body, folder, url: doc.url });
  return {
    spec: SPEC,
    importId,
    title: doc.title,
    body: doc.body,
    source: {
      url: doc.url,
      title: truncate(doc.sourceTitle, MAX_SOURCE_TITLE),
      site: doc.site ? truncate(doc.site, MAX_SOURCE_FIELD) : null,
      author: doc.author ? truncate(doc.author, MAX_SOURCE_FIELD) : null,
      publishedAt: doc.publishedAt,
      capturedAt: localIso(at),
      selection: false,
    },
    target: { folder: folder || null, notePath: null },
    conflict: "new",
    tags: doc.tags,
    // `entry.json` 里的附件形态：`{name, mime, file}`（相对条目目录）。字节由调用方另行持有。
    assets: assets.map((asset) => ({ name: asset.name, mime: asset.mime, file: asset.file })),
    client: { name: opts.clientName, version: SKILL_VERSION },
  };
}

/* ========================== 工作区与桥探测 ============================= */

function userDataDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opennote");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "opennote");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opennote");
}

function readBridgeFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir(), "bridge.json"), "utf8"));
  } catch {
    return null;
  }
}

/** `recent-workspaces.json`：最近打开过的笔记本绝对路径（不一定等于「当前打开的」）。 */
function readRecentWorkspaces() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir(), "recent-workspaces.json"), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch {
    return [];
  }
}

async function probeBridge(endpoint) {
  const candidates = endpoint ? [endpoint] : PORTS.map((port) => `http://127.0.0.1:${port}`);
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(600) });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload && payload.ok && payload.result) return { endpoint: base, ...payload.result };
    } catch {
      /* 这个端口没有我们的桥，继续试下一个 */
    }
  }
  return null;
}

/** 令牌：`--token` > `OPENNOTE_TOKEN` > `bridge.json` 的明文。 */
function resolveToken(opts) {
  if (opts.token) return { token: opts.token, source: "--token" };
  if (process.env.OPENNOTE_TOKEN) return { token: process.env.OPENNOTE_TOKEN, source: "OPENNOTE_TOKEN" };
  const bridge = readBridgeFile();
  if (bridge && typeof bridge.tokenPlaintext === "string" && bridge.tokenPlaintext) {
    return { token: bridge.tokenPlaintext, source: path.join(userDataDir(), "bridge.json") };
  }
  return { token: null, source: null };
}

async function checkBridgeAuth(endpoint, token) {
  if (!token) return "missing";
  try {
    const response = await fetch(`${endpoint}/v1/imports/auth-probe-0000`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 404 && payload?.error?.code === "IMP-4017") return "ok";
    if (response.status === 401) return "invalid";
    return `http-${response.status}`;
  } catch (error) {
    return "unreachable";
  }
}

/**
 * 找到「当前打开的笔记本」的绝对路径。
 *
 * 桥**故意不回绝对路径**（契约 §7），所以只能：桥给出 `workspace.name`（= 目录名）
 * → 在 `recent-workspaces.json` 里按同名匹配。匹配不到就如实失败，绝不猜。
 */
async function resolveWorkspace(opts) {
  if (opts.workspace) {
    const root = path.resolve(opts.workspace);
    if (!fs.existsSync(root)) throw new IngestError("IMP-4007", EXIT.workspace, `--workspace 指向的目录不存在：${root}`);
    return { root, how: "--workspace" };
  }
  if (process.env.OPENNOTE_WORKSPACE) {
    const root = path.resolve(process.env.OPENNOTE_WORKSPACE);
    if (fs.existsSync(root)) return { root, how: "OPENNOTE_WORKSPACE" };
  }
  const bridge = await probeBridge(opts.endpoint);
  const candidates = readRecentWorkspaces();
  const name = bridge?.workspace?.open ? bridge.workspace.name : null;
  if (bridge && !bridge.workspace?.open) {
    // 应用在运行、但**没有打开任何笔记本** —— 这就是「没有当前笔记本」，
    // 不能拿 recent-workspaces 里的历史条目顶上（那是猜）。
    if (opts.allowRecent && candidates.length === 1) {
      return { root: path.resolve(candidates[0]), how: "recent-workspaces 唯一候选（--allow-recent 显式允许；应用当前没有打开笔记本）" };
    }
    throw new IngestError("IMP-4007", EXIT.workspace, "Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。", { candidates });
  }
  if (name) {
    const hit = candidates.filter((item) => path.basename(item).toLowerCase() === String(name).toLowerCase());
    if (hit.length === 1) return { root: path.resolve(hit[0]), how: `桥的笔记本名匹配 recent-workspaces（${name}）` };
    if (hit.length > 1) {
      throw new IngestError("IMP-4007", EXIT.workspace, `有多个同名笔记本（${name}），无法确定是哪一个。请用 --workspace <路径> 指定。`, { candidates: hit });
    }
    throw new IngestError(
      "IMP-4007",
      EXIT.workspace,
      `应用打开的笔记本叫「${name}」，但在 recent-workspaces.json 里找不到同名目录。请用 --workspace <路径> 指定。`,
      { candidates },
    );
  }
  // 桥不可用（应用没运行 / 接口没开）：recent-workspaces 是「最近打开过」而不是「当前打开」，
  // 只有用户显式允许（--allow-recent）才拿它顶上，否则宁可失败让 Agent 去问人。
  if (opts.allowRecent && candidates.length === 1) {
    return { root: path.resolve(candidates[0]), how: "recent-workspaces 唯一候选（--allow-recent 显式允许；桥不可用）" };
  }
  throw new IngestError(
    "IMP-4007",
    EXIT.workspace,
    candidates.length
      ? `无法确定要投进哪个笔记本（桥不可用，recent-workspaces 里最近打开过：${candidates.join("；")}）。请用 --workspace <路径> 指定；确认无误也可以用 --allow-recent 采用唯一候选。`
      : "找不到笔记本目录。请在 Opennote 里打开一个笔记本文件夹，或用 --workspace <路径> 指定。",
    { candidates },
  );
}

/* ============================ 收件箱投递 ============================== */

/** 试运行不写盘，因此找不到笔记本也不该失败；真投递则必须解析出笔记本。 */
async function resolveWorkspaceForRun(opts) {
  if (opts.dryRun) {
    try {
      return await resolveWorkspace(opts);
    } catch (error) {
      return { root: null, how: `未解析（试运行不写盘）：${error.message}` };
    }
  }
  return resolveWorkspace(opts);
}

function readInboxEntries(root) {
  const dir = path.join(root, INBOX_REL);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // 目录不存在（或读不了）→ 空收件箱；目录由投递时的 mkdir 重建。
    return { entries: [], invalidDirs: [] };
  }
  const out = [];
  const invalid = [];
  for (const name of names) {
    const entryPath = path.join(dir, name, ENTRY_FILE);
    let envelope = null;
    try {
      envelope = JSON.parse(fs.readFileSync(entryPath, "utf8"));
    } catch {
      /* 没有（或读不出）entry.json 的目录**不是**收件箱条目 —— 与应用的 readDir() 同语义 */
    }
    if (!envelope || typeof envelope !== "object") {
      invalid.push(name);
      continue;
    }
    let status = "pending";
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, name, STATE_FILE), "utf8"));
      if (state && typeof state.status === "string") status = state.status;
    } catch {
      status = "pending";
    }
    out.push({ dirName: name, dirPath: path.join(dir, name), status, importId: typeof envelope.importId === "string" ? envelope.importId : null, title: typeof envelope.title === "string" ? envelope.title : null });
  }
  return { entries: out, invalidDirs: invalid };
}

/** 应用判据是**全部条目**（`inbox.ts` 的 `details.length >= INBOX_LIMIT`），不是只数 pending。 */
function inboxUsage(root) {
  const { entries, invalidDirs } = readInboxEntries(root);
  return {
    total: entries.length,
    pending: entries.filter((item) => item.status === "pending" || item.status === "committing").length,
    invalidDirs,
    entries,
  };
}

function writeFileAtomic(target, contents) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

function deliverToInbox(root, envelope, assets, opts) {
  const inboxDir = path.join(root, INBOX_REL);
  const usage = inboxUsage(root);
  if (usage.total >= INBOX_LIMIT) {
    throw new IngestError("IMP-4013", EXIT.validation, INBOX_FULL_MESSAGE, { code: "IMP-4013" });
  }
  const hit = usage.entries.find((item) => item.importId === envelope.importId);
  if (hit && !opts.force) {
    // 三种既有条目要分开说：**已入库** / **正在等确认** / **提交失败过**。
    // 把 failed 混进「已在收件箱」会让 Agent 把一条坏条目当成正常状态，永远不再管它。
    const reason = hit.status === "committed" ? "already-imported"
      : hit.status === "failed" ? "failed-in-inbox"
      : "already-in-inbox";
    return {
      skipped: true,
      reason,
      dirName: hit.dirName,
      status: hit.status,
      importId: hit.importId,
      nextStep: hit.status === "failed"
        // 同 importId 重投会被应用标成 IMP-4017；要救活只能换一个 importId（`--force` 做的就是这件事）。
        ? "该条目上一次入库失败了：请在 Opennote 收件箱里丢弃它，然后加 --force 重投（--force 会用一个新的 importId）。"
        : null,
    };
  }
  // `--force`：既有条目不可用时的重投通道。**必须换 importId** —— 同 importId 的第二个条目
  // 会被应用标成 failed + IMP-4017（幂等键就是身份），等于又造一条死条目。
  let importId = envelope.importId;
  if (hit && opts.force) {
    importId = `${envelope.importId}-r${sha256Hex(`${envelope.importId}:${Date.now()}`).slice(0, 4)}`;
    envelope.importId = importId;
  }

  const at = new Date();
  const slug = importId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "entry";
  let dirName = `${inboxStamp(at)}-${slug}`;
  let guard = 0;
  while (fs.existsSync(path.join(inboxDir, dirName))) {
    guard += 1;
    if (guard > 50) throw new IngestError("IMP-4010", EXIT.validation, "条目目录名冲突 50 次，放弃。");
    dirName = `${inboxStamp(at)}-${slug}-${guard + 1}`;
  }
  const entryDir = path.join(inboxDir, dirName);
  // 附件目录按需创建（与 `enqueueInbox()` 一致：没有附件就不留空目录）。
  if (assets.length) fs.mkdirSync(path.join(entryDir, ASSETS_DIR), { recursive: true });
  else fs.mkdirSync(entryDir, { recursive: true });

  // ① 正文与附件先落地，② entry.json 最后写（它是「条目存在」的唯一判据）。
  fs.writeFileSync(path.join(entryDir, BODY_FILE), envelope.body);
  for (const asset of assets) {
    fs.writeFileSync(path.join(entryDir, ...asset.file.split("/")), asset.bytes);
  }
  const entryOut = {
    spec: SPEC,
    importId,
    title: envelope.title,
    body: null,
    bodyFile: BODY_FILE,
    source: envelope.source,
    target: envelope.target,
    conflict: envelope.conflict,
    tags: envelope.tags,
    assets: envelope.assets,
    client: envelope.client,
    enqueuedAt: at.toISOString(),
  };
  writeFileAtomic(path.join(entryDir, ENTRY_FILE), `${JSON.stringify(entryOut, null, 2)}\n`);
  // state.json 只由应用改写状态；这里写上初始 pending，与仓库自己的外部投递夹具一致。
  writeFileAtomic(
    path.join(entryDir, STATE_FILE),
    `${JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: at.toISOString() }, null, 2)}\n`,
  );

  // ③ 落盘后**回读校验**（不是只看文件在不在）：把 entry.json 读回来解析，
  //    核对身份与正文长度；对不上就如实失败，绝不假装成功。
  let written;
  try {
    written = JSON.parse(fs.readFileSync(path.join(entryDir, ENTRY_FILE), "utf8"));
  } catch (error) {
    throw new IngestError("IMP-5001", EXIT.internal, `写盘后回读失败：${error.message}`);
  }
  const bodyOnDisk = fs.readFileSync(path.join(entryDir, BODY_FILE));
  const expectedBytes = Buffer.byteLength(envelope.body, "utf8");
  if (written.importId !== importId || written.title !== envelope.title || bodyOnDisk.byteLength !== expectedBytes) {
    throw new IngestError(
      "IMP-5001",
      EXIT.internal,
      `写盘后回读不一致（importId=${written.importId}，正文字节 ${bodyOnDisk.byteLength} ≠ ${expectedBytes}）：${entryDir}`,
    );
  }
  return { skipped: false, dirName, entryDir, importId, pending: usage.pending + 1, inboxId: dirName, forced: Boolean(hit && opts.force), replacedDirName: hit ? hit.dirName : null };
}

/* ============================== 桥直传 =============================== */

/**
 * 回执状态 → 本脚本的 action。**这是防「假成功」的关键一步**：
 * `ok:true` 只说明桥接受了请求，不代表写成了笔记。
 *
 * | `result.status` | 含义 | action |
 * | --- | --- | --- |
 * | `created` / `appended` | 真的写/追加了笔记 | `imported` |
 * | `pending` | **只进了收件箱**（应用侧偏好强制，`path` 为 null），等用户确认 | `queued` |
 * | `deduped` / `duplicate` / `skipped` | 没写盘，返回的是既有落点 | `skipped` |
 * | 其它 | 版本不匹配，不敢下结论 | `unknown`（按失败处理） |
 */
function actionForBridgeStatus(status) {
  switch (status) {
    case "created":
    case "appended":
      return "imported";
    case "pending":
      return "queued";
    case "deduped":
    case "duplicate":
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

async function deliverToBridge(endpoint, token, envelope, opts) {
  const response = await fetch(`${endpoint}/v1/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(60_000),
  }).catch((error) => {
    throw new IngestError("IMP-1001", EXIT.connect, `连不上本地桥（${endpoint}）：${error.message}`);
  });
  const payload = await response.json().catch(() => null);
  if (!payload) throw new IngestError("IMP-3002", EXIT.internal, "本地桥回了非 JSON 响应。");
  if (payload.ok) {
    const result = payload.result ?? {};
    const status = typeof result.status === "string" ? result.status : "";
    const action = actionForBridgeStatus(status);
    if (action === "unknown") {
      return {
        ok: false,
        code: "IMP-5001",
        userMessage: `本地桥回了无法识别的回执状态 ${JSON.stringify(status)}，不能判定是否入库。`,
        exit: EXIT.internal,
        result,
        status: response.status,
      };
    }
    return { ok: true, action, status, result, http: response.status };
  }
  const code = payload.error?.code ?? "IMP-5001";
  const userMessage = payload.error?.userMessage ?? "导入失败。";
  const exit = code === "IMP-2001" || code === "IMP-2002" ? EXIT.auth
    : code === "IMP-4006" || code === "IMP-1001" || code === "IMP-1004" ? EXIT.connect
    : code === "IMP-4007" ? EXIT.workspace
    : code === "IMP-4011" ? EXIT.skipped
    : code === "IMP-4015" || code === "IMP-4020" ? EXIT.ratelimit
    : code.startsWith("IMP-4") ? EXIT.validation
    : EXIT.internal;
  return { ok: false, code, userMessage, exit, result: null, status: response.status };
}

/* =============================== 主流程 =============================== */

function listSourceFiles(opts) {
  if (!opts.dir) return opts.files;
  const root = path.resolve(opts.dir);
  if (!fs.existsSync(root)) throw new UsageError(`--dir 目录不存在：${root}`);
  const skipDirs = new Set([".git", "node_modules", ".opennote"]);
  const out = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!opts.recursive || depth >= 12 || skipDirs.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!matchesAny(entry.name, opts.match)) continue;
      if (opts.exclude.length && matchesAny(entry.name, opts.exclude)) continue;
      out.push(full);
    }
  };
  walk(root, 0);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function envelopeFor(file, opts, at) {
  const raw = fs.readFileSync(file, "utf8");
  const doc = parseDocument(file, raw, opts);
  const assets = collectAssets(file, doc.body, opts);
  const envelope = buildEnvelope(doc, assets, opts, at);
  if (opts.importId) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(opts.importId)) {
      throw new IngestError("IMP-4003", EXIT.validation, `--import-id 必须是 8–128 个 [A-Za-z0-9_-] 字符（收到 ${opts.importId}）。`);
    }
    envelope.importId = opts.importId;
  }
  return { envelope, assets, doc, note: opts.channel === "bridge" ? stripForBridge(envelope, assets) : envelope, adjustedTags: doc.adjustedTags, truncatedTags: doc.truncatedTags };
}

/** 桥直传形态：正文内联、附件转 base64（与 `serializeEnvelope()` 同形）。 */
function stripForBridge(envelope, assets) {
  return {
    ...envelope,
    assets: assets.map((asset) => ({ name: asset.name, mime: asset.mime, dataBase64: asset.bytes.toString("base64") })),
  };
}

async function runCheck(opts) {
  const bridge = await probeBridge(opts.endpoint);
  const token = resolveToken(opts);
  const auth = bridge ? await checkBridgeAuth(bridge.endpoint, token.token) : "no-bridge";
  const report = {
    ok: true,
    node: process.version,
    bridge: bridge ? { endpoint: bridge.endpoint, app: bridge.app, spec: bridge.spec, inbox: bridge.inbox, inboxMode: bridge.inboxMode, workspace: bridge.workspace } : { found: false },
    token: { present: Boolean(token.token), source: token.source, auth: bridge ? auth : "no-bridge" },
    workspace: null,
    inbox: null,
  };
  try {
    const resolved = await resolveWorkspace(opts);
    report.workspace = resolved;
    const usage = inboxUsage(resolved.root);
    report.inbox = {
      // 口径与应用的 `listInboxDetails()` 一致：只数**有 entry.json** 的条目。
      total: usage.total,
      pending: usage.pending,
      // 没有 entry.json 的目录不是条目（应用会忽略），单列出来便于排障。
      invalidDirs: usage.invalidDirs,
      limit: INBOX_LIMIT,
      latest: usage.entries
        .slice()
        .sort((a, b) => (a.dirName < b.dirName ? 1 : -1))
        .slice(0, 5)
        .map((item) => ({ dirName: item.dirName, status: item.status, title: item.title })),
    };
  } catch (error) {
    report.workspace = { error: error.message, candidates: error.extra?.candidates ?? null };
    report.ok = false;
  }
  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return EXIT.ok;
  }

  if (opts.check) {
    const report = await runCheck(opts);
    printJson(report);
    return report.ok ? EXIT.ok : EXIT.workspace;
  }

  const files = listSourceFiles(opts);
  if (!files.length) throw new UsageError("没有要入库的文件。给一个或多个文件路径，或用 --dir <目录>。");
  if (opts.title && files.length > 1) throw new UsageError("--title 只对单篇有意义；批量请让每篇自带 H1 标题。");

  // 桥通道不需要本地工作区路径（写盘发生在应用侧）；只在收件箱通道（或试运行）才解析，
  // 免得「有多个候选笔记本」把一条本来能成功的桥投递无谓地毙掉。
  const resolved = opts.channel === "bridge" && !opts.dryRun
    ? { root: null, how: "桥通道不需要本地工作区路径" }
    : await resolveWorkspaceForRun(opts);
  const at = new Date();
  const results = [];

  let bridgeContext = null;
  if (opts.channel === "bridge") {
    const bridge = await probeBridge(opts.endpoint);
    if (!bridge) throw new IngestError("IMP-1001", EXIT.connect, "连不上本地桥。请在 Opennote 里开启「设置 · 文件 · 导入与接口」，并确认桌面版正在运行。");
    const token = resolveToken(opts);
    if (!token.token) throw new IngestError("IMP-2001", EXIT.auth, "没有找到访问令牌。请把 Opennote「导入与接口」里的令牌设进 OPENNOTE_TOKEN，或用 --token 传入。");
    const auth = await checkBridgeAuth(bridge.endpoint, token.token);
    // 只有「明确 401」才提前失败；其余情况（探测不可用 / 老版本桥）交给真实请求，
    // 让回执里的错误码说话 —— 探针是启发式，回执才是真相。
    if (auth === "invalid") throw new IngestError("IMP-2002", EXIT.auth, "访问令牌不正确或已失效。请在 Opennote 的「导入与接口」里重新复制令牌。");
    bridgeContext = { endpoint: bridge.endpoint, token: token.token, auth };
  }

  for (const file of files) {
    const label = path.relative(process.cwd(), file) || file;
    try {
      const prepared = envelopeFor(file, opts, at);
      const bodyBytes = Buffer.byteLength(prepared.envelope.body, "utf8");
      if (opts.dryRun) {
        results.push({ ok: true, action: "dry-run", file: label, importId: prepared.envelope.importId, title: prepared.envelope.title, target: prepared.envelope.target.folder, tags: prepared.envelope.tags, adjustedTags: prepared.adjustedTags, truncatedTags: prepared.truncatedTags, bodyBytes, assets: prepared.assets.map((asset) => asset.name), envelope: prepared.envelope });
        continue;
      }
      if (opts.channel === "inbox") {
        const outcome = deliverToInbox(resolved.root, prepared.envelope, prepared.assets, opts);
        results.push({
          ok: true,
          action: outcome.skipped ? "skipped" : "queued",
          file: label,
          importId: outcome.importId,
          title: prepared.envelope.title,
          dirName: outcome.dirName,
          // 只有真投出去才有条目状态；跳过时给的是**既有条目**的状态与原因。
          entryStatus: outcome.skipped ? outcome.status : "pending",
          reason: outcome.reason ?? null,
          nextStep: outcome.nextStep ?? null,
          forced: outcome.forced ?? false,
          replacedDirName: outcome.replacedDirName ?? null,
          tags: prepared.envelope.tags,
          adjustedTags: prepared.adjustedTags,
          truncatedTags: prepared.truncatedTags,
          bodyBytes,
        });
      } else {
        const outcome = await deliverToBridge(bridgeContext.endpoint, bridgeContext.token, prepared.note, opts);
        if (outcome.ok) {
          results.push({
            ok: true,
            action: outcome.action,
            file: label,
            importId: prepared.envelope.importId,
            title: prepared.envelope.title,
            result: outcome.result,
            receiptStatus: outcome.status,
            // action=queued 时说清「还在收件箱」；action=skipped 时说清为什么没写盘。
            inboxId: outcome.result?.inboxId ?? null,
            notePath: outcome.result?.path ?? null,
            reason: outcome.action === "skipped" ? outcome.status : null,
            bodyBytes,
          });
        } else {
          results.push({ ok: false, action: "failed", file: label, importId: prepared.envelope.importId, code: outcome.code, message: outcome.userMessage, userMessage: outcome.userMessage, exit: outcome.exit });
        }
      }
    } catch (error) {
      if (error instanceof IngestError) {
        results.push({ ok: false, action: "failed", file: label, code: error.code, message: error.message, userMessage: null, exit: error.exit });
      } else if (error instanceof UsageError) {
        throw error;
      } else if (error && error.code === "ENOENT") {
        results.push({ ok: false, action: "failed", file: label, code: "IMP-4003", message: `读不到源文件：${error.path ?? file}`, userMessage: null, exit: EXIT.usage });
      } else {
        results.push({ ok: false, action: "failed", file: label, code: "IMP-5001", message: error.message, userMessage: null, exit: EXIT.internal });
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  const summary = {
    ok: failed.length === 0,
    channel: opts.channel,
    workspace: resolved.root,
    workspaceHow: resolved.how,
    total: results.length,
    queued: results.filter((item) => item.action === "queued").length,
    skipped: results.filter((item) => item.action === "skipped").length,
    imported: results.filter((item) => item.action === "imported").length,
    failed: failed.length,
    dryRun: opts.dryRun,
    results,
  };

  if (opts.json) printJson(summary);
  else if (!opts.quiet) printHuman(summary, results);

  if (!failed.length) return EXIT.ok;
  const order = [EXIT.usage, EXIT.connect, EXIT.auth, EXIT.workspace, EXIT.ratelimit, EXIT.validation, EXIT.internal, EXIT.skipped];
  for (const code of order) {
    if (failed.some((item) => item.exit === code)) return code;
  }
  return EXIT.internal;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const SKIP_LABEL = {
  "already-imported": "这份内容已经入库过（同 importId 命中既有笔记）",
  "already-in-inbox": "已经在收件箱里等确认",
  "failed-in-inbox": "收件箱里那条上一次入库失败了，需要先丢弃再重投",
  deduped: "内容重复，未写盘（返回既有落点）",
  duplicate: "内容重复，未写盘（返回既有落点）",
  skipped: "被跳过，未写盘",
};

function printHuman(summary, results) {
  for (const item of results) {
    if (item.action === "queued" && item.dirName) {
      process.stdout.write(`✓ 已投递到收件箱（待确认）：${item.title}（条目 ${item.dirName}，${item.bodyBytes} 字节）\n`);
    } else if (item.action === "queued") {
      // 桥回执 status=pending：只进了收件箱，**没有**写成笔记。
      process.stdout.write(`✓ 已进入收件箱（待确认，未写成笔记）：${item.title}${item.inboxId ? `（条目 ${item.inboxId}）` : ""}\n`);
    } else if (item.action === "skipped") {
      const label = SKIP_LABEL[item.reason] ?? String(item.reason ?? "已存在");
      const where = item.dirName ? `，条目 ${item.dirName}` : item.notePath ? `，落点 ${item.notePath}` : "";
      process.stdout.write(`• 跳过：${item.title}（${label}${where}）\n`);
      if (item.nextStep) process.stdout.write(`  ↳ ${item.nextStep}\n`);
    } else if (item.action === "imported") {
      process.stdout.write(`✓ 已写成笔记：${item.notePath ?? item.result?.path ?? item.title}（${item.receiptStatus ?? "created"}）\n`);
    } else if (item.action === "dry-run") {
      process.stdout.write(`· 试运行：${item.title} → 落点 ${item.target || "（根目录）"}，${item.bodyBytes} 字节\n`);
    } else {
      process.stdout.write(`✗ 失败：${item.file} · ${item.code} ${item.userMessage ?? item.message ?? ""}\n`);
    }
  }
  process.stdout.write(
    `\n合计 ${summary.total} 篇：进收件箱 ${summary.queued} · 写成笔记 ${summary.imported} · 跳过 ${summary.skipped} · 失败 ${summary.failed}\n` +
      `笔记本：${summary.workspace ?? "（桥通道不需要本地路径 / 未解析）"}（${summary.workspaceHow}）\n`,
  );
  if (summary.queued > 0) {
    process.stdout.write("下一步：进收件箱的条目还不算笔记，请在 Opennote 收件箱里逐条点「导入」确认。\n");
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // 全局失败（用法错误 / 工作区解析失败）也要在 --json 下给出 JSON，
    // 否则 Agent 拿到的是 stderr 里的散文，无法按 code 分支。
    const wantsJson = process.argv.includes("--json");
    if (error instanceof UsageError) {
      if (wantsJson) printJson({ ok: false, error: { code: "USAGE", message: error.message, exit: EXIT.usage } });
      process.stderr.write(`用法错误：${error.message}\n\n${HELP}`);
      process.exit(EXIT.usage);
    }
    if (error instanceof IngestError) {
      if (wantsJson) printJson({ ok: false, error: { code: error.code, message: error.message, exit: error.exit, candidates: error.extra?.candidates ?? null } });
      process.stderr.write(`${error.code} ${error.message}\n`);
      process.exit(error.exit);
    }
    if (wantsJson) printJson({ ok: false, error: { code: "IMP-5001", message: String(error && error.message ? error.message : error), exit: EXIT.internal } });
    process.stderr.write(`内部错误：${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(EXIT.internal);
  });
