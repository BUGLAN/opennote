#!/usr/bin/env node
/**
 * 「结果不可信」标记的**唯一定义处**（`0` 通过 / `1` 可信但失败 / `2` 结果不可信）。
 *
 * 为什么走**文件**而不是扫输出：`node --test` **不逐字转发**测试子进程的 stderr（它把子进程输出
 * 重新包装成 TAP），所以「在输出里找标记行」**永远不会触发** —— 实测：标记确实同步写出去了，
 * 变异跑完仍是 `exit 1`、runner 找不到它。文件标记与 `.building` / `.mutation-running` 同一族，
 * 对 TAP 重包装免疫。
 *
 * 两条纪律（都在 `.building` 上学过）：
 *   - **跑前先清**：上一次被 kill 的运行可能留下陈旧标记，污染下一轮；
 *   - **读完即删**：takeUntrusted() 读取后立刻删除，不允许残留。
 *
 * 用法（所有测试文件共用这一处，别再各自发明说法）：
 *   import { reportUntrusted } from "../tools/untrusted-marker.mjs";
 *   reportUntrusted("mock 在 3 秒内没有就绪");
 *   process.exit(1);   // runner 按文件标记改判为 2
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export const UNTRUSTED_PREFIX = "# UNTRUSTED: ";
export const UNTRUSTED_FILE = join(import.meta.dirname, "..", ".untrusted");
export const DIAG_FILE = join(import.meta.dirname, "..", ".test-diag.log");
/** 路径只有一个产地：写与读都用这个常量。 */
const FILE = UNTRUSTED_FILE;

/** 诊断：同步追加，绝不影响判定（出错就吞掉）。 */
export function diag(line) {
  try {
    appendFileSync(DIAG_FILE, "[" + new Date().toISOString() + "] " + String(line) + "\n", "utf8");
  } catch {
    /* 诊断本身不许改变结论 */
  }
}

/** 打标记：**同步**落盘（writeFileSync 不受 process.exit 截断影响），同时写 fd 2 给人看。 */
export function reportUntrusted(reason) {
  const line = UNTRUSTED_PREFIX + String(reason || "未说明原因") + "\n";
  writeFileSync(FILE, line, "utf8");
  writeSync(2, line);
  diag("写标记 → " + FILE + "；写入后 existsSync=" + existsSync(FILE));
}

/** 跑前先清（有则删，无则不动）。 */
export function clearUntrusted() {
  if (existsSync(FILE)) rmSync(FILE, { force: true });
}

/** 读完即删：返回所有不可信原因（每行一条，已去掉前缀）。 */
export function takeUntrusted() {
  if (!existsSync(FILE)) return [];
  const text = readFileSync(FILE, "utf8");
  rmSync(FILE, { force: true });
  return text
    .split("\n")
    .filter((line) => line.startsWith(UNTRUSTED_PREFIX))
    .map((line) => line.slice(UNTRUSTED_PREFIX.length).trim());
}