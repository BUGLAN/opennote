/**
 * extension/ 的**机械化验收**（零依赖）。跑：`node verify.mjs`
 *
 * 与 tests/ 的分工：tests 验证「逻辑对不对」，verify 验证「交付物能不能装、装完安不安全」。
 * 一共 12 组断言，任何一条不过就 exit 1 并打印具体文件与行号：
 *  V1 manifest 基本盘（MV3 / service_worker / 最小权限 / 无 content_scripts）
 *  V2 manifest 引用到的每个文件都真实存在
 *  V3 全 dist 零远程地址（只允许 127.0.0.1 / localhost，以及 SVG 命名空间）
 *  V4 零 eval / new Function / 字符串注入 / 内联脚本
 *  V5 tokens.css 与仓库根逐字节一致（SHA-256 比对），且 BUILD-INFO 记录一致
 *  V6 **0 个新设计令牌**：dist 里新增的自定义属性声明必须为 0
 *  V7 逐字文案清单（03 §UI-01 + mockup + 00 §6.14㉗㉘）全部出现在交付物里
 *  V8 契约硬约束：不发 overwrite、探测走 API-03、端口范围 8787–8796、401 不泄漏令牌
 *  V9 中文文案里没有 emoji
 *  V10 模板白名单（00 §6.14 ㉙）：变量/过滤器/触发器/behavior 白名单、priority 降序、内置 3 个、
 *      条件只认一层 {{#if}}（`{{#each}}`/`{{else}}`/嵌套一律**原样输出**并在这里报错）
 *  V11 高亮形态（00 §6.14 ㉚）：键名、`## 高亮` 小节形态、空高亮不生成、按 URL 分组
 *  V12 三区（00 §6.14 ㉘）：正文/高亮/属性都在交付物里，且 ⋯ 菜单里没有「剪藏到收件箱」
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// 0.3.1（00 §6.15㉝）：`Alt+Shift+S` 的语义由「剪藏选区」改为「进入元素选择模式」，
// 所以 `clip-selection` 命令必须**消失**，取而代之的是 `pick-element`。
if (!manifest.commands || !manifest.commands["pick-element"] || !manifest.commands["clip-page"]) {
  fail(GROUP_V1, "缺少 commands：pick-element / clip-page（Alt+Shift+S 现在是元素选择）");
} else if (manifest.commands["clip-selection"]) {
  fail(GROUP_V1, "`clip-selection` 命令必须删除（00 §6.15㉝：选区剪藏不再是入口）");
} else if (manifest.commands["pick-element"].suggested_key?.default !== "Alt+Shift+S") {
  fail(GROUP_V1, `pick-element 的默认快捷键必须是 Alt+Shift+S，实际 ${JSON.stringify(manifest.commands["pick-element"].suggested_key)}`);
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
if (manifest.options_ui && manifest.options_ui.page) referenced.push(manifest.options_ui.page);
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

// 选项页（C06「管理模板…」的落点）内部的引用
if (manifest.options_ui && manifest.options_ui.page) {
  const optionsHtml = readDist(`dist/${manifest.options_ui.page}`);
  const optionsDir = dirname(join(DIST, manifest.options_ui.page));
  let optionsRefs = 0;
  for (const match of optionsHtml.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (target.startsWith("data:") || target.startsWith("#")) continue;
    optionsRefs += 1;
    if (!existsSync(join(optionsDir, target))) fail(GROUP_V2, `options.html 引用的 ${target} 不存在`);
  }
  if (optionsRefs === 0) fail(GROUP_V2, "options.html 没有引用任何样式/脚本，像是空壳");
  pass(`options.html 的 ${optionsRefs} 个 link/script 引用全部存在`);
} else {
  fail(GROUP_V2, "manifest 缺少 options_ui（模板管理页是 C06「管理模板…」的落点）");
}

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
let placeholderHits = 0;
for (const file of textFiles) {
  // `placeholder="https://example.com/…"` 是 03 §UI-01 C36 冻结的**示例占位符**（输入框里的灰字示例），
  // 浏览器不会去请求它 —— 只有它允许出现 example.com，其余一律禁止。
  const text = readDist(file)
    .replace(/placeholder="[^"]*"/g, () => {
      placeholderHits += 1;
      return 'placeholder=""';
    })
    .replace(/placeholder:\\?"[^"]*\\?"/g, () => {
      placeholderHits += 1;
      return 'placeholder:""';
    });
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
if (remoteHits === 0) pass(`全部 ${textFiles.length} 个文本产物无远程地址（仅允许回环与 SVG 命名空间；示例占位符已排除 ${placeholderHits} 处）`);

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
  "未配置令牌",
  "未连接",
  "离线，已暂存",
  // S2–S12 主文案
  "已剪藏到「",
  "已在笔记中（未重复入库）。",
  "没有选中任何文字。在页面上选一段，或把来源切到「整页正文」。",
  "这个页面不允许插件读取内容。",
  "换个普通网页再试。",
  "已选中 ",
  "字 · ",
  "约 ",
  "字 · 预计 1 篇笔记",
  "发布于 ",
  "剪藏于 ",
  "用逗号分隔，可留空",
  "已保留你填的标题与标签。",
  "连接被拒说明本机没有在监听，不是令牌问题。",
  "Opennote 没有在运行，内容已暂存在插件里，打开 Opennote 后会自动补投。",
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
  "连接",
  "用当前选区新建标签…",
  "复制 Markdown",
  "打开 Opennote",
  "插件设置",
  // 00 §6.14 ㉗ 冻结文案（三条，逐字）
  "Opennote 没有在运行。请先打开 Opennote，再试一次。",
  "Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。",
  // 00 §6.14 ㉘：进收件箱的冻结回执
  "已进入收件箱等待确认：",
  // 三区（㉘）
  "正文",
  "高亮",
  "属性",
  "模板",
  "按网址自动匹配",
  "已手动选择",
  "管理模板…",
  "不使用模板",
  "追加到笔记",
  "已高亮 ",
  " 处",
  "清除本页全部高亮",
  "清除这条高亮",
  "默认底色",
  "强调底色",
  "写一句批注（可不填）",
  "加批注",
  "编辑批注",
  "删除批注",
  "保存",
  "取消",
  "清除这一页的全部高亮？",
  "留下",
  "这些值会写进笔记的来源信息里。改过之后不会被模板再改回去。",
  "按模板更新",
  "标题不能为空。",
  "网址要以 http:// 或 https:// 开头。",
  "发布时间要写成 2026-09-21 或 2026-09-21T15:04:05+08:00 这样的格式。",
  "追加目标要写成工作区里的相对路径，并以 .md 结尾。",
  "部分标签不符合规则，已忽略。",
  "填了目标笔记，这次剪藏会以「追加」的方式提交；没填就交给 Opennote 自己判断。",
  "高亮会一起写进正文，出处在「高亮」区里可以再看。",
  "这个页面上还没有高亮。在页面上选中文字，点右键菜单里的「高亮这段文字」。",
  "改标题",
  // 元素选择（UI-16，0.3.1 取代 UI-02 的浮标；00 §6.15㉝ 逐字）
  "选择页面元素",
  "重新选择",
  "正在页面上等待你点选…",
  "在页面上点一下要剪的部分；按 Esc 取消。",
  "还没选元素。点上面的「选择页面元素」，在页面上点一下要剪的那块。",
  "已选择 ",
  "这个页面不能选择元素：只有普通网页（http 或 https）支持。换个普通网页再试。",
  "已选好这一块。点扩展图标看预览。",
  "知道了",
  "这块是嵌入的内容，只能剪到它的外框，里面的内容读不到。",
  // 令牌块（㉞：配对整体删除；03 §UI-01 C70/C72/C73/C74）
  "粘贴访问令牌",
  "令牌在 Opennote 的「设置 · 文件 → 导入与接口」里点「复制令牌」拿到，粘贴到这里。",
  "重新粘贴令牌",
  "先粘贴访问令牌。",
  "令牌要以 opn_ 开头。",
  "令牌要是 47 个字符：opn_ 加 43 位。",
  "令牌里有不认识的字符，请重新复制一次。",
  "令牌已保存。",
  "换一个令牌：在 Opennote 里重新生成，然后回来粘贴。",
  "令牌长期有效。能读到剪贴板或插件存储的程序都能拿到它，从而往 Opennote 里导入内容；不过本地接口只提供导入，不提供读取和删除。",
  "清除本地令牌？",
  "清除后这个客户端就不能再往 Opennote 导入，需要重新复制粘贴令牌。",
  "清除",
  "留下",
  "来源未被允许。本地接口只接受浏览器扩展与本机程序发来的请求。",
  // 右键菜单最终两项（03 §UI-03）
  "剪藏整页正文",
  "高亮这段文字",
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

/* ── V10 模板白名单（00 §6.14 ㉙） ─────────────────────────────────── */

