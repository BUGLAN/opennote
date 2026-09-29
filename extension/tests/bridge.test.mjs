/**
 * 本地桥客户端 × mock 桥的**真回环集成测试**（不 mock fetch，全部走 127.0.0.1）。
 * 覆盖：端口顺序发现、300ms 超时、Bearer 令牌、幂等（同 importId）、
 * 六个错误码分支、以及「扩展一律不发 overwrite」的行为断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockBridge } from "../tools/mock-bridge.mjs";
import {
  BRIDGE_PORTS,
  HEALTH_TIMEOUT_MS,
  codeFromHttp,
  discover,
  endpointOf,
  getImportStatus,
  getWorkspace,
  isValidToken,
  postImport,
  postPair,
  probeHealth,
  requestJson,
  submitEnvelope,
} from "../src/lib/bridge.js";
import { ISO_WITH_TZ_RE, buildEnvelope } from "../src/lib/envelope.js";
import { STATE, decideState } from "../src/lib/state.js";

function envelopeFixture(importId = "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90") {
  return buildEnvelope({
    importId,
    title: "中文排版指北",
    body: "第一段。\n\n第二段。",
    url: "https://example.com/post",
    pageTitle: "中文排版指北 · 示例站",
    site: "example.com",
    author: "小林",
    publishedAt: "2026-09-20T10:00:00+08:00",
    capturedAt: "2026-09-29T21:04:11+08:00",
    selection: true,
    folder: "剪藏",
    tags: ["排版", "网页剪藏"],
  });
}

async function bootstrap(options = {}) {
  const outDir = options.outDir || mkdtempSync(join(tmpdir(), "opennote-mock-"));
  const bridge = await startMockBridge({ port: 0, log: false, outDir, ...options });
  return bridge;
}

async function reserveClosedPort() {
  const server = createServer((_req, res) => res.end(""));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("端口发现：默认范围就是 8787–8796，单次超时 300ms（02 §5.2.1）", () => {
  assert.deepEqual([...BRIDGE_PORTS], [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796]);
  assert.equal(HEALTH_TIMEOUT_MS, 300);
  assert.equal(endpointOf(8787, "/v1/health"), "http://127.0.0.1:8787/v1/health");
});

test("没有任何端口在监听 → unreachable（IMP-1001 / 本地接口未开启）", async () => {
  const port = await reserveClosedPort();
  const probe = await probeHealth(port);
  assert.equal(probe.kind, "unreachable");
  const result = await discover({ ports: [port] });
  assert.equal(result.hit, null);
  assert.equal(result.sawListener, false);
  assert.equal(result.noWindow, false);
  const state = decideState({ probe: result, online: true, token: "opn_x", pendingCount: 0 });
  assert.equal(state, STATE.INTERFACE_OFF);
});

test("顺序探测：命中即停，返回完整探测记录", async (t) => {
  const first = await bootstrap();
  const second = await bootstrap();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  const result = await discover({ ports: [first.port, second.port] });
  assert.equal(result.hit.port, first.port);
  assert.equal(result.probes.length, 1);
  assert.equal(result.sawListener, true);

  const missed = await discover({ ports: [first.port, second.port].slice(1) });
  assert.equal(missed.hit.port, second.port);
});

test("健康检查读得出 workspace.open（不许从 health 里期待绝对路径）", async (t) => {
  const open = await bootstrap();
  const empty = await bootstrap({ mode: "no-workspace" });
  t.after(async () => {
    await open.close();
    await empty.close();
  });
  const healthy = await probeHealth(open.port);
  assert.equal(healthy.kind, "ok");
  assert.equal(healthy.health.workspace.open, true);
  assert.equal(healthy.health.spec, "opennote.import/v1");
  assert.ok(!JSON.stringify(healthy.health).includes(":\\"), "health 不得返回绝对路径");

  const noWorkspace = await probeHealth(empty.port);
  assert.equal(noWorkspace.health.workspace.open, false);
  const probe = await discover({ ports: [empty.port] });
  assert.equal(decideState({ probe, online: true, token: "opn_x", pendingCount: 0 }), STATE.CONNECTED);
  // 背景脚本据此把视图切成「未打开笔记本」（IMP-4007），芯片仍是「已连接」
  const ws = await getWorkspace(empty.port, empty.token);
  assert.equal(ws.open, false);
});

test("POST /v1/import：创建 + 幂等 + 请求头 + 落盘（H1 是唯一标题来源）", async (t) => {
  const bridge = await bootstrap();
  t.after(() => bridge.close());
  const envelope = envelopeFixture();

  const first = await submitEnvelope(bridge.port, bridge.token, envelope);
  assert.equal(first.kind, "ok");
  assert.equal(first.result.status, "created");
  assert.equal(first.result.path, "剪藏/中文排版指北.md");
  assert.equal(first.result.deduped, false);
  assert.equal(first.attempts, 1);

  const received = bridge.imports[0].envelope;
  assert.equal(received.spec, "opennote.import/v1");
  assert.equal(received.client.name, "chrome-extension");
  assert.match(received.source.capturedAt, ISO_WITH_TZ_RE);
  assert.equal(received.source.selection, true);
  assert.ok(!("conflict" in received), "信封不得下发 conflict 键（否则接收端判定链第 3/4 步失效）");
  assert.equal(received.conflict === "overwrite", false);
  assert.deepEqual(bridge.unknownFieldsSeen, []);
  assert.deepEqual(bridge.tagsViolations, []);

  const request = bridge.requests.at(-1);
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/import");
  assert.equal(request.query, "", "令牌与参数都不许进 query");
  assert.ok(request.authorization.startsWith("Bearer opn_"));
  assert.equal(request.authorization.length, "Bearer ".length + 47);
  assert.equal(request.xOpennoteToken, bridge.token);
  assert.match(request.contentType, /application\/json/);

  const file = readFileSync(bridge.imports[0].filePath, "utf8");
  assert.ok(file.includes("# 中文排版指北"), "标题必须写进正文 H1");
  assert.ok(file.includes("第二段。"));

  const second = await submitEnvelope(bridge.port, bridge.token, envelope);
  assert.equal(second.result.status, "deduped");
  assert.equal(second.result.deduped, true);
  assert.equal(second.result.dedupedBy, "importId");
  assert.equal(bridge.imports.length, 1, "同 importId 不得产生第二个文件");
});

test("鉴权：缺令牌 → IMP-2001；错令牌 → IMP-2002，且响应体不含 opn_（02 §10 S-06）", async (t) => {
  const bridge = await bootstrap();
  t.after(() => bridge.close());
  const envelope = envelopeFixture();

  const missing = await postImport(bridge.port, null, envelope);
  assert.equal(missing.kind, "error");
  assert.equal(missing.code, "IMP-2001");

  const wrongToken = `opn_${"A".repeat(43)}`;
  const wrong = await postImport(bridge.port, wrongToken, envelope);
  assert.equal(wrong.code, "IMP-2002");

  const raw = await requestJson(endpointOf(bridge.port, "/v1/import"), {
    method: "POST",
    headers: { Authorization: `Bearer ${wrongToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  assert.equal(raw.http, 401);
  assert.ok(!raw.text.includes("opn_"), "401 响应体不得回显令牌前缀");
  assert.ok(!raw.text.includes(bridge.token));
});

test("令牌校验（background 的 API-03 只读探测）：有效 → IMP-4017，无效 → IMP-2002", async (t) => {
  const bridge = await bootstrap();
  t.after(() => bridge.close());
  const good = await getImportStatus(bridge.port, bridge.token, "auth-probe-0000");
  assert.equal(good.kind, "error");
  assert.equal(good.code, "IMP-4017");
  const bad = await getImportStatus(bridge.port, `opn_${"B".repeat(43)}`, "auth-probe-0000");
  assert.equal(bad.code, "IMP-2002");
});

test("配对：错误配对码 → IMP-2004；正确 → 47 字符令牌（并记录 origin）", async (t) => {
  const bridge = await bootstrap({ code: "482913" });
  t.after(() => bridge.close());

  const wrong = await postPair(bridge.port, "000000");
  assert.equal(wrong.kind, "error");
  assert.equal(wrong.code, "IMP-2004");

  const right = await postPair(bridge.port, "482913");
  assert.equal(right.kind, "ok");
  assert.equal(right.token.length, 47);
  assert.ok(isValidToken(right.token));
  assert.equal(right.result.spec, "opennote.import/v1");
  assert.equal(bridge.pairs.length, 2);
  assert.equal(bridge.pairs[1].client.name, "chrome-extension");
});

test("no-window：桥在跑但窗口不在场 → IMP-4006，状态为「Opennote 未运行」", async (t) => {
  const bridge = await bootstrap({ mode: "no-window" });
  t.after(() => bridge.close());
  const probe = await discover({ ports: [bridge.port] });
  assert.equal(probe.noWindow, true);
  assert.equal(probe.hit, null);
  assert.equal(decideState({ probe, online: true, token: "opn_x", pendingCount: 0 }), STATE.NOT_RUNNING);
  const call = await submitEnvelope(bridge.port, bridge.token, envelopeFixture(), { attempts: 1 });
  assert.equal(call.code, "IMP-4006");
  assert.equal(call.retryable, true);
});

test("foreign：有端口在监听但不是我们的桥 → 端口被占用", async (t) => {
  const bridge = await bootstrap({ mode: "foreign" });
  t.after(() => bridge.close());
  const probe = await probeHealth(bridge.port);
  assert.equal(probe.kind, "foreign");
  const result = await discover({ ports: [bridge.port] });
  assert.equal(result.hit, null);
  assert.equal(result.sawListener, true);
  assert.equal(decideState({ probe: result, online: true, token: "opn_x", pendingCount: 0 }), STATE.PORT_BUSY);
});

test("starting（端口已绑定但接口没就绪，答得比 300ms 慢）→ 本地接口未开启 + 可重试，绝不显示已连接", async (t) => {
  const bridge = await bootstrap({ mode: "starting" });
  t.after(() => bridge.close());
  const started = Date.now();
  const probe = await probeHealth(bridge.port, { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(probe.kind, "timeout", `300ms 内答不完就该判超时，实际 ${probe.kind}`);
  assert.ok(elapsed < 900, `探测必须按 300ms 预算收手，实际 ${elapsed}ms`);
  const result = await discover({ ports: [bridge.port], timeoutMs: 300 });
  assert.equal(result.hit, null);
  const stateId = decideState({ probe: result, online: true, token: "opn_x", pendingCount: 0 });
  assert.notEqual(stateId, STATE.CONNECTED, "启动中绝不能显示已连接");
  assert.equal(stateId, STATE.INTERFACE_OFF);
});

test("origin-denied（403 IMP-3001 来源未被信任）→ 需要配对，绝不能显示已连接", async (t) => {
  const bridge = await bootstrap({ mode: "origin-denied" });
  t.after(() => bridge.close());
  const probe = await probeHealth(bridge.port);
  assert.equal(probe.code, "IMP-3001");
  const result = await discover({ ports: [bridge.port] });
  assert.equal(result.hit, null);
  assert.equal(result.originRejected, true);
  // 即便本地已经有令牌，也不能显示已连接
  const stateId = decideState({ probe: result, online: true, token: bridge.token, pendingCount: 0 });
  assert.notEqual(stateId, STATE.CONNECTED);
  assert.equal(stateId, STATE.NEEDS_PAIRING);
});

test("rate-limit：IMP-4015 带 Retry-After，客户端只重试一次且不空转", async (t) => {
  const probeBridge = await bootstrap({ mode: "rate-limit" });
  const retryBridge = await bootstrap({ mode: "rate-limit" });
  t.after(async () => {
    await probeBridge.close();
    await retryBridge.close();
  });
  const envelope = envelopeFixture();
  const first = await postImport(probeBridge.port, probeBridge.token, envelope);
  assert.equal(first.code, "IMP-4015");
  assert.equal(first.retryable, true);
  assert.equal(first.retryAfter, 1);
  // 全新靶机：第一次 429、重试成功 → 恰好 2 次
  const retried = await submitEnvelope(retryBridge.port, retryBridge.token, envelope);
  assert.equal(retried.kind, "ok");
  assert.equal(retried.attempts, 2);
  assert.equal(retryBridge.imports.length, 1);
});

test("folder-denied：落点被拒 → IMP-4009（芯片仍是已连接）", async (t) => {
  const bridge = await bootstrap({ mode: "folder-denied" });
  t.after(() => bridge.close());
  const call = await submitEnvelope(bridge.port, bridge.token, envelopeFixture(), { attempts: 1 });
  assert.equal(call.code, "IMP-4009");
  assert.equal(call.retryable, false);
});

test("auth-required：健康检查仍可读，导入一律 401 IMP-2001 → 状态切「需要配对」", async (t) => {
  const bridge = await bootstrap({ mode: "auth-required" });
  t.after(() => bridge.close());
  const health = await probeHealth(bridge.port);
  assert.equal(health.kind, "ok");
  const call = await postImport(bridge.port, bridge.token, envelopeFixture());
  assert.equal(call.code, "IMP-2001");
  assert.equal(decideState({ probe: await discover({ ports: [bridge.port] }), online: true, token: null, pendingCount: 0 }), STATE.NEEDS_PAIRING);
});

test("mock 自身会拦住 overwrite（证明「扩展一律不发 overwrite」这条断言有牙齿）", async (t) => {
  const bridge = await bootstrap();
  t.after(() => bridge.close());
  const forged = { ...envelopeFixture(), conflict: "overwrite" };
  const call = await postImport(bridge.port, bridge.token, forged, {});
  assert.equal(call.kind, "error");
  assert.equal(call.code, "IMP-4001");
});

test("判定链走 HTTP：选区二次剪藏 → appended；整页二次剪藏 → 202 pending + inboxId", async (t) => {
  const bridge = await bootstrap();
  t.after(() => bridge.close());
  const url = "https://example.com/judgment-http";

  const first = buildEnvelope({
    title: "判定链 HT",
    body: "第一版正文。\n",
    url,
    site: "example.com",
    capturedAt: "2026-09-29T21:04:11+08:00",
    selection: true,
  });
  const created = await submitEnvelope(bridge.port, bridge.token, first);
  assert.equal(created.kind, "ok");
  assert.equal(created.result.status, "created");
  assert.equal(created.http, 201);
  assert.ok(!("conflict" in first), "插件信封不得带 conflict 键");

  // 第 3 步：同 URL、正文变了、selection:true → 追加
  const second = buildEnvelope({
    title: "判定链 HT 续",
    body: "第二版正文（追加）。\n",
    url,
    site: "example.com",
    capturedAt: "2026-09-29T21:05:00+08:00",
    selection: true,
  });
  const appended = await submitEnvelope(bridge.port, bridge.token, second);
  assert.equal(appended.result.status, "appended");
  assert.equal(appended.result.path, created.result.path);
  assert.equal(appended.http, 200);

  // 第 4 步：同 URL、正文变了、selection:false → 进收件箱
  const third = buildEnvelope({
    title: "判定链 HT 整页",
    body: "整页第二版（进收件箱）。\n",
    url,
    site: "example.com",
    capturedAt: "2026-09-29T21:06:00+08:00",
    selection: false,
  });
  const pending = await submitEnvelope(bridge.port, bridge.token, third);
  assert.equal(pending.result.status, "pending");
  assert.ok(pending.result.inboxId, "pending 必须带非空 inboxId");
  assert.equal(pending.http, 202);
  assert.equal(bridge.imports.length, 1, "进收件箱不得直接落成笔记");

  assert.deepEqual(
    bridge.judgment.map((entry) => entry.step),
    ["created", "appended", "pending"],
  );
});

test("HTTP 状态码兜底映射：不留「未知错误」", () => {
  assert.equal(codeFromHttp(400), "IMP-3002");
  assert.equal(codeFromHttp(401), "IMP-2002");
  assert.equal(codeFromHttp(403), "IMP-3001");
  assert.equal(codeFromHttp(404), "IMP-3005");
  assert.equal(codeFromHttp(413), "IMP-4005");
  assert.equal(codeFromHttp(415), "IMP-3004");
  assert.equal(codeFromHttp(429), "IMP-4015");
  assert.equal(codeFromHttp(500), "IMP-5001");
  assert.equal(codeFromHttp(418), "IMP-4014");
  assert.ok(isValidToken(`opn_${"a".repeat(43)}`));
  assert.ok(!isValidToken(`opn_${"a".repeat(42)}`));
  assert.ok(!isValidToken(`xxx_${"a".repeat(43)}`));
});
