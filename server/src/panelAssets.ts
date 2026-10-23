/**
 * 控制台静态资源的读取（`docs/执行-三端同步…` §4.6：**无构建步骤**的静态页）。
 *
 * ## 为什么是「读文件」而不是「打包进来」
 *
 * 控制台的 HTML/CSS/JS 是**给人改的**（§4.6：它只是运维界面，不是产品的一部分）。
 * 把它们打进 bundle 的话，改一行样式也要重新构建 JS —— 那正好抵消了「无构建步骤」的收益。
 * 所以它们是**真的文件**，服务端在启动时读进内存（几百 KB，之后只从内存发）。
 *
 * ## 路径必须在两种运行方式下都对
 *
 * | 怎么跑 | `import.meta.url` 在哪 | `./panel/` 指向 |
 * | --- | --- | --- |
 * | `tsx server/src/index.ts`（开发） | `server/src/panelAssets.ts` | `server/src/panel/` ✅ |
 * | `node dist/index.js`（产物） | `dist/index.js` | `dist/panel/` ✅ |
 *
 * 两者形状相同，**前提是本文件与入口同层**（`server/src/` / `dist/`），
 * 且构建脚本把 `server/src/panel/*` 拷到 `server/dist/panel/`。
 * 这个「同层」的约束写在注释里而不是靠记忆 —— 一旦有人把它挪到子目录，这里会立刻读不到。
 *
 * 读失败**不静默**：控制台打不开是运维事故（§4.12：控制台是主要入口），
 * 所以如实报错并说清期望的路径。
 *
 * ## 为什么字体和印章也要走这张表
 *
 * 控制台与产品共用同一套自托管字体（Figtree / Newsreader / Fraunces / JetBrains Mono）。
 * `PANEL_CSP` 里 `font-src` 与 `img-src` 都只允许 `'self'`，所以它们**必须**由本服务发出 ——
 * 指向 CDN 会直接被浏览器拦掉，表现为「字体静默回退到系统字」，很难查。
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 控制台静态文件的目录（相对本模块）。 */
const ASSET_DIR = new URL("./panel/", import.meta.url);

export interface PanelAsset {
  body: string | Buffer;
  contentType: string;
  /** 二进制资源（字体/PNG）发 Buffer，文本资源发 string。 */
  binary: boolean;
}

/**
 * 资源名 → content-type。**只允许表里这些**（不是通用静态服务器）。
 *
 * ⚠️ 白名单而不是「拼路径」：`/panel/{任意}` 若直接拼进文件路径就是一个
 * 目录穿越漏洞（`/panel/../../etc/passwd`）。名字不在表里的一律 404。
 */
const ASSETS: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "api.js": "text/javascript; charset=utf-8",
  "views.js": "text/javascript; charset=utf-8",
  "icons.js": "text/javascript; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "tokens.css": "text/css; charset=utf-8",
  "assets/fonts/figtree-latin-wght-normal.woff2": "font/woff2",
  "assets/fonts/newsreader-latin-opsz-normal.woff2": "font/woff2",
  "assets/fonts/fraunces-latin-full-normal.woff2": "font/woff2",
  "assets/fonts/jetbrains-mono-latin-wght-normal.woff2": "font/woff2",
  "assets/seal/seal-light.png": "image/png",
  "assets/seal/seal-dark.png": "image/png",
  "assets/seal/indigo-light.png": "image/png",
  "assets/seal/indigo-dark.png": "image/png",
  "assets/seal/pine-light.png": "image/png",
  "assets/seal/pine-dark.png": "image/png",
  "assets/seal/gamboge-light.png": "image/png",
  "assets/seal/gamboge-dark.png": "image/png",
};

const BINARY = /\.(woff2|png|jpe?g|webp|gif|ico)$/;

let cache: Map<string, PanelAsset> | null = null;
/** 每个资源上次读进来时的 `mtimeMs`（见 `loadPanelAsset` 的「为什么还要看时间戳」）。 */
let mtimes: Map<string, number> | null = null;

/**
 * 读一个资源（带缓存，但**跟着文件走**）。
 *
 * 名字不在白名单里 → `null`（调用方回 404）。
 *
 * ## 为什么还要看时间戳
 *
 * 第一版是「第一次读就全读进来，之后只从内存发」。那在产物里没问题，但在这台页面上
 * 有一个很难查的表现：**改了 `views.js`、刷新浏览器，什么都没变**。
 *
 * 因为 `cache-control: no-store` 只约束**浏览器**；文件内容早就被进程缓存在内存里了。
 * 于是「无构建步骤、改完刷新就能看」这个承诺是假的，而失败的样子（旧页面）
 * 和「改错了」一模一样。
 *
 * 现在每次取都 `stat` 一下：`mtimeMs` 变了就重读那一个文件。
 * 成本是一次 stat（微秒级），换掉的是一整类「改了没生效」的排查时间。
 */
export function loadPanelAsset(name: string): PanelAsset | null {
  const contentType = ASSETS[name];
  if (!contentType) return null;
  if (!cache || !mtimes) {
    cache = new Map();
    mtimes = new Map();
    for (const [key, type] of Object.entries(ASSETS)) {
      const path = fileURLToPath(new URL(key, ASSET_DIR));
      const binary = BINARY.test(key);
      try {
        cache.set(key, {
          body: binary ? readFileSync(path) : readFileSync(path, { encoding: "utf8" }),
          contentType: type,
          binary,
        });
        mtimes.set(key, statSync(path).mtimeMs);
      } catch (error) {
        throw new Error(
          `控制台静态资源读不到：${path}\n` +
            `（期望它位于与本模块同层的 panel/ 目录下；构建产物需要把 server/src/panel/* 拷到 dist/panel/）\n` +
            `原始错误：${String(error)}`,
        );
      }
    }
  }

  const cached = cache.get(name);
  if (!cached) return null;
  /* 文件被改过？重读这一个（失败就继续用旧内容：宁可发旧页面，也不要 500）。 */
  try {
    const path = fileURLToPath(new URL(name, ASSET_DIR));
    const stamp = statSync(path).mtimeMs;
    if (mtimes.get(name) !== stamp) {
      const binary = BINARY.test(name);
      cache.set(name, {
        body: binary ? readFileSync(path) : readFileSync(path, { encoding: "utf8" }),
        contentType,
        binary,
      });
      mtimes.set(name, stamp);
      return cache.get(name)!;
    }
  } catch {
    /* stat 失败（文件被删/权限）：继续发内存里的那一份。 */
  }
  return cached;
}

/** 面板的资源清单（测试与诊断用；也让「加了文件忘了登记」变得可见）。 */
export function panelAssetNames(): string[] {
  return Object.keys(ASSETS);
}

/** 清掉缓存（测试用：改了资源文件之后要能重新读）。 */
export function resetPanelAssetCacheForTests(): void {
  cache = null;
  mtimes = null;
}
