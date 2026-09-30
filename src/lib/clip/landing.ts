/**
 * 落点决策与附件落盘（契约 §3.1 / §3.3 / §3.4 / §3.6）。
 *
 * 本模块只做「给定后端与快照 → 得到路径与字节」的确定性运算，不碰全局状态，
 * 方便单测直接喂一个内存后端。
 */

import {
  assertSafeRelative,
  baseName,
  extName,
  joinPath,
  normalizePath,
  parentPath,
  sanitizeName,
  stripExtension,
} from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
import { resolveAvailablePath } from "../../data/library";
import { ImportRejection, importProblem, normalizeFolder } from "./envelope";
import { contentHash8 } from "./hash";

/**
 * 请求路径 = `joinPath(folder, sanitizeName(title, "未命名") + ".md")`（契约 §3.1）。
 * `folder` 为 `null`/`""` 时是**工作区根目录**；目录不存在时逐段创建，不是失败。
 */
export function requestedNotePath(folder: string | null, title: string): string {
  const dir = normalizeFolder(folder);
  return joinPath(dir, `${sanitizeName(title, "未命名")}.md`);
}

/** 逐段 `mkdir`（幂等；三段后端都会自动创建中间层）。 */
export async function ensureFolderDirs(backend: FileSystemBackend, folder: string | null): Promise<void> {
  const dir = normalizeFolder(folder);
  if (!dir) return;
  const segments = dir.split("/");
  let prefix = "";
  for (const segment of segments) {
    prefix = joinPath(prefix, segment);
    try {
      await backend.mkdir(prefix);
    } catch (error) {
      throw new ImportRejection(
        importProblem("IMP-4009", {
          field: "target.folder",
          segment,
          reason: error instanceof Error ? error.message : "mkdir-failed",
        }),
      );
    }
  }
}

/**
 * 唯一决定文件名的两步（契约 §3.3.2）：
 * `uniquePath()` 的内存序号语义（` 2`、` 3`…）**叠加**磁盘 `exists()` 真实探测。
 * 必须走 `resolveAvailablePath()`，不得只用 `uniquePath()`：`taken` 只来自内存，
 * 「上次扫描之后由外部程序创建的同名文件」不在内存里（D03）。
 */
export async function allocateNotePath(
  backend: FileSystemBackend,
  requested: string,
  taken: Set<string>,
): Promise<string> {
  const candidate = await resolveAvailablePath(backend, requested, taken);
  // `resolveAvailablePath` 的 `guard > 500` 会放弃循环并返回一个仍被占用的候选路径。
  if (await backend.exists(candidate)) {
    throw new ImportRejection(importProblem("IMP-4010", { requested, candidate }));
  }
  taken.add(candidate);
  return candidate;
}

/**
 * 附件目录：与笔记**同级**、**按笔记名派生**的 `<noteName>.assets/`。
 *
 * 为什么不是公共 `assets/`（Lead 裁定 + 用户原话「从收件箱移动到其他位置时，图片位置也应改变」）：
 * 公共目录只有在「整个目录一起搬」时才成立；一旦**只把一篇笔记挪到别处**（或从收件箱用
 * `{folder}` 把它入库到另一个目录），`./assets/x.png` 就指空。按笔记名派生后，
 * 「图片跟笔记走」是**路径结构**保证的，不依赖任何搬迁代码记得搬。
 *
 * 不复用 `src/fs/paths.ts` 的 `ASSETS_DIR`：那个常量还被收件箱条目的 `entry/assets/`
 * 用着（`src/data/inbox.ts`），改它会波及无关功能。这里在 clip 层派生。
 */
export function assetsDirFor(notePath: string): string {
  const stem = sanitizeName(stripExtension(baseName(notePath)), "未命名");
  return joinPath(parentPath(notePath), `${stem}.assets`);
}

/**
 * 附件最终名：`contentHash8(bytes) + "-" + sanitizeName(name, "attachment")`（契约 §3.4）。
 *
 * 比 `sanitizeName` 多一步：**空白折成 `-`**。因为这个名字要直接出现在正文的
 * Markdown 相对引用里，而**空格会截断链接目标**（`![x](foo.assets/a1b2-C Windows.png)`
 * 在多数渲染器里指不到文件；`sanitizeName` 会把 `:`、`/` 等换成空格，所以很容易撞上）。
 * 只影响附件文件名，不动笔记名（笔记名走 `sanitizeName`，那个位置没有 Markdown 语法）。
 */
export async function assetFinalName(bytes: Uint8Array, name: string): Promise<string> {
  return `${await contentHash8(bytes)}-${sanitizeName(name, "attachment").replace(/\s+/g, "-")}`;
}

export interface AssetTarget {
  path: string;
  /** `true` = 命中了**内容相同**的已存在路径（重试幂等，不重复写、不覆盖）。 */
  reused: boolean;
}

/** 字节相同判定（重试幂等靠它，而不是靠「路径存在」）。 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 附件落点（契约 §3.4 + Lead 裁定「不得静默覆盖」）。
 *
 * 名字里带内容哈希 → **重试幂等**：部分成功后的重试会命中同一路径，不产生
 * `foo.assets/a 2.png`、`a 3.png` 的垃圾堆积；同名不同内容天然区分。
 *
 * 但「路径已存在」**不等于**「内容就是我们的」：用户完全可能在附件目录里手放一个
 * 同名文件（或极端哈希碰撞）。所以：
 * 1. 路径存在 + 字节相同 → 复用（不写、不覆盖）✅
 * 2. 路径存在 + 字节不同 → **可读化去重**（`x 2.png`、`x 3.png`…），**绝不静默覆盖** ✅
 * 3. 落点必须过 `assertSafeRelative()` **且父目录就是附件目录**：资产名不是路径逃逸入口（D-④）✅
 */
