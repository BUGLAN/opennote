#!/usr/bin/env node
/**
 * 【诊断/设计稿渲染工具 · **不是门禁**】用真实的 `popup.js` / `picker.js` 渲染出截图，
 * 落到 `extension/.shots/`（已 gitignore，不进版本库）。**永远 exit 0**，不作为验收证据引用
 * —— 与 `cdp-pick-check.mjs` / `dist-race-probe.mjs` 同一口径（T-08）：
 * 门禁是 `tests/**` + `verify.mjs`；本工具只产出**人眼看的图**。
 *
 * 为什么要有它：`T-11` 已写死「涉及 action popup 内交互的路径机器不可验」（真机 CDP 里 popup 被节流）。
 * 所以这里的做法是**同一份产品代码、换一个宿主**：
 *   - 把 `dist/popup/popup.html` 原样取来，只把三处引用改成本地 http 路径，并在模块之前
 *     注入一个 `chrome` 替身（`sendMessage` 立即回一份固定快照）⇒ 跑的是**真** popup.js 与真 CSS；
 *   - 元素选择覆盖层同理：静态页 + 真 `dist/content/picker.js` + 派发一次 mousemove。
 * **它不是 action popup 的截图**，这一点写在这里，免得被当成「真机验过了」。
 *
 * 用法：`node tools/popup-shot.mjs [--shots=名字,名字]`
 *   可用镜头：card-page / card-element / card-page-night / card-element-night / card-warn / card-pickfail
 *             card-token / card-token-night / card-token-saved / card-token-before
 *             card-before-page / card-before-element
 *             picker-paper / picker-night / picker-before-paper / picker-before-night
 *
 * `card-token*`（0.3.5）：`?state=needs-pairing` 让替身快照换成「这台客户端还没有配置访问令牌」——
 * 即用户首启看到的现场（令牌块 + IMP-2001 说明块）。`card-token-before` 走 `variant=before`，
 * 用来出一帧「改动前」的对照图（见下）。
 *
 * `card-pickfail`（0.3.3）：点 `选择当前元素` 后接口回一份 `injection_failed` ⇒ 工具条那一行出现
 * 失败说明（`#pickNote`）。用它证明「图片开关**始终**与两个按钮同一行」——这个状态下它最容易被挤下去。
 *
 * `*-before-*` 镜头要用「改动前的那一版代码」，它躺在 `.shots/before/`（gitignore 内，不进版本库）。
 * 重新生成它的命令（**不要手工抄文件**）：
 *   `cmd /c "git archive HEAD extension/src | tar -xf - -C extension/.shots/before"`
 * 那个目录不存在时，`before` 镜头会渲染成缺文件的空页并在报告里报错 —— 这是**故意的**：
 * 宁可出不了图，也不要拿「当前代码」冒充「改动前」。
 *
 * 已知坑（自己踩过，写在这里免得下一个人再踩）：
 *   - **不能用 `spawnSync`**：它堵住本进程的事件循环，而静态服务就在这个进程里 ——
 *     Chrome 会一直等不到响应，卡到超时（file:// 495ms 成功、http:// 30s 超时，变量只差「谁在应答」）；
 *   - 每次给一个**独立的 `--user-data-dir`**，否则 headless 会去挂到本机已在跑的 Chrome 上。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, ".shots");
const BEFORE = join(SHOTS, "before", "extension", "src");
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];
const chrome = CHROME_CANDIDATES.find((path) => path && existsSync(path));
if (!chrome) {
  process.stdout.write("找不到 Chrome，无法出图（本工具不是门禁，退出 0）。\n");
  process.exit(0);
}
mkdirSync(SHOTS, { recursive: true });

/* ────────────────────────── 夹具正文（含所有要看的块） ────────────────────────── */

const ARTICLE = [
  "# 写给工程师的本地优先笔记",
  "",
  "**本地优先**不是口号，是一种把「文件属于你」放在第一位的取舍。",
  "",
  "| 后端 | 落盘方式 | 权限 |",
  "| --- | --- | --- |",
  "| Electron | 直接写磁盘 | 完整 |",
  "| 浏览器 | File System Access | 需授权 |",
  "",
  "## 为什么",
  "",
  "```js",
  "const note = await open(\"note.md\");",
  "```",
  "",
  "- 第一条",
  "- 第二条",
  "",
  "> 引用一行。",
  "",
  "---",
  "",
  "收尾一段。",
].join("\n");

const PICKED = ["## 只剪这一段", "", "被点中的那块正文，与整页提取不是同一份内容。"].join("\n");

