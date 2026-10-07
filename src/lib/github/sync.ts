/**
 * 本地笔记本 ↔ GitHub 仓库的双向同步。
 *
 * **判据只有一个来源**：基线（`.opennote/github.json`）里每个文件的
 * `localHash`（本地改没改）与 `remoteSha`（远端改没改）。
 *
 * ```
 *            本地改了   远端改了     推送时           拉取时
 *   否          否       不动             不动
 *   是          否       提交并推送       不动
 *   否          是       不动             覆盖本地
 *   是          是       ——（先拉取）     冲突，跳过并列出
 * ```
 *
 * 三条硬纪律：
 * 1. **只动我们物化过的文件**（`imported:true`）与**本地新建**的文件；
 *    树里那些源码/配置（`imported:false`）永不触碰 —— 否则一次同步会把仓库里
 *    我们没导入的东西当成「用户删了」而全部删掉。
 * 2. **一次推送一个提交**（blob → tree → commit → ref），且 `force:false`：
 *    远端在我们读完之后前进了，这次推送会被 GitHub 拒绝 —— **绝不静默强推**。
 * 3. `.opennote/` 与隐藏路径**永不推送**（状态文件、历史快照、回收站不是仓库内容；
 *    基线自己也在里面，推上去就等于把同步账本提交进仓库）。
 */

import { isHiddenPath, isImagePath, joinPath, META_DIR } from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
import { sha256Hex } from "../clip/hash";
import { GithubError, type GithubApi, type GithubTree } from "./api";
import type { GithubBaseline } from "./baseline";
import { isMaterializable } from "./importRepo";

/** 推送的候选：一个本地文件的当前状态。 */
export interface LocalFile {
  path: string;
  hash: string;
  bytes: number;
}

export interface PushPlan {
  added: LocalFile[];
  modified: LocalFile[];
  deleted: string[];
}

/**
 * 纯函数：基线 + 本地现状 → 推送计划。
 *
 * `本地现状` 由 {@link collectLocalFiles} 扫出来（跳过 `.opennote/` 与隐藏路径）。
 * 判定「本地改了」用的是**内容哈希**而不是 mtime：Git 克隆、网盘同步、手工拷贝
 * 都可能改 mtime 而不改内容，用 mtime 会让整棵仓库每次都被判成「改过」。
 */
export function planPush(baseline: GithubBaseline, local: LocalFile[]): PushPlan {
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const added: LocalFile[] = [];
  const modified: LocalFile[] = [];
  const deleted: string[] = [];

  for (const file of local) {
    const known = baseline.files[file.path];
    if (!known) {
      added.push(file);
      continue;
    }
    if (known.localHash !== file.hash) modified.push(file);
  }
  for (const [path, known] of Object.entries(baseline.files)) {
    if (!known.imported) continue; // 没物化过的东西绝不当作「用户删了」
    if (localByPath.has(path)) continue;
    deleted.push(path);
  }
  return { added, modified, deleted };
}

export function pushIsEmpty(plan: PushPlan): boolean {
  return plan.added.length === 0 && plan.modified.length === 0 && plan.deleted.length === 0;
}

export interface PullPlan {
  /** 远端新增或远端已改、且本地没动 —— 可以直接覆盖本地。 */
  download: { path: string; sha: string }[];
  /** 远端删了、本地没动 —— 可以删本地。 */
  removeLocal: string[];
  /** 两边都改了（含「本地删了 / 远端改了」）：**不动**，列出来给人看。 */
  conflicts: { path: string; reason: "both-modified" | "deleted-locally-modified-remotely" | "deleted-remotely-modified-locally" }[];
}

/**
 * 纯函数：基线 + 远端树 + 本地现状 → 拉取计划。
 *
 * **只有「该物化的路径」才可能进 `download`**（判据是 `isMaterializable()`，与导入同一份）：
 * 基线里那些故意只记账的源码/配置（`imported:false`）**永远不落地** —— 否则一次拉取就会把
 * 仓库源码写进笔记本，而下一次推送又把它当成新笔记推回去。
 */