export async function allocateAssetPath(
  backend: FileSystemBackend,
  dir: string,
  name: string,
  bytes: Uint8Array,
  taken: Set<string>,
): Promise<AssetTarget> {
  const finalName = await assetFinalName(bytes, name);
  const candidate = safeAssetPath(joinPath(dir, finalName), name);
  // 第二道闸（比 `assertSafeRelative` 更硬）：**落点必须真在附件目录里**。
  // `joinPath` 会把 `..` 归一化掉，所以「名字里带 `..`」不会报错、而是**悄悄写到目录外** ——
  // 光靠词法校验看不出来。这里直接比对父目录，越界一律拒（`sanitizeName` 是第一道，
  // 万一它将来被改松，这一道仍然拦得住）。
  if (parentPath(candidate) !== normalizePath(dir)) {
    throw new ImportRejection(importProblem("IMP-4012", { field: "assets[].name", name, path: candidate }));
  }
  if (taken.has(candidate)) return { path: candidate, reused: true };
  if (!(await backend.exists(candidate))) {
    taken.add(candidate);
    return { path: candidate, reused: false };
  }
  const existing = await backend.readBytes(candidate).catch(() => null);
  if (existing && sameBytes(existing, bytes)) {
    taken.add(candidate);
    return { path: candidate, reused: true };
  }
  // 可读化去重：`a1b2-diagram.png` → `a1b2-diagram-2.png`（用 `-2` 而不是 ` 2`：
  // 这个名字会出现在正文的 Markdown 引用里，空格会截断链接目标）。
  for (let index = 2; index <= 52; index += 1) {
    const next = assetDedupeName(candidate, index);
    if (taken.has(next) || (await backend.exists(next))) continue;
    taken.add(next);
    return { path: next, reused: false };
  }
  throw new ImportRejection(importProblem("IMP-4010", { requested: candidate }));
}

/** `foo/assets/a1b2-x.png` + 3 → `foo/assets/a1b2-x-3.png`（扩展名之前插序号）。 */
function assetDedupeName(candidate: string, index: number): string {
  const ext = extName(candidate);
  return ext ? `${candidate.slice(0, candidate.length - ext.length)}-${index}${ext}` : `${candidate}-${index}`;
}

/** 词法护栏：附件落点的**整条**路径必须是安全的工作区相对路径。 */
function safeAssetPath(path: string, name: string): string {
  try {
    return assertSafeRelative(path);
  } catch (error) {
    throw new ImportRejection(
      importProblem("IMP-4012", {
        field: "assets[].name",
        name,
        path,
        reason: error instanceof Error ? error.message : "unsafe-name",
      }),
    );
  }
}

export interface AssetRename {
  /** 信封里的原始 `name`（正文引用的就是它）。 */
  name: string;
  /** 实际落盘路径（工作区相对）。 */
  finalPath: string;
}

/**
 * 正文引用改写（契约 §3.4）：把**客户端写法**的两种形态改成
 * **笔记同级 `<noteName>.assets/<新名>` 的相对引用**（Lead 裁定：`foo.assets/img-1.png`）。
 *
 * 两趟、各管一种形态，而不是「三次 `split/join`」：
 * - 后者会把已经改写过的结果再匹配一遍（`foo.assets/x.png` 里含有子串 `assets/x.png`），
 *   在文本里滚出 `foo.foo.assets/x.png`；
 * - 也不能把 `](` 和 `assets/` 写进同一个正则的并列分支：正则按**位置**而不是按分支顺序
 *   取第一个能匹配的，`](./assets/x.png)` 会被 `](` 分支吃掉整个路径，于是永远匹配不上。
 *
 * 表里查不到的名字**原样保留**（未声明的引用不静默删除，配合 `IMP-W002`）。
 * 新引用前缀**从 `finalPath` 现取**（`归档/foo.assets/a1b2-photo.png` → `foo.assets/a1b2-photo.png`），
 * 不重复推导笔记名——落盘在哪，正文就指哪，两边不可能漂移。
 */
export function rewriteAssetRefs(body: string, renames: AssetRename[]): string {
  if (!renames.length) return body;
  const refs = new Map<string, string>();
  for (const { name, finalPath } of renames) {
    const file = baseName(finalPath);
    const dir = baseName(parentPath(finalPath));
    refs.set(name, dir ? `${dir}/${file}` : file);
  }
  const lookup = (token: string): string | undefined => refs.get(token);
  // ① 带目录的写法：`./assets/x` 与 `assets/x`（客户端约定的两种变体）。
  const next = body.replace(/(?:\.\/)?assets\/([^\s)"'<>\]]+)/g, (match, token: string) => lookup(token) ?? match);
  // ② 裸名写法：`](x)`（同目录引用，不含 `/` 才算裸名，路径交给 ① 处理）。
  return next.replace(/\]\(([^)\s/]+)\)/g, (match, token: string) => {
    const target = lookup(token);
    return target ? `](${target})` : match;
  });
}

/** 正文里引用了 `assets/xxx` 但 `assets[]` 未声明 → `IMP-W002`（原样保留，不静默删除）。 */
export function findUndeclaredAssetRefs(body: string, declaredNames: string[]): string[] {
  const found = new Set<string>();
  const pattern = /(?:\.\/)?assets\/([^\s)"'<>\]]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (!declaredNames.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

/**
 * `overwrite` 的反面：第一段之前的内容必须原样保留。测试与撤销都用它做前后像比对。
 */
export function isAppendOf(existing: string, next: string): boolean {
  return next.startsWith(existing.replace(/\r\n?/g, "\n").trimEnd());
}