/** popup 的 `chrome` 替身 + 固定快照（必须**在模块之前**以经典脚本运行）。 */
function popupStub(mode, theme, stage, click, pickfail, state) {
  const snapshot = `
    const extraction = {
      url: "https://example.com/posts/local-first",
      pageTitle: "写给工程师的本地优先笔记",
      site: "example.com",
      author: "张三",
      publishedAt: "2026-08-14T09:30:00+08:00",
      article: { title: "写给工程师的本地优先笔记", markdown: ARTICLE, chars: ARTICLE.length },
      images: { items: [{ url: "https://cdn.example.com/a.png", alt: "图" }, { url: "https://cdn.example.com/b.png", alt: "" }], dropped: 0 },
      selection: { present: false, markdown: "", chars: 0, ancestorTitle: null }
    };
    const snapshot = {
      ok: true,
      tab: { id: 1, url: extraction.url, title: extraction.pageTitle },
      extraction,
      restricted: false,
      extractionFailed: false,
      stateId: STATE,
      inbox: true,
      pickedElement: MODE === "element" ? { tagName: "article", selector: "article", chars: 120, isIframe: false } : null,
      pickArmed: false,
      settings: { hasToken: STATE !== "needs-pairing", tokenTail: STATE === "needs-pairing" ? "" : "pvr4", mode: MODE, pendingCount: 0, folder: "", tags: [], notePaths: [] }
    };`;
  return `<script>
(() => {
  const MODE = ${JSON.stringify(mode)};
  const STATE = ${JSON.stringify(state || "connected")};
  const ARTICLE = ${JSON.stringify(ARTICLE)};
  const PICKED = ${JSON.stringify(PICKED)};
  ${snapshot}
  window.__shot = { mode: MODE, created: [] };
  if (${JSON.stringify(theme)} === "night") {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => (String(query).includes("prefers-color-scheme")
      ? { matches: true, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
      : original(query));
  }
  const IMAGES = { items: extraction.images.items, dropped: 0 };
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.1.4" }),
      getURL: (path) => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/" + path,
      sendMessage: (message, callback) => {
        let reply;
        switch (message && message.type) {
          case "opennote:load":
          case "opennote:retry":
            reply = snapshot;
            break;
          case "opennote:preview":
            reply = { ok: true, preview: { mode: message.mode, title: extraction.article.title, pickedElement: { tagName: "article", markdown: PICKED }, images: IMAGES } };
            break;
          case "opennote:clip-stage":
            reply = { ok: true, reply: ${JSON.stringify(stage)} === "warn"
              ? { ok: true, openUrl: "http://127.0.0.1:8787/clip/stage-1?k=k1", warnings: ["图片没能下载（没有权限、跨站限制或网络不可达），正文里保留原始网址：https://cdn.example.com/b.png"] }
              : { ok: true, openUrl: "http://127.0.0.1:8787/clip/stage-1?k=k1", warnings: [] } };
            break;
          case "opennote:pick":
            /*
             * 点选失败（诊断镜头 card-pickfail 用）：popup 会把四因分离的文案写进 #pickNote、把
             * chrome.scripting 的原文写进 #pickDetail —— 这是**唯一**还能让工具条那一行多出一行的状态
             * （这段注释在模板字符串里，所以不写反引号）。0.3.3 的「图片开关始终与两个按钮同一行」
             * 必须在这个状态下也成立（用户第二张真机截图就是这个现场）。
             */
            reply = { ok: true, reply: ${JSON.stringify(pickfail)}
              ? { ok: false, reason: ${JSON.stringify(pickfail)} === "all" ? "injection_failed" : ${JSON.stringify(pickfail)}, detail: "Error: Cannot access contents of the page. Extension manifest must request permission to access this host." }
              : { ok: true } };
            break;
          default:
            reply = { ok: true, reply: { ok: true } };
        }
        if (typeof callback === "function") setTimeout(() => callback(reply), 0);
      }
    },
    tabs: { create: (info) => { window.__shot.created.push(info); } }
  };
  if (${JSON.stringify(click)} === "open") {
    setTimeout(() => {
      const button = document.getElementById("openEditable");
      if (button) button.click();
    }, 300);
  }
  if (${JSON.stringify(click)} === "pick") {
    setTimeout(() => {
      const button = document.getElementById("pick");
      if (button) button.click();
    }, 300);
  }
  /* 插件设置（⋯ → 插件设置）：S30 的令牌只读回显只在这个视图里出现，所以必须能拍它。 */
  if (${JSON.stringify(click)} === "settings") {
    setTimeout(() => {
      const more = document.getElementById("more");
      if (more) more.click();
      const item = document.querySelector('[data-action="settings"]');
      if (item) item.click();
    }, 300);
  }
})();
</script>`;
}

