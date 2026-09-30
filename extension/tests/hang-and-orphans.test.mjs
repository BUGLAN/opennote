/**
 * 「等待必须有出口」+「删模块不许留孤儿」两类回归的单测。
 *
 * 背景（都是真实事故）：
 *  - `popup.js:209` 的 `highlights` 是删模块留下的自由变量 → `render()` 抛 ReferenceError →
 *    **popup 永远停在「正在读取页面…」，界面完全不可用**（用户实测）；
 *  - `chrome.scripting.executeScript` / `chrome.runtime.sendMessage` 都没有超时 →
 *    任何一步永不 settle，popup 就永久白屏（用户实测的卡死没有出口）。
 *
 * 这里既测**纯函数**（超时、自由变量分析），也测**接线**（谁会真的用它们）——
 * 因为「实现了但没人调用」正是上一轮的教训（V17 只守了名字 `normalizeUrl`，没守住这一类）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTimeout, settleWithin, TimeoutError } from "../src/lib/timeout.js";
import { freeVariables, scanTree, ENV_GLOBALS } from "../tools/no-undef-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFileSync(join(ROOT, "src", rel), "utf8");
const POPUP = readSrc("popup/popup.js");
const BACKGROUND = readSrc("background.js");
const VERIFY = readFileSync(join(ROOT, "verify.mjs"), "utf8");

/* ── 1. 超时原语 ─────────────────────────────────────────────── */

test("withTimeout：正常返回原值，不误杀", async () => {
  const value = await withTimeout(Promise.resolve("ok"), 500, "测试");
  assert.equal(value, "ok");
});

test("withTimeout：永不 settle 的 promise 会在时限内抛 TimeoutError（绝不无限 pending）", async () => {
  const hang = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(() => withTimeout(hang, 60, "注入"), (error) => {
    assert.ok(error instanceof TimeoutError, "必须是 TimeoutError");
    assert.match(error.message, /注入/);
    return true;
  });
  assert.ok(Date.now() - started < 1000, "必须在时限附近就返回");
});

test("withTimeout：原 promise 的 reject 原样抛出（不吞错）", async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("注入被拒")), 500, "注入"), /注入被拒/);
});

test("settleWithin：把「超时」与「抛错」分开报，调用方才有得选", async () => {
  const timeout = await settleWithin(new Promise(() => {}), 40, "读取");
  assert.equal(timeout.ok, false);
  assert.equal(timeout.reason, "timeout");
  const thrown = await settleWithin(Promise.reject(new Error("boom")), 40, "读取");
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, "error");
  const fine = await settleWithin(Promise.resolve(7), 40, "读取");
  assert.deepEqual(fine, { ok: true, value: 7 });
});

/* ── 2. 自由变量分析（no-undef 的静态版） ─────────────────────── */

test("自由变量：用户实测的那行 `highlights` 必须命中（这就是 79/80 之外那个卡死）", () => {
  // 逐字取自被删除的那段（修复前的 popup.js:209）
  const bad = `
function previewNode(box, el) {
  if ((highlights || []).length) {
    box.appendChild(el("p", "clip__merged", "高亮会一起写进正文"));
  }
  return box;
}`;
  assert.deepEqual(freeVariables(bad), ["highlights"]);
});

test("自由变量：删模块留下的另一类孤儿（未定义的函数与参数名）也命中", () => {
  assert.deepEqual(freeVariables("const u = normalizeUrl(theUrl);"), ["normalizeUrl", "theUrl"]);
});

test("自由变量：声明 / import / 解构 / 参数 / 模板 / 正则 / 对象键都不误报", () => {
  const clean = `
import { a as local } from "./lib/other.js";
const obj = { b: 1, c: 2 };
const { b, c: renamed } = obj;
const arrow = (d, e = 1, ...rest) => d + e + rest.length;
function named(f, { g: h }) { return f + h + renamed + local + b; }
const obj2 = { key: 1, method(i) { return i; } };
const tpl = \`x\${named(1, { g: 2 })}y\`;
const re = /[a-z]+/gi.test(tpl);
const cls = class Inner { m(j) { return j; } };
for (const item of []) console.log(item, arrow(1), obj2, cls, re, document);
`;
  assert.deepEqual(freeVariables(clean), []);
});

