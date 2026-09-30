/**
 * 「门禁不许读一个正在被写的产物」——守卫自身的可证伪测试。
 *
 * 起因：`build.mjs` 先 `rmSync(dist)` 再逐文件重写，存在半写窗口；Lead 和我各观测到一次
 * 「刚跑完 build 就 `node --test`」的 79/80 假红。团队已为同族问题立过规矩（`.mutation-running`
 * 期间 verify 退出码 2 = 结果不可信，既不是红也不是绿），这组测试把那套规矩**钉在代码里**：
 *
 *   ① 正常态：dist 指纹必须与 BUILD-INFO 一致；
 *   ② 构建进行中（`.building` 存在）→ 守卫抛「构建进行中」，调用方必须当**中止**处理；
 *   ③ 半写/事后改动（指纹对不上）→ 守卫抛「指纹对不上」；
 *   ④ 接线：verify 看 `.building`，读 dist 的测试走 `readStableDist`（静态断言，防止守卫被绕过）。
 *
 * ②③ 在**临时目录**里跑同一份实现：不动真 dist，所以不会和并行跑的其它测试互相干扰
 * （这正是我们不想再制造的那类噪声）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_MARKER,
  DistUnstableError,
  assertDistStable,
  fingerprintOf,
  readBuildInfo,
  readStableDist,
} from "../tools/dist-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "opennote-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个 mini dist（含 BUILD-INFO.json 与真实指纹），用来在隔离环境里验守卫。 */
function makeMiniDist(dir) {
  const files = [
    { path: "a.js", bytes: Buffer.from("export const a = 1;\n") },
    { path: "lib/b.js", bytes: Buffer.from("export const b = 2;\n") },
  ];
  mkdirSync(join(dir, "lib"), { recursive: true });
  for (const file of files) writeFileSync(join(dir, file.path), file.bytes);
  const fingerprint = fingerprintOf(files);
  writeFileSync(join(dir, "BUILD-INFO.json"), `${JSON.stringify({ fingerprint }, null, 2)}\n`);
  return { files, fingerprint };
}

test("① 正常态：dist 全量指纹与 BUILD-INFO 一致，产物读取走守卫", () => {
  const fingerprint = assertDistStable();
  assert.equal(fingerprint, readBuildInfo().fingerprint, "现场重算的指纹必须等于构建时记下的那个");
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(readStableDist("lib/envelope.js").includes("export"), "守卫之后读到的就是真内容");
});

test("② 构建进行中：.building 存在 → 抛「构建进行中」（不可信，绝不当绿）", (t) => {
  const dir = tempDir(t);
  const marker = join(dir, ".building");
  writeFileSync(marker, `${JSON.stringify({ pid: process.pid, at: new Date(2026, 0, 1).toISOString() })}\n`);
  assert.throws(
    () => assertDistStable({ distDir: dir, markerPath: marker }),
    (error) => {
      assert.ok(error instanceof DistUnstableError, `必须是 DistUnstableError，实际 ${error && error.name}`);
      assert.match(error.message, /构建进行中/);
      assert.match(error.message, /结果不可信/);
      return true;
    },
  );
});

test("②b 标记被清掉之后，同一个目录立刻恢复可信（守卫不是永久封锁）", (t) => {
  const dir = tempDir(t);
  const marker = join(dir, ".building");
  const { fingerprint } = makeMiniDist(dir);
  writeFileSync(marker, "{}\n");
  assert.throws(() => assertDistStable({ distDir: dir, markerPath: marker }), DistUnstableError);
  rmSync(marker, { force: true });
  assert.equal(assertDistStable({ distDir: dir, markerPath: marker }), fingerprint);
});

test("③ 半写/事后改动：指纹对不上 → 抛「指纹对不上」（覆盖被 kill 的构建、别的 agent 的构建、手改产物）", (t) => {
  const dir = tempDir(t);
  const marker = join(dir, ".building");
  const { fingerprint } = makeMiniDist(dir);
  assert.equal(assertDistStable({ distDir: dir, markerPath: marker }), fingerprint, "先确认这个 mini dist 本来可信");

  // 模拟「写了一半」：一个文件只写了一半（内容变短）
  writeFileSync(join(dir, "lib/b.js"), "export const b = ");
  assert.throws(
    () => assertDistStable({ distDir: dir, markerPath: marker }),
    (error) => {
      assert.ok(error instanceof DistUnstableError);
      assert.match(error.message, /指纹对不上/);
      return true;
    },
  );

  // 模拟「构建被人打断」：文件少了一个（dist 刚被 rm 掉一部分）
  rmSync(join(dir, "a.js"), { force: true });
  assert.throws(() => assertDistStable({ distDir: dir, markerPath: marker }), /指纹对不上/);

  // 模拟「产物根本没有指纹」（旧产物/半写 BUILD-INFO）
  writeFileSync(join(dir, "BUILD-INFO.json"), "{}\n");
  assert.throws(() => assertDistStable({ distDir: dir, markerPath: marker }), /没有构建指纹/);
});

test("④ 接线：verify 必须看 .building，读 dist 的测试必须走 readStableDist（守卫不许被绕过）", () => {
  assert.equal(BUILD_MARKER, join(ROOT, ".building"), "标记必须落在 extension/.building");
  const verifySrc = readFileSync(join(ROOT, "verify.mjs"), "utf8");
  assert.ok(verifySrc.includes("BUILD_MARKER"), "verify 必须引用共享的 BUILD_MARKER");
  assert.ok(/if \(existsSync\(BUILD_MARKER\)\)/.test(verifySrc), "verify 必须在读 dist 之前检查构建标记");
  assert.match(verifySrc, /process\.exit\(2\)/, "构建进行中必须中止为退出码 2（结果不可信）");
  const selfSrc = readFileSync(join(ROOT, "tests/self-contained.test.mjs"), "utf8");
  assert.ok(selfSrc.includes("readStableDist("), "读 dist 的测试必须走 readStableDist");
  assert.ok(!/readFileSync\(join\(ROOT, "dist/.test(selfSrc), "不许绕过守卫直接 readFileSync(dist)");
  const buildSrc = readFileSync(join(ROOT, "build.mjs"), "utf8");
  assert.ok(buildSrc.includes("BUILD_MARKER"), "build.mjs 必须立开工标记");
  assert.ok(buildSrc.includes("fingerprint,"), "build.mjs 必须把指纹写进 BUILD-INFO");
});

test("⑤ 真产物：BUILD-INFO 里必须有 64 位指纹，且 dist 目录存在（构建指纹不是可选项）", () => {
  const info = readBuildInfo();
  assert.match(info.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(join(ROOT, "dist")), "dist 必须存在（先跑 `node build.mjs`）");
});
