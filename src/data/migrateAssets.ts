/**
 * 旧附件布局迁移器（调研报告 `docs/asset-lifecycle-and-migration.md` §3.1 的 A→B→C→D 四步）。
 *
 * 目标：把**全部**旧附件目录（工作区里的 `<笔记名>.assets/`、公共 `assets/`，以及
 * `.opennote/trash/` 下的同类目录）里的文件整理进工作区根的共享 `.assets/`，
 * 文件名换成内容派生的 uuid，并把正文里指向它们的引用**同步改写**（含回收站笔记）。
 *
 * 为什么值得一个独立模块：`rebaseSharedAssetRefs` 按设计只认 `.assets/`，对旧布局一格不改
 * （报告 §3.2 已证实），而旧布局的写法比现有改写器的射程多得多（角括号、无 `./` 前缀、
 * `<img src>`、带笔记子目录的公共 `assets/`…）。
 *
 * 三条不可动摇的性质：
 * 1. **默认只读**：{@link buildAssetMigrationPlan} 只调 `list`/`readBytes`/`readText`/`exists`/`stat`，
 *    一个字节都不写；只有 {@link applyAssetMigration} 会写，而它只被 `--apply` 调用。
 * 2. **去重按字节**（sha256 分组 + 逐字节复核），不是按文件名。真实反例：
 *    `image.png` 与 `image 2.png` 同名不同内容，必须判成两个文件、绝不互相覆盖。
 * 3. **先复制、后改写、最后删源**：任何中间状态下源文件都还在，最坏结果是「多一份冗余」
 *    而不是「丢图」。删源只删「复制过且逐字节校验通过」的那些；目录只在真的空了才收。
 *
 * 明确不碰的东西：`.opennote/history/**`（历史快照是只读历史，一个字节都不动）、
 * 工作区根的空 `assets/`（`ensureWorkspaceScaffold` 每次开工作区都会重建它）、
 * 共享 `.assets/` 本身（新布局的家，只往里加）。
 */

import { HISTORY_DIR, baseName, isMarkdownPath, joinPath, parentPath, sameBytes } from "../fs/paths";
import type { FileSystemBackend } from "../fs/types";
import { resolveWorkspacePath } from "../fs/workspaceRef";
import { assetFinalName, dedupeAssetName, relativeAssetRef, SHARED_ASSETS_DIR } from "./assetPaths";

/* ------------------------------------------------------------------ 类型 */

/** 一个待迁移的源文件（旧布局里的一个附件）。 */
export interface AssetMigrationFile {
  /** 工作区相对源路径（旧布局）。 */
  source: string;
  /** 工作区相对最终路径（共享 `.assets/<内容 uuid>.<ext>`，冲突时带 `-2`）。 */
  target: string;
  /** 源字节的 sha256（十六进制）。同哈希 = 同一份内容。 */
  hash: string;
  /** 字节数（复制校验的第二个判据）。 */
  size: number;
  /** `true` = 目标已存在且字节相同，**不需要复制**（复用，不重写、不改 mtime）。 */
  reused: boolean;
}

/** 一个内容组：同内容的若干个源文件 → 同一个最终路径（省下的文件数 = 组内个数 - 1）。 */
export interface AssetMigrationGroup {
  hash: string;
  /** 组内源路径（字典序，顺序是确定性的：决定最终名与让位次序）。 */
  sources: string[];
  target: string;
  /** `true` = 最终名让过位（`-2`…），即「同名不同内容」真实发生过。 */
  deduped: boolean;
}

/** 一条被改写的引用（报告与逐条反解校验用）。 */
export interface AssetReferenceRewrite {
  note: string;
  /** 原文里的引用目标。 */
  before: string;
  /** 改写后的目标（含角括号/标题串时是完整形态）。 */
  after: string;
  /** 它指向的最终路径。 */
  target: string;
}

/** 解析不到文件的引用、或连工作区路径都算不出来的引用（**原样保留** + 报告，绝不猜）。 */
export interface AssetReferenceIssue {
  note: string;
  ref: string;
  kind: "dead" | "unresolvable";
  reason: string;
}

export interface AssetMigrationNoteReport {
  note: string;
  rewritten: number;
  issues: number;
}

