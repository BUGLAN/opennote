/**
 * 产物（`dist/`）读取守卫 —— 修的是 Lead 复现的那条 flake：「同一秒内跑完 `build.mjs` 之后
 * `node --test` 偶发 79/80」。
 *
 * **根因**：`build.mjs` 是「先 `rmSync(dist)`，再逐个文件重写」，所以 dist 存在一个**半写窗口**；
 * 任何在窗口里读 dist 的门禁都可能读到缺文件/旧内容。而 `extension/**` 是**共享工作树**，
 * 别的 agent（verifier / Lead / 另一个我）也可能正在跑 build —— 所以这不只是「我自己别并跑」的问题，
 * 而是「门禁读到正在被写的产物」这一族问题（同族：`.mutation-running` 让变异脚本自己的 verify
 * 恒为 exit 2 的假通过、verify-e2e 那次读到 verifier 正写的脚本）。
 *
 * **形制**（与 `.mutation-running` 完全同构，只做两件事：标记不可信、绝不把不可信说成绿）：
 *   ① `build.mjs` 开工前写 `.building` 标记（内含 pid/时间），收工时摘掉；
 *   ② `build.mjs` 把 dist 全量指纹写进 `dist/BUILD-INFO.json`；
 *   ③ 读 dist 的门禁先 `assertDistStable()`：标记在 → 抛「构建进行中」；指纹对不上 →
 *      抛「产物在构建之后被改过/写了一半」。
 *
 * 为什么用「标记 + 指纹」而不是把 build 做成原子替换：Windows 上 `rename` 到已存在的非空目录会失败，
 * 「先删再改名」仍然留窗口；而**指纹**能覆盖任何来源的半写（被 kill 的构建、别的 agent 的构建、
 * 手改产物），且不依赖任何进程还活着。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = join(EXT_DIR, "dist");
export const BUILD_MARKER = join(EXT_DIR, ".building");
export const BUILD_INFO_FILE = "BUILD-INFO.json";

/** 「产物不可信」专用错误：调用方必须把它当**中止**，不能当通过、也不能当断言失败。 */
export class DistUnstableError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "DistUnstableError";
    this.detail = detail;
  }
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** 列出目录下所有文件（相对路径，`/` 分隔，排序）。
 *  目录在遍历途中被删掉时**不抛**：返回已经列到的部分 —— 构建正在写 dist 时这会真的发生，
 *  上层（指纹比对）会把「少了文件」判成不可信，而不是让 fs 的 ENOENT 冒出去。 */
export function walkFiles(dir, base = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/** 纯函数：由 `[{path, bytes}]` 算指纹（`BUILD-INFO.json` 自己不参与，否则自指）。 */
export function fingerprintOf(entries) {
  const lines = entries
    .filter((entry) => entry.path !== BUILD_INFO_FILE)
    .map((entry) => `${entry.path}\u0000${entry.bytes.length}\u0000${sha256(entry.bytes)}`)
    .sort();
  return sha256(Buffer.from(lines.join("\n"), "utf8"));
}

/** 现场重算 dist 指纹（与 build 写进 BUILD-INFO 的算法是同一份实现）。
 *  注意：必须把「读的过程中文件消失/变短」也归到**不可信**，而不是让 fs 的 ENOENT 冒出去 ——
 *  构建正在 rm+重写时这会真的发生（本工具的探针第一次跑就撞上了）。 */
export function fingerprintDist(distDir = DIST_DIR) {
  try {
    return fingerprintOf(walkFiles(distDir).map((path) => ({ path, bytes: readFileSync(join(distDir, path)) })));
  } catch (error) {
    throw new DistUnstableError(
      `读 dist 算指纹时产物变了（${error.code || error.name}: ${error.message}）—— 构建正在写这个目录。结果不可信。`,
      { distDir, cause: error.code || error.name },
    );
  }
}

export function readBuildInfo(distDir = DIST_DIR) {
  const file = join(distDir, BUILD_INFO_FILE);
  if (!existsSync(file)) {
    throw new DistUnstableError(`dist 里没有 ${BUILD_INFO_FILE}：产物不完整，先跑 \`node build.mjs\``, { file });
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new DistUnstableError(`${BUILD_INFO_FILE} 读不出来（可能正被重写）：${error.message}`, { file });
  }
}

/** 读产物前必须先过这一关。返回 dist 指纹（等于 BUILD-INFO 里记的那个）。 */
export function assertDistStable({ distDir = DIST_DIR, markerPath = BUILD_MARKER } = {}) {
  if (existsSync(markerPath)) {
    let detail = "";
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      detail = `（pid=${marker.pid} 开始于 ${marker.at}）`;
    } catch {
      detail = "（标记内容读不出来）";
    }
    throw new DistUnstableError(
      `构建进行中${detail}：${relative(EXT_DIR, markerPath) || markerPath} 存在，此刻 dist 可能只写了一半。`
        + "结果不可信：等构建结束再跑（若确认没有构建在跑，删掉这个标记文件）。",
      { markerPath },
    );
  }
  const info = readBuildInfo(distDir);
  if (typeof info.fingerprint !== "string" || info.fingerprint.length !== 64) {
    throw new DistUnstableError(`${BUILD_INFO_FILE} 里没有构建指纹（旧产物？）：重跑 \`node build.mjs\``, { distDir });
  }
  const actual = fingerprintDist(distDir);
  if (actual !== info.fingerprint) {
    throw new DistUnstableError(
      `产物指纹对不上：BUILD-INFO 记的是 ${info.fingerprint.slice(0, 16)}…，现场算出来是 ${actual.slice(0, 16)}…`
        + " —— dist 在构建之后被改过（或构建被人打断，写了一半）。结果不可信：重跑 `node build.mjs`。",
      { expected: info.fingerprint, actual },
    );
  }
  return actual;
}

/** 读一个 dist 文件的安全入口：先确认产物可信，再读。
 *  读的那一刻文件仍可能被构建删掉 —— 一样归到「不可信」，不冒 fs 原始错误。 */
export function readStableDist(relPath, options = {}) {
  assertDistStable(options);
  const distDir = options.distDir || DIST_DIR;
  try {
    return readFileSync(join(distDir, relPath), "utf8");
  } catch (error) {
    throw new DistUnstableError(
      `读 dist/${relPath} 时文件不见了（${error.code || error.name}）—— 构建正在写这个目录。结果不可信。`,
      { relPath, cause: error.code || error.name },
    );
  }
}