export function planPull(baseline: GithubBaseline, remote: GithubTree, local: LocalFile[]): PullPlan {
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const remoteByPath = new Map(remote.entries.map((entry) => [joinPath(entry.path), entry]));
  const download: PullPlan["download"] = [];
  const removeLocal: string[] = [];
  const conflicts: PullPlan["conflicts"] = [];

  for (const [path, entry] of remoteByPath) {
    const known = baseline.files[path];
    const localFile = localByPath.get(path);
    const remoteChanged = !known || known.remoteSha !== entry.sha;
    if (!remoteChanged) continue;

    if (!isMaterializable(path)) continue; // 源码 / 配置：只更新下面那一轮账本，绝不落地
    if (!known || !known.imported) {
      /*
       * 两种情况都直接拉：
       * - 远端新增的笔记或图片：没有本地改动可言；
       * - **上次没物化成功的**（超上限 / 取字节失败）：`localHash` 是 null、本地也确实没有这个文件，
       *   那不是「用户删了它」—— 这里给它一次重试机会（拉下来之后 `localHash` 才成为真值）。
       */
      download.push({ path, sha: entry.sha });
      continue;
    }
    if (!localFile) {
      // 物化过的文件被本地删了，远端又改了它：两边都动了，只能问人
      conflicts.push({ path, reason: "deleted-locally-modified-remotely" });
      continue;
    }
    const localChanged = localFile.hash !== known.localHash;
    if (localChanged) conflicts.push({ path, reason: "both-modified" });
    else download.push({ path, sha: entry.sha });
  }

  for (const [path, known] of Object.entries(baseline.files)) {
    if (!known.imported) continue;
    if (remoteByPath.has(path)) continue;
    const localFile = localByPath.get(path);
    if (!localFile) continue; // 两边都没了
    const localChanged = localFile.hash !== known.localHash;
    if (localChanged) conflicts.push({ path, reason: "deleted-remotely-modified-locally" });
    else removeLocal.push(path);
  }

  return { download, removeLocal, conflicts };
}

/* ------------------------------------------------------------ 本地现状扫描 */