/** 把真 popup.html 的三处引用改成 http 路径（其余一字不动）。 */
function popupDocument(query) {
  const mode = query.get("mode") || "page";
  const theme = query.get("theme") || "paper";
  const stage = query.get("stage") || "ok";
  const click = query.get("click") || "";
  const pickfail = query.get("pickfail") || "";
  const state = query.get("state") || "connected";
  const before = query.get("variant") === "before";
  const html = readFileSync(before ? join(BEFORE, "popup", "popup.html") : join(DIST, "popup", "popup.html"), "utf8");
  const base = before ? "/before" : "/dist";
  return html
    .replace('href="../styles/tokens.css"', `href="${base}/styles/tokens.css"`)
    .replace('href="popup.css"', `href="${base}/popup/popup.css"`)
    .replace(
      '<script type="module" src="popup.js"></script>',
      `${popupStub(mode, theme, stage, click, pickfail, state)}<script type="module" src="${base}/popup/popup.js"></script>`,
    )
    .replace("<html lang=\"zh-CN\" data-theme=\"paper\" data-accent=\"seal\">", `<html lang="zh-CN" data-theme="${theme}" data-accent="seal">`);
}

/**
 * 元素选择覆盖层的静态页。`variant=before` 时把本轮两处修复**逆向**回去：
 *   ① 注入 CSS 里的 `:host([data-…])` 还原成裸属性选择器；
 *   ② 去掉宿主元素上的主题镜像。
 * 这样就能在同一台机器上复现「修复前两帧字节完全相同」这件事。
 */
function pickerDocument(query) {
  const theme = query.get("theme") || "paper";
  const before = query.get("variant") === "before";
  const picker = readFileSync(join(DIST, "content", "picker.js"), "utf8");
  const processed = before
    ? picker
        .replace(/:host\((\[data-[^)]*\])\)/g, "$1")
        .replace(/\n  for \(const name of \["data-theme", "data-accent", "data-font", "data-width"\]\) \{[\s\S]*?\n  \}/, "")
    : picker;
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}" data-accent="seal">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/dist/styles/tokens.css">
<style>
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--font-ui); }
  main { max-width: 720px; margin: 0 auto; padding: 40px 32px; }
  .card { padding: 18px; margin: 18px 0; border: 1px solid var(--rule); border-radius: var(--radius); background: var(--paper-2); }
</style>
</head>
<body>
<main>
  <h1>示例文章</h1>
  <p>这一页只是覆盖层的宿主页面：一张纸、几块内容，用来拍「hover 到某一块」时的蒙层与轮廓。</p>
  <div class="card" id="target"><h2>被 hover 的那一块</h2><p>覆盖层应当把这一块留成「洞」，四周压暗。</p></div>
  <p>页面其余部分。</p>
