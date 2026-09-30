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
 *  V10/V11 已在 M2（task-28）随模板/高亮模块一起删除（理由见下文 V10/V11 段）——
 *  原 V10 模板白名单（00 §6.14 ㉙）：变量/过滤器/触发器/behavior 白名单、priority 降序、内置 3 个、
 *      条件只认一层 {{#if}}（`{{#each}}`/`{{else}}`/嵌套一律**原样输出**并在这里报错）
 *  原 V11 高亮形态（00 §6.14 ㉚）：键名、`## 高亮` 小节形态、空高亮不生成、按 URL 分组
 *  V12 三区（00 §6.14 ㉘）：正文/高亮/属性都在交付物里，且 ⋯ 菜单里没有「剪藏到收件箱」（M1 起只剩极简形态）
 *  V13–V18 见下文各段
 *  V19 产物一致性（M2 收尾）：dist 全量指纹必须等于 BUILD-INFO 记的那个 —— 读一个写了一半的
 *      产物**不许**被当成绿；构建进行中由 `.building` 标记挡成退出码 2（与 `.mutation-running` 同构）
 *  V20 自由变量（no-undef 的静态版）：删模块留下的孤儿（`normalizeUrl` / `highlights`）必须在此报红
 *      —— `node --check` 对运行时 ReferenceError 是盲的，而它已经让 popup 卡死过一次
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 产物指纹算法与构建脚本**同一份实现**（tools/dist-guard.mjs）；BUILD_MARKER 也取自那里。
import { BUILD_MARKER, DistUnstableError, fingerprintDist, readBuildInfo, walkFiles } from "./tools/dist-guard.mjs";
// 自由变量检查（no-undef 的静态版）与 V20 是**同一份实现**，测试也 import 它做变异红证明。
import { scanTree } from "./tools/no-undef-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const SRC = join(HERE, "src");
const ROOT_TOKENS = join(HERE, "..", "src", "styles", "tokens.css");

// 「结果不可信」必须与「结果可信且失败」分开（Lead 0.3.1 裁定）：
// `tools/mutation-check.ps1` 运行期间会把 src/dist 改成故意坏的状态，此刻跑 verify 得到的红是**假红**。
// 发现标记就**以退出码 2 中止**，不打印任何红绿 —— 这种中止不是 PASS，也不是 FAIL。
const MUTATION_MARKER = join(HERE, ".mutation-running");
// 变异脚本**自己**的 verify 需要看到真实红（它用 `OPENNOTE_MUTATION_SELF=1` 声明身份）；
// 其它任何进程（没有这个环境变量）在变异期间跑 verify 都会被下面的标记挡成退出码 2。
if (existsSync(MUTATION_MARKER) && process.env.OPENNOTE_MUTATION_SELF !== "1") {
  console.error("有变异正在运行（extension/.mutation-running 存在）：本次 verify 结果不可信，已中止（退出码 2）。");
  console.error("等 tools/mutation-check.ps1 跑完（它会自己摘掉标记）再跑 verify。");
  process.exit(2);
}

// 同一族问题（Lead 复现的那条 flake）：`build.mjs` 是「先删 dist 再逐个文件重写」，存在半写窗口，
// 而 extension/** 是共享工作树（别的 agent 也可能正在跑 build）。读 dist 的门禁看到开工标记就
// **以退出码 2 中止** —— 与 `.mutation-running` 完全同构：不把不可信说成绿，也不把不可信说成红。
if (existsSync(BUILD_MARKER)) {
  let detail = "";
  try {
    const marker = JSON.parse(readFileSync(BUILD_MARKER, "utf8"));
    detail = `（pid=${marker.pid} 开始于 ${marker.at}）`;
  } catch {
    detail = "（标记内容读不出来）";
  }
  console.error(`有构建正在运行（extension/.building 存在${detail}）：此刻 dist 可能只写了一半，本次 verify 结果不可信，已中止（退出码 2）。`);
  console.error("等 `node build.mjs` 跑完再验；若确认没有构建在跑，删掉 extension/.building。");
  process.exit(2);
}

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

// 注意：V2 里「options 页与通往它的路由必须成对不存在」是一条**状态快照**，不是普适判据 ——
// 它记录的是 C-10p 那次裁定（死按钮必须删干净）。如果 options 页**合法回归**，这条会先红，
// 那时该做的是**改这条（连同 03 的裁定）**，而不是把它当 bug 去查。

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

// M2（task-28）：options 页**只为模板管理存在**，已随模板整套删除（文件 + manifest 条目）。
// 所以断言方向反过来：manifest 里**不该再有** `options_ui` —— 指向一个不存在的页面才是缺陷。
if (manifest.options_ui) {
  fail(GROUP_V2, "options_ui 已在 M2 退场（options 页只为模板存在），manifest 里不该再有它");
} else {
  pass("manifest 没有 options_ui（模板管理页随模板整套退场）");
}

// C-10p（verifier 在 HEAD 上抓到）：上面那半边守的是**目标**，还有**路由**那半边 ——
// 删了 options 页，但 `open-options` 动作 / `opennote:open-options` 消息 / `openOptionsPage()`
// 还留着 →「插件设置」是个点了没反应的死按钮（受限页面里它还是唯一的设置入口）。
// 判据：**路由与目标必须成对存在** —— 目标不在，路由也必须不在。
const deadRouteHits = [];
for (const [label, base] of [["src", SRC], ["dist", DIST]]) {
  for (const rel of walkFiles(base, base)) {
    if (!rel.endsWith(".js") && !rel.endsWith(".html") && !rel.endsWith(".json")) continue;
    const text = readFileSync(join(base, rel), "utf8");
    const hit = /openOptionsPage|opennote:open-options|["']open-options["']/.exec(text);
    if (hit) deadRouteHits.push(`${label}/${rel.replaceAll(sep, "/")}（${hit[0]}）`);
  }
}
if (existsSync(join(SRC, "options"))) deadRouteHits.push("src/options/（目录已随 M2 删除）");
// A（网页版剪藏页）：插件里那个「可编辑剪藏页」（src/clip/clip.html + clip.js）被新架构取代并删除，
// 它专用的 `?tabId=` 路由与 `tabById()` 也**必须一起消失** —— 目标没了、路由还在，就是下一个 C-10p。
if (existsSync(join(SRC, "clip"))) deadRouteHits.push("src/clip/（已被网页版剪藏页取代，必须整目录删除）");
for (const [label, base] of [["src", SRC], ["dist", DIST]]) {
  for (const rel of walkFiles(base, base)) {
    if (!rel.endsWith(".js") && !rel.endsWith(".html") && !rel.endsWith(".json")) continue;
    const text = readFileSync(join(base, rel), "utf8");
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const hit = /clip\/clip\.html|tabById|\?tabId=|\bclip-page\.js\b/.exec(stripped);
    if (hit) deadRouteHits.push(`${label}/${rel.replaceAll(sep, "/")}（旧剪藏页的痕迹：${hit[0]}）`);
  }
}
// 目录形态与路由形态都要查：旧页的产物目录（dist/clip/**）也算「目标还在」
if (existsSync(join(DIST, "clip"))) deadRouteHits.push("dist/clip/**（旧剪藏页的构建产物还在）");
if (deadRouteHits.length) {
  fail(GROUP_V2, `options 页已删除，但通往它的路由还在（死按钮 C-10p）：${deadRouteHits.join("、")}`);
} else {
  pass("options 路由与目标成对不存在（没有通往已删页面的死按钮）");
}

/* ── V2b 产物清单（正面断言：逐个核对「该在的」与「必须不在的」） ────────────
 * 起因（Lead 要求）：原来这里只写「产物文件数不超过 N」这种**数字上界**，
 * 它挡不住「删掉一个、又混进来一个」。更糟的是：把一个模块整个删掉时，
 * 后面那些 `import(dist/lib/…)` 会**先抛异常**，于是「缺少清单里的文件」这句人话根本来不及打印。
 * 所以清单核对放在**读产物之前**，并且正面列出每一个文件。
 */
const GROUP_V2B = "V2b 产物清单";
const EXPECTED_DIST_FILES = [
  "BUILD-INFO.json",
  "background.js",
  "content/clipboard.js",
  "content/extract-page.js",
  "content/picker.js",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "lib/assets.js",
  "lib/bridge.js",
  "lib/envelope.js",
  "lib/errors.js",
  "lib/pick.js",
  "lib/queue.js",
  "lib/stage.js",
  "lib/state.js",
  "lib/store.js",
  "lib/timeout.js",
  "manifest.json",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "styles/tokens.css",
];
const FORBIDDEN_DIST_PATHS = [
  "clip/clip.html",
  "clip/clip.js",
  "lib/templates.js",
  "lib/highlights.js",
  "content/highlight.js",
  "content/float.js",
  "options/options.html",
];
// `distFiles` 里带 `dist/` 前缀（相对 extension/）；清单用相对 dist/ 的写法更直观。
const distRelFiles = distFiles.map((file) => file.replace(/^dist\//, ""));
const extraDistFiles = distRelFiles.filter((file) => !EXPECTED_DIST_FILES.includes(file));
const missingDistFiles = EXPECTED_DIST_FILES.filter((file) => !distRelFiles.includes(file));
const smuggledDistFiles = FORBIDDEN_DIST_PATHS.filter((file) => distRelFiles.includes(file));
if (extraDistFiles.length) {
  fail(GROUP_V2B, `产物里出现了清单之外的文件（正面断言，新增文件必须同步到 verify 的清单）：${extraDistFiles.join(", ")}`);
}
if (missingDistFiles.length) fail(GROUP_V2B, `产物缺少清单里的文件：${missingDistFiles.join(", ")}`);
if (smuggledDistFiles.length) fail(GROUP_V2B, `已退场的产物又回来了：${smuggledDistFiles.join(", ")}`);
// 清单与 manifest 的引用必须对得上：manifest 指向的每个文件都要在清单里（V2 另有「文件真实存在」）
const manifestRefs = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon || {}),
  ...Object.values(manifest.icons || {}),
];
for (const ref of manifestRefs) {
  if (!EXPECTED_DIST_FILES.includes(ref)) fail(GROUP_V2B, `manifest 引用的 ${ref} 不在产物清单里（清单漏了或 manifest 改了）`);
}
if (!extraDistFiles.length && !missingDistFiles.length && !smuggledDistFiles.length) {
  pass(`产物清单逐个核对通过：${distRelFiles.length} 个文件，manifest 引用的 ${manifestRefs.length} 个都在清单内（M1 时 27、task-29 删页前 24）`);
} else {
  // 清单不对就**停在这里**：后面的断言会去 import 产物里的模块，缺文件时那一步会先抛 ENOENT，
  // 于是「缺少清单里的文件」这句人话根本来不及打印（实测过：node 直接把异常栈吐在最后）。
  // 宁可明确地说「清单不对，没继续验」，也不要在一个半截产物上跑完再报一堆假红。
  console.error("产物清单不对：后面的断言会跑在半截产物上，因此**在这里停**（不是跑完发现红，而是不跑）。");
  for (const item of failures) console.error(`  ${item}`);
  process.exit(1);
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

/*
 * M1（task-24）删条目说明 —— 以下逐字文案随**界面**一起退场，不是「跑不过就删」：
 * - 高亮整套（00 §6.15 ㊵ 作废㉚）：`已高亮 {n} 处` / `清除本页全部高亮` / `清除这条高亮` /
 *   `加批注` / `编辑批注` / `删除批注` / `清除这一页的全部高亮？` / `这个页面上还没有高亮…`
 *   —— 高亮入口（右键菜单项）与高亮区都不再存在，界面上不会出现这些句子。
 * - 属性区与 `存到` / `标签`（task-24 第 5 条）：`这些值会写进笔记的来源信息里…` /
 *   `标题不能为空。` / `网址要以 http:// 或 https:// 开头。` / `发布时间要写成…` /
 *   `追加目标要写成…` / `填了目标笔记…` / `用逗号分隔，可留空` / `追加到笔记` / `已手动选择`
 *   —— 这些控件的输入校验与说明不复存在（来源信息改为页面自动填写、允许空值）。
 * - 来源三选一（task-24 第 4 条）：`没有选中任何文字…把来源切到「整页正文」` —— 没有来源开关了。
 * - M2（task-28）再删三条：`按网址自动匹配`（模板选择器）、`默认底色`/`强调底色`（高亮两档配色）
 *   —— 模板与高亮**连模块一起删除**，这三句在任何界面上都不会再出现。
 * 仍然适用的条目**全部保留**；按钮改名只改这一条（`选择页面元素` → `选择当前元素`，已同步 d-ui）。
 */
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
    "这个页面不允许插件读取内容。",
  "换个普通网页再试。",
  "已选中 ",
  "字 · ",
  "约 ",
  "字 · 预计 1 篇笔记",
  "发布于 ",
  "剪藏于 ",
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
        "保存",
  "取消",
    "留下",
    "按模板更新",
          "部分标签不符合规则，已忽略。",
    "改标题",
  // M2（task-28）已删除的功能的三句文案从这里**移除**（不是放宽判据，是判据对象已不存在）：
  //   「不使用模板」「写一句批注（可不填）」「高亮会一起写进正文，出处在「高亮」区里可以再看。」
  // 它们原本只由**死代码与孤儿 JSDoc 注释**满足 —— 也就是说 V7 曾经靠注释变绿（假绿）。
  // 清掉孤儿注释与死代码（C-10s / 用户实测卡死的根因）之后，这三句在交付物里真的不存在了。
  // 元素选择（UI-16，0.3.1 取代 UI-02 的浮标；00 §6.15㉝ 逐字）
  "选择页面元素",
  "重新选择",
  // 0.3.3（用户真机截图红框）：从这里**移除**两句说明（不是放宽判据，是判据对象已不存在）——
  //   「正在页面上等待你点选…」「在页面上点一下要剪的部分；按 Esc 取消。」（03 C68/C69）
  // 删除它的是用户本人（原话「红框内的说明文字删除」）。`#pickNote` 本身**保留**：
  // 它仍是点选失败的出口（四因分离的文案 + `#pickDetail` 的真实原文），删掉那才是静默失败。
  "还没选元素。点上面的「选择当前元素」，在页面上点一下要剪的那块。",
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
  // A（网页版剪藏页）+ ②/③/⑤（task-3，本轮新增的用户可见文案，逐字）：
  // 卡片上的「在新标签页编辑」入口、两个按钮的选中态来源行、图片开关、预览截断提示、
  // 以及「接口没给 openUrl」时的失败原因（失败必须有人话，不许静默）。
  "在新标签页里编辑后保存",
  "整页正文",
  "图片一起保存",
  // 0.3.3（用户真机截图红框）：图片开关下面那三条状态说明**整段删除**，所以它们的逐字条目
  // 从这里移除（C89 / C90 / C95）——「这一页没找到可以下载的图片」原本也只由那一句满足。
  // 注意：下面「 张图片没有可下载的地址，正文里保留原始网址。」**保留** —— 它来自 `background.js`
  // （真实降级时的 warnings[]），与开关下面的说明句不是同一件事，图片没下下来时照旧逐条说出来。
  " 张图片没有可下载的地址，正文里保留原始网址。",
  // ③ 的降级句（图片下载失败：原因逐条如实说，绝不用一句「失败」糊过去）
  "图片没能下载（",
  "正文里保留原始网址：",
  "不是支持的图片格式",
  "图片太大（超过 8 MiB）",
  "只下载了前 ",
  "打开编辑页",
  "预览只显示开头，剪藏后是完整正文。",
  "本地接口没有返回可打开的页面地址。",
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

/* ── V10 / V11：已在 M2（task-28）随模块一起删除 ──────────────────────
 * **为什么不再适用**（不是「跑不过就删」）：
 * - V10「模板白名单」测的是 `lib/templates.js` 的变量/过滤器/条件白名单。模板整套（㉙）已在
 *   M2 连模块带选择器一起删除：`src/lib/templates.js` 文件不存在了，`chrome.storage.local` 的
 *   `opennote.templates.v1` 也不再读写 —— 断言一个不存在的模块只会变成永假/永真的空转。
 * - V11「高亮形态」测的是 `lib/highlights.js` 的「`> 摘录` + 批注空行」写法。高亮整套（㊵ 作废㉚）
 *   同样在 M2 删除：`lib/highlights.js` / `content/highlight.js`、右键入口、正文里的
 *   `## 高亮` 小节、模板变量 `{{highlights}}` 全部不复存在。
 * 取代它们的正向断言在 V17（极简形态）+ V18（令牌回显）里：只剩两个按钮、没有死元素、
 * 来源信息允许空值、以及**这两个模块与它们的存储键在 dist 里一个字节都不许出现**。
 */

/* ── V12 极简形态（M1 / task-24：三区退场后的留存项） ───────────────
 * 不再适用的断言与理由（逐条，Lead 硬要求）：
 * - `data-region="body|highlight|property"` 三区按钮、`#regionHighlight`/`#regionProps` 容器、
 *   `#sourceSwitch` 来源三选一、`#template` 模板选择器、`#notePath` 追加落点、属性面板 8 个字段，
 *   以及「提交时必须带 templateId/props/dirty」—— **全部随界面一起退场**：00 §6.15 ㊵㊶ 把
 *   三区/模板/高亮/来源三选一/存到/标签整套删掉，控件不存在了，再断言它们存在就是断言一个
 *   用户看不到的假界面。这些位点改由 V17（极简形态）正向断言「只剩两个按钮且无死元素」。
 * 仍然适用、因此保留的断言（判据一字未放宽）：
 * - 「剪藏到收件箱」这个死按钮必须不存在（进收件箱由应用侧设置决定）
 * - `receipt.status === "pending"` 的冻结文案，以及预览与提交共用 `opennote:preview` 一条合成路径
 * - ⋯ 菜单必须**恰好**是清单里的项、文案逐字，且没有收件箱项
 */

const GROUP_V12 = "V12 极简形态";
const popupJs = readDist("dist/popup/popup.js");

const popupHtmlNoComments = popupHtml.replace(/<!--[\s\S]*?-->/g, "");
if (/data-action="inbox"/.test(popupHtmlNoComments)) fail(GROUP_V12, "⋯ 菜单里还留着 data-action=\"inbox\"（剪藏到收件箱）");
if (popupHtmlNoComments.includes("剪藏到收件箱") || popupJs.includes("剪藏到收件箱")) {
  fail(GROUP_V12, "交付物里还出现「剪藏到收件箱」字样（00 §6.14 ㉘：删掉那个 disabled 项）");
} else pass("⋯ 菜单里没有「剪藏到收件箱」（进收件箱由应用侧设置决定）");

if (!popupJs.includes("INBOX_PENDING")) fail(GROUP_V12, "popup 没有处理 receipt.status === \"pending\" 的进收件箱分支");
if (!readDist("dist/lib/state.js").includes("已进入收件箱等待确认：")) {
  fail(GROUP_V12, "缺少冻结文案「已进入收件箱等待确认：{标题}。」");
}
if (popupJs.includes("INBOX_PENDING") && readDist("dist/lib/state.js").includes("已进入收件箱等待确认：")) {
  pass("pending 回执走 INBOX_PENDING 状态，文案逐字为「已进入收件箱等待确认：{标题}。」");
}
if (!background.includes("opennote:preview")) fail(GROUP_V12, "background 缺少 opennote:preview（预览与提交必须共用同一条合成路径）");
else pass("预览与提交共用 background 的同一合成路径（opennote:preview）");

// ⋯ 菜单（M1）：`标签` 输入退场后，「用当前选区新建标签…」这个唯一标签入口也退场 ——
// 留着它就是一个点了没反应的死元素。所以菜单从 C63 的 6 项变 5 项，需要 d-ui 同步 03。
const menuButtons = Array.from(popupHtmlNoComments.matchAll(/<button[^>]*role="menuitem"[^>]*data-action="([^"]+)"[^>]*>([^<]*)</g));
const menuItems = menuButtons.map((match) => match[1]);
const menuLabels = menuButtons.map((match) => match[2]);
const MENU_EXPECTED = ["copy", "stage", "open-settings", "settings", "forget"];
const MENU_LABELS = ["复制 Markdown", "暂存在插件里", "打开 Opennote", "插件设置", "清除本地令牌"];
if (JSON.stringify(menuItems) !== JSON.stringify(MENU_EXPECTED)) {
  fail(GROUP_V12, `⋯ 菜单应恰好是 M1 的 5 项 ${JSON.stringify(MENU_EXPECTED)}，实际 ${JSON.stringify(menuItems)}`);
} else if (JSON.stringify(menuLabels) !== JSON.stringify(MENU_LABELS)) {
  fail(GROUP_V12, `⋯ 菜单文案必须逐字：${JSON.stringify(MENU_LABELS)}，实际 ${JSON.stringify(menuLabels)}`);
} else pass(`⋯ 菜单恰好 5 项且文案逐字：${menuLabels.join(" / ")}`);

/* ── V12b 消息契约清单（T-01 的出口：清单在 03 §13，这里机检「清单与代码对得上」） ──
 * T-01 的原文：「按 02 §5.2.11 的写法补一份消息契约清单，并加一条 verify.mjs 断言：
 * 清单里的每个消息名都能在 popup.js 与 background.js 里找到对应的收发点」。
 * 所以这里**逐条点名**：每条消息都必须有 background 的接收点 + 声明的发送方。
 * 加消息却忘了写进清单（或删了清单里的消息）→ 这一条红。
 */
const GROUP_V12B = "V12b 消息契约";
const DECLARED_MESSAGES = [
  { name: "opennote:load", sender: "popup" },
  { name: "opennote:retry", sender: "popup" },
  { name: "opennote:preview", sender: "popup" },
  { name: "opennote:submit", sender: "popup" },
  { name: "opennote:stage", sender: "popup" },
  { name: "opennote:clip-stage", sender: "popup" },
  { name: "opennote:pick", sender: "popup" },
  { name: "opennote:set-token", sender: "popup" },
  { name: "opennote:forget-token", sender: "popup" },
  { name: "opennote:open-settings", sender: "popup" },
  { name: "opennote:open-note", sender: "popup" },
  { name: "opennote:copy-in-page", sender: "popup" },
  { name: "opennote:element-picked", sender: "picker" },
  { name: "opennote:pick-cancelled", sender: "picker" },
];
const pickerSrc = readDist("dist/content/picker.js");
const senderText = { popup: popupJs, picker: pickerSrc };
const contractHits = [];
for (const item of DECLARED_MESSAGES) {
  if (!background.includes(`case "${item.name}":`) && !background.includes(`"${item.name}"`)) {
    contractHits.push(`清单里的 ${item.name} 在 background.js 里找不到接收点`);
  }
  if (!senderText[item.sender].includes(item.name)) {
    contractHits.push(`清单里的 ${item.name} 在发送方 ${item.sender} 里找不到发送点`);
  }
}
// 发送方的**载荷键集合**也点一条名（Lead 裁定把它做成声明式的）：preview 只许带这三个键
const DECLARED_PREVIEW_KEYS = ["type", "mode", "images"];
const previewCall = (popupJs.match(/send\(\{\s*type: "opennote:preview"[^}]*\}\)/) || [])[0] || "";
if (!previewCall) {
  contractHits.push("popup 里找不到 opennote:preview 的发送点（清单说它只带 type/mode/images）");
} else {
  for (const key of DECLARED_PREVIEW_KEYS) {
    if (!new RegExp(`\\b${key}\\b`).test(previewCall)) contractHits.push(`opennote:preview 的载荷缺少声明的键 ${key}`);
  }
  const extra = [...previewCall.matchAll(/(?:^|[{,\s])([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)]
    .map((match) => match[1])
    .filter((key) => !DECLARED_PREVIEW_KEYS.includes(key));
  if (extra.length) contractHits.push(`opennote:preview 的载荷多出了未声明的键：${extra.join(", ")}（清单必须同步）`);
}
if (!background.includes('case "opennote:clip-stage":')) contractHits.push("background 缺少 opennote:clip-stage 的接收点");
if (/return \{ ok: false, code: "IMP-3005" \};/.test(background) === false) contractHits.push("background 缺少「未知消息」的兜底回执（IMP-3005）");
if (contractHits.length) {
  for (const hit of contractHits) fail(GROUP_V12B, hit);
} else {
  pass(`消息契约清单 ${DECLARED_MESSAGES.length} 条与代码逐条对得上（发送方 + 接收点 + preview 载荷键集合）`);
}

/* ── V17 极简形态：只剩两个按钮、无死元素、来源信息允许空值（M1 / task-24） ───────── */

const GROUP_V17 = "V17 极简形态";
const popupHtmlBare = popupHtml.replace(/<!--[\s\S]*?-->/g, "");

// ① 只有两个按钮，且文案逐字
const pickLabel = (popupHtmlBare.match(/<button[^>]*id="pick"[^>]*>([^<]*)</) || [])[1];
const extractLabel = (popupHtmlBare.match(/<button[^>]*id="extractPage"[^>]*>([^<]*)</) || [])[1];
if (pickLabel !== "选择当前元素") fail(GROUP_V17, `「选择当前元素」按钮文案必须逐字，实际 ${JSON.stringify(pickLabel)}`);
if (extractLabel !== "整页提取") fail(GROUP_V17, `「整页提取」按钮文案必须逐字，实际 ${JSON.stringify(extractLabel)}`);

// ② 退场的控件必须真的不在 DOM 里（否则就是用户可见的死元素）
const GONE_IDS = ["seg", "segmented", "regionHighlight", "regionProps", "sourceSwitch", "tmplRow", "template", "notePath", "tags", "folder", "footRow", "hlList"];
const stillThere = GONE_IDS.filter((id) => popupHtmlBare.includes(`id="${id}"`));
if (stillThere.length) fail(GROUP_V17, `popup.html 里还留着已退场控件（死元素）：${stillThere.join(", ")}`);
const GONE_TOKENS = ["data-region=", "data-mode=", "已高亮", "清除本页全部高亮"];
const stillTokens = GONE_TOKENS.filter((token) => popupHtmlBare.includes(token));
if (stillTokens.length) fail(GROUP_V17, `popup.html 里还留着已退场界面的痕迹：${stillTokens.join(", ")}`);
if (!stillThere.length && !stillTokens.length) pass(`只剩两个按钮：${pickLabel} / ${extractLabel}，三区/模板/来源开关/存到/标签的 DOM 一个都不在`);

// ③ popup 不再发已退场字段（契约只在「两个按钮 + 正文」这一处）
for (const key of ["templateId", "props", "dirty"]) {
  if (new RegExp(`\\b${key}:`).test(popupJs)) fail(GROUP_V17, `popup 仍然发送已退场字段 ${key}（契约漂移）`);
}
if (!popupJs.includes("opennote:submit") || !popupJs.includes("opennote:stage")) fail(GROUP_V17, "popup 缺少剪藏/暂存消息");
if (!popupJs.includes('type: "opennote:preview", mode')) fail(GROUP_V17, "popup 的预览必须只带 mode（来源只剩两种）");
// M2（task-28）：模板与高亮**连模块一起删除** —— 判据从 M1 的「空高亮」升级为
// 「死代码与死存储键在产物里一个都不许出现」+「产物确实变小了」。判据没有放宽，只是跟着实现往前走。
if (background.includes("opennote-highlight")) fail(GROUP_V17, "background 里还留着右键高亮菜单项");
// M2 引入过、真机抓到过的回归：URL 归一化原在已删的高亮模块里，删掉后元素选择的结果会静默落不了盘。
// 成对断言：调用了就必须本地定义（静态检查抓不到 ReferenceError，这条能）。
if (background.includes("normalizeUrl(") && !background.includes("function normalizeUrl(")) {
  fail(GROUP_V17, "background 调用了 normalizeUrl 却没有本地定义（元素选择结果会静默落不了盘）");
}
const DEAD_ARTIFACTS = ["lib/templates.js", "lib/highlights.js", "content/highlight.js", "options/options.html"];
const stillShipped = DEAD_ARTIFACTS.filter((path) => distFiles.some((file) => file.endsWith(path)));
if (stillShipped.length) fail(GROUP_V17, `已退场的模块仍在产物里：${stillShipped.join(", ")}`);
const DEAD_TOKENS = [
  "opennote.templates.v1",
  "opennote.highlights.v1",
  "withHighlightSection",
  "highlightInPage",
  "TEMPLATES_KEY",
  "HIGHLIGHTS_KEY",
];
const distText = distFiles
  .filter((file) => /\.(js|html|css|json)$/.test(file))
  .map((file) => readDist(file))
  .join("\n");
const stillReferenced = DEAD_TOKENS.filter((token) => distText.includes(token));
if (stillReferenced.length) fail(GROUP_V17, `已退场的存储键/符号仍在产物里：${stillReferenced.join(", ")}`);
// task-29 曾在这里写「产物文件数不超过 N」；task-3（本轮）把那两件旧剪藏页产物删掉、
// 新增 `lib/stage.js` + `lib/assets.js` ⇒ 仍是 24。**数字上界已删除**：
// 判据改成 V2b 的**正面清单**（逐个核对「该在的 / 必须不在的」），因为上界挡不住「删一个、混进来一个」。

// ④ 来源信息自动填写、**允许空值**：缺失字段必须是 null（不是空串、不是占位值）
const envelopeModule = await import(pathToFileURL(join(DIST, "lib", "envelope.js")).href);
const baseClip = {
  importId: "verify-m1",
  title: "示例标题",
  body: "# 正文",
  url: "https://example.com/posts/hello",
  capturedAt: "2026-01-01T00:00:00+08:00",
  selection: false,
};
const noAuthor = envelopeModule.buildEnvelope({ ...baseClip });
const withAuthor = envelopeModule.buildEnvelope({ ...baseClip, pageTitle: "网页标题", author: "张三", publishedAt: "2026-01-01T08:00:00+08:00" });
if (noAuthor.source.author !== null) fail(GROUP_V17, `提取不到作者时必须下发 null（02 的「null 则省略整行」），实际 ${JSON.stringify(noAuthor.source.author)}`);
if (noAuthor.source.publishedAt !== null) fail(GROUP_V17, `提取不到发布时间时必须下发 null，实际 ${JSON.stringify(noAuthor.source.publishedAt)}`);
if (withAuthor.source.author !== "张三") fail(GROUP_V17, "提取到作者时要如实带上");
if (withAuthor.source.publishedAt !== "2026-01-01T08:00:00+08:00") fail(GROUP_V17, "提取到发布时间时要如实带上");
// 任何来源字段都不许是空串/占位值（那会让「没作者」和「作者是空字符串」无法区分）
const emptyish = Object.entries(noAuthor.source).filter(([, value]) => value === "" || value === "null" || value === "undefined");
if (emptyish.length) fail(GROUP_V17, `来源信息不得用空串/占位值凑满 8 键：${JSON.stringify(emptyish)}`);
// ⑤ 来源字段必须**透传 null**：`buildClipEnvelope` 里给来源字段加 `|| ""`（或 String() 强转）
//    就会把「没作者」变成「作者是空字符串」，而 02 的「null 则省略整行」再也救不回来。
//    这条断言直接卡在**真实调用点**上（只测 lib/envelope.js 是测不到这个回归的 —— 这就是
//    「看起来能红其实不会红」的形状，所以必须卡在这里）。
const buildCall = (background.match(/return buildEnvelope\(\{[\s\S]*?\n  \}\);/m) || [])[0] || "";
if (!buildCall) fail(GROUP_V17, "background 里找不到 buildEnvelope 的调用点");
else {
  for (const key of ["url:", "pageTitle:", "site:", "author:", "publishedAt:"]) {
    const line = buildCall.split("\n").find((item) => item.trim().startsWith(key)) || "";
    if (!line) { fail(GROUP_V17, `buildEnvelope 调用里缺少来源字段 ${key}`); continue; }
    if (/\|\|\s*""/.test(line) || /String\(/.test(line)) {
      fail(GROUP_V17, `来源字段 ${key} 不得用空串/强转兜底（会把「缺失」变成「空值」）：${line.trim()}`);
    }
  }
}
if (!failures.some((item) => item.includes(GROUP_V17))) {
  pass("来源信息自动填写且允许空值：缺失字段为 null（不是空串），提取到的字段如实带上");
}

/* ── V21 段（并入 V17 组）：A 接通 + ⑤ 选中态 + ③ 图片开关（task-3） ────────────
 * 这一段的每一条都对应一条**自认欠账**：
 *  - A 接通：`CLIP_WEB_READY` 从 false 改 true 的变异必须红（入口恢复渲染 + 只打开接口给的 openUrl）；
 *  - ⑤：两个按钮「看不出选的是元素还是整页」—— 选中态必须是**既有令牌**着色 + `aria-pressed`；
 *  - ③：图片开关**默认关**（默认值只有一个产地 `lib/stage.js`），关着时 `assets[]` 必须为空。
 */
const GROUP_V17A = "V17 A 接通与 ③⑤";
const popupCodeV17A = popupJs.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const stageDist = readDist("dist/lib/stage.js");
const backgroundDistV17A = readDist("dist/background.js");

// ① A 接通：请求体形状的唯一定义 + openUrl 的唯一产地
if (!/export const STAGE_SPEC = "opennote\.clip\/v1";/.test(stageDist)) {
  fail(GROUP_V17A, "lib/stage.js 必须声明 spec = opennote.clip/v1（形状的唯一定义）");
}
// 行为断言（比文本匹配强）：真的 import 产物里的模块，跑一次组装，逐字比对键集合与默认值
const stageModule = await import(pathToFileURL(join(DIST, "lib", "stage.js")).href);
const FROZEN_STAGE_KEYS = ["spec", "url", "title", "body", "selection", "tags", "source", "assets"];
const builtKeys = Object.keys(stageModule.buildStageRequest({}).request);
if (JSON.stringify(builtKeys) !== JSON.stringify(FROZEN_STAGE_KEYS)) {
  fail(GROUP_V17A, `暂存请求体的键集合被改了：期望 ${JSON.stringify(FROZEN_STAGE_KEYS)}，实际 ${JSON.stringify(builtKeys)}`);
}
if (stageModule.buildStageRequest({}).request.assets.length !== 0) {
  fail(GROUP_V17A, "默认关：没有下载到字节时 assets 必须是空数组");
}
// 资产形状（02 §2.5）：合法形状原样保留；`{url,alt}` 这种信封里不存在的形状**必须**被丢掉并记 warning
// （独立验证者用真桥探到过：发 `{url,alt}` → 422 IMP-4003 detail.field="assets[0].name"）
const goodAsset = { name: "a.png", mime: "image/png", dataBase64: "aGVsbG8=" };
const goodStage = stageModule.buildStageRequest({ url: "u", title: "t", body: "b", assets: [goodAsset] });
if (JSON.stringify(goodStage.request.assets) !== JSON.stringify([goodAsset])) {
  fail(GROUP_V17A, "合法的 {name,mime,dataBase64} 资产必须原样进 assets");
}
const badStage = stageModule.buildStageRequest({ url: "u", title: "t", body: "b", assets: [{ url: "https://a/b.png", alt: "x" }] });
if (badStage.request.assets.length !== 0) {
  fail(GROUP_V17A, "assets 里混进了 {url,alt} 形状：桥会 422 拒掉整条剪藏（必须有回归闸门）");
}
if (!badStage.warnings.some((item) => item.includes("没能保存成可入库的格式") && item.includes("正文里保留原始网址"))) {
  fail(GROUP_V17A, "丢掉一条资产必须如实说明（降级为原始 URL + warnings[]，不许静默）");
}
if (stageModule.openUrlOf({}) !== null || stageModule.openUrlOf({ openUrl: "   " }) !== null) {
  fail(GROUP_V17A, "openUrlOf 对缺失/空白必须返回 null（否则会打开一个坏页面）");
}
if (stageModule.IMAGE_DOWNLOAD_DEFAULT !== false) {
  fail(GROUP_V17A, `图片开关默认值必须关，实际 ${JSON.stringify(stageModule.IMAGE_DOWNLOAD_DEFAULT)}`);
}
// ③ 的字节层必须在产物里（拿到字节才发），且不许出现「按网址造资产」的老写法
const assetsDist = readDist("dist/lib/assets.js");
for (const needle of ["export async function collectImageAssets(", "export function assetFromBytes(", "export function sniffMime("]) {
  if (!assetsDist.includes(needle)) fail(GROUP_V17A, `dist/lib/assets.js 缺少 ${needle}`);
}
if (/assets\.push\(\{\s*url/.test(readDist("dist/lib/stage.js")) || /assets\.push\(\{\s*url/.test(assetsDist)) {
  fail(GROUP_V17A, "不许再把「网址」当资产推进 assets（信封里没有这个形状）");
}
if (!/export function buildStageRequest\(input\)/.test(stageDist) || !/export function openUrlOf\(result\)/.test(stageDist)) {
  fail(GROUP_V17A, "lib/stage.js 必须导出 buildStageRequest 与 openUrlOf");
}
if (/\/clip\//.test(stageDist.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 "))) {
  fail(GROUP_V17A, "扩展侧不许出现 /clip/ 路径拼接（openUrl 只能来自接口）");
}
if (!backgroundDistV17A.includes("const openUrl = openUrlOf(result);")) {
  fail(GROUP_V17A, "background 必须用 openUrlOf(result) 取 openUrl（缺席就不打开页面）");
}
if (!popupCodeV17A.includes("chrome.tabs.create({ url: reply.openUrl })")) {
  fail(GROUP_V17A, "popup 必须用接口返回的 openUrl 打开页面");
}
if (!popupCodeV17A.includes('type: "opennote:clip-stage"')) {
  fail(GROUP_V17A, "popup 必须走 opennote:clip-stage（不许退回旧的 clip.html 跳转）");
}
if (!popupCodeV17A.includes("const CLIP_WEB_READY = true;")) {
  fail(GROUP_V17A, "A 已上线：卡片上的入口开关必须恢复为 true（否则图标按钮又变成点了没用的死按钮）");
}
if (!/if \(!reply \|\| !reply\.ok \|\| !reply\.openUrl\) \{[\s\S]{0,400}?return;/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "失败/没有 openUrl 时必须先 return（不许打开一个坏页面，也不许静默）");
}

// ② ⑤ 选中态：aria-pressed（读屏）+ 既有令牌着色（视觉），一次解决
const pickBtn = (popupHtmlBare.match(/<button[^>]*id="pick"[^>]*>/) || [])[0] || "";
const extractBtn = (popupHtmlBare.match(/<button[^>]*id="extractPage"[^>]*>/) || [])[0] || "";
if (!/aria-pressed="(true|false)"/.test(pickBtn)) fail(GROUP_V17A, "「选择当前元素」必须有 aria-pressed（选中态的可访问性半边）");
if (!/aria-pressed="true"/.test(extractBtn)) fail(GROUP_V17A, "「整页提取」默认选中（aria-pressed=\"true\"），与 03 §UI-01 一致");
if (!/pickButton\.setAttribute\("aria-pressed", mode === "element" \? "true" : "false"\)/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "popup 必须按当前来源设置「选择当前元素」的 aria-pressed");
}
if (!/extractPageButton\.setAttribute\("aria-pressed", mode === "page" \? "true" : "false"\)/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "popup 必须按当前来源设置「整页提取」的 aria-pressed");
}
const popupCss = readDist("dist/popup/popup.css");
if (!/\.clip__pick \.btn\[aria-pressed="true"\]\{[^}]*background:var\(--accent-soft\)/.test(popupCss)) {
  fail(GROUP_V17A, "选中态必须用既有令牌 --accent-soft 着色（V6 另有「0 新增令牌」兜底）");
}
if (!/\.clip__pick \.btn\[aria-pressed="true"\]\{[^}]*color:var\(--accent\)/.test(popupCss)) {
  fail(GROUP_V17A, "选中态的字色必须是 --accent（S-C8）");
}

// ③ 图片开关：默认关（唯一定义）+ 关着时不下发 assets
if (!/export const IMAGE_DOWNLOAD_DEFAULT = false;/.test(stageDist)) {
  fail(GROUP_V17A, "lib/stage.js 必须声明 IMAGE_DOWNLOAD_DEFAULT = false（默认关）");
}
if (!popupCodeV17A.includes("let imageDownload = IMAGE_DOWNLOAD_DEFAULT;")) {
  fail(GROUP_V17A, "popup 的图片开关必须取 IMAGE_DOWNLOAD_DEFAULT（默认值只有一个产地）");
}
if (!/id = "imgDownload";/.test(popupCodeV17A) || !/input\.type = "checkbox";/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "图片开关必须是卡片上的一个复选框（工具条仍是两个按钮）");
}
if (!/images: imageDownload/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "预览必须按开关状态要图片清单（关着时不多注入一次）");
}
/* ③ 的位置（0.3.3，用户真机截图）：开关必须**始终**与两个按钮同一行。
   光「挂进 #pickRow」不够 —— `#pickNote` 是 `flex-basis:100%` 的整行子项，**排在它后面的兄弟一定被挤到
   下一行**：只要那一行有话说（点选失败 / 等待点选），开关就掉到第三行（用户截图里的现场）。
   判据因此盯**兄弟顺序**（可证伪），不盯「元素存在」——元素一直都在，位置错了用户照样不满意。 */
if (!/pickRow\.insertBefore\(imageSwitch\(\), pickNote\);/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "图片开关必须插在 #pickNote 之前（否则整行子项一有话说，它就被挤到下一行）");
}
if (/pickRow\.appendChild\(imageSwitch\(\)\)/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "图片开关不许 appendChild 到整行子项之后（那不算「同一行」）");
}
/* 开关下面那三条状态说明句 0.3.3 按用户要求**整段删除**（含 `aria-describedby` 的接线）：
   这里扫的是剥过注释的代码 —— 谁把它写回来（哪怕是「顺手加一句帮助文案」）都翻红。 */
for (const gone of ["imageNote", "imgDownloadNote", "正文里保留图片的原始网址"]) {
  if (popupCodeV17A.includes(gone)) {
    fail(GROUP_V17A, `已删除的图片开关说明句不许复活：${gone}`);
  }
}
if (/\.clip__assets-note\s*\{/.test(popupCss)) {
  fail(GROUP_V17A, "已删除的说明句规则必须从 popup.css 删掉（写了不生效 = 缺陷）");
}
/* 「选择模式进行中」的说明句（C68/C69）同样按用户要求删除；`#pickNote` 只留失败出口。 */
if (popupCodeV17A.includes("正在页面上等待你点选") || popupCodeV17A.includes("按 Esc 取消。")) {
  fail(GROUP_V17A, "「等待点选」的两句说明已按用户要求删除，不许复活");
}
if (!/pickNote\.textContent =/.test(popupCodeV17A)) {
  fail(GROUP_V17A, "删说明句不许连带删掉失败出口：pickNote 仍要写点选失败的文案（失败绝不静默）");
}
if (!failures.some((item) => item.includes(GROUP_V17A))) {
  pass("A 接通（请求体形状唯一定义 + openUrl 只来自接口 + 失败不打开页面）、⑤ 选中态（aria-pressed + 既有令牌）、③ 图片开关（默认关 + 始终与按钮同一行 + 说明句已删）");
}
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

  /* ① 夜版帧（v5）：影子根里没有主题 —— **两半缺一不可**，缺哪一半都只剩亮色一套值。
   * 起因：`page-01-mask-paper` 与 `page-02-mask-night` 字节数完全相同（31744）。
   * 真因不是 `Emulation.setEmulatedMedia`，而是注入的令牌里那些**根属性选择器**
   * （`[data-theme="night"]`）在影子根里匹配不到影子树外面的祖先。 */
  const injected = (() => {
    const match = pickerSource.match(/const TOKENS_CSS = ("(?:[^"\\]|\\.)*");/);
    if (!match) return "";
    try {
      return JSON.parse(match[1]);
    } catch {
      return "";
    }
  })();
  if (!injected) {
    fail(GROUP_V14, "取不到注入影子根的 TOKENS_CSS（构建期的占位符替换没生效？）");
  } else {
    // 「裸」= 不在任何 `:host(...)` 里的根属性选择器。先把 `:host(...)` 组摘掉再数 ——
    // 直接 lookbehind 会把 `:host([data-theme="night"][data-accent="seal"])` 里**第二个**属性
    // 误判成裸的（探针自己错，不是 CSS 错）。
    const withoutHost = injected.replace(/:host\((?:[^()]|\([^()]*\))*\)/g, ":host");
    const bare = (withoutHost.match(/\[data-(theme|accent|font|width)=/g) || []).length;
    if (bare > 0) {
      fail(GROUP_V14, `注入影子根的令牌里还有 ${bare} 处裸的根属性选择器：影子根匹配不到影子树外的祖先 ⇒ 夜版/强调色永远不生效`);
    }
    if (!/:host\(\[data-theme="night"\]\)/.test(injected)) {
      fail(GROUP_V14, "夜版属性选择器必须搬成 :host([data-theme=…])（构建期机械改写，不许手抄色值）");
    }
  }
  // 另一半：宿主元素必须把页面根上的主题属性**镜像**过来，否则 `:host([data-theme=…])` 永不匹配
  if (!/for \(const name of \["data-theme", "data-accent", "data-font", "data-width"\]\)/.test(pickerCode)) {
    fail(GROUP_V14, "覆盖层必须把页面根的主题属性镜像到宿主元素（只写我们自己创建的节点）");
  }
  if (!/host\.setAttribute\(name, value\)/.test(pickerCode)) {
    fail(GROUP_V14, "镜像要真的写到宿主元素上（host.setAttribute）");
  }
  // 两半的**唯一产地**：构建期的机械改写必须在 build.mjs 里（运行时镜像只是另一半）
  const buildSource = readFileSync(join(HERE, "build.mjs"), "utf8");
  if (!buildSource.includes(":host(${match})")) {
    fail(GROUP_V14, "build.mjs 必须做「根属性选择器 → :host(...)」的机械改写（否则运行时镜像也白搭）");
  }
  if (!failures.some((item) => item.includes(GROUP_V14))) {
    pass("① 夜版帧的两半都在产物里：根属性选择器搬进 :host(...) + 宿主镜像页面主题属性");
  }
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

/* ── V16 元素选择失败原因四因分离（task-21） ───────────────────────── */

const GROUP_V16 = "V16 元素选择四因分离";
const pickLibCode = stripComments(readDist("dist/lib/pick.js"));
const REQUIRED_REASONS = ["no_url", "restricted_scheme", "injection_failed", "extraction_failed"];
const reasonCopies = REQUIRED_REASONS.map((reason) => {
  const found = pickLibCode.match(new RegExp(reason + ': "([^"]+)"'));
  return [reason, found ? found[1] : null];
});
const missingReasons = reasonCopies.filter(([, copy]) => !copy).map(([reason]) => reason);
if (missingReasons.length) {
  for (const reason of missingReasons) fail(GROUP_V16, "lib/pick.js 缺少原因 " + reason + " 的文案");
} else {
  const copies = reasonCopies.map(([, copy]) => copy);
  // ① 四种原因必须产生**四种不同**的文案（共用一句假话 = 这次缺陷的根因）
  if (new Set(copies).size !== copies.length) fail(GROUP_V16, "四种失败原因必须各有不同文案，实际有重复");
  // ② 「只有普通网页」这句只许属于 restricted_scheme
  const schemeCopy = reasonCopies.find(([reason]) => reason === "restricted_scheme")[1];
  const schemeOnly = copies.filter((copy) => copy.includes("只有普通网页"));
  if (schemeOnly.length !== 1 || schemeOnly[0] !== schemeCopy) fail(GROUP_V16, "「只有普通网页」这句话只能属于 restricted_scheme");
  // ③ no_url 不得报成「页面类型不支持」，且必须给可执行的下一步
  const noUrl = reasonCopies.find(([reason]) => reason === "no_url")[1];
  if (/普通网页|http 或 https/.test(noUrl)) fail(GROUP_V16, "no_url 不得伪装成「页面类型不支持」：" + noUrl);
  if (!/刷新|点一下扩展图标/.test(noUrl)) fail(GROUP_V16, "no_url 必须给可执行的下一步：" + noUrl);
  // ④ injection_failed 不得自称「只有普通网页」，也不得与 extraction_failed 同句
  const injection = reasonCopies.find(([reason]) => reason === "injection_failed")[1];
  const extraction = reasonCopies.find(([reason]) => reason === "extraction_failed")[1];
  if (/普通网页|http 或 https/.test(injection)) fail(GROUP_V16, "injection_failed 不得伪装成「页面类型不支持」：" + injection);
  if (injection === extraction) fail(GROUP_V16, "injection_failed 与 extraction_failed 必须是两句不同的话");
}
// ⑤ background 必须回传真实错误原文（detail）并 console.warn 出来，而不是吞掉
const bgForPick = readDist("dist/background.js");
if (!/reason: "injection_failed", detail/.test(bgForPick)) fail(GROUP_V16, "startPick() 必须把注入失败的真实原文放进 detail");
if (!bgForPick.includes("[opennote] 元素选择注入失败")) fail(GROUP_V16, "注入失败必须 console.warn 出真实 error（含 name/message）");
if (!/describeError\(error\)/.test(bgForPick)) fail(GROUP_V16, "注入错误必须经 describeError() 整理成 name: message");
// ⑥ popup 必须把 detail 透出来（不得只看 ok）
const popupForPick = readDist("dist/popup/popup.js");
if (!/pickDetail\.textContent = .*reply\.detail/.test(popupForPick)) fail(GROUP_V16, "popup 必须把 detail 原文（reply.detail）真的写进 pickDetail");
if (pickupHardcoded().length) fail(GROUP_V16, "popup 不得再硬编码「这个页面不能选择元素…」当唯一失败文案");
if (!/PICK_FAIL_COPY\[reason\]/.test(popupForPick)) fail(GROUP_V16, "popup 必须按后台给的 reason 选文案");
if (!readDist("dist/popup/popup.html").includes('id="pickDetail"')) fail(GROUP_V16, "popup.html 缺少 pickDetail 节点");
// ⑦ 抽取失败不许再被合并成 restricted（task-21 的第 5 条根因）
if (!/snapshot\.extractionFailed = true/.test(bgForPick)) fail(GROUP_V16, "抽取失败必须记成 extractionFailed，不得合并进 restricted");
if (!/extractionFailed && !snapshot\.restricted/.test(popupForPick)) fail(GROUP_V16, "popup 必须给抽取失败单独一条路径");
if (failures.filter((item) => item.includes(GROUP_V16)).length === 0) {
  pass("元素选择四因分离：" + REQUIRED_REASONS.join(" / ") + " 文案互不相同、注入失败带真实原文、popup 按 reason 取文案");
}

function pickupHardcoded() {
  return popupForPick.match(/pickNote\.textContent = "这个页面不能选择元素[^"]*"/g) || [];
}
/* ── V18 令牌回显（M2 / task-28：界面说的必须是真的） ─────────────────
 * 起因是一个用户可见的错值：刚粘贴完令牌，popup 的只读回显显示 `opn_••••••••••••????` ——
 * `state.tokenTail` 缺失时被兜底成了 `????`。修法是「尾 4 位从唯一真源推导 + 掩码写成纯函数」，
 * 这里把三层都钉住：后台推导、popup 用纯函数渲染、全仓不许再有假尾号。
 */

const GROUP_V18 = "V18 令牌回显";
const popupJsV18 = readDist("dist/popup/popup.js");
const bridgeJsV18 = readDist("dist/lib/bridge.js");

if (!/export function maskTokenTail\(tail\)/.test(bridgeJsV18)) {
  fail(GROUP_V18, "lib/bridge.js 必须导出 maskTokenTail（掩码的单一来源）");
}
if (!/tokenTail: probed\.stored\.token \? String\(probed\.stored\.token\)\.slice\(-4\) : null,/.test(background)) {
  fail(GROUP_V18, "background 必须从已保存的令牌推导 tokenTail（粘贴后第一次快照就是真值）");
}
if (!popupJsV18.includes("maskTokenTail(state.tokenTail)")) {
  fail(GROUP_V18, "popup 的只读回显必须用 maskTokenTail(state.tokenTail) 渲染");
}
// 只卡**字符串字面量**：注释里可以解释「以前这里会显示 ????」，但代码里不许再有这个占位值。
if (/["']\?\?\?\?/.test(popupJsV18) || /["']\?\?\?\?/.test(background)) {
  fail(GROUP_V18, "交付物里还留着 ???? 假尾号（界面说的不是真的）");
}
// 行为断言（比文本匹配强）：掩码本身在任何输入下都不许编造 `?` 占位。
const { maskTokenTail: maskV18 } = await import(pathToFileURL(join(DIST, "lib", "bridge.js")).href);
if (maskV18("pvr4") !== `opn_${"•".repeat(12)}pvr4`) fail(GROUP_V18, "掩码形状必须是 opn_ + 12 个点 + 真实尾 4 位");
if (String(maskV18("")).includes("?")) fail(GROUP_V18, "尾号未知时不得编造 ? 占位");
if (!failures.some((item) => item.includes(GROUP_V18))) {
  pass("令牌只读回显的尾 4 位来自唯一真源，且没有 ???? 假尾号");
}

/* ── V19 产物一致性（M2 收尾：Lead 复现的那条 flake 的修复） ──────────────
 * `build.mjs` 先 `rmSync(dist)` 再逐个文件重写 → 存在半写窗口；读 dist 的门禁可能读到中间态。
 * 判据：**现场重算** dist 全量指纹（除 BUILD-INFO.json 自己），必须等于 BUILD-INFO 里记的那个。
 * 算法与构建共用 `tools/dist-guard.mjs` 一份实现，所以任何来源的半写/事后改动都会红：
 * 被 kill 的构建、别的 agent 的构建、手改产物。构建**进行中**由 `.building` 挡成退出码 2（上面）。
 */

const GROUP_V19 = "V19 产物一致性";
try {
  const buildInfo = readBuildInfo(DIST);
  const liveFingerprint = fingerprintDist(DIST);
  if (buildInfo.fingerprint !== liveFingerprint) {
    fail(
      GROUP_V19,
      `产物指纹对不上：BUILD-INFO=${String(buildInfo.fingerprint).slice(0, 16)}… 现场=${liveFingerprint.slice(0, 16)}…（dist 在构建之后被改过，或构建写了一半）`,
    );
  } else {
    pass(`dist 全量指纹与 BUILD-INFO 一致（${liveFingerprint.slice(0, 16)}…，${distFiles.length} 个文件）`);
  }
} catch (error) {
  if (error instanceof DistUnstableError) fail(GROUP_V19, error.message);
  else throw error;
}

/* ── V20 自由变量（no-undef 的静态版：删模块留下的孤儿） ──────────────── */

// 两个真实事故，同一个类：
//  ① M2 删 `lib/highlights.js` → `background.js` 的 `normalizeUrl` 成了自由变量（元素选择静默失败）；
//  ② 同一批删除 → `popup.js` 的 `highlights` 成了自由变量 → `render()` 抛 ReferenceError →
//     **popup 永远停在「正在读取页面…」，界面完全不可用**（用户实测）。
// `node --check` 对这类问题是**盲的**（运行时 ReferenceError，不是语法错误）—— 所以这里补上。
const GROUP_V20 = "V20 自由变量";
const srcFileCount = walkFiles(SRC, SRC).filter((f) => f.endsWith(".js")).length;
const freeHits = scanTree(SRC);
if (freeHits.length) {
  for (const hit of freeHits) fail(GROUP_V20, `src/${hit.file} 里有自由变量（没声明 / 没 import / 不在白名单）：${hit.free.join(", ")}`);
} else {
  pass(`${srcFileCount} 个 src/*.js 全部无自由变量（声明过 / import 过 / 在白名单里）`);
}

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
console.log("\n✓ 20 组验收全部通过（V1–V20）");
