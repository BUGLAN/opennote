/**
 * 正文引用 → **工作区路径**（唯一产地）。
 *
 * 为什么单独一个模块：这个函数被三条路用到，而它们**必须**用同一套语义，否则
 * 「图片在编辑器里显示得出来、迁移器却认为它是死引用」这类静默分家就会发生：
 *   1. 渲染/预载/复制图片（`src/data/assets.ts`，re-export 保持既有导入路径不变）；
 *   2. 旧附件迁移器的引用解析与逐条反解校验（`src/data/migrateAssets.ts`）；
 *   3. 命令行迁移器（`scripts/migrate-assets.mjs` 经 `src/data/migrateAssets.ts` 进入）。
 *
 * 第 3 条是它不能留在 `assets.ts` 里的原因：`assets.ts` 还 import 着 `library` / `ui` /
 * `legacy`（React、idb、localStorage），命令行进程为了「解析一条相对引用」去把整个前端
 * 运行时拉起来，既慢又脆。这里只依赖 `normalizePath`，所以两条路都干净。
 */

import { normalizePath } from "./paths";

export function resolveWorkspacePath(src: string, baseDir: string): string | null {
  const value = src.trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
  if (!value) return null;
  if (value.startsWith("asset://")) return null;
  if (value.startsWith("/")) {
    const absolute = normalizePath(value);
    return absolute || null;
  }
  /*
   * **先拼接、再归一**（0.4.0 修）：`..` 必须在**目录语义**下被吃掉。
   *
   * 旧写法是 `joinPath(baseDir, normalizePath(value))` —— 而 `normalizePath` 把 `..` 当
   * 冗余段直接丢弃，于是 `操作系统/产品/a.md` 里的 `../../.assets/x.png` 会先被压成
   * `.assets/x.png`，再拼成 `操作系统/产品/.assets/x.png`：**指到一个不存在的地方**。
   * 共享附件目录（工作区根的 `.assets/`）全靠这条语义，图才不会「编辑器里是裂图」。
   */
  const joined = normalizePath(`${baseDir}/${value}`);
  return joined || null;
}