const GROUP_V10 = "V10 模板";
const templatesSource = existsSync(join(DIST, "lib/templates.js")) ? readDist("dist/lib/templates.js") : "";
if (!templatesSource) {
  fail(GROUP_V10, "缺少 dist/lib/templates.js");
} else {
  const T = await import(pathToFileURL(join(DIST, "lib", "templates.js")).href);

  const expectVariables = ["title", "url", "site", "author", "publishedAt", "capturedAt", "selection", "highlights", "content", "wordCount"];
  if (JSON.stringify([...T.TEMPLATE_VARIABLES]) !== JSON.stringify(expectVariables)) {
    fail(GROUP_V10, `变量白名单与 ㉙ 不一致：${[...T.TEMPLATE_VARIABLES].join("/")}`);
  } else pass(`模板变量白名单 10 个与 ㉙ 逐字一致`);

  const expectFilters = ["date", "upper", "lower", "trim", "truncate"];
  if (JSON.stringify([...T.TEMPLATE_FILTERS]) !== JSON.stringify(expectFilters)) {
    fail(GROUP_V10, `过滤器白名单与 ㉙ 不一致：${[...T.TEMPLATE_FILTERS].join("/")}`);
  } else pass("过滤器白名单 date/upper/lower/trim/truncate");

  if (JSON.stringify([...T.TRIGGER_TYPES]) !== JSON.stringify(["url", "domain", "path"])) {
    fail(GROUP_V10, "触发器类型白名单必须是 url/domain/path");
  }
  if (JSON.stringify([...T.TEMPLATE_BEHAVIORS]) !== JSON.stringify(["new", "append", "inbox"])) {
    fail(GROUP_V10, "behavior 白名单必须是 new/append/inbox");
  }
  if (JSON.stringify([...T.PROPERTY_KEYS]) !== JSON.stringify(["title", "source.url", "source.title", "source.site", "author", "publishedAt", "tags", "target.folder"])) {
    fail(GROUP_V10, `属性面板白名单与 ㉘ 的 8 个字段不一致：${[...T.PROPERTY_KEYS].join("/")}`);
  } else pass("触发器/behavior/属性面板白名单与 ㉘㉙ 一致");

  // 内置 3 个开箱模板
  const builtins = T.BUILTIN_TEMPLATES;
  if (!Array.isArray(builtins) || builtins.length !== 3) {
    fail(GROUP_V10, `内置模板必须是 3 个，实际 ${Array.isArray(builtins) ? builtins.length : "不是数组"}`);
  } else {
    const names = builtins.map((template) => template.name).join("/");
    const domains = builtins.flatMap((template) => template.triggers.map((trigger) => trigger.value)).join(" ");
    for (const wanted of ["默认", "论文", "视频"]) {
      if (!names.includes(wanted)) fail(GROUP_V10, `内置模板缺少「${wanted}」`);
    }
    for (const wanted of ["arxiv.org", "doi.org", "youtube.com", "bilibili.com"]) {
      if (!domains.includes(wanted)) fail(GROUP_V10, `内置模板缺少触发域名 ${wanted}`);
    }
    if (!/默认\/论文\/视频/.test(names)) fail(GROUP_V10, `内置模板名不是 默认/论文/视频：${names}`);
    else pass("内置 3 个模板：默认 / 论文(arxiv.org,doi.org) / 视频(youtube.com,bilibili.com)");

    // 内置模板自身必须过校验（含模板文本的越界语法检查）
    for (const template of builtins) {
      const problems = T.validateTemplate(template);
      if (problems.length) fail(GROUP_V10, `内置模板「${template.name}」不合法：${problems.join("；")}`);
    }
    if (builtins.length === 3) pass("3 个内置模板均通过 validateTemplate（含越界语法扫描）");
  }

  // priority 降序 + triggers 命中
  const sample = [
    { id: "low", name: "低", triggers: [{ type: "domain", value: "example.com" }], priority: 1 },
    { id: "high", name: "高", triggers: [{ type: "domain", value: "example.com" }], priority: 9 },
  ];
  const picked = T.matchTemplate(sample, "https://example.com/a");
  if (!picked.template || picked.template.id !== "high") fail(GROUP_V10, "priority 降序没有生效（应选 priority 9）");
  else pass("priority 降序：同触发器时高优先级模板生效");

  if (T.matchTemplate(sample, "https://other.test/x").fallback !== true) fail(GROUP_V10, "无命中时必须回退到内置默认模板");
  else pass("无命中回退内置默认模板（fallback=true）");

  const byPath = T.matchTemplate([{ id: "p", name: "路径", triggers: [{ type: "path", value: "/docs/" }], priority: 3 }], "https://x.test/docs/a");
  if (!byPath.template || byPath.template.id !== "p") fail(GROUP_V10, "path 触发器未命中");
  const byUrl = T.matchTemplate([{ id: "u", name: "网址", triggers: [{ type: "url", value: "https://x.test/*/b" }], priority: 3 }], "https://x.test/docs/b");
  if (!byUrl.template || byUrl.template.id !== "u") fail(GROUP_V10, "url 通配触发器未命中");
  if (byPath.template && byUrl.template) pass("url / domain / path 三种触发器都能命中");

  // 变量与过滤器
  const rendered = T.renderTemplate("{{title|upper|truncate:5}}", { title: "abcdefg" });
  if (rendered !== "ABCDE…") fail(GROUP_V10, `过滤器链渲染不对：${rendered}`);
  const dated = T.renderTemplate("{{capturedAt|date:YYYY-MM-DD}}", { capturedAt: "2026-03-04T05:06:07+08:00" });
  if (dated !== "2026-03-04") fail(GROUP_V10, `|date:YYYY-MM-DD 渲染不对：${dated}`);
  const trimmed = T.renderTemplate("{{author|trim}}", { author: "  张 三  " });
  if (trimmed !== "张 三") fail(GROUP_V10, `|trim 渲染不对：${trimmed}`);
  const lowered = T.renderTemplate("{{site|lower}}", { site: "Example.COM" });
  if (lowered !== "example.com") fail(GROUP_V10, `|lower 渲染不对：${lowered}`);
  if (rendered === "ABCDE…" && dated === "2026-03-04" && trimmed === "张 三" && lowered === "example.com") {
    pass("变量渲染 + 过滤器链（upper/truncate/date/trim/lower）逐条正确");
  }

  // 极简 {{#if}}：只认一层，truthy 才输出；越界语法原样输出且被 scanTemplate 报出来
  const ifTrue = T.renderTemplate("{{#if author}}作者：{{author}}{{/if}}", { author: "张三" });
  const ifFalse = T.renderTemplate("{{#if author}}作者：{{author}}{{/if}}", { author: "   " });
  if (ifTrue !== "作者：张三") fail(GROUP_V10, `{{#if}} 真值分支不对：${ifTrue}`);
  if (ifFalse !== "") fail(GROUP_V10, `{{#if}} 空值应整段消失：${ifFalse}`);
  const eachSource = "{{#each tags}}{{name}}{{/each}}";
  if (T.renderTemplate(eachSource, { tags: "x" }) !== eachSource) fail(GROUP_V10, "{{#each}} 必须原样输出（不做循环）");
  if (T.scanTemplate(eachSource).issues.length === 0) fail(GROUP_V10, "{{#each}} 没有被 scanTemplate 报为越界语法");
  const nestedSource = "{{#if author}}{{#if title}}x{{/if}}{{/if}}";
  if (T.scanTemplate("{{#if author}}a{{/if}}{{else}}b").issues.length === 0) fail(GROUP_V10, "{{else}} 没有被报为越界");
  if (T.scanTemplate(nestedSource).issues.length === 0) fail(GROUP_V10, "嵌套 {{#if}} 没有被报为越界");
  const unknownVar = T.scanTemplate("{{nope}}");
  if (!unknownVar.issues.some((issue) => issue.includes("未知变量"))) fail(GROUP_V10, "未知变量没有被报出来");
  if (!T.scanTemplate("{{title|weird}}").issues.some((issue) => issue.includes("未知过滤器"))) fail(GROUP_V10, "未知过滤器没有被报出来");
  if (T.renderTemplate("{{nope}}", {}) !== "{{nope}}") fail(GROUP_V10, "未知变量必须原样输出，不得静默清空");
  if (T.scanTemplate(eachSource).issues.length && T.scanTemplate(nestedSource).issues.length) {
    pass("极简 {{#if}} 一层生效；{{#each}}/{{else}}/嵌套/未知变量/未知过滤器一律原样输出并被报出");
  }

  // 模板绝不变出 conflict: "new"（00 §6.13⑳ 红线），inbox 由应用侧决定
  const ctx = T.templateContext({ title: "T", url: "https://arxiv.org/abs/1", site: "arxiv.org", content: "正文" });
  const newTpl = T.applyTemplate({ id: "a", name: "a", behavior: "new", noteNameFormat: "{{title}}" }, ctx);
  const inboxTpl = T.applyTemplate({ id: "b", name: "b", behavior: "inbox" }, ctx);
  const appendTpl = T.applyTemplate({ id: "c", name: "c", behavior: "append", appendTo: "笔记/x.md" }, ctx);
  if (newTpl.conflict !== null) fail(GROUP_V10, `behavior=new 不得下发 conflict，实际 ${newTpl.conflict}`);
  if (inboxTpl.conflict !== null) fail(GROUP_V10, "behavior=inbox 由应用侧设置决定，插件不得代发 conflict");
  if (appendTpl.conflict !== "append") fail(GROUP_V10, "behavior=append 且有落点时应下发 conflict=append");
  if (appendTpl.notePath !== "笔记/x.md") fail(GROUP_V10, "behavior=append 的 appendTo 应写进 target.notePath");
  if (newTpl.conflict === null && inboxTpl.conflict === null && appendTpl.conflict === "append") {
    pass("模板 behavior 不产生 conflict:new；只有 append+落点才下发 conflict:append");
  }

  // 导入/导出 JSON 往返
  const exported = T.exportTemplates([{ id: "rt", name: "往返", triggers: [{ type: "domain", value: "rt.test" }], priority: 2 }], { includeBuiltins: false });
  const roundTrip = T.importTemplates(exported);
  if (roundTrip.templates.length !== 1 || roundTrip.problems.length) fail(GROUP_V10, `导出再导入不往返：${roundTrip.problems.join("；")}`);
  if (T.importTemplates('{"templates":[{"id":"bad","name":"bad","properties":{"nope":"{{title}}"}}]}').templates.length !== 0) {
    fail(GROUP_V10, "properties 白名单外的键必须被拒绝");
  } else pass("模板导入/导出 JSON 往返一致，白名单外的键被拒绝");
}

