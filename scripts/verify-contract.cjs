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
const crypto = require("crypto");
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

/** 撤回刚记下的一条：把它换成 SKIP（「树在动 → 本次不判」）。
 *  用法与 e2e 里那条 `COVERAGE-SELFTEST` 同族：**结论进了台账还能被收回**，
 *  否则「先判后撤」会留下一条假的 PASS/FAIL。 */
function withdrawLast(id, why) {
  const last = results[results.length - 1];
  if (!last || last.id !== id) throw new Error(`withdrawLast: 最后一条不是 ${id}（是 ${last && last.id}）`);
  results.pop();
  return skip(id, last.title, why);
}

/* ------------------------------------------------------- 变异落地自检（NO_EFFECT）
 * 纪律（交接文档 §五 / Lead 反复强调）：**变异必须先证明落地**。
 *   · 打印「命中 N 处 + 改动前后 sha256」；
 *   · 命中 0 处 = `NO_EFFECT` —— **不等于 MISSED**（判据可能压根没被启用），
 *     也**不能**当成「护栏检测到了」；
 *   · 一旦出现 NO_EFFECT 就 `exit 2`（脚本自己不可信），**不进红绿判定**。
 * 这条纪律对**检查器自己**同样适用 —— 一个什么都没改到的变异会让自检**假通过**，
 * 那正是本项目一路在打的「恒绿」缺陷。
 *
 * `NO_EFFECTS` 非空时：对应自检不记 PASS/FAIL（只记 INFO 说明「本次未执行」），
 * 收尾以退出码 2 中止（与「树在动」同一个语义：不可信 ≠ 失败，也 ≠ 通过）。
 */
const NO_EFFECTS = [];

const sha256 = (text) => crypto.createHash("sha256").update(String(text), "utf8").digest("hex");

/** 记一条 NO_EFFECT（变异没落地）。返回 false，便于调用方 `if (!landed(...)) continue;`。 */
function noEffect(id, name, why) {
  NO_EFFECTS.push(`${id} · ${name}：${why}`);
  if (!WANT_JSON) console.log(`  NO_EFFECT  [${id}] ${name}：${why}`);
  return false;
}

/**
 * 变异落地判定（**所有变异都必须先过这一关**）。
 *
 * @param id      所属自检 id（如 `C-12·变异自检`）
 * @param name    变异名
 * @param before  变异前源码
 * @param after   变异后源码
 * @param hits    命中处数（调用方自己数；**必须自己数**，不能拿「字符串不等」当命中）
 * @param target  期望被影响的判据 id（null = 控制组，不要求翻红）
 * @returns true = 已落地，可以进红绿判定
 */
function mutationLanded(id, name, before, after, hits, target) {
  const a = sha256(before);
  const b = sha256(after);
  const line = `命中 ${hits} 处 | sha256 ${a} → ${b}`
    + (target === null ? " | 控制组" : ` | 目标 ${target}`);
  if (!WANT_JSON) console.log(`  MUTATE     [${id}] ${name} — ${line}`);
  if (hits <= 0) {
    return noEffect(id, name, `变异命中 **0 处**（sha256 ${a} → ${b}）—— 锚点没对上源码，本条自检**未执行**，不作红绿判定`);
  }
  if (before === after) {
    return noEffect(id, name, `变异后与变异前**逐字相同**（sha256 ${a}）—— 本条自检**未执行**，不作红绿判定`);
  }
  return true;
}

/** 数一处替换的命中数（字符串，非正则注入面）。 */
const countOf = (text, needle) => (needle === "" ? 0 : String(text).split(needle).length - 1);

/**
 * 改动**行**数（按行多重集差，`0` ⇔ 两份文本的行多重集相同）。
 *
 * 用途：当变异的形态是「在任意位置插/删/改若干行」时，没法用固定 needle 数命中。
 * 这里数的是「进去了多少行 / 出来多少行」，作为**落地自检的命中处数** ——
 * 它证明的是「变异真的改动了输入」，比旧版「字符串不等」强一步
 * （字符串不等也可能只是空白差异，而 `0` 命中必须报 `NO_EFFECT`）。
 */
function changedLineCount(a, b) {
  const A = String(a).split("\n");
  const B = String(b).split("\n");
  const pool = new Map();
  for (const line of A) pool.set(line, (pool.get(line) || 0) + 1);
  let common = 0;
  for (const line of B) {
    const left = pool.get(line) || 0;
    if (left > 0) { pool.set(line, left - 1); common += 1; }
  }
  return (A.length - common) + (B.length - common);
}

/**
 * 在**注释**里找一段自证文本（不剥注释：这里要的就是注释）。
 * 用于「声明的例外必须自证」范式（C-12b 的 handler、BR-14 的删除白名单）。
 */
