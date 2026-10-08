/**
 * A（网页版剪藏页）· 扩展侧的两件事，逐条卡住：
 *
 *   ① `POST /v1/clip/stage`（Bearer 长期令牌，请求体形状冻结）；
 *   ② 成功拿到 `openUrl` 后 `chrome.tabs.create({ url: openUrl })`。
 *
 * 这一组里**有真回环**（`tools/mock-bridge.mjs` 起一个真的 127.0.0.1 服务端，不 mock fetch）：
 * 请求体形状、资产的合法形状、图片下载的成功/降级，全部是**可执行**断言 ——
 * 起因是独立验证者用真桥探到过一次真缺陷：扩展发出 `assets:[{url,alt}]`，
 * 而 02 §2.5 要求 `{name, mime, dataBase64}` ⇒ 桥回 422 `IMP-4003 detail.field="assets[0].name"`。
 * 所以这里既测「合法形状能过」，也测「非法形状一定被拒」（判据两边都卡，不许只卡一边）。
 *
 * 被删掉的旧路（`src/clip/clip.html` + `clip.js` 与它的 `?tabId=` 路由）在这里**反向断言**：
 * 目标没了、路由也必须没了（C-10p：死路由与死按钮成对存在或成对消失）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startMockBridge } from "../tools/mock-bridge.mjs";
import { postClipStage } from "../src/lib/bridge.js";
import { collectImageAssetsFromPage, sniffMime } from "../src/lib/assets.js";
import { fetchImagesInPage } from "../src/content/fetch-images.js";
import {
  IMAGE_DOWNLOAD_DEFAULT,
  STAGE_REQUEST_KEYS,
  STAGE_SOURCE_KEYS,
  IMAGE_UNUSABLE_WARNING,
  buildStageRequest,
  openUrlOf,
} from "../src/lib/stage.js";
import { diag, reportUntrusted } from "../tools/untrusted-marker.mjs";

const ROOT = join(import.meta.dirname, "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
/**
 * 剥注释再比对：这类判据**三次**被注释带偏（注释里解释「以前这里写死 ex.article.excerpt」
 * → 判据把注释当成了代码）。凡是「代码里不许出现某某」的断言，一律先过这个函数。
 */
const stripComments = (text) =>
  String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const POPUP = read("src", "popup", "popup.js");
const BACKGROUND = read("src", "background.js");
const BRIDGE = read("src", "lib", "bridge.js");
const STAGE = read("src", "lib", "stage.js");

/** 1×1 的**真** PNG（70 字节，含 IHDR/IDAT/IEND）：用来验「按魔数嗅探 + base64 回得来」。 */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000d49444154789c63d864a5f71f0004d6021a376cd97e0000000049454e44ae426082",
  "hex",
);
assert.equal(PNG_BYTES.length, 70, "自检：这串 hex 必须是完整的 70 字节 PNG");

/** 只做 TCP 连接探测（不发 HTTP：免得给 mock 多记一条请求，改变被观测对象）。 */
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
  const outDir = options.outDir || mkdtempSync(join(tmpdir(), "opennote-stage-"));
  const bridge = await startMockBridge({ port: 0, log: false, outDir, ...options });
  for (let i = 0; i < 30; i += 1) {
    if (await portAccepts(bridge.port)) return bridge;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  diag("clip-web-stage bootstrap：mock 端口 3 秒内没有开始接受连接");
  reportUntrusted("clip-web-stage：mock 在 3 秒内没有开始接受连接（环境不可信，不是产品缺陷）");
  process.exit(1); // runner 按 .untrusted 改判为退出码 2
}

/* ── ① 请求体形状（冻结） ─────────────────────────────────────────────── */

