/**
 * Skill 端口发现顺序的自测：**「先读 `bridge.json.port`，读不到再扫 8787–8796」**。
 *
 * 为什么需要它：`8787–8796` 完全可能整段被 Windows 的系统保留段吃掉（`EACCES`），
 * 那时桥会绑在**段外**的端口上 —— 一个只会盲扫固定段的脚本**永远找不到它**。
 * 这条自测用「伪造 userData + 桥替身」把那个现场造出来，且不碰任何真实笔记本。
 *
 * 用法：`node scripts/skill-port-discovery-smoke.mjs`
 * 退出码：0 = 通过；1 = 失败；2 = 夹具自身没跑起来（不算通过）。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, ".agents", "skills", "opennote-ingest", "scripts", "opennote-ingest.mjs");

/** 冻结段 `8787–8796` 之外 —— 模拟「桥绑在段外」。 */
const PORT = 18787;
const TOKEN = `opn_${"a".repeat(43)}`;

/**
 * 必须用**异步** spawn：`spawnSync` 会阻塞父进程的事件循环，而桥替身就跑在父进程里 ——
 * 那样子进程发来的请求永远没人应答，只会超时（第一版就栽在这儿）。
 */
function runAsync(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "opennote-skill-e2e-"));
const userData = path.join(appdata, "opennote");
const notebook = path.join(appdata, "notes");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(notebook, { recursive: true });

// 桥公布的端口 = PORT（**不在冻结段里**）；令牌沿用脚本已经在读的那个键。
fs.writeFileSync(
  path.join(userData, "bridge.json"),
  JSON.stringify({ version: 2, tokenPlaintext: TOKEN, enabled: true, port: PORT, startPort: PORT }, null, 2),
);
fs.writeFileSync(path.join(userData, "recent-workspaces.json"), JSON.stringify([notebook]));

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/v1/health") {
    return send(200, {
      ok: true,
      result: {
        bridge: "running",
        spec: "opennote.import/v1",
        app: "0.9.0",
        port: PORT,
        workspace: { open: true, name: path.basename(notebook) },
        inbox: true,
        inboxMode: "inbox",
        authRequired: true,
        time: new Date().toISOString(),
      },
    });
  }
  // 鉴权探针：令牌对 → 回「这个 importId 不存在」（= 探针成功，与真桥同款语义）。
  if (req.url.startsWith("/v1/imports/")) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, { ok: false, error: { code: "IMP-2002" } });
    }
    return send(404, { ok: false, error: { code: "IMP-4017" } });
  }
  return send(404, { ok: false, error: { code: "IMP-4040" } });
});

let exitCode = 2;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });

  // 先自检替身：否则失败原因是夹具，不是 Skill。
  const selfCheck = await fetch(`http://127.0.0.1:${PORT}/v1/health`)
    .then((response) => response.status)
    .catch(() => 0);
  if (selfCheck !== 200) {
    console.log(`SKIP 桥替身没能起来（/v1/health → ${selfCheck}），夹具问题，不算判定`);
    process.exit(2);
  }

  const run = await runAsync(process.execPath, [SCRIPT, "--check", "--json"], {
    env: { ...process.env, APPDATA: appdata },
  });

  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    /* 输出不是 JSON，下面按失败报 */
  }

  const ok =
    report !== null &&
    report.ok === true &&
    report.bridge &&
    report.bridge.how === "bridge.json.port" &&
    report.bridge.endpoint === `http://127.0.0.1:${PORT}` &&
    report.token &&
    report.token.auth === "ok" &&
    report.workspace &&
    typeof report.workspace.root === "string";

  console.log(`桥绑在段外（${PORT}）时的 --check：`);
  console.log(run.stdout.trim() || "(空)");
  if (run.stderr.trim()) console.log(`stderr: ${run.stderr.trim()}`);

  if (ok) {
    console.log(`\nPASS 段外端口由 bridge.json.port 发现（how=${report.bridge.how}）`);
    exitCode = 0;
  } else {
    console.log("\nFAIL 没能通过 bridge.json.port 找到段外端口（旧实现只会盲扫 8787–8796）");
    exitCode = 1;
  }
} finally {
  server.close();
  fs.rmSync(appdata, { recursive: true, force: true });
}

process.exit(exitCode);
