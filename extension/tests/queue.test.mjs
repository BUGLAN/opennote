/**
 * 离线暂存队列单测（FR-53 / 02 §5.7.7 `queued_offline`）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_MAX_ITEMS,
  QUEUE_BYTE_BUDGET,
  enqueue,
  findItem,
  itemBytes,
  makeQueueItem,
  markAttempt,
  queueBytes,
  queueSummary,
  removeItem,
  takeBatch,
} from "../src/lib/queue.js";
import { buildEnvelope } from "../src/lib/envelope.js";

function envelopeWith(id, body = "正文") {
  return buildEnvelope({
    importId: id,
    title: "标题",
    body,
    url: "https://example.com/a",
    pageTitle: "标题 · 站点",
    site: "example.com",
    capturedAt: "2026-09-29T21:04:11+08:00",
    selection: true,
  });
}

function item(id) {
  return makeQueueItem({
    envelope: envelopeWith(id),
    endpoint: "http://127.0.0.1:8787",
    token: "opn_TEST",
    port: 8787,
    folderLabel: "剪藏",
    noteTitle: "标题",
    mode: "selection",
    reason: "IMP-1001",
  });
}

test("暂存项保存完整信封 + 端口/token 快照 + 同一 importId", () => {
  const entry = item("3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90");
  assert.equal(entry.importId, entry.envelope.importId);
  assert.equal(entry.port, 8787);
  assert.equal(entry.token, "opn_TEST");
  assert.equal(entry.endpoint, "http://127.0.0.1:8787");
  assert.equal(entry.reason, "IMP-1001");
  assert.equal(entry.attempts, 0);
  assert.equal(entry.mode, "selection");
  assert.equal(entry.folderLabel, "剪藏");
});

test("入队：同一 importId 只保留一条（重投幂等）", () => {
  const id = "aaaa1111-bbbb-2222-cccc-333344445555";
  const first = enqueue([], item(id));
  const second = enqueue(first.queue, { ...item(id), reason: "IMP-4006" });
  assert.equal(second.queue.length, 1);
  assert.equal(second.queue[0].reason, "IMP-4006");
});

test("入队：超过 50 条从最旧开始丢弃，并把被丢弃的条目返回", () => {
  let queue = [];
  for (let i = 0; i < QUEUE_MAX_ITEMS + 3; i += 1) {
    const result = enqueue(queue, item(`id-${String(i).padStart(8, "0")}`));
    assert.equal(result.ok, true);
    queue = result.queue;
  }
  assert.equal(queue.length, QUEUE_MAX_ITEMS);
  const overflow = enqueue(queue, item("id-last-0000"));
  assert.equal(overflow.queue.length, QUEUE_MAX_ITEMS);
  assert.equal(overflow.evicted.length, 1);
  assert.equal(overflow.evicted[0].importId, "id-00000003");
  assert.equal(overflow.queue[overflow.queue.length - 1].importId, "id-last-0000");
});

test("入队：单条超过字节预算 → 明确拒绝（不许静默丢弃）", () => {
  const huge = item("id-huge-0001");
  huge.envelope.body = "a".repeat(QUEUE_BYTE_BUDGET + 1024);
  const result = enqueue([], huge);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "item-too-large");
  assert.equal(result.queue.length, 0);
});

test("FIFO 补投批次 / 移除 / 记失败", () => {
  let queue = [];
  for (const id of ["id-00000001", "id-00000002", "id-00000003", "id-00000004"]) {
    queue = enqueue(queue, item(id)).queue;
  }
  assert.deepEqual(takeBatch(queue, 2).map((it) => it.importId), ["id-00000001", "id-00000002"]);
  queue = markAttempt(queue, "id-00000001", "IMP-4006");
  assert.equal(findItem(queue, "id-00000001").attempts, 1);
  assert.equal(findItem(queue, "id-00000001").lastCode, "IMP-4006");
  queue = removeItem(queue, "id-00000001");
  assert.equal(findItem(queue, "id-00000001"), null);
  assert.equal(queue.length, 3);
  const summary = queueSummary(queue);
  assert.equal(summary.count, 3);
  assert.ok(summary.bytes > 0);
  assert.ok(queueBytes(queue) > 0);
  assert.ok(itemBytes(queue[0]) > 0);
});

test("markAttempt / removeItem 对不存在的 id 是安全的空操作", () => {
  const queue = [item("id-00000009")];
  assert.equal(removeItem(queue, "nope").length, 1);
  assert.equal(markAttempt(queue, "nope", "IMP-1001")[0].attempts, 0);
});
