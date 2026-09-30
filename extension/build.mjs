/**
 * extension/ 的构建脚本：**零依赖**（只用 node 内置模块），不污染主项目构建。
 *
 * 做四件事：
 *  1. 把 `src/**` 复制成 `dist/**`（源码本身就是浏览器可直接加载的 ESM，不需要打包器）；
 *  2. 从仓库根的 `src/styles/tokens.css` **整份复制**设计令牌到
 *     `extension/src/styles/tokens.css` 与 `extension/dist/styles/tokens.css`，
 *     并记录 SHA-256（任务硬要求：禁止手抄色值，必须内容哈希比对）；
 *  3. 把元素选择脚本里的 `"__OPENNOTE_TOKENS_CSS__"` 占位符替换成令牌全文
 *     （只做 `:root` → `:host` 的机械替换，供影子 DOM 使用）；
 *  4. 用 `--accent` / `--accent-ink` 两个**从 tokens.css 解析出来**的值生成图标 PNG
 *     （不手抄颜色，也不引第三方图形库）。
 *
 * 用法：`node build.mjs`（cwd 不限，脚本按自身路径定位）。
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 产物指纹算法与读取守卫**同一份实现**（tools/dist-guard.mjs）——不许这里一套、门禁一套。
import { fingerprintOf, walkFiles as walkDistFiles } from "./tools/dist-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "src");
const DIST = join(HERE, "dist");
/**
 * 开工标记（与 `.mutation-running` 同构）：dist 是「先删再逐个文件重写」，存在半写窗口；
 * 别的进程（另一个 agent 的 verify、测试、CDP 工具）读 dist 前会看这个标记，看到就判
 * 「结果不可信」而不是把半写产物当绿。见 tools/dist-guard.mjs 顶部说明。
 */
const BUILD_MARKER = join(HERE, ".building");
const TOKENS_SOURCE = join(HERE, "..", "src", "styles", "tokens.css");
const ICON_SIZES = [16, 32, 48, 128];
const FLOAT_PLACEHOLDER = '"__OPENNOTE_TOKENS_CSS__"';

const log = (line) => process.stdout.write(`${line}\n`);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/* ── 1. 设计令牌：整份复制 + 哈希比对 ─────────────────────────────────── */

function copyTokens() {
  if (!existsSync(TOKENS_SOURCE)) {
    throw new Error(`找不到权威令牌文件：${TOKENS_SOURCE}`);
  }
  const css = readFileSync(TOKENS_SOURCE);
  const hash = sha256(css);
  const vendorDir = join(SRC, "styles");
  mkdirSync(vendorDir, { recursive: true });
  const vendored = join(vendorDir, "tokens.css");
  // 已存在且内容一致时不动（保持 mtime 稳定）；不一致才覆盖。
  if (!existsSync(vendored) || sha256(readFileSync(vendored)) !== hash) {
    writeFileSync(vendored, css);
  }
  const destDir = join(DIST, "styles");
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, "tokens.css"), css);
  return { hash, css: css.toString("utf8"), bytes: css.length };
}

/**
 * `:root` → `:host`：影子 DOM 里没有 `:root`，宿主元素用 `:host` 承接令牌。
 *
 * 还要把**挂在文档根上的属性选择器**一起搬进来（如 `[data-theme="night"]`、
 * `[data-theme="night"][data-accent="seal"]`、`[data-font="mono"]`）：影子根里的
 * 属性选择器**匹配不到影子树外面的祖先**，所以原样保留的话，覆盖层永远只有亮色一套值
 * —— 这就是「`page-01-mask-paper` 与 `page-02-mask-night` 字节数完全相同（31744）」的根因
 * （不是 `Emulation.setEmulatedMedia` 不生效）。搬成 `:host([data-theme="night"])` 之后，
 * 只要覆盖层把页面根上的这几个属性**镜像到自己的宿主元素**上（`content/picker.js`），
 * 夜版就有真正的帧差异，且**一个色值都不用手抄**。
 */