export interface AssetMigrationReport {
  /** 被扫描的旧附件目录（工作区 + 回收站）。 */
  scannedDirs: string[];
  /** 旧布局附件文件总数（**待迁移文件数**）。 */
  totalFiles: number;
  /** 按字节去重后省下的文件数（每个内容组 = 个数 - 1 累加）。 */
  dedupedSavings: number;
  /** 内容组数（含只有一份内容的组）。 */
  contentGroups: number;
  /** 重复内容组数（组内 > 1 个文件）。 */
  duplicateGroups: number;
  /** 最终路径需要让位（`-2`）的文件数：同名不同内容的真实发生次数。 */
  dedupedTargets: number;
  /** 真正需要**新写**的最终文件数（按内容组算：同内容的多个源共用一次写入）。 */
  copiesNeeded: number;
  /** 目标已存在且字节相同 → 复用（不写、不改 mtime）的最终文件数。 */
  reusedExisting: number;
  /** 正文里指向旧布局、需要改写的引用条数。 */
  referencesToRewrite: number;
  /** 涉及的笔记篇数。 */
  notesWithRewrites: number;
  /** 解析不到文件的引用（死引用）。 */
  deadReferences: number;
  /**
   * 死引用里**指向附件**的那些（路径含 `assets/`/`.assets/`，或本身就是图片扩展名）。
   *
   * 与 `deadReferences` 分开报，是因为另外那一类是**笔记之间的链接**（`[x](./gomock.md)`）
   * 指向一篇不存在的笔记 —— 那是另一类既成缺陷，迁移器同样一字不动，但用户看到
   * 「54 条死引用」时应该能分清里面有几条与图有关。
   */
  deadAssetReferences: number;
  /** 连工作区路径都算不出来的本地引用（Windows/macOS 绝对路径等）。 */
  unresolvableReferences: number;
  /** 没有任何存活笔记引用的旧布局附件文件数。 */
  unreferencedFiles: number;
  /** 共享 `.assets/` 里已存在、且没有任何笔记引用的文件数（不计入迁移）。 */
  unreferencedSharedFiles: number;
  /** 有笔记引用的旧布局源文件（`unreferencedFiles` 的补集，供报告列出无引用文件）。 */
  referencedSources: string[];
  /** 有笔记引用的共享 `.assets/` 文件。 */
  referencedSharedFiles: string[];
  /** 同名不同内容的真实反例（`image.png` / `image 2.png` 那种），供报告直接引用。 */
  sameNameDifferentBytes: Array<{ name: string; sources: string[] }>;
  /** 逐文件映射（阶段 B/C/D 的唯一依据）。 */
  files: AssetMigrationFile[];
  /** 内容组明细。 */
  groups: AssetMigrationGroup[];
  /** 逐篇笔记的改写计划（`before` 是阶段 A 读到的正文，用于并发改动比对）。 */
  notePlans: Array<{ note: string; before: string; after: string; rewrites: AssetReferenceRewrite[] }>;
  references: AssetReferenceRewrite[];
  issues: AssetReferenceIssue[];
  notes: AssetMigrationNoteReport[];
  /** 扫描时读不出来的文件（不猜、不静默）。 */
  unreadable: string[];
}

export interface AssetMigrationOptions {
  /** 迁移落点目录，默认共享 `.assets/`。 */
  sharedDir?: string;
  /** 报告里 `issues` / `references` 明细的条数上限，默认 200。 */
  limit?: number;
}

export interface AssetMigrationResult {
  copied: number;
  reused: number;
  rewrittenNotes: number;
  rewrittenReferences: number;
  deletedSources: number;
  removedDirs: string[];
  keptDirs: string[];
  /** 改写后逐条反解校验失败的笔记（整篇回滚，一篇坏不影响别人）。 */
  failedNotes: string[];
  /** 源文件在阶段 B/C 已经不在 / 内容变了（外部改动）→ 跳过。 */
  vanishedSources: string[];
  /** 改写前正文与阶段 A 读到的不一致（并发编辑）→ 跳过该篇。 */
  conflictedNotes: string[];
  /** 阶段 B 校验失败的文件 → 不进入阶段 C/D。 */
  failedCopies: string[];
}

/* ------------------------------------------------------------------ 路径识别 */

/** 目录名是不是「旧附件目录」或共享附件目录（与 `library.ts` 的识别规则同一份名单）。 */
export function isAssetsDirName(name: string): boolean {
  return name === "assets" || name.endsWith(".assets");
}

