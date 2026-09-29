/**
 * 本地桥 mock（零依赖，`node:http`）。
 *
 * 两个用途，都写进 README 的复现步骤里：
 *  1. **人为构造** 6 态连接状态与全部降级路径——不必等桌面版 Opennote / C3 的真桥；
 *  2. `tests/bridge.test.mjs` 的集成靶机（端口发现、令牌、幂等、错误码映射都在真回环上跑）。
 *
 * 它按 docs/import/02-interface 的字段与错误码实现了一个**故意严格**的子集：
 *  - 扩展一旦发了 `conflict: "overwrite"`、缺 `capturedAt`、`spec` 不对、标签带逗号，
 *    mock 都会如实报告（测试会断言这些情况一次都没发生）；
 *  - 令牌、配对码错误分别回 401 `IMP-2002` / `IMP-2001` / `IMP-2004`，
 *    并且响应体里**不含** `opn_`（02 §10 的 S-06 断言）。
 *
 * CLI：
 *   node tools/mock-bridge.mjs --mode healthy --port 8787 --code 482913
 *   node tools/mock-bridge.mjs --mode no-window      # 桥在跑但窗口不在场 → IMP-4006
 *   node tools/mock-bridge.mjs --mode foreign        # 端口有程序监听但不是 Opennote → 端口被占用
 *   node tools/mock-bridge.mjs --mode starting       # 端口已绑定但接口没就绪（答得比 300ms 慢）→ 本地接口未开启 + 重试
 *   node tools/mock-bridge.mjs --mode origin-denied  # /v1/health 直接 403 IMP-3001 → 需要配对（绝不能显示已连接）
 *   node tools/mock-bridge.mjs --mode no-workspace   # 没打开笔记本 → IMP-4007
 *   node tools/mock-bridge.mjs --mode folder-denied  # 落点被拒 → IMP-4009
 *   node tools/mock-bridge.mjs --mode rate-limit     # 第一次 429 IMP-4015
 *   node tools/mock-bridge.mjs --mode auth-required  # 所有请求 401 IMP-2001
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const SPEC = "opennote.import/v1";
export const CLIENT_NAME = "chrome-extension";

/**
 * `/demo`：一个「像真实文章页」的样张，用来在真机浏览器里验证正文抽取与浮标定位
 * （含导航/侧栏/页脚噪点、og 元信息、发布时间、中英混排段落）。
 */
export const DEMO_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>中文排版指北 · 示例站</title>
<meta property="og:title" content="中文排版指北">
<meta property="og:site_name" content="示例站">
<meta name="author" content="小林">
<meta property="article:published_time" content="2026-09-20T10:00:00+08:00">
<style>body{font-family:system-ui;margin:0}header,nav,aside,footer{background:#eee;padding:8px}main{max-width:640px;margin:0 auto;padding:16px}</style>
</head><body>
<header><nav>首页 · 目录 · 关于 · 订阅</nav></header>
<main>
<article>
<h1>中文排版指北</h1>
<p>这是第一段正文。中文与 English 混排时，标点与空格的关系值得说明。</p>
<p>这是第二段正文，包含一个<a href="https://example.com/inline">行内链接</a>与<code>inline code</code>。</p>
<h2>标点与空格</h2>
<ul><li>中文之间不加空格</li><li>这是第二个列表项</li></ul>
<blockquote><p>引用的段落也应该被保留下来。</p></blockquote>
<pre><code>const x = 1;
console.log(x);</code></pre>
<table><thead><tr><th>项目</th><th>说明</th></tr></thead><tbody><tr><td>空格</td><td>中西文之间</td></tr></tbody></table>
<p>最后一段正文，用来确认末尾段落没有丢失。</p>
</article>
</main>
<aside>相关阅读 · 热门标签 · 广告位</aside>
<footer>版权所有 © 示例站 · 备案号 · 隐私政策</footer>
</body></html>`;

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * 与真接收端 `src/lib/clip/frontmatter.ts:97 downgradeLeadingH1()` 同口径：
 * 正文首个非空行若已是 H1，降级为 H2（保证整篇只有一个 H1，`deriveTitle()` 才读得对）。
 * 插件抽取的正文会带自己的 H1，所以这一步不是可选项。
 */
function downgradeLeadingH1(body) {
  const lines = String(body).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (/^#\s+\S/.test(lines[i])) lines[i] = `#${lines[i]}`;
    break;
  }
  return lines.join("\n");
}