</main>
<script>window.chrome = { runtime: { sendMessage() {} } };</script>
<script>${processed.replace(/<\/script>/gi, "<\\/script>")}</script>
<script>
  const target = document.getElementById("target");
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + 24, clientY: rect.top + 24 }));
</script>
</body>
</html>`;
}

/* ────────────────────────── 静态服务 ────────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function sendFile(response, file) {
  if (!existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  response.end(readFileSync(file));
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/popup-harness.html") {
    response.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
    response.end(popupDocument(url.searchParams));
    return;
  }
  if (url.pathname === "/picker-harness.html") {
    response.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
    response.end(pickerDocument(url.searchParams));
    return;
  }
  // 目录穿越防护：解析后的路径必须仍在这两个根之下
  for (const [prefix, base] of [["/dist/", DIST], ["/before/", BEFORE]]) {
    if (!url.pathname.startsWith(prefix)) continue;
    const target = normalize(join(base, url.pathname.slice(prefix.length)));
    if (relative(base, target).startsWith("..")) break;
    sendFile(response, target);
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("not found");
});

/* ────────────────────────── 出图 ────────────────────────── */

const SHOT_LIST = [  { name: "card-page", url: "/popup-harness.html?mode=page", window: "360,700" },
  { name: "card-element", url: "/popup-harness.html?mode=element", window: "360,700" },
  { name: "card-page-night", url: "/popup-harness.html?mode=page&theme=night", window: "360,700" },
  { name: "card-element-night", url: "/popup-harness.html?mode=element&theme=night", window: "360,700" },
  { name: "card-warn", url: "/popup-harness.html?mode=page&stage=warn&click=open", window: "360,700" },
  // 0.3.3：点选失败 → 工具条那一行多出一句失败说明（`#pickNote`）。这是「图片开关**始终**与两个按钮
  // 同一行」最容易被挤下去的现场（用户第二张真机截图就是这个），所以专门拍一帧。
  { name: "card-pickfail", url: "/popup-harness.html?mode=page&pickfail=injection_failed&click=pick", window: "360,700" },
  // 0.3.5：首启「还没有配置访问令牌」的现场（`state=needs-pairing`）—— 令牌块 + 上方的 IMP-2001 说明块
  // 同时在场，是最容易看出「块与块之间没有边距/边框」的状态。
  { name: "card-token", url: "/popup-harness.html?mode=page&state=needs-pairing", window: "360,700" },
  { name: "card-token-night", url: "/popup-harness.html?mode=page&state=needs-pairing&theme=night", window: "360,700" },
  { name: "card-token-saved", url: "/popup-harness.html?mode=page&click=settings", window: "360,700" },
  { name: "card-token-before", url: "/popup-harness.html?mode=page&state=needs-pairing&variant=before", window: "360,700" },
  { name: "card-token-saved-before", url: "/popup-harness.html?mode=page&click=settings&variant=before", window: "360,700" },
  { name: "card-before-page", url: "/popup-harness.html?mode=page&variant=before", window: "360,700" },
  { name: "card-before-element", url: "/popup-harness.html?mode=element&variant=before", window: "360,700" },
  { name: "card-before-page-night", url: "/popup-harness.html?mode=page&theme=night&variant=before", window: "360,700" },
  { name: "picker-paper", url: "/picker-harness.html?theme=paper", window: "720,520" },
  { name: "picker-night", url: "/picker-harness.html?theme=night", window: "720,520" },
  { name: "picker-before-paper", url: "/picker-harness.html?theme=paper&variant=before", window: "720,520" },
  { name: "picker-before-night", url: "/picker-harness.html?theme=night&variant=before", window: "720,520" },
];

const only = (process.argv.find((item) => item.startsWith("--shots=")) || "").slice("--shots=".length);
const wanted = only ? SHOT_LIST.filter((shot) => only.split(",").includes(shot.name)) : SHOT_LIST;

const results = [];
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/**
 * 起一次 headless Chrome 截图。**必须用异步 spawn**：`spawnSync` 会把本进程的事件循环堵住，
 * 而静态服务就跑在这个进程里 —— 实测症状是 Chrome 永远等不到响应、一直卡到超时
 * （`.shots/debug-chrome-flags.mjs` 记录过：file:// 495ms 成功、http:// 30s 超时，变量只差「谁在应答」）。
 */
function shoot(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: null, stderr: `${stderr}\n（超时 ${timeoutMs}ms 被杀）` });
    }, timeoutMs);
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stderr: String((error && error.message) || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stderr });
    });
  });
}

try {
  for (const shot of wanted) {
    const file = join(SHOTS, `${shot.name}.png`);
    // 每次一个**独立的 user-data-dir**：否则 headless 会去挂到本机已在跑的 Chrome 上（实测卡住不退出）。
    const profile = mkdtempSync(join(tmpdir(), "opennote-shot-"));
    const result = await shoot([
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--window-size=${shot.window}`,
      "--virtual-time-budget=2000",
      `--screenshot=${file}`,
      `http://127.0.0.1:${port}${shot.url}`,
    ]);
    rmSync(profile, { recursive: true, force: true });
    if (!existsSync(file)) {
      results.push({ name: shot.name, error: `未生成（chrome exit=${result.status}）${(result.stderr || "").split("\n").filter(Boolean).slice(-1)[0] || ""}` });
      continue;
    }
    const bytes = readFileSync(file);
    results.push({
      name: shot.name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      url: shot.url,
    });
  }
} finally {
  await new Promise((done) => server.close(done));
}

process.stdout.write("设计稿渲染（诊断工具，不是门禁）· 输出目录 extension/.shots/\n");
for (const item of results) {
  process.stdout.write(
    item.error
      ? `  ${item.name.padEnd(24)} ${item.error}\n`
      : `  ${item.name.padEnd(24)} ${String(item.bytes).padStart(7)} B  sha256=${item.sha256}  ${item.url}\n`,
  );
}
process.exit(0);
