/**
 * M2（task-28）：令牌只读回显的**尾 4 位必须是真的**。
 *
 * 这条盯的是一个用户可见的错值：粘贴完令牌后 popup 显示 `opn_••••••••••••????`
 * （`state.tokenTail` 缺失时兜底成 `????`）。它属于「界面说的不是真的」那一族，
 * 所以断言分三层，任何一层回退都会独立变红：
 *   ① 纯函数 `maskTokenTail` 的行为（有尾号显示真尾号、绝不显示 `?`）；
 *   ② 后台必须从**唯一真源**（已保存的令牌）推导 `tokenTail`；
 *   ③ popup 必须用这个纯函数渲染，且全仓不许再出现 `????` 假尾号。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { maskTokenTail } from "../src/lib/bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const popupJs = readFileSync(join(ROOT, "src/popup/popup.js"), "utf8");
const background = readFileSync(join(ROOT, "src/background.js"), "utf8");

test("maskTokenTail：掩码是 12 个点 + 真实尾 4 位（形状与 03 §UI-04 S6 一致）", () => {
  assert.equal(maskTokenTail("pvr4"), "opn_••••••••••••pvr4");
  assert.equal(maskTokenTail("pvr4").replace("opn_", "").slice(0, 12), "•".repeat(12));
});

test("maskTokenTail：尾号缺失时**不显示假尾号**（不出现 ? 或任何占位符）", () => {
  const missing = maskTokenTail(null);
  assert.equal(missing, `opn_${"•".repeat(12)}`);
  assert.ok(!missing.includes("?"), `缺失时不得出现 ? 占位：${missing}`);
  assert.ok(!/[\dA-Za-z]/.test(missing.replace("opn_", "")), `缺失时不得编造字符：${missing}`);
});

test("maskTokenTail：尾号里的连字符/下划线原样保留（base64url 允许）", () => {
  assert.equal(maskTokenTail("a-_9"), "opn_••••••••••••a-_9");
});

test("后台：tokenTail 从唯一真源（已保存的令牌）推导，粘贴后第一次快照就是真值", () => {
  assert.match(background, /tokenTail: probed\.stored\.token \? String\(probed\.stored\.token\)\.slice\(-4\) : null,/);
});

test("popup：用 maskTokenTail 渲染，且代码里没有 ???? 这类假尾号（注释里解释原因不算）", () => {
  assert.match(popupJs, /tokenCode\.textContent = maskTokenTail\(state\.tokenTail\);/);
  // 只卡**字符串字面量**：注释里可以解释「以前这里会显示 ????」，但代码里不许再有这个占位值。
  assert.ok(!/["']\?\?\?\?/.test(popupJs), "popup 代码里不该再有 ???? 假尾号");
  assert.ok(!/["']\?\?\?\?/.test(background), "background 代码里不该再有 ???? 假尾号");
});
