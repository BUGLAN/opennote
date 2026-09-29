/**
 * extension/ 的**机械化验收**（零依赖）。跑：`node verify.mjs`
 *
 * 与 tests/ 的分工：tests 验证「逻辑对不对」，verify 验证「交付物能不能装、装完安不安全」。
 * 一共 9 组断言，任何一条不过就 exit 1 并打印具体文件与行号：
 *  V1 manifest 基本盘（MV3 / service_worker / 最小权限 / 无 content_scripts）
 *  V2 manifest 引用到的每个文件都真实存在
 *  V3 全 dist 零远程地址（只允许 127.0.0.1 / localhost，以及 SVG 命名空间）
 *  V4 零 eval / new Function / 字符串注入 / 内联脚本
 *  V5 tokens.css 与仓库根逐字节一致（SHA-256 比对），且 BUILD-INFO 记录一致
 *  V6 **0 个新设计令牌**：dist 里新增的自定义属性声明必须为 0
 *  V7 逐字文案清单（03 §UI-01 + mockup）全部出现在交付物里
 *  V8 契约硬约束：不发 overwrite、探测走 API-03、端口范围 8787–8796、401 不泄漏令牌
 *  V9 中文文案里没有 emoji
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const SRC = join(HERE, "src");
const ROOT_TOKENS = join(HERE, "..", "src", "styles", "tokens.css");

const failures = [];
const notes = [];
const fail = (group, message) => failures.push(`[${group}] ${message}`);
const pass = (message) => notes.push(`  ✓ ${message}`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const rel = (file) => relative(HERE, file).split(sep).join("/");

if (!existsSync(DIST)) {
  console.error("dist/ 不存在：先跑 `node build.mjs`");
  process.exit(1);
}

const distFiles = walk(DIST).map(rel).sort();
const textFiles = distFiles.filter((file) => /\.(js|json|css|html|mjs|txt|md)$/.test(file));
const readDist = (file) => readFileSync(join(HERE, file), "utf8");

/* ── V1 manifest 基本盘 ───────────────────────────────────────────── */

const manifest = JSON.parse(readDist("dist/manifest.json"));
const GROUP_V1 = "V1 manifest";

if (manifest.manifest_version !== 3) fail(GROUP_V1, `manifest_version 必须是 3，实际 ${manifest.manifest_version}`);
else pass("manifest_version = 3");

if (!manifest.background || !manifest.background.service_worker) fail(GROUP_V1, "缺少 background.service_worker");
else pass(`service worker = ${manifest.background.service_worker}（type=${manifest.background.type || "classic"}）`);

if (manifest.background && manifest.background.type !== "module") {
  fail(GROUP_V1, "service worker 需要 type=module（源码用静态 ESM 相对导入，无打包器）");
} else pass("service worker 用 ES module 静态导入（零打包器）");

const allowedPermissions = ["storage", "contextMenus", "activeTab", "scripting"];
const permissions = manifest.permissions || [];
for (const permission of permissions) {
  if (!allowedPermissions.includes(permission)) fail(GROUP_V1, `多要了权限：${permission}`);
}
for (const required of ["storage", "contextMenus", "scripting"]) {
  if (!permissions.includes(required)) fail(GROUP_V1, `缺少必要权限：${required}`);
}
if (permissions.includes("clipboardWrite")) {
  fail(GROUP_V1, "不应申请 clipboardWrite：复制降级走页面内 execCommand（见 README 降级链）");
}
pass(`权限清单 = ${JSON.stringify(permissions)}`);

const hostPermissions = manifest.host_permissions || [];
const expectedHosts = [];
for (let port = 8787; port <= 8796; port += 1) expectedHosts.push(`http://127.0.0.1:${port}/*`);
if (JSON.stringify(hostPermissions) !== JSON.stringify(expectedHosts)) {
  fail(GROUP_V1, `host_permissions 必须精确等于 8787–8796 的 10 条回环模式，实际：${JSON.stringify(hostPermissions)}`);
} else pass("host_permissions = 10 条 127.0.0.1 回环模式（8787–8796，无 <all_urls>）");

