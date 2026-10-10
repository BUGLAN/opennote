#!/usr/bin/env node
/**
 * 版本一致性门禁 / 版本号写入 —— 发布链路里「版本从哪来」的唯一真源工具。
 *
 * 真源约定（改版本号只走这个脚本，别手改 JSON）：
 *   - 桌面版 / 网页版：根 `package.json` 的 `version`；发布 tag 必须与它逐字一致。
 *   - `electron/bridge.cjs` 的 `APP_VERSION_FALLBACK` 是**同一个版本事实的第二个产地**
 *     （读不到 `package.json` 的打包布局下回退用它）。它必须与根版本逐字一致，
 *     所以由本脚本一并写入并校验 —— 见 `V-7`。
 *   - 浏览器扩展：`extension/package.json` 与 `extension/src/manifest.json` 必须彼此一致。
 *     扩展有自己的生命周期（当前 0.2.x），**不**强制与根版本同号。
 *   - `CHANGELOG.md` 必须同时有 `## [Unreleased]` 段与当前版本的条目：
 *     没有条目就说明「这个版本要发什么」没人写过，发布流水线会直接拦下来。
 *
 * 用法：
 *   node scripts/release-version.mjs check [--tag v0.4.0]      # 本地门禁 / CI 门禁
 *   node scripts/release-version.mjs set 0.4.1                 # 写根 package.json + bridge 兜底常量
 *   node scripts/release-version.mjs set 0.4.1 --extension 0.1.5
 *
 * 退出码：0 = 全通过；1 = 有 FAIL（逐条打印，含修复建议）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PATHS = {
  rootPkg: join(ROOT, "package.json"),
  bridgeCjs: join(ROOT, "electron", "bridge.cjs"),
  extPkg: join(ROOT, "extension", "package.json"),
  extManifest: join(ROOT, "extension", "src", "manifest.json"),
  changelog: join(ROOT, "CHANGELOG.md"),
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${detail}`);
  return ok;
}
function skip(id, detail) {
  console.log(`SKIP  [${id}] ${detail}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function rel(file) {
  return relative(ROOT, file).replace(/\\/g, "/");
}
function readTextOrEmpty(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
/** 只替换文件里第一个 `"version": "..."`，其余字节保持不变（避免整文件重排）。 */
function writeVersionField(file, next) {
  const before = readFileSync(file, "utf8");
  const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
  const hits = before.match(new RegExp(pattern, "gm"));
  if (!hits || hits.length !== 1) {
    throw new Error(`${rel(file)}：期望恰好 1 处 "version" 字段，实际 ${hits ? hits.length : 0} 处，拒绝改写`);
  }
  const prev = /^\s*"version"\s*:\s*"([^"]*)"/m.exec(before)[1];
  const after = before.replace(pattern, `$1${next}$2`);
  writeFileSync(file, after);
  const written = readJson(file).version;
  if (written !== next) throw new Error(`${rel(file)}：写入后读回是 ${written}，不是 ${next}`);
  console.log(`  ${rel(file)}: ${prev} → ${next}`);
}

function changelogHasVersion(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+\\[?${escaped}\\]?`, "m").test(text);
}

/** 读 `electron/bridge.cjs` 里的 `APP_VERSION_FALLBACK` 字面量；读不到返回 null。 */
function readBridgeFallbackVersion(file = PATHS.bridgeCjs) {
  const matched = /^\s*const APP_VERSION_FALLBACK = '([^']*)'/m.exec(readTextOrEmpty(file));
  return matched ? matched[1] : null;
}

/**
 * 只替换 `electron/bridge.cjs` 里的 `APP_VERSION_FALLBACK = '<x.y.z>'`，其余字节保持不变。
 *
 * 为什么这份也得由本脚本写：它是**版本事实的第二个产地**（第一个是根 `package.json`），
 * 而它自 `8271223` 写进去之后**一次都没被更新过** —— 冻结在 `0.3.2`，版本却一路走到 `0.9.0`，
 * 于是 `bridge-smoke` 的 ⑬ 咬合**红了七个版本没人管**。
 *
 * 红着的门禁比没有门禁更坏：它让「本次改动没有新增失败」这类判断失去依据 ——
 * 真正的回归会混在既有红里被忽略（这正是本仓库在 `BR-4·变异自检` 里反复强调的纪律）。
 */
function writeFallbackVersion(file, next) {
  const before = readFileSync(file, "utf8");
  const pattern = /^(\s*const APP_VERSION_FALLBACK = ')[^']*(')/m;
  const hits = before.match(new RegExp(pattern, "gm"));
  if (!hits || hits.length !== 1) {
    throw new Error(
      `${rel(file)}：期望恰好 1 处 APP_VERSION_FALLBACK 字面量，实际 ${hits ? hits.length : 0} 处，拒绝改写`,
    );
  }
  const prev = readBridgeFallbackVersion(file);
  writeFileSync(file, before.replace(pattern, `$1${next}$2`));
  const written = readBridgeFallbackVersion(file);
  if (written !== next) throw new Error(`${rel(file)}：写入后读回是 ${written}，不是 ${next}`);
  console.log(`  ${rel(file)}: APP_VERSION_FALLBACK ${prev} → ${next}`);
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length > 0) {
    console.log(`结论：${results.length} 项里 ${failed.length} 项 FAIL —— ${failed.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`结论：${results.length} 项全 PASS`);
}