/* ── V11 高亮形态（00 §6.14 ㉚） ───────────────────────────────────── */

const GROUP_V11 = "V11 高亮";
if (!existsSync(join(DIST, "lib/highlights.js")) || !existsSync(join(DIST, "content/highlight.js"))) {
  fail(GROUP_V11, "缺少 dist/lib/highlights.js 或 dist/content/highlight.js");
} else {
  const H = await import(pathToFileURL(join(DIST, "lib", "highlights.js")).href);
  if (H.HIGHLIGHTS_KEY !== "opennote.highlights.v1") fail(GROUP_V11, `存储键必须是 opennote.highlights.v1，实际 ${H.HIGHLIGHTS_KEY}`);
  if (H.HIGHLIGHT_SECTION_TITLE !== "## 高亮") fail(GROUP_V11, `小节标题必须是「## 高亮」，实际 ${H.HIGHLIGHT_SECTION_TITLE}`);
// 两档底色（Lead 0.3.1 裁定 ②）：新增设计令牌 0，所以颜色只能落在这两档上
if (JSON.stringify(H.HIGHLIGHT_COLORS) !== JSON.stringify(["yellow", "accent"])) {
  fail(GROUP_V11, `高亮底色必须恰好两档 ["yellow","accent"]，实际 ${JSON.stringify(H.HIGHLIGHT_COLORS)}`);
} else if (H.HIGHLIGHT_LEGACY_COLORS.some((color) => H.HIGHLIGHT_COLORS.includes(color))) {
  fail(GROUP_V11, "历史四色不得回来当第三档");
} else if (H.HIGHLIGHT_LEGACY_COLORS.map((color) => H.highlightTier(color)).join() !== "yellow,yellow,yellow,yellow") {
  fail(GROUP_V11, "历史四色必须一律按 yellow 渲染");
} else if (H.highlightTier("accent") !== "accent") {
  fail(GROUP_V11, "accent 必须渲染成 accent");
} else pass("高亮两档：yellow → --mark，accent → --accent-soft（历史四色保留原值、按 yellow 渲染）");

  // 空高亮不生成小节
  const untouched = H.withHighlightSection("正文内容\n", []);
  if (untouched !== "正文内容\n") fail(GROUP_V11, `空高亮必须原样返回正文，实际：${JSON.stringify(untouched)}`);
  if (H.highlightSection([]) !== "") fail(GROUP_V11, "空高亮的 highlightSection 必须是空串");
  else pass("空高亮：不生成「## 高亮」小节，正文一字不改");

  // 形态（03 §UI-14「写入正文的形态」逐字节）：`> 摘录`、换行折叠成空格、有批注时空一行再 `— 批注`
  const section = H.highlightSection([
    { text: "第一条摘录", note: "我的批注" },
    { text: "第二条摘录" },
    { text: "多行\n摘录" },
  ]);
  if (!section.startsWith("## 高亮\n\n")) fail(GROUP_V11, `小节必须以「## 高亮」开头：${JSON.stringify(section.slice(0, 20))}`);
  if (!section.includes("> 第一条摘录\n\n— 我的批注")) fail(GROUP_V11, "有批注时必须写成 `> 摘录` + 空行 + `— 批注`");
  if (!section.includes("> 第二条摘录")) fail(GROUP_V11, "无批注时只写 `> 摘录`");
  if (!section.includes("> 多行 摘录")) fail(GROUP_V11, "摘录内部的换行必须折叠成单个空格（03 §UI-14）");
  if (/> 多行\n/.test(section)) fail(GROUP_V11, "不得逐行加 `> `（那是另一种形态，03 冻结的是折叠成空格）");
  if (section.split("\n").filter((line) => line.startsWith("— ")).length !== 1) {
    fail(GROUP_V11, "批注行只能出现在有批注的那一条下面");
  } else {
    pass("高亮小节形态：`> 摘录`（换行折叠成空格）+ 空行 + `— 批注`");
  }

  // 追加到正文末尾
  const merged = H.withHighlightSection("正文内容", [{ text: "摘录" }]);
  if (!merged.startsWith("正文内容\n\n## 高亮")) fail(GROUP_V11, `高亮必须追加在正文末尾：${JSON.stringify(merged.slice(0, 30))}`);
  else pass("高亮追加在正文末尾（正文内容保留在前）");

  // 按 URL 分组 + 空文本不算高亮
  const first = H.addHighlight(H.defaultHighlights(), { url: "https://a.test/x#frag", text: "A 的摘录" });
  const second = H.addHighlight(first.store, { url: "https://a.test/x", text: "A 的第二条" });
  const third = H.addHighlight(second.store, { url: "https://b.test/y", text: "B 的摘录" });
  const empty = H.addHighlight(third.store, { url: "https://a.test/x", text: "   " });
  if (empty.added !== false) fail(GROUP_V11, "空白文本不得记成高亮");
  if (H.listHighlights(third.store, "https://a.test/x#frag").length !== 2) fail(GROUP_V11, "同 URL（忽略 hash）必须归到同一组");
  if (H.listHighlights(third.store, "https://b.test/y").length !== 1) fail(GROUP_V11, "不同 URL 必须分开分组");
  if (H.countHighlights(third.store) !== 3) fail(GROUP_V11, `总计应为 3 条，实际 ${H.countHighlights(third.store)}`);
  const removed = H.removeHighlight(third.store, "https://a.test/x", H.listHighlights(third.store, "https://a.test/x")[0].id);
  if (!removed.removed || H.listHighlights(removed.store, "https://a.test/x").length !== 1) fail(GROUP_V11, "删除单条高亮失败");
  const { store: clearedStore } = H.clearHighlights(removed.store, "https://a.test/x");
  if (H.listHighlights(clearedStore, "https://a.test/x").length !== 0) fail(GROUP_V11, "清空本页高亮失败");
  if (empty.added === false && H.countHighlights(third.store) === 3 && H.listHighlights(removed.store, "https://a.test/x").length === 1) {
    pass("按 URL 分组（hash 归一）、空文本不计、单条删除与整页清空都正确");
  }

  // 页内脚本必须是非破坏性的、且不回显远程地址
  const highlightSource = readDist("dist/content/highlight.js");
  for (const forbidden of ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write"]) {
    if (highlightSource.includes(forbidden)) fail(GROUP_V11, `content/highlight.js 用 ${forbidden} 改页面 DOM（高亮必须非破坏性）`);
  }
  if (!highlightSource.includes("CSS.highlights") && !/CSS\s*&&\s*[^\n]*highlights/.test(highlightSource)) {
    fail(GROUP_V11, "content/highlight.js 未使用 CSS Highlight API 做视觉标记");
  } else pass("页内高亮不改 DOM（CSS Highlight API），无 innerHTML/document.write");

  // 高亮不得改变 source.selection（判定链第 3/4 步的输入）
  if (!/selection:\s*mode === "selection"/.test(background)) {
    fail(GROUP_V11, "background 的 source.selection 必须只由剪藏范围决定，不得掺入高亮");
  } else pass("source.selection 只由剪藏范围决定（高亮不参与判定链输入）");
}

