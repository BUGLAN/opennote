/**
 * 本地桥客户端 × mock 桥的**真回环集成测试**（不 mock fetch，全部走 127.0.0.1）。
 * 覆盖：端口顺序发现、300ms 超时、Bearer 令牌、幂等（同 importId）、
 * 六个错误码分支、以及「扩展一律不发 overwrite」的行为断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
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
  PAIRING_REMOVED,
  postImport,
  probeHealth,
  requestJson,
  submitEnvelope,
} from "../src/lib/bridge.js";
import { ISO_WITH_TZ_RE, buildEnvelope, envelopeProblems } from "../src/lib/envelope.js";
import { STATE, decideState } from "../src/lib/state.js";
import { diag, reportUntrusted } from "../tools/untrusted-marker.mjs";

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

/** 只做 TCP 连接探测：不产生任何 mock 可见的请求（否则会干扰按请求计数的用例）。 */
async function portAccepts(port) {
  return await new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function bootstrap(options = {}) {
  const outDir = options.outDir || mkdtempSync(join(tmpdir(), "opennote-mock-"));
  const bridge = await startMockBridge({ port: 0, log: false, outDir, ...options });
  // 环境就绪守卫（**有界**，**唯一产地**）：mock 还没开始响应就发请求 → 分类会是 `unreachable`，
  // 那是**环境不可信**，不是产品红（实测两次 flake 都出在这一族：overwrite / no-window）。
  // 判据用「不是 unreachable」而不是「kind==='ok'」—— 有意制造异常的 mode（starting/foreign/no-window…）
  // 本来就答不出 ok，但它们**已经就绪**，不该被当成环境不可用。
  // 等不到就报不可信并退出（runner 按标记文件改判为 2），**不许静默通过、也不许当产品缺陷报红**。
  // 判据是 **TCP 能连上**（不是发一次健康请求）：`rate-limit` 那类用例是按**请求计数**判定的，
  // 用 HTTP 探测会给 mock 多发一次请求，**守卫会改变它所观测的东西**（实测：3/3 把该用例判红）。
  for (let i = 0; i < 30; i += 1) {
    if (await portAccepts(bridge.port)) return bridge;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  diag("bootstrap：mock 端口 3 秒内没有开始接受连接");
  reportUntrusted("mock 在 3 秒内没有开始接受连接（环境不可信，不是产品缺陷）");
  process.exit(1); // runner 按标记文件改判为 2
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

test("㉞ 去配对：客户端不再有 /v1/pair 这条路径，令牌只能由用户粘贴（47 字符）", async (t) => {
  const bridge = await bootstrap({ code: "482913" });
  t.after(() => bridge.close());

  // 客户端侧：桥库不再导出 postPair（配对整体删除），只留一条显式的删除记录
  assert.equal(typeof postPair, "undefined");
  assert.equal(PAIRING_REMOVED.removedIn, "0.3.1");
  // 桥仍可能实现 /v1/pair（服务端的事，由 c 线处理），但扩展**不再调用**它
  assert.equal(bridge.pairs.length, 0, "启动过程里不应该出现任何配对请求");

  // 粘贴路径：47 字符令牌直接可用于导入（本地校验见 lib/bridge.js 的 isValidToken）
  assert.equal(isValidToken(bridge.token), true);
  assert.equal(bridge.token.length, 47);
  const call = await submitEnvelope(bridge.port, bridge.token, envelopeFixture(), { attempts: 1 });
  assert.equal(call.kind, "ok");
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

test("origin-denied（403 IMP-3001 来源不是扩展/本机程序）→ 未配置令牌，绝不能显示已连接", async (t) => {
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

test("auth-required：健康检查仍可读，导入一律 401 IMP-2001 → 状态切「未配置令牌」", async (t) => {
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

test("应用侧「先进入收件箱」（㉕）：通道非 in-app → 一律 202 pending，判定链第 2–6 步被跳过", async (t) => {
  const bridge = await bootstrap({ inbox: true });
  t.after(() => bridge.close());
  const url = "https://example.com/inbox-mode";

  // 第一次：没有 conflict 键、selection:true —— 平时会 created，开了收件箱开关就必须 pending
  const first = buildEnvelope({
    title: "收件箱模式一",
    body: "第一版正文。\n",
    url,
    site: "example.com",
    capturedAt: "2026-09-29T21:04:11+08:00",
    selection: true,
  });
  const pending = await submitEnvelope(bridge.port, bridge.token, first);
  assert.equal(pending.result.status, "pending");
  assert.equal(pending.http, 202);
  assert.ok(pending.result.inboxId, "进收件箱必须带非空 inboxId");
  assert.equal(bridge.wrotePaths.length, 0, "进收件箱不得写任何笔记文件");
  assert.equal(bridge.imports[0].path, null, "收件箱条目没有笔记路径");
  assert.ok(!("conflict" in first), "插件仍然不下发 conflict 键（红线）");

  // 第 1 步幂等优先：同一个 importId 重投 → deduped，不得产生第二条收件箱条目
  const again = await submitEnvelope(bridge.port, bridge.token, first);
  assert.equal(again.result.status, "deduped");
  assert.equal(bridge.pending.length, 1, "同 importId 重投不得多出收件箱条目");

  // 第 2 步（内容重复）也被跳过：新 importId、同 URL 同正文 → 仍 pending（这一步在平时会 duplicate）
  const duplicateContent = buildEnvelope({
    importId: "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
    title: "收件箱模式一",
    body: "第一版正文。\n",
    url,
    site: "example.com",
    capturedAt: "2026-09-29T21:07:00+08:00",
    selection: true,
  });
  const second = await submitEnvelope(bridge.port, bridge.token, duplicateContent);
  assert.equal(second.result.status, "pending");
  assert.equal(bridge.pending.length, 2);
  assert.deepEqual(
    bridge.judgment.map((entry) => entry.step),
    ["pending", "deduped", "pending"],
  );

  // 对照：同样的内容，开关关掉后仍走判定链（证明上面 pending 是开关造成的，不是内容造成的）
  const plain = await bootstrap();
  t.after(() => plain.close());
  const control = await submitEnvelope(plain.port, plain.token, first);
  assert.equal(control.result.status, "created");
  assert.equal(control.http, 201);
});

test("追加到指定笔记：conflict=append + target.notePath 落到那篇 .md（02 §2.4）", async (t) => {
  const bridge = await bootstrap();
  t.after(() => bridge.close());
  const notePath = "笔记/读书笔记.md";

  const payload = buildEnvelope({
    title: "摘录追加",
    body: "被追加的一段。\n",
    url: "https://example.com/append-target",
    site: "example.com",
    capturedAt: "2026-09-29T21:08:00+08:00",
    selection: true,
    notePath,
    conflict: "append",
  });
  assert.equal(payload.target.notePath, notePath);
  assert.equal(payload.conflict, "append");

  const appended = await submitEnvelope(bridge.port, bridge.token, payload);
  assert.equal(appended.result.status, "appended");
  assert.equal(appended.result.path, notePath);
  assert.equal(readFileSync(join(bridge.outDir, "笔记", "读书笔记.md"), "utf8").includes("被追加的一段。"), true);
  assert.deepEqual(
    bridge.judgment.map((entry) => entry.step),
    ["appended"],
  );

  // 落点带 `..`：客户端**先**拦住（envelopeProblems），手工绕过客户端时服务端回 IMP-4009，
  // 两条路径都不得静默改成「新建一篇笔记」。
  const evil = buildEnvelope({
    importId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
    title: "越界追加",
    body: "x",
    url: "https://example.com/append-evil",
    site: "example.com",
    capturedAt: "2026-09-29T21:09:00+08:00",
    selection: true,
    notePath: "a/../b.md",
    conflict: "append",
  });
  assert.ok(
    envelopeProblems(evil).some((problem) => problem.includes("工作区相对")),
    "客户端必须先拦住越界落点",
  );
  const bypass = await postImport(bridge.port, bridge.token, {
    ...evil,
    body: "越界追加的正文。\n",
    source: { ...evil.source, url: "https://example.com/append-evil" },
    target: { folder: null, notePath: "a/../b.md" },
    conflict: "append",
  });
  assert.equal(bypass.kind, "error", "服务端也必须拒（不得当成新建笔记）");
  assert.ok(["IMP-4009", "IMP-4001"].includes(bypass.code), `期望落点错误码，实际 ${bypass.code}`);
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