test("A①：请求体形状冻结 —— 键集合与顺序逐字等于契约", () => {
  const { request } = buildStageRequest({ url: "https://example.com/p", title: "标题", body: "# 正文" });
  assert.deepEqual(Object.keys(request), [...STAGE_REQUEST_KEYS], "键集合/顺序不得漂移");
  assert.equal(request.spec, "opennote.clip/v1", "spec 必须逐字等于 opennote.clip/v1");
  assert.deepEqual(Object.keys(request.source), [...STAGE_SOURCE_KEYS], "source 的键集合不得漂移");
  assert.deepEqual(request.tags, [], "tags 恒为 []（popup 不再提供标签）");
  assert.deepEqual(request.assets, [], "默认关：没有字节就没有资产");
});

test("A①：selection 恒为 false（两个按钮都不是文本选区）", () => {
  assert.equal(buildStageRequest({ url: "u", title: "t", body: "b" }).request.selection, false);
  assert.equal(buildStageRequest({ url: "u", title: "t", body: "b", selection: true }).request.selection, true);
});

test("A①：取不到的来源字段是 null（不是空串、不是占位值）", () => {
  const { request } = buildStageRequest({ url: "u", title: "t", body: "b" });
  for (const [key, value] of Object.entries(request.source)) assert.equal(value, null, `source.${key} 取不到时必须是 null`);
  const withValues = buildStageRequest({ url: "u", title: "t", body: "b", site: "example.com", author: "小林", publishedAt: "2026-09-20" }).request;
  assert.equal(withValues.source.site, "example.com");
  assert.equal(withValues.source.author, "小林");
  assert.equal(withValues.source.publishedAt, "2026-09-20");
});

/* ── ② 资产形状：02 §2.5 的 {name, mime, dataBase64}（真缺陷的回归闸门） ── */

test("③ 回归闸门：{url, alt} 形状**一律不许**出现在 assets 里（桥会 422）", () => {
  const { request, warnings } = buildStageRequest({
    url: "u",
    title: "t",
    body: "b",
    assets: [{ url: "https://a/b.png", alt: "示意图" }],
  });
  assert.deepEqual(request.assets, [], "信封里不存在 {url,alt} 这种资产形状，一条都不许发");
  assert.equal(warnings.length, 1, "丢掉一条必须如实说一句（不许静默）");
  assert.equal(warnings[0], IMAGE_UNUSABLE_WARNING);
});

test("③ 合法形状逐字保留：{name, mime, dataBase64} 原样进 assets", () => {
  const asset = { name: "b.png", mime: "image/png", dataBase64: "aGVsbG8=" };
  const { request, warnings } = buildStageRequest({ url: "u", title: "t", body: "b", assets: [asset] });
  assert.deepEqual(request.assets, [asset]);
  assert.deepEqual(Object.keys(request.assets[0]), ["name", "mime", "dataBase64"], "键集合不许含糊");
  assert.deepEqual(warnings, [], "合法资产不得凭空产生 warning");
});

/* ── ③ 字节层：下载成功 → 资产；拿不到字节 → 降级 ─────────────────────── */

async function withImageServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test("③ 下载成功：真字节 → {name, mime, dataBase64}，base64 能还原成同一串字节", async () => {
  await withImageServer(
    (request, response) => {
      if (request.url === "/ok.png") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(PNG_BYTES);
        return;
      }
      response.writeHead(404).end("nope");
    },
    async (base) => {
      // 0.4.0 起字节由**页面侧**抓（fetchImagesInPage），组装交给 collectImageAssetsFromPage ——
      // 两层在这里串起来测：页面抓到的就是会进信封的。
      const url = `${base}/ok.png`;
      const results = await fetchImagesInPage({ items: [{ url }] });
      const { assets, warnings, downloaded, failed } = collectImageAssetsFromPage([{ url }], results);
      assert.equal(downloaded, 1);
      assert.equal(failed, 0);
      assert.deepEqual(warnings, []);
      assert.equal(assets.length, 1);
      assert.deepEqual(Object.keys(assets[0]), ["name", "mime", "dataBase64"]);
      assert.equal(assets[0].name, "ok.png", "文件名按 URL 末段推导");
      assert.equal(assets[0].mime, "image/png", "mime 按**字节魔数**判定（不轻信 Content-Type）");
      assert.ok(!assets[0].dataBase64.startsWith("data:"), "dataBase64 是纯 base64，不带 data: 前缀");
      assert.ok(Buffer.from(assets[0].dataBase64, "base64").equals(PNG_BYTES), "解回来必须是同一串字节");
    },
  );
});

