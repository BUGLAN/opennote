/**
 * 把仓库物化成一个本地笔记本（「从 GitHub 仓库导入」的中间那一步）。
 *
 * 分工：`planImport()` 是纯函数（树 → 要拉哪些、跳过哪些、基线长什么样），
 * `runImport()` 只负责「按计划取字节 → 写盘 → 记哈希」。两个都能在 node 里用假后端跑，
 * 不需要浏览器、不需要网络。
 *
 * **哪些文件会被物化**：笔记（`.md`/`.txt` 一族）与图片。其余（源码、配置、CI…）只进
 * 基线账本、**不落地** —— 它们不参与本地编辑，也不参与推送（`imported:false` 的条目
 * 同步时一律跳过）。这条规则同时解释了「为什么导入一个代码仓库不会把整个仓库抄下来」。
 */

import { isImagePath, isMarkdownPath, joinPath } from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";
import { sha256Hex } from "../clip/hash";
import type { GithubTree } from "./api";
import { GithubError, type GithubApi } from "./api";
import type { GithubBaseline, GithubBaselineFile } from "./baseline";
import { makeBaseline } from "./baseline";

/** 物化的文件数上限。到顶之后**停下并如实说**（不静默丢文件）。 */
export const MAX_IMPORT_FILES = 2000;
/** 物化的总字节上限（浏览器配额不是无限的）。 */
export const MAX_IMPORT_BYTES = 300 * 1024 * 1024;
/** 单个文件上限：GitHub 的 blob API 也就到 100 MB，20 MB 足够放下一本图册里的一张图。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 并发：raw CDN 能吃住 12 路，与本地扫描的 SCAN_CONCURRENCY 保持一致。 */
const IMPORT_CONCURRENCY = 12;

/**
 * 「这个路径该不该被物化」——**唯一产地**。
 *
 * 导入与拉取必须用同一条判据：只认笔记（`.md`/`.txt` 一族）与图片，其余（源码、配置、CI…）
 * 只进基线账本、永不落地。这条判据曾经在 `planPull()` 里漏成「只要远端 sha 变了就下载」，
 * 后果不是多下几个文件，而是**把仓库源码写进笔记本、下一次推送又把它当成笔记推回去**。
 */
export function isMaterializable(path: string): boolean {
  return isMarkdownPath(path) || isImagePath(path);
}

export interface ImportPlan {
  /** 要拉下来并落地的文件（按路径排序，进度可复现）。 */
  materialize: { path: string; sha: string; size: number }[];
  /** 树里的全部文件（含没物化的），写进基线。 */
  files: Record<string, GithubBaselineFile>;
  /** 因为「不是笔记也不是图片」而没物化的条数。 */
  skippedNotNotes: number;
  /** 因为单文件太大而跳过的条数。 */
  skippedTooLarge: number;
  /** 因为数量/总体积到顶而跳过的条数。 */
  skippedOverLimit: number;
  /** GitHub 只返回了树的一部分。 */
  truncated: boolean;
}

export interface PlanImportOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}

/**
 * 纯函数：树 → 导入计划。**任何一条跳过都要能被数出来**（界面按这四个数字如实汇报）。
 */
export function planImport(tree: GithubTree, options: PlanImportOptions = {}): ImportPlan {
  const maxFiles = options.maxFiles ?? MAX_IMPORT_FILES;
  const maxBytes = options.maxBytes ?? MAX_IMPORT_BYTES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const files: Record<string, GithubBaselineFile> = {};
  const materialize: ImportPlan["materialize"] = [];
  let skippedNotNotes = 0;
  let skippedTooLarge = 0;
  let skippedOverLimit = 0;
  let bytes = 0;

  const sorted = [...tree.entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const path = joinPath(entry.path);
    if (!path || files[path]) continue;
    if (!isMaterializable(path)) {
      skippedNotNotes += 1;
      files[path] = { remoteSha: entry.sha, localHash: null, imported: false };
      continue;
    }
    if (entry.size > maxFileBytes) {
      skippedTooLarge += 1;
      files[path] = { remoteSha: entry.sha, localHash: null, imported: false };
      continue;
    }
    if (materialize.length >= maxFiles || bytes + entry.size > maxBytes) {
      skippedOverLimit += 1;
      files[path] = { remoteSha: entry.sha, localHash: null, imported: false };
      continue;
    }
    bytes += entry.size;
    materialize.push({ path, sha: entry.sha, size: entry.size });
    // localHash 等真正写完再填（写失败的文件不能假装「本地就是这一份」）
    files[path] = { remoteSha: entry.sha, localHash: null, imported: false };
  }

  return { materialize, files, skippedNotNotes, skippedTooLarge, skippedOverLimit, truncated: tree.truncated };
}

export interface RunImportInput {
  api: GithubApi;
  ref: string;
  headSha: string;
  treeSha: string;
  plan: ImportPlan;
  target: { owner: string; repo: string; remote: string };
  backend: FileSystemBackend;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface ImportReport {
  written: number;
  failed: number;
  /** 因为取消（`signal`）而**根本没去取**的条数：既不写盘也不计失败。 */
  aborted: number;
  bytes: number;
  baseline: GithubBaseline;
}

/** 有界并发（与 library.ts 的扫描同款做法，不额外引入依赖）。 */
async function forEachLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * 按计划取字节、写盘、记哈希，最后交回基线。
 *
 * 单个文件失败**不中断整次导入**（网络抖动很正常）：它留在基线里但标成 `imported:false`，
 * 于是既不会被当成「本地删了」而误删远端，也不会参与推送 —— 错的代价只是这一篇没导进来，
 * 报告里 `failed` 会说数。
 */
export async function runImport(input: RunImportInput): Promise<ImportReport> {
  const { api, ref, plan, backend } = input;
  const files: Record<string, GithubBaselineFile> = { ...plan.files };
  let written = 0;
  let failed = 0;
  let aborted = 0;
  let bytes = 0;
  let done = 0;

  await forEachLimited(plan.materialize, IMPORT_CONCURRENCY, async (entry) => {
    try {
      if (input.signal?.aborted) {
        // 取消**不算失败**（用户主动停的），但进度照常推进 —— 界面要说得出「已取消 N/M」
        aborted += 1;
        return;
      }
      const data = await api.raw(entry.path, ref);
      if (isImagePath(entry.path)) await backend.writeBytes(entry.path, data);
      else await backend.writeText(entry.path, new TextDecoder().decode(data));
      files[entry.path] = { remoteSha: entry.sha, localHash: await sha256Hex(data), imported: true };
      written += 1;
      bytes += data.byteLength;
    } catch (error) {
      failed += 1;
      // 「文件在树里、但 raw 拿不到」（子模块、LFS 指针、超大文件…）：如实记一条，不假装成功
      console.warn("[opennote] 这个文件没能从 GitHub 取下来", entry.path, error);
      files[entry.path] = { ...files[entry.path], imported: false };
    } finally {
      done += 1;
      input.onProgress?.(done, plan.materialize.length);
    }
  });

  return {
    written,
    failed,
    aborted,
    bytes,
    baseline: makeBaseline({
      owner: input.target.owner,
      repo: input.target.repo,
      ref,
      remote: input.target.remote,
      headSha: input.headSha,
      treeSha: input.treeSha,
      files,
    }),
  };
}

/** 把 GitHub 的报错统一成一句人话（界面只贴它；不是 `GithubError` 的按未知处理）。 */
export function describeGithubError(error: unknown): string {
  if (error instanceof GithubError) return error.userMessage;
  if (error instanceof Error && error.message) return error.message;
  return "连不上 GitHub，请检查网络后重试。";
}