function scopeTokensForShadow(css) {
  const count = (css.match(/:root/g) || []).length;
  let scoped = css.replace(/:root/g, ":host");
  let attributeHits = 0;
  scoped = scoped.replace(/(\[data-[a-z-]+="[^"]*"\])+/g, (match) => {
    attributeHits += 1;
    return `:host(${match})`;
  });
  return { css: scoped, replacements: count, attributeHits };
}

/* ── 2. 图标：解析令牌里的 --accent / --accent-ink，自己编码 PNG ───────── */

function tokenValue(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function parseColor(value) {
  const hex = String(value || "").trim();
  const short = hex.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    return [0, 1, 2].map((i) => parseInt(short[1][i] + short[1][i], 16));
  }
  const long = hex.match(/^#([0-9a-f]{6})$/i);
  if (long) {
    return [0, 2, 4].map((i) => parseInt(long[1].slice(i, i + 2), 16));
  }
  throw new Error(`无法解析颜色：${value}`);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRectCoverage(size, x, y, inset, radius) {
  // 3×3 超采样求覆盖度，得到平滑边缘（无第三方图形库）
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const min = inset;
      const max = size - inset;
      if (px < min || px > max || py < min || py > max) continue;
      const dx = Math.max(min + radius - px, 0, px - (max - radius));
      const dy = Math.max(min + radius - py, 0, py - (max - radius));
      if (Math.hypot(dx, dy) <= radius) hits += 1;
    }
  }
  return hits / 9;
}

function drawIcon(size, bg, fg) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const bgRadius = size * 0.22;
  const markInset = size * 0.28;
  const markStroke = Math.max(1, size * 0.075);
  const markRadius = size * 0.1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const bgCoverage = roundedRectCoverage(size, x, y, 0.5, bgRadius);
      if (bgCoverage <= 0) continue;
      const outer = roundedRectCoverage(size, x, y, markInset, markRadius);
      const inner = roundedRectCoverage(size, x, y, markInset + markStroke, Math.max(0, markRadius - markStroke));
      const markCoverage = Math.max(0, outer - inner);
      const index = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        rgba[index + c] = Math.round(bg[c] * (1 - markCoverage) + fg[c] * markCoverage);
      }
      rgba[index + 3] = Math.round(255 * bgCoverage);
    }
  }
  return encodePng(size, size, rgba);
}

function writeIcons(tokensCss) {
  const bg = parseColor(tokenValue(tokensCss, "--accent"));
  const fg = parseColor(tokenValue(tokensCss, "--accent-ink"));
  const dir = join(DIST, "icons");
  mkdirSync(dir, { recursive: true });
  for (const size of ICON_SIZES) {
    writeFileSync(join(dir, `icon${size}.png`), drawIcon(size, bg, fg));
  }
  return { count: ICON_SIZES.length, accent: bg, accentInk: fg };
}

/* ── 3. 复制源码树 ───────────────────────────────────────────────────── */

/**
 * manifest 自检（构建期就失败，别等 Chrome 报「清单文件无效」）：
 *  - `default_locale` 要么是**字符串**，要么**整个键不存在**（`null` 会让加载被拒）；
 *  - `manifest_version` 必须是 3；
 *  - 代码路径必须落在 src 树里（会被复制进 dist）。
 */