export function makeToken(random = Math.random) {  let body = "";
  for (let i = 0; i < 43; i += 1) body += TOKEN_ALPHABET[Math.floor(random() * TOKEN_ALPHABET.length)];
  return `opn_${body}`;
}

export function errorBody(code, message, userMessage, extra = {}) {
  return {
    ok: false,
    error: { code, message, userMessage, retryable: Boolean(extra.retryable), ...extra },
  };
}

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const TAG_RE = /^[\p{L}\p{N}_\-/]+$/u;

/**
 * @param {object} options
 * @param {string} [options.mode] healthy | no-window | foreign | starting | origin-denied | no-workspace | folder-denied | rate-limit | auth-required
 * @param {number} [options.port] 0 = 随机空闲端口
 * @param {string} [options.token] 认的令牌（默认随机生成）
 * @param {string} [options.code] 6 位配对码（默认 482913）
 * @param {string} [options.defaultFolder]
 * @param {string} [options.outDir] 落盘目录（默认 os.tmpdir()/opennote-mock-notes）
 * @param {boolean} [options.log] 是否打印请求日志
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startMockBridge(options = {}) {
  const mode = options.mode || "healthy";
  const token = options.token || makeToken();
  const code = options.code || "482913";
  const defaultFolder = options.defaultFolder || "剪藏";
  const outDir = options.outDir || join(tmpdir(), "opennote-mock-notes");
  const log = options.log !== false;

  const state = {
    mode,
    token,
    code,
    port: null,
    started: Date.now(),
    // 「正在启动」模式的时间基准（MOCK_STARTING_MS 之后接口才就绪）
    startedAt: Date.now(),
    imports: [],
    pairs: [],
    rejections: [],
    // 判定链轨迹（created / appended / pending / duplicate / deduped），测试直接断言它
    judgment: [],
    pending: [],
    unknownFieldsSeen: [],
    tagsViolations: [],
    wrotePaths: [],
    requests: [],
  };

  function classifyTags(tags) {
    // 服务端口径：含逗号/换行/[] 或纯数字 → 丢弃 + warning（不尝试替用户改标签）
    const kept = [];
    const violations = [];
    for (const raw of Array.isArray(tags) ? tags : []) {
      const tag = String(raw);
      const bad =
        tag.includes(",") ||
        /[\r\n]/.test(tag) ||
        tag.includes("[") ||
        tag.includes("]") ||
        /^\d+$/.test(tag) ||
        tag.length > 32 ||
        !TAG_RE.test(tag);
      if (bad) violations.push(tag);
      else kept.push(tag);
    }
    return { kept, violations };
  }

  function validateEnvelope(envelope, path) {
    if (!envelope || typeof envelope !== "object") {
      return errorBody("IMP-3002", "body is not an object", "导入内容不是有效的 JSON，请重试。");
    }
    const allowed = [
      "spec", "importId", "title", "body", "source", "target", "conflict", "tags", "assets", "client",
    ];
    for (const key of Object.keys(envelope)) {
      if (!allowed.includes(key)) state.unknownFieldsSeen.push(key);
    }
    if (envelope.spec !== SPEC) {
      return errorBody("IMP-4002", "spec mismatch", "这个客户端版本太旧（或太新），请更新后再试。");
    }
    if (typeof envelope.importId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(envelope.importId)) {
      return errorBody("IMP-4003", "importId invalid", "导入内容缺少必要信息（标题、来源时间或地址），请重试。");
    }
    if (typeof envelope.title !== "string" || !envelope.title.trim() || envelope.title.length > 200) {
      return errorBody("IMP-4003", "title invalid", "导入内容缺少必要信息（标题、来源时间或地址），请重试。");
    }
    if (typeof envelope.body !== "string") {
      return errorBody("IMP-4003", "body invalid", "导入内容缺少必要信息（标题、来源时间或地址），请重试。");
    }
    const source = envelope.source || {};
    if (!ISO_WITH_TZ.test(String(source.capturedAt || ""))) {
      return errorBody("IMP-4003", "source.capturedAt missing/invalid", "导入内容缺少必要信息（标题、来源时间或地址），请重试。");
    }
    if (source.url !== null && source.url !== undefined && !/^https?:$/.test(safeProtocol(source.url))) {
      return errorBody("IMP-4003", "source.url scheme not allowed", "导入内容缺少必要信息（标题、来源时间或地址），请重试。");
    }
    // `conflict` 是**可选键**：缺省 = 客户端没有指定策略，交给接收端判定链
    // （第 3 步选区二次剪藏 → appended；第 4 步整页二次剪藏 → 收件箱 pending）。
    // 与真接收端 src/lib/clip/envelope.ts 的 `conflictExplicit` 同口径：
    // 只有**显式**给了值才走「显式策略」分支；`undefined` / `null` 都算缺省。
    const explicitConflict = envelope.conflict === undefined || envelope.conflict === null ? null : String(envelope.conflict);
    if (explicitConflict === "overwrite") {
      // 02 §5.2：本契约的本地桥只在「用户显式开启的进阶开关」下接受 overwrite；
      // 浏览器插件**一律不发**。mock 见到就报错，测试据此断言扩展的行为。
      return errorBody("IMP-4001", "conflict overwrite is not accepted from extension clients", "导入内容格式不正确。");
    }
    if (explicitConflict !== null && !["new", "append", "skip"].includes(explicitConflict)) {
      return errorBody("IMP-4001", "conflict invalid", "导入内容格式不正确。");
    }
    if (envelope.client && envelope.client.name !== CLIENT_NAME) {
      return errorBody("IMP-4001", `client.name must be ${CLIENT_NAME}`, "导入内容格式不正确。");
    }
    if (mode === "folder-denied" && envelope.target && envelope.target.folder) {
      return errorBody(
        "IMP-4009",
        "target folder cannot be created",
        "找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。",
      );
    }
    void path;
    return null;
  }

  function safeProtocol(url) {
    try {
      return new URL(String(url)).protocol;
    } catch {
      return "invalid:";
    }
  }

  const server = createServer(async (request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      const url = new URL(request.url, `http://127.0.0.1:${state.port}`);
      const path = url.pathname;
      state.requests.push({
        method: request.method,
        path,
        query: url.search,
        authorization: request.headers.authorization || null,
        xOpennoteToken: request.headers["x-opennote-token"] || null,
        contentType: request.headers["content-type"] || null,
        origin: request.headers.origin || null,
        host: request.headers.host || null,
      });
      const raw = Buffer.concat(chunks).toString("utf8");
      if (log) process.stdout.write(`[mock:${mode}] ${request.method} ${path} ${size}B\n`);
      const send = (status, payload, headers = {}) => {
        const body = typeof payload === "string" ? payload : JSON.stringify(payload);
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
        response.end(body);
      };

      if (mode === "foreign") {
        send(200, { hello: "not opennote" });
        return;
      }
      if (request.method === "GET" && path === "/demo") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(DEMO_PAGE);
        return;
      }
      // 「正在启动」：端口已绑定但接口还没就绪，/v1/health 答得比插件 300ms 探测预算还慢。
      // 复现应用侧「正在启动」这一态：插件必须如实说「本地接口未开启」+重试，绝不能显示「已连接」。
      if (mode === "starting" && Date.now() - state.startedAt < Number(process.env.MOCK_STARTING_MS || 4000)) {
        await sleep(600);
        send(200, { ok: true, result: { bridge: "starting", spec: SPEC } });
        return;
      }
      if (mode === "no-window") {
        send(409, errorBody("IMP-4006", "renderer not available", "Opennote 的窗口已关闭。请重新打开 Opennote，再试一次。", { retryable: true }));
        return;
      }
      // 「来源未被信任」：02 §5.2.4 第 2 道闸门，403 IMP-3001。插件只能显示「需要配对」，
      // 绝不能显示「已连接」（Lead 硬要求）。
      if (mode === "origin-denied") {
        send(403, errorBody("IMP-3001", "origin not allowed", "（不显示给用户，仅进设置面板拒绝日志）来源未被允许。", { retryable: false }));
        return;
      }
      if (mode === "rate-limit" && !state.rateLimited) {
        state.rateLimited = true;
        send(429, errorBody("IMP-4015", "too many requests", "导入太频繁了，请稍等几秒再试。", { retryable: true }), { "Retry-After": "1" });
        return;
      }

      if (request.method === "GET" && path === "/v1/health") {
        send(200, {
          ok: true,
          result: {
            bridge: "running",
            spec: SPEC,
            app: "opennote-mock",
            port: state.port,
            workspace: mode === "no-workspace" ? { open: false, name: null } : { open: true, name: "模拟笔记本" },
            inbox: { enabled: false, pending: 0 },
            authRequired: true,
            time: new Date().toISOString(),
          },
        });
        return;
      }

      const auth = request.headers.authorization || "";
      const headerToken = request.headers["x-opennote-token"];
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : headerToken;

      if (path === "/v1/pair" && request.method === "POST") {
        let payload = null;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          send(400, errorBody("IMP-3002", "bad json", "导入内容不是有效的 JSON，请重试。"));
          return;
        }
        state.pairs.push({ code: payload.code, client: payload.client, origin: request.headers.origin || null });
        if (String(payload.code || "") !== code) {
          send(401, errorBody("IMP-2004", "pair code invalid", "配对码不正确或已过期，请在 Opennote 里重新生成。"));
          return;
        }
        send(200, {
          ok: true,
          result: { token, spec: SPEC, endpoint: `http://127.0.0.1:${state.port}`, origin: request.headers.origin || null },
        });
        return;
      }

      if (mode === "auth-required" || !presented) {
        send(401, errorBody("IMP-2001", "missing token", "这个客户端还没有配对。请在 Opennote 的「导入与接口」里点「配对新客户端」，输入显示的 6 位配对码。"));
        return;
      }
      if (presented !== token) {
        // 02 §10 S-06：401 响应体不得含 "opn_"
        send(401, errorBody("IMP-2002", "token mismatch", "访问令牌不正确或已失效。重新生成令牌后，请在客户端里更新。"));
        return;
      }

      if (request.method === "GET" && path === "/v1/workspace") {
        send(200, {
          ok: true,
          result: {
            open: mode !== "no-workspace",
            name: mode === "no-workspace" ? null : "模拟笔记本",
            backend: "node",
            defaultFolder,
            noteCount: 12,
            inboxEnabled: false,
          },
        });
        return;
      }

      if (request.method === "GET" && path.startsWith("/v1/imports/")) {
        const importId = decodeURIComponent(path.slice("/v1/imports/".length));
        const found = state.imports.find((item) => item.importId === importId);
        if (!found) {
          send(404, errorBody("IMP-4017", "import not found", "没有找到这条导入记录。"));
          return;
        }
        send(200, { ok: true, result: { importId, status: found.status, path: found.path, committedAt: found.committedAt, errors: [] } });
        return;
      }

      if (request.method === "POST" && path === "/v1/import") {
        let envelope = null;
        try {
          envelope = JSON.parse(raw || "null");
        } catch {
          send(400, errorBody("IMP-3002", "bad json", "导入内容不是有效的 JSON，请重试。"));
          return;
        }
        const problem = validateEnvelope(envelope, path);
        if (problem) {
          state.rejections.push(problem.error.code);
          send(problem.error.code === "IMP-4009" ? 422 : 422, problem);
          return;
        }
        const previous = state.imports.find((item) => item.importId === envelope.importId);
        if (previous) {
          state.judgment.push({ step: "deduped", path: previous.path });
          send(200, {
            ok: true,
            result: {
              status: "deduped",
              importId: envelope.importId,
              path: previous.path,
              inboxId: null,
              deduped: true,
              dedupedBy: "importId",
              revertible: true,
              preimage: null,
              assets: [],
              tags: previous.tags,
              warnings: [],
            },
          });
          return;
        }
        const { kept, violations } = classifyTags(envelope.tags);
        if (violations.length) state.tagsViolations.push(...violations);

        // ── 判定链第 2/3/4 步（与 src/lib/clip/receive.ts 同口径）────────────────
        const bodyHash = createHash("sha256").update(String(envelope.body || "")).digest("hex");
        const sourceUrl = envelope.source && envelope.source.url ? envelope.source.url : null;
        const sameUrl = sourceUrl ? state.imports.filter((item) => item.url === sourceUrl) : [];
        const byContent = sameUrl.find((item) => item.bodyHash === bodyHash);
        if (byContent) {
          state.judgment.push({ step: "duplicate", path: byContent.path });
          send(200, {
            ok: true,
            result: {
              status: "duplicate",
              importId: envelope.importId,
              path: byContent.path,
              inboxId: null,
              deduped: true,
              dedupedBy: "contentHash",
              revertible: true,
              preimage: null,
              assets: [],
              tags: byContent.tags,
              warnings: [],
            },
          });
          return;
        }
        const existing = sameUrl.length ? sameUrl[sameUrl.length - 1] : null;
        const explicitConflict =
          envelope.conflict === undefined || envelope.conflict === null ? null : String(envelope.conflict);
        if (existing && explicitConflict === null && envelope.source && envelope.source.selection === true) {
          // 第 3 步：同 URL + 正文变了 + 选区 → 追加到既有笔记
          appendFileSync(existing.filePath, `\n${envelope.body}\n`, "utf8");
          state.judgment.push({ step: "appended", path: existing.path });
          send(200, {
            ok: true,
            result: {
              status: "appended",
              importId: envelope.importId,
              path: existing.path,
              inboxId: null,
              deduped: false,
              dedupedBy: null,
              revertible: true,
              preimage: null,
              assets: [],
              tags: existing.tags,
              warnings: [],
            },
          });
          return;
        }
        if (existing && explicitConflict === null && envelope.source && envelope.source.selection === false) {
          // 第 4 步：同 URL + 正文变了 + 整页 → 进收件箱，等人工确认（不落笔记文件）
          const inboxId = `inbox-${state.pending.length + 1}`;
          state.pending.push({ inboxId, importId: envelope.importId, url: sourceUrl, title: envelope.title });
          state.judgment.push({ step: "pending", inboxId });
          send(202, {
            ok: true,
            result: {
              status: "pending",
              importId: envelope.importId,
              path: null,
              inboxId,
              deduped: false,
              dedupedBy: null,
              revertible: false,
              preimage: null,
              assets: [],
              tags: kept,
              warnings: [],
            },
          });
          return;
        }

        mkdirSync(outDir, { recursive: true });
        const safeTitle = String(envelope.title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
        const relativePath = `${envelope.target && envelope.target.folder ? `${envelope.target.folder}/` : ""}${safeTitle}.md`;
        const filePath = join(outDir, `${safeTitle}.md`);
        const frontMatter = ["---", `source: ${envelope.source && envelope.source.url ? envelope.source.url : ""}`, `opennote_import_id: ${envelope.importId}`, "---", ""].join("\n");
        writeFileSync(filePath, `${frontMatter}# ${envelope.title}\n\n${downgradeLeadingH1(envelope.body)}\n`, "utf8");
        state.wrotePaths.push(filePath);
        const tags = Array.from(new Set([...kept, ...(defaultFolder ? [defaultFolder] : [])]));
        state.imports.push({
          importId: envelope.importId,
          path: relativePath,
          filePath,
          tags,
          url: sourceUrl,
          bodyHash,
          committedAt: new Date().toISOString(),
          envelope,
          status: "created",
        });
        state.judgment.push({ step: "created", path: relativePath });
        send(201, {
          ok: true,
          result: {
            status: "created",
            importId: envelope.importId,
            path: relativePath,
            inboxId: null,
            deduped: false,
            dedupedBy: null,
            revertible: true,
            preimage: null,
            assets: [],
            tags,
            warnings: violations.length ? ["IMP-W007 部分标签不符合规则，已忽略。"] : [],
          },
        });
        return;
      }

      send(404, errorBody("IMP-3005", "route not found", null));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port === undefined ? 0 : options.port, "127.0.0.1", () => {
      state.port = server.address().port;
      if (log) process.stdout.write(`[mock:${mode}] LISTENING http://127.0.0.1:${state.port} token=${token} code=${code}\n`);
      resolve({
        ...state,
        server,
        token,
        code,
        outDir,
        url: `http://127.0.0.1:${state.port}`,
        tokenValue: () => token,
        state,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/* ───────────────────────── CLI ───────────────────────── */

const isMain = process.argv[1] && process.argv[1].endsWith("mock-bridge.mjs");
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const port = Number(arg("port", "8787"));
  const bridge = await startMockBridge({
    mode: arg("mode", "healthy"),
    port,
    code: arg("code", "482913"),
    token: arg("token", undefined),
    outDir: arg("out", join(tmpdir(), "opennote-mock-notes")),
  });
  process.stdout.write(
    [
      "本地桥 mock 已启动。复现步骤见 extension/README.md「6 态逐态复现」。",
      `  endpoint      http://127.0.0.1:${bridge.port}`,
      `  mode          ${bridge.mode}`,
      `  配对码        ${bridge.code}`,
      `  令牌          ${bridge.token}`,
      `  落盘目录      ${bridge.outDir}`,
      "Ctrl+C 退出。",
      "",
    ].join("\n"),
  );
  process.on("SIGINT", async () => {
    await bridge.close();
    process.exit(0);
  });
}
