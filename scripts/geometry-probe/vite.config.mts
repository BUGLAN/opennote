/**
 * geometry-probe 的独立 vite 配置。
 *
 * 两个作用：
 *  1. **独立端口**（默认 5211），不和 `pnpm dev`（5173）打架，也不和归档探针（5199）打架。
 *  2. 预打包依赖图。没有 `optimizeDeps.include` 的话 vite 会在第一次用到
 *     `mermaid` / `katex` / `@codemirror/lang-javascript` 时才发现它们、然后
 *     **重新加载页面** —— 那会把正在被测量的编辑器状态整个丢掉，量出来的是垃圾。
 *
 * `root` 指向仓库根，这样 `index.html` 里的 `/src/styles/*.css` 与 `probe.ts` 里的
 * `../../src/editor/*` 都能按产品代码的真实路径解析。
 *
 *   node node_modules/vite/bin/vite.js --config scripts/geometry-probe/vite.config.mts
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.GEOMETRY_VITE_PORT ?? 5211);

export default defineConfig({
  root: repoRoot,
  base: "/",
  logLevel: "info",
  optimizeDeps: {
    entries: ["scripts/geometry-probe/index.html"],
    include: [
      "mermaid",
      "katex",
      "markdown-it",
      "dompurify",
      "idb",
      "@capacitor/core",
      "@capacitor/filesystem",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/search",
      "@codemirror/lang-markdown",
      "@codemirror/language-data",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/markdown",
    ],
  },
  server: {
    port,
    strictPort: true,
    host: "127.0.0.1",
    /*
     * 关掉 HMR 与文件监听 —— 判据要的是**一次测量期间的绝对稳定**。
     *
     * 不关的话：只要有人在同一个工作区里改 `src/**`（并发修复、保存中的编辑器），
     * vite 的文件监听就会给页面推一次 HMR 更新；探针页面没有 `import.meta.hot.accept`，
     * vite 于是整页 reload —— 正在被测量的 EditorView 连同它的状态一起消失，
     * CDP 那边报 `Inspected target navigated or closed`（实测连撞两次）。
     * 依赖预打包完成后的自动 reload 也走同一条通道，一起被堵掉。
     *
     * 页面每次都是重新从磁盘加载的，所以关掉监听不会让探针读到旧代码。
     */
    hmr: false,
    watch: null,
  },
});
