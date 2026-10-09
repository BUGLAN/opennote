/**
 * 落点决策与附件落盘（契约 §3.1 / §3.3 / §3.4 / §3.6）。
 *
 * 本模块只做「给定后端与快照 → 得到路径与字节」的确定性运算，不碰全局状态，
 * 方便单测直接喂一个内存后端。
 */

import {
  assertSafeRelative,
  joinPath,
  normalizePath,
  parentPath,
  sameBytes,
  sanitizeName,
} from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
/*
 * 附件落点与引用文本的**纯路径运算**搬到了 `src/data/assetPaths.ts`（唯一产地不变）：
 * 旧附件迁移器（`src/data/migrateAssets.ts`，命令行也要跑）必须用同一套规则，而它不能
 * import 本模块 —— 本模块还 import 着 `../data/library`（React / idb / localStorage）。
 * 这里 re-export，所以 `from "../lib/clip/landing"` 的既有导入路径一个字都不用改。
 */
import {
  assetFinalName,
  assetsDirFor,
  dedupeAssetName,
  markdownRef,
  relativeAssetRef,
  SHARED_ASSETS_DIR,
} from "../../data/assetPaths";
import { resolveAvailablePath } from "../../data/library";
import { ImportRejection, importProblem, normalizeFolder } from "./envelope";

export { assetFinalName, assetsDirFor, markdownRef, relativeAssetRef, SHARED_ASSETS_DIR };

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

/*
 * 附件目录常量与「相对引用 / 角括号引用 / 最终名」的纯运算都在 `../../data/assetPaths.ts`：
 * 剪藏落盘、编辑器粘贴、旧附件迁移器三条路必须用同一套规则，而迁移器（命令行也要跑）
 * 不能 import 本模块（本模块还 import 着 `../data/library`）。上面的 re-export 让既有导入路径不变。
 */

/**
 * {@link relativeAssetRef} 的逆运算：一条引用 + 笔记路径 → 它指向的**工作区路径**。
 *
 * 移动/回收站/恢复要按新位置重算前缀、永久删除要知道该删哪些文件，两处都靠它。
 * 远程/`data:`/`blob:`/旧的 `asset://` 一律返回空串（没有工作区路径可言）。
 */
export function assetPathOfRef(notePath: string, ref: string): string {
  const value = ref.trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
  if (!value || /^(https?:|data:|blob:|asset:)/i.test(value)) return "";
  // 以 `/` 开头的是**工作区绝对**引用（`resolveWorkspacePath` 的既有语义），不接目录前缀。
  const base = value.startsWith("/") ? "" : parentPath(notePath);
  return normalizePath(`${base}/${value}`);
}

/**
 * 正文里引用了**共享附件目录**的那些文件名（`../.assets/x.png` → `x.png`）。
 *
 * 直接扫 `.assets/<名>` 这个片段，不解析整篇 Markdown：Markdown 的 `](…)`、带 `<>` 的写法、
 * 内联 `<img src="…">` 一网打尽，而且**只认共享目录**——旧布局（`<笔记名>.assets/`、
 * 公共 `assets/<笔记名>/`）不会被卷进来，旧数据零迁移。
 */