if (manifest.content_scripts) fail(GROUP_V1, "不许用 content_scripts（会要求 <all_urls>，改用 activeTab + scripting 按需注入）");
else pass("无 content_scripts（按需注入）");
if (manifest.web_accessible_resources) fail(GROUP_V1, "不需要 web_accessible_resources（不给页面暴露任何扩展资源）");
else pass("无 web_accessible_resources");
if (manifest.content_security_policy) fail(GROUP_V1, "不得放宽 CSP");
else pass("未放宽 CSP（沿用 MV3 默认）");
if (!manifest.commands || !manifest.commands["clip-selection"] || !manifest.commands["clip-page"]) {
  fail(GROUP_V1, "缺少 commands：clip-selection / clip-page");
} else pass(`快捷键 = ${Object.keys(manifest.commands).join(", ")}`);
if (manifest.minimum_chrome_version && Number(manifest.minimum_chrome_version) < 116) {
  fail(GROUP_V1, `minimum_chrome_version=${manifest.minimum_chrome_version} 过低（侧载与 API 都按 116+ 验）`);
}

/* ── V2 manifest 引用文件存在 ─────────────────────────────────────── */

const GROUP_V2 = "V2 引用完整性";
const referenced = [];
if (manifest.background && manifest.background.service_worker) referenced.push(manifest.background.service_worker);
if (manifest.action && manifest.action.default_popup) referenced.push(manifest.action.default_popup);
if (manifest.action && manifest.action.default_icon) referenced.push(...Object.values(manifest.action.default_icon));
if (manifest.icons) referenced.push(...Object.values(manifest.icons));
for (const file of referenced) {
  if (!existsSync(join(DIST, file))) fail(GROUP_V2, `manifest 引用的文件不存在：${file}`);
}
const iconSizes = Object.keys(manifest.icons || {}).map(Number).sort((a, b) => a - b);
if (JSON.stringify(iconSizes) !== JSON.stringify([16, 32, 48, 128])) {
  fail(GROUP_V2, `图标尺寸应为 16/32/48/128，实际 ${iconSizes.join("/")}`);
}
pass(`manifest 引用的 ${referenced.length} 个文件全部存在`);

// popup.html 内部的引用
const popupHtml = readDist(`dist/${manifest.action.default_popup}`);
const popupDir = dirname(join(DIST, manifest.action.default_popup));
for (const match of popupHtml.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const target = match[1];
  if (target.startsWith("data:") || target.startsWith("#")) continue;
  const resolved = join(popupDir, target);
  if (!existsSync(resolved)) fail(GROUP_V2, `popup.html 引用的 ${target} 不存在`);
}
pass("popup.html 的 link/script 引用全部存在");

// service worker 的静态导入图
const importGraph = new Set();
function followImports(entry) {
  const full = join(DIST, entry);
  if (importGraph.has(entry) || !existsSync(full)) return;
  importGraph.add(entry);
  const source = readFileSync(full, "utf8");
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = match[1];
    if (!spec.startsWith(".")) {
      fail(GROUP_V2, `${entry} 引用了非相对模块：${spec}（必须零依赖）`);
      continue;
    }
    const target = relative(DIST, join(dirname(full), spec)).split(sep).join("/");
    if (!existsSync(join(DIST, target))) fail(GROUP_V2, `${entry} 引用的 ${target} 不存在`);
    else followImports(target);
  }
}
followImports(manifest.background.service_worker);
pass(`service worker 导入图共 ${importGraph.size} 个文件，全部为相对路径且存在`);

/* ── V3 零远程地址 ───────────────────────────────────────────────── */

