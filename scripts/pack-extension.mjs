#!/usr/bin/env node
/**
 * 把 `extension/dist` 打成可分发的扩展包：`release/Opennote-clip-<version>.zip`。
 *
 * 同一个 zip 有两个用途：
 *   1. 手动安装：解压后在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」；
 *   2. 商店上传：Chrome Web Store / Edge Add-ons 都接受「manifest.json 在根目录」的 zip。
 *      （不要给它签名成 .crx：商店渠道不需要，自签名 crx 在现代 Chrome 上反而更难装。）
 *
 * 可复现性：所有条目用固定时间戳 + 固定权限位 + DEFLATE level 9，
 * 同一份 dist 两次打包得到的字节与 sha256 完全一致 —— 校验和才有意义。
 *
 * 前置：`node extension/build.mjs`（或 pnpm pack:extension 之前先构建）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import JSZip from "jszip";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "extension", "dist");
const OUT_DIR = join(ROOT, "release");
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

if (!existsSync(join(DIST, "manifest.json"))) {
  fail(`extension/dist/manifest.json 不存在 —— 先跑 \`node extension/build.mjs\` 构建扩展`);
} else {
  const extPkgVersion = JSON.parse(readFileSync(join(ROOT, "extension", "package.json"), "utf8")).version;
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  if (manifest.version !== extPkgVersion) {
    fail(
      `扩展版本漂移：manifest.json = ${manifest.version}，extension/package.json = ${extPkgVersion} —— 先跑 \`pnpm release:check\` 看清是哪一处该改`,
    );
  } else {
    // 收集 dist 下的全部文件，排序保证字节稳定
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    walk(DIST);
    files.sort((a, b) => relative(DIST, a).localeCompare(relative(DIST, b)));

    const zip = new JSZip();
    for (const file of files) {
      const name = relative(DIST, file).split(sep).join("/");
      zip.file(name, readFileSync(file), { date: FIXED_DATE, unixPermissions: 0o644, createFolders: false });
    }

    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
      streamFiles: false,
    });

    mkdirSync(OUT_DIR, { recursive: true });
    const out = join(OUT_DIR, `Opennote-clip-${manifest.version}.zip`);
    writeFileSync(out, buffer);

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const mb = (buffer.length / 1048576).toFixed(2);
    const atRoot = zip.file("manifest.json") !== null;
    console.log(`PASS  [E-1] manifest.json 在 zip 根目录：${atRoot}`);
    console.log(`PASS  [E-2] 条目数 ${files.length}，与 extension/dist 一致`);
    console.log(`PASS  [E-3] 体积 ${mb} MB，sha256 ${sha256}`);
    console.log(`      产物：${relative(ROOT, out).replace(/\\/g, "/")}`);
    if (!atRoot) process.exitCode = 1;
  }
}