/* ── V12 三区 + ⋯ 菜单无收件箱项（00 §6.14 ㉘） ────────────────────── */

const GROUP_V12 = "V12 三区";
const popupJs = readDist("dist/popup/popup.js");
for (const region of ["body", "highlight", "property"]) {
  if (!popupHtml.includes(`data-region="${region}"`)) fail(GROUP_V12, `popup.html 缺少三区按钮 data-region="${region}"`);
}
if (!popupHtml.includes('id="regionHighlight"') || !popupHtml.includes('id="regionProps"')) {
  fail(GROUP_V12, "popup.html 缺少高亮区 / 属性区容器");
}
if (!popupHtml.includes('id="sourceSwitch"') || !popupHtml.includes('data-mode="selection"') || !popupHtml.includes('data-mode="page"')) {
  fail(GROUP_V12, "popup.html 缺少正文区的来源开关（选中片段 / 整页正文）");
}
if (!popupHtml.includes('id="template"')) fail(GROUP_V12, "popup.html 缺少模板选择器");
if (!popupHtml.includes('id="notePath"')) fail(GROUP_V12, "popup.html 缺少「追加到指定笔记」选择器");
const propertyFields = ["propTitle", "propUrl", "propSourceTitle", "propSite", "propAuthor", "propPublished", "tags", "folder"];
const missingFields = propertyFields.filter((id) => !popupHtml.includes(`id="${id}"`));
if (missingFields.length) fail(GROUP_V12, `属性面板缺少字段：${missingFields.join(", ")}`);
if (!missingFields.length) pass("三区 + 来源开关 + 模板选择器 + 属性面板 8 个字段 + 追加落点都在 popup.html 里");

