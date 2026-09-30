/**
 * 「构建进行中读产物」的**量化探针**（M2 收尾：把 Lead 那条 flake 从「1/N 假红」变成可测量的窗口）。
 *
 * 做什么：一边用子进程连续跑 `node build.mjs`（dist 被反复删除+重写），一边在**本进程**里
 * 高频做两件事：
 *   ① `assertDistStable()`（新的守卫）→ 统计它挡住多少次（标记 / 指纹两类）；
 *   ② **旧行为的样子**：直接 `readFileSync(dist/...)` + 数 dist 文件数 → 统计有多少次会读到
 *      缺文件/空文件（也就是修复前门禁可能读到的中间态）。
 *
 * 它**不是门禁**（不做红绿判定，永远退出 0）：它回答的是「半写窗口到底存不存在、有多大」。
 * 结论有两种都算有价值：命中 > 0 → 窗口真实存在，守卫确实挡住了；命中 = 0 → 在这台机器的
 * 时序下窗口极窄，那条 flake 另有原因（那就别把它归因到文件竞争上）。
 *
 * 用法：`node tools/dist-race-probe.mjs [--seconds 20] [--builds 30]`
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_MARKER, DIST_DIR, DistUnstableError, assertDistStable, readBuildInfo, walkFiles } from "./dist-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return Number(hit.split("=")[1]);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? Number(process.argv[index + 1]) : fallback;
};

const SECONDS = arg("seconds", 20);
const BUILDS = arg("builds", 30);

/** 等一个正在跑的构建收工（探针自己不许踩在别人的构建上开工）。 */
async function waitForQuietBuild(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(BUILD_MARKER) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 跑一次构建并等它结束（用来保证探针**开始前**和**结束后** dist 都是完整的）。 */
function buildOnce() {
  const result = spawnSync(process.execPath, ["build.mjs"], { cwd: EXT, stdio: "ignore" });
  return result.status === 0;
}

await waitForQuietBuild();
if (!buildOnce()) {
  console.error("探针开始前必须先能构建成功（`node build.mjs` 失败）：已中止。");
  process.exit(1);
}

/** 基线文件数取自**刚跑完的完整构建**（此刻 dist 是完整的），用来判断「文件数不足 = 半写」。 */
const EXPECTED_FILES = walkFiles(DIST_DIR).length;
const SAMPLE_FILES = ["lib/envelope.js", "background.js", "manifest.json", "popup/popup.js", "content/picker.js"];

const stats = {
  checks: 0,
  stable: 0,
  markerHits: 0,
  fingerprintHits: 0,
  rawMissing: 0,
  rawEmpty: 0,
  shortTree: 0,
  buildsFinished: 0,
};

function sampleRaw() {
  let gap = false;
  for (const rel of SAMPLE_FILES) {
    try {
      if (readFileSync(join(DIST_DIR, rel)).length === 0) {
        stats.rawEmpty += 1;
        gap = true;
      }
    } catch {
      stats.rawMissing += 1;
      gap = true;
    }
  }
  if (walkFiles(DIST_DIR).length < EXPECTED_FILES) {
    stats.shortTree += 1;
    gap = true;
  }
  return gap;
}

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["build.mjs"], { cwd: join(HERE, ".."), stdio: "ignore" });
    child.on("exit", () => {
      stats.buildsFinished += 1;
      resolve();
    });
  });
}

const deadline = Date.now() + SECONDS * 1000;
/** 构建风暴：最多 BUILDS 次，且不超过 deadline。 */
const storm = (async () => {
  for (let i = 0; i < BUILDS && Date.now() < deadline; i += 1) await runBuild();
})();

const probe = (async () => {
  while (Date.now() < deadline) {
    stats.checks += 1;
    try {
      assertDistStable();
      stats.stable += 1;
    } catch (error) {
      if (error instanceof DistUnstableError) {
        if (/构建进行中/.test(error.message)) stats.markerHits += 1;
        else stats.fingerprintHits += 1;
      } else {
        throw error;
      }
    }
    sampleRaw();
    // 让出事件循环，好让构建子进程推进 + 我们能继续高频采样
    await new Promise((resolve) => setImmediate(resolve));
  }
})();

await Promise.all([storm, probe]);

// 收工：探针可能正好在某个构建写一半时结束 —— 必须补一次完整构建，
// 绝不给工作树留一个半写的 dist（这正是本探针要消灭的那个状态）。
await waitForQuietBuild();
const restored = buildOnce();
if (!restored) {
  console.error("探针收尾构建失败：dist 可能停在半写状态，请手动跑 `node build.mjs`。");
  process.exit(1);
}

console.log(`探针：${SECONDS}s 内采样 ${stats.checks} 次，构建完成 ${stats.buildsFinished} 次（期望文件数 ${EXPECTED_FILES}）`);
console.log(`  守卫判定可信（stable）：${stats.stable}`);
console.log(`  守卫挡住「构建进行中」（.building 标记）：${stats.markerHits}`);
console.log(`  守卫挡住「指纹对不上」（写了一半/被改动）：${stats.fingerprintHits}`);
console.log(`  旧行为会读到的中间态：缺文件 ${stats.rawMissing} 次 / 空文件 ${stats.rawEmpty} 次 / 文件树不完整 ${stats.shortTree} 次`);
const blocked = stats.markerHits + stats.fingerprintHits;
if (blocked > 0) {
  console.log(`结论：半写窗口**真实存在**，本次 ${blocked} 次采样落在窗口里 —— 修复前这些采样会被门禁当成真产物。`);
} else {
  console.log("结论：本次没有采样落在窗口里（窗口极窄或本机时序避开了）。这**不能**证明窗口不存在，只能说明它不是本次那条 flake 的唯一解释。");
}
