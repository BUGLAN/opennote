/**
 * 落点决策与附件落盘（契约 §3.1 / §3.3 / §3.4 / §3.6）。
 *
 * 本模块只做「给定后端与快照 → 得到路径与字节」的确定性运算，不碰全局状态，
 * 方便单测直接喂一个内存后端。
 */

import {
  assertSafeRelative,
  extName,
  joinPath,
  normalizePath,
  parentPath,
  sanitizeName,
} from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
import { resolveAvailablePath } from "../../data/library";
import { ImportRejection, importProblem, normalizeFolder } from "./envelope";
import { contentUuid } from "./hash";

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
 *
 * 为什么不是公共 `assets/`（老的 `ASSETS_DIR`）：那个常量还被收件箱条目的 `entry/assets/`
 * 用着（`src/data/inbox.ts`），动它会波及无关功能；这里是独立的新目录。
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

/**
 * Markdown 链接/图片目标的**唯一产地**（`](…)` 里那个字符串）。
 *
 * 为什么需要它：附件目录是**按笔记名派生**的，而笔记名可以带空格（`备注 2.md` → `备注 2.assets/`，
 * 而且 `uniquePath` 给每一篇重名笔记加序号也会产生空格）。**空格会截断链接目标**：
 *   - `![x](./备注 2.assets/a.png)` ⇒ markdown-it 不产 `<img>`（原样输出文本）、lezer 不产 URL 子节点
 *     ⇒ 编辑器里图片不显示，而且**不报错**；
 *   - `![x](<./备注 2.assets/a.png>)` ⇒ 两边都正常。
 *
 * CommonMark 的**角度括号目标**是唯一既能表达空格、又被 markdown-it / lezer / Typora / VS Code
 * 共同支持的写法（百分号编码要靠各渲染器愿意解码，不可靠）。
 * 注意：这里说的是**引用文本**的写法；落盘目录名**不改**（00 号 §6.16（51）逐字是 `<笔记名>.assets/`）。
 * 把两个产地（`saveImage` 的 markdown、剪藏的 `rewriteAssetRefs`）都接到这一个函数上，
 * 免得一处转义、另一处不转义。
 */
export function markdownRef(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path;
}

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
