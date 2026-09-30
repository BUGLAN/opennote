#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Opennote 0.2.0 · 独立契约验证器（Verifier 产物，只读驱动，绝不修改产品代码）
 * ============================================================================
 *
 * 用途：把 `docs/import/02-接口契约-导入信封与通道.md`（+ 00/01/03 号）里的**硬性要求**
 * 变成可复跑的断言。判据以 Lead 蒸馏的权威口径为准（见 docs/verify/V1-契约与安全.md）。
 *
 * 语义：
 *   退出码 0  = 全部断言通过（FAIL 数 = 0；SKIP 不算通过，会在摘要里单独计数）
 *   退出码 1  = 有 FAIL，末尾打印失败清单（含证据）
 *   退出码 2  = 脚本自身出错（环境问题）
 *
 * 用法：
 *   node scripts/verify-contract.cjs              # 全部
 *   node scripts/verify-contract.cjs --dynamic    # 追加动态调用（Vite ssrLoadModule 载入 TS）
 *   node scripts/verify-contract.cjs --json       # 机器可读输出
 *
 * 关键设计：
 *   - 「变更面」= `git diff --name-only <BASELINE>` ∪ 未跟踪文件。基线默认 5a98f59
 *     （D01–D38 修复完成后的提交），可用 VERIFY_BASELINE 覆盖。
 *     这样即使队友把工作提交了，断言仍然只打在本次改动面上，可独立复跑。
 *   - 未落地的能力一律 **SKIP + 原因**，绝不写成 PASS。
 *   - 动态执行走 Vite 的 ssrLoadModule（仓库内已有 vite，无需新依赖）。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
/** 号段与文案的唯一真源：02 号附录 A.3。 */
const CONTRACT_DOC = "docs/import/02-接口契约-导入信封与通道.md";
/**
 * 文案列是「一个格子覆盖多种分支」的码，本就不可能逐字相等，显式排除出逐字比对。
 * `IMP-4011`：同一格同时描述 append 目标缺失 / overwrite 降级 / skip 命中三种情形，
 * 并附「后两种不提示」的说明；实现只保留 overwrite 降级那一句。
 */
const DOC_MULTI_CASE_CODES = new Set(["IMP-4011"]);
/**
 * 文案列虽是散文、但 Lead 裁定**必须**逐字比对的码（0.3.1）：
 * `IMP-1006` 的散文格里引用了桌面版那一句「这个导入方式需要 Opennote 桌面版」，
 * 裁定「以 `02` 附录 A.3（= 桥那句）为准」→ 对这个码不再 SKIP。
 */
const DOC_VERBATIM_DESPITE_PROSE = new Set(["IMP-1006"]);
const BASELINE = process.env.VERIFY_BASELINE || "5a98f59";
const ARGS = new Set(process.argv.slice(2));
const WANT_DYNAMIC = ARGS.has("--dynamic") || ARGS.has("--all");
const WANT_JSON = ARGS.has("--json");
/**
 * `--mutate-copy=<producer>`：**只在内存里**把某个产地的文案改一个字，用来做变异验证
 * （证明 C-6f 的断言对文案敏感、不是恒绿）。**绝不写盘、绝不动产品文件。**
 * 例：`node scripts/verify-contract.cjs --mutate-copy=main`
 */
const MUTATE_COPY = (() => {
  for (const arg of ARGS) {
    const m = /^--mutate-copy=(.+)$/.exec(arg);
    if (m) return m[1];
  }
  return null;
})();
/**
 * `--mutate-ex6=remote-src|eval`：**只在内存里**给被扫的 html 追加一段
 * `<script src="https://evil.example/x.js">` 或 `eval(...)`，用来证明 `EX-6` / `EX-7` 会红。
 * 这是 Lead 0.3.1 复核时要求的变异验证：改完必须红、去掉必须绿。**不写盘。**
 */
const MUTATE_EX6 = (() => {
  for (const arg of ARGS) {
    const m = /^--mutate-ex6=(.+)$/.exec(arg);
    if (m) return m[1];
  }
  return null;
})();

/* ------------------------------------------------------------------ 结果收集 */

const results = [];
let currentGroup = "(未分组)";

function group(title) {
  currentGroup = title;
  if (!WANT_JSON) console.log(`\n── ${title} ──`);
}

function record(status, id, title, detail) {
  const entry = { group: currentGroup, status, id, title, detail: detail == null ? "" : String(detail) };
  results.push(entry);
  if (!WANT_JSON) {
    const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : status === "INFO" ? "INFO" : "SKIP";
    console.log(`  ${mark}  [${id}] ${title}${entry.detail ? ` — ${entry.detail}` : ""}`);
  }
  return status === "PASS";
}

const pass = (id, title, detail) => record("PASS", id, title, detail);
const fail = (id, title, detail) => record("FAIL", id, title, detail);
const skip = (id, title, detail) => record("SKIP", id, title, detail);
const info = (id, title, detail) => record("INFO", id, title, detail);

/** 断言辅助：cond 为真 → PASS，否则 FAIL。 */
function check(id, title, cond, okDetail, badDetail) {
  return cond ? pass(id, title, okDetail) : fail(id, title, badDetail);
}

/* ------------------------------------------------------------------ 工具 */

function readIfExists(rel) {
  const abs = path.join(ROOT, rel);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dev-dist", "release", ".vite", "coverage", ".dsh-acl-report", ".gate-logs"]);

function walk(relDir, out = []) {
  const abs = path.join(ROOT, relDir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.posix.join(relDir.replace(/\\/g, "/"), entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".css", ".json", ".html", ".md", ".txt", ".yml", ".yaml"]);

function readTree(relDirs, filter) {
  const files = [];
  for (const dir of relDirs) {
    if (!exists(dir)) continue;
    for (const rel of walk(dir)) {
      if (filter && !filter(rel)) continue;
      files.push(rel);
    }
  }
  return files;
}

function grepFiles(files, pattern, options = {}) {
  const hits = [];
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  for (const rel of files) {
    const raw = readIfExists(rel);
    if (raw == null) continue;
    const text = options.strip ? stripComments(raw) : raw;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
      const scanner = new RegExp(re.source, flags);
      let m;
      while ((m = scanner.exec(lines[i])) !== null) {
        hits.push({ file: rel, line: i + 1, text: lines[i].trim(), match: m[0] });
        if (m.index === scanner.lastIndex) scanner.lastIndex += 1;
      }
    }
  }
  return hits;
}

/**
 * `grepFiles()` 的命中对象是 `{ file, line, text, match }`——**没有** `lines` 字段。
 * 需要上下文时按需重读该文件（不要假设命中对象带整份文件，那会得到 `undefined.slice`）。
 */
function lineWindow(hit, before = 2, after = 4) {
  const raw = readIfExists(hit.file);
  if (raw == null) return hit.text || "";
  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, hit.line - 1 - before);
  return lines.slice(start, hit.line + after).join("\n");
}

/**
 * 解析 `02` 号附录 A.3 的错误码表（**文档是号段的唯一真源**）。
 *
 * 表格行形如：`| \`IMP-5002\` | 触发条件 | 503 | userMessage | 处置建议 |`
 * 返回 `{ codes:Set<string>, rows:Map<code,{http,userMessage}> }`。
 */
function parseDocErrorTable() {
  const codes = new Set();
  const rows = new Map();
  const rel = CONTRACT_DOC;
  const raw = readIfExists(rel);
  if (raw == null) return { codes, rows };
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\|\s*`(IMP-\d{4})`\s*\|(.+)$/.exec(line);
    if (!m) continue;
    const code = m[1];
    codes.add(code);
    const cells = m[2].split("|").map((cell) => cell.trim());
    // 首个单元格 = 触发条件；其后依次为 http、userMessage（列数不足则留空）
    // 去掉 Markdown 反引号：`不能使用 `..`、绝对路径` 与实现的 `不能使用 ..、绝对路径` 是同一句。
    const http = (cells[1] || "").replace(/`/g, "").trim();
    const rawCopy = (cells[2] || "").trim();
    // 文档的「文案」列有两种写法，必须区分，否则会把注释当成正文（误报）：
    //   ① 逐字文案，可能带一个 `（…）` 注释**前缀**：`（不显示给用户）请求格式不被接受。`
    //   ② 说明性散文：`中文文案由调用方按平台覆盖：… → …`（该码没有唯一逐字文案）
    const annotated = /^（[^）]*）/.test(rawCopy);
    const prose = /由调用方|→|^见\s|见\s*§/.test(rawCopy);
    const userMessage = rawCopy.replace(/^（[^）]*）\s*/, "").replace(/^「|」$/g, "").replace(/`/g, "").trim();
    // http 列可能出现多个候选：`404 / 403`、`409 / 200`（同一码在不同分支下的状态码）。
    const httpOptions = http ? http.split(/\s*[/或]\s*/).filter(Boolean) : [];
    if (!rows.has(code)) rows.set(code, { http, httpOptions, userMessage, annotated, prose, rawCopy });
  }
  return { codes, rows };
}

/** 剥掉注释与字符串里的文档性反例，避免把注释当实现（注释里常写「不得 xxx」）。 */function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length))
    .replace(/^[ \t]*\*.*$/gm, (m) => " ".repeat(m.length));
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return null;
  }
}

/* ------------------------------------------------------- 变更面（本次改动） */

