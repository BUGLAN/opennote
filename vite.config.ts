import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * `VITE_BASE` lets the same build be served from a domain root or from a
 * project sub-path (GitHub Pages：`VITE_BASE=/opennote/ pnpm build`).
 * The desktop build (`pnpm build:desktop`) loads through `file://`, where only
 * relative paths work — and the service worker is meaningless there.
 */
const isDesktop = process.env.OPENNOTE_DESKTOP === "1";

/**
 * Root `package.json` — its `version` is the single version source for both
 * desktop (`app.getVersion()` at runtime) and web (baked into the bundle via
 * `define` below, because the web build has no preload bridge to ask).
 */
const appPackage = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version?: string;
};

/** The slice of rolldown's `PreRenderedChunk` the chunk layout needs. */
interface PreRenderedChunkInfo {
  name: string;
  moduleIds?: string[];
}

/* --------------------------------------------------------- bundle layout */

/** `node_modules/@scope/name/…` → `@scope/name` (pnpm's `.pnpm/…` store included). */
function packageNameOf(id: string): string | null {
  const normalized = id.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("node_modules/");
  if (marker < 0) return null;
  const parts = normalized.slice(marker + "node_modules/".length).split("/");
  if (!parts[0]) return null;
  if (parts[0].startsWith("@")) return parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

/**
 * D28: everything the app only reaches through `import()` — the ~150 CodeMirror
 * language packages, the whole Mermaid graph, KaTeX — is emitted into
 * `assets/lazy/`, which the service worker leaves out of the install-time
 * precache and fills from the network on first use (`workbox.runtimeCaching`).
 *
 * A chunk is moved there only when *every* module inside it belongs to a package
 * that `src/**` never imports statically. A chunk that also carries shell code
 * (shared editor internals, `dompurify`, …) is loaded during startup, so it has
 * to stay in the precache — otherwise the offline app would fail to boot.
 * The invariant to check on `dist/` after a build: every file in the static
 * import closure of `index.html` must appear in `sw.js`'s precache manifest.
 */
const eagerlyImportedPackages = new Set<string>();

const SOURCE_FILE = /\.(?:ts|tsx|js|jsx)$/;
const STATIC_IMPORT_FROM = /(?:^|[\s;}])(?:import|export)\s[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
const STATIC_IMPORT_BARE = /(?:^|[\s;}])import\s*["']([^"']+)["']/g;

/** `"@scope/name/sub"` → `"@scope/name"`; `null` for relative paths and assets. */
function packageNameOfSpecifier(specifier: string): string | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (/\.(?:css|svg|png|jpe?g|gif|woff2?|ttf|wasm)$/i.test(specifier)) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/**
 * Records every package `src/**` imports statically: those modules are part of
 * the app shell, no matter which chunk rolldown decides to put them in.
 */
function scanEagerAppPackages(root: string): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(join(dir, entry.name));
        continue;
      }
      if (!SOURCE_FILE.test(entry.name)) continue;
      const code = readFileSync(join(dir, entry.name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const pattern of [STATIC_IMPORT_FROM, STATIC_IMPORT_BARE]) {
        for (const match of code.matchAll(pattern)) {
          const pkg = packageNameOfSpecifier(match[1]);
          if (pkg) eagerlyImportedPackages.add(pkg);
        }
      }
    }
  };
  const src = join(root, "src");
  if (existsSync(src)) walk(src);
}

function isLazyChunk(moduleIds: string[]): boolean {
  let sawThirdPartyModule = false;
  for (const rawId of moduleIds) {
    const id = rawId.replace(/\\/g, "/");
    if (id.includes("\0")) continue; // vite/rolldown runtime helpers ship with the shell
    const pkg = packageNameOf(id);
    if (!pkg) return false; // app source, assets, project css
    if (eagerlyImportedPackages.has(pkg)) return false;
    sawThirdPartyModule = true;
  }
  return sawThirdPartyModule;
}

/**
 * A readable file name for an on-demand chunk — `codemirror-lang-python-<hash>.js`
 * instead of rolldown's `dist-<hash>.js`, which keeps the build log and
 * DevTools network panel usable.
 */