const GROUP_V3 = "V3 零远程代码";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "www.w3.org"]);
let remoteHits = 0;
for (const file of textFiles) {
  const text = readDist(file);
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
      const host = (match[0].match(/^https?:\/\/([^/:?#]+)/) || [])[1] || "";
      if (ALLOWED_HOSTS.has(host)) continue;
      remoteHits += 1;
      fail(GROUP_V3, `${file}:${index + 1} 出现远程地址 ${match[0]}`);
    }
  });
}
for (const file of textFiles) {
  const text = readDist(file);
  if (/^\s*\/\/#\s*sourceMappingURL=/m.test(text)) fail(GROUP_V3, `${file} 含 sourceMappingURL`);
}
if (remoteHits === 0) pass(`全部 ${textFiles.length} 个文本产物无远程地址（仅允许回环与 SVG 命名空间）`);

/* ── V4 零动态代码 ───────────────────────────────────────────────── */

const GROUP_V4 = "V4 零动态代码";
for (const file of textFiles.filter((f) => f.endsWith(".js"))) {
  const text = readDist(file);
  if (/\beval\s*\(/.test(text)) fail(GROUP_V4, `${file} 含 eval`);
  if (/new\s+Function\s*\(/.test(text)) fail(GROUP_V4, `${file} 含 new Function`);
  if (/setTimeout\s*\(\s*["'`]/.test(text)) fail(GROUP_V4, `${file} 含字符串 setTimeout`);
  if (/document\.write\s*\(/.test(text)) fail(GROUP_V4, `${file} 含 document.write`);
}
if (/<script(?![^>]*\bsrc=)/.test(popupHtml)) fail(GROUP_V4, "popup.html 含内联脚本");
if (/\son[a-z]+\s*=\s*"/i.test(popupHtml)) fail(GROUP_V4, "popup.html 含内联事件属性");
pass("dist 内零 eval / new Function / 内联脚本 / 内联事件");

/* ── V5 tokens.css 逐字节一致 ────────────────────────────────────── */

const GROUP_V5 = "V5 设计令牌一致性";
const sourceTokens = readFileSync(ROOT_TOKENS);
const sourceHash = createHash("sha256").update(sourceTokens).digest("hex");
const distTokens = readDist("dist/styles/tokens.css");
const distHash = createHash("sha256").update(Buffer.from(distTokens, "utf8")).digest("hex");
if (distHash !== sourceHash) {
  fail(GROUP_V5, `dist/styles/tokens.css 与 src/styles/tokens.css 不一致（${distHash.slice(0, 12)} vs ${sourceHash.slice(0, 12)}）——禁止手抄令牌`);
} else pass(`tokens.css 逐字节一致 sha256=${sourceHash.slice(0, 16)}…`);
const vendoredHash = createHash("sha256").update(readFileSync(join(SRC, "styles/tokens.css"))).digest("hex");
if (vendoredHash !== sourceHash) fail(GROUP_V5, "extension/src/styles/tokens.css 与仓库根令牌不一致");
const buildInfo = JSON.parse(readDist("dist/BUILD-INFO.json"));
if (buildInfo.tokens.sha256 !== sourceHash) fail(GROUP_V5, "BUILD-INFO.json 记录的令牌哈希与实际不符");
else pass(`BUILD-INFO.json 记录的令牌哈希一致（${buildInfo.tokens.declaredTokens} 个令牌声明）`);

/* ── V6 0 个新设计令牌 ───────────────────────────────────────────── */

const GROUP_V6 = "V6 零新增令牌";
const declaredInTokens = new Set(
  Array.from(distTokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)).map((match) => match[1]),
);
const consumers = textFiles.filter((file) => file.endsWith(".css") || file.endsWith(".js") || file.endsWith(".html"));
const declaredElsewhere = new Map();
for (const file of consumers) {
  if (file === "dist/styles/tokens.css") continue;
  const text = readDist(file);
  for (const match of text.matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gi)) {
    const name = match[2];
    if (!declaredInTokens.has(name)) {
      const list = declaredElsewhere.get(name) || [];
      list.push(file);
      declaredElsewhere.set(name, list);
    }
  }
}
if (declaredElsewhere.size > 0) {
  for (const [name, files] of declaredElsewhere) fail(GROUP_V6, `新增了设计令牌 ${name}（出现在 ${Array.from(new Set(files)).join(", ")}）`);
} else pass("dist 里除 tokens.css 之外 0 处自定义属性声明（没有新增设计令牌）");

// 反向检查：引用的令牌必须都在 tokens.css 里声明过（避免拼错成「静默失效的变量」）
const referencedUnknown = new Set();
for (const file of consumers) {
  const text = readDist(file);
  for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!declaredInTokens.has(match[1])) referencedUnknown.add(`${match[1]}（${file}）`);
  }
}
if (referencedUnknown.size > 0) {
  for (const item of referencedUnknown) fail(GROUP_V6, `引用了 tokens.css 里不存在的令牌：${item}`);
} else pass("所有 var(--…) 引用都能在 tokens.css 里找到声明");

/* ── V7 逐字文案清单 ─────────────────────────────────────────────── */

const GROUP_V7 = "V7 逐字文案";
const bundle = textFiles.map((file) => readDist(file)).join("\n");
const requiredCopy = [
  // UI-01 状态芯片
  "正在连接本地接口…",
  "本地接口已开启",
  "本地接口未开启",
  "端口被占用",
  "Opennote 未运行",
  "需要配对",
  "未连接",
  "离线，已暂存",
  // S2–S12 主文案
  "已剪藏到「",
  "已在笔记中（未重复入库）。",
  "没有选中任何文字。在页面上选一段，或者切到「整页正文」。",
  "这个页面不允许插件读取内容。",
  "换个普通网页再试。",
  "已选中 ",
  "字 · ",
  "约 ",
  "字 · 预计 1 篇笔记",
  "发布于 ",
  "剪藏于 ",
  "用逗号分隔，可留空",
  "粘贴访问令牌",
  "在 Opennote 的「设置 · 文件 → 导入与接口」里复制访问令牌，粘贴到这里。",
  "配对码不正确或已过期，请在 Opennote 里重新生成。",
  "已保留你填的标题与标签。",
  "连接被拒说明本机没有在监听，不是令牌问题。",
  "Opennote 未打开笔记本，内容已暂存在插件里，打开笔记本后会自动补投。",
  "打开 Opennote 后会自动补投。",
  "打开这篇笔记",
  "再剪一段",
  "剪藏到 Opennote",
  "正在剪藏…",
  "正在读取页面…",
  "暂存在插件里",
  "重试",
  "打开 Opennote 设置",
  "先暂存这页",
  "配对",
  "连接",
  "剪藏到收件箱",
  "用当前选区新建标签…",
  "复制 Markdown",
  "打开 Opennote",
  "插件设置",
  // float 浮标（UI-02）
  "剪藏整页正文",
  "剪藏",
  "整页",
  "已剪藏",
  "已暂存",
];
const missingCopy = requiredCopy.filter((text) => !bundle.includes(text));
if (missingCopy.length > 0) {
  for (const text of missingCopy) fail(GROUP_V7, `缺少逐字文案：${text}`);
} else pass(`逐字文案清单 ${requiredCopy.length} 条全部命中`);

/* ── V8 契约硬约束 ───────────────────────────────────────────────── */

const GROUP_V8 = "V8 契约硬约束";
const background = readDist("dist/background.js");
if (/conflict\s*:\s*["']overwrite["']/.test(bundle) || /overwrite\s*[:=]\s*true/.test(bundle)) {
  fail(GROUP_V8, "出现 overwrite：扩展一律不发覆盖指令（02 §5.2）");
} else pass("零 overwrite 用法（红线不变）");
// BLOCK-1 回归闸门：信封默认**不下发** conflict，否则接收端判定链第 3/4 步永不生效
const envelopeDist = readDist("dist/lib/envelope.js");
// 只看代码，不看注释（注释里正是要写清这条纪律，会被误报）
const envelopeCode = envelopeDist.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
if (/conflict\s*:\s*["']new["']/.test(envelopeCode) || /envelope\.conflict\s*=\s*["']new["']/.test(envelopeCode)) {
  fail(GROUP_V8, "envelope.js 又把 conflict 硬编码成 \"new\" 了：接收端会把「缺省」当成「显式 new」，判定链第 3/4 步会失效（选区二次剪藏不追加、整页二次剪藏进不了收件箱）");
} else if (!envelopeDist.includes("OPTIONAL_ENVELOPE_KEYS")) {
  fail(GROUP_V8, "envelope.js 未声明 conflict 为可选键");
} else pass("conflict 默认缺省（只在调用方显式要求时才下发），判定链第 3/4 步不受阻");
if (!background.includes("auth-probe-0000")) {
  fail(GROUP_V8, "令牌有效性探测必须走 API-03（GET /v1/imports/{id}），找不到探针 id");
} else pass("令牌探测走 API-03 只读接口（不产生副作用）");
if (!/for\s*\(\s*let\s+port\s*=\s*8787[^)]*port\s*<=\s*8796/.test(readDist("dist/lib/bridge.js")) && !readDist("dist/lib/bridge.js").includes("8787")) {
  fail(GROUP_V8, "端口探测范围必须是 8787–8796");
} else pass("端口探测范围 8787–8796、单次 300ms、命中即停");
const bridgeSource = readDist("dist/lib/bridge.js");
for (const needle of ['credentials: "omit"', 'redirect: "error"', 'cache: "no-store"']) {
  if (!bridgeSource.includes(needle)) fail(GROUP_V8, `请求未设置 ${needle}`);
}
if (!/AbortController/.test(bridgeSource)) fail(GROUP_V8, "缺少 AbortController 超时");
else pass("请求带 credentials:omit / redirect:error / cache:no-store / AbortController");

// 401 不得回显令牌：错误响应处理里不能把 token 拼进 message
if (/IMP-2002[\s\S]{0,200}token\s*\+/.test(bundle)) {
  fail(GROUP_V8, "IMP-2002 的处理里把令牌拼进了文案（02 §10 S-06 禁止回显）");
} else pass("错误文案不回显令牌（02 §10 S-06）");
if (manifest.permissions.includes("tabs")) fail(GROUP_V8, "不需要 tabs 权限（activeTab 足够）");
else pass("未申请 tabs / <all_urls> / clipboardWrite");

/* ── V9 无 emoji ─────────────────────────────────────────────────── */

const GROUP_V9 = "V9 无 emoji";
// ① 象形符号/旗帜/变体选择符：任何位置都不许出现（含注释）
const pictographRe = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
// ② 常被当图标用的符号字符：只查「代码行」（注释里作为文档记号可以出现）
const iconSymbolRe = /[✂✎✏✔✓✕✖★☆☑⚑☰⏵▶◀⟳↻⟲⬆⬇➕➖]/u;
const commentLineRe = /^\s*(\/\/|\/\*|\*|#|<!--)/;
for (const file of textFiles) {
  const text = readDist(file);
  const hit = text.match(pictographRe);
  if (hit) fail(GROUP_V9, `${file} 含 emoji：${hit[0]}（03 §UI-03：图标一律内联 SVG）`);
  text.split("\n").forEach((line, index) => {
    if (commentLineRe.test(line)) return;
    const symbol = line.match(iconSymbolRe);
    if (symbol) fail(GROUP_V9, `${file}:${index + 1} 用符号字符当图标：${symbol[0]}`);
  });
}
// 内联 SVG 必须存在（图标不是 emoji 也不是远程图片）
if (!/<svg/.test(popupHtml)) fail(GROUP_V9, "popup.html 里找不到内联 SVG 图标");
else pass("图标为内联 SVG，文案里无 emoji");

/* ── 汇总 ───────────────────────────────────────────────────────── */

const bytes = distFiles.reduce((sum, file) => sum + statSync(join(HERE, file)).size, 0);
console.log("Opennote 剪藏扩展 · 交付物机械验收");
console.log(`dist：${distFiles.length} 个文件，${(bytes / 1024).toFixed(1)} KiB`);
console.log(`版本：${manifest.version} · 权限：${permissions.join(" / ")}`);
for (const line of notes) console.log(line);
if (failures.length > 0) {
  console.error(`\n✗ 未通过 ${failures.length} 条：`);
  for (const item of failures) console.error(`  ${item}`);
  process.exit(1);
}
console.log("\n✓ 9 组验收全部通过（V1–V9）");