test("自由变量：环境白名单可审（数组，且在文件里），src 全树 0 命中", () => {
  assert.ok(Array.isArray(ENV_GLOBALS) && ENV_GLOBALS.includes("chrome") && ENV_GLOBALS.includes("document"));
  assert.deepEqual(scanTree(), [], "src 下不应有任何自由变量（含 popup.js 的渲染路径）");
});

/* ── 3. 接线：超时与出口必须真的被用上 ───────────────────────── */

test("popup 的 send 有超时（否则后台不回 = 永久白屏）", () => {
  assert.match(POPUP, /const SEND_TIMEOUT_MS = \d+;/);
  assert.match(POPUP, /function send\(message, timeoutMs = SEND_TIMEOUT_MS\)/);
  assert.match(POPUP, /setTimeout\(\(\) => \{[\s\S]{0,200}resolve\(\{ ok: false, timedOut: true \}\)/, "超时必须 resolve 一个可判别的失败");
});

test("load 的失败/超时都有可见出口（不许停在「正在读取页面…」）", () => {
  const at = POPUP.indexOf("async function load(");
  const body = POPUP.slice(at, at + 700);
  assert.match(body, /if \(!response \|\| !response\.ok\) \{[\s\S]{0,300}renderUnreadableBody\(/, "失败必须渲染可见出口");
  assert.doesNotMatch(body, /if \(!response\) \{\s*return;/, "不许静默 return");
});

test("preview 拿不到时必须给出口（此前是静默 return = 死路）", () => {
  const at = POPUP.indexOf("async function refreshPreview(");
  const body = POPUP.slice(at, at + 600);
  assert.match(body, /if \(!response \|\| !response\.ok \|\| !response\.preview\) \{[\s\S]{0,220}renderUnreadableBody\(/);
  assert.doesNotMatch(body, /\|\| !response\.preview\) return;/, "旧的静默 return 不许回来");
});

test("「没能读到正文」必须可重试（此前 actions 是空数组）", () => {
  assert.match(POPUP, /failed\.actions = \[\{ id: "retry", label: "重试", primary: true \}\];/);
  assert.match(POPUP, /case "retry":[\s\S]{0,80}await load\(true\)/, "重试要真的重新加载");
});

/* ── 3.5 粘贴令牌这条链（真机实测：点「连接」后 15 秒内既没存盘、也没任何提示） ── */

test("粘贴令牌：探测本地接口必须有超时（否则「连接」可以永远没反应）", () => {
  assert.match(BACKGROUND, /const DISCOVER_TIMEOUT_MS = \d+;/);
  assert.match(
    BACKGROUND,
    /settleWithin\(discover\(\{ preferredPort: state\.port, ports: BRIDGE_PORTS \}\), DISCOVER_TIMEOUT_MS/,
    "discover 必须带时限",
  );
  assert.match(BACKGROUND, /\[opennote\] set-token：已保存/, "成败都要能被观测到（console），不能黑箱");
});

test("粘贴令牌：后台说不清原因时，界面也必须给一句人话（不许静默）", () => {
  const at = POPUP.indexOf("async function connectToken(");
  const body = POPUP.slice(at, at + 1600);
  assert.match(body, /response\.timedOut[\s\S]{0,140}本地接口没有在规定时间内回话/, "超时要有可读原因");
  assert.match(body, /tokenError\.hidden = false/, "任何失败都要把它显示出来");
  assert.match(body, /notify\("令牌已保存。本地接口/, "探测失败但已存盘时要说清楚");
});

test("后台：注入有超时、load 有总时限（到点返回可重试的失败态）", () => {
  assert.match(BACKGROUND, /const INJECT_TIMEOUT_MS = \d+;/);
  assert.match(BACKGROUND, /const SNAPSHOT_TIMEOUT_MS = \d+;/);
  assert.match(BACKGROUND, /withTimeout\(\s*chrome\.scripting\.executeScript\(/, "executeScript 必须包超时");
  assert.match(BACKGROUND, /settleWithin\(pending, SNAPSHOT_TIMEOUT_MS/, "loadSnapshot 必须有总时限");
  assert.match(BACKGROUND, /return \{ ok: false, timedOut: true, code: "IMP-4014" \};/);
});

/* ── 4. 死路由（C-10p）：路由与目标必须成对存在 ────────────────── */

test("options 页删除后，通往它的路由也必须消失（死按钮不留）", () => {
  const files = ["popup/popup.js", "background.js", "lib/state.js", "manifest.json"];
  for (const rel of files) {
    const text = readSrc(rel);
    assert.doesNotMatch(text, /openOptionsPage|opennote:open-options|["']open-options["']/, `${rel} 还留着通往已删 options 页的路由`);
  }
  assert.match(VERIFY, /死按钮 C-10p/, "verify V2 必须守路由那半边（不能只守 manifest 那半边）");
});

/* ── 5. 死导入（只 import、全文件不再使用） ───────────────────── */

test("没有只 import 不使用的名字（verifier 那条判据的静态版）", () => {
  const files = ["background.js", "popup/popup.js", "lib/bridge.js", "lib/envelope.js", "lib/state.js", "lib/queue.js", "lib/pick.js"];
  for (const rel of files) {
    const text = readSrc(rel);
    // 注释里提到某个名字**不算使用**（否则「名字在注释里出现过」会把死导入洗白成活的）
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const raw of match[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop();
        if (!name) continue;
        const uses = code.match(new RegExp(`\\b${name}\\b`, "g")) || [];
        // 1 次 = 只出现在 import 行；>=2 次 = 真的被用了
        assert.ok(uses.length >= 2, `${rel} 里的 ${name} 只出现在 import 行（死导入，实际出现 ${uses.length} 次）`);
      }
    }
  }
});

/* ── 6. task-29 ②：「所见即所剪」（改过的正文必须真的进信封） ───────────── */

test("所见即所剪：popup 把界面上的正文一起发出去，后台优先用它", () => {
  // 三条接线缺一条都会变成「假开关」：改了不生效，剪藏时又用回原始抽取结果。
  assert.match(POPUP, /type: "opennote:submit",[\s\S]{0,320}body: payload\.body/, "popup 必须把正文发出去");
  assert.match(BACKGROUND, /overrides: \{ title: message\.title, importId: message\.importId, body: message\.body \}/, "后台必须接住 body");
  assert.match(BACKGROUND, /bodyOverride: overrides\.body/, "后台必须把它交给信封合成");
  assert.match(BACKGROUND, /bodyOverride = null \}\) \{[\s\S]{0,220}resolveBody\(extraction, mode, pickedElement, bodyOverride\)/, "合成点必须优先用改过的正文");
  assert.match(
    BACKGROUND,
    /function resolveBody\(extraction, mode, picked, bodyOverride = null\) \{\s*if \(typeof bodyOverride === "string" && bodyOverride\.length > 0\) return bodyOverride;/,
    "改过的正文优先，未改时行为不变",
  );
});

test("task-29 ①：蒙层用既有令牌、且不再占用 --sel（一个令牌一个用途）", () => {
  const picker = readSrc("content/picker.js");
  assert.doesNotMatch(picker, /\.op-mask\{[^}]*var\(--sel\)/, "--sel 只归 ::selection 用，蒙层不许再借它");
  assert.match(picker, /\.op-mask\{[^}]*color-mix\(in srgb, var\(--paper\)/, "蒙层要有更浅的纸色混色（纸/夜两版自动成立）");
  assert.match(picker, /\.op-box\{[^}]*100vmax color-mix\(in srgb, var\(--paper\)/, "被 hover 的那块要留成洞（周围才变淡）");
  assert.doesNotMatch(picker, /--(sel|scrim|mask)\s*:/, "不许新增令牌（红线：新增 0）");
});


/* ── 7. P0：元素模式的预览/提交必须读被点中的那块（不是整页正文） ───────── */

test("P0：元素模式的预览/提交必须读被点中的那块（不是整页正文）", () => {
  const start = POPUP.indexOf("function currentMarkdown()");
  assert.ok(start > -1, "找不到 currentMarkdown()");
  // 注释里出现 `ex.article` 不算「代码走了整页」—— 先剥注释再比位置（上一课：注释会把判据带偏）
  const raw = POPUP.slice(start, POPUP.indexOf("\n}", start));
  const fn = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.match(fn, /mode === "element"/, "元素模式必须有独立分支");
  // 光是「文本里有 mode === "element"」挡不住「挂了 && false」这种等于忽略模式的写法 ——
  // 判据要钉在**条件本身**上。注意上一版我把正则写成要求 `)` 紧跟 `element"`，
  // 于是 `element" && false` 根本不匹配 → 变异照过，**红证明是假的**（自己踩的坑，记录在此）。
  assert.match(fn, /if \(mode === "element"\) \{/, '元素分支的条件必须**就是** mode === "element"');
  assert.doesNotMatch(fn, /mode === "element"\s*&&/, "不许给元素分支挂额外条件（等于忽略模式）");
  assert.match(fn, /pickedElement[\s\S]{0,120}markdown/, "必须取 pickedElement.markdown");
  // 关键：元素分支必须挡在「落到整页正文」之前，否则又是「写了不读」的假开关
  assert.ok(fn.indexOf('mode === "element"') < fn.indexOf("ex.article"), "元素分支必须挡在整页正文之前");
  // ★ 关键补丁：预览渲染（previewNode）必须**调用** currentMarkdown()。
  // 原来这里只盯 currentMarkdown 本身 —— 而 previewNode 根本不调用它（写死 ex.article.excerpt），
  // 所以那条断言对"用户看到的预览"是**假覆盖**：函数修好了，预览照样显示整页。
  const pvRaw = POPUP.slice(POPUP.indexOf("function previewNode()"), POPUP.indexOf("function ", POPUP.indexOf("function previewNode()") + 10));
  // 注释里提到 `ex.article.excerpt` 不算"代码在取整页摘要"——**第三次**踩这个坑了，一律先剥注释
  const pv = pvRaw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // 判据盯**意图**：预览正文只有一个产地 = `currentMarkdown()`（它内部再按 mode 分流）。
  // ② 「像 Opennote」把这一段从「一行纯文本摘要」换成「块级渲染」（renderDoc），
  // 所以这里不再钉 `const excerpt = ...` 这个字面形状 —— 但**强度不变**：
  // 它仍然要求 previewNode 真的调用 currentMarkdown()，且不得直接从 `ex.article` 取正文。
  assert.match(pv, /currentMarkdown\(\)/, "预览正文必须取自 currentMarkdown()（唯一产地）");
  assert.doesNotMatch(pv, /ex\.article\.(excerpt|markdown)/, "预览不得直接取整页摘要/整页正文（元素模式会被冒充成整页）");
});

/* ── 8. 根因四：预览回包到了必须重绘，且字段形状要对 ─────────────────── */

test("根因四：refreshPreview 拿到回包后必须重绘（否则正文永不出现）", () => {
  const start = POPUP.indexOf("async function refreshPreview()");
  assert.ok(start > -1, "找不到 refreshPreview()");
  const raw = POPUP.slice(start, POPUP.indexOf("\n}", start));
  const fn = raw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.match(fn, /lastPreview = preview;[\s\S]{0,400}?render\(\);/, "赋值 lastPreview 之后必须 render()（真机：不重绘 → 正文 15s 全空）");
  assert.match(fn, /titleValue = preview\.title \|\|/, "标题按回包真实形状读（后台发 preview.title，不发 preview.props）");
  assert.doesNotMatch(fn, /preview\.props/, "不许再按不存在的 preview.props 读标题");
});