test("③ 降级：服务器报错 / 不是图片 / 超时 / 太大 —— 一律不进 assets，原因如实进 warnings", async () => {
  await withImageServer(
    (request, response) => {
      if (request.url === "/error.png") {
        response.writeHead(500).end("boom");
        return;
      }
      if (request.url === "/text.txt") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("这不是图片");
        return;
      }
      if (request.url === "/big.png") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(Buffer.concat([PNG_BYTES, Buffer.alloc(2048)]));
        return;
      }
      if (request.url === "/slow.png") {
        // 永不回话：靠 aborted 超时降级（真机上的「跨站挂住」就是这个形状）
        return;
      }
      response.writeHead(404).end("nope");
    },
    async (base) => {
      const items = [
        { url: `${base}/error.png` },
        { url: `${base}/text.txt` },
        { url: `${base}/big.png` },
        { url: `${base}/slow.png` },
        { url: `${base}/ok.png` },
      ];
      // 页面侧把单件上限放宽（组装侧才是判定产地），超时仍由页面侧真实发生。
      const results = await fetchImagesInPage({ items, timeoutMs: 300, maxBytes: 1024 * 1024 * 1024 });
      const result = collectImageAssetsFromPage(items, results, { maxBytes: 1024 });
      assert.deepEqual(result.assets, [], "一张都没拿到字节 ⇒ assets 必须为空（不许退化成 {url,alt}）");
      assert.equal(result.failed, 5);
      assert.ok(result.warnings.length >= 5, "每个失败都要有自己的那句话");
      for (const warning of result.warnings) {
        assert.match(warning, /正文里保留原始网址/, "降级必须说清后果（正文保留原始 URL）");
      }
      assert.ok(result.warnings.some((item) => item.includes("服务器返回 500")), "要如实说服务器回了什么");
      assert.ok(result.warnings.some((item) => item.includes("不是支持的图片格式")), "要如实说不是图片");
      assert.ok(result.warnings.some((item) => item.includes("太大")), "要如实说太大");
      assert.ok(result.warnings.some((item) => item.includes("下载超时")), "要如实说超时");
    },
  );
});

