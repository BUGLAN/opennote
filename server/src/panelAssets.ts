/**
 * 控制台静态资源的读取（`docs/执行-三端同步…` §4.6：**无构建步骤**的静态页）。
 *
 * ## 为什么是「读文件」而不是「打包进来」
 *
 * 控制台的 HTML/CSS/JS 是**给人改的**（§4.6：它只是运维界面，不是产品的一部分）。
 * 把它们打进 bundle 的话，改一行样式也要重新构建 JS —— 那正好抵消了「无构建步骤」的收益。
 * 所以它们是**真的文件**，服务端在启动时读进内存（几个 KB，之后只从内存发）。
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
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 控制台静态文件的目录（相对本模块）。 */
const ASSET_DIR = new URL("./panel/", import.meta.url);

export interface PanelAsset {
  body: string;
  contentType: string;
}

/** 资源名 → content-type。**只允许这三个**（不是通用静态服务器）。 */
const ASSETS: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};

let cache: Map<string, PanelAsset> | null = null;

/**
 * 读一个资源（带缓存）。
 *
 * ⚠️ **白名单**而不是「拼路径」：`/panel/{任意}` 若直接拼进文件路径就是一个
 * 目录穿越漏洞（`/panel/../../etc/passwd`）。这里的 `ASSETS` 表就是白名单，
 * 名字不在表里的一律返回 `null`。
 */
export function loadPanelAsset(name: string): PanelAsset | null {
  const contentType = ASSETS[name];
  if (!contentType) return null;
  if (!cache) {
    cache = new Map();
    for (const [key, type] of Object.entries(ASSETS)) {
      const path = fileURLToPath(new URL(key, ASSET_DIR));
      try {
        cache.set(key, { body: readFileSync(path, "utf8"), contentType: type });
      } catch (error) {
        throw new Error(
          `控制台静态资源读不到：${path}\n` +
            `（期望它位于与本模块同层的 panel/ 目录下；构建产物需要把 server/src/panel/* 拷到 dist/panel/）\n` +
            `原始错误：${String(error)}`,
        );
      }
    }
  }
  return cache.get(name) ?? null;
}

/** 面板的资源清单（测试与诊断用；也让「加了文件忘了登记」变得可见）。 */
export function panelAssetNames(): string[] {
  return Object.keys(ASSETS);
}

/** 清掉缓存（测试用：改了资源文件之后要能重新读）。 */
export function resetPanelAssetCacheForTests(): void {
  cache = null;
}