// 「剪藏到收件箱」这个置灰死按钮必须彻底消失（应用侧设置成为唯一真源）。
// 注释里可以解释「为什么删掉它」，所以先剥掉 HTML 注释再匹配——只看真正会渲染的节点。
const popupHtmlNoComments = popupHtml.replace(/<!--[\s\S]*?-->/g, "");
if (/data-action="inbox"/.test(popupHtmlNoComments)) fail(GROUP_V12, "⋯ 菜单里还留着 data-action=\"inbox\"（剪藏到收件箱）");
if (popupHtmlNoComments.includes("剪藏到收件箱") || popupJs.includes("剪藏到收件箱")) {
  fail(GROUP_V12, "交付物里还出现「剪藏到收件箱」字样（00 §6.14 ㉘：删掉那个 disabled 项）");
} else pass("⋯ 菜单里没有「剪藏到收件箱」（进收件箱由应用侧设置决定）");

// pending 回执的冻结文案
if (!popupJs.includes("INBOX_PENDING")) fail(GROUP_V12, "popup 没有处理 receipt.status === \"pending\" 的进收件箱分支");
if (!readDist("dist/lib/state.js").includes("已进入收件箱等待确认：")) {
  fail(GROUP_V12, "缺少冻结文案「已进入收件箱等待确认：{标题}。」");
}
if (popupJs.includes("INBOX_PENDING") && readDist("dist/lib/state.js").includes("已进入收件箱等待确认：")) {
  pass("pending 回执走 INBOX_PENDING 状态，文案逐字为「已进入收件箱等待确认：{标题}。」");
}

