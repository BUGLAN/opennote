/**
 * 离线暂存队列（FR-53 / 02 §5.7.7 `queued_offline`）。
 *
 * 纪律：
 *  - 每一条都保存**完整信封 + 端口/token 快照 + 同一个 `importId`**；
 *    重投时 importId 不变 → 服务端按 02 §4.1 第 1 步幂等命中，不会重复入库。
 *  - 队列写不下时**必须如实告诉用户**（不许静默丢掉），并走「复制到剪贴板」降级。
 *  - 纯函数，可在 node 里断言。
 */

import { utf8Bytes } from "./envelope.js";

export const QUEUE_MAX_ITEMS = 50; // FR-53 的队列上限：够用且不会把 storage 撑爆
/** chrome.storage.local 默认 10 MB 配额（未申请 unlimitedStorage），给队列留 6 MB 预算。 */
export const QUEUE_BYTE_BUDGET = 6 * 1024 * 1024;

/** 单条队列项的存储字节估算。 */
export function itemBytes(item) {
  try {
    return utf8Bytes(JSON.stringify(item));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function queueBytes(queue) {
  return (Array.isArray(queue) ? queue : []).reduce((sum, item) => sum + itemBytes(item), 0);
}

/**
 * 造一条暂存项。
 * @param {object} input
 * @param {object} input.envelope 完整信封（L0）
 * @param {string} input.endpoint 提交时用的 `http://127.0.0.1:<port>`
 * @param {string|null} input.token 提交时的令牌（可能是 null：还没配对）
 * @param {number|null} input.port
 * @param {string} [input.folderLabel] 展示用落点标签（成功文案要用）
 * @param {string} [input.noteTitle]
 * @param {string} [input.mode] `selection` | `page`
 * @param {string} [input.reason] 入队的契约 code（IMP-1001 / IMP-4006 / …）
 */
export function makeQueueItem(input) {
  const envelope = input.envelope;
  return {
    importId: envelope.importId,
    envelope,
    endpoint: input.endpoint || null,
    token: input.token || null,
    port: input.port === undefined ? null : input.port,
    folderLabel: input.folderLabel || "根目录",
    noteTitle: input.noteTitle || envelope.title || "",
    mode: input.mode || (envelope.source && envelope.source.selection ? "selection" : "page"),
    reason: input.reason || null,
    queuedAt: input.queuedAt || new Date().toISOString(),
    attempts: 0,
    lastCode: null,
  };
}

/**
 * 入队。同一 `importId` 只保留一条（重投语义），超出条数/字节预算时从**最旧**开始丢弃，
 * 并把被丢弃的条目返回给调用方（用于如实告知用户）。
 * @returns {{ok: boolean, queue: object[], evicted: object[], reason: string|null}}
 */
export function enqueue(queue, item, options = {}) {
  const { maxItems = QUEUE_MAX_ITEMS, byteBudget = QUEUE_BYTE_BUDGET } = options;
  const current = (Array.isArray(queue) ? queue : []).filter((it) => it && it.importId !== item.importId);
  const bytes = itemBytes(item);
  if (bytes > byteBudget) {
    return { ok: false, queue: current, evicted: [], reason: "item-too-large" };
  }
  const evicted = [];
  const next = [...current, item];
  while (next.length > maxItems || queueBytes(next) > byteBudget) {
    if (next.length <= 1) break;
    evicted.push(next.shift());
  }
  return { ok: true, queue: next, evicted, reason: null };
}

export function removeItem(queue, importId) {
  return (Array.isArray(queue) ? queue : []).filter((it) => it && it.importId !== importId);
}

export function findItem(queue, importId) {
  return (Array.isArray(queue) ? queue : []).find((it) => it && it.importId === importId) || null;
}

/** 记一次失败（attempts +1，留下契约 code 以便排障）。 */
export function markAttempt(queue, importId, code) {
  return (Array.isArray(queue) ? queue : []).map((it) =>
    it && it.importId === importId
      ? { ...it, attempts: (it.attempts || 0) + 1, lastCode: code || it.lastCode || null }
      : it,
  );
}

/** 补投批次：按入队顺序（FIFO）取前 N 条。 */
export function takeBatch(queue, limit = 3) {
  return (Array.isArray(queue) ? queue : []).slice(0, Math.max(0, limit));
}

export function queueSummary(queue) {
  const list = Array.isArray(queue) ? queue : [];
  return {
    count: list.length,
    bytes: queueBytes(list),
    oldest: list.length ? list[0].queuedAt : null,
  };
}
