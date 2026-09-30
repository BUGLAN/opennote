#!/usr/bin/env node
/**
 * 【诊断工具 · **不是门禁**】用**真桥**（`electron/bridge.cjs`，不需要 Electron）复跑
 * `/v1/clip/stage` 的三种资产输入，看扩展现在到底会不会发出一个「桥必拒的形状」。
 *
 * 性质标注（T-08 的纪律）：本文件是工具，**永远 exit 0**，不作为验收证据引用；
 * 真正的门禁是 `tests/clip-web-stage.test.mjs`（真回环 mock 的两个方向）+ `verify.mjs` 的 V17A
 * + `tools/mutation-stage-assets.mjs`（能红证明）。这里只是把真桥的原话抄出来，供人核对。
 *
 * 用法：`node tools/real-bridge-stage-probe.mjs`（只读：不改 electron/**，只起一次私有端口）
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, "..", "..");
const BRIDGE_PATH = join(ROOT, "electron", "bridge.cjs");

if (!existsSync(BRIDGE_PATH)) {
  process.stdout.write(`真桥不在（${BRIDGE_PATH}）—— 跳过。\n`);
  process.exit(0);
}

const bridgeModule = require(BRIDGE_PATH);
const { createBridge, sha256Hex } = bridgeModule;

// 1×1 真 PNG（70 字节）：证明「有字节才发」的那条路能过
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPYaKX3HwAE1gIaN2zZfgAAAABJRU5ErkJggg==";

const TOKEN = `opn_${"P".repeat(43)}`;

function post(port, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = require("node:http").request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/clip/stage",
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.length,
          Authorization: `Bearer ${TOKEN}`,
          "X-Opennote-Token": TOKEN,
          // 桥按**类型**放行来源：`chrome-extension://<8-64 位小写字母数字>`（`isExtensionOrigin`）。
          // 带连字符的假 id 会被 403 IMP-3001 挡在门外 —— 第一次跑就是这么被挡的（如实记下）。
          Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    request.on("error", (error) => resolve({ status: 0, text: String(error && error.message) }));
    request.end(payload);
  });
}

const base = () => ({
  spec: "opennote.clip/v1",
  url: "https://example.com/posts/local-first",
  title: "真桥探针：写给工程师的本地优先笔记",
  body: "![图](https://cdn.example.com/a.png)\n\n正文。",
  selection: false,
  tags: [],
  source: { site: "example.com", author: null, publishedAt: null },
});

const cases = [
  ["assets=[]（开关关着）", { ...base(), assets: [] }],
  ["assets=[{url,alt}]（**修复前**扩展发出的形状）", { ...base(), assets: [{ url: "https://cdn.example.com/a.png", alt: "图" }] }],
  ["assets=[{name,mime,dataBase64}]（修复后：有字节才发）", { ...base(), assets: [{ name: "a.png", mime: "image/png", dataBase64: PNG_BASE64 }] }],
];

async function freePort() {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), "opennote-real-bridge-probe-"));
const bridge = createBridge({
  dataDir,
  log: () => {},
  getWindow: () => ({ id: 1 }),
  onEnvelope: async () => ({ ok: true, result: { status: "created", warnings: [] } }),
  isEnabled: () => true,
  getTokenHash: () => sha256Hex(TOKEN),
  getInboxEnabled: () => false,
});
// 桥要求「先有令牌才允许开监听」（未设置令牌时 start() 直接拒绝）—— 与真机一致：
// 生产里是用户在设置面板点「生成令牌」。这里显式生成一次，再用同一串明文发请求。
if (typeof bridge.regenerateToken === "function") bridge.regenerateToken();

const lines = [];
try {
  const port = await freePort();
  const started = await bridge.startWithPort(port);
  if (!started || !started.port) {
    lines.push(`真桥起不来：${(started && started.error) || "未知原因"} —— 探针跳过。`);
  } else {
    lines.push(`真桥实例：http://127.0.0.1:${started.port}（dataDir=${dataDir}）`);
    lines.push("");
    for (const [label, body] of cases) {
      const result = await post(started.port, body);
      let parsed = null;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = null;
      }
      const detail = parsed && parsed.error && parsed.error.detail ? JSON.stringify(parsed.error.detail) : "";
      const code = parsed && parsed.error ? parsed.error.code : parsed && parsed.ok ? "ok" : "(非 JSON)";
      const openUrl = parsed && parsed.openUrl ? parsed.openUrl : "";
      lines.push(`HTTP ${result.status} · ${code} ${detail}`);
      lines.push(`   ${label}`);
      if (openUrl) lines.push(`   openUrl=${openUrl}`);
      lines.push("");
    }
  }
} finally {
  try {
    await bridge.stop();
  } catch {
    /* 探针不因停止失败而改变退出码 */
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
process.stdout.write("（诊断工具，永远 exit 0；不作为验收证据 —— 门禁见 tests/clip-web-stage.test.mjs 与 verify.mjs V17A）\n");
process.exit(0);
