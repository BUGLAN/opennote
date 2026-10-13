/**
 * 打包服务端（`pnpm build:server`）→ `server/dist/{index,cli}.js`。
 *
 * ## 为什么要打包，而不是 `tsc` 直接 emit
 *
 * 源码里的相对导入**没有 `.js` 扩展名**（`from "./config"`）—— 那是 bundler 风格，
 * TypeScript 能解析、Vite 能解析，但 **Node 的 ESM 解析器不能**：它会去找
 * `./config` 这个文件本身，然后报 `ERR_MODULE_NOT_FOUND`。
 *
 * 所以 `tsc` 直出的 `dist/` **跑不起来**（这一点我在 `server/tsconfig.build.json`
 * 里如实写了，没有假装构建好了）。三条出路：
 *
 *   a. **过一遍打包器**（本文件）—— 产物自洽、可 `node dist/index.js` 直接跑；
 *   b. 全仓相对导入加 `.js` 扩展名 —— 零构建依赖，但要改遍所有导入；
 *   c. `module: "nodenext"` + 加扩展名 —— 同 b，更严格。
 *
 * 选 a 的理由：**文档 §8.2 的部署步骤写的就是 `node dist/cli.js`**，
 * 而它也是唯一一条「不改动全仓导入」就能做到「产物可直接执行」的路。
 * 代价是多一个构建依赖 —— 而 `esbuild` **本来就在依赖树里**（`tsx` 与 Vite 都带它），
 * 所以这个代价接近零。
 *
 * ## 为什么两个入口分开打
 *
 * `index` 与 `cli` 是**两个进程**，没有共享运行时状态。分开打最简单；
 * 代价是共用的模块在两边各有一份（几十 KB 量级，无所谓）。
 * 用 `--splitting` 需要多个入口 + 共享 chunk，会引入「产物目录里有一堆 chunk」的复杂度，
 * 而收益在这个体量上不值得。
 */

import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "server", "dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  /*
   * `node22` 对齐 `.nvmrc` / CI 用的 Node 版本。定得**保守**一点：
   * 把 target 抬到比运行时更高的语法，会在容器里以「语法错误」的形式炸，
   * 而那种错误信息指不到真正的原因。
   */
  target: "node22",
  sourcemap: true,
  // 依赖**打进产物**：镜像里就不需要 `node_modules`（更小、也没有供应链面）。
  // 这些都是纯 JS 依赖（hono / zod），没有原生模块。
  packages: "bundle",
  /*
   * `node:sqlite` 是实验性内置模块。esbuild 对 `node:` 前缀会自动外部化，
   * 但显式写出来更能说明「这是运行时提供的，不是我们的依赖」。
   */
  external: ["node:*"],
  logLevel: "warning",
  banner: {
    /*
     * 有些 CJS 依赖会用到 `require` / `__dirname`，而 ESM 产物里它们不存在。
     * 垫一个 `createRequire` 是最省事的兼容做法（本项目当前没有这类依赖，
     * 但少一个「以后加依赖时诡异报错」的坑）。
     */
    js: [
      "import { createRequire as __opennoteCreateRequire } from 'node:module';",
      "const require = __opennoteCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};

const entries = [
  { in: join(root, "server", "src", "index.ts"), out: join(outDir, "index.js") },
  { in: join(root, "server", "src", "cli.ts"), out: join(outDir, "cli.js") },
];

for (const entry of entries) {
  await build({ ...common, entryPoints: [entry.in], outfile: entry.out });
}

/*
 * 一个最小的 `package.json`：产物是 ESM，而 `dist/` 的**最近祖先** `server/`
 * 没有自己的 `package.json` —— Node 会一路往上找到仓库根的 `"type": "module"`，
 * 于是恰好是对的。但**显式写一份更稳**：将来 `server/` 加了自己的 `package.json`
 * （或者镜像里只 COPY 了 dist），行为不会意外变化。
 */
writeFileSync(join(outDir, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, "utf8");

const { statSync } = await import("node:fs");
for (const entry of entries) {
  const size = statSync(entry.out).size;
  console.log(`[build:server] ${entry.out.replace(`${root}\\`, "").replace(`${root}/`, "")}  ${(size / 1024).toFixed(0)} KB`);
}
console.log("[build:server] 完成。产物自洽（依赖已打进包），可直接 `node server/dist/index.js`。");
