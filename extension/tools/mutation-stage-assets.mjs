#!/usr/bin/env node
/**
 * 反向验证：**变异 → 必须红；恢复 → 必须绿**。零依赖，跑 `node tools/mutation-stage-assets.mjs`。
 *
 * 为什么不用 `mutation-check.ps1`：那一份是 PowerShell 的、每个变异只报「命中/未命中」，
 * 没有**落地证明**。今天的纪律是「变异必须先证明落地，否则红证明无效」——
 *   ① 每个锚点先数**命中处数**（0 处 = 锚点漂了，不是产品红）；
 *   ② 打印**改动前后的 sha256**（一样 = 没落地）；
 *   ③ 任一条不成立就报 `NO_EFFECT` 并 **exit 2**（结果不可信，既不算红也不算绿，不许进入判定）。
 *
 * 编排（与 `.building` / `.mutation-running` 同构）：脚本运行期间 src/dist 是**故意坏的**，
 * 别的进程此刻跑 verify 会看到假红 —— 所以脚本立 `.mutation-running` 标记，
 * `verify.mjs` 看到它就 exit 2（脚本自己的 verify 用 `OPENNOTE_MUTATION_SELF=1` 声明身份）。
 *
 * 判据矩阵（每一条都对应一次真实事故或一条自认欠账）：
 *   ① 资产形状退回 `{url,alt}` → 真桥 422（独立验证者探到的真缺陷）
 *   ② 入口开关退回 false → 图标按钮又变成点了没用的死按钮
 *   ③ openUrl 改成扩展自己拼 → 打开一个不是接口给的地址
 *   ④ stage 请求退回旧的 clip.html 跳转 → 网页版剪藏页根本不会打开
 *   ⑤ 图片开关默认改成开 → 「默认关」这条口径失效
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MARKER = join(ROOT, ".mutation-running");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const countOf = (text, needle) => text.split(needle).length - 1;

function runGate(kind) {
  const args = kind === "tests" ? ["--test", "tests/clip-web-stage.test.mjs"] : ["verify.mjs"];
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OPENNOTE_MUTATION_SELF: "1" } });
  return { code: result.status === null ? 1 : result.status, text: `${result.stdout || ""}${result.stderr || ""}` };
}

function build() {
  const result = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`build.mjs 失败：${result.stdout}${result.stderr}`);
}

const MUTATIONS = [
  {
    id: "①",
    label: "资产形状退回 {url,alt}（真桥会 422 IMP-4003 detail.field=assets[0].name）",
    file: "src/lib/stage.js",
    pairs: [
      [
        "    const asset = normalizeAsset(candidate);\n    if (!asset) {",
        "    const asset = { url: candidate && candidate.url, alt: candidate && candidate.alt };\n    if (false) {",
      ],
    ],
    expect: { tests: /assets 里混进了 \{url, alt\} 形状|{url, alt} 形状/, verify: /混进了 \{url,alt\} 形状/ },
  },
  {
    id: "②",
    label: "入口开关退回 CLIP_WEB_READY = false（图标按钮又变成死按钮）",
    file: "src/popup/popup.js",
    pairs: [["const CLIP_WEB_READY = true;", "const CLIP_WEB_READY = false;"]],
    expect: { tests: /A 已上线，开关必须是 true/, verify: /入口开关必须恢复为 true/ },
  },
  {
    id: "③",
    label: "openUrl 改成扩展自己拼（端口写死 8787）",
    file: "src/popup/popup.js",
    pairs: [
      [
        "chrome.tabs.create({ url: reply.openUrl })",
        "chrome.tabs.create({ url: `http://127.0.0.1:8787/clip/${reply.stageId}` })",
      ],
    ],
    expect: { tests: /打开的必须是接口返回的 openUrl/, verify: /popup 必须用接口返回的 openUrl 打开页面/ },
  },
  {
    id: "④",
    label: "stage 请求退回旧的 clip.html 跳转",
    file: "src/popup/popup.js",
    pairs: [
      ['type: "opennote:clip-stage",', 'type: "opennote:open-clip-page",'],
      [
        "  if (button) button.disabled = false;",
        '  await chrome.tabs.create({ url: chrome.runtime.getURL("clip/clip.html") });\n  if (button) button.disabled = false;',
      ],
    ],
    expect: { tests: /popup 必须发这条消息|旧的插件内可编辑页已被网页版取代/, verify: /必须走 opennote:clip-stage/ },
  },
  {
    id: "⑤",
    label: "图片开关默认改成开",
    file: "src/lib/stage.js",
    pairs: [["export const IMAGE_DOWNLOAD_DEFAULT = false;", "export const IMAGE_DOWNLOAD_DEFAULT = true;"]],
    expect: { tests: /IMAGE_DOWNLOAD_DEFAULT 是 false|图片开关默认/, verify: /图片开关默认值必须关/ },
  },
  {
    id: "⑥",
    label: "产物清单正面断言：混进来一个清单外的文件（已退场的模块回归）",
    kind: "create",
    file: "src/lib/templates.js",
    content: "// 变异：让一个已退场的模块回到 src 树里（产物清单必须红）\nexport const TEMPLATES_KEY = \"opennote.templates.v1\";\n",
    expect: { tests: null, verify: /清单之外的文件|已退场的模块仍在产物里|已退场的存储键/ },
  },
  {
    id: "⑦",
    label: "产物清单正面断言：删掉清单里该在的文件（lib/stage.js）",
    kind: "delete",
    file: "src/lib/stage.js",
    expect: { tests: null, verify: /缺少清单里的文件/ },
  },
  {
    id: "⑧",
    label: "夜版帧半一：去掉构建期的「根属性选择器 → :host(...)」改写",
    file: "build.mjs",
    pairs: [
      [
        '  scoped = scoped.replace(/(\\[data-[a-z-]+="[^"]*"\\])+/g, (match) => {\n    attributeHits += 1;\n    return `:host(${match})`;\n  });',
        "  // mutation: 去掉根属性选择器改写",
      ],
    ],
    expect: { tests: /统计改写处数|必须把根属性选择器包成|夜版帧的两半/, verify: /裸的根属性选择器|机械改写/ },
  },
  {
    id: "⑨",
    label: "夜版帧半二：去掉宿主元素上的页面主题镜像",
    file: "src/content/picker.js",
    pairs: [
      [
        '  for (const name of ["data-theme", "data-accent", "data-font", "data-width"]) {\n    const value = document.documentElement.getAttribute(name);\n    if (value) host.setAttribute(name, value);\n  }',
        "  // mutation: 不再镜像主题属性",
      ],
    ],
    expect: { tests: /镜像/, verify: /主题属性镜像/ },
  },
];

const report = [];
let noEffect = false;
let missedRed = 0;

writeFileSync(MARKER, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`);
try {
  for (const mutation of MUTATIONS) {
    const full = join(ROOT, mutation.file);
    if (!existsSync(full) && mutation.kind !== "create") {
      report.push(`── 变异 ${mutation.id}：SKIP —— 文件不存在（${mutation.file}）`);
      continue;
    }
    const original = existsSync(full) ? readFileSync(full, "utf8") : null;
    let mutated = original;
    const landing = [];
    let anchorMissing = false;
    if (mutation.kind === "create") {
      landing.push(`目标文件本来不存在：${!existsSync(full)}`);
      if (existsSync(full)) anchorMissing = true;
      mutated = mutation.content;
    } else if (mutation.kind === "delete") {
      landing.push(`目标文件存在（长度 ${(original || "").length} 字节），变异 = 删掉它`);
      mutated = null;
    } else {
      for (const [find, replace] of mutation.pairs) {
        const hits = countOf(mutated, find);
        landing.push(`锚点命中 ${hits} 处：${find.split("\n")[0].trim().slice(0, 60)}`);
        if (hits !== 1) anchorMissing = true;
        mutated = mutated.split(find).join(replace);
      }
    }
    const before = original === null ? "(文件不存在)" : sha(original);
    const after = mutated === null ? "(文件不存在)" : sha(mutated);
    report.push(`── 变异 ${mutation.id}：${mutation.label}`);
    report.push(`   ${mutation.file} sha256 ${before} → ${after}（${landing.join(" / ")}）`);
    if (anchorMissing || before === after) {
      report.push(`   NO_EFFECT：锚点没命中或内容没变（命中处数与 sha256 见上）—— 本次红证明**无效**，按纪律中止（exit 2）`);
      noEffect = true;
      continue;
    }
    try {
      if (mutated === null) rmSync(full, { force: true });
      else writeFileSync(full, mutated);
      // 落地自检（回读）：写进去的必须真的是那个状态
      const readBack = mutated === null ? "(文件不存在)" : sha(readFileSync(full, "utf8"));
      if (readBack !== after) {
        report.push(`   NO_EFFECT：回读 sha256=${readBack} 与预期 ${after} 不一致 —— 中止（exit 2）`);
        noEffect = true;
        continue;
      }
      build();
      const tests = mutation.expect.tests ? runGate("tests") : null;
      const verify = runGate("verify");
      const testsRed = tests ? tests.code !== 0 && mutation.expect.tests.test(tests.text) : true;
      const verifyRed = verify.code !== 0 && mutation.expect.verify.test(verify.text);
      if (tests) {
        const testsEvidence = (tests.text.split("\n").find((line) => mutation.expect.tests.test(line)) || "").trim();
        report.push(`   tests  exit=${tests.code} ${testsRed ? "红（命中判据）" : "未按预期红"}`);
        if (testsEvidence) report.push(`     ${testsEvidence}`);
      } else {
        report.push(`   tests  这次不要求红（变异只动文件清单，用例读的是 src 内容）`);
      }
      const verifyEvidence = (verify.text.split("\n").find((line) => mutation.expect.verify.test(line)) || "").trim();
      report.push(`   verify exit=${verify.code} ${verifyRed ? "红（命中判据）" : "未按预期红"}`);
      if (verifyEvidence) report.push(`     ${verifyEvidence}`);
      if (!testsRed || !verifyRed) {
        missedRed += 1;
        report.push(`   ✗ 未红：这条变异没有让判据变红 —— 恒绿的检查比没有检查更坏`);
      } else {
        report.push(`   ✓ 门禁按预期红`);
      }
    } finally {
      if (original === null) rmSync(full, { force: true });
      else writeFileSync(full, original);
      const restored = existsSync(full) ? sha(readFileSync(full, "utf8")) : "(文件不存在)";
      report.push(`   恢复：sha256 ${restored} ${restored === before ? "= 改动前（一致）" : "≠ 改动前（不一致！）"}`);
      if (restored !== before) missedRed += 1;
      build();
    }
  }

  report.push("");
  report.push("================= 恢复后复跑（必须全绿） =================");
  const testsAfter = runGate("tests");
  const verifyAfter = runGate("verify");
  report.push(`tests  exit=${testsAfter.code} ${(testsAfter.text.match(/^# (pass|fail) \d+$/gm) || []).join(" / ")}`);
  report.push(`verify exit=${verifyAfter.code} ${(verifyAfter.text.trim().split("\n").pop() || "").trim()}`);
  if (testsAfter.code !== 0 || verifyAfter.code !== 0) missedRed += 1;
} finally {
  rmSync(MARKER, { force: true });
  build(); // dist 必须回到干净状态（别人随后读产物）
}

process.stdout.write(`${report.join("\n")}\n`);
if (noEffect) {
  process.stdout.write("\nNO_EFFECT：有变异没有落地，本次反向验证结果不可信（退出码 2，不算红也不算绿）。\n");
  process.exit(2);
}
if (missedRed > 0) {
  process.stdout.write(`\n有 ${missedRed} 处没有按预期变红或恢复不一致（退出码 1）。\n`);
  process.exit(1);
}
process.stdout.write("\n全部变异都按预期变红，恢复后两个门禁全绿。\n");