// 提交时必须把三区的数据都送出去（模板 / 属性 / 追加落点）
for (const key of ["templateId", "props", "dirty"]) {
  if (!popupJs.includes(`${key}:`)) fail(GROUP_V12, `popup 提交时没有带上 ${key}`);
}
if (!background.includes("opennote:preview")) fail(GROUP_V12, "background 缺少 opennote:preview（预览与提交必须共用同一条合成路径）");
else pass("popup 提交带上 templateId/props/dirty；预览与提交共用 background 的同一合成路径");

// ⋯ 菜单必须**恰好**是 03 §UI-01 C63 的 6 项（少一项多做一项都算偏；0.3.1 起第 6 项是「清除本地令牌」）
const menuButtons = Array.from(popupHtmlNoComments.matchAll(/<button[^>]*role="menuitem"[^>]*data-action="([^"]+)"[^>]*>([^<]*)</g));
const menuItems = menuButtons.map((match) => match[1]);
const menuLabels = menuButtons.map((match) => match[2]);
const MENU_EXPECTED = ["tag-from-selection", "copy", "stage", "open-settings", "settings", "forget"];
const MENU_LABELS = ["用当前选区新建标签…", "复制 Markdown", "暂存在插件里", "打开 Opennote", "插件设置", "清除本地令牌"];
if (JSON.stringify(menuItems) !== JSON.stringify(MENU_EXPECTED)) {
  fail(GROUP_V12, `⋯ 菜单应恰好是 C63 的 6 项 ${JSON.stringify(MENU_EXPECTED)}，实际 ${JSON.stringify(menuItems)}`);
} else if (JSON.stringify(menuLabels) !== JSON.stringify(MENU_LABELS)) {
  fail(GROUP_V12, `⋯ 菜单文案必须逐字照 C63：${JSON.stringify(MENU_LABELS)}，实际 ${JSON.stringify(menuLabels)}`);
} else pass(`⋯ 菜单恰好 6 项且文案逐字照 C63：${menuLabels.join(" / ")}`);