function cmdCheck(argv) {
  const tagIdx = argv.indexOf("--tag");
  const tagArg = tagIdx === -1 ? "" : (argv[tagIdx + 1] ?? "");

  const rootVersion = readJson(PATHS.rootPkg).version;
  check("V-1", SEMVER.test(rootVersion), `根 package.json version = ${rootVersion}（vX.Y.Z 形态）`);

  const extPkgVersion = readJson(PATHS.extPkg).version;
  const extManifestVersion = readJson(PATHS.extManifest).version;
  check(
    "V-2",
    extPkgVersion === extManifestVersion,
    `扩展两处版本一致：extension/package.json = ${extPkgVersion}，extension/src/manifest.json = ${extManifestVersion}`,
  );

  const changelog = readTextOrEmpty(PATHS.changelog);
  check("V-3", /^##\s+\[Unreleased\]/m.test(changelog), "CHANGELOG.md 有 ## [Unreleased] 段");
  check(
    "V-4",
    changelogHasVersion(changelog, rootVersion),
    `CHANGELOG.md 有 ${rootVersion} 的条目（没有就先写清楚这个版本发什么）`,
  );

  /*
   * 版本事实的**第二个产地**。缺了这条，`bridge.cjs` 的兜底常量会静静地烂在旧版本上：
   * `bridge-smoke` 的 ⑬ 咬合虽然会红，但发布链路（CI 跑的是本脚本）完全看不见它。
   */
  const bridgeFallback = readBridgeFallbackVersion();
  check(
    "V-7",
    bridgeFallback === rootVersion,
    `electron/bridge.cjs 的 APP_VERSION_FALLBACK = ${bridgeFallback ?? "(读不到)"}` +
      `，必须等于根 package.json 的 ${rootVersion}` +
      `（修复：node scripts/release-version.mjs set ${rootVersion}）`,
  );

  if (tagArg) {
    const tag = tagArg.replace(/^v/, "");
    check("V-5", SEMVER.test(tag), `tag ${tagArg} 是 vX.Y.Z 形态`);
    check("V-6", tag === rootVersion, `tag ${tagArg} 与根 package.json 的 ${rootVersion} 一致`);
  } else {
    skip("V-5/V-6", "未提供 --tag，不校验 tag（CI 里必须带 --tag \"$GITHUB_REF_NAME\"）");
  }

  summarize();
}

function cmdSet(argv) {
  const version = argv[0];
  if (!version || !SEMVER.test(version)) {
    console.error(`用法：node scripts/release-version.mjs set <x.y.z> [--extension <x.y.z>]\n收到：${version ?? "(空)"}`);
    process.exitCode = 1;
    return;
  }
  console.log(`写入版本号：`);
  writeVersionField(PATHS.rootPkg, version);
  // 同一个版本事实的第二个产地：打包布局读不到 package.json 时，桥用它回退。
  writeFallbackVersion(PATHS.bridgeCjs, version);

  const extIdx = argv.indexOf("--extension");
  if (extIdx !== -1) {
    const extVersion = argv[extIdx + 1];
    if (!extVersion || !SEMVER.test(extVersion)) {
      console.error(`--extension 需要合法的 x.y.z，收到：${extVersion ?? "(空)"}`);
      process.exitCode = 1;
      return;
    }
    writeVersionField(PATHS.extPkg, extVersion);
    writeVersionField(PATHS.extManifest, extVersion);
  } else {
    console.log(`  （扩展版本未动：要一起改加 --extension <x.y.z>）`);
  }

  console.log("");
  console.log("接下来：");
  console.log(`  1. 在 CHANGELOG.md 的 [Unreleased] 下面加一节 ## [${version}]，并写清发了什么`);
  console.log(`  2. pnpm release:check`);
  console.log(`  3. git commit -am "chore(release): ${version}"`);
  console.log(`  4. git tag v${version} && git push origin main --tags   # tag 会触发 .github/workflows/release.yml`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "check") cmdCheck(rest);
else if (command === "set") cmdSet(rest);
else {
  console.error("用法：node scripts/release-version.mjs <check|set> ...（详见文件头注释）");
  process.exitCode = 1;
}
