import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 网页版剪藏页（A2）的独立构建。
 *
 * 它和应用主构建（`vite.config.ts`）分开，有三个原因：
 * 1. 入口是 `clip/index.html`，产物必须落在 `dist-clip/clip/` 前缀下：桥用
 *    `/clip/<stageId>` 提供页面、`/clip/assets/*` 提供资源，而 HTML 在 `clip/` 里
 *    才写得出 `./assets/x.js` 这种相对引用（从 `/clip/<stageId>` 解析成 `/clip/assets/x.js`）；
 * 2. 这个页面是"一次性"的（打开 → 编辑 → 入库 → 关掉）：不需要 PWA / Service Worker，
 *    要的是最短的启动路径；
 * 3. 桥在响应头里下发 CSP（`script-src 'self'`），所以页面里不许有任何内联可执行脚本，
 *    也就不需要主构建那个给内联脚本算 sha256 的 CSP 插件。
 */
const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const clipEntry = fileURLToPath(new URL("clip/index.html", import.meta.url));

/** 产物里页面自己那一层目录：`dist-clip/clip/...`。 */
const CLIP_DIR = "clip";

/**
 * HTML 里的资源引用必须相对于页面自己：`./assets/x.js`。
 *
 * 为什么需要这个钩子：Vite 给 `base: "./"` 的**嵌套** HTML 算相对基路径时把 HTML 路径
 * 当成目录，算出的是 `..`（根级 `index.html` 才是 `.`）；而 chunk 的文件名是相对 outDir 的
 * `clip/assets/...`，两者一拼就是 `../clip/assets/...`。那个地址在本例里恰好也能解析对，
 * 但它依赖"URL 末尾没有斜杠"，而且和契约说好的 `./assets/x.js` 不是一回事。
 * 这里只重写本页自己的产物（outDir 相对路径以 `clip/` 开头），其它（公开目录文件、CSS 里的
 * 字体引用）一律交回 Vite 默认处理 —— 字体本来就与 CSS 同目录，实测是 `./xxx.woff2`，正确。
 */
function clipHtmlAssetUrl(filename: string): string | undefined {
  if (!filename.startsWith(`${CLIP_DIR}/`)) return undefined;
  return `./${filename.slice(CLIP_DIR.length + 1)}`;
}

/**
 * 构建期红线：产物 HTML 里**只许**有 `./assets/...` 这种相对引用。
 * 一旦 Vite 的算法或上面的配置漂了，宁可让 `pnpm build:clip` 当场红，也不要交付一个
 * 页面上全是 404 的产物（页面的兜底文案只会说"脚本没加载成功"，看不出是路径错了）。
 */
function assertRelativeAssetRefs(): Plugin {
  return {
    name: "opennote-clip:assert-relative-refs",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const name = Object.keys(bundle).find((file) => file === `${CLIP_DIR}/index.html`);
      if (name === undefined) {
        this.error(`产物里没有找到 ${CLIP_DIR}/index.html`);
        return;
      }
      const asset = bundle[name];
      const source = asset.type === "asset" ? asset.source : "";
      const html = typeof source === "string" ? source : new TextDecoder().decode(source);
      const refs = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
      const offenders = refs.filter((ref) => ref !== "" && !ref.startsWith("data:") && !ref.startsWith("./assets/"));
      if (offenders.length > 0) {
        this.error(
          `${CLIP_DIR}/index.html 里的资源引用必须是 ./assets/...，实际出现了：${offenders.join("、")}`,
        );
      }
    },
  };
}

export default defineConfig({
  root: repoRoot,
  // 这页不用应用 `public/` 里的图标与清单：不复制，产物里就只有页面自己的东西。
  publicDir: false,
  // 相对基路径：产物 HTML 里的资源引用必须是 `./assets/...`，不是 `/assets/...`。
  base: "./",
  plugins: [react(), assertRelativeAssetRefs()],
  experimental: {
    renderBuiltUrl(filename, context) {
      return context.hostType === "html" ? clipHtmlAssetUrl(filename) : undefined;
    },
  },
  build: {
    outDir: "dist-clip",
    emptyOutDir: true,
    target: "es2022",
    cssTarget: "chrome110",
    /*
     * 资源目录必须写成 `clip/assets`，不能留默认的 `assets`。
     * 页面 HTML 在 `dist-clip/clip/index.html`，默认 assetsDir 会把 JS/CSS/字体放到
     * `dist-clip/assets/`，HTML 里于是写成 `../assets/x.js` —— 桥按 `/clip/assets/*`
     * 提供静态资源，那就 404 了。写成 `clip/assets` 后，HTML 里的引用是 `./assets/x.js`，
     * 从 `/clip/<stageId>` 解析出来就是 `/clip/assets/x.js`。
     */
    assetsDir: `${CLIP_DIR}/assets`,
    rollupOptions: {
      input: clipEntry,
    },
  },
});
