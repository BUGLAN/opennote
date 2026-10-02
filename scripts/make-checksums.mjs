#!/usr/bin/env node
/**
 * 生成 `release/SHA256SUMS`（GNU coreutils 格式，可直接 `sha256sum -c SHA256SUMS` 校验）。
 *
 * 用法：
 *   node scripts/make-checksums.mjs                 # 只收「当前版本」的产物
 *   node scripts/make-checksums.mjs release --all   # 连旧版本残留一起收（默认不收）
 *   node scripts/make-checksums.mjs release a.zip   # 显式点名
 *
 * 「当前版本」怎么判：文件名里带根版本（`-0.4.0-`）或扩展版本（`-0.1.4.`）。
 * 这样 `release/` 里躺着的旧 zip 不会被写进校验和 —— 否则用户按 SHA256SUMS 核对时，
 * 会以为发布方发了两个互不相干的包。
 *
 * 为什么需要它：这个项目没有代码签名，用户唯一能自己做的完整性检查就是哈希比对。
 * 格式：每行 `<64 位小写 hex><两个空格><文件名>`（不含路径），按名字排序，行尾 LF。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACT = /^Opennote-.+\.(zip|exe|7z|dmg|AppImage|tar\.gz)$/;

const argv = process.argv.slice(2);
const includeAll = argv.includes("--all");
const positional = argv.filter((arg) => !arg.startsWith("--"));
const [dirArg, ...explicit] = positional;
const dir = dirArg ? join(ROOT, dirArg) : join(ROOT, "release");

const rootVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const extVersion = JSON.parse(readFileSync(join(ROOT, "extension", "package.json"), "utf8")).version;
const isCurrent = (name) => name.includes(`-${rootVersion}-`) || name.includes(`-${extVersion}.`);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`FAIL  目录不存在：${relative(ROOT, dir).replace(/\\/g, "/")}`);
  process.exitCode = 1;
} else {
  const named = explicit.length > 0 ? explicit : readdirSync(dir).filter((name) => ARTIFACT.test(name));
  const candidates = named.sort();
  const stale = candidates.filter((name) => !isCurrent(name));
  const names = includeAll ? candidates : candidates.filter(isCurrent);

  console.log(`当前版本：桌面/网页 ${rootVersion}，扩展 ${extVersion}`);
  if (stale.length > 0 && !includeAll) {
    console.log(`WARN  以下产物不是当前版本，未纳入校验和（要收就加 --all）：${stale.join(", ")}`);
  }

  if (names.length === 0) {
    console.error(`FAIL  ${relative(ROOT, dir).replace(/\\/g, "/")} 下没有当前版本的 Opennote-* 产物 —— 先打包`);
    process.exitCode = 1;
  } else {
    const lines = [];
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) {
        console.error(`FAIL  清单里的文件不存在：${name}`);
        process.exitCode = 1;
        continue;
      }
      const digest = await sha256(file);
      lines.push(`${digest}  ${name}`);
      console.log(`  ${digest}  ${name}  (${(statSync(file).size / 1048576).toFixed(1)} MB)`);
    }
    const out = join(dir, "SHA256SUMS");
    writeFileSync(out, `${lines.join("\n")}\n`);
    const shapeOk = lines.every((line) => /^[0-9a-f]{64} {2}\S/.test(line));
    const countOk = lines.length === names.length;
    console.log(`${countOk ? "PASS" : "FAIL"}  [C-1] ${lines.length}/${names.length} 个产物写入 ${relative(ROOT, out).replace(/\\/g, "/")}`);
    console.log(`${shapeOk ? "PASS" : "FAIL"}  [C-2] 每行都是 \`<sha256>  <文件名>\`（可直接 sha256sum -c）`);
    console.log(`      校验：sha256sum -c SHA256SUMS（Windows 上在 Git Bash 里跑，或用 Get-FileHash 手工比对）`);
    if (!countOk || !shapeOk) process.exitCode = 1;
  }
}
