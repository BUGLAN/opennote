/**
 * 附件**落点与引用文本**的纯路径运算（唯一产地）。
 *
 * 为什么单独一个模块：这些函数有三个调用方，而它们必须逐字一致，否则「剪藏写下的引用」
 * 与「迁移器改写出的引用」迟早漂移：
 *   1. 剪藏落盘 `src/lib/clip/landing.ts`（re-export，既有导入路径一个字不改）；
 *   2. 编辑器粘贴 `saveImage`（`src/data/library.ts` 经 landing 使用）；
 *   3. 旧附件迁移器 `src/data/migrateAssets.ts` —— 它**不能**直接 import `landing.ts`，
 *      因为 landing 还 import 着 `../data/library`（React / idb / localStorage 整串前端
 *      运行时），命令行进程不该为了算一个文件名把它们拉起来。
 *
 * 本模块只依赖 `../fs/paths` 与 `./hash`，所以渲染进程与命令行都能用。
 */

import { extName, normalizePath, parentPath, sanitizeName } from "../fs/paths";
import { contentUuid } from "../lib/clip/hash";

/**
 * 附件目录：**整个笔记本共用一个**，在工作区根下、以点开头。
 *
 * 0.4.0 用户裁定（原话「很多笔记都是用 git 管理的，这样每次都会多一个文件夹」）：
 * 旧规则是按笔记名派生 `<笔记名>.assets/` —— 每剪一篇带图的文章就在 git 里多一个目录，
 * 而且目录名跟着（可能很长的）笔记标题走。现在统一落在工作区根的 `.assets/`：
 *   - git 里**只有一个**附件目录；
 *   - 点开头 ⇒ `isHiddenPath()` 已经把它挡在左栏目录树与剪藏落点候选之外，无需额外排除。
 *
 * 代价（用户已知晓并接受）：图片不再跟着笔记搬。移动/回收站/恢复改走
 * `rebaseNoteAssetRefs()` 重写正文引用（见 `src/data/library.ts`），图本身留在原地。
 */
export const SHARED_ASSETS_DIR = ".assets";

/** 附件目录（唯一产地）。不带参数：落点与笔记路径无关了。 */
export function assetsDirFor(): string {
  return SHARED_ASSETS_DIR;
}

/**
 * 取正文里那条**相对引用**：从笔记所在目录走到附件路径。
 *
 * `操作系统/产品/a.md` + `.assets/x.png` → `../../.assets/x.png`
 * `a.md` + `.assets/x.png`              → `.assets/x.png`
 *
 * 不能借道 `normalizePath`：它把 `..` 当冗余段**吃掉**（`../.assets/x.png` → `.assets/x.png`），
 * 前缀必须在这里按目录层数现算。写入时算、读取时由 `resolveWorkspacePath()` 反向吃掉 `..`。
 */
export function relativeAssetRef(notePath: string, assetPath: string): string {
  const fromDir = parentPath(notePath);
  const from = fromDir ? fromDir.split("/") : [];
  const target = normalizePath(assetPath).split("/");
  const file = target.pop() ?? "";
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common += 1;
  return [...Array(from.length - common).fill(".."), ...target.slice(common), file].filter(Boolean).join("/");
}

/**
 * Markdown 链接/图片目标的**唯一产地**（`](…)` 里那个字符串）。
 *
 * 为什么需要它：附件路径可能带空格（`备注 2.assets/a.png`、`x-2 副本.png`）。**空格会截断
 * 链接目标**：
 *   - `![x](./备注 2.assets/a.png)` ⇒ markdown-it 不产 `<img>`、lezer 不产 URL 子节点
 *     ⇒ 编辑器里图片不显示，而且**不报错**；
 *   - `![x](<./备注 2.assets/a.png>)` ⇒ 两边都正常。
 *
 * CommonMark 的**角度括号目标**是唯一既能表达空格、又被 markdown-it / lezer / Typora / VS Code
 * 共同支持的写法（百分号编码要靠各渲染器愿意解码，不可靠）。
 * 把两个产地（`saveImage` 的 markdown、剪藏的 `rewriteAssetRefs`）都接到这一个函数上，
 * 免得一处转义、另一处不转义。
 */
export function markdownRef(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path;
}

/**
 * 附件最终名：`<uuid>.<ext>`（0.4.0 用户裁定：**默认就用 uuid 命名**）。
 *
 * 名字里的 uuid 由**内容**派生（`contentUuid`，同一份字节同一个名字）：
 * 重试幂等、重复剪藏命中同一路径、不产生 `x-2.png` 垃圾 —— 这些性质一条不少。
 * 保留原名的**扩展名**（`.png` / `.jpg`…）：系统与编辑器靠它认文件类型，不能丢。
 *
 * 旧规则是 `contentHash8(bytes) + "-" + sanitizeName(name)`：名叫「原始名」的那一段
 * 直接来自图片 URL 末段，而有些站点把整条 URL 编成十六进制塞进路径，
 * 文件名于是长成 `63e80eb9-68747470733a2f2f7169616e77656e…`（用户实测截图）。
 * 顺带把「名字本身当路径逃逸入口」这条路彻底堵死：落盘名里只剩 uuid 与扩展名。
 */
export async function assetFinalName(bytes: Uint8Array, name: string): Promise<string> {
  const sanitized = sanitizeName(name, "attachment");
  const ext = extName(sanitized);
  // 扩展名只认「点 + 1~6 位字母数字」：`evil.png/../x` 这种被 sanitize 成带空格的名字，
  // 取不到合法扩展名时就不带扩展名，绝不把名字里的怪字符带回路径。
  const safeExt = /^\.[A-Za-z0-9]{1,6}$/.test(ext) ? ext.toLowerCase() : "";
  return `${await contentUuid(bytes)}${safeExt}`;
}

/**
 * 去重名：`foo/assets/a1b2-x.png` + 3 → `foo/assets/a1b2-x-3.png`（扩展名之前插序号）。
 *
 * 用 `-2` 而不是 ` 2`：这个名字会出现在正文的 Markdown 引用里，**空格会截断链接目标**
 * （`markdownRef` 得写成 `<…>` 才救得回来）。剪藏落点与编辑器粘贴都走这一条。
 */
export function dedupeAssetName(candidate: string, index: number): string {
  const ext = extName(candidate);
  return ext ? `${candidate.slice(0, candidate.length - ext.length)}-${index}${ext}` : `${candidate}-${index}`;
}