/** 扫出本地全部文件（跳过 `.opennote/`、隐藏路径与几个明显不是笔记的目录）。 */
export async function collectLocalFiles(
  target: FileSystemBackend,
  options: { maxFiles?: number } = {},
): Promise<LocalFile[]> {
  const maxFiles = options.maxFiles ?? 20000;
  const out: LocalFile[] = [];
  const queue: string[] = [""];
  const skipDirs = new Set(["node_modules", "dist", "release", META_DIR]);

  while (queue.length && out.length < maxFiles) {
    const dir = queue.shift() ?? "";
    let entries;
    try {
      entries = await target.list(dir);
    } catch (error) {
      console.warn("[opennote] 同步：读不到目录", dir, error);
      continue;
    }
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      if (isHiddenPath(path) || skipDirs.has(entry.name)) continue;
      if (entry.kind === "directory") {
        queue.push(path);
        continue;
      }
      try {
        const bytes = await target.readBytes(path);
        out.push({ path, hash: await sha256Hex(bytes), bytes: bytes.byteLength });
      } catch (error) {
        console.warn("[opennote] 同步：读不到文件", path, error);
      }
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------- 推送 */

export interface PushInput {
  api: GithubApi;
  backend: FileSystemBackend;
  baseline: GithubBaseline;
  message: string;
}

export interface PushResult {
  commitSha: string;
  treeSha: string;
  headSha: string;
  added: number;
  modified: number;
  deleted: number;
  files: GithubBaseline["files"];
}

/**
 * 一次提交推完所有改动。
 *
 * 顺序是 GitHub 的 Git Data API 要求的那四步；任何一步失败都**不留半个提交**
 * （前一步产物在远端只是悬空对象，引用没动过，仓库看起来完全没变）。
 */
export async function pushChanges(input: PushInput): Promise<PushResult> {
  const { api, backend, baseline, message } = input;
  const local = await collectLocalFiles(backend);
  const plan = planPush(baseline, local);

  // 远端在我们读基线之后前进过 → 不做任何写入（否则会把别人的提交顶掉或被 GitHub 拒绝）
  const head = await api.headSha(baseline.ref);
  if (baseline.headSha && head !== baseline.headSha) {
    throw new GithubError("GH-STALE", "远端有新的提交，推送被拒绝了。请先「从远端拉取」。", 409);
  }

  /*
   * 每个文件的新 `remoteSha` **就是 `createBlob()` 的返回值** —— 它是 GitHub 对「我们刚上传的
   * 这份字节」给出的权威 blob sha，不需要（也不该）事后回读整棵树：回读一旦失败就会**在
   * `updateRef` 之后抛错**（远端引用已经前进、本地基线却没更新，用户看到的话还会误导他再点一次）。
   * 整条链的顺序因此是「先把所有会失败的事做完，最后才动引用」。
   */
  const treeEntries: { path: string; sha: string | null }[] = [];
  const uploaded = new Map<string, string>();
  for (const file of [...plan.added, ...plan.modified]) {
    const bytes = await backend.readBytes(file.path);
    const blobSha = await api.createBlob(bytes);
    uploaded.set(file.path, blobSha);
    treeEntries.push({ path: file.path, sha: blobSha });
  }
  for (const path of plan.deleted) treeEntries.push({ path, sha: null });

  const baseTree = baseline.treeSha || (await api.commitTree(head));
  const treeSha = await api.createTree({ baseTree, entries: treeEntries });
  const commitSha = await api.createCommit({ message, tree: treeSha, parents: [head] });
  await api.updateRef(baseline.ref, commitSha);

  const files: GithubBaseline["files"] = { ...baseline.files };
  for (const path of plan.deleted) delete files[path];
  for (const file of [...plan.added, ...plan.modified]) {
    const remoteSha = uploaded.get(file.path);
    if (!remoteSha) {
      throw new GithubError("GH-BLOB", "推送时漏掉了一个文件的标识，本地基线没有更新。请再点一次「同步到 GitHub」。", null, file.path);
    }
    files[file.path] = { remoteSha, localHash: file.hash, imported: true };
  }
  return {
    commitSha,
    treeSha,
    headSha: commitSha,
    added: plan.added.length,
    modified: plan.modified.length,
    deleted: plan.deleted.length,
    files,
  };
}

/* ------------------------------------------------------------------- 拉取 */

export interface PullInput {
  api: GithubApi;
  backend: FileSystemBackend;
  baseline: GithubBaseline;
}

export interface PullResult {
  downloaded: number;
  removed: number;
  /** 取字节失败的条数（**如实计数**：界面要说得出「有 2 篇没拉下来」）。 */
  failed: number;
  conflicts: PullPlan["conflicts"];
  files: GithubBaseline["files"];
  headSha: string;
  treeSha: string;
}

/** 拉取：远端新增/修改覆盖**没动过**的本地文件；两边都改的一律跳过并列出。 */
export async function pullChanges(input: PullInput): Promise<PullResult> {
  const { api, backend, baseline } = input;
  const head = await api.headSha(baseline.ref);
  const tree = await api.tree(baseline.ref);
  const local = await collectLocalFiles(backend);
  const plan = planPull(baseline, tree, local);

  const files: GithubBaseline["files"] = { ...baseline.files };
  let downloaded = 0;
  let failed = 0;
  for (const item of plan.download) {
    try {
      const data = await api.raw(item.path, baseline.ref);
      if (isImagePath(item.path)) await backend.writeBytes(item.path, data);
      else await backend.writeText(item.path, new TextDecoder().decode(data));
      files[item.path] = { remoteSha: item.sha, localHash: await sha256Hex(data), imported: true };
      downloaded += 1;
    } catch (error) {
      // 不进基线（`imported` 保持原来的值）：下一次拉取会重试它 —— 记一半反而会让基线说谎
      failed += 1;
      console.warn("[opennote] 拉取这个文件失败", item.path, error);
    }
  }
  let removed = 0;
  for (const path of plan.removeLocal) {
    try {
      await backend.remove(path);
      delete files[path];
      removed += 1;
    } catch (error) {
      console.warn("[opennote] 删除这个本地文件失败", path, error);
    }
  }
  // 远端删掉、本地也没动过的（`removeLocal`）与下载完成的都已经处理；
  // 其余的远端条目（我们没物化过的）也要把 remoteSha 更新掉，否则每次拉取都判成「远端改了」
  for (const entry of tree.entries) {
    const path = joinPath(entry.path);
    const known = files[path];
    if (!known || known.imported) continue;
    files[path] = { remoteSha: entry.sha, localHash: null, imported: false };
  }

  return { downloaded, removed, failed, conflicts: plan.conflicts, files, headSha: head, treeSha: tree.sha };
}

export interface ResolveConflictsInput {
  api: GithubApi;
  backend: FileSystemBackend;
  baseline: GithubBaseline;
  paths: string[];
}

/**
 * 「用远端覆盖这些文件」：**只覆盖用户点名的那几条**冲突路径。
 *
 * 与 `pullChanges` 分开写，是因为这是一次**明确会丢本地改动**的操作：
 * 它必须由用户在对话框里点一下才发生，并且只作用于对话框里列出来的那份清单。
 */
export async function resolvePullConflicts(input: ResolveConflictsInput): Promise<{ overwritten: number; files: GithubBaseline["files"] }> {
  const { api, backend, baseline, paths } = input;
  const tree = await api.tree(baseline.ref);
  const remoteByPath = new Map(tree.entries.map((entry) => [joinPath(entry.path), entry.sha]));
  const files: GithubBaseline["files"] = { ...baseline.files };
  let overwritten = 0;
  for (const path of paths) {
    const sha = remoteByPath.get(path);
    if (!sha) continue; // 远端已经没有这一条了：不猜，交给下一次拉取按「远端删除」处理
    try {
      const data = await api.raw(path, baseline.ref);
      if (isImagePath(path)) await backend.writeBytes(path, data);
      else await backend.writeText(path, new TextDecoder().decode(data));
      files[path] = { remoteSha: sha, localHash: await sha256Hex(data), imported: true };
      overwritten += 1;
    } catch (error) {
      console.warn("[opennote] 用远端覆盖这个文件失败", path, error);
    }
  }
  return { overwritten, files };
}