function verifyManifest() {
  const raw = readFileSync(join(SRC, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  if (manifest.manifest_version !== 3) {
    throw new Error(`manifest_version 必须是 3，实际 ${manifest.manifest_version}`);
  }
  if ("default_locale" in manifest && typeof manifest.default_locale !== "string") {
    throw new Error(
      `default_locale 只能是字符串或整个键不存在，实际是 ${JSON.stringify(manifest.default_locale)}（MV3 规范不允许 null）`,
    );
  }
  if (manifest.default_locale && !existsSync(join(SRC, "_locales", manifest.default_locale))) {
    throw new Error(`声明了 default_locale=${manifest.default_locale} 但没有 src/_locales/${manifest.default_locale}/`);
  }
  for (const key of ["background.service_worker", "action.default_popup"]) {
    const [head, tail] = key.split(".");
    const value = manifest[head] ? manifest[head][tail] : null;
    if (!value) throw new Error(`manifest 缺少 ${key}`);
    if (!existsSync(join(SRC, value))) throw new Error(`manifest 的 ${key}=${value} 指向的文件不存在`);
  }
  return manifest;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function copyTree() {
  const copied = [];
  verifyManifest();
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    const relPosix = rel.split(sep).join("/");
    if (relPosix.startsWith("styles" + "/")) continue; // tokens.css 由 copyTokens 单独处理
    const dest = join(DIST, rel);
    mkdirSync(dirname(dest), { recursive: true });
    let content = readFileSync(file);
    if (relPosix === "content/picker.js") {
      const source = content.toString("utf8");
      if (!source.includes(FLOAT_PLACEHOLDER)) {
        throw new Error("content/picker.js 缺少 __OPENNOTE_TOKENS_CSS__ 占位符");
      }
      const scoped = scopeTokensForShadow(TOKENS_SNAPSHOT.css);
      content = Buffer.from(source.replace(FLOAT_PLACEHOLDER, JSON.stringify(scoped.css)), "utf8");
      copied.push({ path: relPosix, note: `tokens 注入（:root→:host ${scoped.replacements} 处；根属性选择器→:host(...) ${scoped.attributeHits} 处）` });
    } else {
      copied.push({ path: relPosix });
    }
    writeFileSync(dest, content);
  }
  return copied;
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

let TOKENS_SNAPSHOT = null;

function main() {
  // 先立标记再动任何文件：任何在构建期间读 dist 的门禁都会看到「不可信」，而不是读到半写产物。
  writeFileSync(BUILD_MARKER, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`);
  process.on("exit", () => {
    try {
      rmSync(BUILD_MARKER, { force: true });
    } catch {
      /* 退出清理失败也不能影响构建结果 */
    }
  });
  try {
    buildAll();
  } finally {
    rmSync(BUILD_MARKER, { force: true });
  }
}

function buildAll() {
  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  TOKENS_SNAPSHOT = copyTokens();
  const files = copyTree();
  const icons = writeIcons(TOKENS_SNAPSHOT.css);

  const tokenNames = Array.from(TOKENS_SNAPSHOT.css.matchAll(/(--[a-z0-9-]+)\s*:/gi)).map((m) => m[1]);
  const uniqueTokens = Array.from(new Set(tokenNames));

  // 指纹：dist 全部文件（除 BUILD-INFO.json 自己）的内容哈希 —— 任何半写/事后改动都逃不掉。
  const fingerprint = fingerprintOf(
    walkDistFiles(DIST).map((path) => ({ path, bytes: readFileSync(join(DIST, path)) })),
  );

  const info = {
    builtAt: new Date().toISOString(),
    product: "opennote-clip-extension",
    fingerprint,
    version: JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8")).version,
    tokens: {
      source: relative(HERE, TOKENS_SOURCE).split(sep).join("/"),
      sha256: TOKENS_SNAPSHOT.hash,
      bytes: TOKENS_SNAPSHOT.bytes,
      declaredTokens: uniqueTokens.length,
      copiedVerbatim: true,
    },
    icons: { sizes: ICON_SIZES, accentFromTokens: icons.accent, accentInkFromTokens: icons.accentInk },
    files: files.map((f) => f.path).sort(),
  };
  writeFileSync(join(DIST, "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);

  const distFiles = walk(DIST).map((f) => relative(DIST, f).split(sep).join("/"));
  log(`[build] dist 就绪：${distFiles.length} 个文件`);
  log(`[build] dist 指纹=${fingerprint.slice(0, 16)}…（verify V19 与读产物的测试都会核对它）`);
  log(`[build] tokens.css sha256=${TOKENS_SNAPSHOT.hash.slice(0, 16)}… bytes=${TOKENS_SNAPSHOT.bytes} 令牌数=${uniqueTokens.length}`);
  log(`[build] 图标：${ICON_SIZES.join("/")}px（--accent 来自 tokens.css，无手抄色值）`);
  for (const line of files.filter((f) => f.note)) log(`[build] ${line.path}：${line.note}`);
}

main();