export function sharedAssetFilesIn(content: string): string[] {
  const found = new Set<string>();
  /*
   * `.assets/` 前面那个字符必须是**路径起点**（`](`、空白、引号、`/`、行首）。
   * 少了这道边界，`测试标题.assets/x.png` 这种**旧布局**引用也会被扫成「共享目录里的 x.png」——
   * 而它在永久删除时会被拿去删 `.assets/x.png`：删到别人的图。
   */
  for (const match of String(content ?? "").matchAll(/(?:^|[(<"'/\s])\.assets\/([^\s)"'<>)\]]+)/g)) found.add(match[1]);
  return [...found];
}

/**
 * 笔记换了路径之后，把正文里指向**共享附件目录**的引用按新位置重算前缀
 * （`a.md` 里的 `.assets/x.png` 搬进 `操作系统/` 后 → `../.assets/x.png`）。
 *
 * 只改「字面指向 `.assets/`」的引用：旧布局引用（`<笔记名>.assets/…`、`assets/<笔记名>/…`）
 * 一格都不碰 —— 那些笔记的图本来就在原处，改了反而指空。
 *
 * 两种落点写法都覆盖：Markdown 的 `](…)` / `](<…>)`，以及内联 `<img src="…">`。
 */
export function rebaseSharedAssetRefs(content: string, toNotePath: string): string {
  const dir = parentPath(toNotePath);
  const prefix = dir ? "../".repeat(dir.split("/").length) : "";
  const relocate = (file: string): string => `${prefix}.assets/${file}`;
  let next = String(content ?? "");
  // Markdown：`](../.assets/x.png)` 与 `](<../../.assets/x.png>)`（可选标题串一起吃掉）。
  next = next.replace(
    /\]\((<)?((?:\.\.\/)*)\.assets\/([^\s)">]+)(>)?(\s+"[^"]*")?\)/g,
    (_match, open: string | undefined, _ups: string, file: string, close: string | undefined, title: string | undefined) =>
      `](${open && close ? `<${relocate(file)}>` : relocate(file)}${title ?? ""})`,
  );
  // HTML：`<img src="../.assets/x.png">`
  next = next.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*["'])(?:\.\.\/)*\.assets\/([^\s"'>]+)(["'])/gi,
    (_match, head: string, file: string, tail: string) => `${head}${relocate(file)}${tail}`,
  );
  return next;
}

/**
 * 附件最终名与去重名都在 `../../data/assetPaths.ts`（{@link assetFinalName} /
 * {@link dedupeAssetName}）：编辑器粘贴（`saveImage`）与旧附件迁移器都要用同一份实现。
 */

export interface AssetTarget {
  path: string;
  /** `true` = 命中了**内容相同**的已存在路径（重试幂等，不重复写、不覆盖）。 */
  reused: boolean;
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
 * 2. 路径存在 + 字节不同 → **可读化去重**（`x-2.png`、`x-3.png`…），**绝不静默覆盖** ✅
 * 3. 落点必须过 `assertSafeRelative()` **且父目录就是附件目录**：资产名不是路径逃逸入口（D-④）✅
 *
 * 「字节相同」的判据是 `sameBytes()`（`src/fs/paths.ts`，唯一产地）：编辑器粘贴路径
 * （`saveImage`）用的是同一个函数，两条路径的复用语义不许漂移。
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
    const next = dedupeAssetName(candidate, index);
    if (taken.has(next) || (await backend.exists(next))) continue;
    taken.add(next);
    return { path: next, reused: false };
  }
  throw new ImportRejection(importProblem("IMP-4010", { requested: candidate }));
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

/*
 * `markdownRef`（`](…)` 里那个字符串的唯一产地）也搬去了 `../../data/assetPaths.ts`：
 * 空格会**截断链接目标**（`![x](./备注 2.assets/a.png)` 在 markdown-it 里不产 `<img>`，
 * 而且不报错），所以附件路径带空格时一律写成 CommonMark 的角括号目标 `<…>`。
 * 编辑器粘贴与剪藏落盘共用这一个函数，免得一处转义、另一处不转义。
 */

export interface AssetRename {
  /** 信封里的原始 `name`（正文引用的就是它）。 */
  name: string;
  /** 实际落盘路径（工作区相对）。 */
  finalPath: string;
}

/**
 * 正文引用改写（契约 §3.4）：把**客户端写法**的两种形态改成**指向共享 `.assets/` 的相对引用**。
 *
 * 两趟、各管一种形态，而不是「三次 `split/join`」：
 * - 后者会把已经改写过的结果再匹配一遍（`foo.assets/x.png` 里含有子串 `assets/x.png`），
 *   在文本里滚出 `foo.foo.assets/x.png`；
 * - 也不能把 `](` 和 `assets/` 写进同一个正则的并列分支：正则按**位置**而不是按分支顺序
 *   取第一个能匹配的，`](./assets/x.png)` 会被 `](` 分支吃掉整个路径，于是永远匹配不上。
 *
 * 表里查不到的名字**原样保留**（未声明的引用不静默删除，配合 `IMP-W002`）。
 * 新引用**从最终落盘路径现取**（`relativeAssetRef(notePath, finalPath)`），
 * 不重复推导笔记名——落盘在哪，正文就指哪，两边不可能漂移。
 * 目标串一律过 {@link markdownRef}（带空格时写成 `<…>`，否则图片不会渲染）。
 *
 * **`assets/` 前面必须有边界**（0.4.0）：应用自己产出的引用长这样 `](.assets/<uuid>.png)`，
 * 若不加边界，改写器会把**自己刚写出来的引用**再当成客户端写法扫一遍。
 * 客户端写法前面永远是 `](`、空白或行首，不会是 `.`/字母/数字。
 */
export function rewriteAssetRefs(body: string, renames: AssetRename[], notePath: string): string {
  if (!renames.length) return body;
  const refs = new Map<string, string>();
  for (const { name, finalPath } of renames) {
    refs.set(name, markdownRef(relativeAssetRef(notePath, finalPath)));
  }
  const lookup = (token: string): string | undefined => refs.get(token);
  // ① 带目录的写法：`./assets/x` 与 `assets/x`（客户端约定的两种变体）。
  const next = body.replace(/(?<![\w.-])(?:\.\/)?assets\/([^\s)"'<>\]]+)/g, (match, token: string) => lookup(token) ?? match);
  // ② 裸名写法：`](x)`（同目录引用，不含 `/` 才算裸名，路径交给 ① 处理）。
  return next.replace(/\]\(([^)\s/]+)\)/g, (match, token: string) => {
    const target = lookup(token);
    return target ? `](${target})` : match;
  });
}

/** 正文里引用了 `assets/xxx` 但 `assets[]` 未声明 → `IMP-W002`（原样保留，不静默删除）。 */
export function findUndeclaredAssetRefs(body: string, declaredNames: string[]): string[] {
  const found = new Set<string>();
  // 与 `rewriteAssetRefs` 同一条边界规则：`.assets/<uuid>` 是**我们自己写出来的**最终引用，
  // 不是「客户端声明过的名字」，不能被当成未声明引用报 IMP-W002。
  const pattern = /(?<![\w.-])(?:\.\/)?assets\/([^\s)"'<>\]]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (!declaredNames.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

/**
 * 正文里的**远程图片地址**（markdown 图片 `![alt](url)` 与内联 `<img src="url">`），
 * 去重、只收 `http(s)`、保持出现顺序。
 *
 * 用途：0.4.0 的「图片一起保存」兜底 —— 扩展侧受 `host_permissions` 限制，跨站图
 * 拿不到字节（正文里就留着原始网址）；设置开着时由主进程代下（见 `receive.ts` 的
 * `setRemoteImageSource`），落盘后再把引用改写成 `assets/<名>`。
 */
export function collectRemoteImageUrls(body: string): string[] {
  const found = new Set<string>();
  const push = (value: string | undefined) => {
    const url = String(value || "").trim().replace(/^<|>$/g, "");
    if (/^https?:\/\//i.test(url)) found.add(url);
  };
  // 单次扫描保**文档顺序**（分两趟会把所有 `<img>` 排到所有 markdown 图后面）。
  // 尖括号写法 `<url>` 里允许空格（URL 带空格时 markdown 必须这么写）；裸写法到空白或 `)` 为止。
  const pattern = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) push(match[1] ?? match[2]);
  return [...found];
}

/**
 * 把远程图片引用改写成**契约 §3.4 的客户端写法** `assets/<名>`。
 *
 * 与扩展侧 `extension/src/lib/assets.js` 的 `rewriteRemoteImageRefs()` 同一件事、
 * 同一套替换形状：先归一到 `assets/<名>`，再由 {@link rewriteAssetRefs} 统一映射到
 * `<笔记名>.assets/<hash8>-<名>` 的最终相对引用 —— 一条改写链，不做第二套「直接替换成
 * 最终路径」的实现（那样就会有两处推导落点名，迟早漂移）。
 *
 * 精确整串替换（`split/join`，不是正则）：URL 里的 `?`、`&`、`%`、`(` 都不是正则安全的。
 */
export function rewriteRemoteImageUrls(body: string, mappings: Array<{ url: string; name: string }>): string {
  let next = String(body || "");
  for (const entry of Array.isArray(mappings) ? mappings : []) {
    const url = entry && typeof entry.url === "string" ? entry.url : "";
    const name = entry && typeof entry.name === "string" ? entry.name : "";
    if (!url || !name) continue;
    next = next.split(`](${url})`).join(`](assets/${name})`);
    next = next.split(`](<${url}>)`).join(`](assets/${name})`);
  }
  return next;
}

/**
 * `overwrite` 的反面：第一段之前的内容必须原样保留。测试与撤销都用它做前后像比对。
 */
export function isAppendOf(existing: string, next: string): boolean {
  return next.startsWith(existing.replace(/\r\n?/g, "\n").trimEnd());
}
