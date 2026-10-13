/**
 * 单仓边界检查（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.6 第 4 条、§10.1 F4/F5）。
 *
 * 单仓把「服务端」和「客户端」放进了同一个仓库，于是下面这四条边界**只能靠机械检查**
 * （类型系统管不到跨目录的 import，`shared/tsconfig.json` 的 `lib` 只管得住 `shared/` 自己）：
 *
 * | # | 规则 | 破了会怎样 |
 * | --- | --- | --- |
 * | B1 | `src/` 里不出现 `from "../server/` | 服务端代码被打进前端产物 |
 * | B2 | `server/` 里不出现 `from "../src/` | 客户端代码进了 Node 进程 |
 * | B3 | `server/` 里不出现 `@noble/`（红线 3 的机械化） | 服务端有了加解密能力 ⇒ **E2EE 直接失效** |
 * | B4 | `server/` 的源码里不出现 `decrypt`/`encrypt` 这类导出 | 同上（更宽的兜网） |
 *
 * 用法：`node scripts/check-boundaries.mjs`。CI 与 `pnpm check:boundaries` 都跑它。
 * **退出码非 0 = 边界被破了**，不要用「以后再修」放过。
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 只看源码；产物与依赖目录不参与。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-clip", "release", ".git", "android", "build", "coverage", ".ignore-rules-build"]);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 一条规则：哪些文件里不许出现什么。
 *
 * ⚠️ 这里**必须匹配「代码」而不是「文本」**。第一版把 B3 写成裸的 `/@noble\//`，
 * 结果它拦住了服务端里**解释这条规则本身的注释**（"服务端里也不允许出现 @noble/*"）——
 * 那会逼人**不再写这条注释**，正好把护栏的说明书拆掉。
 * 现在 B1–B3 都要求出现 `from` / `import` / `require` 这类**加载语法**。
 */
const RULES = [
  {
    id: "B1",
    files: () => walk(join(root, "src")),
    // `from "../server/…"` 与 `from "../../server/…"` 都要抓（深浅不同）。
    pattern: /(?:from|import|require)\s*\(?\s*["'][^"']*\/server\//,
    message: "src/ 里不许 import server/（服务端代码会被打进前端产物）",
  },
  {
    id: "B2",
    files: () => walk(join(root, "server")),
    pattern: /(?:from|import|require)\s*\(?\s*["'][^"']*\/src\//,
    message: "server/ 里不许 import src/（客户端代码会进 Node 进程）",
  },
  {
    id: "B3",
    files: () => walk(join(root, "server")),
    /*
     * 红线 3：服务端不做加解密。`@noble/*` 只进客户端构建。
     *
     * **只拦真正的加载**（`from "@noble/…"` / `require("@noble/…")`）—— 见上面的说明：
     * 把「提到这个名字」也拦掉，会让人不敢在注释里写这条规则。
     */
    pattern: /(?:from|import|require)\s*\(?\s*["']@noble\//,
    message: "server/ 里不许 import @noble/*（红线 3：服务端不得有加解密能力）",
  },
  {
    id: "B4",
    files: () => walk(join(root, "server")),
    // 更宽的兜网：哪怕不 import 加密库，自己写一个 decrypt 也算破线。
    pattern: /\b(?:export\s+(?:async\s+)?function\s+|export\s+const\s+)(?:decrypt|encrypt|unwrapKey|deriveNotebookKey)\b/,
    message: "server/ 里不许导出解密/加密函数（红线 3）",
  },
];

const violations = [];
for (const rule of RULES) {
  const files = await rule.files();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    // 逐行找，方便报出确切位置。
    text.split(/\r?\n/).forEach((line, index) => {
      if (rule.pattern.test(line)) {
        violations.push({ rule, file: relative(root, file).replace(/\\/g, "/"), line: index + 1, text: line.trim() });
      }
    });
  }
}

if (violations.length === 0) {
  console.log(`[opennote] 边界检查通过（${RULES.length} 条规则）`);
  process.exit(0);
}

console.error("[opennote] 边界检查未通过：");
for (const item of violations) {
  console.error(`  ${item.rule.id} ${item.file}:${item.line}  ${item.text}`);
  console.error(`      → ${item.rule.message}`);
}
process.exit(1);