/* ── V14 元素选择（00 §6.15㉝ / 03 §UI-16） ──────────────────────── */

/** V14/V15 用：剥掉行注释与块注释后再扫，避免「注释里提到某个 API」被当成真的用了它。 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const GROUP_V14 = "V14 元素选择";
const pickerSource = existsSync(join(DIST, "content/picker.js")) ? readDist("dist/content/picker.js") : "";
if (!pickerSource) {
  fail(GROUP_V14, "缺少 dist/content/picker.js（popup 的「选择页面元素」没有落点）");
} else {
  // 只准加一层覆盖层（㉝ 原话「不得改页面 DOM、不得注入持久样式」）
  const pickerGuards = [
    ['attachShadow({ mode: "closed" })', "覆盖层必须是 closed 影子根"],
    ["opennote-pick-host", "宿主元素 id 必须是 opennote-pick-host"],
    ["pointer-events:none", "覆盖层必须 pointer-events:none（否则吃页面自己的 hover/click）"],
    ["preventDefault()", "点击必须 preventDefault"],
    ["stopPropagation()", "点击必须 stopPropagation"],
    ["stopImmediatePropagation()", "点击必须 stopImmediatePropagation"],
    ['"Escape"', "Esc 必须能取消"],
    ["host.remove()", "退出时必须移除覆盖层"],
    ["getBoundingClientRect()", "轮廓位置必须来自 getBoundingClientRect()"],
  ];
  const pickerCode = stripComments(pickerSource); // 注释里可以写「不碰 document.body.style.*」，只看真实代码
  const pickerMissing = pickerGuards.filter(([needle]) => !pickerCode.includes(needle)).map(([, why]) => why);
  const forbidden = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "document.body.style", "classList.add", "selectionchange"]
    .filter((needle) => pickerCode.includes(needle));
  if (pickerMissing.length) {
    for (const why of pickerMissing) fail(GROUP_V14, why);
  } else if (forbidden.length) {
    for (const needle of forbidden) fail(GROUP_V14, `content/picker.js 不得出现 ${needle}（会改动宿主页面 / 退回选区逻辑）`);
  } else if (existsSync(join(DIST, "content/float.js"))) {
    fail(GROUP_V14, "content/float.js 仍在 dist 里：选区浮标（UI-02）在 0.3.1 已删除");
  } else {
    pass("元素选择：closed 影子根 + 覆盖层 only + 点击三件套 + Esc + 退出即移除（浮标已删除）");
  }
  // 跟随标签的逐字骨架：`{标签名} · {宽} × {高}`
  if (!/\$\{element\.tagName\.toLowerCase\(\)\} · \$\{width\} × \$\{height\}/.test(pickerSource)) {
    fail(GROUP_V14, "跟随标签必须逐字写成 `{标签名} · {宽} × {高}`（03 §UI-16/C01）");
  } else pass("跟随标签格式逐字：`{标签名} · {宽} × {高}`（整数像素、不写单位）");
}

/* ── V15 去配对（00 §6.15㉞㊱） ──────────────────────────────────── */

