/**
 * Standalone vite config for the jump-probe.
 *
 * It exists only so the probe gets its own root/port and — more importantly —
 * a pre-warmed dependency graph. Without `optimizeDeps.include` vite discovers
 * `katex` / `mermaid` / `@codemirror/lang-javascript` on first use and reloads
 * the page mid-measurement, which would throw away the editor state the probe
 * is measuring.
 *
 *   npx vite --config .tmp-verify/jump-probe/vite.config.mts
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: repoRoot,
  base: "/",
  logLevel: "info",
  optimizeDeps: {
    entries: [".tmp-verify/jump-probe/index.html"],
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
    port: 5199,
    strictPort: true,
    host: "127.0.0.1",
  },
});