/** 共享 `.assets/` 之外、名字像附件目录的，就是**旧布局**。 */
export function isLegacyAssetsDir(path: string, sharedDir = SHARED_ASSETS_DIR): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  if (normalized === sharedDir) return false;
  return isAssetsDirName(baseName(normalized));
}

/** 历史快照一律不碰（报告 §3.5：改它 = 篡改历史版本）。 */
export function isHistoryPath(path: string): boolean {
  return path === HISTORY_DIR || path.startsWith(`${HISTORY_DIR}/`);
}

/**
 * 迁移器要跳过的路径：历史快照 + 一切隐藏段。
 *
 * 注意 `.opennote/trash/…` **必须**被扫到（用户要求一并整理），所以「隐藏段」这条
 * 只对 `.opennote` 之下的**更深**隐藏段生效（`.opennote/.cache/…` 之类）。
 */
function isOutOfScope(path: string): boolean {
  if (isHistoryPath(path)) return true;
  const segments = path.split("/");
  return segments.some((segment, index) => segment.startsWith(".") && index > 0);
}

/* ------------------------------------------------------------------ 扫描（阶段 A） */

async function listEntries(backend: FileSystemBackend, path: string): Promise<Array<{ name: string; kind: string }>> {
  try {
    const entries = await backend.list(path);
    return entries.map((entry) => ({ name: entry.name, kind: entry.kind }));
  } catch {
    return [];
  }
}

/** 递归找出所有**旧布局**附件目录（不含共享 `.assets/`，不含 `.opennote/history/`）。 */
export async function findLegacyAssetDirs(
  backend: FileSystemBackend,
  options: AssetMigrationOptions = {},
): Promise<string[]> {
  const sharedDir = options.sharedDir ?? SHARED_ASSETS_DIR;
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await listEntries(backend, dir)) {
      const path = joinPath(dir, entry.name);
      if (entry.kind !== "directory") continue;
      if (isOutOfScope(path)) continue;
      if (path === sharedDir) continue;
      if (isAssetsDirName(entry.name)) {
        found.push(path);
        continue;
      }
      await walk(path);
    }
  };
  await walk("");
  return found.sort();
}

/** 工作区里所有 markdown 文件（含 `.opennote/trash/`，**不含** `.opennote/history/`）。 */
export async function listNotePaths(backend: FileSystemBackend): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await listEntries(backend, dir)) {
      const path = joinPath(dir, entry.name);
      if (entry.kind === "directory") {
        if (isOutOfScope(path)) continue;
        if (path === SHARED_ASSETS_DIR) continue;
        if (isAssetsDirName(entry.name)) continue;
        await walk(path);
        continue;
      }
      if (isMarkdownPath(path)) found.push(path);
    }
  };
  await walk("");
  return found.sort();
}

async function filesIn(backend: FileSystemBackend, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listEntries(backend, dir)) {
    const path = joinPath(dir, entry.name);
    if (entry.kind === "directory") {
      // 旧附件目录里**还有子目录**（真实数据：`assets/操作系统概念/image.png`、
      // `assets/进程相关/x.png`… 引用文本里就带着那一层），所以整棵子树都算附件。
      if (isOutOfScope(path)) continue;
      out.push(...(await filesIn(backend, path)));
      continue;
    }
    out.push(path);
  }
  return out.sort();
}

/* ------------------------------------------------------------------ 引用解析 */

/** 正文里的一条本地引用。 */
export interface LocalReference {
  /** 引用目标（角括号已剥掉）。 */
  ref: string;
  start: number;
  end: number;
  kind: "markdown" | "html";
  /** 目标是不是写成 CommonMark 角括号形式 `<…>`。 */
  bracketed: boolean;
  /** 目标后面的标题串（`"…"`），改写时原样保留。 */
  title: string;
}

/**
 * 抽出正文里的本地引用（远程 / `data:` / `blob:` / `asset://` / 锚点一律不算本地文件）。
 *
 * 覆盖报告 §3.2 表里迁移必须吃下的全部写法：
 * `](./foo.assets/a.png)`、`](<./foo 2.assets/b.png>)`（角括号）、`](foo.assets/a.png)`（无 `./`）、
 * `](assets/a.png)` / `](assets/操作系统概念/image.png)`（带笔记子目录）、
 * `<img src="./foo.assets/a.png">`、`](<QwenLM ….assets/63e80eb9-…>)`。
 */
