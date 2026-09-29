import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * `VITE_BASE` lets the same build be served from a domain root or from a
 * project sub-path (GitHub Pages：`VITE_BASE=/opennote/ pnpm build`).
 * The desktop build (`pnpm build:desktop`) loads through `file://`, where only
 * relative paths work — and the service worker is meaningless there.
 */
const isDesktop = process.env.OPENNOTE_DESKTOP === "1";

export default defineConfig({
  base: isDesktop ? "./" : (process.env.VITE_BASE ?? "/"),
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
        // Mermaid (~4.9 MB) and KaTeX are only needed once a note actually uses
        // them, so keep them out of the install-time precache and cache them on
        // first use instead.
        globIgnores: ["**/mermaid-*.js", "**/katex-*.js"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/(?:mermaid|katex)-[\w-]+\.js$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "opennote-on-demand",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
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
  ],
  build: {
    target: "es2022",
    cssTarget: "chrome110",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/mermaid") || id.includes("node_modules/d3")) return "mermaid";
          if (id.includes("node_modules/katex")) return "katex";
          if (id.includes("node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, host: "127.0.0.1" },
});