const GROUP_V15 = "V15 去配对";
// 用户可见文案里不许再出现配对这个概念（㊱）。`IMP-2004` 是**留档**的废码，只允许出现在码表里。
const pairingBan = [
  ["配对码", "「配对码」这个说法整体删除（㊱）"],
  ["配对新客户端", "设置面板的「配对新客户端」在 0.3.1 改为「复制令牌」（㊱）"],
  ["6 位", "不再有 6 位码"],
  ["120 秒", "不再有 120 秒有效期"],
  ["一次性", "不再有「一次性」令牌"],
  ["轮换", "不再有「配对成功即轮换令牌」"],
];
const userFacing = textFiles
  .filter((file) => file.endsWith(".html") || file.endsWith(".js"))
  .map((file) => ({ file, text: stripComments(readDist(file)) }))
  // 码表也一起扫：Lead 0.3.1 裁定后 IMP-2004 的文案已从表里删除，任何残留都是漂移
  .filter(() => true);
const pairingHits = [];
for (const { file, text } of userFacing) {
  for (const [needle, why] of pairingBan) {
    if (text.includes(needle)) pairingHits.push(`${file} 含「${needle}」：${why}`);
  }
}
if (pairingHits.length) {
  for (const hit of pairingHits.slice(0, 5)) fail(GROUP_V15, hit);
} else pass("dist 里除码表留档外 0 处配对相关文案（配对码 / 6 位 / 120 秒 / 一次性 / 轮换）");

// 令牌格式：`opn_` + 43 位 base64url = 47 字符（02 §5.2）
const tokenReDeclared = (readDist("dist/background.js").match(/TOKEN_RE = (\/[^\n]*\/);/) || [])[1] || "";
const tokenReExpected = "/^opn_[A-Za-z0-9_-]{43}$/";
if (tokenReDeclared !== tokenReExpected) {
  const declared = tokenReDeclared || "(没找到)";
  fail(GROUP_V15, `令牌本地校验必须是 opn_ + 43 位 base64url 的 47 字符（02 §5.2），实际 ${declared}`);
} else pass("令牌本地校验 = opn_ + 43 位 base64url（总长 47，02 §5.2）");

// 四条本地校验文案（C70）逐字
const popupJsForToken = readDist("dist/popup/popup.js");
for (const sentence of ["先粘贴访问令牌。", "令牌要以 opn_ 开头。", "令牌要是 47 个字符：opn_ 加 43 位。", "令牌里有不认识的字符，请重新复制一次。"]) {
  if (!popupJsForToken.includes(sentence)) fail(GROUP_V15, `令牌块缺少本地校验句（C70）：${sentence}`);
}
// 配对路径必须真的没了：不再有 /v1/pair 调用，也没有 opennote:pair 消息
const backgroundDist = readDist("dist/background.js");
if (backgroundDist.includes("opennote:pair")) fail(GROUP_V15, "background 还留着 opennote:pair 消息分支（㉞：配对删除）");
if (/postPair|pairWithCode|\/v1\/pair/.test(stripComments(backgroundDist))) fail(GROUP_V15, "background 还在调 /v1/pair（㉞：配对删除）");
if (!backgroundDist.includes("opennote:pick")) fail(GROUP_V15, "background 缺少 opennote:pick（元素选择入口）");

/* ── V13 用户可见文案不得含反引号 ────────────────────────────────── */

// Lead 0.3.1 裁定 ①：02 号契约表格里的 `` `..` `` 是 **Markdown 内联代码标记**，不是文案本身。
// 逐字文案一旦把反引号抄进界面，用户就会看到 `..`，所以这里机械地把关：
// 任何**含中文**的字符串字面量 / HTML 属性值 / HTML 文本节点里都不许出现反引号。
const GROUP_V13 = "V13 文案无反引号";
const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/;
let copyStrings = 0;
let backtickHits = 0;
const seenBacktickCopy = new Set();
const recordCopy = (file, text) => {
  if (!text || !CJK.test(text)) return;
  copyStrings += 1;
  if (!text.includes("\u0060")) return;
  const key = `${file}|${text}`;
  if (seenBacktickCopy.has(key)) return;
  seenBacktickCopy.add(key);
  backtickHits += 1;
  fail(GROUP_V13, `${file} 的用户可见文案里有反引号：${JSON.stringify(text.slice(0, 60))}`);
};
for (const file of textFiles) {
  const raw = readDist(file);
  if (file.endsWith(".js")) {
    for (const match of raw.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)) {
      recordCopy(file, match[0].slice(1, -1).replace(/\\n/g, " "));
    }
    // 模板字符串用反引号做定界符；只有出现**转义反引号**（\`）才是文案里真的带了反引号
    for (const match of raw.matchAll(/`[^`]*`/gs)) {
      if (match[0].includes("\\\u0060")) recordCopy(file, match[0].slice(1, -1));
    }
  } else if (file.endsWith(".html")) {
    const clean = raw.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of clean.matchAll(/="([^"]*)"/g)) recordCopy(file, match[1]);
    for (const match of clean.replace(/<[^>]*>/g, "\n").matchAll(/[^\n]+/g)) recordCopy(file, match[0]);
  }
}
if (backtickHits > 0) {
  // 每条已经单独 fail 过
} else pass(`${copyStrings} 条含中文的用户可见文案里 0 个反引号（反引号只是 Markdown 的内联代码标记）`);

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
console.log("\n✓ 15 组验收全部通过（V1–V15）");