function lazyChunkLabel(moduleIds: string[], fallback: string): string {
  const ids = moduleIds.map((id) => id.replace(/\\/g, "/"));
  const legacyMode = ids.map((id) => id.match(/node_modules\/@codemirror\/legacy-modes\/(.+)\.js$/)).find(Boolean);
  if (legacyMode?.[1]) return legacyMode[1].replace(/\//g, "-");
  const packages = ids.map((id) => packageNameOf(id));
  const language = packages.find((pkg) => pkg?.startsWith("@codemirror/lang-") || pkg?.startsWith("@lezer/"));
  if (language) return language.replace(/^@/, "").replace(/\//g, "-");
  return fallback.replace(/[/\\]/g, "-");
}

/** Fills {@link eagerlyImportedPackages} before rolldown starts chunking. */
function appImportScanPlugin(): Plugin {
  return {
    name: "opennote:app-import-scan",
    apply: "build",
    configResolved(config) {
      scanEagerAppPackages(config.root);
    },
  };
}

/* ------------------------------------------------------- content security */
/**
 * The HTML parser normalises CRLF (and a lone CR) to LF before an inline script
 * is hashed, so the digest has to be computed over the normalised text too.
 * Without this the hash only matches on checkouts that happen to be LF: with
 * `core.autocrlf=true` the inline theme bootstrap would be blocked by CSP.
 */
function normalizedScriptText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * D38: the web build ships a strict CSP. `index.html`'s theme bootstrap is an
 * inline script, so its sha256 is added to `script-src` — `'unsafe-inline'` is
 * never used for scripts. The desktop build must not inject the meta policy:
 * the main process adds the response-header policy instead, and intersecting
 * both would drop `file://` scripts (see T3).
 */
function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: "opennote:csp-meta",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      if (isDesktop) return html;
      const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        (match) => `'sha256-${createHash("sha256").update(normalizedScriptText(match[1]), "utf8").digest("base64")}'`,
      );
      const policy = [
        "default-src 'self'",
        ["script-src 'self'", ...hashes].join(" "),
        // `cdn.jsdelivr.net` is the only external origin: the optional 霞鹜文楷
        // font is fetched on demand by `src/data/ui.ts` (falls back to the system
        // 楷体 when it is offline or blocked).
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "img-src 'self' data: blob:",
        "font-src 'self' data: https://cdn.jsdelivr.net",
        /*
         * 两个 GitHub 来源是「从 GitHub 仓库导入 / 同步」要用的（网页版专属）：
         * `api.github.com` 读元数据 / 文件树 / 写提交，`raw.githubusercontent.com` 逐文件读内容
         * （CDN 不占 API 那 60 次/小时的匿名配额）。两处都返回 `Access-Control-Allow-Origin: *`。
         * 桌面版**不放**这两个：它的策略在 `electron/main.cjs` 的 `cspPolicy()` 里，那边对应功能也不开放。
         */
        "connect-src 'self' https://api.github.com https://raw.githubusercontent.com",
        "media-src 'self' blob: data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
      ].join("; ");
      return html.replace(
        /<head([^>]*)>/i,
        (head) => `${head}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

export default defineConfig({
  base: isDesktop ? "./" : (process.env.VITE_BASE ?? "/"),
  define: {
    // 网页版没有 preload 桥（`window.opennote.version` 不存在），关于页之前只能写
    // 「版本未知」。构建时把根 package.json 的版本号烧进包里；
    // `src/lib/appVersion.ts` 是渲染层唯一消费处。
    __OPENNOTE_VERSION__: JSON.stringify(appPackage.version ?? ""),
  },
  plugins: [
    react(),
    VitePWA({
      disable: isDesktop,
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Opennote · 开源笔记",
        short_name: "Opennote",
        description: "纯前端、开源、Typora 风格的 Markdown 笔记本，笔记只存在你的浏览器里。",
        lang: "zh-CN",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#fbf8f3",
        theme_color: "#fbf8f3",
        categories: ["productivity", "utilities"],
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        // Mermaid (~4.9 MB), KaTeX, the ~150 CodeMirror language chunks and the
        // webfonts are only needed once a note actually uses them, so keep them
        // out of the install-time precache and cache them on first use instead.
        globIgnores: [
          "**/assets/lazy/**",
          "**/mermaid-*.js",
          "**/katex-*.js",
          "**/*.woff",
          "**/*.woff2",
          "**/*.ttf",
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/(?:lazy\/)?(?:mermaid|katex)[\w.-]*\.js$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "opennote-on-demand",
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Every other on-demand chunk (CodeMirror languages and Mermaid's own
            // dependencies): hashed and immutable, fetched only when needed.
            urlPattern: /\/assets\/lazy\/[\w.-]+\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "opennote-languages",
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\.(?:woff2?|ttf)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "opennote-fonts",
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    contentSecurityPolicyPlugin(),
    appImportScanPlugin(),
  ],
  build: {
    target: "es2022",
    cssTarget: "chrome110",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Shell chunks stay in `assets/`, on-demand chunks (D28) in `assets/lazy/`.
        chunkFileNames(info: PreRenderedChunkInfo) {
          const moduleIds = info.moduleIds ?? [];
          if (!isLazyChunk(moduleIds)) return "assets/[name]-[hash].js";
          return `assets/lazy/${lazyChunkLabel(moduleIds, info.name)}-[hash].js`;
        },
        manualChunks(id) {
          // The KaTeX stylesheet stays with the app shell (it is imported by
          // `main.tsx`); only the engine itself is loaded on demand.
          if (id.includes("node_modules/katex") && !id.endsWith(".css")) return "katex";
          if (id.includes("node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, host: "127.0.0.1" },
});