function changedFiles() {
  const tracked = git(["diff", "--name-only", BASELINE]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const set = new Set();
  for (const blob of [tracked, untracked]) {
    if (!blob) continue;
    for (const line of blob.split(/\r?\n/)) {
      const rel = line.trim().replace(/\\/g, "/");
      if (rel) set.add(rel);
    }
  }
  return [...set].sort();
}

const CHANGED = changedFiles();
const PRODUCT_CHANGED = CHANGED.filter((rel) => /^(src|electron|extension)\//.test(rel));

/* ------------------------------------------------ 规范中的权威常量（判据） */

/** 02 号附录 A.3 错误码索引（28 个 code）。 */
const ALLOWED_CODES = new Set([
  "IMP-1001", "IMP-1002", "IMP-1003", "IMP-1004", "IMP-1005", "IMP-1006",
  "IMP-2001", "IMP-2002", "IMP-2003", "IMP-2004",
  "IMP-3001", "IMP-3002", "IMP-3003", "IMP-3004", "IMP-3005",
  "IMP-4001", "IMP-4002", "IMP-4003", "IMP-4004", "IMP-4005", "IMP-4006", "IMP-4007",
  "IMP-4008", "IMP-4009", "IMP-4010", "IMP-4011", "IMP-4012", "IMP-4013", "IMP-4014",
  "IMP-4015", "IMP-4017", "IMP-4020",
  "IMP-5001",
]);

/** 02 号附录 A.3 警告码（8 个）。 */
const ALLOWED_WARNINGS = new Set([
  "IMP-W001", "IMP-W002", "IMP-W003", "IMP-W004", "IMP-W005", "IMP-W006", "IMP-W007", "IMP-W008",
]);

/** Lead 裁定的 ImportResult.status 枚举（逐字，无 queued / failed）。 */
const ALLOWED_STATUS = ["created", "appended", "deduped", "duplicate", "pending", "skipped"];

/** 02 号 3.2 front-matter 8 键固定顺序。 */
const FRONT_MATTER_KEYS = [
  "source", "source_title", "source_site", "author",
  "published_at", "captured_at", "tags", "opennote_import_id",
];

/** 规范冻结文案。 */
const COPY = {
  duplicate: "已在笔记中（未重复入库）。",
  duplicateOldVariant: "这条内容已经剪藏过了，未重复入库。",
};

/** 收件箱 5 态。 */
const INBOX_STATES = ["pending", "committing", "committed", "failed", "discarded"];

/* ==================================================================== §1 */

group("§1 环境与基线");

check("ENV-1", "规范文档 00–04 齐全", ["00-项目简报与范围锁定.md", "01-PRD-剪藏与导入需求.md", "02-接口契约-导入信封与通道.md", "03-UI设计规范-剪藏与导入.md", "04-评审报告-一致性核查.md"].every((n) => exists(`docs/import/${n}`)),
  "docs/import/00–04 均存在");

check("ENV-2", `基线提交 ${BASELINE} 可解析`, git(["cat-file", "-t", BASELINE]) !== null && git(["cat-file", "-t", BASELINE]).trim() === "commit",
  `${BASELINE} 是 commit`);

const featureFiles = PRODUCT_CHANGED.filter((rel) => TEXT_EXT.has(path.extname(rel)) && !/\.(test|spec)\./.test(rel));
info("ENV-3", "本次改动面（产品代码）", featureFiles.length ? `${featureFiles.length} 个文件: ${featureFiles.join(", ")}` : "0 个 —— 各线尚未落地");

if (!featureFiles.length) {
  info("ENV-4", "结论前置说明", "改动面为空：§2–§9 的错误码/文案/令牌类断言仍会在全仓扫描（对本仓库实时有效），但「新增代码」类断言会 SKIP");
}

/* ==================================================================== §2 */

group("§2 契约字段名 / 枚举 / 错误码");

const srcFiles = readTree(["src"], (rel) => TEXT_EXT.has(path.extname(rel)) && !/\.(test|spec)\./.test(rel));
const electronFiles = readTree(["electron"], (rel) => TEXT_EXT.has(path.extname(rel)));
const extensionFiles = readTree(["extension"], (rel) => TEXT_EXT.has(path.extname(rel)));
const allProductFiles = [...srcFiles, ...electronFiles, ...extensionFiles];

/**
 * 「产品代码」判定：测试与自测脚本不算产品代码。
 *
 * 理由（Verifier 纪律：先排除误报再报缺陷）：
 *   - `extension/tests/*.mjs` 是测试夹具——测试里出现 emoji 标签（验证 Unicode 标签过滤）、
 *     或为了拿一个空闲端口而短暂 `listen(0)`，都不是产品行为；
 *   - `extension/verify.mjs` 是作者自测脚本，输出用 ✓/✗ 属正常。
 * 契约里「桥不得绑 0 端口」「产品代码无 emoji」约束的是**产品代码**，不是测试。
 * 因此这四类检查一律走 `productFiles`，测试文件单列 INFO。
 */
const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec|bench)\.[cm]?[jt]sx?$/i;
const SELFVERIFY_RE = /(^|\/)verify(-[\w.]+)?\.[cm]?js$/i;
const isTestPath = (rel) => TEST_PATH_RE.test(rel);
const isSelfVerify = (rel) => SELFVERIFY_RE.test(rel);
/** 产品代码 = 改动面 − 测试 − 自测脚本。 */
const productFiles = allProductFiles.filter((rel) => !isTestPath(rel) && !isSelfVerify(rel));
const testFiles = allProductFiles.filter((rel) => isTestPath(rel) || isSelfVerify(rel));

// 活动面：优先只看改动文件；改动面为空时退化为全仓产品文件（此时相关断言会自然 SKIP）
const scopeFiles = featureFiles.length ? featureFiles : allProductFiles;

// C-1/C-2 status 枚举：只在「导入回执」上下文里判定，避免把桥自身的
// state.status（running|starting|port-busy|failed）误判成 ImportResult.status。
{
  const receiverFiles = scopeFiles.filter((rel) => /clip|import|envelope/i.test(rel) && /\.(ts|tsx|js|cjs)$/.test(rel));
  const blob = receiverFiles.map((rel) => readIfExists(rel) || "").join("\n");

  if (!featureFiles.length || !receiverFiles.length) {
    skip("C-1", `status 枚举 ${ALLOWED_STATUS.length} 值（created/appended/deduped/duplicate/pending/skipped）`, "接收端尚未落地");
    skip("C-2", "ImportResult.status 不得含 queued / failed", "接收端尚未落地");
  } else {
    // 1) 从 TS 联合类型 / 常量数组里抽出「回执状态」的真实取值集合
    const unionMembers = new Set();
    for (const m of blob.matchAll(/(?:status|Status)\s*[:=][^=\n]{0,60}=\s*([^\n;]*)/g)) {
      for (const lit of m[1].matchAll(/["'`]([a-z][a-z-]*)["'`]/g)) unionMembers.add(lit[1]);
    }
    for (const m of blob.matchAll(/(?:status|Status)\s*:\s*((?:\s*["'`][a-z][a-z-]*["'`]\s*\|?)+)/g)) {
      for (const lit of m[1].matchAll(/["'`]([a-z][a-z-]*)["'`]/g)) unionMembers.add(lit[1]);
    }
    for (const m of blob.matchAll(/(?:STATUS|STATUSES|Status)\w*\s*[:=][^=]*\[([\s\S]{0,400}?)\]/g)) {
      for (const lit of m[1].matchAll(/["'`]([a-z][a-z-]*)["'`]/g)) unionMembers.add(lit[1]);
    }
    const declared = ALLOWED_STATUS.filter((s) => unionMembers.has(s));
    const illegal = [...unionMembers].filter((s) => !ALLOWED_STATUS.includes(s));
    check("C-1", `回执 status 枚举齐全且逐字（${ALLOWED_STATUS.join("|")}）`, declared.length >= 4,
      `已声明 ${declared.length} 个: ${declared.join(", ")}`,
      `仅声明 ${declared.length} 个: ${declared.join(", ") || "(无)"}`);
    check("C-2", "ImportResult.status 不得含 queued / failed", !illegal.includes("queued") && !illegal.includes("failed"),
      `枚举成员: ${[...unionMembers].join(", ") || "(未抽到)"}`,
      `越界状态值: ${illegal.join(", ")}`);
  }
  // `queued` 只允许作为**扩展通道级本地状态**（02 §5.7.7 `queued_offline` → 收件箱 pending）；
  // 协议回执（src/lib/clip、electron、src/desktop）里出现 `queued` 即违规。
  const protocolFiles = allProductFiles.filter((rel) => /^(src\/lib\/clip|electron|src\/desktop)\//.test(rel) && /\.(ts|cjs|js)$/.test(rel));
  const queuedAsStatus = grepFiles(protocolFiles, /["'`]queued["'`]\s*[,)\]]/, { strip: true });
  check("C-2b", "协议回执里不得把 `queued` 当作 status 值（扩展本地态除外）", queuedAsStatus.length === 0, "0 处",
    queuedAsStatus.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  const extQueued = grepFiles(allProductFiles.filter((rel) => rel.startsWith("extension/")), /["'`]queued["'`]/, { strip: true });
  info("C-2c", "扩展本地通道状态中的 queued（02 §5.7.7 允许）", extQueued.length ? `${extQueued.length} 处，见 ${[...new Set(extQueued.map((h) => h.file))].join(", ")}` : "0 处");
}

// C-3 回执字段名
{
  const required = ["revertible", "preimage", "deduped", "dedupedBy", "inboxId", "warnings"];
  const blob = scopeFiles.map((rel) => readIfExists(rel) || "").join("\n");
  if (!featureFiles.length) {
    skip("C-3", "回执字段名（revertible/preimage/deduped/dedupedBy/inboxId/warnings）", "改动面为空");
  } else {
    const missing = required.filter((name) => !new RegExp(`\\b${name}\\b`).test(blob));
    check("C-3", "回执字段名齐全", missing.length === 0, required.join(", "), `缺少: ${missing.join(", ")}`);
    // path 而非 notePath 作为回执落点字段
    const badNotePath = grepFiles(scopeFiles, /(result|Result)[^\n]*\bnotePath\b/);
    check("C-4", "回执落点字段名为 path（不得用 notePath）", badNotePath.length === 0, "未发现 result.notePath",
      badNotePath.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(" | "));
  }
}

// C-5 错误响应形状
{
  const blob = scopeFiles.map((rel) => readIfExists(rel) || "").join("\n");
  if (!featureFiles.length) skip("C-5", "错误响应形状 {code,message,userMessage,http,retryable,detail}", "改动面为空");
  else {
    const fields = ["code", "message", "userMessage", "http", "retryable", "detail"];
    const missing = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(blob));
    check("C-5", "错误响应 6 字段齐全", missing.length === 0, fields.join(", "), `缺少: ${missing.join(", ")}`);
  }
}

// C-6 错误码 / 警告码号段（**以 02 号附录 A.3 的表格为准**，而不是以本脚本的硬编码清单为准）
{
  const codeHits = grepFiles(allProductFiles, /IMP-\d{4}/g);
  const docCodes = parseDocErrorTable().codes;
  const docReadable = docCodes.size > 0;

  if (!docReadable) {
    skip("C-6", "错误码号段（02 附录 A.3）", "02 号文档不可读或附录 A.3 表格解析失败");
  } else {
    const unknown = [...new Set(codeHits.map((h) => h.match))].filter((c) => !docCodes.has(c));
    check("C-6", `代码中出现的 IMP-#### 均已在 02 附录 A.3 登记（文档共 ${docCodes.size} 个）`, unknown.length === 0,
      codeHits.length ? `${codeHits.length} 处引用，全部已登记` : "0 处引用（尚未落地）",
      `未登记码: ${unknown.join(", ")}`);
    // 本脚本硬编码的那份清单只作为「文档不可读时的兜底」；它不得登记文档里没有的码。
    const stale = [...ALLOWED_CODES].filter((c) => !docCodes.has(c));
    check("C-6b", "本脚本硬编码清单是文档号段的子集（防止脚本自己漂移）", stale.length === 0,
      `${ALLOWED_CODES.size} 个硬编码码全部在文档里`, `脚本里有文档未登记的码: ${stale.join(", ")}`);
  }

  // C-6c：桥的错误表与 02 附录 A.3 逐字一致（http + userMessage）。
  // 这条是「文档改了、实现没改」或「实现改了、文档没改」的双向护栏。
  try {
    const table = parseDocErrorTable().rows;
    const bridge = require(path.join(ROOT, "electron", "bridge.cjs"));
    const impl = bridge.ERROR_TABLE || {};
    const mismatched = [];
    const proseRows = [];
    const multiCaseRows = [];
    const verbatimProse = [];
    const verbatimProseBad = [];
    let compared = 0;
    for (const [code, row] of table) {
      const entry = impl[code];
      if (!entry) continue;
      /**
       * 文案列写成说明性散文的码（没有唯一逐字文案，如 `IMP-1006`「由调用方按平台覆盖」）
       * 一般不参与逐字比对，只记一条观测——否则会拿散文当正文，报出假缺陷。
       *
       * **0.3.1（Lead 裁定）例外**：`IMP-1006` 的散文格里**引用了**桌面版那一句
       * （`「这个导入方式需要 Opennote 桌面版」`），裁定「以 `02` 附录 A.3（= 桥那句）为准」。
       * 所以这个码**不再 SKIP**：把散文格里被「」引用的句子取出来与桥表逐字比对，
       * 只归一化句末句号（文档里是行内引用，不带句号；实现里是完整句子）。
       * 取不到任何引用句 → 报 FAIL（不允许「悄悄退回 SKIP」）。
       */
      if (row.prose) {
        if (DOC_VERBATIM_DESPITE_PROSE.has(code)) {
          const quoted = [...String(row.rawCopy || "").matchAll(/「([^」]+)」/g)].map((q) => q[1]);
          const norm = (s) => String(s).replace(/[。．.]$/, "");
          const hit = quoted.find((q) => norm(q) === norm(entry.userMessage));
          verbatimProse.push(
            `${code}: 从 A.3 散文格取到 ${quoted.length} 个引用句，桥表「${entry.userMessage}」${hit ? `与引用句「${hit}」逐字一致（句末句号归一）` : "**与任何引用句都不一致**"}`,
          );
          if (!hit) {
            verbatimProseBad.push(`${code}: A.3 引用句=[${quoted.join(" / ")}] ≠ 桥表「${entry.userMessage}」`);
          }
          continue;
        }
        proseRows.push(code);
        continue;
      }
      // `IMP-4011` 的文案列是**多情形复合说明**（append 目标缺失 / overwrite 降级 / skip 命中
      // 三种情形共用一格，并附「后两种不提示」的说明），实现里只保留 overwrite 降级那一句
      // 「「覆盖」不可用，已改为新建一篇。」——两者本就不可能逐字相等，显式排除并记录。
      if (DOC_MULTI_CASE_CODES.has(code)) {
        multiCaseRows.push(code);
        continue;
      }
      compared += 1;
      // http 允许多候选：文档写 `409 / 200` 时，实现取其中之一即算一致。
      if (row.httpOptions.length && !row.httpOptions.includes("—") && !row.httpOptions.includes(String(entry.http))) {
        mismatched.push(`${code} http: 文档 ${row.http} ≠ 实现 ${entry.http}`);
      }
      if (row.userMessage && entry.userMessage !== row.userMessage) {
        mismatched.push(`${code} userMessage: 文档「${row.userMessage}」≠ 实现「${entry.userMessage}」`);
      }
    }
    check("C-6c", "桥 ERROR_TABLE 与 02 附录 A.3 的 http / userMessage 逐字一致", mismatched.length === 0,
      `${compared} 个码逐字比对通过`, mismatched.slice(0, 4).join(" | "));
    if (proseRows.length) {
      info("C-6d", "文案列是说明性散文（无唯一逐字文案），不参与逐字比对", proseRows.join(", "));
    }
    // C-6d′：IMP-1006 不再 SKIP（Lead 0.3.1 裁定：以 02 附录 A.3 的引用句为准）。
    if (verbatimProse.length) {
      check("C-6d′", "`IMP-1006` 虽在散文格里，但其引用句可与桥表逐字比对（不再 SKIP）",
        verbatimProseBad.length === 0, verbatimProse.join(" | "), verbatimProseBad.join(" | "));
    } else {
      fail("C-6d′", "`IMP-1006` 的散文格解析退化：没有取到任何可比的引用句（不允许悄悄退回 SKIP）", "tap 无输出");
    }
    if (multiCaseRows.length) {
      info("C-6e", "文案列是多情形复合说明（一个格子覆盖多种分支），不参与逐字比对", multiCaseRows.join(", "));
    }
  } catch (error) {
    skip("C-6c", "桥 ERROR_TABLE 与文档逐字比对", error && error.message ? error.message : String(error));
  }

/* ---------------------------------------------------------------- C-6f 多产地 */
//
// **为什么单列**：同一个语义值（错误码的 `userMessage`）被**复制到 N 处**，
// 而 `C-6c` 只盖住了其中 1 处（桥的 `ERROR_TABLE`）。本轮实测的产地：
//   ① `electron/bridge.cjs` 的 `ERROR_TABLE`      ← C-6c 盖住
//   ② `electron/main.cjs` 的 `NO_WINDOW_ERROR()`   ← 曾漏（本轮 Lead 修的）
//   ③ `src/lib/clip/envelope.ts` 的 `IMPORT_ERRORS`
//   ④ `src/data/inbox.ts` 的 `MESSAGES`
//   ⑤ `extension/src/lib/errors.js`（+ `dist/`，即装进浏览器的产物）
// 它们目前**逐字相同**，但**谁改一份另外几份不会跟着变**，而 `pnpm test` 与 `C-6c` 都发现不了。
// **凡是「一个语义值被复制到 N 处」的地方，护栏必须覆盖全部 N 处**，否则第 N+1 次改动必然漂移。
{
  /**
   * 取出 `userMessage: "…"` / `userMessage: '…'` 的文案。
   * 用**反引用**匹配引号，这样文案里含反引号（例如「不能使用 `..`、绝对路径」）也不会被截断。
   */
  const userMessageIn = (body) => {
    const m = /userMessage\s*:\s*(["'`])((?:(?!\1)[\s\S])*?)\1/.exec(body);
    return m ? m[2] : null;
  };
  /**
   * **括号配平**：从 `{` 找到与它配对的 `}`，跳过字符串字面量里的括号。
   * 这样每条记录的范围是**精确的**——不会像「窗口到下一个键」那样，
   * 把文件后半段某个无关的 `userMessage:`（例如 `bridge.cjs:787` 那句「配对功能已删除」的说明）
   * 吸进某个没有 `userMessage` 的记录里。
   */
  const matchBrace = (src, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        i += 1;
        while (i < src.length && src[i] !== ch) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  };
  /** 读一个字符串字面量，返回 `{ value, end }`。 */
  const readLiteral = (src, idx) => {
    const quote = src[idx];
    let i = idx + 1;
    let out = "";
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") {
        out += src[i + 1] || "";
        i += 2;
        continue;
      }
      out += src[i];
      i += 1;
    }
    return { value: out, end: i };
  };
  /**
   * **逐条取词（配平式）**：定位每个 `"IMP-xxxx":` 键，然后
   *   · 值是大括号块 → 配平到它的 `}`，在块内找 `userMessage:`；
   *   · 值是字符串字面量 → 直接取（`inbox.ts` 的 `MESSAGES` 形态）。
   *
   * **为什么不能再用 `{…}` 那种正则**（V5 的教训，Lead 复核确认）：
   * 旧写法 `/["']IMP-(\d{4})["']\s*:\s*\{([\s\S]{0,400}?)\n\s*\}/g` 要求 `{` 与 `}` 之间**有换行**，
   * 而 `electron/bridge.cjs` 的 `ERROR_TABLE` 是**一行一条**（`'IMP-1001': { … },`），
   * 于是**整张表被吞成一次匹配**：实测 34 个码只比了 1 个（`envelope.ts` 也漏 2 个）——
   * 这条「多产地护栏」自己**静默漏掉了 97% 的产地**。配平扫描不依赖缩进/换行风格，
   * 且键位码数可独立复核（C-6h）。
   */
  const balanceCopies = (text, strip = true) => {
    const source = strip ? stripComments(text) : text;
    const keyRe = /["']IMP-(\d{4})["']\s*:/g;
    const copies = new Map(); // code → 文案
    const invisible = new Set(); // code → 明确写了 `userMessage: null`（契约上不可见）
    const keys = new Set();
    let m;
    while ((m = keyRe.exec(source)) !== null) {
      const code = `IMP-${m[1]}`;
      keys.add(code);
      let pos = m.index + m[0].length;
      while (pos < source.length && /\s/.test(source[pos])) pos += 1;
      let body = null;
      if (source[pos] === "{") {
        const close = matchBrace(source, pos);
        if (close < 0) continue;
        body = source.slice(pos, close + 1);
      } else if (source[pos] === '"' || source[pos] === "'" || source[pos] === "`") {
        body = `__literal__${source.slice(pos, readLiteral(source, pos).end + 1)}`;
      } else {
        continue; // 既不是块也不是字面量（例如对象简写），不猜
      }
      const value = userMessageIn(body);
      if (value != null) {
        if (!copies.has(code)) copies.set(code, value);
      } else if (/userMessage\s*:\s*null/.test(body)) {
        invisible.add(code);
      } else if (body.startsWith("__literal__")) {
        const lit = body.slice("__literal__".length);
        if (!copies.has(code)) copies.set(code, lit.slice(1, -1));
      }
    }
    return { copies, invisible, keyed: [...keys] };
  };
  const asPlain = (map) => ({ copies: map, invisible: new Set(), keyed: [...map.keys()] });
  /** `main.cjs` 的 `importError('IMP-4006', '文案', 409, true)` 形态。 */
  const importErrorCopies = (text) => {
    const out = new Map();
    const source = stripComments(text);
    const re = /importError\(\s*["']IMP-(\d{4})["']\s*,\s*["']([^"']*)["']/g;
    let m;
    while ((m = re.exec(source)) !== null) out.set(`IMP-${m[1]}`, m[2]);
    return out;
  };

  /** 产地清单：id → { file, extract } */
  const PRODUCERS = [
    { id: "bridge", label: "electron/bridge.cjs ERROR_TABLE", file: "electron/bridge.cjs", extract: balanceCopies },
    { id: "main", label: "electron/main.cjs NO_WINDOW_ERROR()", file: "electron/main.cjs", extract: (t) => asPlain(importErrorCopies(t)) },
    { id: "envelope", label: "src/lib/clip/envelope.ts IMPORT_ERRORS", file: "src/lib/clip/envelope.ts", extract: balanceCopies },
    { id: "inbox", label: "src/data/inbox.ts MESSAGES", file: "src/data/inbox.ts", extract: balanceCopies },
    { id: "ext-errors", label: "extension/src/lib/errors.js", file: "extension/src/lib/errors.js", extract: balanceCopies },
    { id: "ext-dist", label: "extension/dist/lib/errors.js（产物）", file: "extension/dist/lib/errors.js", extract: balanceCopies },
  ];

  try {
    const docRows = parseDocErrorTable();
    const mismatches = [];
    const annotated = [];
    const multiCaseSeen = [];
    const coverage = [];
    const coverageGaps = [];
    const perProducer = [];
    for (const producer of PRODUCERS) {
      const text = readIfExists(producer.file);
      if (text == null) {
        perProducer.push(`${producer.id}: 文件不存在`);
        continue;
      }
      const { copies, invisible, keyed } = producer.extract(text);

      /* ---- C-6h 取词器覆盖率自检（**独立复核**，不依赖取词器自己的输出） ----
       * 规则：**每个键位 IMP 码都必须有归宿** —— 要么取到文案，要么显式标记 `userMessage: null`。
       * 有码既没文案也没标记 = 取词器漏了它。
       * 旧取词器在这里会报出 `bridge: 键位 34 个码，只取到 1 个（未认领：IMP-1001…IMP-5002）`，
       * 也就是说这条「多产地护栏」自己静默漏掉了 97% 的产地。 */
      const distinctKeys = [...new Set(keyed)];
      const unclaimed = distinctKeys.filter((c) => !copies.has(c) && !invisible.has(c));
      if (unclaimed.length) {
        coverageGaps.push(`${producer.id}: 键位有 ${distinctKeys.length} 个码，取到文案 ${copies.size} 个、标记不可见 ${invisible.size} 个；**未认领 ${unclaimed.length} 个：${unclaimed.join(", ")}**`);
      }
      coverage.push(`${producer.id}: 键位 ${distinctKeys.length} 个码／取到文案 ${copies.size} 个${invisible.size ? `／按契约不可见 ${invisible.size} 个` : ""}`);

      let compared = 0;
      for (const [code, copy] of copies) {
        const row = docRows.rows.get(code);
        if (!row || row.prose || !row.userMessage) continue;
        /**
         * 一个格子覆盖多种分支的码（`IMP-4011`）：**逐字比对不成立**，与 `C-6c` 同口径。
         * 实测依据：`02:1704` 那一行是「「追加」的目标不存在，已改为新建一篇。」
         * +注解「（overwrite 降级与 skip 情形不提示…）」，而 `bridge.cjs:122` 给的是
         * 「「覆盖」不可用，已改为新建一篇。」—— 同一个码的**不同触发分支**，
         * 按 Lead 对 `IMP-4013` 的同类裁定：记 INFO，不判 FAIL。
         */
        if (DOC_MULTI_CASE_CODES.has(code)) {
          multiCaseSeen.push(`${code} @ ${producer.id}: 实现「${copy}」（文档该行是多分支复合说明，不逐字比）`);
          continue;
        }
        // 变异验证：**只在内存里**给指定产地的文案加后缀（不写盘）。用于证明本断言会红。
        // `--mutate-copy=bridge:IMP-4007` 可以精确指定某个码（用于证明「中间那一行」也真的在被比）。
        const [mutateTarget, mutateCode] = String(MUTATE_COPY || "").split(":");
        const actual = mutateTarget === producer.id && (!mutateCode || mutateCode === code) ? `${copy}（变异）` : copy;
        compared += 1;
        if (actual === row.userMessage) continue;
        /**
         * 「文案 + 给实现者的注解」混在一个格子里的情况（Lead 裁定：文档格混注释是**文档排版**，
         * 不是缺陷）。口径与 C-6d/C-6e 一致：取第一个 `（`/`(` 之前的部分当 `userMessage` 基准，
         * **并且把这一格显式记成 INFO**（不静默跳过）。
         *
         * 只在「原样比不过、但截断后完全相同」时才走这条路 —— 这样它**不会**把真的漂移洗成通过。
         */
        const cut = row.userMessage.split(/[（(]/)[0].trim();
        // 文档格常用 `「…」` 把整段文案（含注解）括起来，而解析时会吃掉外层的前引号，
        // 于是「第一个（之前」的部分可能少一个开头的 `「`。两种候选都试。
        const candidates = [cut, cut && !cut.startsWith("「") ? `「${cut}` : null].filter(Boolean);
        const hit = cut && cut !== row.userMessage ? candidates.find((c) => actual === c) : null;
        if (hit) {
          annotated.push(`${code} @ ${producer.id}: 文档格混有注解，已按「第一个（之前」为基准（${JSON.stringify(row.userMessage)} → ${JSON.stringify(hit)}）`);
          continue;
        }
        mismatches.push(`${code} @ ${producer.id}: 文档「${row.userMessage}」≠ 实现「${actual}」`);
      }
      perProducer.push(`${producer.id}: ${compared} 个码`);
    }
    check("C-6f", "同一错误码的**全部产地**与 02 附录 A.3 的 userMessage 逐字一致（不只桥那一张表）",
      mismatches.length === 0,
      `${PRODUCERS.length} 个产地已比（${perProducer.join("、")}）`,
      mismatches.slice(0, 6).join(" | "));
    // 覆盖率**每次都打印**（不再只在 okDetail 里），这样「比了几个码」是可见的，
    // 而不是等到某天发现「原来一直只比了 1 个」。
    info("C-6f·覆盖", "每个产地的取词覆盖（键位码数 / 实际取到 / 不可见 / userMessage 字面量）", coverage.join(" | "));
    check("C-6h", "取词器**不静默漏码**：文件里每处 `userMessage: \"…\"` 都被某个 IMP 键的窗口认领",
      coverageGaps.length === 0,
      `6 个产地的取词覆盖率自检通过（${coverage.join("；")}）`,
      coverageGaps.join(" | "));
    if (annotated.length) {
      info("C-6f′", "文档文案格混有「给实现者的注解」，已按「第一个（之前」为基准比对（口径同 C-6d/C-6e）",
        annotated.join(" | "));
    }
    if (multiCaseSeen.length) {
      info("C-6f″", "多分支复合码（一个文档格覆盖多种情形）不逐字比对，只登记实现的实际文案（口径同 C-6c）",
        multiCaseSeen.join(" | "));
    }
    if (MUTATE_COPY) {
      info("C-6f·变异", `已对产地「${MUTATE_COPY}」注入内存变异（不写盘）`,
        mismatches.length ? `断言如期变红：${mismatches.length} 处不一致` : "**断言没有变红 —— 说明这条检查是恒绿的，必须修**");
    }
  } catch (error) {
    skip("C-6f", "多产地 userMessage 逐字比对", error && error.message ? error.message : String(error));
  }
}

  const warnHits = grepFiles(allProductFiles, /IMP-W\d{3}/g);  const unknownW = [...new Set(warnHits.map((h) => h.match))].filter((c) => !ALLOWED_WARNINGS.has(c));
  check("C-7", `代码中出现的 IMP-W### 均在附录内（${ALLOWED_WARNINGS.size} 个合法警告码）`, unknownW.length === 0,
    warnHits.length ? `${warnHits.length} 处引用，全部合法` : "0 处引用（尚未落地）",
    `未登记警告码: ${unknownW.join(", ")}`);
}

// C-8 warnings 为 string[]（Lead 裁定），不得是 {code,...} 对象数组
{
  const bad = grepFiles(allProductFiles, /warnings[\s\S]{0,80}?\bcode\s*:/);
  const objArr = grepFiles(allProductFiles, /warnings\s*:\s*\[\s*\{\s*code/);
  check("C-8", "warnings[] 是 string[]（不是 {code,message} 对象数组）", objArr.length === 0,
    "未发现对象数组写法",
    objArr.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  void bad;
}

// C-9 术语与越界能力禁令
{
  const banned = [
    { re: /所有平台都支持/, label: "「所有平台都支持导入接口」" },
    { re: /fetch\(\s*(env\.)?source\.url/, label: "应用抓取 source.url" },
    { re: /opennote:\/\/clip\?url=[^\n]*&fetch=1/, label: "opennote://clip?url=…&fetch=1" },
  ];
  for (const [i, item] of banned.entries()) {
    const hits = grepFiles(allProductFiles, item.re);
    check(`C-${9 + i}`, `禁用项：${item.label}`, hits.length === 0, "0 处",
      hits.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  }
}

/* ==================================================================== §3 */

group("§3 front-matter 字节模板（8 键 / 行内 tags / 无 BOM / 末尾单换行）");

{
  const blob = scopeFiles.map((rel) => readIfExists(rel) || "").join("\n");
  if (!featureFiles.length) {
    skip("FM-1", `8 键固定顺序 ${FRONT_MATTER_KEYS.join(" → ")}`, "改动面为空");
    skip("FM-2", "null 值整行省略（不得写 key: null）", "改动面为空");
    skip("FM-3", "tags: [a, b] 行内数组", "改动面为空");
    skip("FM-4", "不写 BOM", "改动面为空");
  } else {
    // 优先直接解析 FRONT_MATTER_KEYS 常量数组（精确），否则退化为「首次出现位置递增」
    let declaredKeys = null;
    for (const rel of scopeFiles) {
      const text = readIfExists(rel) || "";
      const m = /FRONT_MATTER_KEYS[^=]*=\s*\[([\s\S]*?)\]\s*(?:as const)?/.exec(text);
      if (m) {
        declaredKeys = [...m[1].matchAll(/["'`]([a-z_]+)["'`]/g)].map((x) => x[1]);
        break;
      }
    }
    if (declaredKeys) {
      const sameOrder = declaredKeys.length === FRONT_MATTER_KEYS.length && declaredKeys.every((k, i) => k === FRONT_MATTER_KEYS[i]);
      check("FM-1", `8 键固定顺序 ${FRONT_MATTER_KEYS.join(" → ")}`, sameOrder,
        `FRONT_MATTER_KEYS = ${declaredKeys.join(" → ")}`,
        `实际 ${declaredKeys.join(" → ")}（${declaredKeys.length} 键）`);
    } else {
      const positions = FRONT_MATTER_KEYS.map((k) => blob.indexOf(k));
      const present = positions.every((p) => p >= 0);
      const ordered = present && positions.every((p, i) => i === 0 || p > positions[i - 1]);
      check("FM-1", `8 键固定顺序 ${FRONT_MATTER_KEYS.join(" → ")}`, ordered,
        "首次出现位置递增，顺序正确",
        present ? `顺序错乱，位置: ${positions.join(",")}` : `缺少键: ${FRONT_MATTER_KEYS.filter((k) => blob.indexOf(k) < 0).join(", ")}`);
    }

    // FM-2 只检查**front-matter 渲染器**里的 null 处理：信封归一化把可选字段赋 null 是合法的。
    const fmFiles = scopeFiles.filter((rel) => {
      const text = readIfExists(rel);
      return text != null && text.includes("opennote_import_id") && /\.(ts|tsx|js|cjs)$/.test(rel);
    });
    const nullLiteral = fmFiles.length
      ? grepFiles(fmFiles, /(source|source_title|source_site|author|published_at|captured_at|tags|opennote_import_id)\s*:\s*null/, { strip: true })
      : [];
    check("FM-2", "front-matter 里 null 值整行省略（不得写 `键: null`）", nullLiteral.length === 0,
      fmFiles.length ? `已检查 ${fmFiles.length} 个 front-matter 文件，0 处 \`键: null\`` : "0 处",
      nullLiteral.slice(0, 5).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));

    const fnm = /\btags\b/.test(blob) && /\[/.test(blob);
    const blockList = grepFiles(scopeFiles, /tags:\s*(?:\\n|\r|\n)\s*-\s/);
    check("FM-3", "tags 用行内数组 `[a, b]`（不得块列表）", fnm && blockList.length === 0,
      "未发现块列表写法", blockList.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(" | "));

    // 不写 BOM：① 源文件本身不得以真实 BOM 字符开头；② front-matter 渲染器不得把 \uFEFF 拼进输出。
    // （`\uFEFF` 出现在**检测**正则里是合法的，见 importLog.ts:291；真正的证明是 §9 的字节断言。）
    const bomFiles = [];
    for (const rel of scopeFiles) {
      const raw = readIfExists(rel);
      if (raw != null && raw.charCodeAt(0) === 0xfeff) bomFiles.push(`${rel} 以真实 BOM 开头`);
    }
    const fmRenderer = scopeFiles.filter((rel) => {
      const text = readIfExists(rel);
      return text != null && text.includes("opennote_import_id") && /renderFrontMatter|renderMarkdown/.test(text);
    });
    const bomWrites = fmRenderer.length ? grepFiles(fmRenderer, /["'`]\\uFEFF|\\uFEFF["'`]/, { strip: true }) : [];
    check("FM-4", "不写 BOM（源文件无 BOM 头，渲染器不拼 \\uFEFF）", bomFiles.length === 0 && bomWrites.length === 0,
      bomFiles.length || bomWrites.length ? "" : "源文件无 BOM 头；渲染器无 \\uFEFF 拼接",
      [...bomFiles, ...bomWrites.map((h) => `${h.file}:${h.line} ${h.text}`)].slice(0, 5).join(" | "));
  }
}

/* ==================================================================== §4 */

group("§4 前像 / 导入日志 / 幂等索引");

{
  const blob = scopeFiles.map((rel) => readIfExists(rel) || "").join("\n");
  if (!featureFiles.length) {
    skip("PRE-1", "前像目录 .opennote/import-preimages/", "改动面为空");
    skip("PRE-2", "前像不得放在 .opennote/history/ 之下", "改动面为空");
    skip("PRE-3", "import-log.json 上限 500 且与前像同源清理", "改动面为空");
    skip("PRE-4", "幂等索引 .opennote/import-index.json 上限 2000", "改动面为空");
  } else {
    check("PRE-1", "前像目录 .opennote/import-preimages/", /import-preimages/.test(blob), "已出现 import-preimages",
      "未发现 import-preimages（前像尚未落地）");
    const historyPreimage = grepFiles(scopeFiles, /history[^\n]*preimage|preimage[^\n]*history/i);
    check("PRE-2", "前像不得与 .opennote/history/ 同域", historyPreimage.length === 0, "0 处耦合",
      historyPreimage.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));

    // 只在**导入日志/前像模块**里判定上限与同源清理，避免命中无关数字
    const logFiles = scopeFiles.filter((rel) => /import-?log|preimage/i.test(rel));
    if (!logFiles.length) {
      skip("PRE-3a", "import-log 上限 500", "import-log 模块尚未落地");
      skip("PRE-3b", "日志超限时同步删除最旧前像（同一次操作）", "import-log 模块尚未落地");
    } else {
      const logBlob = logFiles.map((rel) => readIfExists(rel) || "").join("\n");
      check("PRE-3a", "import-log 上限 500", /\b500\b/.test(logBlob), `${logFiles.join(", ")} 中发现 500`, "未发现 500 上限常量");
      const nearby = /500[\s\S]{0,1200}?(remove|unlink|deleteFile|rm\s*\()/.test(logBlob) || /(remove|unlink|deleteFile|rm\s*\()[\s\S]{0,1200}?500/.test(logBlob);
      check("PRE-3b", "日志超限时同步删除最旧前像（同一次操作）", nearby, "同一模块内 500 与删除动作相邻出现",
        "未见「删日志 + 删前像」在同一处完成");
    }

    // 幂等索引不一定住在名为 `import-index` 的文件里：本轮实现把它放在
    // `src/data/importLog.ts`（导出 `IMPORT_INDEX_FILE` / `INDEX_LIMIT`）。
    // 所以按**符号**定位，而不是按文件名。
    const indexFiles = [...new Set(grepFiles(scopeFiles.filter((rel) => !isTestPath(rel)),
      /IMPORT_INDEX_FILE|INDEX_LIMIT|import-index\.json/).map((h) => h.file))];
    if (!indexFiles.length) {
      skip("PRE-4", "幂等索引 .opennote/import-index.json 上限 2000", "未发现索引模块符号（IMPORT_INDEX_FILE / INDEX_LIMIT）");
    } else {
      const indexBlob = indexFiles.map((r) => readIfExists(r) || "").join("\n");
      check("PRE-4a", "索引文件名逐字 .opennote/import-index.json",
        /["'`]\.opennote\/import-index\.json["'`]/.test(indexBlob),
        `${indexFiles.join(", ")} 中命中文件名常量`, "未发现逐字文件名");
      check("PRE-4b", "幂等索引上限常量 == 2000",
        /INDEX_LIMIT\s*=\s*2000\b/.test(indexBlob),
        `${indexFiles.join(", ")} 中 INDEX_LIMIT = 2000`, "未发现 INDEX_LIMIT = 2000");
    }
  }
}

/* ==================================================================== §5 */

group("§5 本地桥与安全");

// B-1 零新依赖
{
  const head = git(["show", `${BASELINE}:package.json`]);
  const now = readIfExists("package.json");
  let same = false;
  let detail = "package.json 不可读";
  if (head && now) {
    try {
      const a = JSON.stringify(JSON.parse(head).dependencies || {});
      const b = JSON.stringify(JSON.parse(now).dependencies || {});
      const devA = JSON.stringify(JSON.parse(head).devDependencies || {});
      const devB = JSON.stringify(JSON.parse(now).devDependencies || {});
      same = a === b && devA === devB;
      detail = same ? `dependencies 与 devDependencies 与 ${BASELINE} 完全一致` : `dependencies 变化: ${a !== b}; devDependencies 变化: ${devA !== devB}`;
    } catch (error) {
      detail = `解析失败: ${error.message}`;
    }
  }
  check("BR-1", "桥零新依赖（dependencies / devDependencies 未变）", same, detail, detail);
}

// B-2/B-3 监听地址与端口（先剥掉注释，避免文档注释里的反例被当成实现）
{
  const bridgeFiles = allProductFiles.filter((rel) => /bridge|clip|server/i.test(rel) || /electron\//.test(rel));
  const listenHits = [];
  for (const rel of bridgeFiles) {
    const raw = readIfExists(rel);
    if (raw == null) continue;
    const lines = stripComments(raw).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/\.listen\s*\(/.test(line)) listenHits.push({ file: rel, line: i + 1, text: line.trim(), lines });
    });
  }
  const blobs = bridgeFiles.map((rel) => stripComments(readIfExists(rel) || "")).join("\n");

  if (!listenHits.length) {
    skip("BR-2", "只绑 127.0.0.1（禁止裸 listen(port)）", "改动面内 0 处真实 .listen(");
  } else {
    const unsafe = [];
    for (const hit of listenHits) {
      const window = lineWindow(hit, 2, 1);
      if (!/127\.0\.0\.1/.test(window)) unsafe.push(`${hit.file}:${hit.line} 未绑定 127.0.0.1 — ${hit.text}`);
      if (/0\.0\.0\.0|::1|'::'|"::"/.test(window)) unsafe.push(`${hit.file}:${hit.line} 出现非法绑定地址 — ${hit.text}`);
    }
    check("BR-2", "只绑 127.0.0.1（禁止裸 listen(port) / 0.0.0.0 / ::1）", unsafe.length === 0,
      `${listenHits.length} 处 .listen 均绑定 127.0.0.1`, unsafe.slice(0, 5).join(" | "));
  }

  const portHits = /8787/.test(blobs) && /8796/.test(blobs);
  if (!blobs) skip("BR-3", "端口范围 8787–8796", "改动面为空");
  else check("BR-3", "端口范围 8787–8796", portHits, "发现 8787 与 8796", "未发现完整端口范围");

  const listenZero = grepFiles(bridgeFiles.filter((rel) => !isTestPath(rel)), /listen\s*\(\s*0\s*[,)]/);
  // 测试里为「取一个空闲端口」短暂 listen(0) 是合法夹具，单列 INFO 而不是 FAIL。
  const zeroInTests = grepFiles(testFiles, /listen\s*\(\s*0\s*[,)]/);
  if (zeroInTests.length) {
    info("BR-4b", "测试夹具里出现 listen(0)（不算违规）",
      zeroInTests.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  }
  check("BR-4", "产品代码不使用端口 0（契约禁止）", listenZero.length === 0,
    `0 处（产品代码 ${bridgeFiles.filter((rel) => !isTestPath(rel)).length} 个文件）`,
    listenZero.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
}

// B-5 四道前置校验顺序 Host → Origin → Content-Type → token
// 判据用**真实拒绝点**（`sendError(req, res, 'IMP-xxxx'`）的行号，而不是文档注释里的首次提及。
{
  const bridgeFiles = allProductFiles.filter((rel) => /bridge|clip/i.test(rel) && /\.(cjs|ts|js|mjs)$/.test(rel));
  if (!bridgeFiles.length) {
    skip("BR-5", "四道前置校验顺序 Host → Origin → Content-Type → token", "未发现桥实现文件");
  } else {
    const GATES = [
      { key: "Host", code: "IMP-1005" },
      { key: "Origin", code: "IMP-3001" },
      { key: "Content-Type", code: "IMP-3004" },
      { key: "token", code: "IMP-2001|IMP-2002" },
    ];
    let verdict = null;
    for (const rel of bridgeFiles) {
      const text = stripComments(readIfExists(rel) || "");
      const positions = GATES.map((g) => {
        const re = new RegExp(`sendError\\([^)]*['"\`](${g.code})['"\`]`);
        for (const line of text.split(/\r?\n/).entries()) {
          if (re.test(line[1])) return line[0] + 1;
        }
        return -1;
      });
      if (positions.every((p) => p > 0)) {
        const ordered = positions.every((p, i) => i === 0 || p > positions[i - 1]);
        verdict = { rel, positions, ordered };
        if (ordered) break;
      }
    }
    check("BR-5", "四道前置校验顺序 Host → Origin → Content-Type → token", Boolean(verdict && verdict.ordered),
      verdict ? `${verdict.rel} 拒绝点行号 ${verdict.positions.join(" < ")}` : "",
      verdict ? `${verdict.rel} 拒绝点行号 ${verdict.positions.join(", ")}（期望严格递增）` : "未找到同时包含四道校验拒绝点的文件");
  }
}

// B-6 拒绝 text/plain：白名单式 Content-Type 校验（非 list 内一律 IMP-3004）
{
  const bridgeFiles = allProductFiles.filter((rel) => /bridge|clip/i.test(rel));
  const raw = bridgeFiles.map((rel) => readIfExists(rel) || "").join("\n");
  const blob = stripComments(raw);
  if (!blob) {
    skip("BR-6", "拒绝 text/plain → 415 IMP-3004", "未发现桥实现");
    skip("BR-7", "绝不返回 Allow-Origin: * / Allow-Credentials: true", "未发现桥实现");
    skip("BR-8", "存在 Vary: Origin", "未发现桥实现");
  } else {
    const whitelist = /CONTENT_TYPES\s*=\s*\[([\s\S]{0,200}?)\]/.exec(blob);
    const list = whitelist ? whitelist[1] : "";
    const onlyJson = whitelist && list.includes("application/json") && list.includes("application/opennote+json") && !list.includes("text/plain");
    const rejectsOthers = /IMP-3004/.test(blob);
    check("BR-6", "拒绝 text/plain → 415 IMP-3004（白名单式：仅 application/json 与 application/opennote+json）",
      onlyJson && rejectsOthers,
      `白名单 = [${list.replace(/\s+/g, " ").trim()}]; IMP-3004 已使用`,
      `白名单 = [${list.replace(/\s+/g, " ").trim() || "(未找到 CONTENT_TYPES)"}]; IMP-3004=${rejectsOthers}`);
    const wildcard = grepFiles(bridgeFiles, /Access-Control-Allow-Origin[^\n]*\*/);
    const creds = grepFiles(bridgeFiles, /Access-Control-Allow-Credentials[^\n]*true/i);
    check("BR-7", "绝不返回 Allow-Origin: * 或 Allow-Credentials: true", wildcard.length === 0 && creds.length === 0, "0 处",
      [...wildcard, ...creds].slice(0, 3).map((h) => `${h.file}:${h.line}`).join(" | "));
    check("BR-8", "存在 Vary: Origin", /Vary[^\n]*Origin/i.test(blob), "已出现 Vary: Origin", "未发现 Vary: Origin");
  }
}

// B-9 token 形态与存储
//
// ⚠️ **这条的标题曾经撒谎**（Lead 2026-09-30 指出，我的问题）：原标题写「只存 sha256 + last4」，
// 而 `00` §6.15㊴ 已裁定 **`bridge.json` 同时存明文**（推翻 ㊲ 的「绝不落盘」，用户知情选择）。
// 断言本身（opn_ 前缀 / 47 字符 / sha256 / last4 四个键位都在）在新口径下仍然成立，于是它**永远绿** ——
// 标题不做断言，所以事实变了它也不会红；**错的只有标签，而标签会被引述成结论。**
// 现在的标题只声称它真正断言的东西；「明文落盘且只落在工作区之外」由 `verify-e2e.cjs` 的 `S10.6` 断言。
{
  const bridgeFiles = allProductFiles.filter((rel) => /bridge|clip|token/i.test(rel));
  const blob = bridgeFiles.map((rel) => readIfExists(rel) || "").join("\n");
  if (!blob) skip("BR-9", "令牌 opn_ + 43 base64url = 47 字符；存储键 sha256 / last4 齐备（明文是否落盘不由本条断言）", "未发现桥实现");
  else {
    const hasPrefix = /opn_/.test(blob);
    const has47 = /\b47\b/.test(blob);
    const hasSha = /sha256|createHash/i.test(blob);
    const hasLast4 = /last4/i.test(blob);
    check("BR-9", "令牌 47 字符 + opn_ 前缀；存储键 sha256 / last4 齐备（明文是否落盘见 e2e 的 S10.6，本条不断言）",
      hasPrefix && has47 && hasSha && hasLast4,
      `opn_=${hasPrefix} 47=${has47} sha256=${hasSha} last4=${hasLast4}`,
      `opn_=${hasPrefix} 47=${has47} sha256=${hasSha} last4=${hasLast4}`);
  }
}

// B-10 CSP 不得为设置页放开 connect-src
{
  const vite = readIfExists("vite.config.ts") || "";
  const main = readIfExists("electron/main.cjs") || "";
  const viteConnect = /"?connect-src([^"\n]*)"/.exec(vite);
  const mainConnect = /"?connect-src([^"\n]*)"/.exec(main);
  const v = viteConnect ? viteConnect[1] : "";
  const m = mainConnect ? mainConnect[1] : "";
  check("BR-10", "web 版 connect-src 未放开 127.0.0.1（设置页走 IPC，不走 HTTP）", v.trim() !== "" && !/127\.0\.0\.1/.test(v),
    `connect-src${v}`, `connect-src${v || "(未找到)"}`);
  check("BR-11", "桌面版 connect-src 未放开 127.0.0.1", m.trim() !== "" && !/127\.0\.0\.1/.test(m),
    `connect-src${m}`, `connect-src${m || "(未找到)"}`);
}

// B-12 webPreferences 未放宽
{
  const main = readIfExists("electron/main.cjs") || "";
  const wp = /webPreferences\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(main);
  const body = wp ? wp[1] : "";
  const ok = /contextIsolation\s*:\s*true/.test(body) && /nodeIntegration\s*:\s*false/.test(body) && /sandbox\s*:\s*true/.test(body);
  check("BR-12", "webPreferences 未放宽（contextIsolation:true / nodeIntegration:false / sandbox:true）", ok,
    "三项均为安全值", body ? body.replace(/\s+/g, " ").trim().slice(0, 160) : "未找到 webPreferences");
}

// B-13 主进程不得写笔记正文（唯一例外 .opennote/inbox/<entry>/state.json）
{
  const main = readIfExists("electron/main.cjs") || "";
  // 找出所有写文件调用上下文，检查是否出现 .md / assets / import-index / import-log / import-preimages
  const writePatterns = [/writeFile\w*\s*\(/g, /writeFileAtomic\s*\(/g, /fs\.promises\.write\w*\s*\(/g];
  const offenders = [];
  for (const re of writePatterns) {
    let match;
    while ((match = re.exec(main)) !== null) {
      const start = Math.max(0, match.index - 400);
      const window = main.slice(start, match.index + 400);
      if (/\.md\b|import-index|import-log|import-preimages|assets\//.test(window)) {
        const line = main.slice(0, match.index).split(/\r?\n/).length;
        offenders.push(`main.cjs:${line} 附近出现正文类目标`);
      }
    }
  }
  const unique = [...new Set(offenders)];
  // 标题精度（Lead 2026-09-30 的「同类问题」要求）：㊴ 之后主进程**确实**会写 `userData/bridge.json`
  // （明文 + sha256 + last4）。本条扫的是**工作区里的正文类目标**，所以「唯一例外」必须限定在
  // 「工作区内的内容文件」，否则读者会把它当成「主进程总共只写一个文件」——那是错的。
  check("BR-13", "主进程不写笔记正文（**工作区里**唯一例外是 `.opennote/inbox/<entry>/state.json`；"
    + "令牌文件 `bridge.json` 在 `userData`，不属于工作区内容）", unique.length === 0,
    "未发现主进程写 .md / 索引 / 前像 / assets", unique.slice(0, 5).join(" | "));
}

// B-14 preload 既有 API 名与 arity 不变（真执行 stub 版 preload，对比 HEAD）
{
  const snapshotApi = (source) => {
    const Module = require("module");
    const original = Module._load;
    let captured = null;
    const stub = {
      contextBridge: { exposeInMainWorld: (_key, value) => { captured = value; } },
      ipcRenderer: {
        invoke: async () => undefined,
        on: () => undefined,
        removeListener: () => undefined,
        send: () => undefined,
        sendSync: () => "0.0.0-verify",
      },
    };
    Module._load = function patched(request, ...rest) {
      if (request === "electron") return stub;
      return original.call(this, request, ...rest);
    };
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "opennote-preload-"));
    const tmpFile = path.join(tmpDir, "preload.cjs");
    fs.writeFileSync(tmpFile, source, "utf8");
    try {
      delete require.cache[require.resolve(tmpFile)];
      require(tmpFile);
    } finally {
      Module._load = original;
    }
    const flat = [];
    const visit = (obj, prefix) => {
      if (!obj || typeof obj !== "object") return;
      for (const [key, value] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "function") flat.push({ name: full, arity: value.length });
        else if (value && typeof value === "object" && !Array.isArray(value)) visit(value, full);
      }
    };
    visit(captured, "");
    return flat.sort((a, b) => a.name.localeCompare(b.name));
  };

  const headSource = git(["show", `${BASELINE}:electron/preload.cjs`]);
  const nowSource = readIfExists("electron/preload.cjs");
  if (!headSource || !nowSource) {
    skip("BR-14", "preload 既有方法名与参数个数不变", "无法读取 preload.cjs");
  } else {
    try {
      const before = snapshotApi(headSource);
      const after = snapshotApi(nowSource);
      const afterMap = new Map(after.map((e) => [e.name, e.arity]));
      const changed = before.filter((e) => afterMap.get(e.name) !== e.arity);
      const added = after.filter((e) => !before.some((b) => b.name === e.name));
      check("BR-14", `preload 既有 ${before.length} 项方法名与 arity 不变`, changed.length === 0,
        `既有 ${before.length} 项全部一致；新增 ${added.length} 项（${added.map((a) => `${a.name}/${a.arity}`).join(", ") || "无"}）`,
        changed.map((c) => `${c.name}: ${c.arity} → ${afterMap.get(c.name)}`).join(" | "));
    } catch (error) {
      fail("BR-14", "preload 既有方法名与参数个数不变", `stub 执行失败: ${error.message}`);
    }
  }
}

/* ==================================================================== §6 */

group("§6 收件箱（5 态 / 保留期 / 独立 watcher / 丢弃不进回收站）");

{
  const inboxFiles = allProductFiles.filter((rel) => /inbox/i.test(rel));
  const blob = allProductFiles.map((rel) => readIfExists(rel) || "").join("\n");
  const hasInboxCode = inboxFiles.length > 0 || /opennote:inbox/.test(blob);

  if (!hasInboxCode) {
    for (const [i, title] of [
      "5 态 pending/committing/committed/failed/discarded",
      "保留期 committed 24h / failed 7d / pending·committing 无期限",
      "discarded 不进回收站（.opennote/trash/ 不出现 inbox-*）",
      "opennote:inbox:changed 独立频道 + payload {root,pending} + 450ms 去抖",
      "state.json 原子写（*.tmp + rename）",
    ].entries()) skip(`IN-${i + 1}`, title, "收件箱尚未落地");
  } else {
    const missingStates = INBOX_STATES.filter((s) => !new RegExp(`["'\`]${s}["'\`]`).test(blob));
    check("IN-1", "5 态齐全", missingStates.length === 0, INBOX_STATES.join("|"), `缺少: ${missingStates.join(", ")}`);

    // 保留期：24 小时 / 7 天必须能从常量推出（毫秒或小时/天数字）
    const has24 = /24\s*\*\s*60\s*\*\s*60|86_?400_?000|24\s*\*\s*3600|\b24\b[^\n]{0,20}(hour|小时|h\b)/i.test(blob);
    const has7d = /7\s*\*\s*24\s*\*\s*60\s*\*\s*60|604_?800_?000|\b7\b[^\n]{0,20}(day|天|d\b)/i.test(blob);
    check("IN-2", "保留期 committed 24h / failed 7d 由常量表达", has24 && has7d, `24h=${has24} 7d=${has7d}`, `24h=${has24} 7d=${has7d}`);

    // IN-3：判据是「收件箱代码有没有**写入/移动进**回收站」，不是「有没有出现 trash 这个词」。
    // `note.trashed`（类型标注、属性读取、界面过滤）都是合法用法，不算违规。
    const TRASH_WRITE_RE = /trashNote\s*\(|trashDir\s*\(|moveToTrash\s*\(|toTrash\s*\(|["'`]\.opennote\/trash|TRASH_DIR\b|trashPath\s*\(/;
    const trashWrites = grepFiles(inboxFiles, TRASH_WRITE_RE, { strip: true });
    // 出现次数单列 INFO，便于人复核哪些是「读」哪些是「写」。
    const trashMentions = grepFiles(inboxFiles, /trash/i, { strip: true });
    info("IN-3b", "收件箱代码里 trash 的出现（读/写/文案）", `${trashMentions.length} 处：${trashMentions.slice(0, 6).map((h) => `${h.file}:${h.line}`).join(", ") || "0 处"}`);
    check("IN-3", "discarded 不进回收站（收件箱代码无 trash **写入**调用）", trashWrites.length === 0, "0 处写入调用",
      trashWrites.slice(0, 5).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));

    check("IN-4", "opennote:inbox:changed 独立频道", /opennote:inbox:changed/.test(blob), "已出现", "未发现独立频道");
    check("IN-5", "payload 形状 { root, pending }", /\bpending\b/.test(blob) && /\broot\b/.test(blob), "同时出现 root 与 pending", "缺少 root / pending");
    check("IN-6", "收件箱 watch 去抖 450ms", /\b450\b/.test(blob), "发现 450", "未发现 450 去抖常量");
    const atomic = grepFiles(inboxFiles.concat(allProductFiles.filter((r) => /bridge/i.test(r))), /\.tmp|writeFileAtomic|rename\s*\(/);
    check("IN-7", "state.json 原子写（*.tmp + rename）", atomic.length > 0, `${atomic.length} 处原子写痕迹`, "未发现原子写痕迹");
  }
}

/* ==================================================================== §7 */

group("§7 UI：设计令牌 / 文案逐字 / 撤销窗口 / 无 emoji");

// U-1 设计令牌：收集所有 CSS 里定义过的自定义属性，扫描使用点
{
  const cssFiles = [...readTree(["src/styles"], (rel) => rel.endsWith(".css")), ...readTree(["extension"], (rel) => rel.endsWith(".css"))];
  const defined = new Set();
  for (const rel of cssFiles) {
    const text = readIfExists(rel) || "";
    for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  }
  const usageFiles = allProductFiles.filter((rel) => /\.(css|tsx|ts)$/.test(rel));
  const used = [];
  for (const rel of usageFiles) {
    const text = readIfExists(rel) || "";
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) used.push({ file: rel, line: i + 1, tok: m[1], text: line.trim() });
    });
  }
  // 既有基线例外：export.ts 导出模板（独立文档，不在应用样式表内）
  const BASELINE_EXCEPTIONS = new Set(["--code"]);
  const undefinedRefs = used.filter((u) => !defined.has(u.tok) && !BASELINE_EXCEPTIONS.has(u.tok));
  check("U-1", "新增/现有 var(--*) 引用全部有定义（新增设计令牌 0）", undefinedRefs.length === 0,
    `${defined.size} 个令牌已定义，${used.length} 处引用全部命中`,
    undefinedRefs.slice(0, 8).map((u) => `${u.file}:${u.line} var(${u.tok})`).join(" | "));

  const mono = used.filter((u) => u.tok === "--mono");
  check("U-2", "var(--mono) 0 处（真实令牌名是 --font-mono）", mono.length === 0, "0 处",
    mono.slice(0, 5).map((u) => `${u.file}:${u.line}`).join(" | "));
  check("U-3", "--font-mono 在 tokens.css 中有定义", defined.has("--font-mono"), "tokens.css 定义 --font-mono", "未定义 --font-mono");
}

// U-4 文案逐字
{
  const blob = allProductFiles.map((rel) => readIfExists(rel) || "").join("\n");
  const hasCanonical = blob.includes(COPY.duplicate);
  const hasOld = blob.includes(COPY.duplicateOldVariant);
  if (!/剪藏|导入|import|inbox|clip/i.test(blob)) {
    skip("U-4", `规范文案 ${COPY.duplicate}`, "产品代码尚未包含导入面");
  } else {
    check("U-4", `规范文案逐字：${COPY.duplicate}`, hasCanonical, "命中", "未找到规范文案");
    check("U-5", "旧长变体已弃用（0 处）", !hasOld, "0 处", `发现旧变体：${COPY.duplicateOldVariant}`);
  }
}

// U-6 撤销窗口 10 秒且**显式**传 duration；duplicate 不弹 toast
//
// 判据不是「源码里出现字面量 10000」——那只是实现细节。契约要害是两件事：
//   ① 窗口常量的值 == 10000ms；
//   ② `notify()` 调用处**显式**传了 `duration`（因为 `notify()` 对带 action 的 toast
//      默认只有 6000ms，靠默认值就等于把撤销窗口砍到 6 秒）。
// 动态侧的等价证据在 `scripts/verify-e2e.cjs` S4.9（捕获 setTimeout 实参 == 10000）。
{
  const uiFiles = allProductFiles.filter((rel) => /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\./.test(rel));
  const duplicateToast = grepFiles(uiFiles, /duplicate[\s\S]{0,160}?notify\s*\(/);
  const clipBlob = allProductFiles.filter((rel) => /clip|receive|import/i.test(rel)).map((rel) => readIfExists(rel) || "").join("\n");

  if (!/撤销|undo|notify/i.test(allProductFiles.map((r) => readIfExists(r) || "").join("\n"))) {
    skip("U-6", "撤销窗口 10000ms 且显式传 duration", "导入 UI 尚未落地");
  } else {
    // ① 常量值
    const constMatch = /UNDO_WINDOW_MS\s*=\s*([0-9_]+)/.exec(clipBlob);
    const constValue = constMatch ? Number(constMatch[1].replace(/_/g, "")) : null;
    check("U-6a", "UNDO_WINDOW_MS 常量 == 10000", constValue === 10000,
      constMatch ? `UNDO_WINDOW_MS = ${constValue}` : "",
      constMatch ? `UNDO_WINDOW_MS = ${constValue}（期望 10000）` : "未找到 UNDO_WINDOW_MS 常量");

    // ② notify 调用处显式传 duration。
    //    只对**导入/收件箱**范围强制（§6.13④ 的 10000ms 只约束导入撤销窗口）。
    //    `src/App.tsx` 里只取**导入相关**的 notify（撤销导入 / 入库成功 / 已经在笔记中）；
    //    「新建笔记」「移入回收站」等既有 toast 不在范围内 —— 它们逐字来自基线 5a98f59，
    //    本次一行未动，作为观测记录（U-6c），不算失败。
    const IMPORT_SCOPE_RE = /^src\/lib\/clip\/|^src\/data\/inbox\.ts$|^src\/data\/importLog\.ts$|^src\/components\/(InboxPanel|ConflictDialog|ImportApiPanel)\.tsx$/;
    const scopeFiles = allProductFiles.filter((rel) => IMPORT_SCOPE_RE.test(rel.replace(/\\/g, "/")));
    const appImportNotify = grepFiles(["src/App.tsx"], /notify\s*\(/).filter((h) =>
      /导入|入库|已在笔记中/.test(lineWindow(h, 0, 4)),
    );
    const notifyCalls = grepFiles(scopeFiles, /notify\s*\(/).concat(appImportNotify);
    const withDuration = notifyCalls.filter((h) => /duration\s*:/.test(lineWindow(h, 0, 4)));
    const actionWithoutDuration = notifyCalls.filter((h) => {
      const window = lineWindow(h, 0, 4);
      return /action\s*:/.test(window) && !/duration\s*:/.test(window);
    });
    const appWideAction = grepFiles(
      allProductFiles.filter((rel) => /\.tsx?$/.test(rel) && !isTestPath(rel)),
      /notify\s*\(/,
    ).filter((h) => {
      const window = lineWindow(h, 0, 4);
      return /action\s*:/.test(window) && !/duration\s*:/.test(window);
    });
    check("U-6b", "导入/收件箱范围内带 action 的 notify 显式传 duration（否则默认只有 6000ms）",
      withDuration.length > 0 && actionWithoutDuration.length === 0,
      `${withDuration.length} 处显式传 duration；扫描范围：${scopeFiles.length} 个导入/收件箱文件 + App.tsx 导入相关 notify ${appImportNotify.length} 处`,
      actionWithoutDuration.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(" | ") || `未发现任何显式 duration（范围内 notify 调用 ${notifyCalls.length} 处）`);
    if (appWideAction.length) {
      info("U-6c", "范围外带 action 的 notify 未显式传 duration（基线已有、非导入范围，不计失败）",
        appWideAction.map((h) => `${h.file}:${h.line}`).join(" | "));
    }

    check("U-7", "duplicate 不弹应用内 toast", duplicateToast.length === 0, "未发现 duplicate → notify",
      duplicateToast.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(" | "));
  }
}

// U-8 无 emoji（只约束**会变成界面文案的产品源码** + **构建产物**）
//
// 契约里的「无 emoji」是 03 号 UI 规范对**用户可见文案**的要求，所以扫描范围必须对准
// 「会不会出现在界面上」，否则每加一篇开发文档都会被自己绊倒（误报）：
//   · 严格扫：`.ts/.tsx/.js/.cjs/.mjs/.html/.css`（剥注释后 —— 注释是给开发者看的，
//     与 BR-4 / IN-3 同理）+ `extension/dist/**`（**产物**，装进浏览器的东西，必须零 emoji）
//   · 不扫：`*.md` / `*.txt`（开发文档）、`tests/`、自测脚本
//   · 被排除的命中记 U-8c INFO，**仍然打印出来**（不隐藏事实）
const UI_COPY_EXT_RE = /\.(ts|tsx|js|cjs|mjs|html|css)$/;
const DOC_EXT_RE = /\.(md|markdown|txt)$/;
const UI_COPY_FILES = (files) => files.filter((rel) => UI_COPY_EXT_RE.test(rel));
{
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
  const scan = (files, { strip = false } = {}) => {
    const hits = [];
    for (const rel of files) {
      const raw = readIfExists(rel);
      if (raw == null) continue;
      const text = strip ? stripComments(raw) : raw;
      text.split(/\r?\n/).forEach((line, i) => {
        EMOJI.lastIndex = 0;
        if (EMOJI.test(line)) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 80)}`);
      });
    }
    return hits;
  };
  const offenders = scan(UI_COPY_FILES(productFiles), { strip: true });
  const inTests = scan(testFiles);
  const docsAndComments = [
    ...scan(productFiles.filter((rel) => DOC_EXT_RE.test(rel))).map((hit) => `[文档] ${hit}`),
    // 注释扫描只看代码文件，否则 `*.md` 会被同时算进「文档」和「注释」两桶（重复计数）
    ...scan(UI_COPY_FILES(productFiles), { strip: false })
      .filter((hit) => !offenders.some((o) => o.split(" ")[0] === hit.split(" ")[0]))
      .map((hit) => `[注释] ${hit}`),
  ];
  if (inTests.length) {
    info("U-8b", "测试/自测脚本里的 emoji（契约不约束）",
      `${inTests.length} 处：${inTests.slice(0, 4).join(" | ")}`);
  }
  check("U-8", "界面文案无 emoji（扫产品源码的 .ts/.tsx/.js/.html/.css，剥注释；不含 tests/ 与 *.md）",
    offenders.length === 0,
    `0 处（剥注释后扫描 ${UI_COPY_FILES(productFiles).length} 个源码文件）`, offenders.slice(0, 8).join(" | "));
  if (docsAndComments.length) {
    info("U-8c", "开发文档（*.md）与代码注释里的 emoji（非用户可见，不计失败）",
      `${docsAndComments.length} 处：${docsAndComments.slice(0, 3).join(" | ")}`);
  }
  // 产物例外：`extension/dist/**` 是**装进浏览器的东西**，这里必须严格零 emoji。
  const distTreeFiles = readTree(["extension/dist"], (rel) => TEXT_EXT.has(path.extname(rel)));
  const distOffenders = scan(distTreeFiles);
  check("U-8e", "扩展产物 `extension/dist/**` 零 emoji（产物是严格面，不是文档）",
    distOffenders.length === 0,
    `0 处（扫描 ${distTreeFiles.length} 个产物文件）`, distOffenders.slice(0, 6).join(" | "));
}

/* ==================================================================== §8 */

group("§8 浏览器插件（manifest v3 / 0 远程 URL / 0 eval / 权限最小化）");

{
  if (!exists("extension")) {
    for (const [i, t] of [
      "extension/ 存在",
      "manifest_version === 3",
      "dist 内 0 处**真的远程引用** + 0 处 eval（判据见下方 EX-6）",
      "权限最小化（列出实际 permissions）",
      "「Opennote 未运行」不显示成「已连接」",
      "降级不静默失败（IMP-4006 / IMP-1001）",
    ].entries()) skip(`EX-${i + 1}`, t, "extension/ 目录不存在，B 线尚未落地");
  } else {
    const manifestCandidates = ["extension/dist/manifest.json", "extension/manifest.json", "extension/src/manifest.json"];
    const manifestPath = manifestCandidates.find((rel) => exists(rel)) || null;
    check("EX-1", "extension/ 存在且能找到 manifest.json", Boolean(manifestPath), manifestPath || "", "未找到 manifest.json（候选: " + manifestCandidates.join(", ") + "）");

    if (manifestPath) {
      let manifest = null;
      try {
        manifest = JSON.parse(readIfExists(manifestPath));
      } catch (error) {
        fail("EX-2", "manifest.json 可解析", error.message);
      }
      if (manifest) {
        check("EX-2", "manifest_version === 3", manifest.manifest_version === 3, `manifest_version=${manifest.manifest_version}`, `manifest_version=${manifest.manifest_version}`);
        const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
        info("EX-3", "实际 permissions / host_permissions", perms.length ? perms.join(", ") : "(空)");
        const forbidden = perms.filter((p) => p === "<all_urls>" || p === "tabs" || p === "webRequest" || p === "cookies" || p === "history" || p === "clipboardRead" || p === "management");
        check("EX-4", "权限最小化（不含 <all_urls>/tabs/webRequest/cookies/history）", forbidden.length === 0,
          `permissions: ${perms.join(", ") || "(空)"}`, `越权项: ${forbidden.join(", ")}`);
        // default_locale 必须是字符串（仅带 _locales 时允许）；null 会让 Chrome 报 manifest 无效
        const badLocale = "default_locale" in manifest && typeof manifest.default_locale !== "string";
        check("EX-5", "manifest 无非法 default_locale（null 会导致加载告警/失败）", !badLocale,
          "未设置或为字符串", `default_locale = ${JSON.stringify(manifest.default_locale)}`);
      }
    }

    const distFiles = readTree(["extension/dist"], (rel) => TEXT_EXT.has(path.extname(rel)));
    const srcFiles = readTree(["extension/src"], (rel) => TEXT_EXT.has(path.extname(rel)));
    const scanFiles = distFiles.length ? distFiles : srcFiles;
    const scanLabel = distFiles.length ? "extension/dist" : "extension/src（dist 尚未构建）";
    if (!scanFiles.length) {
      skip("EX-6", "dist 内 0 处**真的远程引用** + 0 处 eval（判据见下）", "extension/ 下无可扫描文件");
    } else {
      /**
       * **判据收窄（Lead 0.3.1 复核：`EX-6` 是误报）**。
       *
       * 旧判据是「非注释行里出现 `https?://` 就算远程 URL」，于是
       * `extension/dist/popup/popup.html:70` 的 **示例占位文本**
       * `placeholder="https://example.com/posts/local-first"` 被当成了远程资源 ——
       * 它是**表单空值时的灰色提示字**，不会发起任何请求。
       * （Lead 看到的是同一行的 `data-prop="source.url"` 字段路径；实测真正命中的是 placeholder，
       *   两者都不该算远程引用，见 V6 的「检查器误报与修正」。）
       *
       * 新判据 = **真的会引发网络加载/请求的东西**：
       *   ① 资源属性 `href/src/srcset/action/poster` 的值；
       *   ② CSS `url(...)`；
       *   ③ `fetch/importScripts/XMLHttpRequest.open/import` 的参数；
       *   ④ 脚本里的 URL **字符串字面量**（`extension/**` 的 js 整体按脚本扫，
       *      HTML 只扫 `<script>` 块内的部分）。
       * 非资源属性（`placeholder`/`data-*`/`title`/`aria-*`/`value`/`alt`）里的 URL 只记 INFO，不判 FAIL。
       */
      // 回环地址不算「远程」（桥自己的终点就是 `http://127.0.0.1:<port>`）。
      const NOT_LOCAL = "(?!127\\.0\\.0\\.1|localhost)";
      const RESOURCE_ATTR = new RegExp(`\\b(?:href|src|srcset|action|poster|data-src)\\s*=\\s*["']\\s*(?:https?:)?\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
      const CSS_URL = new RegExp(`\\burl\\(\\s*["']?\\s*(?:https?:)?\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
      const NET_CALL = new RegExp(`\\b(?:fetch|importScripts|XMLHttpRequest\\.open|import)\\s*\\(\\s*["'\`](?:https?:)?\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
      // 必须是「https?:// + 主机名首字符」才算真 URL：
      // `opennote://settings/import`（自有协议）、`http(s):// 开头`（说明文字）都不算。
      const STRING_LITERAL = new RegExp(`["'\`][^"'\`]*https?:\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%][^"'\`]*["'\`]`);
      const NON_RESOURCE_ATTR = new RegExp(`\\b(?:placeholder|data-[\\w-]+|title|aria-[\\w-]+|value|alt)\\s*=\\s*["'][^"']*(?:https?:)\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
      const remote = [];
      const evals = [];
      const benign = [];
      // 变异挂钩（只在内存里，不写盘）：用于证明 EX-6 / EX-7 真的会红。
      const overlayTarget = scanFiles.find((rel) => rel.endsWith(".html")) || scanFiles[0];
      const overlay = (rel, text) => {
        if (!MUTATE_EX6 || rel !== overlayTarget) return text;
        if (MUTATE_EX6 === "remote-src") return `${text}\n<script src="https://evil.example/x.js"></script>\n`;
        if (MUTATE_EX6 === "eval") return `${text}\n<script>eval("1+1")</script>\n`;
        return text;
      };
      for (const rel of scanFiles) {
        const text = overlay(rel, readIfExists(rel) || "");
        const isScript = /\.(?:js|mjs|cjs|ts)$/i.test(rel);
        let inScript = isScript;
        text.split(/\r?\n/).forEach((line, i) => {
          const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
          if (!isScript) {
            if (/<script\b/i.test(line) && !/<\/script>/i.test(line)) inScript = true;
            if (/<\/script>/i.test(line)) inScript = false;
          }
          if (isComment) return;
          const where = `${rel}:${i + 1} ${line.trim().slice(0, 100)}`;
          if (inScript) {
            if (NET_CALL.test(line) || STRING_LITERAL.test(line)) remote.push(where);
          } else if (RESOURCE_ATTR.test(line) || CSS_URL.test(line) || NET_CALL.test(line)) {
            remote.push(where);
          }
          if (NON_RESOURCE_ATTR.test(line) && !RESOURCE_ATTR.test(line) && !CSS_URL.test(line) && !NET_CALL.test(line)) {
            benign.push(where);
          }
          if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) evals.push(where);
        });
      }
      check("EX-6", `${scanLabel} 内 0 处**真的远程引用**（资源属性 / CSS url() / fetch 参数 / 脚本字符串字面量）`,
        remote.length === 0,
        `${scanFiles.length} 个文件已扫（判据已收窄：非资源属性里的示例 URL 不算）`,
        remote.slice(0, 6).join(" | "));
      if (benign.length) {
        info("EX-6′", "非资源属性（placeholder/data-*/title/aria-*/value）里的 URL 示例文本：**不算远程引用**，仅登记",
          benign.slice(0, 6).join(" | "));
      }
      check("EX-7", `${scanLabel} 内 0 处 eval / new Function`, evals.length === 0, "0 处", evals.slice(0, 6).join(" | "));

      const extText = scanFiles.map((rel) => readIfExists(rel) || "").join("\n");
      const notRunning = /Opennote 未运行|窗口已关闭/.test(extText);
      check("EX-8", "「Opennote 未运行」是独立状态（不得显示成「已连接」）", notRunning, "存在「未运行」态", "未发现「未运行」态（可能被并入「已连接」/「未连接」）");
      check("EX-9", "降级不静默失败（出现 IMP-4006 / IMP-1001）", /IMP-4006|IMP-1001/.test(extText), "已出现明确失败码", "未发现明确失败码");
    }

    // dist 可加载性：manifest 引用的文件必须全部存在
    const distManifest = exists("extension/dist/manifest.json") ? JSON.parse(readIfExists("extension/dist/manifest.json")) : null;
    if (!distManifest) {
      skip("EX-10", "extension/dist/ 可被「加载已解压的扩展程序」直接加载", "extension/dist/ 尚未构建（B 线未落地）");
    } else {
      const refs = [];
      if (distManifest.action?.default_popup) refs.push(distManifest.action.default_popup);
      if (distManifest.background?.service_worker) refs.push(distManifest.background.service_worker);
      for (const icon of Object.values(distManifest.icons || {})) refs.push(icon);
      const missing = refs.filter((rel) => !exists(`extension/dist/${rel}`));
      check("EX-10", "extension/dist/ 引用的入口文件全部存在", missing.length === 0,
        `${refs.length} 个引用全部命中`, `缺失: ${missing.join(", ")}`);
    }
  }
}

/* ==================================================================== §9 */

group("§9 动态调用（Vite ssrLoadModule 载入 TS，真跑一遍接收端）");

async function dynamicChecks() {
  if (!WANT_DYNAMIC) {
    skip("DYN-0", "动态调用", "未传 --dynamic（阶段 2 会用 --dynamic 复跑）");
    return;
  }
  const clipFiles = readTree(["src/lib/clip"], (rel) => /\.ts$/.test(rel) && !/\.test\.ts$/.test(rel));
  if (!clipFiles.length) {
    skip("DYN-0", "动态调用", "src/lib/clip/ 不存在，接收端未落地");
    return;
  }

  const require2 = createRequire(path.join(ROOT, "package.json"));
  const vite = await import(pathToFileURL(require2.resolve("vite")).href);
  const server = await vite.createServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const mods = {};
    for (const rel of clipFiles) {
      try {
        mods[rel] = await server.ssrLoadModule(`/${rel}`);
      } catch (error) {
        fail(`DYN-LOAD`, `载入 ${rel}`, error.message);
      }
    }
    const surface = Object.entries(mods).map(([rel, mod]) => `${rel}: ${Object.keys(mod).filter((k) => k !== "default").join(", ")}`);
    info("DYN-1", "接收端导出面（供阶段 2 精确断言）", surface.join(" || ").slice(0, 900));

    const memory = await server.ssrLoadModule("/src/fs/testing/memoryHandles.ts");
    const handleBackend = await server.ssrLoadModule("/src/fs/handleBackend.ts");
    const allExports = Object.assign({}, ...Object.values(mods));
    const receive = allExports.receiveEnvelopeOutcome || allExports.receiveEnvelope;
    if (typeof receive !== "function") {
      skip("DYN-2", "receiveEnvelope 动态断言", "未导出 receiveEnvelope / receiveEnvelopeOutcome");
    } else {
      const memfs = new memory.MemoryFileSystem();
      const backend = handleBackend.createHandleBackend(memfs.root, "fsa");
      const envelope = {
        spec: "opennote.import/v1",
        // `importId` 的契约是 `/^[A-Za-z0-9_-]+$/`（8–128 字符，envelope.ts:652）——
        // 这里曾经写成 `sha256:0000…`（含冒号）→ 解析器正确地判了 `IMP-4003`。
        // **那是我的夹具不合规，不是产品缺陷**（改夹具，不改产品）。见 V6 的检查器误报表。
        importId: "sha256-00000000000000ff",
        title: "验证用标题",
        body: "正文第一段。\n",
        source: { url: "https://example.com/verify", title: "来源标题", site: "example.com", author: "作者", publishedAt: "2026-09-29T10:00:00Z", capturedAt: "2026-09-29T21:00:00+08:00" },
        target: { folder: null, notePath: null },
        conflict: "new",
        tags: ["验证", "a,b", "123", "[x]"],
        assets: [],
        client: { name: "cli", version: "0.0.0" },
      };
      let outcome = null;
      let callError = null;
      for (const shape of [
        () => receive(envelope, { backend, workspaceRoot: "", taken: new Set() }),
        () => receive(envelope, backend, ""),
        () => receive({ envelope, backend, workspaceRoot: "" }),
      ]) {
        try {
          outcome = await shape();
          callError = null;
          break;
        } catch (error) {
          callError = error;
        }
      }
      if (outcome == null && callError) {
        skip("DYN-2", "receiveEnvelope 动态断言", `调用形状未知，最后一次错误: ${callError.message}`);
      } else {
        const result = outcome && outcome.ok === true ? outcome.result : outcome;
        /**
         * 0.3.1 校准：`receiveEnvelopeOutcome(raw)` 读的是**应用全局的工作区状态**（它只接一个参数），
         * 本脚本没有打开工作区 → 真实行为是如实返回 `ok:false` + `IMP-4007 工作区未打开`
         * （**不抛异常、不静默写盘**）—— 这本身就是契约要求的「明确失败」。
         * 「落盘 / 收件箱 / 判定链」这些要走真工作区的断言在 `verify-e2e.cjs`（102 条，含真 HTTP 桥）。
         * 旧判据要求这里必须落到 `created`，那是在拿一个没有工作区的调用去要写盘结果 —— 假红。
         */
        const noWorkspace = Boolean(outcome && outcome.ok === false && outcome.error && outcome.error.code === "IMP-4007");
        const okShape = (result && typeof result === "object" && ALLOWED_STATUS.includes(result.status)) || noWorkspace;
        check("DYN-2", "接收端返回合法 status，或如实报「工作区未打开」`IMP-4007`（不抛异常、不静默写盘）", okShape,
          noWorkspace
            ? "未打开工作区 → ok:false / IMP-4007（正确失败面）；写盘路径见 verify-e2e.cjs"
            : `status=${result && result.status}`,
          `实际: ${JSON.stringify(outcome).slice(0, 200)}`);
        if (noWorkspace) {
          skip("DYN-3", "动态调用里的落盘断言", "本脚本未打开工作区 → 由 verify-e2e.cjs 覆盖（PASS 102 / FAIL 0）");
          skip("DYN-4", "动态调用里的落盘断言", "同上");
          skip("DYN-5", "动态调用里的落盘断言", "同上");
          skip("DYN-6", "动态调用里的落盘断言", "同上");
        } else if (okShape) {
          const path0 = result.path;
          const written = path0 ? await backend.readText(path0) : null;
          if (written == null) {
            fail("DYN-3", "created 路径落盘且可读", `path=${path0} 读不到内容`);
          } else {
            const fmMatch = /^---\n([\s\S]*?)\n---\n\n# /.exec(written);
            check("DYN-3", "front-matter 在最开头且闭合后恰好一个空行接 `# 标题`", Boolean(fmMatch), "字节模板匹配", `实际开头: ${JSON.stringify(written.slice(0, 120))}`);
            const keys = fmMatch ? fmMatch[1].split("\n").map((l) => l.split(":")[0]) : [];
            const expectedPresent = FRONT_MATTER_KEYS.filter((k) => written.includes(`${k}:`));
            const orderedOk = expectedPresent.length === keys.length && expectedPresent.every((k, i) => k === keys[i]);
            check("DYN-4", "8 键顺序与存在性符合契约（null 键整行省略）", orderedOk, `实际键序: ${keys.join(" → ")}`, `实际键序 ${keys.join(" → ")}；期望出现 ${expectedPresent.join(" → ")}`);
            check("DYN-5", "文件以单个 \\n 结尾", written.endsWith("\n") && !written.endsWith("\n\n"), "末尾恰好一个换行", `末尾: ${JSON.stringify(written.slice(-20))}`);
            check("DYN-6", "tags 已过滤（逗号 / 纯数字 / 方括号 被丢弃）", !/a,b|123|\[x\]/.test(written), "非法标签未落盘", `实际 tags 行: ${(written.match(/tags:.*/) || ["(无)"])[0]}`);
          }
        }
      }
    }
  } finally {
    await server.close();
  }
}

/* ==================================================================== §10 */

group("§10 端到端 6 场景（由 verify-e2e.cjs 负责，这里只标注入口）");
info("E2E", "端到端场景", "请运行 `node scripts/verify-e2e.cjs`（独立脚本，输出每条场景的 PASS/FAIL/未验证）");

/* ---------------------------------------------------- C-9 · 0.3.1 语义（㉝㉞㊱） */
//
// 这一节只做**静态**取证：元素选择的纪律（㉝）、配对文案清零（㊱）、扩展用户可见文案无反引号。
// 真机交互（点选元素、受限页面提示、popup 文案）在本环境**无法**验证，见 V6 的 UNVERIFIED 清单。
{
  const extFiles = readTree(["extension/src"], (rel) => TEXT_EXT.has(path.extname(rel)));
  const distFiles = readTree(["extension/dist"], (rel) => TEXT_EXT.has(path.extname(rel)));

  /* ── C-9a（㊱）用户可见表面不得再有「配对」措辞 ─────────────────────────── */
  // 判据只取**用户可见表面**：`userMessage:` / `ui:` / `aria-label=` / HTML 文本 / `label:`。
  // 内部常量名（`NEEDS_PAIRING`）与注释不算用户可见（另记 INFO），否则会报一堆假缺陷。
  const PAIRING_WORDS = /配对码|配对新客户端|6 位配对|用配对流程|配对成功|配对已过期/;
  const visibleHits = [];
  const internalHits = [];
  for (const rel of [...extFiles, ...distFiles]) {
    const raw = readIfExists(rel) || "";
    const text = stripComments(raw);
    text.split(/\r?\n/).forEach((line, i) => {
      if (!PAIRING_WORDS.test(line)) return;
      const isVisible =
        /userMessage\s*:|ui\s*:|aria-label\s*=|label\s*:|placeholder\s*=|textContent\s*=|>\s*[^<>]*配对|setAttribute\s*\(\s*["']aria-label["']/.test(line);
      (isVisible ? visibleHits : internalHits).push(`${rel}:${i + 1} ${line.trim().slice(0, 110)}`);
    });
  }
  check("C-9a", "（㊱）扩展**用户可见文案**里已无配对措辞（`userMessage`/`ui`/`aria-label`/HTML 文本）",
    visibleHits.length === 0,
    `${extFiles.length + distFiles.length} 个扩展文件已扫（剥注释）`,
    visibleHits.slice(0, 6).join(" | "));
  if (internalHits.length) {
    info("C-9a′", "（㊱）内部标识符/注释里仍留有配对时代的词（非用户可见，不判失败）",
      internalHits.slice(0, 6).join(" | "));
  }

  /* ── C-9b（㉝）元素选择：`source.selection` 恒为 `false` ───────────────── */
  const bg = readIfExists("extension/src/background.js") || "";
  const picker = readIfExists("extension/src/content/picker.js");
  // 一个文件里 `selection:` 可能出现多次（提取结果对象、信封对象…），要看**全部**：
  // 只要有「绑定到 mode === "selection"」的那一处，且**没有任何**写死 `true` 的，就算达标。
  const selectionExprs = [...bg.matchAll(/selection:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const selectionOnlyText = selectionExprs.some((e) => /mode\s*===\s*["']selection["']/.test(e));
  const selectionAlwaysTrue = selectionExprs.filter((e) => /^true$/.test(e));
  const pickerNeverTrue = picker != null && !/selection\s*:\s*true/.test(stripComments(picker));
  const elementModeExists = /mode\s*===\s*["']element["']/.test(bg);
  check("C-9b", "（㉝）元素选择走 `body`、`source.selection` 恒为 `false`（只有文本选区模式才为 true）",
    Boolean(picker) && selectionOnlyText && selectionAlwaysTrue.length === 0 && pickerNeverTrue && elementModeExists,
    `picker.js=${picker ? `${picker.length} 字节` : "**不存在**"}；selection 表达式=${JSON.stringify(selectionExprs)}；element 模式存在=${elementModeExists}；picker 里无 selection:true=${pickerNeverTrue}`,
    `picker.js=${picker ? "存在" : "**不存在（㉝ 未落地）**"}；有「mode === selection」绑定=${selectionOnlyText}；写死 true 的处数=${selectionAlwaysTrue.length}（${selectionAlwaysTrue.join(", ") || "无"}）；element 模式存在=${elementModeExists}；picker 里无 selection:true=${pickerNeverTrue}`);

  /* ── C-9c（㉝）元素选择交互纪律：不改页面 DOM、Esc 取消、拦住那一次点击 ──── */
  const pickerText = picker ? stripComments(picker) : "";
  const rules = {
    "Shadow DOM 覆盖层": /attachShadow\s*\(/.test(pickerText),
    "shadow 为 closed": /mode\s*:\s*["']closed["']/.test(pickerText),
    "Esc 取消": /["']Escape["']/.test(pickerText),
    阻止默认行为: /preventDefault\s*\(\s*\)/.test(pickerText),
    阻止冒泡: /stopPropagation\s*\(\s*\)/.test(pickerText),
    "注入方式只有 picker.js": /files:\s*\[\s*["']content\/picker\.js["']\s*\]/.test(bg),
  };
  const missingRules = Object.entries(rules).filter(([, ok]) => !ok).map(([k]) => k);
  check("C-9c", "（㉝）元素选择交互纪律（Shadow DOM 覆盖层 / Esc / preventDefault+stopPropagation / 只注入一层）",
    Boolean(picker) && missingRules.length === 0,
    Object.keys(rules).join(" ✓、") + " ✓",
    `未满足：${missingRules.join(", ") || "(picker.js 不存在)"}`);

  /* ── C-9d（㉝）受限页面如实提示：不得静默失败 ─────────────────────────── */
  const restrictedLabel = /IMP-1006[\s\S]{0,120}?label:\s*["'][^"']+["']/.test(bg);
  const hasRestrictedFn = /function\s+isRestrictedUrl|const\s+RESTRICTED_RE/.test(bg);
  const extErrSrc = readIfExists("extension/src/lib/errors.js") || "";
  const uiCopy = /"IMP-1006"[\s\S]{0,300}?ui:\s*["'][^"']+["']/.test(extErrSrc);
  check("C-9d", "（㉝）受限页面（`chrome://` / 扩展商店 / PDF）如实提示 `IMP-1006`，不静默失败",
    hasRestrictedFn && restrictedLabel && uiCopy,
    `isRestrictedUrl/RESTRICTED_RE=${hasRestrictedFn}、受限时给出用户可见 label=${restrictedLabel}、errors.js 的 IMP-1006 有 ui 文案=${uiCopy}`,
    `isRestrictedUrl=${hasRestrictedFn} label=${restrictedLabel} ui=${uiCopy}`);

  /* ── C-9e 扩展用户可见文案 0 反引号（src + dist 产物） ─────────────────── */
  // 背景：D-V10 —— `IMP-4008` 的文案里曾有字面反引号（给用户看的是「不能使用 `..`」）。
  // 这里扫描所有 `userMessage:` / `ui:` 字面量（含 dist 产物，因为它才是真正装进浏览器的）。
  const backtickHits = [];
  for (const rel of [...extFiles, ...distFiles]) {
    const text = stripComments(readIfExists(rel) || "");
    for (const m of text.matchAll(/(?:userMessage|ui|label)\s*:\s*(["'])((?:(?!\1)[\s\S])*?)\1/g)) {
      if (m[2].includes("`")) backtickHits.push(`${rel}: 「${m[2].slice(0, 80)}」`);
    }
  }
  check("C-9e", "扩展用户可见文案 0 字面反引号（含 `dist` 产物）",
    backtickHits.length === 0,
    `${extFiles.length + distFiles.length} 个文件已扫`,
    backtickHits.slice(0, 5).join(" | "));

  /* ── C-9f 渲染层新增面板 0 个 fetch(（设置页走 IPC，不走 HTTP） ─────────── */
  const rendererChanged = (git(["diff", "--name-only", BASELINE, "--", "src"]) || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((rel) => TEXT_EXT.has(path.extname(rel)));
  const fetchHits = grepFiles(rendererChanged, /\bfetch\s*\(/, { strip: true });
  check("C-9f", "渲染层改动文件里 0 处 `fetch(`（设置页/面板一律走 IPC）",
    fetchHits.length === 0,
    `${rendererChanged.length} 个改动中的渲染层文件已扫，0 处 fetch(`,
    fetchHits.slice(0, 5).map((h) => `${h.file}:${h.line}`).join(" | "));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §11 C-10 · ㊷ 左栏「其他」可折叠组（Lead 2026-09-30 指派；写入范围仅本脚本）
 *
 * **为什么单独成组**：㊷ 落地（`a5cb883`）之后，两个脚本里**没有任何 check 引用它** ——
 * 「新增/删除一条 UI 规矩」如果没人看着，下一次重构就会静默回退，而**回退不会红**。
 * （㊵ 高亮移除 / ㊶ popup 极简**尚未落地**，按 Lead 指示**先不加**：落地前加就是恒红，
 * 而恒红的断言会被当噪声忽略；M1 落地后由 Lead 通知再加，且**必须是 FAIL 而不是 INFO**。）
 *
 * **判据是静态的**（读真源 `src/components/Sidebar.tsx` + `src/styles/app.css`），
 * 所以它证明的是「代码里确实有这套结构」，**不证明**「真实窗口里点一下真的折叠」——
 * 后者在 `C-10u` 里如实标 SKIP（不计通过）。真机交互我无法在本环境验证。
 *
 * **每条判据都配内存变异**（`C-10·变异`）：变异是唯一能证明「断言不是恒绿」的办法。
 * 同时要求「变异真的改到了文本」—— 一个什么都没改的变异会让自检**误报为通过**，
 * 那正是 a-defects 里 `NO_EFFECT` 与 `MISSED` 必须分开的同一条原则。
 */
group("§11 左栏「其他」可折叠组（㊷）");

const SIDEBAR_TSX = "src/components/Sidebar.tsx";
const SIDEBAR_CSS = "src/styles/app.css";

/** 判据函数：源码文本进、结论出。做成纯函数才能在同一份真源上重跑变异。 */
function othersGroupChecks(tsx, css) {
  const headMatch = /className="tree__group tree__group--toggle"([\s\S]{0,700}?)\n\s*其他/.exec(tsx);
  const head = headMatch ? headMatch[0] : "";
  const childStart = tsx.indexOf("{othersOpen ? (");
  const childEnd = childStart < 0 ? -1 : tsx.indexOf(") : null}", childStart);
  const childrenBlock = childStart >= 0 && childEnd > childStart ? tsx.slice(childStart, childEnd) : "";
  const labels = [...childrenBlock.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);
  const depths = [...childrenBlock.matchAll(/depth=\{(\d+)\}/g)].map((m) => Number(m[1]));
  // 缩进公式必须落在 **ScopeRow 自己** 的函数体里（只在文件里随便找一处是不够的 ——
  // 变异自检第一次跑就抓住了这个漏洞：非全局替换只删掉三处中的一处，断言照样绿）。
  const scopeRowStart = tsx.indexOf("function ScopeRow(");
  // 注意：`ScopeRow` 的**参数类型注解**里就有 `\n}`（`}): ReactNode {`），所以不能直接找第一个 `\n}`：
  // 那样切出来的「函数体」在签名处就结束了，缩进公式落在窗口之外 —— 变异自检第一次跑就抓到了这个 bug。
  const scopeSigEnd = scopeRowStart < 0 ? -1 : tsx.indexOf("): ReactNode {", scopeRowStart);
  const scopeRowEnd = scopeSigEnd < 0 ? -1 : tsx.indexOf("\n}", scopeSigEnd);
  const scopeRowBlock = scopeRowStart >= 0 && scopeRowEnd > scopeRowStart ? tsx.slice(scopeRowStart, scopeRowEnd) : "";
  const scopeIndentOk = /paddingLeft:\s*6 \+ depth \* 13/.test(scopeRowBlock);
  const formulaCount = (tsx.match(/6 \+ depth \* 13/g) || []).length;
  const defaultOpen = /const \[othersOpen, setOthersOpen\] = useState\(true\)/.test(tsx);
  const cssToggle = /\.tree__group--toggle\s*\{/.test(css);
  const cssCaret = /\.tree__caret\.is-open\s*\{/.test(css);
  const ariaOk = /aria-expanded=\{othersOpen\}/.test(head);
  const toggleOk = /setOthersOpen\(\(open\) => !open\)/.test(head);
  const caretOk = /tree__caret/.test(head);

  return {
    "C-10a": {
      title: "「其他」是可折叠按钮：`tree__group--toggle` + `aria-expanded` + 点击切换 + `tree__caret`（CSS 三件套齐）",
      ok: head !== "" && ariaOk && toggleOk && caretOk && cssToggle && cssCaret,
      detail: `按钮块=${head !== ""} aria-expanded=${ariaOk} 点击切换=${toggleOk} caret=${caretOk}`
        + ` CSS .tree__group--toggle=${cssToggle} .tree__caret.is-open=${cssCaret}`,
    },
    "C-10b": {
      title: "「其他」的子项缩进一级（3 个子项全部 `depth={1}`），与文件夹子项同一公式 `6 + depth * 13`",
      ok: depths.length === 3 && depths.every((d) => d === 1) && scopeIndentOk && formulaCount >= 2,
      detail: `子项 depth=${JSON.stringify(depths)}（期望 [1,1,1]）ScopeRow 内有缩进公式=${scopeIndentOk}`
        + ` 全文件出现次数=${formulaCount}（与文件夹行共用同一写法）depth=1 → ${6 + 1 * 13}px`,
    },
    "C-10c": {
      title: "默认展开（`useState(true)`），且子项只在展开时渲染（同一状态驱动 `aria-expanded` 与渲染条件）",
      ok: defaultOpen && childrenBlock !== "",
      detail: `默认展开=${defaultOpen} 子项位于 othersOpen 条件块内=${childrenBlock !== ""}`,
    },
    "C-10d": {
      title: "左栏条目文案是「收件箱」（不再叫「导入收件箱」）——**只限左栏**，面板仍叫「导入收件箱」是另一件事",
      ok: labels.includes("收件箱") && !/label="导入收件箱"/.test(tsx),
      detail: `子项文案=${JSON.stringify(labels)}`,
    },
    "C-10e": {
      title: "子项成员与顺序固定：星标笔记 → 回收站 → 收件箱",
      ok: JSON.stringify(labels) === JSON.stringify(["星标笔记", "回收站", "收件箱"]),
      detail: `实际=${JSON.stringify(labels)}`,
    },
  };
}

const sidebarTsx = readIfExists(SIDEBAR_TSX);
const sidebarCss = readIfExists(SIDEBAR_CSS);
const C10_IDS = ["C-10a", "C-10b", "C-10c", "C-10d", "C-10e"];
if (sidebarTsx === null || sidebarCss === null) {
  for (const id of C10_IDS) skip(id, "㊷ 左栏「其他」可折叠组", `${SIDEBAR_TSX} 或 ${SIDEBAR_CSS} 读不到`);
} else {
  const real = othersGroupChecks(sidebarTsx, sidebarCss);
  for (const id of C10_IDS) check(id, real[id].title, real[id].ok, real[id].detail, real[id].detail);

  /* ── C-10·变异：8 个内存变异，各自让**对应**检查翻红，且不牵连其它检查 ── */
  const swapChildRows = (source) => {
    const start = source.indexOf("{othersOpen ? (");
    const end = start < 0 ? -1 : source.indexOf(") : null}", start);
    if (start < 0 || end < 0) return source;
    const block = source.slice(start, end);
    const rows = block.match(/<ScopeRow[\s\S]*?\/>/g) || [];
    if (rows.length !== 3) return source;
    let i = rows.length;
    const swapped = block.replace(/<ScopeRow[\s\S]*?\/>/g, () => rows[--i]);
    return source.slice(0, start) + swapped + source.slice(end);
  };
  const C10_MUTATIONS = [
    { name: "no-aria", target: "C-10a", expect: [], apply: (s) => s.replace(/\n\s*aria-expanded=\{othersOpen\}/, "") },
    { name: "no-caret", target: "C-10a", expect: [], apply: (s) => s.replace(/<span className=\{cn\("tree__caret", othersOpen && "is-open"\)\}>[\s\S]*?<\/span>/, "") },
    { name: "no-css-toggle", target: "C-10a", expect: [], apply: (s, c) => [s, c.replace(/\.tree__group--toggle\s*\{[\s\S]*?\}/, "")] },
    { name: "flat-depth", target: "C-10b", expect: [], apply: (s) => s.replace(/depth=\{1\}/g, "depth={0}") },
    { name: "indent-formula", target: "C-10b", expect: [], apply: (s) => s.replace(/paddingLeft:\s*6 \+ depth \* 13/g, "paddingLeft: 0") },
    { name: "collapse-default", target: "C-10c", expect: [], apply: (s) => s.replace("const [othersOpen, setOthersOpen] = useState(true)", "const [othersOpen, setOthersOpen] = useState(false)") },
    // 「总是渲染」会把 `{othersOpen ? (` 这个**取词锚点**一起拿掉，于是 C-10b/d/e 的取词范围也空了。
    // 这是**已知且可接受**的牵连（方向是安全的：它们红/缺失，不会假绿），所以显式声明，
    // 而不是把「无牵连」这条判据放松 —— 放松之后自检就再也抓不住真正的假通过了。
    { name: "always-render", target: "C-10c", expect: ["C-10b", "C-10d", "C-10e"], apply: (s) => s.replace("{othersOpen ? (", "{true ? (") },
    // 改文案同时就是改「子项成员」，C-10e 必然跟着红 —— 同样是可预期的牵连。
    { name: "old-label", target: "C-10d", expect: ["C-10e"], apply: (s) => s.replace('label="收件箱"', 'label="导入收件箱"') },
    { name: "swap-children", target: "C-10e", expect: [], apply: (s) => swapChildRows(s) },
  ];
  const mutationLog = [];
  let mutationsOk = true;
  for (const m of C10_MUTATIONS) {
    let mutTsx = sidebarTsx;
    let mutCss = sidebarCss;
    const applied = m.apply(mutTsx, mutCss);
    if (Array.isArray(applied)) [mutTsx, mutCss] = applied;
    else mutTsx = applied;
    // 「变异真的改到了文本」必须单独判：什么都没改的变异会让自检**假通过**。
    const changed = mutTsx !== sidebarTsx || mutCss !== sidebarCss;
    const verdict = othersGroupChecks(mutTsx, mutCss);
    const targetRed = verdict[m.target].ok === false;
    const collateral = C10_IDS.filter((id) => id !== m.target && verdict[id].ok === false).sort();
    const expect = [...m.expect].sort();
    const collateralOk = collateral.join(",") === expect.join(",");
    const ok = changed && targetRed && collateralOk;
    if (!ok) mutationsOk = false;
    const why = [
      changed ? "" : "**变异没改到文本**",
      targetRed ? "" : "目标仍绿",
      collateralOk ? "" : `牵连与声明不符（实际 ${collateral.join(",") || "无"} / 声明 ${expect.join(",") || "无"}）`,
    ].filter(Boolean).join("；");
    mutationLog.push(`${m.name}→${m.target} ${ok ? "红✓" : `未红✗（${why}）`}`
      + `${collateral.length ? `（+牵连 ${collateral.join(",")}）` : ""}`);
  }
  check("C-10·变异", `㊷ 断言自检：${C10_MUTATIONS.length} 个内存变异各自让对应检查翻红，且牵连与声明一致（证明这 5 条不是恒绿）`,
    mutationsOk, mutationLog.join("；"), mutationLog.join("；"));

  skip("C-10u", "真实窗口里点「其他」能折叠/展开、caret 旋转、子项缩进肉眼对齐",
    "本环境无 Electron 窗口与浏览器。静态判据见 C-10a…C-10e（已过）；复现：`pnpm dev:electron` → 左栏点「其他」→ 目视 3 个子项收起/展开、缩进一级。**SKIP 不计通过。**");
  info("C-10·范围", "同一批文案在其它界面上的现状（㊷ 只裁定左栏，故仅登记不改判）",
    "`src/components/InboxPanel.tsx` 标题与 `aria-label` 仍是「导入收件箱」，`StatusBar`/命令面板仍是「打开导入收件箱」——"
    + "若 Lead 想把它们一并改名，应另立一条裁定，本条不替它做主。");
}

/* ── C-11 契约文档缺口登记（INFO，不改判）───────────────────────────────────
 * 起因：给 `S7B.1` 的清单找「出处」时我差点写下一个**假引用**（`02 §3.2` 其实是
 * 「H1 与 front-matter 的拼装顺序」）。核完才发现：这 5 个桥状态字段在 `02` 里根本没有清单。
 * 我把它登记成一条**可复算的 INFO**（不假装它是通过），因为「断言引用了不存在的出处」
 * 和「标签撒谎」是同一类问题 —— 只是这次还没撒出去就被抓住了。 */
{
  const doc02 = readIfExists("docs/import/02-接口契约-导入信封与通道.md");
  const statusKeys = ["address", "error", "lastRejectedOrigin", "startPort", "portRange"];
  if (doc02 === null) info("C-11", "桥状态字段清单的文档出处", "读不到 02 契约文件，无法统计");
  else {
    const counts = statusKeys.map((k) => `${k}=${doc02.split(k).length - 1}`);
    // 只对**有辨识度**的字段下结论：`address` / `error` 是通用词，会命中 `server.address()` 这类无关文本。
    const distinctive = ["lastRejectedOrigin", "startPort", "portRange"];
    const distinctiveHits = distinctive.filter((k) => doc02.includes(k));
    info("C-11", "`BridgeStatus` 字段清单在 02 号契约里没有出处（文档缺口，登记不改判）",
      `02 内出现次数：${counts.join(", ")}；其中**有辨识度的** 3 个（${distinctive.join(" / ")}）命中 ${distinctiveHits.length}/3`
      + `（address/error 是通用词，可能只是 `+ "`server.address()`" + ` 这类无关文本）`
      + `。权威出处目前只有 src/desktop/bridge.ts 的 BridgeStatus。`
      + (distinctiveHits.length === 0 ? "→ S7B.1 的清单只能引代码，不能引文档；若契约应当列这些字段，请派 d-contract 补一段。" : ""));
  }
}




(async () => {
  try {
    await dynamicChecks();
  } catch (error) {
    fail("DYN-FATAL", "动态段崩溃", error && error.stack ? error.stack.split("\n")[0] : String(error));
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const failures = results.filter((r) => r.status === "FAIL");
  const skips = results.filter((r) => r.status === "SKIP");

  if (WANT_JSON) {
    console.log(JSON.stringify({ baseline: BASELINE, changed: PRODUCT_CHANGED, counts, results }, null, 2));
  } else {
    console.log("\n=== 契约验证摘要 ===");
    console.log(`PASS ${counts.PASS || 0} / FAIL ${failures.length} / SKIP ${counts.SKIP || 0} / INFO ${counts.INFO || 0}`);
    console.log(`基线 ${BASELINE}；本次产品改动面 ${PRODUCT_CHANGED.length} 个文件`);
    if (failures.length) {
      console.log("\n--- 失败清单（必须修） ---");
      for (const f of failures) console.log(`  FAIL [${f.id}] ${f.title}\n        ${f.detail}`);
    }
    if (skips.length) {
      console.log("\n--- 未验证清单（SKIP：不得当作通过） ---");
      for (const s of skips) console.log(`  SKIP [${s.id}] ${s.title} — ${s.detail}`);
    }
  }

  process.exit(failures.length ? 1 : 0);
})();
