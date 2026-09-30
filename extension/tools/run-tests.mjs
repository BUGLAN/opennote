#!/usr/bin/env node
/**
 * 跑测试的**唯一入口**（`node tools/run-tests.mjs`）。
 *
 * 为什么要有它：这个仓库里同一条 flake 出现过**三次**（99/100、复跑 4 次绿、103/4 且 `build.mjs`
 * 紧接 `node --test`），而其中**两次的用例名都因为「用管道过滤输出」而丢了** ——
 * `Select-String`/`grep` 只留下"pass 103 / fail 4"，没有留下 `not ok` 那几行。
 * **「靠人记得」不可靠 → 变成机制**（与 `.building` 标记、变异的 `NO_EFFECT` 前置同一种做法）：
 *   - 通过：只打印 pass 数；
 *   - 失败：**完整输出落盘**到 `extension/.test-failure.log`（进 .gitignore），终端只打印失败用例名；
 *   - 落盘内容里带上**那一刻是否存在 `.building` / `.mutation-running`** —— 下一次 flake 出现时，
 *     证据（用例名 + 半写产物标记）要能自己留下来，不依赖任何人当时记得保存。
 *
 * 退出码与 `node --test` 一致：0 通过 / 1 有失败。**不放宽任何判据、不改产品代码** ——
 * 它的价值是「不丢失证据」，不是「修好它」。
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIAG_FILE, UNTRUSTED_FILE, clearUntrusted, takeUntrusted } from "./untrusted-marker.mjs";

const ROOT = join(import.meta.dirname, "..");
const LOG = join(ROOT, ".test-failure.log");
const GLOB = "tests/**/*.test.mjs";
const MARKERS = [".building", ".mutation-running"];

const started = new Date().toISOString();
// 跑前先清：上一次被 kill 的运行不许留下陈旧标记污染这一轮（也在 .building 上学过）
clearUntrusted();
writeFileSync(DIAG_FILE, "");
const result = spawnSync(process.execPath, ["--test", GLOB], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${result.stdout || ""}${result.stderr || ""}`;
const code = result.status === null ? 1 : result.status;
const notOk = output.split("\n").filter((line) => /^\s*not ok /.test(line));
const present = MARKERS.filter((name) => existsSync(join(ROOT, name)));
const untrusted = takeUntrusted(); // 读完即删
console.log("诊断 · runner 读的标记文件：" + UNTRUSTED_FILE + "；takeUntrusted() 原始返回 " + JSON.stringify(untrusted));
const passCount = (output.match(/^# pass (\d+)/m) || [])[1] || "?";

if (untrusted.length > 0) {
  writeFileSync(
    LOG,
    [
      `# ${started}`,
      "# **结果不可信**（退出码 2）：环境不可用，不是产品失败",
      `# 原因 ${untrusted.length} 条；pass ${passCount}；node --test 退出码 ${code}`,
      `# 那一刻存在的标记文件：${present.length ? present.join(" / ") : "（无）"}`,
      "",
      output,
    ].join("\n"),
    "utf8",
  );
  console.log(`结果不可信（退出码 2，不是失败）—— 环境不可用；完整输出已落盘：${LOG}`);
  for (const reason of untrusted) console.log(`  ${reason}`);
  process.exit(2);
}
if (code === 0 && notOk.length === 0) {
  console.log(`通过：${passCount} 条（node --test 退出码 0）`);
  process.exit(0);
}

writeFileSync(
  LOG,
  [
    `# ${started}`,
    `# 退出码 ${code}；失败用例 ${notOk.length} 条；pass ${passCount}`,
    `# 那一刻存在的标记文件：${present.length ? present.join(" / ") : "（无）"}`,
    `# 复现命令：node tools/run-tests.mjs`,
    "",
    output,
  ].join("\n"),
  "utf8",
);

console.log(`失败 ${notOk.length} 条（退出码 ${code}）—— 完整输出已落盘：${LOG}`);
console.log(`那一刻的标记文件：${present.length ? present.join(" / ") : "（无）"}`);
for (const line of notOk) console.log(line.trim());
process.exit(code === 0 ? 1 : code);