test("③ 嗅探：魔数优先，认不出的字节不许被当图片", () => {
  assert.equal(sniffMime(PNG_BYTES), "image/png");
  assert.equal(sniffMime(Buffer.from("not an image at all")), null);
  assert.equal(sniffMime(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")), "image/svg+xml");
});

test("③ 正文里的原始 URL 由**抽取结果**决定，下载器不改正文（一个事实一个产地）", () => {
  const assetsModule = read("src", "lib", "assets.js");
  assert.doesNotMatch(assetsModule, /body\s*[=:]\s*/, "下载器不许碰正文");
  const { request } = buildStageRequest({
    url: "u",
    title: "t",
    body: "![图](https://cdn.example.com/a.png)\n\n正文",
    assets: [],
    warnings: ["图片没能下载（没有权限、跨站限制或网络不可达），正文里保留原始网址：https://cdn.example.com/a.png"],
  });
  assert.match(request.body, /!\[图\]\(https:\/\/cdn\.example\.com\/a\.png\)/, "正文里的图片语法必须原样保留");
});

test("③ 默认关：IMAGE_DOWNLOAD_DEFAULT 是 false，且 popup 用它（唯一定义）", () => {
  assert.equal(IMAGE_DOWNLOAD_DEFAULT, false);
  assert.ok(POPUP.includes("let imageDownload = IMAGE_DOWNLOAD_DEFAULT;"), "popup 的默认值必须来自唯一定义");
  assert.match(POPUP, /images: imageDownload/, "只有开关打开时才多要一份图片清单");
});

/* ── ④ openUrl 的唯一产地 ─────────────────────────────────────────────── */

test("A②：openUrl 只来自接口返回值；缺席就是 null（扩展侧绝不拼）", () => {
  assert.equal(openUrlOf(null), null);
  assert.equal(openUrlOf({}), null, "接口没给 openUrl 就是没有 —— 不许在这里补一个");
  assert.equal(openUrlOf({ openUrl: "   " }), null, "空白串也不算给了");
  assert.equal(
    openUrlOf({ openUrl: "http://127.0.0.1:8787/clip/stage-1?k=abc" }),
    "http://127.0.0.1:8787/clip/stage-1?k=abc",
    "给了就原样用（不改写、不重拼）",
  );
  assert.doesNotMatch(stripComments(STAGE), /\/clip\//, "扩展侧不许出现 /clip/ 路径拼接");
  assert.doesNotMatch(stripComments(BACKGROUND), /\/clip\//, "background 不许自己拼 /clip/ 路径");
});

/* ── ⑤ 真回环：POST /v1/clip/stage ─────────────────────────────────────── */

test("A①：真回环 —— 合法资产 200，拿回接口产出的 openUrl", async () => {
  const bridge = await bootstrap();
  try {
    const asset = { name: "ok.png", mime: "image/png", dataBase64: PNG_BYTES.toString("base64") };
    const { request } = buildStageRequest({
      url: "https://example.com/posts/hello",
      title: "本地优先的笔记",
      body: "![图](https://example.com/ok.png)\n\n正文。",
      site: "example.com",
      assets: [asset],
    });
    const call = await postClipStage(bridge.port, bridge.token, request);
    assert.equal(call.kind, "ok", `stage 必须成功，实际 ${call.kind} ${call.code || ""} ${call.serverMessage || ""}`);
    assert.equal(call.result.stageId, bridge.stages[0].stageId, "stageId 必须由接口产出");
    assert.match(call.result.openUrl, /^http:\/\/127\.0\.0\.1:\d+\/clip\//, "openUrl 必须指向本地接口的 /clip/<stageId>");
    const posted = bridge.requests.find((item) => item.path === "/v1/clip/stage");
    assert.ok(posted, "mock 必须收到过 /v1/clip/stage");
    assert.equal(posted.authorization, `Bearer ${bridge.token}`, "必须带 Bearer 长期令牌");
    assert.equal(posted.query, "", "令牌绝不进 URL query");
    assert.deepEqual(bridge.stages[0].payload, request, "服务端收到的就是扩展发的那一份");
  } finally {
    await bridge.close();
  }
});

test("A①：真回环 —— 桥按 02 §2.5 校验：{url,alt} 必被 422 拒（真缺陷的探针复现）", async () => {
  const bridge = await bootstrap();
  try {
    const call = await postClipStage(bridge.port, bridge.token, {
      spec: "opennote.clip/v1",
      url: "https://example.com/p",
      title: "t",
      body: "b",
      selection: false,
      tags: [],
      source: { site: null, author: null, publishedAt: null },
      assets: [{ url: "https://example.com/a.png", alt: "x" }],
    });
    assert.notEqual(call.kind, "ok", "桥必须拒掉信封里不存在的资产形状");
    assert.equal(call.http, 422);
    assert.equal(call.code, "IMP-4003");
  } finally {
    await bridge.close();
  }
});

test("A①：真回环 —— 接口没回 openUrl 时，扩展侧取到的是 null（据此不打开页面）", async () => {
  const bridge = await bootstrap({ mode: "stage-no-open-url" });
  try {
    const { request } = buildStageRequest({ url: "https://example.com/p", title: "t", body: "b" });
    const call = await postClipStage(bridge.port, bridge.token, request);
    assert.equal(call.kind, "ok", "接口本身是成功的（只是没给 openUrl）");
    assert.equal(openUrlOf(call.result), null, "没有 openUrl 就必须是 null —— 打开一个坏页面比失败更糟");
  } finally {
    await bridge.close();
  }
});

test("A①：**真桥**（electron/bridge.cjs）—— 02 §5.9.2 的**顶层成功体**必须被客户端认出来", async () => {
  /*
   * 这条是**跨模块集成**，不是替身：起的是仓库里真的 `electron/bridge.cjs`，
   * 打的是扩展里真的 `postClipStage()`。
   *
   * 为什么必须有它（真机实测踩过）：真桥的成功体是**顶层字段**
   * `{ok:true, stageId, expiresAt, openUrl}`（02 §5.9.2 冻结），
   * 而 `normalizeCall()` 只认 `{ok:true, result:{…}}` ⇒ 这条 200 被判成
   * 「2xx 但没有 result」→ `codeFromHttp(200)` → `IMP-4014`
   * ⇒ 用户点入口按钮看到「导入时出现了内部错误，已记录日志。请重试一次。」，**而桥其实成功了**。
   *
   * 为什么原来的门禁全绿：mock 桥当时按**客户端的期待**发 `{ok,result}` —— 替身照期待写，
   * 就永远测不出形状对不上。现在 mock 已改成契约形状，这条再直接咬真桥。
   */
  const requireCjs = createRequire(import.meta.url);
  const { createBridge } = requireCjs("../../electron/bridge.cjs");
  const dataDir = mkdtempSync(join(tmpdir(), "opennote-ext-real-bridge-"));
  const bridge = createBridge({
    dataDir,
    log: () => undefined,
    getWindow: () => ({ id: 1 }),
    isEnabled: () => true,
    getWorkspaceInfo: () => ({ open: true, name: "临时笔记本" }),
    getFolders: () => ["归档"],
    getInboxEnabled: () => true,
    onEnvelope: async () => ({ ok: true, result: { status: "created", path: "x.md" } }),
  });
  bridge.regenerateToken();
  await bridge.start();
  try {
    const { request } = buildStageRequest({ url: "https://example.com/p", title: "t", body: "b" });
    const call = await postClipStage(bridge.getListeningPort(), bridge.getSessionPlaintext(), request);
    assert.equal(call.kind, "ok", `真桥的成功体必须被认出来，实际 ${call.kind} ${call.code || ""}`);
    assert.ok(call.result, "必须归一出 result");
    assert.match(call.result.openUrl, /^http:\/\/127\.0\.0\.1:\d+\/clip\//, "openUrl 必须来自接口");
    assert.ok(call.result.stageId, "stageId 必须来自接口");
  } finally {
    await bridge.stop().catch(() => undefined);
  }
});

test("A①：真回环 —— 没有令牌时 stage 被拒（401），扩展侧拿到可读的码", async () => {
  const bridge = await bootstrap({ mode: "auth-required" });
  try {
    const { request } = buildStageRequest({ url: "https://example.com/p", title: "t", body: "b" });
    const call = await postClipStage(bridge.port, bridge.token, request);
    assert.notEqual(call.kind, "ok");
    assert.equal(call.code, "IMP-2001");
  } finally {
    await bridge.close();
  }
});

/* ── ⑥ 接线：谁发、谁收、失败/降级时是否静默 ─────────────────────────── */

test("A：popup 走 background 的 opennote:clip-stage（popup 不自己发请求、不碰桥的凭据）", () => {
  const popupCode = stripComments(POPUP);
  assert.match(POPUP, /type: "opennote:clip-stage"/, "popup 必须发这条消息");
  assert.doesNotMatch(popupCode, /fetch\(/, "popup 不许自己发请求（桥调用全部在 service worker 里）");
  assert.doesNotMatch(popupCode, /Authorization|Bearer/, "popup 不许构造鉴权头（令牌只在 background 里用）");
  assert.match(POPUP, /imageDownload,/, "开关状态必须随消息一起发出");
  assert.match(BACKGROUND, /case "opennote:clip-stage":/, "background 必须收这条消息");
  assert.match(BRIDGE, /export async function postClipStage\(port, token, payload, options = \{\}\)/, "bridge.js 必须导出 postClipStage");
  assert.match(BRIDGE, /endpointOf\(port, "\/v1\/clip\/stage"\)/, "必须打到 /v1/clip/stage");
  assert.match(BRIDGE, /headers: authHeaders\(token\)/, "必须复用同一套鉴权头（Bearer + X-Opennote-Token）");
});

/*
 * 令牌不对时必须**能重粘**，而且**不许靠删掉用户存的令牌**来实现。
 *
 * 真实现场（0.3.3，用户实测点入口报错）：后台在 IMP-2001/IMP-2002 时把令牌删掉，只为让
 * popup 显示粘贴框；而 ㊴ 的承诺是「长期有效、随时可复制」。更糟的是 `discover()` 是
 * 8787–8796 **顺序探测命中即停** —— 只要有一个「同形状但不是同一实例」的桥在别的端口
 * （例如诊断夹具），一次误判就会把用户的配置毁掉。
 */
test("令牌不对：露出输入框让用户重粘，但**不删**已存的令牌", () => {
  const popupCode = stripComments(POPUP);
  const backgroundCode = stripComments(BACKGROUND);
  assert.match(POPUP, /function tokenInputBlock\(force = false\)/, "tokenInputBlock 必须支持「强制露出输入框」");
  assert.match(
    POPUP,
    /plan\.tokenInput\) box\.appendChild\(tokenInputBlock\(true\)\)/,
    "「这次错误就是令牌不对」时必须强制露出输入框（否则用户卡在只读视图上没法重粘）",
  );
  /*
   * 关键的一条：**`force` 必须真的参与判断**。
   *
   * 第一版只断言了调用点（`tokenInputBlock(true)` 存在），于是把函数体里的
   * `const needInput = force || !hasToken;` 改回 `!hasToken`（= 完全忽略 force）时，
   * 四条断言全绿 —— 守卫恒绿。是变异自检 M2 把它抓出来的：
   * **守卫的价值不在它被写出来，而在它被证明能红。**
   */
  assert.match(
    POPUP,
    /const needInput = force \|\| !hasToken;/,
    "force 必须参与显示判断（只断言调用点等于没断言）",
  );
  assert.doesNotMatch(
    popupCode,
    /tokenInputRow\.hidden = hasToken;/,
    "不许退回「只按有没有存过令牌决定显示」的旧写法",
  );
  // 反面：剪藏暂存那条失败路径里，不许再出现「删令牌」这个副作用。
  const stageHandler = backgroundCode.slice(backgroundCode.indexOf("async function stageClipForWeb("));
  const handlerBody = stageHandler.slice(0, stageHandler.indexOf("\n}\n"));
  assert.doesNotMatch(handlerBody, /token:\s*null/, "stage 失败不许删掉用户存的令牌（改成保留 + 提示重粘）");
  assert.match(popupCode, /tokenInputBlock\(true\)/, "popup 里必须真的用到强制形态");
});

test("A：成功才打开页面；失败先 return（不打开页面）+ 如实显示原因", () => {
  const start = POPUP.indexOf("async function openClipWeb(");
  assert.ok(start > -1, "找不到 openClipWeb()");
  const body = POPUP.slice(start, POPUP.indexOf("\n}", start));
  const createIndex = body.indexOf("chrome.tabs.create");
  const failIndex = body.indexOf("renderBlockReply(");
  assert.ok(createIndex > -1, "成功路径必须调用 chrome.tabs.create");
  assert.ok(failIndex > -1, "失败路径必须给用户一句可读的原因（不许静默）");
  assert.ok(failIndex < createIndex, "失败分支必须在打开页面**之前**返回");
  assert.match(body, /if \(!reply \|\| !reply\.ok \|\| !reply\.openUrl\)[\s\S]*?return;/, "失败分支必须真的 return");
  assert.match(body, /chrome\.tabs\.create\(\{ url: reply\.openUrl \}\)/, "打开的必须是接口返回的 openUrl（不是自己拼的地址）");
  // 有 warnings（图片降级）时不许静默打开：先把说明摆出来，由用户点「打开编辑页」
  assert.match(body, /if \(warnings\.length\)[\s\S]*?plan\.primary = \{ label: "打开编辑页"/, "降级说明必须先给用户看");
  assert.match(BACKGROUND, /const openUrl = openUrlOf\(result\);/, "background 必须经 openUrlOf 取 openUrl");
  assert.match(BACKGROUND, /本地接口没有返回可打开的页面地址。/, "缺席时要有可读原因");
});

test("A：入口恢复渲染 —— CLIP_WEB_READY = true，且只在有网址时渲染", () => {
  const start = POPUP.indexOf("function previewNode()");
  const pv = POPUP.slice(start, POPUP.indexOf("\nfunction ", start + 10));
  assert.match(pv, /const CLIP_WEB_READY = true;/, "A 已上线，开关必须是 true（自认欠账的那条变异红就盯它）");
  assert.match(pv, /CLIP_WEB_READY && \(\(ex && ex\.url\)/, "渲染条件必须被该开关短路");
  assert.match(pv, /if \(openTarget\) \{/, "无网址时不渲染（不画死按钮）");
  assert.match(pv, /iconExternal\(\)/, "图标必须是内联 SVG（不是 emoji）");
  assert.doesNotMatch(stripComments(pv), /clip\/clip\.html/, "旧的插件内可编辑页已被网页版取代，入口不许再指回它");
});

/* ── ⑧ ① 夜版帧：两半缺一不可（src 层；产物层的判据在 verify 的 V14） ──────── */

test("① 夜版帧的两半：build.mjs 搬运根属性选择器 + picker.js 把页面主题镜像到宿主", () => {
  const build = read("build.mjs");
  const picker = read("src", "content", "picker.js");
  // 半一（构建期）：`[data-theme="night"]` 这类**根属性选择器**要机械改写成 `:host(...)`。
  // 影子根匹配不到影子树外面的祖先 —— 不改写，夜版永远只有亮色一套值（31744 那件事的真因）。
  // 判据用**逐字子串**（不用花哨正则：上一版把 `[a-z-]` 写成 `[a-z]`，于是产品正确却红了）。
  assert.ok(build.includes("attributeHits"), "build.mjs 必须统计改写处数（构建日志里能看见搬了多少处）");
  assert.ok(build.includes(":host(${match})"), "build.mjs 必须把根属性选择器包成 :host(...)");
  assert.ok(build.includes('data-[a-z-]+="[^"]*"'), "改写的是根属性选择器（[data-…]）");
  // 半二（运行时）：宿主元素要带上页面根的那几个属性，否则 `:host([data-theme=…])` 永不匹配
  assert.match(picker, /for \(const name of \["data-theme", "data-accent", "data-font", "data-width"\]\)/, "picker 必须镜像页面主题属性");
  assert.match(picker, /host\.setAttribute\(name, value\)/, "镜像要真的写到宿主元素上");
  // ㉝ 的红线在这里也成立：镜像只写**我们自己创建的**节点，不碰页面已有节点
  assert.doesNotMatch(stripComments(picker), /documentElement\.(setAttribute|classList|style)/, "不许改页面根节点");
  assert.doesNotMatch(stripComments(picker), /document\.body\.style/, "不许改页面 body 的样式");
});

/* ── ⑦ 旧页与它的路由必须成对消失 ─────────────────────────────────────── */

test("A：被取代的插件内可编辑页已删除，且没有留下死路由", () => {
  assert.ok(!existsSync(join(ROOT, "src", "clip")), "src/clip/ 必须整目录删掉");
  assert.ok(!existsSync(join(ROOT, "tests", "clip-page.test.mjs")), "它的旧测试也必须删掉");
  for (const [name, text] of [["popup.js", POPUP], ["background.js", BACKGROUND]]) {
    const code = stripComments(text);
    assert.doesNotMatch(code, /clip\/clip\.html/, `${name} 还引用着已删除的 clip.html`);
    assert.doesNotMatch(code, /tabById/, `${name} 还留着只被旧页使用的 tabId 路由`);
    assert.doesNotMatch(code, /\?tabId=/, `${name} 还留着 ?tabId= 路由`);
  }
  assert.ok(!existsSync(join(ROOT, "dist", "clip")), "产物里也不许再有 dist/clip/**（先跑 node build.mjs）");
});