export function extractLocalReferences(content: string): LocalReference[] {
  const text = String(content ?? "");
  const out: LocalReference[] = [];
  const push = (raw: string | undefined, start: number, end: number, kind: "markdown" | "html", title = ""): void => {
    const value = String(raw ?? "").trim();
    if (!value) return;
    if (/^(https?:|data:|blob:|asset:|mailto:|tel:|#)/i.test(value)) return;
    const bracketed = value.startsWith("<") && value.endsWith(">");
    const ref = bracketed ? value.slice(1, -1) : value;
    if (!ref) return;
    out.push({ ref, start, end, kind, bracketed, title });
  };
  // Markdown 图片与链接：目标可以是 `<…>`（允许空格）或裸写法（到空白/`)` 为止），后面可跟标题串。
  const markdown = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(text))) {
    const raw = match[1];
    const open = match[0].indexOf(raw);
    push(raw, match.index + open, match.index + open + raw.length, "markdown", match[2] ?? "");
  }
  // 内联 HTML：`<img src="…">`（其余属性一字不动）。
  const html = /<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']*)\1/gi;
  while ((match = html.exec(text))) {
    const raw = match[2];
    const open = match[0].lastIndexOf(raw);
    push(raw, match.index + open, match.index + open + raw.length, "html");
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 引用 → 工作区路径（与 `resolveWorkspacePath` 同一语义；解析不出来时返回 `null`）。 */
export function workspacePathOfRef(ref: string, notePath: string): string | null {
  return resolveWorkspacePath(ref, parentPath(notePath));
}

/** 用 `markdownRef` 的同一判据决定要不要角括号：新路径本身需要，或原文本来就是角括号形式。 */
export function renderAssetRef(path: string, bracketed: boolean): string {
  return /[\s()<>]/.test(path) || bracketed ? `<${path}>` : path;
}

/**
 * 按映射改写一篇正文里的引用。表里查不到的**原样保留**（死引用本来就死，绝不猜）。
 *
 * 前缀一律用 `relativeAssetRef(notePath, finalPath)` 现算（回收站笔记比工作区深两层，
 * 手拼 `../` 迟早少一层）。
 *
 * `fileExists` 只服务**死引用计数**（C1 回修）：解析得到工作区路径、但不在迁移清单里的引用，
 * 必须先问一嘴磁盘——文件真的不在（断链、指向别机的绝对路径）才算死引用；指向**存在文件**的
 * 引用（共享 `.assets/` 的新布局引用、真实存在的笔记/图片链接）只是「与迁移无关」，
 * 一字不动、也不计死。引用文本的去留完全不因这个判定而改变——它只影响报告。
 */
export async function rewriteAssetRefsIn(
  content: string,
  notePath: string,
  targetOfSource: Map<string, string>,
  fileExists: (path: string) => Promise<boolean>,
): Promise<{ after: string; rewrites: AssetReferenceRewrite[]; issues: AssetReferenceIssue[] }> {
  const text = String(content ?? "");
  const rewrites: AssetReferenceRewrite[] = [];
  const issues: AssetReferenceIssue[] = [];
  let after = "";
  let cursor = 0;
  for (const reference of extractLocalReferences(text)) {
    const resolved = workspacePathOfRef(reference.ref, notePath);
    const finalPath = resolved ? targetOfSource.get(resolved) : undefined;
    after += text.slice(cursor, reference.start);
    if (finalPath) {
      const next = `${renderAssetRef(relativeAssetRef(notePath, finalPath), reference.bracketed)}${reference.title}`;
      after += next;
      rewrites.push({ note: notePath, before: reference.ref, after: next, target: finalPath });
    } else {
      after += text.slice(reference.start, reference.end);
      if (!resolved) {
        issues.push({ note: notePath, ref: reference.ref, kind: "unresolvable", reason: "算不出工作区路径" });
      } else if (!targetOfSource.has(resolved)) {
        // 解析到了某个工作区路径，但它不是迁移清单里的旧附件：可能是新布局（共享 `.assets/`，
        // 不该动），也可能是**真的什么都没有**。只有后者才是死引用 —— 先问磁盘再计数（C1 回修）。
        // 后端拒答（assertSafeRelative 对 `E:\…` 这类永不可能落在工作区里的路径当场抛错）
        // 等价于「那里不可能有文件」：这类引用照旧计死，扫描也不能被它炸掉。
        const alive = await fileExists(resolved).catch(() => false);
        if (!alive) {
          issues.push({
            note: notePath,
            ref: reference.ref,
            kind: "dead",
            reason: `解析到 ${resolved}，但那里没有文件`,
          });
        }
      }
    }
    cursor = reference.end;
  }
  after += text.slice(cursor);
  return { after, rewrites, issues };
}

/* ------------------------------------------------------------------ 建映射（阶段 A） */

/**
 * 阶段 A：扫描 → 建映射 → 出报告。**只读**。
 *
 * 映射的确定性（幂等的前提）：
 * - 内容组按 `sha256(bytes)` 分组，组内源路径按字典序；
 * - 最终名 = `assetFinalName(bytes, 组内第一个源文件名)`（复用现有唯一产地，不另抄公式）；
 * - 目标已存在 + 字节相同 → 复用；已存在 + 字节不同（或本轮已分配给别的组）→ `-2`、`-3`… 让位。
 *   让位顺序只取决于字典序，所以第二次运行得到**完全相同**的最终名。
 */
export async function buildAssetMigrationPlan(
  backend: FileSystemBackend,
  options: AssetMigrationOptions = {},
): Promise<AssetMigrationReport> {
  const sharedDir = options.sharedDir ?? SHARED_ASSETS_DIR;
  const limit = options.limit ?? 200;
  const scannedDirs = await findLegacyAssetDirs(backend, options);

  // --- 收集源文件（读字节 + 算哈希；阶段 D 会删源，所以一切都得先在内存里定下来）---
  const unreadable: string[] = [];
  const sources: Array<{ path: string; bytes: Uint8Array; hash: string }> = [];
  for (const dir of scannedDirs) {
    for (const path of await filesIn(backend, dir)) {
      try {
        const bytes = await backend.readBytes(path);
        sources.push({ path, bytes, hash: await sha256Hex(bytes) });
      } catch {
        unreadable.push(path);
      }
    }
  }

  // --- 按内容分组（**不是**按文件名）---
  const byHash = new Map<string, string[]>();
  for (const source of sources) {
    const list = byHash.get(source.hash) ?? [];
    list.push(source.path);
    byHash.set(source.hash, list);
  }
  const bytesOf = new Map(sources.map((source) => [source.path, source.bytes]));

  // --- 共享目录里已有什么（决定「复用」还是「让位」）---
  const sharedBytes = new Map<string, Uint8Array>();
  for (const path of await filesIn(backend, sharedDir)) {
    try {
      sharedBytes.set(path, await backend.readBytes(path));
    } catch {
      /* 读不出来就当作「不可复用」，走让位分支 */
    }
  }

  const files: AssetMigrationFile[] = [];
  const groups: AssetMigrationGroup[] = [];
  const claimed = new Set<string>();
  let dedupedSavings = 0;
  let duplicateGroups = 0;
  let dedupedTargets = 0;
  let copiesNeeded = 0;
  let reusedExisting = 0;

  for (const hash of [...byHash.keys()].sort()) {
    const paths = (byHash.get(hash) ?? []).slice().sort();
    const bytes = bytesOf.get(paths[0]);
    if (!bytes) continue;
    const baseName = await assetFinalName(bytes, paths[0]);
    const candidate = joinPath(sharedDir, baseName);
    const target = resolveTarget(candidate, bytes, claimed, sharedBytes);
    const deduped = target !== candidate;
    const reused = sharedBytes.has(target) && sameBytes(sharedBytes.get(target) as Uint8Array, bytes);
    if (deduped) dedupedTargets += 1;
    // 按**最终文件**计数，不是按源文件：同内容的多个源共用一次写入（那正是去重的意义）。
    if (reused) reusedExisting += 1;
    else copiesNeeded += 1;
    if (paths.length > 1) {
      duplicateGroups += 1;
      dedupedSavings += paths.length - 1;
    }
    for (const path of paths) files.push({ source: path, target, hash, size: bytes.byteLength, reused });
    groups.push({ hash, sources: paths, target, deduped });
  }

  // --- 引用侧：逐篇笔记解析 → 查表 ---
  const targetOfSource = new Map(files.map((file) => [file.source, file.target]));
  const notePaths = await listNotePaths(backend);
  const notePlans: AssetMigrationReport["notePlans"] = [];
  const references: AssetReferenceRewrite[] = [];
  const issues: AssetReferenceIssue[] = [];
  const referenced = new Set<string>();
  const sharedReferenced = new Set<string>();
  const perNoteIssues = new Map<string, number>();

  for (const notePath of notePaths) {
    let content: string;
    try {
      content = await backend.readText(notePath);
    } catch {
      unreadable.push(notePath);
      continue;
    }
    for (const reference of extractLocalReferences(content)) {
      const resolved = workspacePathOfRef(reference.ref, notePath);
      if (!resolved) continue;
      if (targetOfSource.has(resolved)) referenced.add(resolved);
      if (sharedBytes.has(resolved)) sharedReferenced.add(resolved);
    }
    const result = await rewriteAssetRefsIn(content, notePath, targetOfSource, (path) => backend.exists(path));
    if (result.rewrites.length) {
      notePlans.push({ note: notePath, before: content, after: result.after, rewrites: result.rewrites });
      references.push(...result.rewrites);
    }
    if (result.issues.length) perNoteIssues.set(notePath, result.issues.length);
    issues.push(...result.issues);
  }

  const dead = issues.filter((issue) => issue.kind === "dead");
  return {
    scannedDirs,
    totalFiles: files.length,
    dedupedSavings,
    contentGroups: groups.length,
    duplicateGroups,
    dedupedTargets,
    copiesNeeded,
    reusedExisting,
    referencesToRewrite: references.length,
    notesWithRewrites: notePlans.length,
    deadReferences: dead.length,
    deadAssetReferences: dead.filter((issue) => isAssetLikeRef(issue.ref)).length,
    unresolvableReferences: issues.filter((issue) => issue.kind === "unresolvable").length,
    unreferencedFiles: files.filter((file) => !referenced.has(file.source)).length,
    unreferencedSharedFiles: [...sharedBytes.keys()].filter((path) => !sharedReferenced.has(path)).length,
    referencedSources: [...referenced].sort(),
    referencedSharedFiles: [...sharedReferenced].sort(),
    sameNameDifferentBytes: findSameNameDifferentBytes(files),
    files: files.slice().sort((a, b) => (a.source < b.source ? -1 : 1)),
    groups,
    notePlans,
    references: references.slice(0, limit),
    issues: issues.slice(0, limit),
    notes: notePlans.map((plan) => ({
      note: plan.note,
      rewritten: plan.rewrites.length,
      issues: perNoteIssues.get(plan.note) ?? 0,
    })),
    unreadable,
  };
}

/**
 * 最终名：能用 `candidate` 就用，否则 `-2`、`-3`… 让位。
 *
 * 三种情形（与 `allocateAssetPath` 同一套语义）：
 * 1. `candidate` 不在磁盘上、也没被本轮占走 → 用它；
 * 2. `candidate` 存在 + **字节相同** → 复用它（不复制、不覆盖）；
 * 3. `candidate` 存在 + 字节不同，或已被别的组占走 → 按 `-2`… 让位（**绝不覆盖**）。
 */
export function resolveTarget(
  candidate: string,
  bytes: Uint8Array,
  claimed: Set<string>,
  existing: Map<string, Uint8Array>,
): string {
  if (!claimed.has(candidate)) {
    const onDisk = existing.get(candidate);
    if (onDisk === undefined || sameBytes(onDisk, bytes)) {
      claimed.add(candidate);
      return candidate;
    }
  }
  for (let index = 2; index <= 52; index += 1) {
    const next = dedupeAssetName(candidate, index);
    if (claimed.has(next)) continue;
    const onDisk = existing.get(next);
    if (onDisk !== undefined && !sameBytes(onDisk, bytes)) continue;
    claimed.add(next);
    return next;
  }
  throw new Error(`共享附件目录里同名文件太多，放弃去重：${candidate}`);
}

/** 「这条引用是在指附件，还是在指另一篇笔记」——只用来把死引用分成两类报出来。 */
export function isAssetLikeRef(ref: string): boolean {
  const value = String(ref ?? "");
  if (isMarkdownPath(value)) return false;
  // 旧布局的目录名可能是 `<笔记名>.assets/`（`assets` 前面是点而不是斜杠），也可能是
  // 公共 `assets/`；再兜一层「本来就是图片扩展名」。
  return /(^|\/)[^/]*\.?assets\//.test(value) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(value);
}

/** 「同名不同内容」的真实反例（迁移器不能按文件名去重的直接证据）。 */
export function findSameNameDifferentBytes(files: AssetMigrationFile[]): Array<{ name: string; sources: string[] }> {
  const byName = new Map<string, Set<string>>();
  for (const file of files) {
    const name = baseName(file.source);
    const hashes = byName.get(name) ?? new Set<string>();
    hashes.add(file.hash);
    byName.set(name, hashes);
  }
  const out: Array<{ name: string; sources: string[] }> = [];
  for (const [name, hashes] of byName) {
    if (hashes.size < 2) continue;
    out.push({ name, sources: files.filter((file) => baseName(file.source) === name).map((file) => file.source) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/* ------------------------------------------------------------------ 执行（阶段 B→D） */

export interface ApplyAssetMigrationOptions extends AssetMigrationOptions {
  /** 真的写盘。默认 `false`：**不带 `--apply` 时绝不写任何文件**。 */
  apply?: boolean;
}

/**
 * 执行阶段 B→C→D。`apply` 为假时**只做校验、不写一个字节**。
 *
 * 顺序就是安全设计：B 复制 + 逐字节校验 → C 改写 + 逐条反解校验 → D 删源 + 收空目录。
 * 任何一步失败都不会让「图已经不在原位、引用还没改」这种最坏中间态出现：
 * 源文件直到阶段 D 才可能被删，而且只删「复制过且校验通过」的那些。
 */
export async function applyAssetMigration(
  backend: FileSystemBackend,
  plan: AssetMigrationReport,
  options: ApplyAssetMigrationOptions = {},
): Promise<AssetMigrationResult> {
  const apply = options.apply === true;
  const result: AssetMigrationResult = {
    copied: 0,
    reused: 0,
    rewrittenNotes: 0,
    rewrittenReferences: 0,
    deletedSources: 0,
    removedDirs: [],
    keptDirs: [],
    failedNotes: [],
    vanishedSources: [],
    conflictedNotes: [],
    failedCopies: [],
  };

  /* ---- 阶段 B：复制 + 逐字节校验（源一个字节都不删） ---- */
  const verified = new Set<string>();
  for (const file of plan.files) {
    let bytes: Uint8Array;
    try {
      bytes = await backend.readBytes(file.source);
    } catch {
      // 源在扫描之后不在了：可能是上一次跑已经删过它（幂等），也可能被外部动了。
      result.vanishedSources.push(file.source);
      continue;
    }
    if ((await sha256Hex(bytes)) !== file.hash) {
      result.vanishedSources.push(file.source);
      continue;
    }
    const existing = await backend.readBytes(file.target).catch(() => null);
    if (existing && sameBytes(existing, bytes)) {
      // 已存在且字节相同 → 复用（不重写、不改 mtime）。
      result.reused += 1;
      verified.add(file.source);
      continue;
    }
    if (existing) {
      // 目标存在但内容不是我们的 → 扫描阶段的映射已经让过位，这里出现就说明外部改了目标。
      result.failedCopies.push(file.source);
      continue;
    }
    // `copied` 只数**真的写下去的**：dry-run 里它保持 0（计划复制数在报告的 `copiesNeeded` 里）。
    if (apply) {
      await backend.writeBytes(file.target, bytes);
      result.copied += 1;
    }
    verified.add(file.source);
  }
  if (apply) {
    // 校验：重新读每一个最终路径，大小 + 逐字节都必须对上。
    for (const file of plan.files) {
      if (!verified.has(file.source)) continue;
      const copied = await backend.readBytes(file.target).catch(() => null);
      if (!copied || copied.byteLength !== file.size) {
        result.failedCopies.push(file.source);
        continue;
      }
      const source = await backend.readBytes(file.source).catch(() => null);
      if (source && !sameBytes(copied, source)) result.failedCopies.push(file.source);
    }
  }
  if (result.failedCopies.length) return result;

  /* ---- 阶段 C：改写引用（仍不删源） ---- */
  const targetOfSource = new Map(plan.files.map((file) => [file.source, file.target]));
  for (const notePlan of plan.notePlans) {
    const current = await backend.readText(notePlan.note).catch(() => null);
    if (current === null) {
      result.vanishedSources.push(notePlan.note);
      continue;
    }
    if (current !== notePlan.before) {
      // 并发编辑（用户正在打字 / git 检出）：跳过这篇并报告，绝不覆盖别人的新内容。
      result.conflictedNotes.push(notePlan.note);
      continue;
    }
    const { after, rewrites } = await rewriteAssetRefsIn(current, notePlan.note, targetOfSource, (path) =>
      backend.exists(path),
    );
    if (!rewrites.length) continue;
    // 逐条反解校验：改写后的每一条引用都要 `resolveWorkspacePath` 指回清单里的最终路径。
    const bad = rewrites.some((rewrite) => workspacePathOfRef(rewrite.after, notePlan.note) !== rewrite.target);
    if (bad) {
      result.failedNotes.push(notePlan.note);
      continue;
    }
    if (apply) await backend.writeText(notePlan.note, after);
    result.rewrittenNotes += 1;
    result.rewrittenReferences += rewrites.length;
  }
  if (result.failedNotes.length) return result;

  /* ---- 阶段 D：删源 + 收空目录（只有 A~C 全部通过才走到这里） ---- */
  if (!apply) return result;
  for (const file of plan.files) {
    if (!verified.has(file.source)) continue;
    if (!(await backend.exists(file.source))) continue;
    await backend.remove(file.source).catch(() => undefined);
    result.deletedSources += 1;
  }
  for (const dir of await emptyDirsUnder(backend, plan.scannedDirs)) {
    if (await removeIfEmpty(backend, dir)) result.removedDirs.push(dir);
    else result.keptDirs.push(dir);
  }
  return result;
}

/**
 * 扫描过的旧附件目录**连同它们里面的空子目录**（深的在前，方便从底往上收）。
 *
 * 为什么连子目录一起：真实数据里 `assets/进程相关/` 这种子目录只装附件，文件搬走后它就空了；
 * 只删顶层 `assets/` 会留下一堆空壳（而且顶层非空时连顶层都删不掉）。递归只在**已经确认
 * 全空**的目录上做，`remove()` 永远不带 `recursive`。
 */
async function emptyDirsUnder(backend: FileSystemBackend, roots: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await listEntries(backend, dir)) {
      if (entry.kind !== "directory") continue;
      const child = joinPath(dir, entry.name);
      if (isOutOfScope(child)) continue;
      await walk(child);
      found.push(child);
    }
  };
  for (const root of roots) {
    await walk(root);
    found.push(root);
  }
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/**
 * 只删**空目录**：先 `list()` 确认真空，再 `remove()`（**不带** `recursive`）。
 *
 * 四道护栏，针对的是「误删别的笔记的图」那次历史事故（报告 R1）：
 * 1. 绝不 `recursive: true` —— 有文件残留（死引用指向的、无归属的）就整个目录留下 + 报告；
 * 2. `.opennote/` **元数据目录本身**与 `.assets/` 一律不删（前者是应用自己的状态/历史/回收站根，
 *    后者是新布局的家）；
 * 3. 工作区根的空 `assets/` 也留下（`ensureWorkspaceScaffold` 每次开工作区都会重建它）；
 * 4. 只有**真的空了**才删 —— 判据是 `list()` 返回空，不是「我们以为它空了」。
 *
 * 注意第 2 条**不**排除 `.opennote/trash/` 里的空附件目录：用户明确要求把回收站里的孤儿
 * `.assets/` 一并整理掉，而删一个**确认为空**的附件目录不会碰到任何文件。
 *
 * 后端那一层还有第二道同类护栏（D1 回修）：`remove(dir)` 不带 `recursive` 时，node 后端
 * 走的是 `rmdir`（空目录删得掉、非空抛 `ENOTEMPTY`），不是 `fs.rm(dir,{recursive:false})`
 * —— 后者在 Node 22 / win32 上对目录**一律**抛 `ERR_FS_EISDIR`，会被这里的
 * `.catch(() => undefined)` 吞掉，变成「报告说收了、目录还在」。两道护栏都不许删掉。
 */
export async function removeIfEmpty(backend: FileSystemBackend, dir: string): Promise<boolean> {
  if (!dir || dir === SHARED_ASSETS_DIR) return false;
  if (dir === ".opennote") return false;
  if (dir === "assets") return false;
  // 唯一判据：`list()` 真的返回空。**不**因为后端改成了 rmdir 就把它删掉 ——
  // 后端那层只兜「非空目录不许删」，这层负责「本来就不该删的目录（.assets/.opennote/根 assets）连试都不试」。
  const entries = await listEntries(backend, dir);
  if (entries.length) return false;
  await backend.remove(dir).catch(() => undefined);
  return !(await backend.exists(dir));
}

/* ------------------------------------------------------------------ 小工具 */

/** 十六进制 sha256（走 Web Crypto：浏览器与 Node 18+ 都有）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