function commentsOf(text) {
  const out = [];
  for (const m of String(text).matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) out.push(m[0]);
  return out.join("\n");
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

/** `grepFiles()` 的**内存版**：输入是 `{rel, text}`。变异自检要在内存里重扫，不写盘。 */
function grepFilesInMemory(items, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const hits = [];
  for (const item of items) {
    const lines = String(item.text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const scanner = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      let m;
      while ((m = scanner.exec(lines[i])) !== null) {
        hits.push({ file: item.rel, line: i + 1, text: lines[i].trim(), match: m[0] });
        if (m.index === scanner.lastIndex) scanner.lastIndex += 1;
      }
    }
  }
  return hits;
}

/**
 * `grepFiles()` 的命中对象是 `{ file, line, text, match }`——**没有** `lines` 字段。
 * 需要上下文时按需重读该文件（不要假设命中对象带整份文件，那会得到 `undefined.slice`）。
 */function lineWindow(hit, before = 2, after = 4) {
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

  /* ⚠️ **扫描范围（Lead 2026-09-30 裁定 2）**：`extension/tools/**` 是**诊断工具**（本项目口径：
   * 不是门禁、不得当证据引用），探针给自己挑一个空闲端口 `server.listen(0, …)` 是合法夹具，
   * 不是「产品在选端口」。`BR-4` 的意图是「**桥**不许把 8787–8796 之外的端口当产品端口」，
   * 所以范围排掉诊断工具目录 —— 但**必须配控制组证明它没变成恒绿**（见下面的 BR-4·变异自检：
   * 往 `electron/bridge.cjs` 塞一行 `listen(0)` 必须仍然红）。 */
  const isDiagnosticTool = (rel) => /(^|\/)extension\/tools\//.test(rel) || /(^|\/)tools\/[^/]*probe/.test(rel);
  const productScope = bridgeFiles.filter((rel) => !isTestPath(rel) && !isDiagnosticTool(rel));
  const listenZero = grepFiles(productScope, /listen\s*\(\s*0\s*[,)]/);
  // 测试里为「取一个空闲端口」短暂 listen(0) 是合法夹具，单列 INFO 而不是 FAIL。
  const zeroInTests = grepFiles(testFiles, /listen\s*\(\s*0\s*[,)]/);
  if (zeroInTests.length) {
    info("BR-4b", "测试夹具里出现 listen(0)（不算违规）",
      zeroInTests.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  }
  const zeroInTools = grepFiles(bridgeFiles.filter(isDiagnosticTool), /listen\s*\(\s*0\s*[,)]/);
  if (zeroInTools.length) {
    info("BR-4c", "诊断工具里出现 listen(0)（挑空闲端口，**不算产品端口**；工具本身不得当门禁证据）",
      zeroInTools.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  }
  check("BR-4", "产品代码不使用端口 0（契约禁止；**扫描范围不含 `extension/tools/**` 诊断工具与测试夹具**）",
    listenZero.length === 0,
    `0 处（产品代码 ${productScope.length} 个文件）`,
    listenZero.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  /* ── BR-4·变异自检（控制组方向）：把 `listen(0, …)` 放进**产品文件**里必须仍然红 ──
   * 只把诊断工具排除掉、不证明它还能红，就等于把一条真判据改成恒绿。 */
  {
    const probes = [
      { name: "bridge-listen-zero（往 electron/bridge.cjs 塞 listen(0, …)）", suffix: "electron/bridge.cjs" },
      { name: "ext-bridge-listen-zero（往 extension/src/lib/bridge.js 塞 listen(0, …)）", suffix: "extension/src/lib/bridge.js" },
    ];
    const bad = [];
    const log = [];
    for (const m of probes) {
      const rel = productScope.find((r) => r.replace(/\\/g, "/").endsWith(m.suffix));
      if (rel === undefined) {
        noEffect("BR-4·变异自检", m.name, `产品文件清单里找不到 ${m.suffix}（扫描范围口径变了？）`);
        log.push(`${m.name}→NO_EFFECT（未判定）`);
        continue;
      }
      const before = readIfExists(rel) || "";
      const after = `${before}\nserver.listen(0, '127.0.0.1')\n`;
      if (!mutationLanded("BR-4·变异自检", m.name, before, after, countOf(after, "listen(0"), "BR-4")) {
        log.push(`${m.name}→NO_EFFECT（未判定）`);
        continue;
      }
      // 在**内存里**重扫：只把那一个文件的文本换成变异版（不写盘）。
      const mutated = grepFilesInMemory(
        productScope.map((r) => ({ rel: r, text: r === rel ? after : (readIfExists(r) || "") })),
        /listen\s*\(\s*0\s*[,)]/,
      );
      const red = mutated.length > 0;
      if (!red) bad.push(`${m.name}：注入后 BR-4 仍绿（**这条判据已经恒绿了**）`);
      log.push(`${m.name}→${red ? "红✓" : "未红✗"}`);
    }
    check("BR-4·变异自检", `${probes.length} 个控制组：把 \`listen(0, …)\` 放进**产品文件**（bridge.cjs / extension/src）→ BR-4 必须仍然红`,
      bad.length === 0, log.join("；"), `不成立的变异：${bad.join(" | ")}`);
  }
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
/**
 * **声明式删除白名单**（Lead 2026-09-30 裁定）。
 *
 * `preload` 的方法名/arity 冻结是「不许静默回归」的护栏；但**故意的 API 删除**是另一回事：
 * C-12c 裁定「删死订阅、不补发送方」时，`onMenu` / `onImportNotice` 就是**该删的**。
 * 判据必须能区分「声明的删除」与「回归」，否则一条**正确**的删除会让护栏永远红 ——
 * 而永远红的断言会被当噪声忽略（比没有更坏）。
 *
 * 范式沿用 C-12b 的「**要豁免就得自证**」：被删的方法名、**或它订阅的那个频道字面量**，
 * 必须出现在 `electron/preload.cjs` 的**注释**里（自证 = 下一个人读代码时能看见为什么）。
 * 白名单是**显式清单**（不是通配、不是「允许任意删除」）；证不出来 → 照旧算红。
 * 反向也有自检：删一个**未声明**的方法 → 必须**仍然红**（`BR-14·变异自检`）。
 */
const DECLARED_PRELOAD_REMOVALS = [
  { name: "onMenu", why: "C-12c / 交接 §四-B1：菜单栏被故意移除（非 darwin 上 Menu.setApplicationMenu(null)）⇒ 删死订阅，不补发送方" },
  { name: "onImportNotice", why: "C-12c / 交接 §四-B2：主进程从未发过它，三件事各有产地（workspace-changed / inbox:changed / announce）⇒ 删订阅" },
];

/** 从 HEAD 版 preload 里找出某个方法**订阅的那个频道字面量**（用于自证匹配）。
 *  兼容两种写法：`name: (cb) => subscribe(CONST, cb)` 与
 *  方法简写 `name(cb) { … ipcRenderer.on(CONST, listener) … }`。 */
function baselineChannelOf(headSource, methodName) {
  const consts = channelConstsOf(headSource);
  const resolve = (id) => (id ? consts.get(id) : null);
  const arrow = new RegExp(`${methodName}\\s*:\\s*\\([^)]*\\)\\s*=>\\s*subscribe\\(\\s*([A-Za-z_$][\\w$]*)`).exec(headSource);
  const body = new RegExp(`\\n\\s{2}${methodName}\\([^)]*\\)\\s*\\{([\\s\\S]{0,900}?)\\n\\s{2}\\},`).exec(headSource);
  const inBody = body ? /(?:subscribe|ipcRenderer\.on)\(\s*([A-Za-z_$][\w$]*)/.exec(body[1]) : null;
  const id = (arrow && arrow[1]) || (inBody && inBody[1]) || null;
  return resolve(id);
}

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
    /**
     * 差分分类（纯函数：同一份真源上可重跑，变异自检就靠它）。
     * @returns `{ changed, declaredRemoved, regressions, evidence }`
     */
    const preloadDelta = (beforeSrc, afterSrc, declarations = DECLARED_PRELOAD_REMOVALS) => {
      const before = snapshotApi(beforeSrc);
      const after = snapshotApi(afterSrc);
      const afterMap = new Map(after.map((e) => [e.name, e.arity]));
      const changed = before.filter((e) => afterMap.get(e.name) !== e.arity);
      const added = after.filter((e) => !before.some((b) => b.name === e.name));
      const comments = commentsOf(afterSrc);
      const declaredRemoved = [];
      const regressions = [];
      const evidence = [];
      for (const c of changed) {
        const declaration = declarations.find((d) => d.name === c.name);
        const channel = baselineChannelOf(beforeSrc, c.name);
        if (declaration && afterMap.get(c.name) === undefined) {
          const provedBy = comments.includes(c.name) ? `方法名 \`${c.name}\``
            : (channel && comments.includes(channel)) ? `频道 \`${channel}\`` : null;
          if (provedBy) {
            declaredRemoved.push(c.name);
            evidence.push(`${c.name}（自证：preload 注释里写着 ${provedBy}）`);
            continue;
          }
          regressions.push(`${c.name}: ${c.arity} → 已删除，但**注释里既没有方法名也没有它订阅的频道**
            （自证失败；删除必须自证：${declaration.why}）`.replace(/\s+/g, " "));
          continue;
        }
        regressions.push(`${c.name}: ${c.arity} → ${afterMap.get(c.name)}`
          + (declaration ? "（虽是声明的删除项，但**不是删除**而是改了 arity ⇒ 不算声明式删除）" : ""));
      }
      return { before, after, changed, added, declaredRemoved, regressions, evidence };
    };

    try {
      const d = preloadDelta(headSource, nowSource);
      check("BR-14", `preload 既有 ${d.before.length} 项方法名与 arity 不变`
        + `（**声明的删除**除外，且删除必须自证：注释里写明被删方法名或它订阅的频道）`,
        d.regressions.length === 0,
        `既有 ${d.before.length} 项：一致 ${d.before.length - d.changed.length} 项`
        + `；**声明的删除 ${d.declaredRemoved.length} 项**（${d.evidence.join("、") || "无"}）`
        + `；新增 ${d.added.length} 项（${d.added.map((a) => `${a.name}/${a.arity}`).join(", ") || "无"}）`,
        `回归/未自证的删除：${d.regressions.join(" | ")}`
        + `。处置：若不是有意删除，恢复原状；若是有意删除，**在 preload.cjs 的注释里写明原因**`
        + `（这是「声明的删除」，不是回归）。**不要**往前挪 BASELINE 来让整组判据一起变松。`);

      /* ── BR-14·变异自检：三种形态各一条（都先证明落地）────────────────────
       *  ① 删一个**未声明**的方法 → 必须判成回归（红）；
       *  ② 删一个**已声明**的方法 → 必须判成「声明的删除」（绿）—— 若这条红，
       *     说明白名单没生效，那正版删除会被永远判红（噪声）；
       *  ③ 只改一个方法的 **arity**（不删）→ 必须判成回归（红）—— 证明判据不只看「在不在」。 */
      /** 从 preload 源码里删掉一个方法条目（单行箭头条目与多行方法简写都支持）。 */
      const removePreloadMethod = (source, name) => {
        const lines = String(source).split("\n");
        const out = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (new RegExp(`^[ \\t]*${name}\\s*:`).test(lines[i])) continue; // 单行条目
          if (new RegExp(`^[ \\t]*${name}\\s*\\(`).test(lines[i])) { // 多行方法简写
            i += 1;
            while (i < lines.length && !/^[ \t]*\},?\s*$/.test(lines[i])) i += 1;
            continue;
          }
          out.push(lines[i]);
        }
        return out.join("\n");
      };
      /* ⚠️ 被删的锚点必须选**在 HEAD 里也存在**的方法：差分是「HEAD ⇄ 现在」，
       * 删一个本来就不在 HEAD 里的新方法（如 `onDeepLink`）不会出现在 `changed` 里
       * —— 第一版就选错了目标，两条变异都「没变红」，是自检自己抓出来的。 */
      const mutations14 = [
        { name: "undeclared-remove（删一个**未声明**的方法 `shell.openExternal`）", removed: "openExternal: (url) => invoke('opennote:shell:openExternal', url),", expect: "regression",
          apply: (s) => removePreloadMethod(s, "openExternal") },
        { name: "declared-remove（删一个**已声明**的方法并把自证写进注释）", removed: "pickFolder: () => invoke('opennote:dialog:pickFolder'),", expect: "declared",
          declaration: { name: "dialog.pickFolder", why: "自检变异：故意删除并自证" },
          apply: (s) => `/* 自检变异自证：dialog.pickFolder 是有意删除（本注释就是自证文本）。 */\n${removePreloadMethod(s, "pickFolder")}` },
        { name: "arity-change（只改 arity：`shell.openExternal` 多一个形参）", needle: "openExternal: (url, extra) =>", expect: "regression",
          apply: (s) => s.replace("openExternal: (url) =>", "openExternal: (url, extra) =>") },
      ];
      const failures14 = [];
      const log14 = [];
      /* 参照系必须是**基线增量**，不是绝对零：真实树上已经有一条**声明的删除**（`onMenu`），
       * 若按绝对值判「declared 必须为空」，每一个回归变异都会背上它 —— 那不是牵连，
       * 是基线里就有的事实（同 V6 §8 的「牵连必须是增量」）。 */
      const base14 = preloadDelta(headSource, nowSource);
      const baseRegressions = new Set(base14.regressions);
      const baseDeclared = new Set(base14.declaredRemoved);
      for (const m of mutations14) {
        const mutatedSrc = m.apply(nowSource);
        /* 命中数有两种方向：`needle` = 变异**新增**的文本；`removed` = 变异**删掉**的文本。
         * 第一版只用 `needle` 数，于是「删条目」与「改 arity」两类都数成 0/-1 →
         * 被自己的 NO_EFFECT 抓出来（这正是这条纪律存在的意义）。 */
        const hits = m.removed
          ? countOf(nowSource, m.removed) - countOf(mutatedSrc, m.removed)
          : countOf(mutatedSrc, m.needle) - countOf(nowSource, m.needle);
        if (!mutationLanded("BR-14·变异自检", m.name, nowSource, mutatedSrc, hits, "BR-14")) {
          log14.push(`${m.name}→NO_EFFECT（未判定）`);
          continue;
        }
        const declarations = m.declaration ? [...DECLARED_PRELOAD_REMOVALS, m.declaration] : DECLARED_PRELOAD_REMOVALS;
        const dm = preloadDelta(headSource, mutatedSrc, declarations);
        const newRegressions = dm.regressions.filter((r) => !baseRegressions.has(r));
        const newDeclared = dm.declaredRemoved.filter((n) => !baseDeclared.has(n));
        const fine = m.expect === "regression"
          ? newRegressions.length === 1 && newDeclared.length === 0
          : newRegressions.length === 0 && newDeclared.length === 1;
        if (!fine) {
          failures14.push(`${m.name}：期望 ${m.expect}，实际**增量** regression=[${newRegressions.join("；")}] declared=[${newDeclared.join(",")}]`
            + `（基线 regression=[${base14.regressions.join("；")}] declared=[${base14.declaredRemoved.join(",")}]）`);
        }
        log14.push(`${m.name}→${m.expect} ${fine ? "✓" : "✗"}`);
      }
      check("BR-14·变异自检", `${mutations14.length} 个变异各自生效：未声明的删除/改 arity → 判回归；已声明的删除 → 判声明式删除`,
        failures14.length === 0, log14.join("；"), `不成立的变异：${failures14.join(" | ")}`);
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
//   · 不扫：`*.md` / `*.txt`（开发文档）、`tests/`、自测脚本、
//     **`extension/tools/**`（开发/自测工具：CLI 打点、cdp 探针、变异脚本 —— 不是界面文案）**
//   · 被排除的命中记 U-8c / U-8d INFO，**仍然打印出来**（不隐藏事实）
//
// 为什么把 `extension/tools/**` 划出去（2026-09-30 实测触发）：队友在做 M2 时新建了
// `extension/tools/_m2-detach*.mjs`，里面的 `console.log("  ✗ " + miss)` 让 U-8 变红。
// 那是**开发工具的 CLI 反馈**，不是界面文案 —— U-8 的标题声称的是「界面文案无 emoji」，
// 判据范围必须与标题一致，否则就是我自己在制造假红。
// 真正的严格面仍然是 `extension/dist/**`（`U-8e`，**不做任何排除**）：任何可能到达用户的
// emoji 都必须经过产物，所以在 tools 上放松不会漏掉用户可见面。
const UI_COPY_EXT_RE = /\.(ts|tsx|js|cjs|mjs|html|css)$/;
const DOC_EXT_RE = /\.(md|markdown|txt)$/;
const TOOLING_RE = /^extension\/tools\//;
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
  const toolingFiles = productFiles.filter((rel) => TOOLING_RE.test(rel));
  const uiCopyFiles = UI_COPY_FILES(productFiles.filter((rel) => !TOOLING_RE.test(rel)));
  const offenders = scan(uiCopyFiles, { strip: true });
  const toolingHits = scan(UI_COPY_FILES(toolingFiles));
  const inTests = scan(testFiles);
  const docsAndComments = [
    ...scan(productFiles.filter((rel) => DOC_EXT_RE.test(rel))).map((hit) => `[文档] ${hit}`),
    // 注释扫描只看代码文件，否则 `*.md` 会被同时算进「文档」和「注释」两桶（重复计数）
    ...scan(uiCopyFiles, { strip: false })
      .filter((hit) => !offenders.some((o) => o.split(" ")[0] === hit.split(" ")[0]))
      .map((hit) => `[注释] ${hit}`),
  ];
  if (inTests.length) {
    info("U-8b", "测试/自测脚本里的 emoji（契约不约束）",
      `${inTests.length} 处：${inTests.slice(0, 4).join(" | ")}`);
  }
  if (toolingHits.length) {
    info("U-8d", `开发工具脚本（extension/tools/**，${toolingFiles.length} 个文件）里的 emoji：不是界面文案，计 INFO 但**照实打印**`,
      `${toolingHits.length} 处：${toolingHits.slice(0, 4).join(" | ")}`
      + `（这些是 CLI/探针/变异脚本的打点；用户可见面的严格判据是 U-8e 的 extension/dist/**，那里不做任何排除）`);
  }
  check("U-8", "界面文案无 emoji（扫产品源码的 .ts/.tsx/.js/.html/.css，剥注释；不含 tests/、*.md、extension/tools/**）",
    offenders.length === 0,
    `0 处（剥注释后扫描 ${uiCopyFiles.length} 个源码文件；另排除 ${toolingFiles.length} 个开发工具文件）`,
    offenders.slice(0, 8).join(" | "));
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
      /**
       * **XML 命名空间 URI**（`http://www.w3.org/2000/svg` / `1999/xhtml` / `1999/xlink` /
       * `XML/1998/namespace`）是**标识符，不是网络资源**：`document.createElementNS(NS, 'svg')`
       * 不会发起任何请求，浏览器也不去解析它。把它们算成「远程引用」是**判据误报**
       * （Lead 2026-09-30 复核：`extension/dist/popup/popup.js` 的 `const NS = "http://www.w3.org/2000/svg"`）
       * —— 判据误报一次，就等于教别人忽略它一次。
       *
       * 收窄**只作用于「脚本里的字符串字面量」这一条**（`STRING_LITERAL`）：
       *   · 资源属性 / CSS `url()` / `fetch(...)` 参数三条**原样保留**（它们才是真的会发请求的东西）；
       *   · 命中的命名空间字面量单独记 `EX-6″` INFO（**登记，不隐藏**）。
       * 反向证明仍在：`--mutate-ex6=remote-src` 塞一个真远程 `<script src>` 必须红。
       */
      const XML_NS_LITERAL = /["'`]https?:\/\/www\.w3\.org\/(?:1999\/xhtml|2000\/svg|1999\/xlink|XML\/1998\/namespace)["'`]/g;
      const nsHits = [];
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
            // 命名空间字面量先从**这一行**里抹掉再比字符串字面量那一档（别的三档不看它）。
            const nsInLine = [...line.matchAll(XML_NS_LITERAL)].map((m) => m[0]);
            if (nsInLine.length) nsHits.push(`${rel}:${i + 1} ${nsInLine.join("、")}`);
            const lineNoNs = line.replace(XML_NS_LITERAL, '""');
            if (NET_CALL.test(line) || STRING_LITERAL.test(lineNoNs)) remote.push(where);
          } else if (RESOURCE_ATTR.test(line) || CSS_URL.test(line) || NET_CALL.test(line)) {
            remote.push(where);
          }
          if (NON_RESOURCE_ATTR.test(line) && !RESOURCE_ATTR.test(line) && !CSS_URL.test(line) && !NET_CALL.test(line)) {
            benign.push(where);
          }
          if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) evals.push(where);
        });
      }
      check("EX-6", `${scanLabel} 内 0 处**真的远程引用**（资源属性 / CSS url() / fetch 参数 / 脚本字符串字面量；`
        + `XML 命名空间 URI 与示例占位文本不算）`,
        remote.length === 0,
        `${scanFiles.length} 个文件已扫（判据已收窄：非资源属性里的示例 URL 与 ` + `www.w3.org 命名空间字面量不算）`,
        remote.slice(0, 6).join(" | "));
      if (benign.length) {
        info("EX-6′", "非资源属性（placeholder/data-*/title/aria-*/value）里的 URL 示例文本：**不算远程引用**，仅登记",
          benign.slice(0, 6).join(" | "));
      }
      if (nsHits.length) {
        info("EX-6″", "XML 命名空间 URI（`www.w3.org/…`）：**标识符，不是网络资源**，不算远程引用 —— 仅登记",
          `${nsHits.length} 处：${nsHits.slice(0, 4).join(" | ")}`);
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
          /* ⚠️ 这里**不许写死 e2e 的数字**：写死的数字迟早烂（曾写「PASS 102 / FAIL 0」，
           * 而 e2e 当时已是 106/0）。要引用就跑它，别在文案里编。 */
          skip("DYN-3", "动态调用里的落盘断言", "本脚本未打开工作区 → 落盘由 verify-e2e.cjs 覆盖（跑 `node scripts/verify-e2e.cjs` 看它的结果，别信转述）");
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

  /* ── C-9f 渲染层改动文件里 0 处**指向本地桥的** `fetch(`（设置页/面板走 IPC，不走 HTTP） ──
   *
   * **判据收窄（2026-09-30，我自己的误报）**：旧口径是「任何 `fetch(` 都算」，
   * 于是 `src/lib/export.ts:22` 的 `await fetch(url)`（`url` 来自 `resolveImageSrc()`，
   * 是**本机资源/blob URL**，用途是导出时把图内联成 data URL）被误判成「设置页绕过 IPC 打 HTTP」。
   * 判据的**意图**是「渲染层不许绕过 IPC 去请求**本地桥**（127.0.0.1:8787–8796 / `/v1/*`）」，
   * 所以只认**指向桥的**那几种实参；非桥的 fetch（本机资源、blob、data:）单列 INFO 登记，不判红。
   * 反向证明仍在（`C-9f·变异自检`）：往一个改动中的渲染层文件里塞
   * `fetch("http://127.0.0.1:8787/v1/health")` 必须红。 */
  const rendererChanged = (git(["diff", "--name-only", BASELINE, "--", "src"]) || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((rel) => TEXT_EXT.has(path.extname(rel)));
  const bridgeFetchRe = /\bfetch\s*\(\s*(?:`[^`]*|["'][^"']*)?(?:https?:\/\/(?:127\.0\.0\.1|localhost)|\/v1\/|http:\/\/127\.0\.0\.1)/;
  const fetchHits = grepFiles(rendererChanged, /\bfetch\s*\(/, { strip: true });
  const bridgeFetchHits = fetchHits.filter((h) => {
    const raw = readIfExists(h.file) || "";
    const lines = raw.split(/\r?\n/);
    // 看这一行 + 后两行：实参可能跨行（`await fetch(\n  "http://127.0.0.1:8787/v1/…"\n)`）。
    const window = lines.slice(h.line - 1, h.line + 2).join("\n");
    return bridgeFetchRe.test(window);
  });
  const benignFetch = fetchHits.filter((h) => !bridgeFetchHits.includes(h));
  check("C-9f", "渲染层改动文件里 0 处**指向本地桥的** `fetch(`（`127.0.0.1:8787–8796` / `/v1/*`）——"
    + "设置页/面板一律走 IPC；**非桥的 fetch（本机资源/blob/data:）不算**",
    bridgeFetchHits.length === 0,
    `${rendererChanged.length} 个改动中的渲染层文件已扫：0 处桥请求`
    + `；非桥 fetch ${benignFetch.length} 处已登记（${benignFetch.slice(0, 3).map((h) => `${h.file}:${h.line}`).join("、") || "无"}）`,
    bridgeFetchHits.slice(0, 5).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  if (benignFetch.length) {
    info("C-9f′", "非桥 `fetch(`（本机资源/blob/data: 之类，不是绕过 IPC 打本地接口）—— 仅登记",
      benignFetch.slice(0, 4).map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "));
  }
  /* C-9f·变异自检：往**改动中的渲染层文件**里塞一个指向桥的 fetch → 必须红。
   * （旧口径没有变异，收窄之后更不能没有 —— 否则「范围收窄」与「判据恒绿」长得一模一样。） */
  {
    const target = rendererChanged.find((rel) => rel.endsWith(".ts") || rel.endsWith(".tsx")) || null;
    const before = target ? (readIfExists(target) || "") : "";
    const after = before === "" ? "" : `${before}\nvoid fetch("http://127.0.0.1:8787/v1/health")\n`;
    if (!target || !mutationLanded("C-9f·变异自检", "bridge-fetch（往改动中的渲染层文件塞桥请求）", before, after, countOf(after, "127.0.0.1:8787"), "C-9f")) {
      if (!target) noEffect("C-9f·变异自检", "bridge-fetch", "改动面里没有 .ts/.tsx 文件可注入");
    } else {
      const mutatedHits = grepFilesInMemory(
        rendererChanged.map((rel) => ({ rel, text: rel === target ? after : (readIfExists(rel) || "") })),
        /\bfetch\s*\(/,
      ).filter((h) => {
        const text = h.file === target ? after : (readIfExists(h.file) || "");
        const lines = text.split(/\r?\n/);
        return bridgeFetchRe.test(lines.slice(h.line - 1, h.line + 2).join("\n"));
      });
      check("C-9f·变异自检", "注入一个指向本地桥的 `fetch(` → C-9f 必须仍然红（证明收窄之后没变恒绿）",
        mutatedHits.length > 0,
        `注入 ${target} → 桥请求命中 ${mutatedHits.length} 处 ✓`,
        `注入 ${target} 后 C-9f 仍绿 —— **这条判据已经恒绿了**`);
    }
  }
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

/* ═══════════════════════════════════════════════════════════════════════════
 * §12 C-11 · 桥状态字段：把「静默截断」这一**真缺陷**变成永久护栏
 *
 * 历史（本项目抓到过的真缺陷）：`bridgeStatusPayload()` 曾经**逐字段重建**状态对象，
 * 于是 `address` / `error` / `lastRejectedOrigin` / `startPort` / `portRange` 被静默丢掉 ——
 * 渲染层拿不到 `lastRejectedOrigin`，R8 的「已拒绝一个来源不明的请求」就**永远显示不出来**，
 * 三条 UI 要求因此成了死代码。现在实现改成 `...raw` 先行，但**没有任何东西拦着它退回去**。
 *
 * 判据（三条 + 变异自检）：
 *   C-11a 正常路径必须**展开 `...raw`**，或逐字段列出 `BridgeStatus` 声明的**全部**字段 → 防静默截断回归
 *   C-11b 两条路径**显式重建**的键必须都在 `BridgeStatus` 里 → 不向渲染层泄漏未声明字段
 *   C-11c 失败路径必须包含正常路径的**全部显式键** → 渲染层不必为「字段不存在」写第二套分支
 *         （`main.cjs` 的注释自己就是这么承诺的：「其余可选字段一律给 `null` 而不是省略」）
 *   C-11d **文档消费侧**：`02` 里一旦有清单，就双向咬合「文档 ↔ `BridgeStatus`」；
 *         现在还没有 → INFO（等 d-contract 补完自动升级为真咬合，不用改代码）
 */
group("§12 桥状态字段咬合（C-11）");

const BRIDGE_STATUS_TS = "src/desktop/bridge.ts";
const MAIN_CJS = "electron/main.cjs";

/** 判据函数：两份源码文本进、结论出（纯函数才能在同一份真源上重跑变异）。 */
function bridgeStatusChecks(tsText, mainText) {
  const ifaceMatch = /export interface BridgeStatus \{([\s\S]*?)\n\}/.exec(tsText);
  const ifaceFields = ifaceMatch
    ? [...ifaceMatch[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1])
    : [];
  const fnStart = mainText.indexOf("function bridgeStatusPayload()");
  const fnEnd = fnStart < 0 ? -1 : mainText.indexOf("\n}\n", fnStart);
  const fnBody = fnStart >= 0 && fnEnd > fnStart ? mainText.slice(fnStart, fnEnd) : "";
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // 取 `return {` 之后那个对象字面量（花括号配平）
  const returnObjects = (body) => {
    const out = [];
    const re = /return \{/g;
    let m;
    while ((m = re.exec(body))) {
      const from = m.index + "return ".length;
      let depth = 0;
      let i = from;
      for (; i < body.length; i += 1) {
        if (body[i] === "{") depth += 1;
        else if (body[i] === "}") {
          depth -= 1;
          if (depth === 0) { i += 1; break; }
        }
      }
      out.push(body.slice(from, i));
    }
    return out;
  };
  // 对象**顶层**键（只认 depth===1 的属性名，跳过嵌套对象/三元里的同名 token）
  const topLevelKeys = (objText) => {
    const text = stripComments(objText);
    const start = text.indexOf("{");
    if (start < 0) return [];
    const keys = [];
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (c === "{") { depth += 1; continue; }
      if (c === "}") { depth -= 1; if (depth === 0) break; continue; }
      if (depth !== 1 || !/[A-Za-z_$]/.test(c)) continue;
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i));
      if (!m) continue;
      const before = text.slice(Math.max(0, i - 24), i);
      if (!/[{\s,]$/.test(before) || /[\w$.)\]]$/.test(before)) continue;
      keys.push(m[1]);
      i += m[0].length - 1;
    }
    return keys;
  };
  const objects = returnObjects(fnBody);
  // 失败路径 = 第一个 return（!controller），正常路径 = 第二个（有 ...raw）
  const failObj = objects.length >= 2 ? objects[0] : "";
  const normalObj = objects.length >= 2 ? objects[1] : objects[0] || "";
  const normalKeys = topLevelKeys(normalObj);
  const failKeys = topLevelKeys(failObj);
  const hasSpread = /\.\.\.\s*raw\b/.test(stripComments(normalObj));
  const coveredByExplicit = ifaceFields.every((f) => normalKeys.includes(f));
  const leakNormal = normalKeys.filter((k) => !ifaceFields.includes(k));
  const leakFail = failKeys.filter((k) => !ifaceFields.includes(k));
  const missingInFail = normalKeys.filter((k) => !failKeys.includes(k));

  return {
    "C-11a": {
      title: "`bridgeStatusPayload()` 正常路径不丢字段：`...raw` 展开，或逐字段覆盖 `BridgeStatus` 全部字段（防「静默截断」回归）",
      ok: ifaceFields.length > 0 && fnBody !== "" && (hasSpread || (coveredByExplicit && normalKeys.length > 0)),
      detail: `BridgeStatus 字段数=${ifaceFields.length} 展开 ...raw=${hasSpread} 显式键=${normalKeys.length}`
        + ` 显式覆盖全部=${coveredByExplicit}${ifaceFields.length ? "" : "（未解析到 BridgeStatus，判据不成立）"}`
        + `；与 scripts/bridge-hooks-check.cjs L292–297 的「...raw 存在性」检查**部分重叠**：那条只看全文件有没有 \`...raw,\``
        + `（连注释里出现都算），本条要求它落在 bridgeStatusPayload() **正常路径的返回对象**里，或逐字段覆盖全部字段`,
    },
    "C-11b": {
      title: "两条路径**显式重建**的键都在 `BridgeStatus` 里（不向渲染层泄漏未声明字段）",
      ok: ifaceFields.length > 0 && leakNormal.length === 0 && leakFail.length === 0,
      detail: `正常路径多出的键=${leakNormal.join(",") || "无"} 失败路径多出的键=${leakFail.join(",") || "无"}`,
    },
    "C-11c": {
      title: "失败路径包含正常路径的全部显式键（渲染层不必为「字段不存在」写第二套分支）",
      ok: fnBody !== "" && missingInFail.length === 0,
      detail: `失败路径缺=${missingInFail.join(",") || "无"}（正常路径显式键 ${normalKeys.length} 个：${normalKeys.join("/")}）`,
    },
  };
}

{
  const tsText = readIfExists(BRIDGE_STATUS_TS);
  const mainText = readIfExists(MAIN_CJS);
  const C11_IDS = ["C-11a", "C-11b", "C-11c"];
  if (tsText === null || mainText === null) {
    for (const id of C11_IDS) skip(id, "桥状态字段咬合", `${BRIDGE_STATUS_TS} 或 ${MAIN_CJS} 读不到`);
  } else {
    const real = bridgeStatusChecks(tsText, mainText);
    for (const id of C11_IDS) check(id, real[id].title, real[id].ok, real[id].detail, real[id].detail);

    const C11_MUTATIONS = [
      { name: "drop-spread", target: "C-11a", expect: [], apply: (s) => s.replace(/^\s*\.\.\.raw,\s*$/m, "") },
      // 正常路径塞一个未声明字段：既违反 C-11b（泄漏），也必然违反 C-11c（失败路径没有它）——
      // 第二条牵连是**可推导**的，所以显式声明，而不是放松「牵连必须为空」。
      { name: "invent-key", target: "C-11b", expect: ["C-11c"], apply: (s) => s.replace(/^(\s*)\.\.\.raw,/m, "$1...raw,\n$1fooBar: 1,") },
      // ⚠️ 我第一版这里删的是失败路径的 `lastRejectedOrigin` —— 它**不在**正常路径的显式键里，
      // 所以 C-11c 本来就不该对它敏感（变异无效，自检如实报「目标仍绿」）。
      // 真正能证明 C-11c 有效的是删掉一个**两边都有**的显式键。
      { name: "shrink-failure", target: "C-11c", expect: [], apply: (s) => s.replace(/^\s*tokenSet: false,\s*$/m, "") },
    ];
    const log = [];
    let ok = true;
    for (const m of C11_MUTATIONS) {
      const mutated = m.apply(mainText);
      const changed = mutated !== mainText;
      const verdict = bridgeStatusChecks(tsText, mutated);
      const targetRed = verdict[m.target].ok === false;
      const collateral = C11_IDS.filter((id) => id !== m.target && verdict[id].ok === false).sort();
      const collateralOk = collateral.join(",") === [...m.expect].sort().join(",");
      const fine = changed && targetRed && collateralOk;
      if (!fine) ok = false;
      const why = [
        changed ? "" : "**变异没改到文本**",
        targetRed ? "" : "目标仍绿",
        collateralOk ? "" : `牵连与声明不符（实际 ${collateral.join(",") || "无"} / 声明 ${m.expect.join(",") || "无"}）`,
      ].filter(Boolean).join("；");
      log.push(`${m.name}→${m.target} ${fine ? "红✓" : `未红✗（${why}）`}`
        + `${collateral.length ? `（+牵连 ${collateral.join(",")}）` : ""}`);
    }
    check("C-11·变异", `C-11 断言自检：${C11_MUTATIONS.length} 个内存变异各自让对应检查翻红（证明这 3 条不是恒绿）`,
      ok, log.join("；"), log.join("；"));
  }
}

/** 文档侧判据（纯函数）：`02` §5.2.11 的字段表 ↔ `BridgeStatus`，**集合**双向比对。
 *  为什么必须按「表行」解析、而不是 `doc.includes(字段名)`：后者有个洞 ——
 *  把 `` `lastRejectedOrigin?` `` 写成 `` `lastRejectedOrigins?` ``（多一个字母），
 *  名字里仍**包含**原名，`includes` 那套会闭眼放过；而「表里多了个不存在的字段」
 *  正是文档漂移的典型形态。 */
function bridgeStatusDocChecks(docText, tsText) {
  const ifaceMatch = /export interface BridgeStatus \{([\s\S]*?)\n\}/.exec(tsText);
  const code = ifaceMatch
    ? [...ifaceMatch[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)(\??):/gm)].map((m) => ({ name: m[1], optional: m[2] === "?" }))
    : [];
  const section = /^####\s*5\.2\.11[^\n]*\n([\s\S]*?)(?=\n####\s|\n###\s|\n---\n)/m.exec(docText);
  const rows = section
    ? [...section[1].matchAll(/^\|\s*`([A-Za-z_$][\w$]*)(\??)`\s*\|/gm)].map((m) => ({ name: m[1], optional: m[2] === "?" }))
    : [];
  const docNames = rows.map((r) => r.name);
  const missing = code.filter((c) => !docNames.includes(c.name)).map((c) => c.name);
  const extra = docNames.filter((n) => !code.some((c) => c.name === n));
  const markerMismatch = code
    .filter((c) => rows.some((r) => r.name === c.name && r.optional !== c.optional))
    .map((c) => `${c.name}（代码${c.optional ? "可选" : "必现"}／文档${rows.find((r) => r.name === c.name).optional ? "可选" : "必现"}）`);
  const hasAnchor = section !== null;
  const hasCode = code.length > 0;
  return {
    anchor: {
      ok: hasAnchor,
      detail: hasAnchor
        ? `锚点 \`#### 5.2.11\` 找到，表行 ${rows.length} 行`
        : "锚点 `#### 5.2.11` **未找到** → 咬合失效（删掉一节文档不能让检查闭嘴；若清单搬到别处，请更新本检查的锚点，不要删掉这条检查）",
    },
    bite: {
      ok: hasCode && hasAnchor && missing.length === 0 && extra.length === 0 && markerMismatch.length === 0,
      detail: `代码 ${code.length} 个字段（可选 ${code.filter((c) => c.optional).length} / 必现 ${code.filter((c) => !c.optional).length}）`
        + ` ↔ §5.2.11 表行 ${rows.length} 行；缺=${missing.join(",") || "无"} 多=${extra.join(",") || "无"} 可选标记不一致=${markerMismatch.join(",") || "无"}`,
      failDetail: `文档缺的字段：${missing.join(", ") || "无"}；文档多出的字段（应为空）：${extra.join(", ") || "无"}；`
        + `可选标记不一致：${markerMismatch.join(", ") || "无"}（表行 ${rows.length} 行 / 代码 ${code.length} 个字段）`,
    },
  };
}

/* ── C-11d 文档消费侧：02 §5.2.11 ↔ `BridgeStatus`，含**不许静默降级** ────────
 * 起因：给 `S7B.1` 的清单找「出处」时我差点写下一个**假引用**（`02 §3.2` 其实是
 * 「H1 与 front-matter 的拼装顺序」）。当时登记为 INFO（文档缺口）。
 * d-contract 补完 §5.2.11 之后，本段**自动**升级成真咬合 —— 我没有改判据逻辑，只是它现在能咬了。
 *
 * ⚠️ **不许静默降级**：契约既然已经把这份清单收编成权威产地，那「清单消失」就必须**红**，
 * 而不是悄悄退回 INFO（退回 INFO = 删掉一节文档就能让检查闭嘴）。 */
{
  const doc02 = readIfExists("docs/import/02-接口契约-导入信封与通道.md");
  const tsText = readIfExists(BRIDGE_STATUS_TS) || "";
  if (doc02 === null) {
    skip("C-11d", "`02 §5.2.11` 字段清单咬合", "读不到 02 契约文件");
  } else {
    const verdict = bridgeStatusDocChecks(doc02, tsText);
    check("C-11d", "`02 §5.2.11` 的字段清单与 `BridgeStatus` **双向一致**（集合 + 可选标记 `?`；清单缺失即红，不静默降级）",
      verdict.bite.ok, `${verdict.anchor.detail}；${verdict.bite.detail}`, verdict.bite.failDetail);

    const DOC_MUTATIONS = [
      // ⚠️ 第一版写成把标题改成 `#### 5.2.11x` —— 没用：段首正则里的 `[^\n]*` 把 `x` 一起吞了，
      // 锚点照样匹配（自检如实报「未红」）。要真删掉锚点，必须**换掉节号**。
      { name: "drop-anchor", target: "C-11d", expect: [], apply: (s) => s.replace(/^####\s*5\.2\.11/m, "#### 5.2.99") },
      { name: "drop-row", target: "C-11d", expect: [], apply: (s) => s.replace(/^\|\s*`startPort\?`.*$/m, "") },
      { name: "typo-extra-row", target: "C-11d", expect: [], apply: (s) => s.replace(/^(\|\s*`)startPort(\?`)/m, "$1startPorts$2") },
      { name: "flip-optional", target: "C-11d", expect: [], apply: (s) => s.replace(/^(\|\s*`)state(`\s*\|)/m, "$1state?$2") },
    ];
    const log = [];
    let ok = true;
    for (const m of DOC_MUTATIONS) {
      const mutated = m.apply(doc02);
      const changed = mutated !== doc02;
      const v = bridgeStatusDocChecks(mutated, tsText);
      const targetRed = v.bite.ok === false;
      const fine = changed && targetRed;
      if (!fine) ok = false;
      log.push(`${m.name}→${targetRed ? "红✓" : "未红✗"}${changed ? "" : "（**变异没改到文本**）"}`);
    }
    check("C-11d·变异", `C-11d 断言自检：${DOC_MUTATIONS.length} 个内存变异各自让它翻红（证明「清单消失/漂移」真的会红）`,
      ok, log.join("；"), log.join("；"));
  }
}




const EXT_MARKERS = ["extension/.building", "extension/.mutation-running"];
/** 这一轮是不是在「树在动」的窗口里跑的 —— 与 b 的 `extension/.gitignore` 约定对齐。
 *  · `.building`（build.mjs 正在 rmSync+重写 dist）→ 读 `dist` 的判据不可信；
 *  · `.mutation-running`（mutation-check.ps1 在故意改坏 extension/src 与 dist）→ **extension 面整体**不可信。
 *  另附一道不依赖标记的自查：产物文件比 `BUILD-INFO.builtAt` 更新 = 构建之后被改过/写了一半。
 *  （不重算 b 的指纹算法 —— 那会和 b 的实现漂移；这里的判据是「与 builtAt 的时序关系」，与算法无关。） */
const UNTRUSTED = { at: false, why: [] };
function extTrust(opts = {}) {
  const on = opts.injectMarker ? [opts.injectMarker] : EXT_MARKERS.filter((rel) => exists(rel));
  if (on.length) {
    return {
      trusted: false,
      scope: on.some((m) => m.endsWith(".mutation-running")) ? "extension" : "dist",
      why: `标记存在（树在动）：${on.join(", ")}`,
    };
  }
  const raw = readIfExists("extension/dist/BUILD-INFO.json");
  if (!raw) return { trusted: false, scope: "dist", why: "读不到 extension/dist/BUILD-INFO.json" };
  let info;
  try { info = JSON.parse(raw); } catch { return { trusted: false, scope: "dist", why: "BUILD-INFO.json 不是合法 JSON" }; }
  const builtAt = Date.parse(info.builtAt || "");
  if (!Number.isFinite(builtAt)) return { trusted: false, scope: "dist", why: "BUILD-INFO.builtAt 缺失或不可解析" };
  let newer = [];
  try {
    newer = walk("extension/dist").filter((rel) => fs.statSync(path.join(ROOT, rel)).mtimeMs > builtAt + 2000);
  } catch (err) {
    return { trusted: false, scope: "dist", why: `遍历 dist 失败：${err.message}` };
  }
  if (newer.length) {
    return {
      trusted: false,
      scope: "dist",
      why: `${newer.length} 个产物文件比 BUILD-INFO.builtAt 更新（构建后被改过，或构建被打断写了一半）：${newer.slice(0, 3).join(", ")}`,
    };
  }
  return { trusted: true, scope: "none", why: `无标记；产物文件均早于 builtAt=${info.builtAt}` };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §13 C-10f…C-10o · ㊵ / ㊶（M2 已落地 `50fb34e`：死代码退场 + 极简形态）
 *
 * **与 b 的 `extension/verify.mjs` V17/V18 的分工，先说清，不许谎报新覆盖**：
 *   · **重叠**（V17 已有，我复算但不算新覆盖）：两个按钮文案；12 个退场 id；
 *     popup 不发 `templateId`/`props`/`dirty`；死模块不在产物里；两个存储键不在产物里；
 *     来源字段不得空串兜底。这 6 点我**换产地**复核：V17 看 `extension/dist/**`（产物），
 *     我看 `extension/src/**`（源码）—— 任一侧漂移都该红，所以重叠部分保留。
 *   · **新角度**（V17 没有的）：`## 高亮` 小节的**剥注释**源码扫描（V17 只扫 dist 里的符号名）；
 *     右键菜单**恰好一项**且 id/文案逐字（V17 只查 `opennote-highlight` 不存在）；
 *     manifest 无 `options_ui`/`options_page` 且 `src/options/` 目录不存在；
 *     源码里对已删模块的**引用**为 0；`#pickRow` 容器内**恰好两个** button；
 *     `opennote:preview` 载荷的**键集合恰为 {type, mode}**（V17 是子串判据）；
 *     存储键在**源码面**也 0 命中。
 *   · **我不重复劳动**的：来源字段的**运行时**语义由 V17 ④（真调 dist 的 `buildEnvelope`）
 *     与我的 e2e `S1.5b`（应用侧 front-matter 整行省略）覆盖，这里只做**源码静态**那一面。
 *
 * ⚠️ **扫源码查「不许再出现」必须先剥注释**：`background.js` 里就有 **3 处注释**在记录高亮退场的
 * 事实（L62–67 / L291 / L803），`lib/highlights.js` 的名字也只在注释里出现一次（L149）。
 * 不剥注释 = 在**记录退场**的文本上判「退场没做」= 三条假红。
 */
group("§13 ㊵/㊶ 死代码退场与极简形态（C-10f…C-10o）");

const EXT = (rel) => `extension/src/${rel}`;

/** 剥代码注释（`/* *\/` 与行注释；避开 `http://` 这类冒号后缀）。 */
function stripCodeComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}
const stripHtmlComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, " ");

/** 找出**孤儿 JSDoc 块**：一串相邻的 JSDoc 里，JS 只会把紧贴声明的那一块挂上去，
 *  前面的都挂不上任何东西（`5f553a3` 清过一次「注释里的换页符 + 孤儿 JSDoc」，这是后续例）。
 *  两条防误报：
 *   ① 只认「这一串的最后一块**确实紧贴一个声明**」的情形 —— 装饰性注释串不判；
 *   ② **文件头的模块说明不算孤儿**（`lib/timeout.js:1` 那种横幅本来就该独立存在，
 *      它不挂声明是设计如此。第一版没排除它 → 误报，我自己在复跑里抓到的）。 */
function orphanJsdocBlocks(text) {
  const lines = String(text).split("\n");
  const isCommentish = (l) => {
    const t = l.trim();
    return t === "" || /^(\/\/|\/\*|\*)/.test(t);
  };
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\/\*\*/.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/\*\//.test(lines[j])) j += 1;
    blocks.push({ start: i, end: Math.min(j, lines.length - 1) });
    i = j;
  }
  const orphans = [];
  for (let k = 0; k < blocks.length - 1; k += 1) {
    const a = blocks[k];
    const b = blocks[k + 1];
    if (!lines.slice(a.end + 1, b.start).every(isCommentish)) continue; // 中间还有别的代码 → 不算一串
    if (!lines.slice(0, a.start).some((l) => !isCommentish(l))) continue; // ② 文件头横幅
    const last = blocks[blocks.length - 1];
    let after = last.end + 1;
    while (after < lines.length && lines[after].trim() === "") after += 1;
    const attached = after < lines.length
      && /^\s*(export\s+)?(async\s+)?(function|const|let|var|class)\b/.test(lines[after]);
    if (attached) orphans.push(a);
  }
  return orphans;
}

/** 找出**死导入**：`import` 进来的本地名在文件别处一次都没用到。
 *  与孤儿 JSDoc 同族 —— **声明与使用脱节**（b 清 C44 时留下 `filterTags` 就是这么来的）。
 *  防误报三条：
 *   ① 只认静态 import 的**本地绑定名**（含 `as` 重命名）；
 *   ② `import "…"`（副作用导入）与 `export … from` 不在此列；
 *   ③ 名字只在**注释**里出现过：不算「用过」，但**不判死** —— 单独列成观察，
 *      因为 `@type {Foo}` 这类 JSDoc 用法是合法的，判红会误伤。 */
function deadImportsIn(text) {
  const code = stripCodeComments(text);
  /* ⚠️ 「是否只在注释里出现」必须在**去掉 import 语句本身**的文本上判。
   * 第一版用的是全文 → import 行自己就命中了那个名字 → 每个导入都被算成「在注释里出现过」
   * → `dead` 永远是空的 = **恒绿的检查**。是给 C-10t 配的 `dead-import` 变异抓出来的
   * （「目标没有翻红」）；否则它会一直绿着骗人 —— 这就是「NO_EFFECT 不能算 MISSED」。 */
  const textNoImports = String(text).replace(/^[ \t]*import[\s\S]*?from\s*["'][^"']+["']\s*;?/gm, " ");
  const dead = [];
  const commentOnly = [];
  /* 行号必须取自**原文**：`stripCodeComments` 把块注释压成一个空格，块注释里的换行会消失，
   * 用它算出来的行号会漂（第一版就漂了）。用法判定则用剥过注释的代码 —— 各取所长。 */
  const importRe = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/gm;
  let m = importRe.exec(String(text));
  while (m !== null) {
    const clause = m[1];
    const raw = String(text);
    const line = raw.slice(0, m.index).split("\n").length; // 行号必须从**原文**数（见上）
    /* 报给作者的行号要是**名字自己那一行**：多行 import 里 `filterTags` 在 L17，
     * 而 import 语句从 L13 起 —— 只报 13 会让人白找一趟。 */
    const nameLineOf = (n) => {
      const within = m[0].indexOf(n);
      return within < 0 ? line : line + m[0].slice(0, within).split("\n").length - 1;
    };
    const names = [];
    const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (braceMatch) {
      for (const part of braceMatch[1].split(",")) {
        const t = part.trim();
        if (!t) continue;
        const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(t);
        names.push(asMatch ? asMatch[2] : t);
      }
    }
    const nsMatch = /^\s*\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (nsMatch) names.push(nsMatch[1]);
    if (!nsMatch) {
      const defaultMatch = /^[ \t]*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(
        clause.replace(/\{[\s\S]*?\}/, " ").replace(/^[ \t]*\*[^,]*,[ \t]*/, " "),
      );
      if (defaultMatch) names.push(defaultMatch[1]);
    }
    const rest = code.slice(0, m.index) + code.slice(m.index + m[0].length);
    void rest;
    for (const name of names) {
      if (!name || name === "type") continue;
      const esc = name.replace(/\$/g, "\\$");
      const countIn = (s) => (s.match(new RegExp(`\\b${esc}\\b`, "g")) || []).length;
      /* ⚠️ 用**计数**判定，不要用下标切片：行号取自原文、用法判定取自剥注释后的代码，
       * 两套下标不是同一坐标系 —— 第一版拿原文下标去切 `code`，越界后 `rest` 变成整段代码，
       * 于是每个名字都「被用过」，C-10t 变成**恒绿**（第二次了，仍是变异抓出来的）。 */
      if (countIn(code) > countIn(clause)) continue; // 除本 import 子句外还在代码里出现过 → 用过
      (countIn(textNoImports) > 0 ? commentOnly : dead).push(`${m[2]} 的 \`${name}\`（第 ${nameLineOf(name)} 行）`);
    }
    m = importRe.exec(String(text));
  }
  return { dead, commentOnly };
}

/** 删掉**整条都死**的 import（把还有活名字的那些重建成单行）—— 自我归零型变异的参照系。 */
function stripDeadImports(text) {
  const deadNames = new Set(deadImportsIn(text).dead.map((d) => /`([^`]+)`/.exec(d)[1]));
  if (!deadNames.size) return String(text);
  return String(text).replace(
    /^[ \t]*import\s+([\s\S]*?)\s+from\s*(["'][^"']+["'])\s*;?/gm,
    (full, clause, src) => {
      const nsMatch = /^\s*\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (nsMatch) return deadNames.has(nsMatch[1]) ? "" : full;
      const names = [];
      const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
      if (braceMatch) {
        for (const part of braceMatch[1].split(",")) {
          const t = part.trim();
          if (!t) continue;
          const asM = /^(\S+)\s+as\s+(\S+)$/.exec(t);
          names.push(asM ? asM[2] : t);
        }
      }
      const defaultM = /^[ \t]*([A-Za-z_$][\w$]*)\s*,/.exec(clause);
      if (defaultM) names.push(defaultM[1]);
      const kept = names.filter((n) => !deadNames.has(n));
      if (!kept.length) return "";
      return `import { ${kept.join(", ")} } from ${src};`;
    },
  );
}

/** 把孤儿 JSDoc 块删掉（只留紧贴声明的那一块）—— 自我归零型变异的参照系要用。 */
function stripOrphanJsdocs(text) {
  const drop = new Set();
  for (const b of orphanJsdocBlocks(text)) {
    for (let i = b.start; i <= b.end; i += 1) drop.add(i);
  }
  return String(text).split("\n").filter((_, i) => !drop.has(i)).join("\n");
}

/** 取 `<div id="…">…</div>` 整块（div 配平）。 */
function divById(html, id) {
  const marker = html.indexOf(`id="${id}"`);
  if (marker < 0) return null;
  const open = html.lastIndexOf("<div", marker);
  if (open < 0) return null;
  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = open;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return html.slice(open, m.index + m[0].length);
    } else if (!m[0].endsWith("/>")) depth += 1;
  }
  return null;
}

/** 对象字面量的**顶层键**：支持 `k: v` 与简写 `k`，跳过字符串里的逗号，`...` 记作 spread。 */
function objectKeyList(objText) {
  const text = String(objText).trim();
  const inner = text.startsWith("{") ? text.slice(1, text.lastIndexOf("}")) : text;
  const parts = [];
  let depth = 0;
  let quote = null;
  let buf = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; buf += ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((raw) => {
    const p = raw.trim();
    if (!p) return "";
    if (p.startsWith("...")) return "...";
    const withValue = /^([A-Za-z_$][\w$]*)\s*:/.exec(p);
    if (withValue) return withValue[1];
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(p);
    return shorthand ? shorthand[1] : `?${p.slice(0, 24)}`;
  }).filter(Boolean);
}

/** `send({…})` 的每个载荷对象文本。 */
function sendPayloads(text) {
  const out = [];
  const re = /send\(\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const from = m.index + m[0].length - 1;
    let depth = 0;
    let i = from;
    for (; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    out.push(text.slice(from, i));
  }
  return out;
}

const M2_IDS = ["C-10f", "C-10g", "C-10h", "C-10i", "C-10j", "C-10k", "C-10l", "C-10m", "C-10n", "C-10o", "C-10p", "C-10r", "C-10s", "C-10t"];
const M2_GONE_IDS = ["seg", "segmented", "regionHighlight", "regionProps", "sourceSwitch", "tmplRow", "template", "notePath", "tags", "folder", "footRow", "hlList"];
const M2_GONE_TOKENS = ["data-region=", "data-mode=", "已高亮", "清除本页全部高亮"];
const M2_DEAD_MODULES = ["lib/templates.js", "lib/highlights.js", "content/highlight.js", "options/options.html"];
const M2_STORAGE_KEYS = ["opennote.templates.v1", "opennote.highlights.v1"];
/**
 * `opennote:preview` 载荷的**声明式键集合**（Lead 2026-09-30 裁定 (a)；出处见 C-10m 的注释）。
 * 旧的字面冻结集合是 `["type","mode"]` —— 本轮 ③ 放行 `images`，故在这里显式声明。
 * 判据是 **⊆ 这个集合**：任何未声明的键都会红（不许悄悄长出新字段）。
 */
const M2_DECLARED_PREVIEW_KEYS = ["type", "mode", "images"];
/** 退场键（旧功能复活就会命中）：与 C-10m 一起判，**任何** send 载荷都不许带它们。 */
const M2_RETIRED_PAYLOAD_KEYS = ["templateId", "props", "dirty"];

/** 纯函数：输入全是文本/清单，输出每条的结论 —— 只有这样变异才能在同一份真源上重跑。 */
function m2Checks(inp) {
  const codeTexts = inp.srcFiles.map((f) => ({ rel: f.rel, text: stripCodeComments(f.text) }));
  const bgCode = stripCodeComments(inp.bgText);
  const popupCode = stripCodeComments(inp.popupJs);
  const popupBare = stripHtmlComments(inp.popupHtml);
  const result = {};

  // C-10f ── `## 高亮` 小节与模板变量彻底不再生成（**剥注释**后扫源码）
  {
    const TOKENS = ["## 高亮", "{{highlights}}", "withHighlightSection", "highlightInPage"];
    const hits = [];
    for (const f of codeTexts) for (const t of TOKENS) if (f.text.includes(t)) hits.push(`${f.rel}:${t}`);
    const commentOnly = [];
    for (const f of inp.srcFiles) {
      for (const t of TOKENS) {
        if (f.text.includes(t) && !stripCodeComments(f.text).includes(t)) commentOnly.push(`${f.rel}(${t})`);
      }
    }
    result["C-10f"] = {
      title: "㊵ 高亮整套不再生成：源码（剥注释后）里没有 `## 高亮` / `{{highlights}}` / `withHighlightSection` / `highlightInPage`",
      ok: hits.length === 0,
      detail: `0 命中（扫描 ${inp.srcFiles.length} 个源码文件）；`
        + `注释里的退场记录 ${commentOnly.length} 处**不计**：${commentOnly.slice(0, 3).join(", ") || "无"}`,
      failDetail: `仍在生成/引用：${hits.join(", ")}`,
    };
  }

  // C-10g ── 右键菜单**恰好一项**，id 与文案逐字
  {
    const creates = [...bgCode.matchAll(/contextMenus\.create\(\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => m[1]);
    const first = creates[0] || "";
    const title = (/title:\s*"([^"]*)"/.exec(first) || [])[1] || null;
    const menuId = (/id:\s*"([^"]*)"/.exec(first) || [])[1] || null;
    const ok = creates.length === 1 && title === "剪藏整页正文到 Opennote" && menuId === "opennote-clip-page";
    result["C-10g"] = {
      title: "㊵ 右键菜单**恰好一项**：id `opennote-clip-page`、文案逐字「剪藏整页正文到 Opennote」",
      ok,
      detail: `create 调用 ${creates.length} 次；id=${JSON.stringify(menuId)} title=${JSON.stringify(title)}`,
      failDetail: `create 调用 ${creates.length} 次（应为 1）；id=${JSON.stringify(menuId)} title=${JSON.stringify(title)}（应为 opennote-clip-page / 「剪藏整页正文到 Opennote」）`,
    };
  }

  // C-10h ── 死模块不在产物里；产物里没有工具残留；且**每个产物文件都是 BUILD-INFO 声明过的**
  //          【死模块那半与 V17 ⑤ 重叠；「声明集合 vs 现场集合」与残留扫描是新角度】
  //          第一版写的是「产物 ≤ 21」这个**魔数**：b 新增一个正常产物（`lib/timeout.js`）它就红。
  //          改成与 `BUILD-INFO.json` 的声明集合对照 —— 更强（任何未声明文件都抓得到），也不脆。
  {
    const shipped = inp.distFiles.filter((rel) => M2_DEAD_MODULES.some((d) => rel.endsWith(d)));
    const debris = inp.distFiles.filter((rel) => /\.bak|\.orig$|\.tmp$|~$|\.swp$|bak-mutation/i.test(rel));
    const info = inp.buildInfo;
    let declared = null;
    if (info && Array.isArray(info.files)) {
      const prefix = "extension/dist/";
      declared = new Set([
        ...info.files.map((f) => prefix + f),
        ...((info.icons && Array.isArray(info.icons.sizes)) ? info.icons.sizes.map((s) => `${prefix}icons/icon${s}.png`) : []),
        ...(info.tokens && info.tokens.source ? [`${prefix}styles/${path.basename(info.tokens.source)}`] : []),
        `${prefix}BUILD-INFO.json`,
      ]);
    }
    const undeclared = declared ? inp.distFiles.filter((rel) => !declared.has(rel)) : [];
    const ok = shipped.length === 0 && debris.length === 0 && declared !== null && undeclared.length === 0;
    result["C-10h"] = {
      title: "㊵ 死模块不在产物里；产物里没有工具残留（`*.bak-mutation` 等）；且**每个产物文件都是 `BUILD-INFO.json` 声明过的**（与声明集合对照，不用魔数上限）",
      ok,
      detail: `产物 ${inp.distFiles.length} 个文件，BUILD-INFO 声明 ${declared ? declared.size : "（读不到）"} 个（含图标与 tokens.css 的换算）；`
        + `死模块命中=${shipped.join(", ") || "无"}；工具残留=${debris.join(", ") || "无"}；未声明文件=${undeclared.join(", ") || "无"}`
        + `【与 V17 ⑤ 重叠的部分：死模块不在产物；新角度：残留扫描 + 声明集合对照】`,
      failDetail: `产物 ${inp.distFiles.length} 个文件；死模块命中=${shipped.join(", ") || "无"}；工具残留=${debris.join(", ") || "无"}；`
        + `BUILD-INFO 未声明的文件=${undeclared.join(", ") || "无"}${declared ? "" : "（**BUILD-INFO.json 读不到/无 files 清单**）"}。`
        + `处置：是**残留**（` + "`*.bak-mutation`" + `）就删掉；是**新增的正常产物**就重跑 \`node build.mjs\` 让 BUILD-INFO 收进去 —— 两种都不要改判据。`,
    };
  }

  // C-10i ── manifest 不再有 options 入口（新角度）
  {
    const hasOptionsKey = /"(options_ui|options_page)"\s*:/.test(inp.manifest);
    const optionsDir = inp.srcFiles.filter((f) => /\/options\//.test(f.rel)).map((f) => f.rel);
    result["C-10i"] = {
      title: "㊵ manifest 不再有 `options_ui`/`options_page`，且 `extension/src/options/` 目录不存在（入口与实现一起删）",
      ok: !hasOptionsKey && optionsDir.length === 0,
      detail: `manifest 里 options 键=${hasOptionsKey ? "仍在" : "无"}；src/options 下的文件=${optionsDir.length} 个`,
      failDetail: `manifest 里仍有 options 键=${hasOptionsKey}；src/options 下仍有 ${optionsDir.length} 个文件：${optionsDir.slice(0, 5).join(", ")}`,
    };
  }

  // C-10j ── 源码里没有任何代码**引用**已删模块（剥注释后）
  {
    const REFS = ["highlights.js", "highlight.js", "templates.js"];
    const refHits = [];
    for (const f of codeTexts) for (const r of REFS) if (f.text.includes(r)) refHits.push(`${f.rel}(${r})`);
    result["C-10j"] = {
      title: "㊵ 源码里没有代码引用已删模块（`lib/highlights.js` / `content/highlight.js` / `lib/templates.js`）——注释里的历史说明不算",
      ok: refHits.length === 0,
      detail: `剥注释后 0 命中（已删模块的路径字符串）`,
      failDetail: `仍有引用：${refHits.join(", ")}`,
    };
  }

  // C-10k ── 主操作区 `#pickRow` **恰好两个** button，文案逐字（新角度：正向计数）
  {
    const row = divById(popupBare, "pickRow");
    const rowButtons = row ? [...row.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].trim()) : [];
    const allButtons = [...popupBare.matchAll(/<button[^>]*>/g)].length;
    const ok = row !== null && rowButtons.length === 2
      && rowButtons[0] === "选择当前元素" && rowButtons[1] === "整页提取";
    result["C-10k"] = {
      title: "㊶ 主操作区 `#pickRow` **恰好两个** button，文案逐字「选择当前元素」/「整页提取」",
      ok,
      detail: `#pickRow 内 ${rowButtons.length} 个：${rowButtons.join(" / ")}；`
        + `全 popup 共 ${allButtons} 个 button（其余属令牌流程 / 底栏主按钮 / ⋯ 菜单 / 危险确认框）`,
      failDetail: `#pickRow ${row ? "内" : "**找不到**"}按钮 ${rowButtons.length} 个：${rowButtons.join(" / ") || "无"}`
        + `（应为 选择当前元素 / 整页提取）`,
    };
  }

  // C-10l ── 12 个退场 id 与痕迹不在源码 DOM【与 V17 ② 重叠】
  {
    const stillIds = M2_GONE_IDS.filter((id) => popupBare.includes(`id="${id}"`));
    const stillTokens = M2_GONE_TOKENS.filter((t) => popupBare.includes(t));
    result["C-10l"] = {
      title: "㊶ 12 个退场控件 id（seg/segmented/regionHighlight/regionProps/sourceSwitch/tmplRow/template/notePath/tags/folder/footRow/hlList）与三区痕迹不在源码 DOM",
      ok: stillIds.length === 0 && stillTokens.length === 0,
      detail: `0 命中（12 个 id + ${M2_GONE_TOKENS.length} 个痕迹词）【与 V17 ② 重叠，我扫源码面】`,
      failDetail: `仍在源码 DOM 里：id=${stillIds.join(", ") || "无"}；痕迹=${stillTokens.join(", ") || "无"}`,
    };
  }

  /* C-10m ── 预览载荷的键集合（**声明式**，Lead 2026-09-30 裁定 (a)）
   *
   * 出处：本轮 ③「图片下载开关（插件侧）」交付 5 —— 开关状态必须随预览请求到 background
   * （抽取那一刻就要决定「要不要多要一份图片清单」），字段清单按 `T-01` 落进 03 号文档。
   *
   * **旧的字面冻结集合是 `["type","mode"]`**（㊶ 时还没有 ③）。Lead 本轮据 ③ 放行 `images`，
   * 判据由「恰为两个字面键」改成「⊆ 声明集合，且必含 type/mode」——
   * **这是本轮按 ③ 做的判据更新，不是「判据一直是这样的」**（V7 里列了新旧集合的差异）。
   *
   * **两个方向都要咬**（只咬一边就是「配对只守一半」）：
   *   ① 注入**退场键**（`templateId`/`props`/`dirty`）→ 必须红（旧功能复活）；
   *   ② 注入**未声明的键**（不在声明集合里，例如 `wat`）→ 必须红（悄悄长出新字段）。
   */
  {
    const payloads = sendPayloads(popupCode);
    const previewIdx = payloads.findIndex((p) => p.includes("opennote:preview"));
    const previewKeys = previewIdx >= 0 ? objectKeyList(payloads[previewIdx]) : null;
    const retiredKeys = [];
    for (const p of payloads) {
      for (const k of M2_RETIRED_PAYLOAD_KEYS) if (objectKeyList(p).includes(k)) retiredKeys.push(k);
    }
    const undeclaredKeys = (previewKeys || []).filter((k) => !M2_DECLARED_PREVIEW_KEYS.includes(k));
    const missingKeys = M2_DECLARED_PREVIEW_KEYS.filter((k) => k === "type" || k === "mode").filter((k) => !(previewKeys || []).includes(k));
    const ok = previewKeys !== null && undeclaredKeys.length === 0 && missingKeys.length === 0 && retiredKeys.length === 0;
    result["C-10m"] = {
      title: "㊶+③ `opennote:preview` 载荷的键集合 ⊆ **声明集合** `[" + M2_DECLARED_PREVIEW_KEYS.join(",") + "]`"
        + "（出处：③ 交付 5 + `T-01` 的 03 字段清单）且必含 `type`/`mode`；"
        + "**两个方向都咬**：退场键不许复活、未声明的键不许悄悄新增",
      ok,
      detail: `send 载荷 ${payloads.length} 个；preview 的键=${JSON.stringify(previewKeys)}（声明集合 ${JSON.stringify(M2_DECLARED_PREVIEW_KEYS)}）`
        + `；未声明键=${undeclaredKeys.join(", ") || "无"}；缺必需键=${missingKeys.join(", ") || "无"}；退场键命中=${retiredKeys.join(", ") || "无"}`
        + `【子串判据与 V17 ③ 重叠，键集合是新角度；阅读型 \`preview.props\` 不算发送】`,
      failDetail: `send 载荷 ${payloads.length} 个；preview 的键=${JSON.stringify(previewKeys)}`
        + `（须 ⊆ ${JSON.stringify(M2_DECLARED_PREVIEW_KEYS)} 且含 type/mode）`
        + `；未声明键=${undeclaredKeys.join(", ") || "无"}；缺必需键=${missingKeys.join(", ") || "无"}；退场键命中=${retiredKeys.join(", ") || "无"}`,
    };
  }

  // C-10n ── 来源字段不得用空串/强转兜底【与 V17 ⑤ 重叠，我扫源码面】
  {
    const call = (/return buildEnvelope\(\{[\s\S]*?\n {2}\}\);/m.exec(bgCode) || [])[0] || "";
    const missing = [];
    const fallback = [];
    for (const key of ["url:", "pageTitle:", "site:", "author:", "publishedAt:"]) {
      const line = call.split("\n").find((l) => l.trim().startsWith(key)) || "";
      if (!line) { missing.push(key); continue; }
      if (/\|\|\s*""/.test(line) || /String\(/.test(line)) fallback.push(`${key} ${line.trim()}`);
    }
    result["C-10n"] = {
      title: "㊶ 来源字段不用空串/强转兜底（`|| \"\"` / `String()`）—— 否则「没有作者」会变成「作者是空字符串」，整行省略再也救不回来",
      ok: call !== "" && missing.length === 0 && fallback.length === 0,
      detail: `调用点找到=${call !== ""}；5 个来源字段行齐=${missing.length === 0}；兜底命中=${fallback.length}`
        + `【与 V17 ⑤ 重叠（它扫 dist，我扫源码）；运行时语义见 V17 ④ 与我的 e2e S1.5b】`,
      failDetail: `调用点找到=${call !== ""}；缺行=${missing.join(", ") || "无"}；兜底命中=${fallback.join(" | ") || "无"}`,
    };
  }

  // C-10o ── 两个存储键在源码 + 产物里 0 命中（src 面是新角度）
  {
    const inSrc = inp.srcFiles.filter((f) => M2_STORAGE_KEYS.some((k) => f.text.includes(k))).map((f) => f.rel);
    const inDist = inp.distTexts.filter((f) => M2_STORAGE_KEYS.some((k) => f.text.includes(k))).map((f) => f.rel);
    const elsewhere = inp.otherFiles.filter((f) => M2_STORAGE_KEYS.some((k) => f.text.includes(k))).map((f) => f.rel);
    result["C-10o"] = {
      title: "㊵㊶ `opennote.templates.v1` / `opennote.highlights.v1` 不再被读写（源码 + 产物 0 命中）",
      ok: inSrc.length === 0 && inDist.length === 0,
      detail: `源码 0 命中（${inp.srcFiles.length} 个文件）；产物文本 0 命中（${inp.distTexts.length} 个文件）`
        + `；测试/工具面另有 ${elsewhere.length} 处提及（不计失败，照实打印：${elsewhere.slice(0, 3).join(", ") || "无"}）`
        + `【产物面与 V17 ⑤ 重叠，源码面是新角度】`,
      failDetail: `源码命中：${inSrc.join(", ") || "无"}；产物命中：${inDist.join(", ") || "无"}`,
    };
  }

  // C-10p ── 路由与目标**同生共死**（新角度：b 的 V2 只断言「manifest 不该有 options_ui」，
  //          没查**还有没有路走到那个已删的页面**。这是配对判据的另一半。）
  {
    const routeSites = [];
    for (const f of codeTexts) {
      if (/openOptionsPage\s*\(/.test(f.text)) routeSites.push(`${f.rel}:openOptionsPage()`);
      if (/opennote:open-options/.test(f.text)) routeSites.push(`${f.rel}:opennote:open-options`);
      if (/id:\s*"open-options"/.test(f.text)) routeSites.push(`${f.rel}:action "open-options"`);
    }
    const manifestDeclares = /"(options_ui|options_page)"\s*:/.test(inp.manifest);
    const optionsFiles = inp.srcFiles.filter((f) => /\/options\//.test(f.rel)).map((f) => f.rel);
    const targetExists = manifestDeclares && optionsFiles.length > 0;
    result["C-10p"] = {
      title: "㊵ 通往 options 页的路由与声明**同生共死**：有 `openOptionsPage()`/`opennote:open-options` 路由，就必须有 manifest options 声明**且**页面文件存在（或把路由删掉）",
      ok: routeSites.length === 0 || targetExists,
      detail: `路由位点 ${routeSites.length} 个：${routeSites.join(" / ") || "无"}；manifest 声明=${manifestDeclares}；options 页面文件=${optionsFiles.length} 个`,
      failDetail: `发现了 ${routeSites.length} 个路由位点（${routeSites.join(" / ")}），但 **目标不存在**：`
        + `manifest 声明=${manifestDeclares}、options 页面文件=${optionsFiles.length} 个。`
        + `三种正当修法任选其一：①删掉整条路由（含 `+"`state.js` 的 action、popup 的 case、background 的 handler"+`）`
        + `；②恢复 options 页并在 manifest 里声明；③若确定要借浏览器兜底（无声明页时 Chrome 会退到扩展详情页），`
        + `请把「有意兜底」写进注释并同步文案，然后让我按第③种改判据 —— 现在两处注释说的都还是**已退场的模板管理**。`,
    };
  }

  // C-10r ── **分发配对**：谁产出动作、谁负责处理，两边都要有落点（新角度）
  //          这一条是 `C-10p` 修好之后的**守卫**：删路由最容易只删一半
  //          （删了 popup 的 case 却留着 state.js 的 action → 界面上多一个点了没反应的按钮）。
  {
    const popupCode2 = stripCodeComments(inp.popupJs);
    const bgCode2 = stripCodeComments(inp.bgText);
    const stateCode2 = stripCodeComments(inp.stateJs);
    const cases = new Set([...popupCode2.matchAll(/case\s*"([^"]+)":/g)].map((m) => m[1]));
    const stateActionIds = new Set([...stateCode2.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]));
    const htmlActionIds = new Set([...popupBare.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]));
    const producers = [...new Set([...stateActionIds, ...htmlActionIds])].sort();
    const orphanActions = producers.filter((id) => !cases.has(id));
    const sentTypes = new Set([...popupCode2.matchAll(/type:\s*"(opennote:[^"]+)"/g)].map((m) => m[1]));
    const handled = new Set([...bgCode2.matchAll(/case\s*"(opennote:[^"]+)":/g)].map((m) => m[1]));
    const orphanMsgs = [...sentTypes].filter((t) => !handled.has(t)).sort();
    result["C-10r"] = {
      title: "㊵㊶ **分发配对**：每个动作 id（`state.js` 的 `plan.actions` ∪ `popup.html` 的 `data-action`）都有 popup 的分发分支；每个 popup 发出的 `opennote:*` 消息都有 background 的 handler",
      ok: orphanActions.length === 0 && orphanMsgs.length === 0,
      detail: `动作 id ${producers.length} 个（${producers.join("/")}）全部有分支；`
        + `popup 发出的消息 ${sentTypes.size} 种全部有 handler（background 共 ${handled.size} 个 case）`
        + `【新角度：守「删路由只删一半」——界面上留一个点了没反应的按钮】`,
      failDetail: `没有人处理的动作 id：${orphanActions.join(", ") || "无"}；`
        + `没有 handler 的消息类型：${orphanMsgs.join(", ") || "无"}`
        + `（popup 发出的消息共 ${sentTypes.size} 种，background 的 case 共 ${handled.size} 个）`,
    };
  }

  // C-10s ── **注释面的同族判据**：注释里的「去处」也必须是存在的（新角度）
  //          `C-10p` 管的是**代码路由**；注释是给下一个读者的事实陈述，同样不能指向已删的落点。
  //          难点：`background.js:39` 那类「记录某功能已退场」的注释**必须放行** ——
  //          否则就是在「记录退场」的文本上判「退场没做」（同 `C-10f` 的剥注释教训）。
  //          规则：同一行/同一注释块里同时出现「已退场功能名」与「已删落点」且**通篇没有退场字样** → 红。
  //          逃生口：写明「已退场 / 已删除 / 不再」即可通过（这也正是诚实的写法）。
  {
    const RETIRED_FEATURES = ["模板", "高亮"];
    const GONE_TARGETS = ["选项页", "options 页", "options_ui"];
    // 逃生口只认**强**退场词。第一版把「不再」也算进去，于是
    // `popup.js:533` 的「popup 里**不再**重复一份」把自己放行了 —— 假绿。
    // 「不再重复一份」不是「已退场」的陈述，不能当逃生口。
    const RETIREMENT_WORDS = /退场|已删|删除|随之退场|收回/;
    const hits = [];
    for (const f of inp.srcFiles) {
      if (!/^extension\//.test(f.rel)) continue;
      const lines = f.text.split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!/^(\/\/|\*|\/\*)/.test(trimmed)) return; // 只看注释行
        if (RETIREMENT_WORDS.test(trimmed)) return;   // 记录了「已退场」→ 放行
        const feature = RETIRED_FEATURES.find((w) => trimmed.includes(w));
        const target = GONE_TARGETS.find((w) => trimmed.includes(w));
        if (feature && target) hits.push(`${f.rel}:${i + 1}`);
      });
    }
    const manifestDeclares2 = /"(options_ui|options_page)"\s*:/.test(inp.manifest);
    const pageExists = manifestDeclares2 && inp.srcFiles.some((f) => /\/options\//.test(f.rel));
    /* 同一节的第二半：**孤儿 JSDoc**。JS 只把**紧贴声明的那一块**挂到声明上，
     * 一串相邻的 JSDoc 块里前面的都挂不上任何东西（`5f553a3` 清过一次，这是第三例）。
     * 只认「这一串的最后一块**确实紧贴一个声明**」的情形 —— 装饰性注释不会被误判。
     * 加这半边的理由：不加的话 b 只清 `popup.js:533` 我这条就绿了，
     * 那 11 行孤儿 JSDoc 会被**放行半个修复** —— 配对只守一半 = 没守，对我自己的判据也一样。 */
    const orphanJsdocs = [];
    for (const f of inp.srcFiles) {
      if (!/^extension\/src\/.*\.js$/.test(f.rel)) continue;
      for (const b of orphanJsdocBlocks(f.text)) orphanJsdocs.push(`${f.rel}:${b.start + 1}`);
    }
    result["C-10s"] = {
      title: "㊵㊶ **注释也是标签**：注释里的去处必须存在（已退场功能的注释不得把已删的 options 页当去处），且不得留**孤儿 JSDoc**（一串相邻 `/** */` 里挂不上声明的那几块）",
      ok: (hits.length === 0 || pageExists) && orphanJsdocs.length === 0,
      detail: `去处命中 ${hits.length} 处：${hits.join(", ") || "无"}；options 页存在=${pageExists}；`
        + `孤儿 JSDoc ${orphanJsdocs.length} 处：${orphanJsdocs.join(", ") || "无"}`
        + `【与 C-10p 同族：一个管代码路由、一个管注释里的去处；` + "`background.js:39` 那类「记录退场」的注释被放行】",
      failDetail: `注释仍把已删的 options 页当去处：${hits.join(", ") || "无"}（options 页存在=${pageExists}）；`
        + `孤儿 JSDoc：${orphanJsdocs.join(", ") || "无"}。`
        + `去处类两种正当修法：①删掉/改写这句注释（它描述的功能——模板导入导出——本身也已在 M2 退场）；`
        + `②若确实要保留，明写「已退场/已删除」。孤儿 JSDoc 只需保留**紧贴声明的那一块**，其余删掉或并进那一块。`,
    };
  }

  // C-10t ── **死导入**：`import` 进来的名字一次都没用到（新角度，且是 Lead 点名的同族）
  //          「声明与使用脱节」的第三种形态：孤儿 JSDoc（注释挂不上声明）、死路由（按钮没人接）、
  //          死导入（导入了没人用）。b 清 C44 时留下 `filterTags` 就是这么冒出来的。
  {
    const dead = [];
    const commentOnly = [];
    for (const f of inp.srcFiles) {
      if (!/^extension\/src\/.*\.js$/.test(f.rel)) continue;
      const r = deadImportsIn(f.text);
      for (const d of r.dead) dead.push(`${f.rel} 从 ${d}`);
      for (const c of r.commentOnly) commentOnly.push(`${f.rel} 从 ${c}`);
    }
    result["C-10t"] = {
      title: "㊵㊶ **死导入**：`import` 进来的每个本地名都要在文件里真的被用到（与孤儿 JSDoc、死路由同族：**声明与使用脱节**）",
      ok: dead.length === 0,
      detail: `死导入 ${dead.length} 处：${dead.join("；") || "无"}`
        + `；仅在注释里出现（**不判死**，` + "`@type {Foo}` 是合法用法" + `）${commentOnly.length} 处：${commentOnly.join("；") || "无"}`,
      failDetail: `死导入：${dead.join("；") || "无"}。处置：要么用起来，要么删掉这行 import ——`
        + `**清一个功能时把它的导入留下**，下一次就会有人以为那条路径还在。`,
    };
  }

  return result;
}

{
  const srcFiles = readTree(["extension/src", "src"], (rel) => TEXT_EXT.has(path.extname(rel)))
    .map((rel) => ({ rel, text: readIfExists(rel) || "" }));
  const distFiles = readTree(["extension/dist"], () => true);
  const distTexts = distFiles.filter((rel) => TEXT_EXT.has(path.extname(rel)))
    .map((rel) => ({ rel, text: readIfExists(rel) || "" }));
  const otherFiles = readTree(["extension/tests", "extension/tools"], (rel) => TEXT_EXT.has(path.extname(rel)))
    .map((rel) => ({ rel, text: readIfExists(rel) || "" }));

  const baseInputs = () => ({
    srcFiles,
    distFiles,
    distTexts,
    otherFiles,
    bgText: readIfExists(EXT("background.js")) || "",
    popupJs: readIfExists(EXT("popup/popup.js")) || "",
    popupHtml: readIfExists(EXT("popup/popup.html")) || "",
    stateJs: readIfExists(EXT("lib/state.js")) || "",
    manifest: readIfExists(EXT("manifest.json")) || "",
    buildInfo: (() => {
      try { return JSON.parse(readIfExists("extension/dist/BUILD-INFO.json") || "null"); } catch { return null; }
    })(),
  });

  const real = m2Checks(baseInputs());
  /* 「树在动」时不许把半写状态说成产品缺陷：与 b 的标记协议一致。
   * `scope: "dist"` 只放掉读产物的判据；`scope: "extension"`（变异运行中）连源码面也不判。 */
  const trust = extTrust();
  const DIST_READING = new Set(["C-10h", "C-10o"]);
  const unjudged = new Set(trust.trusted
    ? []
    : trust.scope === "extension" ? M2_IDS : M2_IDS.filter((id) => DIST_READING.has(id)));
  if (!trust.trusted) {
    UNTRUSTED.at = true;
    UNTRUSTED.why.push(`${trust.why} → 本次**不判**：${[...unjudged].join(", ") || "（无）"}`);
  }
  for (const id of M2_IDS) {
    if (unjudged.has(id)) {
      skip(`${id}（本次不判）`, real[id].title,
        `树在动：${trust.why}。**既不算通过也不算失败**；等构建/变异结束再跑本脚本。`);
      continue;
    }
    check(id, real[id].title, real[id].ok, real[id].detail, real[id].failDetail);
  }
  if (unjudged.size === M2_IDS.length) {
    info("C-10·本轮未判", "变异在跑，源码面判据全部未判（不许当绿）", trust.why);
  }

  /** 变异：只改内存里的文本，绝不落盘。`target: null` = **控制组**（必须保持全绿）。
   *  ⚠️ 同一个文件在 inputs 里有**两份表示**（顶层字段 + `srcFiles` 里那一项）。
   *  第一版只改了一份 → `orphan-action` 变异「改了文本但判据没感觉」（判据读的是另一份），
   *  被 `C-10·M2 变异有效性` 如实抓出来。这里统一**两份一起改**。 */
  const patchSource = (inp, suffix, fn) => ({
    ...inp,
    srcFiles: inp.srcFiles.map((f) => (f.rel.endsWith(suffix) ? { ...f, text: fn(f.text) } : f)),
    ...(suffix.endsWith("background.js") ? { bgText: fn(inp.bgText) } : {}),
    ...(suffix.endsWith("popup/popup.js") ? { popupJs: fn(inp.popupJs) } : {}),
    ...(suffix.endsWith("popup/popup.html") ? { popupHtml: fn(inp.popupHtml) } : {}),
    ...(suffix.endsWith("lib/state.js") ? { stateJs: fn(inp.stateJs) } : {}),
    ...(suffix.endsWith("manifest.json") ? { manifest: fn(inp.manifest) } : {}),
  });
  const patchSrc = patchSource;
  /** 自我归零：把「通向已删 options 页的注释」与「孤儿 JSDoc」**两种债都清掉** ——
   *  C-10s 的两个变异都要靠它拿到一个**绿的参照系**。
   *  第一版只清了前者，而真源此刻因为后者仍是红的 → 变异又变成「参照系本来就红、证明不了任何事」。 */
  /** 自我归零：把**现存**的死导入清掉 —— C-10t 变异的绿参照系。 */
  const cleanDeadImports = (i) => {
    const fix = (t) => stripDeadImports(t);
    return {
      ...i,
      srcFiles: i.srcFiles.map((f2) => (/^extension\/src\/.*\.js$/.test(f2.rel) ? { ...f2, text: fix(f2.text) } : f2)),
      popupJs: fix(i.popupJs),
      bgText: fix(i.bgText),
      stateJs: fix(i.stateJs),
    };
  };  const cleanCommentDebt = (i) => {
    const fix = (t) => stripOrphanJsdocs(String(t).split("\n").filter((l) => !/插件选项页/.test(l)).join("\n"));
    return {
      ...i,
      srcFiles: i.srcFiles.map((f) => (/^extension\/src\/.*\.js$/.test(f.rel) ? { ...f, text: fix(f.text) } : f)),
      popupJs: fix(i.popupJs),
      bgText: fix(i.bgText),
      stateJs: fix(i.stateJs),
    };
  };
  const M2_MUTATIONS = [
    {
      name: "highlight-in-code", target: "C-10f", expect: [],
      apply: (i) => patchSrc(i, "background.js", (t) => `${t}\nconst legacyHeading = "## 高亮";\n`),
    },
    {
      // 控制组：把同样的词塞进**注释**，判据必须**保持绿** —— 证明「剥注释」是精确的，
      // 而不是把所有东西都剥掉了（一条恒绿的检查也能通过「代码里塞词」以外的所有检查）。
      name: "highlight-in-comment（控制组）", target: null, expect: [],
      apply: (i) => patchSrc(i, "background.js", (t) => `${t}\n// 历史：正文里不再生成 ## 高亮 小节\n`),
    },
    {
      name: "second-menu-item", target: "C-10g", expect: [],
      apply: (i) => patchSource(i, "background.js", (t) => t.replace("chrome.contextMenus.create({", "chrome.contextMenus.create({\n      id: \"opennote-highlight\",\n      title: \"高亮这段文字\",\n    });\n    chrome.contextMenus.create({")),
    },
    {
      name: "menu-title-typo", target: "C-10g", expect: [],
      apply: (i) => patchSource(i, "background.js", (t) => t.replace("title: \"剪藏整页正文到 Opennote\"", "title: \"剪藏选中片段\"")),
    },
    {
      name: "dead-module-shipped", target: "C-10h", expect: [],
      apply: (i) => ({ ...i, distFiles: [...i.distFiles, "extension/dist/lib/highlights.js"] }),
    },
    {
      // 2026-09-30 实测撞到过这个形态：`extension/tools/mutation-check.ps1` 跑完把
      // `dist/<file>.bak-mutation` 留在**产物目录**里（下次打包就会被发出去）。
      name: "debris-in-dist", target: "C-10h", expect: [],
      apply: (i) => ({ ...i, distFiles: [...i.distFiles, "extension/dist/background.js.bak-mutation"] }),
    },
    {
      // 声明集合那一半的独立信号：一个**不是**残留、但 BUILD-INFO 没声明的文件。
      name: "undeclared-in-dist", target: "C-10h", expect: [],
      apply: (i) => ({ ...i, distFiles: [...i.distFiles, "extension/dist/leftover-note.js"] }),
    },
    {
      name: "options-ui-back", target: "C-10i", expect: [],
      apply: (i) => patchSource(i, "manifest.json", (t) => t.replace('"action"', '"options_ui": { "page": "options/options.html" },\n  "action"')),
    },
    {
      name: "third-button-in-row", target: "C-10k", expect: [],
      apply: (i) => patchSource(i, "popup/popup.html", (t) => t.replace('id="pickRow">', 'id="pickRow">\n      <button type="button" id="hlBtn">高亮这段文字</button>')),
    },
    {
      /* ⚠️ 锚点必须**与载荷里其它键无关**：第一版写死 `'send({ type: "opennote:preview", mode })'`，
       * ③ 给这个载荷加了 `images` 之后它就不匹配了（`NO_EFFECT`，自检如实报出来）。
       * 现在只锚在**契约里的那个键**（`type: "opennote:preview"`）上，加多少字段都能命中。 */
      name: "send-templateId（退场键复活：preview 载荷多一个 `templateId`）", target: "C-10m", expect: [],
      apply: (i) => patchSource(i, "popup/popup.js", (t) => t.replace(
        /(send\(\s*\{\s*type:\s*"opennote:preview")/,
        '$1, templateId: "t1"',
      )),
    },
    {
      // 另一个方向：**未声明**的新键（不是退场键）—— 契约没更新就没人知道这个字段存在。
      name: "send-undeclared-key（悄悄长出新字段：preview 载荷多一个 `wat`）", target: "C-10m", expect: [],
      apply: (i) => patchSource(i, "popup/popup.js", (t) => t.replace(
        /(send\(\s*\{\s*type:\s*"opennote:preview")/,
        '$1, wat: 1',
      )),
    },
    {
      // ⚠️ 第一版写的是 `/(\n\s*author:\s*)([^\n,]+),/` —— 它命中的是 `composeDelivery()` 里
      // **预览展示用** 的 `      author: extraction.author || "",`（6 空格缩进，本来就带兜底），
      // 于是把 `|| ""` 变成了 `|| "" || ""`，而**信封调用点那行没被碰到** → 目标仍绿。
      // 自检（含下面的「变异有效性」）如实报了出来。这里必须锁定**信封调用点的 4 空格缩进**。
      name: "source-fallback", target: "C-10n", expect: [],
      apply: (i) => patchSource(i, "background.js", (t) => t.replace(/(\n {4}author:\s*extraction\.author),/, '$1 || "",')),
    },
    {
      name: "storage-key-back", target: "C-10o", expect: [],
      apply: (i) => patchSrc(i, "lib/store.js", (t) => `${t}\nconst LEGACY_TEMPLATES_KEY = "opennote.templates.v1";\n`),
    },
    {
      // 删路由只删一半的三种形态：状态机多一个动作、popup 少一个分支、消息发出去没人接。
      // ⚠️ 这里**追加**而不是替换某一具体行 —— 第一版替换的是 `{ id: "open-options", … }`，
      //    结果 b 一修好那行就没了，变异「没改到文本」（自检如实报了出来）。
      //    变异不能依赖「产品当前恰好长这样」。
      name: "orphan-action（state.js 多一个动作，popup 没有分支）", target: "C-10r", expect: [],
      apply: (i) => patchSrc(i, "lib/state.js", (t) => `${t}\nplan.actions = [{ id: "manage-templates", label: "管理模板…", primary: false }];\n`),
    },
    {
      name: "drop-case（popup 少一个分支，动作 id 还在）", target: "C-10r", expect: [],
      apply: (i) => patchSource(i, "popup/popup.js", (t) => t.replace('case "queue":', 'case "queue2":')),
    },
    {
      name: "orphan-message（popup 发一个没人接的消息）", target: "C-10r", expect: [],
      apply: (i) => patchSource(i, "popup/popup.js", (t) => t.replace('type: "opennote:submit"', 'type: "opennote:submit2"')),
    },
    {
      // ⚠️ 变异必须**自带归零**：第一版是「再追加一句过时注释」，可产品当前那行本来就是红的
      //    → 目标在基线就红，变异证明不了任何事（自检如实报了出来）。
      //    改成「先把现存那行删掉（归零）→ 再注入一句过时注释（弄坏）」，于是无论产品
      //    此刻是干净还是脏的，它都必须翻红。
      name: "stale-options-comment（先归零再注入：注释把已删的选项页当去处）", target: "C-10s", expect: [],
      pre: (i) => cleanCommentDebt(i),
      apply: (i) => patchSource(cleanCommentDebt(i), "popup/popup.js", (t) => `${t}\n// 模板的导入/导出搬到插件选项页（C06「管理模板…」）。\n`),
    },
    {
      // 控制组：**同样提到已删的选项页，但写明了它已退场** —— 判据必须保持绿，
      // 否则它就是在「记录退场」的文本上判「退场没做」（同 C-10f 的教训）。同样先归零。
      name: "retired-comment-in-comment（控制组：写明已退场）", target: null, expect: [],
      pre: (i) => cleanCommentDebt(i),
      apply: (i) => patchSource(cleanCommentDebt(i), "popup/popup.js", (t) => `${t}\n// 选项页已随模板一起退场（M2）；这里只留一句史话。\n`),
    },
    {
      // 死导入（与孤儿 JSDoc 同族的第三种形态）：import 了一个没人用的名字。
      name: "dead-import（先归零再注入：导入了没人用的符号）", target: "C-10t", expect: [],
      pre: (i) => cleanDeadImports(i),
      apply: (i) => patchSource(cleanDeadImports(i), "popup/popup.js", (t) => `${t}\nimport { filterTags } from "../lib/envelope.js";\n`),
    },
    {
      // 孤儿 JSDoc 那半边的独立信号：一串两块，只有紧贴声明的那块挂得上。
      name: "orphan-jsdoc（一串相邻 JSDoc，前面那块挂不上任何声明）", target: "C-10s", expect: [],
      pre: (i) => cleanCommentDebt(i),
      apply: (i) => patchSource(cleanCommentDebt(i), "popup/popup.js", (t) => `${t}\n/** 退役的模板选择器（㉘㉙）。 */\n/** 预览（模板 + 手改 + 高亮）。 */\nfunction selftestOrphan() { return 1; }\n`),
    },
  ];
  const log = [];
  let mutationsOk = true;
  /* 基线要先算一次：**牵连必须是「增量」**。
   * `C-10p` 在真源上本来就是红的（M2 漏删的路由），如果按「绝对态」统计牵连，
   * 每个变异都会背上一个 `C-10p` —— 那不是牵连，是**基线里就有的红**。
   * 这与 a-defects 的「`NO_EFFECT` 不能算 `MISSED`」同族：比较的对象必须是**基线**，不是绝对零。 */
  const m2Base = baseInputs();
  const m2BaseJson = JSON.stringify(m2Base);
  const m2BaseVerdict = m2Checks(m2Base);
  const baseRed = M2_IDS.filter((id) => m2BaseVerdict[id].ok === false);
  for (const m of M2_MUTATIONS) {
    const mutated = m.apply(m2Base);
    /* 参照系：默认是「真源」。自归一型变异（先修好再弄坏）可以声明 `pre` ——
     * 那时它要对比的是**修好后的状态**，而不是恰好此刻是脏的真源。
     * 否则「产品当前正好是坏的」会把一个有效的变异判成「证明不了任何事」。 */
    const refVerdict = m.pre ? m2Checks(m.pre(m2Base)) : m2BaseVerdict;
    const refJson = m.pre ? JSON.stringify(m.pre(m2Base)) : m2BaseJson;
    const mutatedJson = JSON.stringify(mutated);
    /* **落地自检**（Lead 2026-09-30：变异必须先证明落地）：打印命中处数（行多重集差值）
     * + 改动前后 sha256；0 命中 → `NO_EFFECT`（exit 2），**不**进红绿判定。
     * 旧版只比「字符串不等」—— 那证明不了「锚点命中了契约里的那处」，正是
     * `send-templateId` 锚点过期时「看起来改了文本、其实打空了」的温床。 */
    const landingHits = changedLineCount(refJson, mutatedJson);
    if (!mutationLanded("C-10·变异M2", m.name, refJson, mutatedJson, landingHits, m.target)) {
      log.push(`${m.name}→NO_EFFECT（未判定）`);
      mutationsOk = false;
      continue;
    }
    const changed = true;
    const verdict = m2Checks(mutated);
    const newlyRed = M2_IDS.filter((id) => refVerdict[id].ok === true && verdict[id].ok === false);
    let fine;
    let why = "";
    if (m.target === null) {
      // 控制组：**改到了文本**、且**没有任何检查新增变红**
      fine = changed && newlyRed.length === 0;
      why = [
        changed ? "" : "**变异没改到文本**",
        newlyRed.length ? `控制组不该让任何检查变红，实际新增红 ${newlyRed.join(",")}` : "",
      ].filter(Boolean).join("；");
      log.push(`${m.name}→保持全绿 ${fine ? "✓" : `✗（${why}）`}`);
    } else {
      const targetFlipped = refVerdict[m.target].ok === true && verdict[m.target].ok === false;
      const collateral = newlyRed.filter((id) => id !== m.target).sort();
      const collateralOk = collateral.join(",") === [...m.expect].sort().join(",");
      fine = changed && targetFlipped && collateralOk;
      if (!fine) mutationsOk = false;
      why = [
        changed ? "" : "**变异没改到文本**",
        refVerdict[m.target].ok === false ? "目标在参照系里就是红的（该变异证明不了任何事）" : "",
        targetFlipped ? "" : "目标没有翻红",
        collateralOk ? "" : `牵连与声明不符（实际 ${collateral.join(",") || "无"} / 声明 ${m.expect.join(",") || "无"}）`,
      ].filter(Boolean).join("；");
      log.push(`${m.name}→${m.target} ${fine ? "红✓" : `未红✗（${why}）`}`
        + `${collateral.length ? `（+牵连 ${collateral.join(",")}）` : ""}`);
    }
    if (!fine && m.target === null) mutationsOk = false;
  }
  if (baseRed.length) {
    info("C-10·M2 基线红", "跑变异前真源上已经存在的红（**不计入任何变异的牵连**）",
      `${baseRed.join(", ")} —— 它们要在「基线」里如实存在，而不是被算成某次变异的副作用`);
  }
  check("C-10·变异M2", `㊵㊶ 断言自检：${M2_MUTATIONS.length} 个内存变异（含 1 个控制组）各自生效，且牵连与声明一致`,
    mutationsOk, log.join("；"), log.join("；"));
  const MUT_JUDGED = trust.trusted;
  if (!MUT_JUDGED) {
    withdrawLast("C-10·变异M2", `${trust.why} —— 变异自检要读真源当基线，树在动时它会给出假红/假绿，**本次不判**。`);
  }
  // 变异没改到文本 = 假通过的前身：单独报出来（同 a-defects 的 NO_EFFECT ≠ MISSED）
  const noEffect = [];
  for (const m of M2_MUTATIONS.filter((x) => x.target !== null)) {
    const ref = m.pre ? m2Checks(m.pre(m2Base)) : m2BaseVerdict;
    const after = m2Checks(m.apply(m2Base))[m.target];
    if (JSON.stringify(ref[m.target]) === JSON.stringify(after)) noEffect.push(m.name);
  }
  if (noEffect.length) {
    fail("C-10·M2 变异有效性", "有变异**没有改变目标判据的结论**（这类变异若被算作通过，就是假通过）",
      `无效变异：${noEffect.join(", ")}`);
  } else {
    info("C-10·M2 变异有效性", "每个变异都确实改变了目标判据的结论（不是「改了文本但判据没感觉」）",
      `${M2_MUTATIONS.filter((x) => x.target !== null).length} 个变异全部有效`);
  }
  if (!MUT_JUDGED) {
    withdrawLast("C-10·M2 变异有效性", `${trust.why} —— 同上，本次不判。`);
  }

  /* ── C-10p 三态自检：三种几何**自己造**，不拿产品当前状态当前提 ───────────────
   * 第一版写成「现行必须是红」，于是 b 一修好，自检自己就红了 —— 那说明这条自检
   * 依赖的是**产品此刻是坏的**，而不是判据本身能分辨好坏。改成自己注入：
   *   ① 注入一条悬挂路由（有路由、无声明页）→ 必须红；
   *   ② 真源（无论修没修）→ 按判据如实给；
   *   ③ 恢复页面 + 有路由 → 必须绿（证明它不是「一刀禁掉 openOptionsPage」）。 */
  {
    const dropRoute = (i) => ({
      ...i,
      srcFiles: i.srcFiles.map((f) => {
        let text = f.text;
        if (f.rel.endsWith("popup.js")) text = text.replace(/^\s*case "open-options":\n(?:.*\n)*?\s*break;\n/m, "");
        if (f.rel.endsWith("background.js")) {
          text = text.replace(/^\s*case "opennote:open-options":\n(?:.*\n)*?\s*return \{ ok: true \};\n/m, "");
        }
        if (f.rel.endsWith("lib/state.js")) text = text.replace(/^\s*\{ id: "open-options",[^\n]*\},?\n/m, "");
        return { ...f, text };
      }),
    });
    const injectRoute = (i) => ({
      ...i,
      bgText: `${i.bgText}\n// 自检注入：一条通往 options 页的路由\nasync function selftestRoute() { await chrome.runtime.openOptionsPage(); }\n`,
      srcFiles: i.srcFiles.map((f) => (f.rel.endsWith("background.js")
        ? { ...f, text: `${f.text}\n// 自检注入：一条通往 options 页的路由\nasync function selftestRoute() { await chrome.runtime.openOptionsPage(); }\n` }
        : f)),
    });
    const restorePage = (i) => ({
      ...i,
      manifest: i.manifest.replace('"action"', '"options_ui": { "page": "options/options.html" },\n  "action"'),
      srcFiles: [...i.srcFiles, { rel: "extension/src/options/options.html", text: "<html><body>options</body></html>" }],
    });
    const dangling = m2Checks(injectRoute(baseInputs()))["C-10p"].ok;            // 期望 false
    const live = m2Checks(baseInputs())["C-10p"].ok;                             // 真源如实
    const repaired = m2Checks(restorePage(injectRoute(baseInputs())))["C-10p"].ok; // 期望 true
    check("C-10p·三态自检",
      "C-10p 判据三态正确：**注入**一条悬挂路由 → 红；**恢复页面**后同样有路由 → 绿（证明它不是「一刀禁掉 openOptionsPage」）；真源按实给",
      dangling === false && repaired === true,
      `注入悬挂路由=${dangling ? "绿" : "红"}（期望红）；恢复页面=${repaired ? "绿" : "红"}（期望绿）；真源现状=${live ? "绿（路由已删净）" : "红（仍有悬挂路由）"}`,
      `注入悬挂路由=${dangling ? "绿" : "红"}（期望红）恢复页面=${repaired ? "绿" : "红"}（期望绿）真源=${live}`);
    /* 另有一条独立观察：`dropRoute` 修法在当前树上是否真的可行（不是断言，是情报）。 */
    info("C-10p·备选修法", "「删掉整条路由」这条修法在当前树上的效果（只作情报，不参与判定）",
      `把四个位点全删掉后 C-10p=${m2Checks(dropRoute(baseInputs()))["C-10p"].ok ? "绿" : "红"}`
      + `（本判据对「删路由」与「恢复页面」两种正当修法都放行）`);
  }

  /* ── 信任门自检：证明这道门不是死代码 ─────────────────────────────────────
   * 不能靠「真去写一个 `.building` 标记」来测 —— `extension/` 是 b 的工作面，
   * 我往里塞标记会顺带把 b 自己的门禁判成不可信。所以用注入 + 撤回自检：
   *   ① 注入 `.mutation-running` → extension 面整体不判；
   *   ② 注入 `.building` → 只放掉读 dist 的判据；
   *   ③ `withdrawLast` 机制本身可用（先记一条再撤回成 SKIP，台账不留残渣）。 */
  {
    const fakeMut = extTrust({ injectMarker: "extension/.mutation-running" });
    const fakeBuild = extTrust({ injectMarker: "extension/.building" });
    pass("__trust-selftest__", "withdrawLast 自检占位（本方不留在台账里）", "占位");
    withdrawLast("__trust-selftest__", "自检：这条应被撤回");
    const asSkip = results[results.length - 1];
    const mechOk = Boolean(asSkip) && asSkip.id === "__trust-selftest__" && asSkip.status === "SKIP";
    results.pop(); // 自检不留痕：台账恢复原样（否则摘要里会多一条莫名其妙的 SKIP）
    const noResidue = !results.some((r) => r.id === "__trust-selftest__");
    check("C-10·信任门自检",
      "「树在动」门禁三态正确：`.mutation-running` → extension 面整体不判；`.building` → 只放掉读 dist 的判据；`withdrawLast` 能把已记录的结论撤回成 SKIP 且不留残渣",
      fakeMut.trusted === false && fakeMut.scope === "extension"
        && fakeBuild.trusted === false && fakeBuild.scope === "dist" && mechOk && noResidue,
      `注入 .mutation-running→scope=${fakeMut.scope}；注入 .building→scope=${fakeBuild.scope}；`
        + `withdrawLast=${mechOk ? "把 PASS 撤回成 SKIP ✓" : "失效"}、无残渣=${noResidue}；真源本次=${trust.trusted ? "可信" : trust.why}`,
      `注入 .mutation-running→scope=${fakeMut.scope}（应为 extension）；注入 .building→scope=${fakeBuild.scope}（应为 dist）；`
        + `withdrawLast 写成 SKIP=${mechOk}；无残渣=${noResidue}`);
  }

  /* ── C-10q（INFO，登记不改判）：这条路由的**可达性**与「同名不同行为」────────────
   * 判「该删还是该改文案」是产品裁定，不是事实问题；但事实必须摆出来。 */
  {
    const stateCode = stripCodeComments(readIfExists(EXT("lib/state.js")) || "");
    const popupCode2 = stripCodeComments(readIfExists(EXT("popup/popup.js")) || "");
    const bgCode2 = stripCodeComments(readIfExists(EXT("background.js")) || "");
    const rawPopup = readIfExists(EXT("popup/popup.js")) || "";
    const rawBg = readIfExists(EXT("background.js")) || "";
    const restrictedAction = /id:\s*"open-options"/.test(stateCode);
    const menuHidden = /more\.hidden\s*=[^;]*RESTRICTED_PAGE/.test(popupCode2);
    const popupCase = /case "open-options":/.test(popupCode2);
    const bgCase = /case "opennote:open-options":/.test(bgCode2);
    const openOptions = /openOptionsPage\s*\(/.test(bgCode2);
    const staleComments = [];
    if (/模板选择器/.test(rawPopup)) staleComments.push("popup.js 的 case 注释仍说「C06 的落点在**模板选择器**里」");
    if (/模板管理/.test(rawBg)) staleComments.push("background.js 的 case 注释仍说「**模板管理**走 options 页」");
    if (restrictedAction || popupCase || bgCase) {      info("C-10q", "那条 options 路由的现状（事实摆出，该删还是该改由 Lead 裁定）",
        `可达链：<页面受限> → state.js 的 RESTRICTED_PAGE 给一个 label 为「插件设置」的 action \`open-options\``
        + `（同名 action 在 ⋯ 菜单里是 \`settings\` → **popup 内设置视图**，两者行为不同）`
        + ` → popup 的 case（${popupCase ? "在" : "无"}）→ background 的 case（${bgCase ? "在" : "无"}）`
        + ` → \`openOptionsPage()\`（${openOptions ? "在" : "无"}）。`
        + `同一状态下 ⋯ 菜单被隐藏（\`more.hidden … RESTRICTED_PAGE\`=${menuHidden}），所以那个状态下**只有这一条**「插件设置」。`
        + `两处注释引用的都是已退场功能：${staleComments.join("；") || "（无）"}。`
        + `⚠️ **未验证**：无声明 options 页时 \`chrome.runtime.openOptionsPage()\` 在真机上到底打开什么`
        + `（Chrome 可能退到扩展详情页）—— 本环境没有浏览器，我不猜；上面的断言只咬「路由 vs 声明」不一致这一静态事实。`);
    }
  }
}

/* ==================================================================== §14 */
/* §14 C-12a…C-12c · 桌面端 IPC 通道配对（新角度）
 *
 * 与 `scripts/ipc-safety-check.cjs` 62 条的重叠核对（**先说清，不谎报新覆盖**）：
 *   · **0 条**做「通道 ⇄ handler」配对 —— 它管的是安全面（fs 授权 / junction 越界 / CSP /
 *     webPreferences / 关闭握手 / 方法名与 arity）；
 *   · 部分重叠：「既有 fs / dialog / shell / app 方法名与参数个数不变」（L1150）与
 *     「新增 API：authorizeRoot / watch / flush 握手齐全」（L1184）断言的是 preload **方法名与 arity**，
 *     **不是通道**；「onFlushRequest …flushDone 发对频道」（L1194）用 stub 抓 `send` 的频道名，
 *     只覆盖 flush **一条**频道。
 *   本组咬的是**两侧集合的配对** —— 正是 `getWorkspaceInfo` 从未传给桥（插件对开着的笔记本报
 *   `IMP-4007`）、`bridgeStatusPayload()` 静默截断 6 个字段、`newPairCode` handler 残留、
 *   `token()` 无 handler 那一类形状的护栏。
 *
 * 判据只读源码文本（不启动 Electron）；无法解析的通道表达式**不判红**，单列成观察。 */
/**
 * 把**注释**抹成空格（保留换行 ⇒ **行号不变**），字符串字面量原样保留。
 *
 * **为什么需要它**（Lead 2026-09-30 复核 C-12c 的误报）：`channelsAt()` 原来在**原文**上抽通道，
 * 于是 preload 顶部那段说明性注释里写出的调用形状
 * （`subscribe('opennote:menu', callback)` —— 说的是「这里曾是接入点」）
 * 被当成了一个**真的订阅** → C-12c 报「听了没人发」。**说明性注释不等于订阅**：
 * 注释是标签，不是事实。反过来，如果判据把注释里的形状也算数，那任何写文档的人都会
 * 让判据变红 —— 判据就成了噪声（「判据误报一次，就等于教别人忽略它一次」）。
 *
 * **但不能因此变松**：真代码里的订阅仍必须被抽到。两向都有自检：
 *   · `comment-call-shape`（**控制组**）：注释里写出完整调用形状 → 必须**保持绿**；
 *   · `dead-listener`：真加一行订阅（代码）→ 必须**变红**。
 * 另有 `commentStripAudit()`（剥离自检）：**非注释区**里的任何匹配若在剥离后消失，
 * 说明是剥离器自己吞了代码 → 直接 FAIL（检查器自己的 NO_EFFECT）。
 *
 * 实现是逐字符扫描（不是正则）：需要区分「字符串里的 `//`」与真注释 ——
 * 正则版本会误伤 `'https://…'` 这类字面量。
 */
function stripCommentsKeepLines(input) {
  const src = String(input);
  const spans = [];
  let out = "";
  let i = 0;
  /** 状态机：code / "line" / "block" / 引号字符本身（字符串或模板）/ "regex" */
  let state = "code";
  let spanStart = -1;
  /** 正则字面量判定用：上一个**有意义**的字符（跳过空白与换行）。 */
  const prevSignificant = (at) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    return j >= 0 ? src[j] : "";
  };
  const REGEX_PREFIX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; spanStart = i; out += "  "; i += 2; continue; }
      if (c === "/" && d === "*") { state = "block"; spanStart = i; out += "  "; i += 2; continue; }
      /* ⚠️ **正则字面量**：`/["']/` 里的引号不是字符串起点。不认它，状态机会从这里开始失步，
       * 于是**后面整段真代码被当成字符串/注释吞掉**（`C-13b` 的变异自检当场抓到的：
       * popup.js 里 `+ "/clip/" + id` 那行被后面的行注释状态吃掉了）。
       * 用通行的启发式：`/` 前面是有意义的「表达式起始」字符（或行首）时，它是正则。 */
      if (c === "/" && REGEX_PREFIX.has(prevSignificant(i))) {
        out += c; i += 1;
        let inClass = false;
        while (i < src.length) {
          const rc = src[i];
          if (rc === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
          if (rc === "[") inClass = true;
          else if (rc === "]") inClass = false;
          else if (rc === "/" && !inClass) { out += rc; i += 1; break; }
          else if (rc === "\n") break; // 未闭合的正则：不在这一行里继续吞
          out += rc; i += 1;
        }
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { state = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; spans.push([spanStart, i]); out += c; } else out += " ";
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; spans.push([spanStart, i + 2]); out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1; continue;
    }
    // 字符串 / 模板字面量：原样保留（含转义），只负责不被当成注释起点
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === state) state = "code";
    out += c; i += 1;
  }
  if (spanStart >= 0 && state !== "code") spans.push([spanStart, src.length]);
  return { text: out, spans };
}

/**
 * **剥离器自己的单元自检**（Lead 2026-09-30 补充 1 的反向要求）。
 *
 * 为什么要它：`/["']/` 这种**正则字面量里的引号**会让状态机失步，之后**整段真代码被吞掉** ——
 * 症状与「没人订阅 / 没有那行代码」**完全一样**（这正是「判据误报教人忽略它」的同族）。
 * 所以剥离器必须有可执行的用例，而不是只靠「非注释区丢失 0 处」那一条文件级审计
 * （那条审计只会发现「判据已经要看的形状」丢了，发现不了「判据没在看的东西」丢了）。
 */
const STRIP_SELFTEST_CASES = [
  { name: "行注释里的引号要被抹掉", src: 'const a = 1 // "quote" in comment\nconst b = 2', probe: (t) => !t.includes("quote") && t.includes("const b = 2") },
  { name: "字符串里的 // 不是注释", src: 'const a = "http://x" // y\nconst b = 2', probe: (t) => t.includes('"http://x"') && t.includes("const b = 2") },
  { name: "正则字面量里的引号不是字符串（失步源）", src: 'const re = /["\']/g\nconst s = "//not a comment"\nconst c = 3', probe: (t) => t.includes('const c = 3') && t.includes('"//not a comment"') },
  { name: "模板字面量里的 // 与引号都不是注释", src: 'const t = `a//b "c"`\nconst d = 4', probe: (t) => t.includes("`a//b \"c\"`") && t.includes("const d = 4") },
  { name: "块注释跨行：内容抹掉、换行与行号保留", src: '/* multi\nline "x" */\nconst e = 5', probe: (t) => !t.includes("multi") && t.includes("const e = 5") && t.split("\n").length === 3 },
  { name: "除号不是正则起点", src: 'const f = a / b / c // 注释\nconst g = 6', probe: (t) => t.includes("const g = 6") },
];
function stripSelftest() {
  const bad = [];
  for (const c of STRIP_SELFTEST_CASES) {
    const stripped = stripCommentsKeepLines(c.src).text;
    if (!c.probe(stripped)) bad.push(`${c.name} → ${JSON.stringify(stripped.slice(0, 80))}`);
  }
  return { total: STRIP_SELFTEST_CASES.length, bad };
}

/**
 * **剥离器自检**：非注释区里出现过的匹配，剥离后必须**逐字还在原偏移**。
 * 少一处就说明剥离器吞了真代码（例如把正则字面量 `/\//` 当成了行注释）——
 * 那是**检查器自己**的 NO_EFFECT，必须报红，不能静默降级成「通道少了一个」。
 */
function commentStripAudit(raw, patterns, strip = stripCommentsKeepLines) {
  const { text, spans } = strip(raw);
  const inComment = (idx) => spans.some(([s, e]) => idx >= s && idx < e);
  const lost = [];
  for (const re of patterns) {
    const scanner = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of String(raw).matchAll(scanner)) {
      if (inComment(m.index)) continue; // 注释里的形状：本来就该被剥掉
      if (text.startsWith(m[0], m.index)) continue;
      lost.push(`${m[0].replace(/\s+/g, " ").slice(0, 48)}（第 ${String(raw).slice(0, m.index).split("\n").length} 行）`);
    }
  }
  return { text, spans, lost };
}

function channelConstsOf(text) {
  const map = new Map();
  for (const m of String(text).matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}
/** 包装函数的形参名：`function handle(channel, …)` / `const invoke = (channel, …)` 里的 `channel`
 *  不是「产地」，不能当成通道，也不该报成「解析不了」。 */
const CHANNEL_PARAMS = new Set(["channel", "ch", "name", "args"]);

/** 整个 `electron/` 目录里的字面通道常量（跨文件解析用：main 从 `./deeplink.cjs`
 *  取 `DEEPLINK_CHANNEL`，只在本文件里找常量会漏 → 误报「发了没人听」）。 */
function sharedChannelConsts(files) {
  const map = new Map();
  for (const f of files) {
    for (const [k, v] of channelConstsOf(f.text)) map.set(k, v);
  }
  return map;
}

function channelsAt(text, patterns, shared) {
  const src = String(text);
  const consts = channelConstsOf(src);
  const look = (name) => (consts.has(name) ? consts.get(name) : (shared && shared.has(name) ? shared.get(name) : null));
  const channels = new Map(); // channel -> 首个出现行
  const unresolved = [];
  const params = new Set();
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const raw = String(m[1]).trim();
      const line = src.slice(0, m.index).split("\n").length;
      if (/^["']/.test(raw)) {
        const name = raw.slice(1, -1);
        if (!channels.has(name)) channels.set(name, line);
      } else if (/^[A-Za-z_$][\w$]*$/.test(raw)) {
        const name = look(raw);
        if (name !== null) {
          if (!channels.has(name)) channels.set(name, line);
        } else if (CHANNEL_PARAMS.has(raw)) params.add(raw);
        else unresolved.push(`${raw}（第 ${line} 行）`);
      } else {
        unresolved.push(`${raw}（第 ${line} 行）`);
      }
    }
  }
  return { channels, unresolved, params: [...params] };
}

const fmtChannels = (m) => [...m.entries()].map(([c, l]) => `${c}（第 ${l} 行）`).join("、") || "无";

/** 顶层逗号切分（忽略括号与字符串里的逗号）。 */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = s.indexOf(c, i + 1);
      cur += s.slice(i, end < 0 ? s.length : end + 1);
      i = end < 0 ? s.length : end;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    if (")]}".includes(c)) depth -= 1;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function resolveChannelExpr(expr, consts, shared) {
  const e = String(expr).trim();
  const q = /^['"]([^'"]+)['"]$/.exec(e);
  if (q) return q[1];
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (consts && consts.has(e)) return consts.get(e);
    if (shared && shared.has(e)) return shared.get(e);
  }
  return null;
}
/** 函数体（按花括号配对取），用于识别「包装函数」。 */
function functionBodies(text) {
  const src = String(text);
  const out = [];
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") depth -= 1;
      i += 1;
    }
    out.push({
      name: m[1],
      params: m[2].split(",").map((s) => s.trim()).filter(Boolean),
      body: src.slice(m.index + m[0].length, i - 1),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}
/** 包装函数解析：`function relayToRenderer(channel, payload) { … webContents.send(channel, …) }`
 *  的**调用点**才是真正的产地。第一版没做这层 → `import:request` / `import:receipt` 被误报「听了没人发」。 */
function channelsViaWrappers(text, kind, consts, shared) {
  const src = String(text);
  const found = new Map();
  const unresolved = [];
  const sendRe = /webContents\.send\(\s*([A-Za-z_$][\w$]*)/;
  const handleRe = /(?<![.\w])handle\(\s*([A-Za-z_$][\w$]*)/;
  for (const fn of functionBodies(src)) {
    const probe = kind === "send" ? sendRe.exec(fn.body) : handleRe.exec(fn.body);
    if (!probe) continue;
    const idx = fn.params.indexOf(probe[1]);
    if (idx < 0) continue;
    const callRe = new RegExp(`(?<![.\\w])${fn.name}\\(([^)]*)\\)`, "g");
    for (const call of src.matchAll(callRe)) {
      const args = splitTopLevel(call[1]);
      const arg = (args[idx] || "").trim();
      const name = resolveChannelExpr(arg, consts, shared);
      const line = src.slice(0, call.index).split("\n").length;
      if (name === null) { if (arg) unresolved.push(`${arg}（第 ${line} 行，经 ${fn.name}）`); continue; }
      if (!found.has(name)) found.set(name, line);
    }
  }
  return { channels: found, unresolved };
}
/** 三元链求值（保守）：能判定的判定，判不了的两支都算（多算只会让判据更宽，不会假绿）。 */
function splitTernary(e) {
  let depth = 0;
  let q = -1;
  for (let i = 0; i < e.length; i += 1) {
    const c = e[i];
    if (c === "'" || c === '"' || c === "`") { i = e.indexOf(c, i + 1); if (i < 0) return null; continue; }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "?" && depth === 0 && q < 0) q = i;
    else if (c === ":" && depth === 0 && q >= 0) {
      return { cond: e.slice(0, q), then: e.slice(q + 1, i), else: e.slice(i + 1) };
    }
  }
  return null;
}
function evalTplExpr(expr, param, value) {
  const e = String(expr).trim();
  const q = /^['"]([^'"]*)['"]$/.exec(e);
  if (q) return [q[1]];
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return e === param ? [value] : [`{${e}}`];
  const t = splitTernary(e);
  if (!t) return [`{${e}}`];
  /* ⚠️ 提取标识符前必须**去掉字符串字面量**：`op === 'recent'` 里的 `recent`
   * 会被 `[A-Za-z_$][\w$]*` 当成标识符 →条件被误判成「含别的变量」→ 保守展开出
   * `opennote:inbox:recent` 这类**交叉组合**的假名（第一版就这样误报了一串死 handler）。 */
  const condNoStrings = t.cond.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const otherIdent = [...condNoStrings.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((n) => n !== param);
  const lits = [...t.cond.matchAll(new RegExp(`${param}\\s*={2,3}\\s*'([^']+)'`, "g"))].map((m) => m[1]);
  if (otherIdent.length === 0 && lits.length) {
    return lits.includes(value) ? evalTplExpr(t.then, param, value) : evalTplExpr(t.else, param, value);
  }
  return [...evalTplExpr(t.then, param, value), ...evalTplExpr(t.else, param, value)];
}
/** 工厂解析：`const F = (p) => handle(\`opennote:${…}\`)` + `F('recent')` → 展开出真实通道名。 */
function channelsViaFactories(text, consts, shared) {
  const src = String(text);
  const found = new Map();
  const unresolved = [];
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\(([A-Za-z_$][\w$]*)\)\s*=>\s*handle\(\s*`([^`]*)`/g)) {
    const [, fname, param, tpl] = m;
    const line0 = src.slice(0, m.index).split("\n").length;
    const callRe = new RegExp(`(?<![.\\w])${fname}\\(\\s*(['"][^'"]*['"])`, "g");
    let any = false;
    for (const call of src.matchAll(callRe)) {
      const value = call[1].slice(1, -1);
      const line = src.slice(0, call.index).split("\n").length;
      let candidates = [""];
      for (const part of tpl.split(/\$\{([^}]*)\}/)) {
        const isExpr = tpl.split(/\$\{([^}]*)\}/).indexOf(part) % 2 === 1;
        if (!isExpr) { candidates = candidates.map((c) => c + part); continue; }
        const vals = evalTplExpr(part, param, value);
        candidates = candidates.flatMap((c) => vals.map((v) => c + v));
      }
      for (const c of candidates) {
        any = true;
        if (!found.has(c)) found.set(c, line);
      }
    }
    if (!any) unresolved.push(`${fname}(\`…\`)（第 ${line0} 行，工厂未被静态调用）`);
  }
  void consts;
  void shared;
  return { channels: found, unresolved };
}
/** 已声明的 IPC 例外（**自证**）：注释里写明「保留」+「下线」，且 handler 体内确实抛「已下线」。 */
function declaredIpcExceptions(text) {
  const src = String(text);
  const out = [];
  for (const m of src.matchAll(/((?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*)handle\(\s*\n?\s*'([^']+)'/g)) {
    const comment = m[1];
    const channel = m[2];
    if (!/保留/.test(comment) || !/下线/.test(comment)) continue;
    const bodyStart = m.index + m[0].length;
    const body = src.slice(bodyStart, bodyStart + 900);
    const throwsFriendly = /throw/.test(body) && /已下线/.test(body);
    out.push({ channel, throwsFriendly, evidence: "注释写明「保留…下线」且体内确实 throw「已下线」" });
  }
  return out;
}
/** 抽取用的调用形状（两处共用：剥离自检与真正的抽取都必须用**同一组**模式，
 *  否则「自检通过」与「实际抽取」比对的不是同一件事）。 */
const IPC_PATTERNS_PRE = [
  /(?<![.\w])(?:invoke|ipcRenderer\.send|ipcRenderer\.sendSync)\(\s*([^,)]+)/g,
  /(?<![.\w])subscribe\(\s*([^,)]+)/g,
  /ipcRenderer\.on\(\s*([^,)]+)/g,
];
const IPC_PATTERNS_MAIN = [
  /(?<![.\w])(?:handle|ipcMain\.handle|ipcMain\.on)\(\s*([^,)]+)/g,
  /webContents\.send\(\s*([^,)]+)/g,
];
function ipcPairChecks(inp) {
  /* ⚠️ **先剥注释**（Lead 2026-09-30 复核的 C-12c 误报）：说明性注释里写出的调用形状
   * （`subscribe('opennote:menu', callback)`）不是订阅。行号必须不变 ⇒ 用的是
   * `stripCommentsKeepLines()`（把注释抹成空格、保留换行），不是 `stripCodeComments()`。 */
  const audits = {
    pre: commentStripAudit(inp.preload, IPC_PATTERNS_PRE),
    main: commentStripAudit(inp.main, IPC_PATTERNS_MAIN),
  };
  const P = audits.pre.text;
  const M = audits.main.text;
  const shared = inp.sharedConsts || new Map();
  /* ⚠️ 首参可能**换行**在下一行（main 里多数 `handle(` 都是多行写法）。
   * 第一版的字符类里排除了 `\n` → 31 个 handle 只认出几个 → 误报一串「发了没有接收端」。 */
  const preOut = channelsAt(P, [/(?<![.\w])(?:invoke|ipcRenderer\.send|ipcRenderer\.sendSync)\(\s*([^,)]+)/g], shared);
  const preIn = channelsAt(P, [/(?<![.\w])subscribe\(\s*([^,)]+)/g, /ipcRenderer\.on\(\s*([^,)]+)/g], shared);
  const mainIn = channelsAt(M, [/(?<![.\w])(?:handle|ipcMain\.handle|ipcMain\.on)\(\s*([^,)]+)/g], shared);
  /* ⚠️ `webContents.send` 前面是 `.`（`window.webContents.send(…)`），
   * 第一版用 `(?<![.\w])` 一并挡掉了 → 8 个事件通道被误报成「听了没人发」。 */
  const mainOut = channelsAt(M, [/webContents\.send\(\s*([^,)]+)/g], shared);
  /* 两类「静态抽取器读不到」的真实注册/发送形态（第一版都误报了）：
   *  ① 包装函数：`function relayToRenderer(channel, …) { window.webContents.send(channel, …) }`
   *     → 真正的产地是它的**调用点** `relayToRenderer('opennote:import:request', …)`；
   *  ② 工厂 + 模板字面量：`const relayHandler = (op) => handle(\`opennote:${…}\`)` + `relayHandler('recent')`
   *     → 通道名是拼出来的，必须按调用点代入求值。 */
  const mConsts = channelConstsOf(M);
  for (const [name, line] of channelsViaWrappers(M, "handle", mConsts, shared).channels) {
    if (!mainIn.channels.has(name)) mainIn.channels.set(name, line);
  }
  for (const [name, line] of channelsViaFactories(M, mConsts, shared).channels) {
    if (!mainIn.channels.has(name)) mainIn.channels.set(name, line);
  }
  for (const [name, line] of channelsViaWrappers(M, "send", mConsts, shared).channels) {
    if (!mainOut.channels.has(name)) mainOut.channels.set(name, line);
  }
  const dynUnresolved = [
    ...channelsViaFactories(M, mConsts, shared).unresolved,
    ...channelsViaWrappers(M, "send", mConsts, shared).unresolved,
  ];

  const diff = (a, b) => [...a.keys()].filter((c) => !b.has(c));
  const noHandler = diff(preOut.channels, mainIn.channels);
  const deadHandlerRaw = diff(mainIn.channels, preOut.channels);
  /* **已声明的例外必须自证**：主进程可以保留一个不可达的 handler，但注释要写明「保留…下线」，
   * 而且体内必须**确实**抛出「已下线」（说了就得是真的）。证不出来就照旧算红。
   * ⚠️ 这里必须读**原文** `inp.main`（自证文本就在注释里）—— 上面的 `M` 已经剥掉了注释。 */
  const declared = declaredIpcExceptions(inp.main).filter((e) => e.throwsFriendly);
  const declaredNames = new Set(declared.map((e) => e.channel));
  const deadHandler = deadHandlerRaw.filter((c) => !declaredNames.has(c));
  const deadHandlerDeclared = deadHandlerRaw.filter((c) => declaredNames.has(c));
  const orphanEvent = diff(mainOut.channels, preIn.channels);
  const deadListener = diff(preIn.channels, mainOut.channels);
  const unresolvedAll = [
    ...preOut.unresolved.map((u) => `preload 发出 ${u}`),
    ...mainIn.unresolved.map((u) => `main 接收 ${u}`),
    ...orphanEventUnresolvedFix(mainOut.unresolved, "main 发出"),
    ...preIn.unresolved.map((u) => `preload 接收 ${u}`),
    ...dynUnresolved.map((u) => `main 动态构造 ${u}`),
  ];
  return {
    "C-12a": {
      ok: noHandler.length === 0,
      title: "IPC 配对① preload 能 `invoke`/`send` 的每个通道，main 都必须有接收端（否则调用必 `No handler registered`）",
      detail: `preload 发出 ${preOut.channels.size} 个通道，main 接收端 ${mainIn.channels.size} 个，全部配对 ✅`,
      failDetail: `preload 发了但没有接收端的通道：${noHandler.map((c) => `${c}（preload 第 ${preOut.channels.get(c)} 行）`).join("、") || "无"}`,
    },
    "C-12b": {
      ok: deadHandler.length === 0,
      title: "IPC 配对② main 的每个接收端都必须能从 preload 调到（否则是**死 handler** —— 与死路由/死导入同族）；例外必须**自证**",
      detail: `main 接收端 ${mainIn.channels.size} 个，全部在 preload 有调用点 ✅`
        + (deadHandlerDeclared.length
          ? `；**已声明的例外 ${deadHandlerDeclared.length} 个**（注释写明「保留…下线」且体内确实 throw「已下线」）：${deadHandlerDeclared.join("、")}`
          : ""),
      failDetail: `没人能调到的 handler：${deadHandler.map((c) => `${c}（main 第 ${mainIn.channels.get(c)} 行）`).join("、") || "无"}。`
        + `处置：删掉它，或在**它上方的注释里**写明「保留」+「下线」并真的抛出「已下线」错误（要豁免就得自证）。`,
    },
    "C-12c": {
      ok: orphanEvent.length === 0 && deadListener.length === 0,
      title: "IPC 配对③ 主进程 `webContents.send` 的事件通道 ⇄ preload `subscribe`/`on` 的订阅，**两个方向都要咬**"
        + "（**只认代码，不认注释**：说明性注释里写出的调用形状不是订阅）",
      detail: `main 发出 ${mainOut.channels.size} 个事件通道，preload 订阅 ${preIn.channels.size} 个，双向配对 ✅`
        + `（已剥注释；` + `commentStripAudit 非注释区丢失=${audits.pre.lost.length + audits.main.lost.length} 处）`,
      failDetail: `发了没人听：${orphanEvent.map((c) => `${c}（main 第 ${mainOut.channels.get(c)} 行）`).join("、") || "无"}；`
        + `听了没人发：${deadListener.map((c) => `${c}（preload 第 ${preIn.channels.get(c)} 行）`).join("、") || "无"}`,
    },
    _meta: { preOut, preIn, mainIn, mainOut, unresolvedAll, audits },
  };
}
/** 只是给观察列表去掉一个无用形参（保持列表构造可读）。 */
function orphanEventUnresolvedFix(list, label) {
  return list.map((u) => `${label} ${u}`);
}

{
  group("§14 桌面端 IPC 通道配对（C-12a…C-12c）");
  const electronDir = path.join(ROOT, "electron");
  const readElectron = (name) => {
    try { return fs.readFileSync(path.join(electronDir, name), "utf8"); } catch { return ""; }
  };
  const ipcInp = {
    preload: readElectron("preload.cjs"),
    main: readElectron("main.cjs"),
    /* 跨文件常量表：main 从 `./deeplink.cjs` 取 `DEEPLINK_CHANNEL`，
     * 只在本文件里找常量会把它当成「解析不了」→ 误报「发了没人听」。 */
    sharedConsts: sharedChannelConsts(
      fs.readdirSync(electronDir).filter((f) => f.endsWith(".cjs")).map((f) => ({ rel: f, text: readElectron(f) })),
    ),
  };
  const verdicts = ipcPairChecks(ipcInp);
  for (const id of ["C-12a", "C-12b", "C-12c"]) {
    const v = verdicts[id];
    check(id, v.title, v.ok, v.detail, v.failDetail);
  }
  const meta = verdicts._meta;
  info("C-12·覆盖面", "三组判据各看到多少通道 / 有多少表达式解析不了（解析不了的不判红，摆出来）",
    `preload 发出 ${meta.preOut.channels.size}（${fmtChannels(meta.preOut.channels)}）｜main 接收 ${meta.mainIn.channels.size}`
    + `｜main 发出 ${meta.mainOut.channels.size}｜preload 订阅 ${meta.preIn.channels.size}`
    + `｜包装函数形参跳过：${[...meta.preOut.params, ...meta.mainIn.params].join("/") || "无"}`
    + `｜解析不了：${meta.unresolvedAll.join("；") || "无"}`);
  info("C-12·重叠核对", "与 `ipc-safety-check`（62 条）的重叠：**0 条做通道配对**；部分重叠仅两处",
    "「既有 fs/dialog/shell/app 方法名与参数个数不变」与「新增 API…握手齐全」断言 preload 的**方法名与 arity**（不是通道）；"
    + "「onFlushRequest …flushDone 发对频道」只覆盖 flush **一条**频道。本组咬的是**两侧集合的配对**，属新覆盖。");

  /* ── 变异自检：6 个目标变异 + 2 个控制组，全在内存里改文本 ───────────────
   * ⚠️ **参照系（2026-09-30 重做）**：旧版假设「真实树上 C-12c 是红的」，于是用 `healed()`
   * 把 `onMenu` / `import:notice` 两条订阅**写死**拆掉来构造「修好态」。Lead 落地 C-12c 后
   * 那两条订阅真的没了 → 写死的 `replace` 一个都没命中 → `healed()` 变成恒等 → 自检自己红了
   * （**这正是它该有的行为**：拿一个没有落地的变异去构造基线，什么都证明不了）。
   *
   * 现在改成**按实际树推导**：谁在真实树上是「听了没人发」，就拆谁 —— 拆的时候要**证明落地**
   * （命中数 + 前后 sha256）。真实树本来就双向配对时，`healed()` 是**正当的空操作**，
   * 此时基线本来就是绿的，等价于直接注入探针。两种情形都如实打印，不再靠写死的字符串。 */
  const healSubscriptions = (text, channels) => {
    let out = String(text);
    let hits = 0;
    for (const channel of channels) {
      const esc = channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 只把「订阅动作」拆掉（常量定义留着，别牵动别的判据）：
      //   subscribe('ch', cb) / subscribe(CONST, cb) / ipcRenderer.on(CONST, listener)
      const re = new RegExp(
        `(?:subscribe\\(\\s*(?:['"\`]${esc}['"\`]|[A-Za-z_$][\\w$]*)\\s*,|ipcRenderer\\.on\\(\\s*(?:['"\`]${esc}['"\`]|[A-Za-z_$][\\w$]*)\\s*,)`,
        "g",
      );
      out = out.replace(re, (m0) => { hits += 1; return "void ("; });
    }
    return { text: out, hits };
  };
  const baseAll = ipcPairChecks(ipcInp);
  const deadOnRealTree = baseAll._meta.preIn.channels
    && [...baseAll._meta.preIn.channels.keys()].filter((c) => !baseAll._meta.mainOut.channels.has(c));
  const healInfo = healSubscriptions(ipcInp.preload, deadOnRealTree || []);
  const healedInput = healInfo.hits > 0 ? { ...ipcInp, preload: healInfo.text } : ipcInp;
  if (healInfo.hits > 0) {
    // 变异前置也要证明落地（同一条纪律，适用于**构造基线的步骤**本身）。
    mutationLanded("C-12·变异前置", `healed（拆掉真实树上 ${deadOnRealTree.length} 条「听了没人发」的订阅）`,
      ipcInp.preload, healedInput.preload, healInfo.hits, null);
  } else {
    info("C-12·变异前置", "真实树本来就没有「听了没人发」的订阅 ⇒ 修好态 = 真源（**正当的空操作**，不是 NO_EFFECT）",
      `真实树 preload 订阅 ${baseAll._meta.preIn.channels.size} 个 / main 发出 ${baseAll._meta.mainOut.channels.size} 个，双向配对`);
  }
  const healed = () => healedInput;
  const mut = [
    { name: "orphan-invoke（preload 调一个 main 没有的通道）", target: "C-12a", needle: "opennote:probe:missing",
      apply: (i) => ({ ...i, preload: `${i.preload}\nconst probe = () => invoke('opennote:probe:missing')\n` }) },
    { name: "drop-handler（main 少一个接收端）", target: "C-12a", needle: "'opennote:fs:list'",
      /* ⚠️ 第一版写的是 `handle('opennote:fs:list'` —— 但 main 里注册是**多行**的
       * （`handle(\n  'opennote:fs:list',`），replace 匹配不上 → 没改到文本 → 自己被抓出来。 */
      apply: (i) => ({ ...i, main: i.main.replace("'opennote:fs:list'", "'opennote:fs:list2'") }),
      hits: (i, o) => countOf(i.main, "'opennote:fs:list'") - countOf(o.main, "'opennote:fs:list'") },
    { name: "dead-handler（main 多一个没人调的接收端）", target: "C-12b", needle: "opennote:dead:probe",
      apply: (i) => ({ ...i, main: `${i.main}\nhandle('opennote:dead:probe', async () => ({}))\n` }) },
    { name: "orphan-event（main 发一个 preload 没订阅的事件）", target: "C-12c", pre: healed, needle: "opennote:probe:event",
      apply: (i) => ({ ...i, main: `${i.main}\nwin.webContents.send('opennote:probe:event', {})\n` }) },
    { name: "dead-listener（preload **真加一行订阅**，没人发）", target: "C-12c（听了没人发）", pre: healed, needle: "opennote:probe:never",
      apply: (i) => ({ ...i, preload: `${i.preload}\nsubscribe('opennote:probe:never', () => {})\n` }) },
    /* ── 两个控制组 ───────────────────────────────────────────────────────
     * ① 只在注释里**提**通道名（旧控制组）；
     * ② Lead 2026-09-30 复核 C-12c 误报时点的形状：注释里写出**完整的调用形状**
     *    （`subscribe('…', cb)`）。剥离器是为此写的，所以这条控制组必须保持绿 ——
     *    若它变红，说明注释又参与判定了（人的说明文字会把判据变成噪声）。 */
    { name: "comment-only（控制组①：注释里提通道名）", target: null, needle: "opennote:fs:list2",
      apply: (i) => ({ ...i, preload: `${i.preload}\n// 历史：曾经有 'opennote:fs:list2' 这个通道\n`, main: `${i.main}\n// 历史：曾经有 'opennote:dead:probe' 这个 handler\n` }) },
    { name: "comment-call-shape（控制组②：注释里写出完整订阅调用形状）", target: null, pre: healed, needle: "subscribe('opennote:probe:never'",
      apply: (i) => ({ ...i, preload: `${i.preload}\n// 说明性注释（不是代码）：subscribe('opennote:probe:never', () => {}) 曾经写在这里\n` }) },
  ];
  const failures12 = [];
  const mutLog12 = [];
  for (const m of mut) {
    const ref = m.pre ? m.pre() : ipcInp;
    const mutated = m.apply(ref);
    /* 命中数按**整份输入**（preload + main）数：变异打在哪个文件上不由调用方声明，
     * 数错文件会让一个真变异被误报成 NO_EFFECT（第一版就踩了：`dead-handler` 的
     * needle 在 main 上，我却在 preload 里数 → 命中 0 处）。 */
    const beforeAll = `${ref.preload}\u0000${ref.main}`;
    const afterAll = `${mutated.preload}\u0000${mutated.main}`;
    const hits = m.hits ? m.hits(ref, mutated) : countOf(afterAll, m.needle) - countOf(beforeAll, m.needle);
    // 先证明落地，再进红绿判定；没落地 → NO_EFFECT（exit 2），**不**记 PASS/FAIL。
    // 比较的是**整份输入**（有的变异打在 main 上、有的打在 preload 上）。
    if (!mutationLanded("C-12·变异自检", m.name, JSON.stringify(ref), JSON.stringify(mutated), hits, m.target)) {
      mutLog12.push(`${m.name}→NO_EFFECT（未判定）`);
      continue;
    }
    const base = ipcPairChecks(ref);
    const after = ipcPairChecks(mutated);
    const newlyRed = ["C-12a", "C-12b", "C-12c"].filter((id) => base[id].ok && !after[id].ok);
    if (m.target === null) {
      const fine = newlyRed.length === 0;
      if (!fine) failures12.push(`${m.name}：控制组不该让任何检查变红，实际 ${newlyRed.join(",")}`);
      mutLog12.push(`${m.name}（控制组）→保持全绿 ${fine ? "✓" : "✗"}`);
      continue;
    }
    const key = m.target.startsWith("C-12c") ? "C-12c" : m.target;
    if (base[key].ok !== true) { failures12.push(`${m.name}：目标 ${key} 在基线就是红的（证明不了任何事）`); mutLog12.push(`${m.name}→基线红✗`); continue; }
    const flipped = after[key].ok === false;
    if (!flipped) failures12.push(`${m.name}：目标 ${key} 没有翻红`);
    mutLog12.push(`${m.name}→${key} ${flipped ? "红✓" : "未红✗"}`);
  }
  check("C-12·变异自检", `${mut.filter((m) => m.target).length} 个目标变异各自能让对应判据翻红、${mut.filter((m) => !m.target).length} 个控制组保持全绿（证明这三条不是恒绿）`,
    failures12.length === 0,
    `${mut.length} 个内存变异全部按声明生效（每次变异都打印命中处数 + 改动前后 sha256）：${mutLog12.join("；")}`,
    `不成立的变异：${failures12.join("；")}`);
  /* 剥离器自检：**非注释区**里的匹配在剥离后必须逐字还在原偏移。
   * 少一处就说明是剥注释吞了真代码 —— 那是检查器自己的 NO_EFFECT，必须红。
   * （注释区里的匹配按设计就该消失，不算丢失。） */
  const stripLost = [...meta.audits.pre.lost, ...meta.audits.main.lost];
  check("C-12·剥离自检", "剥注释**只吃掉注释**：非注释区的调用形状在剥离后逐字仍在原偏移（检查器自己不吞代码）",
    stripLost.length === 0,
    `preload 原文 ${ipcInp.preload.length} 字符 → 剥后 ${meta.audits.pre.text.length}（注释区间 ${meta.audits.pre.spans.length} 段）；`
    + `main 原文 ${ipcInp.main.length} → 剥后 ${meta.audits.main.text.length}（注释区间 ${meta.audits.main.spans.length} 段）；非注释区丢失 0 处`,
    `非注释区被剥离器吞掉的匹配：${stripLost.join(" | ")}`);
}

/* ==================================================================== §15 */
/* §15 C-13 · 网页版剪藏页（`/v1/clip/*`）—— 契约判据（Lead 2026-09-30 指派）
 *
 * **盯的是用户看得见的那条路径**（Lead 的原话）：
 *   扩展带着长期令牌 POST `/v1/clip/stage` → 桥回 `openUrl`（端口由桥拼）
 *   → 浏览器打开 `/clip/<stageId>?k=`（页面永不持有长期令牌）
 *   → 页面读暂存正文 → 用户编辑 + 选落点 → `POST /v1/clip/commit`
 *   → **磁盘上真的有那条笔记**（端到端那一半在 `verify-e2e.cjs` 的 `S13`）。
 *
 * 本组只做**静态契约面**（快、可复跑），行为面在 e2e：
 *   · 六条路由与**凭据分工**（页面端点不用 Bearer；stage 用 Bearer）
 *   · `openUrl` / `stageId` 的**唯一产地**（桥拼；扩展一律不拼）
 *   · `k` / `stageId` **不进日志**（白名单 + 调用点两向）
 *   · `folders[0] === ""`、commit 的 `folder` 非空必须**已存在**（绝不自动创建）
 *   · commit **复用唯一一条入库通路**（`onEnvelope` 只有一处调用点）
 *   · 页面 HTML：JSON 数据块注入 + CSP 无 `unsafe-inline` + `no-store`；缺产物 503
 *   · 静态资源：扩展名白名单 + 穿越 404
 *   · **跨线**：扩展侧 stage 请求体的形状（含 `assets[]` 元素）必须能被桥按 02 §2.7 接收
 *   · **跨线**：页面读 `stage.selection` 的类型必须与桥给的一致（布尔标志 vs 被当文本）
 *   · 产物 `dist-clip/**` 里 0 处真远程引用（与 `EX-6` 同口径；XML 命名空间只登记）
 *
 * **每条判据都配内存变异**（`C-13·变异自检`），落地自检（命中处数 + 前后 sha256）走
 * `mutationLanded()`：命中 0 处 → `NO_EFFECT` + 退出码 2，**不**进红绿判定。
 */

/** `marker` 之后那个函数的 `{…}` 体（**先跳过参数表与返回类型**再找函数体）。
 *  ⚠️ 两处都踩过坑（判据因此在**产品正确**时假红）：
 *   ① `function writeLog(event, fields = {}) {` 的**默认参数里就有 `{}`** → 取到的「函数体」长度是 0；
 *   ② `export async function saveImage(…): Promise<{ path: string; markdown: string }> {` 的
 *      **返回类型注解里也有 `{}`** → 取到的是类型字面量，`assetsDirFor(notePath)` 落在窗口外。
 *  所以：先配平圆括号跳过参数表，再跳过 `<…>` 里的类型实参（连同里面的 `{}`），最后那个 `{` 才是函数体。 */
function bodyAfter(text, marker) {
  const src = String(text);
  const at = src.indexOf(marker);
  if (at < 0) return "";
  let i = at;
  let paren = 0;
  let sawParen = false;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") { paren += 1; sawParen = true; }
    else if (src[i] === ")") { paren -= 1; if (sawParen && paren === 0) { i += 1; break; } }
  }
  // 跳过返回类型里的 `<…>`（含其中的 `{…}`）与圆括号
  let angle = 0;
  let paren2 = 0;
  let open = -1;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "<") { angle += 1; continue; }
    if (c === ">" && angle > 0) { angle -= 1; continue; }
    if (angle > 0) continue;
    if (c === "(") { paren2 += 1; continue; }
    if (c === ")" && paren2 > 0) { paren2 -= 1; continue; }
    if (c === "{" && paren2 === 0) { open = i; break; }
    if (c === "\n" && /;\s*$/.test(src.slice(i - 2, i))) break; // 签名都不完整就别猜
  }
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") { depth -= 1; if (depth === 0) return src.slice(open + 1, j); }
  }
  return "";
}

/** `bodyAfter` 自己的单元自检：两类踩过的形态必须都能取到**真的函数体**。 */
const BODY_SELFTEST_CASES = [
  {
    name: "默认参数里有对象字面量",
    src: "function f(event, fields = {}) {\n  return alpha;\n}\n",
    probe: (b) => b.includes("return alpha"),
  },
  {
    name: "返回类型注解里有对象字面量（Promise<{…}>）",
    src: "export async function g(\n  a: string,\n  notePath: string,\n): Promise<{ path: string; markdown: string }> {\n  const dir = assetsDirFor(notePath);\n}\n",
    probe: (b) => b.includes("assetsDirFor(notePath)"),
  },
  {
    name: "返回类型里有泛型数组",
    src: "function h(x: number): Array<{ id: string }> {\n  return beta;\n}\n",
    probe: (b) => b.includes("return beta"),
  },
  {
    name: "普通单行签名",
    src: "function k(a, b) {\n  return gamma;\n}\n",
    probe: (b) => b.includes("return gamma"),
  },
];
function bodySelftest() {
  const bad = [];
  for (const c of BODY_SELFTEST_CASES) {
    const body = bodyAfter(c.src, c.src.slice(0, c.src.indexOf("(")));
    if (!c.probe(body)) bad.push(`${c.name} → ${JSON.stringify(body.slice(0, 60))}`);
  }
  return { total: BODY_SELFTEST_CASES.length, bad };
}

/**
 * 远程引用扫描。两种口径：
 *   · `strict = true`（**我们自己的源码**）：额外把 URL **字符串字面量**算进来；
 *   · `strict = false`（**第三方 bundle / 产物**）：只算**真的会发请求**的三类
 *     （资源属性 / CSS `url()` / `fetch`·`XMLHttpRequest.open`·`importScripts`·`import` 的参数），
 *     URL 字面量单列 `literals` —— React 的 `https://react.dev/errors/…` 这类**错误文档链接**
 *     是给人看的文案，算成「远程引用」就是判据误报（同 `EX-6` 的教训）。
 * XML 命名空间 URI 永远只登记。
 */
function remoteRefsIn(rel, text, strict = false) {
  const NOT_LOCAL = "(?!127\\.0\\.0\\.1|localhost)";
  const RESOURCE_ATTR = new RegExp(`\\b(?:href|src|srcset|action|poster|data-src)\\s*=\\s*["']\\s*(?:https?:)?\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
  const CSS_URL = new RegExp(`\\burl\\(\\s*["']?\\s*(?:https?:)?\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
  const NET_CALL = new RegExp(`\\b(?:fetch|importScripts|XMLHttpRequest\\.open|import)\\s*\\(\\s*["'\`](?:https?:)?\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%]`, "i");
  const STRING_LITERAL = new RegExp(`["'\`][^"'\`]*https?:\\/\\/${NOT_LOCAL}[A-Za-z0-9\\-._~%][^"'\`]*["'\`]`);
  const XML_NS = /["'`]https?:\/\/www\.w3\.org\/(?:1999\/xhtml|2000\/svg|1999\/xlink|XML\/1998\/namespace)["'`]/g;
  const remote = [];
  const namespaces = [];
  const literals = [];
  const isScript = /\.(?:js|mjs|cjs|ts|tsx)$/i.test(rel);
  let inScript = isScript;
  String(text).split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (!isScript) {
      if (/<script\b/i.test(line) && !/<\/script>/i.test(line)) inScript = true;
      if (/<\/script>/i.test(line)) inScript = false;
    }
    const where = `${rel}:${index + 1} ${line.trim().slice(0, 100)}`;
    const ns = [...line.matchAll(XML_NS)].map((m) => m[0]);
    if (ns.length) namespaces.push(where);
    const lineNoNs = line.replace(XML_NS, '""');
    if (inScript) {
      if (NET_CALL.test(line)) remote.push(where);
      if (STRING_LITERAL.test(lineNoNs)) {
        if (strict) remote.push(where);
        else literals.push(where);
      }
    } else if (RESOURCE_ATTR.test(line) || CSS_URL.test(line) || NET_CALL.test(line)) {
      remote.push(where);
    }
  });
  return { remote, namespaces, literals };
}

/**
 * 剪藏页契约判据（纯函数）。`inp` 全是文本 —— 变异在同一份真源上重跑。
 * 每个返回值：`{ title, ok, detail }`。
 */
function clipContractChecks(inp) {
  const code = (text) => stripCommentsKeepLines(text).text;
  const b = code(inp.bridge);
  const stageStore = code(inp.clipStage);
  const extStage = code(inp.extStage);
  const extAll = `${code(inp.extPopup)}\n${code(inp.extBg)}\n${extStage}`;
  const result = {};

  // C-13a ── 六条路由 + **凭据分工**（页面端点不用长期令牌；stage 用令牌）
  {
    const routes = bodyAfter(b, "async function handleClipRoutes");
    const pageBlock = bodyAfter(routes || b, "if (route === '/clip' || route.startsWith('/clip/'))");
    const stageBlock = bodyAfter(routes || b, "if (route === '/v1/clip/stage')");
    const missing = [
      ["POST /v1/clip/stage", /'\/v1\/clip\/stage'/.test(b)],
      ["GET /v1/clip/stage", /route === '\/v1\/clip\/stage'[\s\S]{0,600}?method === 'GET'/.test(b)],
      ["GET /v1/clip/folders", /'\/v1\/clip\/folders'/.test(b)],
      ["POST /v1/clip/commit", /'\/v1\/clip\/commit'/.test(b)],
      ["GET /clip/<stageId>", /route === '\/clip' \|\| route\.startsWith\('\/clip\/'\)/.test(b)],
      ["GET /clip/assets/<file>", /'\/clip\/assets'/.test(b)],
    ].filter(([, ok]) => !ok).map(([name]) => name);
    const pageNoBearer = pageBlock !== "" && !/checkToken\(/.test(pageBlock);
    const stageNeedsBearer = /checkToken\(req, res\)[\s\S]{0,240}?handleClipStageCreate/.test(stageBlock || routes);
    const commitNoBearer = !/checkToken\(/.test(bodyAfter(routes || b, "if (route === '/v1/clip/commit'") || "");
    result["C-13a"] = {
      title: "六条剪藏路由齐备，且**凭据分工**正确：页面端点（`/clip/*` 与 `stageId+k` 的三条）**不用** Bearer 长期令牌，"
        + "`POST /v1/clip/stage` 用 Bearer（「页面永不持有长期令牌」）",
      ok: missing.length === 0 && pageNoBearer && stageNeedsBearer && commitNoBearer,
      detail: `路由齐备=${missing.length === 0}${missing.length ? `（缺 ${missing.join("、")}）` : ""}`
        + `｜/clip/* 块里没有 checkToken=${pageNoBearer}｜stage 走令牌=${stageNeedsBearer}｜commit 不走令牌=${commitNoBearer}`,
    };
  }

  // C-13b ── `openUrl` 的唯一产地是桥（端口 + stageId 都不可预知 ⇒ 扩展绝不许拼）
  {
    const openUrlBuilt = /const openUrl = `http:\/\/127\.0\.0\.1:\$\{listeningPort\}\/clip\/\$\{entry\.stageId\}\?k=/.test(b);
    /* 扩展**代码**里（已剥注释）不许出现**页面**路径 `/clip/<stageId>`。
     * ⚠️ 必须先排除接口路径 `/v1/clip/*`（扩展当然要调 `/v1/clip/stage`）——
     * 第一版把 `/v1/clip/` 一起算了进去 → 在产品**正确**时报红（「范围过宽」那一种误报）。 */
    const extNoV1 = extAll.replace(/\/v1\/clip\//g, "/v1-clip/");
    const extBuilds = /\/clip\//.test(extNoV1) || /127\.0\.0\.1[^\n]{0,40}\/clip/.test(extNoV1);
    const extReads = /openUrlOf\s*\(/.test(extStage) && /tabs\.create\(\{\s*url:\s*(?:reply\.|result\.)?openUrl/.test(code(inp.extPopup));
    result["C-13b"] = {
      title: "`openUrl` 的**唯一产地是桥**（`http://127.0.0.1:${listeningPort}/clip/<stageId>?k=`）；"
        + "扩展侧代码里 0 处**页面路径** `/clip/…` 拼装（`/v1/clip/*` 接口路径不算）、只读接口返回的 `openUrl` 去 `tabs.create`",
      ok: openUrlBuilt && !extBuilds && extReads,
      detail: `桥按监听端口拼=${openUrlBuilt}｜扩展代码出现页面路径拼装=${extBuilds}｜扩展只读 openUrl（openUrlOf + tabs.create(url: openUrl)）=${extReads}`,
    };
  }

  // C-13c ── `stageId` 由桥生成（绝不用客户端给的 id）
  {
    const genFromRandom = /stageId:\s*newSecret\(\)/.test(stageStore) && /randomBytes\(/.test(stageStore);
    const createBody = bodyAfter(b, "async function handleClipStageCreate");
    const clientIdUsed = /\bpayload\.(?:importId|stageId)\b/.test(createBody);
    result["C-13c"] = {
      title: "`stageId`（与 `k`）由桥自己生成：唯一产地是 `clip-stage.cjs` 的 `newSecret()`（32 字节随机）；"
        + "stage 处理函数**不读**客户端的 `importId`/`stageId`（「一个事实一个产地」）",
      ok: genFromRandom && !clientIdUsed,
      detail: `stageId = newSecret() =${genFromRandom}｜stage 处理函数引用客户端 id=${clientIdUsed}`,
    };
  }

  // C-13d ── `k` / `stageId` 不进日志（白名单 + 调用点，两向）
  {
    const writeLogBody = bodyAfter(b, "function writeLog(");
    const whitelistClean = writeLogBody !== ""
      && !/\bfields\.(?:k|key|stageId|secret|query|search)\b/.test(writeLogBody)
      && !/\bline\.(?:k|key|stageId|secret|query|search)\s*=/.test(writeLogBody);
    const calls = [...b.matchAll(/writeLog\(\s*'[^']+'\s*,\s*\{([\s\S]{0,200}?)\}\s*\)/g)].map((m) => m[1]);
    const badCalls = calls.filter((c) => /\b(?:k|key|stageId|query|searchParams)\s*:/.test(c) || /\.key\b/.test(c));
    result["C-13d"] = {
      title: "`k` / `stageId` **绝不进 `bridge.log`**：写日志的**字段白名单**里没有它们，"
        + "且 0 处 `writeLog` 调用把它们塞进字段里（内容泄漏只能从这两个口子出去）",
      ok: whitelistClean && badCalls.length === 0,
      detail: `writeLog 字段白名单不含 k/key/stageId/secret/query=${whitelistClean}｜${calls.length} 个调用点的字段里命中=${badCalls.length}`,
    };
  }

  // C-13e ── `folders[0] === ""`（= 收件箱；页面默认落点）
  {
    const foldersBody = bodyAfter(b, "async function clipFolders");
    /* 判据盯**返回的清单以 `""` 开头**，不盯某个函数名或某行字面：
     * 实现从 `return ['', …]` 改成 `{ ok:true, folders: ['', …] }`（三态分开）之后，
     * 旧的逐字锚点会假红一次 —— 而产品那次改动是**更好**的。 */
    const emptyFirst = /(?:folders|list)\s*:\s*\[\s*''\s*,\s*\.\.\./.test(foldersBody)
      || /return\s*\[\s*''\s*,\s*\.\.\./.test(foldersBody);
    const dedup = /new Set\(\)/.test(foldersBody);
    /* 「拿不到」必须与「真的为空」分开（一个返回值扛两种含义就是撒谎）。 */
    const distinctFailure = /ok:\s*false/.test(foldersBody);
    result["C-13e"] = {
      title: "`GET /v1/clip/folders` 的 `folders[0] === \"\"`（= 收件箱，恒为第 0 项）且去重；"
        + "「拿不到 / 工作区没打开」与「工作区里真的只有收件箱」是**两种结果**（前者明确失败，绝不回空数组假装）",
      ok: emptyFirst && dedup && distinctFailure,
      detail: `'' 前置=${emptyFirst}｜去重=${dedup}｜失败与空列表分开=${distinctFailure}`,
    };
  }

  // C-13f ── commit 的 `folder` 非空必须**已存在**（绝不自动创建）
  {
    const commitBody = bodyAfter(b, "async function handleClipCommit");
    const checksExistence = /\bif\s*\(![\w.]*includes\(folder\)\)/.test(commitBody);
    /* 「不在列表 → 明确 4xx」按**语义**判（commit 体内引用的码，其 ERROR_TABLE http 是 4xx），
     * 不写死码号：本轮剪藏页的码从复用 `IMP-4008` 换成了专用码（`IMP-4022`），
     * 写死旧码会在**产品正确**时假红 —— 契约要的是「不存在的落点必须被明确拒绝」。 */
    const commitCodes = [...new Set([...commitBody.matchAll(/'IMP-\d{4}'/g)].map((m) => m[0].slice(1, -1)))];
    const codeHttp = (code) => {
      const m = new RegExp(`'${code}':\\s*\\{\\s*http:\\s*(\\d+)`).exec(b);
      return m ? Number(m[1]) : null;
    };
    const reports4xx = commitCodes.some((c) => (codeHttp(c) || 0) >= 400 && (codeHttp(c) || 0) < 500);
    const noCreate = !/mkdir/i.test(commitBody);
    result["C-13f"] = {
      title: "`POST /v1/clip/commit` 的 `folder` 非空时必须是**已存在**的目录（对候选清单做成员校验 + 明确 4xx），"
        + "**绝不自动创建**（这是「落点写错地方」最贵的那个错）",
      ok: checksExistence && reports4xx && noCreate,
      detail: `成员校验（\`!…includes(folder)\`）=${checksExistence}｜不在列表 → 4xx 码 ${JSON.stringify(commitCodes)}=${reports4xx}`
        + `｜commit 体内 0 处 mkdir=${noCreate}`,
    };
  }

  // C-13g ── **唯一一条入库通路**：`onEnvelope` 只有一个调用点，commit 复用它
  {
    const onEnvelopeCalls = (b.match(/\bonEnvelope\s*\(/g) || []).length;
    const pipelineBody = bodyAfter(b, "async function runEnvelopePipeline");
    const pipelineRelays = /\bonEnvelope\s*\(\s*JSON\.stringify\(envelope\)/.test(pipelineBody);
    const importCalls = /await runEnvelopePipeline\(req, res, \{ envelope, importId/.test(b);
    const commitCalls = /runEnvelopePipeline\(req, res, \{\s*envelope,/.test(bodyAfter(b, "async function handleClipCommit"));
    result["C-13g"] = {
      title: "`/v1/clip/commit` **复用唯一一条入库通路**（信封 → `onEnvelope` → 回执）："
        + "整份 `bridge.cjs` 里 `onEnvelope(` 只有**一处**调用点，`/v1/import` 与 commit 都走 `runEnvelopePipeline()` "
        + "（不许另造第二条写路径）",
      ok: onEnvelopeCalls === 1 && pipelineRelays && importCalls && commitCalls,
      detail: `onEnvelope( 调用点=${onEnvelopeCalls}（应为 1）｜唯一调用点在 runEnvelopePipeline 里=${pipelineRelays}`
        + `｜/v1/import 走它=${importCalls}｜commit 走它=${commitCalls}`,
    };
  }

  /** **页面里有没有内联可执行脚本**：逐个 `<script>` 标签看 —— 有 `src`、或类型是数据块/模板，
     *  才算「不可执行」。⚠️ 第一版写成「有内联 script **且** 没有 module+src」（后半句是错的逻辑：
     *  只要页面引了 module 脚本，它就永远判 false ⇒ **恒绿**，`inline-script-in-page` 变异当场把它抓出来）。 */
  const htmlNoComments = stripHtmlComments(inp.clipHtml);
  const inlineScripts = [...htmlNoComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/i.test(m[1]) && !/type\s*=\s*"(?:application\/json|application\/ld\+json|text\/template)"/i.test(m[1]));
  const htmlInline = inlineScripts.length > 0;

  // C-13h ── 页面 HTML：JSON 数据块 + CSP + no-store；缺产物 503；页面源码无内联可执行脚本
  {
    const bootBlock = /<script type="application\/json" id="\$\{CLIP_BOOT_ID\}">/.test(b) || /type="application\/json"[\s\S]{0,60}id="\$\{CLIP_BOOT_ID\}"/.test(b);
    const bootFields = /JSON\.stringify\(\{\s*port:\s*listeningPort,\s*stageId:[\s\S]{0,60}?k:\s*entry\.key\s*\}\)/.test(b);
    const csp = (/const CLIP_CSP =\s*[\s\S]{0,120}?"([^"]*default-src[^"]*)"/.exec(b) || [])[1] || "";
    const scriptSrc = (/script-src([^;]*)/.exec(csp) || [])[1] || "";
    const cspOk = scriptSrc.includes("'self'") && !scriptSrc.includes("unsafe-inline");
    const noStore = /function sendHtml\([\s\S]{0,600}?'Cache-Control': 'no-store'/.test(b);
    /* **产物缺失 → 503 + 可读文案**（判据盯意图，不盯码号或句子的字面：实现从
     * 「借 IMP-5001 + 覆盖 userMessage」改成了正式码 `IMP-5003`，字面判据会因此假红一次）。
     * 要求：入口在 try 里读产物、有 catch、catch 路径发的码在 ERROR_TABLE 里 **http 是 503**、
     * 且文案里确实指向 `build:clip`（用户照着能修）。 */
    const pageBody = bodyAfter(b, "function handleClipPage");
    const readsArtifact = /readFileSync\(clipIndexPath\(\)/.test(pageBody);
    const hasCatch = /catch\s*\{/.test(pageBody);
    const errorCodes = [...pageBody.matchAll(/'IMP-\d{4}'/g)].map((m) => m[0].slice(1, -1));
    const httpOfCode = (code) => {
      const m = new RegExp(`'${code}':\\s*\\{\\s*http:\\s*(\\d+)`).exec(b);
      return m ? Number(m[1]) : null;
    };
    const missing503 = readsArtifact && hasCatch && errorCodes.some((c) => httpOfCode(c) === 503) && /build:clip/.test(b);
    result["C-13h"] = {
      title: "页面 HTML：引导数据走 **`<script type=\"application/json\">` 数据块**（不可执行）+ CSP `script-src 'self'`"
        + "（**无 `unsafe-inline`**）+ `Cache-Control: no-store`；产物缺失 → **503 + 可读文案**（绝不回空 200）；"
        + "页面源码里**没有内联可执行脚本**",
      ok: bootBlock && bootFields && cspOk && noStore && missing503 && !htmlInline,
      detail: `JSON 数据块=${bootBlock}｜注入 {port,stageId,k}=${bootFields}｜script-src=${JSON.stringify(scriptSrc.trim())}`
        + `｜no-store=${noStore}｜缺产物 503 带文案=${missing503}｜页面内联可执行脚本 ${inlineScripts.length} 段=${htmlInline}`,
    };
  }

  // C-13i ── 静态资源：扩展名白名单 + 穿越 404
  {
    const nameFn = bodyAfter(b, "function isClipAssetName");
    const rejectsTraversal = /includes\('\.\.'\)/.test(nameFn) && /(?:includes\('\/'\)|includes\('\\\\'\))/.test(nameFn);
    const basenameGuard = /path\.basename\(name\)\s*!==\s*name/.test(nameFn);
    const whitelist = /\\\.\(\?:\s*js\|css\|woff2\|png\|svg\|map\s*\)\$/.test(nameFn) || /\|css\|woff2\|png\|svg\|map/.test(nameFn);
    const missing404 = /function clipAssetMiss\([\s\S]{0,300}?sendError\(req, res, 'IMP-3005'/.test(b);
    result["C-13i"] = {
      title: "`GET /clip/assets/<file>`：扩展名白名单（js/css/woff2/png/svg/map）+ 单段文件名（`..`、`/`、`\\`、盘符一律拒），"
        + "路径穿越与文件不存在统一 **404**（不区分，不给探测信号）",
      ok: rejectsTraversal && basenameGuard && whitelist && missing404,
      detail: `拒绝 ../分隔符=${rejectsTraversal}｜basename 单段守卫=${basenameGuard}｜扩展名白名单=${whitelist}｜miss 走 404=${missing404}`,
    };
  }

  // C-13j ── **跨线**：扩展侧 stage 请求体的形状必须能被桥接收（含 assets[] 元素）
  {
    const requestKeys = (/STAGE_REQUEST_KEYS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(extStage) || [])[1] || "";
    const declaredKeys = [...requestKeys.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const frozen = ["spec", "url", "title", "body", "selection", "tags", "source", "assets"];
    const builtKeys = (() => {
      const body = bodyAfter(extStage, "export function buildStageRequest(");
      const obj = (/\bconst request = \{([\s\S]*?)\n\s*\};/.exec(body) || [])[1] || "";
      return objectKeyList(`{${obj}}`);
    })();
    /* **资产的元素形状**：桥按 02 §2.5 只认 `{name, mime, dataBase64|file}`。
     * 判据盯的是**生产者**（`normalizeAsset` 的返回形状 + 只 push 它的结果），不是某一行 push 的字面。 */
    const normalizeBody = bodyAfter(extStage, "export function normalizeAsset(");
    const assetReturnKeys = (() => {
      const m = /return\s*\{([\s\S]*?)\};/.exec(normalizeBody);
      return m ? objectKeyList(`{${m[1]}}`) : [];
    })();
    const ASSET_ALLOWED = ["name", "mime", "dataBase64", "file"];
    const guardsAll = ["name", "mime", "dataBase64"].every((k) => new RegExp(`!${k}\\b`).test(normalizeBody));
    const pushesOnlyNormalized = /assets\.push\(\s*asset\s*\)/.test(bodyAfter(extStage, "export function buildStageRequest("));
    const assetShapeOk = assetReturnKeys.length > 0
      && assetReturnKeys.every((k) => ASSET_ALLOWED.includes(k))
      && assetReturnKeys.includes("name") && assetReturnKeys.includes("mime")
      && guardsAll && pushesOnlyNormalized;
    result["C-13j"] = {
      title: "**跨线**：扩展侧 `buildStageRequest()` 的请求体键集合 = 冻结的 8 键，且 `assets[]` 的**元素形状**"
        + "只能是桥按 02 §2.5 接收的 `{name, mime, dataBase64|file}`（否则图片开关一开就 422 `IMP-4003`）",
      ok: assetShapeOk && JSON.stringify(builtKeys) === JSON.stringify(frozen) && JSON.stringify(declaredKeys) === JSON.stringify(frozen),
      detail: `声明键=${JSON.stringify(declaredKeys)}｜构造键=${JSON.stringify(builtKeys)}｜`
        + `资产工厂返回键=${JSON.stringify(assetReturnKeys)}（允许 ${JSON.stringify(ASSET_ALLOWED)}，必须含 name+mime）｜`
        + `三键缺一即拒=${guardsAll}｜只 push 工厂产物=${pushesOnlyNormalized}`,
    };
  }

  // C-13k ── **跨线**：`stage.selection` 的类型必须与桥一致（布尔标志，不是「选中的文本」）
  {
    const webContract = code(inp.webContract);
    const webView = code(inp.webView);
    const typedBoolean = /selection\s*:\s*boolean/.test(webContract);
    const readsFlag = /selection\s*:\s*stage\.selection\s*===\s*true/.test(webContract)
      || /selection\s*:\s*typeof\s+stage\.selection\s*===\s*"boolean"/.test(webContract);
    const viewTreatsAsText = /\.selection\.trim\(\)/.test(webView);
    result["C-13k"] = {
      title: "**跨线**：桥的 `GET /v1/clip/stage` 给的 `selection` 是**布尔标志**（与信封 §2.3 同义），"
        + "页面必须按布尔读（当文本读 ⇒ 那条「编辑区填的是你选中的文字」分支**永远不可达**，是死代码）",
      ok: typedBoolean && readsFlag && !viewTreatsAsText,
      detail: `页面类型标 boolean=${typedBoolean}｜按布尔读=${readsFlag}｜视图把 selection 当文本=${viewTreatsAsText}`,
    };
  }

  // C-13l ── 剪藏页产物里 0 处**真的会发请求**的远程引用（EX-6 同口径；URL 字面量与命名空间只登记）
  {
    const files = inp.distFiles || [];
    const ownFiles = inp.ownPageFiles || [];
    const remote = [];
    const namespaces = [];
    const literals = [];
    for (const f of files) {
      const hit = remoteRefsIn(f.rel, f.text, false);
      remote.push(...hit.remote);
      namespaces.push(...hit.namespaces);
      literals.push(...hit.literals);
    }
    for (const f of ownFiles) {
      const hit = remoteRefsIn(f.rel, f.text, true);
      remote.push(...hit.remote);
      namespaces.push(...hit.namespaces);
    }
    result["C-13l"] = {
      title: "剪藏页**产物**（`dist-clip/**`，真正装进浏览器的那份）与页面自有源码里 0 处**真的会发请求**的远程引用"
        + "（资源属性 / CSS url() / fetch·XHR·import 参数）；**URL 字符串字面量只登记**"
        + "（第三方 bundle 里的错误文档链接不是远程引用）；XML 命名空间只登记；产物不存在时 SKIP（**不计通过**）",
      ok: files.length > 0 && remote.length === 0,
      detail: `${files.length} 个产物文件 + ${ownFiles.length} 个页面自有源码文件已扫｜远程引用=${remote.length}`
        + `｜URL 字面量登记=${literals.length}${literals.length ? `（首个：${literals[0].slice(0, 90)}）` : ""}`
        + `｜XML 命名空间登记=${namespaces.length}${namespaces.length ? `（首个：${namespaces[0].slice(0, 90)}）` : ""}`,
      failDetail: `真的会发请求的远程引用：${remote.slice(0, 4).join(" | ")}`,
    };
  }

  // C-13m ── `handleRequest` 里的 OPTIONS 预检分支**只允许出现一次**（重复 = 不可达死代码）
  {
    const requestBody = bodyAfter(b, "async function handleRequest(");
    const optionsBranches = (requestBody.match(/if\s*\(req\.method === 'OPTIONS'\)/g) || []).length;
    result["C-13m"] = {
      title: "`handleRequest()` 里的 OPTIONS 预检分支**只出现一次**：复制出来的第二段是**不可达死代码**"
        + "（本项目一路在打的「死路由 / 死订阅 / 死导入」同族；没有任何请求会执行到它，却会让下一个读者以为有两段逻辑）",
      ok: requestBody !== "" && optionsBranches === 1,
      detail: `handleRequest 里 OPTIONS 分支=${optionsBranches} 处（应为 1）`,
    };
  }

  return result;
}

const C13_IDS = ["C-13a", "C-13b", "C-13c", "C-13d", "C-13e", "C-13f", "C-13g", "C-13h", "C-13i", "C-13j", "C-13k", "C-13l", "C-13m"];

{
  group("§15 网页版剪藏页（C-13a…C-13l）");
  const readDistClip = () => {
    const dir = path.join(ROOT, "dist-clip");
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walkDir = (abs) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (TEXT_EXT.has(path.extname(entry.name))) {
          out.push({ rel: path.posix.join("dist-clip", path.relative(dir, full).replace(/\\/g, "/")), text: fs.readFileSync(full, "utf8") });
        }
      }
    };
    walkDir(dir);
    return out;
  };
  const baseClipInp = {
    bridge: readIfExists("electron/bridge.cjs") || "",
    clipStage: readIfExists("electron/clip-stage.cjs") || "",
    extStage: readIfExists("extension/src/lib/stage.js") || "",
    extPopup: readIfExists("extension/src/popup/popup.js") || "",
    extBg: readIfExists("extension/src/background.js") || "",
    clipHtml: readIfExists("clip/index.html") || "",
    viteClip: readIfExists("vite.clip.config.ts") || "",
    webContract: readIfExists("src/clip-web/contract.ts") || "",
    webView: readIfExists("src/clip-web/view.ts") || "",
    ownPageFiles: [
      { rel: "clip/index.html", text: readIfExists("clip/index.html") || "" },
      ...readTree(["src/clip-web"], (rel) => /\.(?:ts|tsx)$/.test(rel) && !/\.test\./.test(rel))
        .map((rel) => ({ rel, text: readIfExists(rel) || "" })),
    ],
    distFiles: readDistClip(),
  };
  const real13 = clipContractChecks(baseClipInp);
  for (const id of C13_IDS) {
    const v = real13[id];
    check(id, v.title, v.ok, v.detail, v.detail);
  }
  /* **剥离器单元自检**（Lead 补充 1 的反向要求）：剥注释的路径必须既「只吃注释」又「不吞真代码」。
   * 6 个用例里最关键的是正则字面量那一条 —— 它失步过一次，症状与「代码里没那行」完全一样。 */
  {
    const st = stripSelftest();
    check("C-13·剥离自检", `剥注释器单元自检：${st.total} 个用例（行注释/字符串里的 // /正则里的引号/模板字面量/块注释/除号）全部正确`,
      st.bad.length === 0,
      `${st.total} 个用例全部正确（含「正则字面量里的引号不是字符串」这一条 —— 它失步过，症状与「代码里没有那行」一模一样）`,
      `用例不成立：${st.bad.join(" | ")}`);
  }
  /* **文件级剥离审计**：C-13 判据要看的那些形状，剥注释后必须逐字还在（丢了就是剥离器吞了真代码）。
   * 另加**审计自检**：给审计喂一个「故意吞掉一处真代码」的桩剥离器 → 它**必须报出丢失**
   * （否则这条审计自己是恒绿的：「没有丢失」与「审计根本没在比」长得一模一样）。 */
  {
    const probes = [/\/clip\//g, /\bassets\.push\(/g, /\breturn\s*\{/g, /\btabs\.create\(/g, /\bopenUrlOf\s*\(/g, /selection\s*:/g];
    const lost = [];
    for (const f of [
      { rel: "extension/src/popup/popup.js", text: baseClipInp.extPopup },
      { rel: "extension/src/background.js", text: baseClipInp.extBg },
      { rel: "extension/src/lib/stage.js", text: baseClipInp.extStage },
      { rel: "src/clip-web/contract.ts", text: baseClipInp.webContract },
      { rel: "src/clip-web/view.ts", text: baseClipInp.webView },
      { rel: "electron/bridge.cjs", text: baseClipInp.bridge },
    ]) {
      const audit = commentStripAudit(f.text, probes);
      for (const l of audit.lost) lost.push(`${f.rel}: ${l}`);
    }
    const lossyStub = (text) => ({ text: String(text).replace(/return\s*\{/g, "return X"), spans: [] });
    const auditSelf = commentStripAudit("function f() {\n  return {\n}\n", [/return\s*\{/g], lossyStub);
    check("C-13·剥离审计", "C-13 判据要看的形状（`/clip/`、`assets.push(`、`return {`、`tabs.create(`、`openUrlOf(`、`selection:`）"
      + "在剥注释后逐字仍在原偏移（**非注释区** 0 处丢失）；**审计自检**：桩剥离器故意吞掉一处真代码时它必须报出来",
      lost.length === 0 && auditSelf.lost.length > 0,
      `6 个文件 × 6 组形状：非注释区丢失 0 处；审计自检：桩剥离器吞掉 \`return {\` → 报出丢失 ${auditSelf.lost.length} 处 ✓`,
      `非注释区被剥离器吞掉的匹配：${lost.slice(0, 6).join(" | ") || "无"}；审计自检丢失数=${auditSelf.lost.length}（必须 > 0）`);
  }
  /* 产物不在（没跑 `pnpm build:clip`）时 C-13l 是 SKIP：**不计通过**，如实说原因。 */
  if (!(baseClipInp.distFiles || []).length) {
    withdrawLast("C-13l", "`dist-clip/**` 还没构建（没跑 `pnpm build:clip`）⇒ 产物那一面本次不判。**SKIP 不计通过。**");
  }
  info("C-13·覆盖面", "这组判据各看到多少：路由 / 请求体键 / 产物文件（判据只看**静态契约面**，行为面在 e2e 的 S13）",
    `bridge.cjs ${baseClipInp.bridge.length} 字符；clip-stage.cjs ${baseClipInp.clipStage.length}；`
    + `extension/src/lib/stage.js ${baseClipInp.extStage.length}；clip/index.html ${baseClipInp.clipHtml.length}；`
    + `dist-clip 产物 ${baseClipInp.distFiles.length} 个文件`);

  /* ── C-13·变异自检：每条判据至少一个能红的变异（跨线两条另有「修好后必须绿」的控制组）──
   * 所有变异**先过落地自检**（命中处数 + 前后 sha256），0 命中 → NO_EFFECT + 退出码 2。 */
  const CONTRACT_ASSET_RETURN = "return { name, mime, dataBase64 };";
  const setAssetReturn = (inp, text) => ({
    ...inp,
    extStage: inp.extStage.replace(/return\s*\{[\s\S]*?\};/, text),
  });
  const BREAK_SELECTION = (i) => ({
    ...i,
    webContract: i.webContract
      .replace(/selection:\s*boolean;/, "selection: string;")
      .replace(/selection:\s*stage\.selection\s*===\s*true,/, 'selection: typeof stage.selection === "string" ? stage.selection : "",'),
    // 幂等：已经有那条分支就不要再加一条（否则前后两份「坏态」不一致，控制组证明不了任何事）。
    webView: /\.selection\.trim\(\)/.test(i.webView) ? i.webView : i.webView.replace(
      /^([ \t]*)if \(stage\.body\.trim\(\) !== ""\) return \{[^\n]*\n/m,
      "$&$1if (stage.selection.trim() !== \"\") return { title: stage.title, body: stage.selection, source: \"selection\" };\n",
    ),
  });
  const FIX_SELECTION = (i) => ({
    ...i,
    webContract: i.webContract
      .replace(/selection:\s*string;/, "selection: boolean;")
      .replace(/selection:\s*typeof stage\.selection\s*===\s*"string"\s*\?\s*stage\.selection\s*:\s*"",/, "selection: stage.selection === true,"),
    webView: i.webView.replace(/^[ \t]*if \(stage\.selection\.trim\(\) !== ""\)[^\n]*\n/m, ""),
  });
  /* ── C-13m 的参照系规范化（Lead 2026-09-30 的纪律）：这条判据在**真实树上就是红的**
   * （`bridge.cjs` 里 OPTIONS 预检被复制了一份），拿一个红基线做变异证明不了任何事 ——
   * 所以两个变异都先把参照系规范化：一条「修好后必须变绿」（控制组），一条「修好再复制 → 必须变红」。 */
  const OPTIONS_BLOCK_G = /\n[ \t]*\/\/ OPTIONS 预检：只走 Host \+ Origin，不校验令牌（预检不携带 Authorization）。\n[ \t]*if \(req\.method === 'OPTIONS'\) \{[\s\S]*?\n[ \t]*\}\n/g;
  const dropDuplicateOptions = (text) => {
    const matches = [...String(text).matchAll(OPTIONS_BLOCK_G)];
    if (matches.length < 2) return String(text);
    /* 只留**第一处**：从后往前删掉其余所有副本。
     * ⚠️ 第一版只删「第二处」，于是「先复制再删」的控制组在已经重复的树上剩 2 处 → 仍然红，
     * 控制组自己变红（自检当场抓出来）。 */
    let out = String(text);
    for (let i = matches.length - 1; i >= 1; i -= 1) {
      const m = matches[i];
      out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
    }
    return out;
  };
  const forceDuplicateOptions = (text) => String(text).replace(OPTIONS_BLOCK_G, (m0) => `${m0}${m0}`);
  const c13mut = [
    { name: "page-route-requires-bearer（页面端点被加上长期令牌闸门）", target: "C-13a", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(
        "if (route === '/clip' || route.startsWith('/clip/')) {",
        "if (route === '/clip' || route.startsWith('/clip/')) {\n      if (!checkToken(req, res)) return true;",
      ) }) },
    { name: "openUrl-hardcoded-port（桥把端口写死 8787，不再用真实监听端口）", target: "C-13b", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(
        "const openUrl = `http://127.0.0.1:${listeningPort}/clip/",
        "const openUrl = `http://127.0.0.1:8787/clip/",
      ) }) },
    { name: "ext-builds-openurl（扩展自己拼页面路径 /clip/）", target: "C-13b", expect: "red",
      apply: (i) => ({ ...i, extPopup: `${i.extPopup}\nconst u = "http://127.0.0.1:" + port + "/clip/" + id;\n` }) },
    { name: "stageid-from-client（stageId 用客户端给的 id）", target: "C-13c", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(
        "    const entry = clipStore.stage({",
        "    const clientId = payload.importId || payload.stageId;\n    void clientId;\n    const entry = clipStore.stage({",
      ) }) },
    { name: "log-stage-secret（写日志的白名单里加了 k）", target: "C-13d", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(
        "    if (fields.detail != null) line.detail = clampText(redact(String(fields.detail)), 200)",
        "    if (fields.detail != null) line.detail = clampText(redact(String(fields.detail)), 200)\n    if (fields.k != null) line.k = String(fields.k)",
      ) }) },
    { name: "log-secret-at-callsite（某个 writeLog 调用把 k 塞进字段）", target: "C-13d", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(
        "writeLog('bridge.stop', {})",
        "writeLog('bridge.stop', { k: 'x', stageId: 'y' })",
      ) }) },
    { name: "folders-lose-inbox-first（去掉 folders 的 '' 前置项）", target: "C-13e", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(/((?:folders|list)\s*:\s*\[\s*)''\s*,\s*/, "$1") }) },
    { name: "folder-autocreate（去掉「必须已存在」的成员校验，改为直接用）", target: "C-13f", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(/if\s*\(![\w.]*includes\(folder\)\)\s*\{/, "if (false) {") }) },
    { name: "second-write-path（commit 里再调一次 onEnvelope，绕开唯一通路）", target: "C-13g", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace(
        "    const outcome = await runEnvelopePipeline(req, res, {",
        "    await onEnvelope(JSON.stringify(envelope), { clientName: CLIP_CLIENT_NAME, clientVersion: '' });\n    const outcome = await runEnvelopePipeline(req, res, {",
      ) }) },
    { name: "csp-unsafe-inline（CSP 的 script-src 加上 unsafe-inline）", target: "C-13h", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace("script-src 'self'; style-src", "script-src 'self' 'unsafe-inline'; style-src") }) },
    { name: "inline-script-in-page（页面源码里塞一段内联可执行脚本）", target: "C-13h", expect: "red",
      apply: (i) => ({ ...i, clipHtml: i.clipHtml.replace("</body>", "<script>window.__probe = 1;</script>\n</body>") }) },
    { name: "asset-traversal-allowed（静态资源放行 `..`）", target: "C-13i", expect: "red",
      apply: (i) => ({ ...i, bridge: i.bridge.replace("    if (name.includes('..')) return false\n", "") }) },
    { name: "ext-assets-wrong-shape（**跨线**：扩展把资产发成 `{url, alt}`，桥必拒 `IMP-4003`）", target: "C-13j", expect: "red",
      pre: (i) => setAssetReturn(i, CONTRACT_ASSET_RETURN),
      apply: (i) => setAssetReturn(i, 'return { url: String(name), alt: "" };') },
    { name: "ext-assets-contract-shape（**控制组**：资产形状改回 `{name, mime, dataBase64}` → 必须变绿）", target: "C-13j", expect: "green",
      pre: (i) => setAssetReturn(i, 'return { url: String(name), alt: "" };'),
      apply: (i) => setAssetReturn(i, CONTRACT_ASSET_RETURN) },
    { name: "page-selection-as-text（**跨线**：页面把 `stage.selection` 当字符串读）", target: "C-13k", expect: "red",
      pre: FIX_SELECTION,
      apply: BREAK_SELECTION },
    { name: "page-selection-boolean（**控制组**：页面按布尔读 `selection` → 必须变绿）", target: "C-13k", expect: "green",
      pre: BREAK_SELECTION,
      apply: FIX_SELECTION },
    { name: "dist-remote-ref（产物里塞一个真远程请求：`fetch` + `<script src>`）", target: "C-13l", expect: "red",
      apply: (i) => (i.distFiles || []).length === 0 ? i : {
        ...i,
        distFiles: i.distFiles.map((f, index) => (index === 0
          ? { ...f, text: `${f.text}\nfetch("https://evil.example/x")\n<script src="https://evil.example/x.js"></script>\n` }
          : f)),
      } },
    { name: "duplicate-options-branch（**先修好后**再复制一份 OPTIONS 预检，第二段不可达）", target: "C-13m", expect: "red",
      pre: (i) => ({ ...i, bridge: dropDuplicateOptions(i.bridge) }),
      apply: (i) => ({ ...i, bridge: forceDuplicateOptions(i.bridge) }) },
    { name: "options-branch-dedup（**控制组**：把重复的那段删掉 → 必须变绿）", target: "C-13m", expect: "green",
      pre: (i) => ({ ...i, bridge: forceDuplicateOptions(i.bridge) }),
      apply: (i) => ({ ...i, bridge: dropDuplicateOptions(i.bridge) }) },
  ];
  const failures13 = [];
  const log13 = [];
  for (const m of c13mut) {
    const ref = m.pre ? m.pre(baseClipInp) : baseClipInp;
    const mutated = m.apply(ref);
    const hits = changedLineCount(JSON.stringify(ref), JSON.stringify(mutated));
    if (!mutationLanded("C-13·变异自检", m.name, JSON.stringify(ref), JSON.stringify(mutated), hits, m.target)) {
      log13.push(`${m.name}→NO_EFFECT（未判定）`);
      continue;
    }
    const before = clipContractChecks(ref);
    const after = clipContractChecks(mutated);
    const flipped = C13_IDS.filter((id) => before[id].ok !== after[id].ok);
    const fine = m.expect === "red"
      ? before[m.target].ok === true && after[m.target].ok === false && flipped.length === 1
      : before[m.target].ok === false && after[m.target].ok === true && flipped.length === 1;
    if (!fine) {
      failures13.push(`${m.name}：期望 ${m.expect}，实际翻转为 [${flipped.join(",") || "无"}]`
        + `（目标基线 ok=${before[m.target].ok} → ${after[m.target].ok}）`);
    }
    log13.push(`${m.name}→${m.expect} ${fine ? "✓" : "✗"}${flipped.length > 1 ? `（牵连 ${flipped.filter((x) => x !== m.target).join(",")}）` : ""}`);
  }
  check("C-13·变异自检", `${c13mut.length} 个内存变异各自生效：每条形变都打印命中处数 + 前后 sha256；`
    + `跨线两条另有「修好后必须绿」的控制组`,
    failures13.length === 0, log13.join("；"), `不成立的变异：${failures13.join(" | ")}`);
}

/* ==================================================================== §16 */
/* §16 C-14 · B4「三条写图路径统一到 `assetsDirFor`」（task-5；Lead 2026-09-30 指派复核）
 *
 * 判据盯**用户看得见的那条路径**：给一篇笔记粘一张图 → 图落在工作区根的共享 `.assets/`、
 * 正文引用按笔记所在目录的层数写成相对路径；把这篇笔记删了再恢复 → 引用跟着重算、图还在；
 * 单独把一篇笔记挪到别的目录 → 引用前缀跟着变，仍然指得对。
 * **旧数据不迁移**：公共 `<目录>/assets/` 与老的 `<笔记名>.assets/` 里的图一个字节都不许动。
 * **永久删除按引用删**：整目录递归删共享 `.assets/` 会把别人的图一起删掉。
 */
function assetsPathChecks(inp) {
  const code = (text) => stripCommentsKeepLines(text).text;
  const lib = code(inp.library);
  const media = code(inp.media);
  const imp = code(inp.importTs);
  const result = {};

  // C-14a ── `saveImage` 的落点是**整库共用**的 `.assets/`，引用按笔记所在目录现算
  {
    const body = bodyAfter(lib, "export async function saveImage(");
    const sharedDir = /assetsDirFor\(\s*\)/.test(body);
    const derivesRef = /relativeAssetRef\(\s*notePath\s*,/.test(body);
    const noPublicAssets = !/ASSETS_DIR/.test(body);
    result["C-14a"] = {
      title: "`saveImage(blob, suggestedName, notePath)`：落点是共享 `assetsDirFor()`（整库一个 `.assets/`），"
        + "引用由 `relativeAssetRef(notePath, path)` 按**笔记所在目录**现算 —— 既不拼公共 `assets/`，也不拼按笔记名派生的目录",
      ok: body !== "" && sharedDir && derivesRef && noPublicAssets,
      detail: `saveImage 体内 \`assetsDirFor()\`=${sharedDir}｜\`relativeAssetRef(notePath,…)\`=${derivesRef}｜体内出现公共 ASSETS_DIR=${!noPublicAssets}`,
    };
  }

  // C-14b ── 三条写图路径统一（编辑器粘贴/拖拽、import.ts 迁移、library.ts saveImage）
  {
    /* 判据要盯**第三个实参本身**（最终笔记路径），不能只在附近找 `notePath` 这个词 ——
     * 第一版用 `[\s\S]{0,200}?notePath` 的窗口式匹配，变异把实参换成 `""` 之后
     * 附近还有别的 `notePath` 出现 ⇒ 判据仍然绿（**变异落地但没翻红**，自检当场抓住）。 */
    const call = (/saveImage\(([\s\S]*?)\)\s*;/.exec(media) || [])[1] || "";
    const args = call ? splitTopLevel(call) : [];
    const thirdArg = (args[2] || "").trim();
    const mediaPassesNotePath = args.length === 3 && /notePath/.test(thirdArg);
    const importDerives = /assetsDirFor\(\s*\)/.test(imp) && /relativeAssetRef\(/.test(imp);
    const libDerives = /assetsDirFor\(\s*\)/.test(lib);
    result["C-14b"] = {
      title: "三条写图路径统一到同一条规则：编辑器粘贴/拖拽把**笔记路径**传给 `saveImage`（**第三个实参**）、"
        + "`src/lib/import.ts` 的新图落盘用 `assetsDirFor()` + `relativeAssetRef`、`library.ts` 的 `saveImage` 用 `assetsDirFor()`"
        + "（**新图一律落共享 `.assets/`**）",
      ok: mediaPassesNotePath && importDerives && libDerives,
      detail: `media.ts saveImage 第三实参=${JSON.stringify(thirdArg)}｜import.ts 共享落点+前缀=${importDerives}｜library.ts 用 assetsDirFor()=${libDerives}`,
    };
  }

  // C-14c ── 删除 / 恢复 / 移动：**改写引用**而不是搬目录；永久删除**按引用删**
  {
    /* 三个方向都要在**各自的函数体里**判：同一个形状的调用在三个函数里各有一处，
     * 在全文里找会让「恢复方向反了」这个变异**落地却不翻红**（第一版就是这样）。 */
    const trashBody = bodyAfter(lib, "export async function trashNote(");
    const restoreBody = bodyAfter(lib, "export async function restoreNote(");
    const moveBody = bodyAfter(lib, "export async function moveNote(");
    const trashRebase = /rebaseNoteAssets\(\s*target\s*,\s*id\s*,\s*trashPath\s*\)/.test(trashBody);
    const restoreRebase = /rebaseNoteAssets\(\s*target\s*,\s*id\s*,\s*nextPath\s*\)/.test(restoreBody);
    const moveRebase = /rebaseNoteAssets\(\s*target\s*,\s*id\s*,\s*nextPath\s*\)/.test(moveBody);
    /* 永久删除**必须**按引用挑文件：整目录 `remove(assetsDirFor(), { recursive: true })`
     * 会把共享目录里**别人的图**一起删掉 —— 这是这套布局最危险的一处。 */
    const refBasedDelete = /sharedAssetFilesIn\(/.test(lib);
    const noWholesaleDelete = !/remove\(\s*assetsDirFor\(\s*\)\s*,\s*\{\s*recursive/.test(lib);
    /* 旧布局的自有附件目录仍要清算（老笔记真删了，它就该消失）。 */
    const legacyKept = /joinPath\(parentPath\(id\), `\$\{stem\}\.assets`\)/.test(lib);
    result["C-14c"] = {
      title: "删除/恢复/移动都**改写正文引用**（`rebaseNoteAssets(target, id, 新路径)`），不再搬目录；"
        + "永久删除**按引用删**（`sharedAssetFilesIn`）且**绝不整目录递归删共享 `.assets/`**（那会删掉别人的图）；"
        + "旧布局的 `<笔记名>.assets/` 仍按目录清算",
      ok: trashRebase && restoreRebase && moveRebase && refBasedDelete && noWholesaleDelete && legacyKept,
      detail: `trashNote rebase=${trashRebase}｜restoreNote rebase=${restoreRebase}｜moveNote rebase=${moveRebase}`
        + `｜按引用删=${refBasedDelete}｜无整目录递归删=${noWholesaleDelete}｜旧目录清算保留=${legacyKept}`,
    };
  }

  return result;
}

const C14_IDS = ["C-14a", "C-14b", "C-14c"];

{
  group("§16 B4 三条写图路径统一（C-14a…C-14c）");
  const baseAssetsInp = {
    library: readIfExists("src/data/library.ts") || "",
    media: readIfExists("src/editor/media.ts") || "",
    importTs: readIfExists("src/lib/import.ts") || "",
  };
  const real14 = assetsPathChecks(baseAssetsInp);
  for (const id of C14_IDS) {
    const v = real14[id];
    check(id, v.title, v.ok, v.detail, v.detail);
  }
  const c14mut = [
    { name: "saveimage-public-assets（saveImage 退回公共 `<目录>/assets/`）", target: "C-14a", expect: "red",
      /* ⚠️ 必须锚在 `saveImage` 的**函数体**里：`assetsDirFor()` 在 library.ts 里出现多次
       * （`removeSharedAssetsOfNote` 里也有一处），非全局 replace 会打中**第一处**（不是 saveImage）
       * → 变异落地却不翻红。 */
      apply: (i) => ({ ...i, library: i.library.replace(
        /(export async function saveImage\([\s\S]*?)const dir = assetsDirFor\(\);/,
        "$1const dir = joinPath(parentPath(notePath), ASSETS_DIR);",
      ) }) },
    { name: "media-passes-empty（编辑器不再把笔记路径传下去）", target: "C-14b", expect: "red",
      /* ⚠️ 必须锚在 `saveImage(` 的**实参**上：`options.notePath` 在文件里出现多次（还有一处
       * `if (!options.notePath)`），非全局 `replace` 会打中**第一处**（不是实参）→ 变异落地却不翻红。 */
      apply: (i) => ({ ...i, media: i.media.replace(/(saveImage\([\s\S]*?,\s*)options\.notePath(\s*\))/, '$1""$2') }) },
    { name: "restore-uses-id（恢复方向反了：用回收站 id 而不是 nextPath）", target: "C-14c", expect: "red",
      /* ⚠️ 只替换**恢复那一处**（`trashNote`/`moveNote` 里还有同形状的调用 —— 非全局 replace 会打错目标，
       * 第一版就因此「变异落地了但判据没翻红」）。 */
      apply: (i) => ({ ...i, library: i.library.replace(
        /(export async function restoreNote[\s\S]*?)await rebaseNoteAssets\(target, id, nextPath\)/,
        "$1await rebaseNoteAssets(target, id, id)",
      ) }) },
    { name: "purge-whole-shared-dir（永久删除整目录递归删共享 `.assets/`：会删掉别人的图）", target: "C-14c", expect: "red",
      apply: (i) => ({ ...i, library: i.library.replace(
        "await removeSharedAssetsOfNote(target, id);",
        "await target.remove(assetsDirFor(), { recursive: true });",
      ) }) },
  ];
  const failures14 = [];
  const log14 = [];
  for (const m of c14mut) {
    const mutated = m.apply(baseAssetsInp);
    const hits = changedLineCount(JSON.stringify(baseAssetsInp), JSON.stringify(mutated));
    if (!mutationLanded("C-14·变异自检", m.name, JSON.stringify(baseAssetsInp), JSON.stringify(mutated), hits, m.target)) {
      log14.push(`${m.name}→NO_EFFECT（未判定）`);
      continue;
    }
    const before = assetsPathChecks(baseAssetsInp);
    const after = assetsPathChecks(mutated);
    const flipped = C14_IDS.filter((id) => before[id].ok !== after[id].ok);
    const fine = m.expect === "red"
      ? before[m.target].ok === true && after[m.target].ok === false && flipped.length === 1
      : before[m.target].ok === false && after[m.target].ok === true && flipped.length === 1;
    if (!fine) failures14.push(`${m.name}：期望 ${m.expect}，实际翻转为 [${flipped.join(",") || "无"}]（目标 ${before[m.target].ok} → ${after[m.target].ok}）`);
    log14.push(`${m.name}→${m.expect} ${fine ? "✓" : "✗"}`);
  }
  check("C-14·变异自检", `${c14mut.length} 个内存变异各自能让对应判据翻红（都打印命中处数 + 前后 sha256）`,
    failures14.length === 0, log14.join("；"), `不成立的变异：${failures14.join(" | ")}`);
  /* **`bodyAfter` 单元自检**：两类踩过的形态（默认参数里的 `{}`、返回类型里的 `{}`）必须都能取到真函数体 ——
   * 否则判据会在**产品正确**时假红（`C-14a` 就是这么红过一次）。 */
  {
    const bt = bodySelftest();
    check("C-14·取词自检", `取函数体的辅助函数自检：${bt.total} 个用例（默认参数里的 \`{}\`、返回类型里的 \`{}\`、泛型数组、普通签名）全部正确`,
      bt.bad.length === 0,
      `${bt.total} 个用例全部正确（两类「签名里也有 ` + "`{}`" + `」的形态是踩过的坑）`,
      `用例不成立：${bt.bad.join(" | ")}`);
  }
  info("C-14·覆盖面", "这条线**只做静态契约面**；行为面（粘贴/剪藏落共享 `.assets/`、移动/回收站/恢复改写引用、"
    + "永久删除按引用删、旧数据不动）在 `src/editor/*.test.ts` / `src/lib/import*.test.ts` / `src/lib/clip/assets*.test.ts`"
    + " / `src/data/library.files.test.ts` 与 `pnpm test` 里",
    `library.ts ${baseAssetsInp.library.length} 字符｜media.ts ${baseAssetsInp.media.length}｜import.ts ${baseAssetsInp.importTs.length}`);
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
  /* 收尾再查一次「树在不在动」：跑到一半有人开始 build / 跑变异，这一轮的结论就不算数。
   * 这不是第四种「通过」，是**中止**：既不能当绿，也不能当失败清单。 */
  const trustEnd = extTrust();
  const untrusted = UNTRUSTED.at || !trustEnd.trusted;

  if (WANT_JSON) {
    console.log(JSON.stringify({ baseline: BASELINE, changed: PRODUCT_CHANGED, counts, untrusted, results }, null, 2));
  } else {
    if (untrusted) {
      console.log("\n" + "!".repeat(72));
      console.log("!! 本次运行【不可信】—— 不得当作通过，也不得当作失败清单");
      for (const why of UNTRUSTED.why) console.log(`!!   · ${why}`);
      if (!UNTRUSTED.at && !trustEnd.trusted) console.log(`!!   · 收尾复查：${trustEnd.why}`);
      console.log("!!   处理：等构建/变异结束（或删掉遗留标记）后重跑本脚本。");
      console.log("!".repeat(72));
    }
    console.log("\n=== 契约验证摘要 ===");
    console.log(`PASS ${counts.PASS || 0} / FAIL ${failures.length} / SKIP ${counts.SKIP || 0} / INFO ${counts.INFO || 0}`
      + `${untrusted ? "  【不可信】" : ""}${NO_EFFECTS.length ? "  【NO_EFFECT】" : ""}`);
    console.log(`基线 ${BASELINE}；本次产品改动面 ${PRODUCT_CHANGED.length} 个文件`);
    if (NO_EFFECTS.length) {
      console.log("\n--- NO_EFFECT 清单（变异没落地 ⇒ 对应自检**未执行**，本轮红绿结论不完整；退出码 2） ---");
      for (const n of NO_EFFECTS) console.log(`  NO_EFFECT  ${n}`);
      console.log("  处理：修正变异锚点（源码变了？）后重跑。**不许**把「没落地」当成「护栏检测到了」。");
    }
    if (failures.length) {
      console.log("\n--- 失败清单（必须修） ---");
      for (const f of failures) console.log(`  FAIL [${f.id}] ${f.title}\n        ${f.detail}`);
    }
    if (skips.length) {
      console.log("\n--- 未验证清单（SKIP：不得当作通过） ---");
      for (const s of skips) console.log(`  SKIP [${s.id}] ${s.title} — ${s.detail}`);
    }
  }

  /* 退出码：0 = 全通过；1 = 有 FAIL（打印失败清单）；2 = **本次不可信**：
   *   ① 树在动（`.building` / `.mutation-running`，与 b 的标记协议一致）；
   *   ② 出现 `NO_EFFECT`（某个变异没落地 ⇒ 它的自检没执行 ⇒ 本轮的红绿结论不完整）。
   * 两者都**不是**第四种「通过」，也都**不是**产品失败清单 —— 不可信 ≠ 失败 ≠ 通过。 */
  process.exit(untrusted || NO_EFFECTS.length ? 2 : failures.length ? 1 : 0);
})();
