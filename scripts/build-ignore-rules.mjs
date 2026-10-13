/**
 * 把同步范围的**唯一判定函数**（`src/sync/ignore.ts`）编译成主进程能 require 的 CommonJS。
 *
 * **为什么需要这一步**：渲染层（`src/`）走 Vite，import TypeScript 天经地义；但主进程是
 * 纯 CommonJS（`electron/main.cjs`、`electron/bridge.cjs`），**require 不了 `.ts`**。
 * 而 `docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.11 要求「扫描与 watcher 共用同一个
 * 判定函数」——所以这里把那一份实现**机械地**编译出来，产物是 `electron/ignore-rules.cjs`。
 *
 * **不是第二份实现**：产物不要手改，改 `src/sync/ignore.ts` 后重跑 `pnpm build:ignore`
 * （`dev:electron` 与 `build:desktop` 都会先跑一次，所以 `pnpm dev` 下也是最新的）。
 *
 * ⚠️ TypeScript 7 是原生编译器，**不再导出 JS API**（`require('typescript').ScriptTarget`
 * 是 undefined），所以这里只能驱动 `tsc` 这个 CLI，配置走 `tsconfig.ignore-rules.json`。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(root, "node_modules", "typescript", "bin", "tsc");
const OUT_DIR = join(root, ".ignore-rules-build");
/** 产物必须是 `.cjs`：仓库根 `package.json` 带 `"type": "module"`，`.js` 会被当 ESM 解析。 */
const OUT_FILE = join(root, "electron", "ignore-rules.cjs");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

await rm(OUT_DIR, { recursive: true, force: true });

try {
  await run(process.execPath, [TSC, "--ignoreConfig", "src/sync/ignore.ts", "--outDir", ".ignore-rules-build", "--module", "commonjs", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--esModuleInterop", "--isolatedModules", "--skipLibCheck"]);

  const compiled = await readFile(join(OUT_DIR, "ignore.js"), "utf8");
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(
    OUT_FILE,
    "/* eslint-disable */\n" +
      "/* 构建产物（scripts/build-ignore-rules.mjs）—— 不要手改。\n" +
      "   源文件：src/sync/ignore.ts；重新生成：pnpm build:ignore */\n" +
      compiled,
    "utf8",
  );
  console.log("[opennote] 同步忽略规则已生成：electron/ignore-rules.cjs");
} finally {
  await rm(OUT_DIR, { recursive: true, force: true });
}
