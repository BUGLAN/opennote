#!/usr/bin/env node
/**
 * 打包桌面产物的跨平台启动冒烟。
 *
 * 真启动一次已经打包好的可执行文件，用独立的 `--user-data-dir` 和
 * `--remote-debugging-port` 等窗口渲染，再经 CDP 断言：
 *   1. 主进程打出了 `desktop ready`（`loadFile` / 创建窗口成功）；
 *   2. `#root` 里已经有渲染内容；
 *   3. `window.opennote` 是 preload 暴露的对象，且一次无害的 IPC 调用能成功；
 *   4. 启动日志里没有主进程致命错误。
 *
 * Windows 发布流水线用它检查 `release/win-unpacked/Opennote.exe`，通过后只把这份
 * 已经启动过的目录归档成 zip。macOS 的 `scripts/build-mac.mjs` 复用同一个实现，
 * 所以两个平台查的是同一组条件，不再各维护一份。
 *
 * 用法：
 *   node scripts/smoke-desktop.mjs
 *   node scripts/smoke-desktop.mjs --executable release/win-unpacked/Opennote.exe
 *   node scripts/smoke-desktop.mjs --timeout-ms 90000 --keep-user-data
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP_EVAL = join(ROOT, "scripts", "cdp-eval.mjs");
const READY_MARKER = "[opennote] desktop ready";
const DEFAULT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
const STARTUP_GRACE_MS = 750;
const MAX_LOG_CHARS = 200_000;
const LOG_TAIL_CHARS = 6000;

/**
 * 只匹配主进程明确写出的致命启动路径，不匹配可降级的可选模块告警。
 * 例如缺少 `@parcel/watcher` 会退回 `node:fs` 监听，不能把这种正常降级判成失败。
 */
const FATAL_STARTUP_PATTERNS = [
  /\[opennote\] 启动失败：/,
  /\[opennote\] 创建窗口失败：/,
  /\[opennote\] 加载失败 /,
  /\[opennote\] CSP 注入注册失败：/,
  /Unable to load preload script/i,
  /A JavaScript error occurred in the main process/i,
];

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 本机打包产物的默认位置；也可以在命令行用 `--executable` 覆盖。 */
export function defaultDesktopExecutable({ root = ROOT, platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32") return join(root, "release", "win-unpacked", "Opennote.exe");
  if (platform === "darwin") {
    const suffix = arch === "arm64" ? "arm64" : "x64";
    return join(root, "release", `mac-${suffix}`, "Opennote.app", "Contents", "MacOS", "Opennote");
  }
  if (platform === "linux") {
    const suffix = arch === "arm64" ? "-arm64" : "";
    return join(root, "release", `linux${suffix}-unpacked`, "opennote");
  }
  throw new Error(`不支持的平台：${platform}`);
}

/** 返回第一条致命日志；没有就返回 null。 */
export function findFatalStartupError(log) {
  for (const line of log.split(/\r?\n/)) {
    if (FATAL_STARTUP_PATTERNS.some((pattern) => pattern.test(line))) return line.trim();
  }
  return null;
}

/** 把 CDP 读到的状态转成人能读的失败原因；空数组表示全部通过。 */
export function rendererStateProblems(state) {
  if (!state || typeof state !== "object") return ["CDP 没有返回页面状态"];
  const problems = [];
  if (state.bridge !== true || state.bridgeType !== "object") {
    problems.push(`window.opennote 不可用（bridgeType=${state.bridgeType ?? "undefined"}）`);
  }
  if (state.isElectron !== true) problems.push("window.opennote.isElectron 不是 true");
  if (state.hasFsList !== true) problems.push("window.opennote.fs.list 不是函数");
  if (state.ipc !== true) {
    problems.push(`窗口 IPC 调用失败${state.ipcError ? `：${state.ipcError}` : ""}`);
  }
  if (!Number.isInteger(state.rootChildren) || state.rootChildren < 1) {
    problems.push(`#root 没有渲染内容（children=${state.rootChildren ?? "undefined"}）`);
  }
  return problems;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("没有分配到可用的 CDP 端口");
  return port;
}

async function findPage(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

function capture(command, args, { timeoutMs = 5000, ...options } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} 超过 ${timeoutMs}ms 没有返回`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} 退出码 ${code}\n${stderr.trim()}`));
    });
  });
}

async function readRendererState(port) {
  const expression = `
    const note = window.opennote;
    let ipc = false;
    let ipcError = "";
    if (note && typeof note.window?.getState === "function") {
      try {
        const value = await note.window.getState();
        ipc = typeof value?.maximized === "boolean";
      } catch (error) {
        ipcError = String(error?.message ?? error);
      }
    }
    return {
      title: document.title,
      bridgeType: typeof note,
      bridge: Boolean(note),
      isElectron: note?.isElectron === true,
      hasFsList: typeof note?.fs?.list === "function",
      ipc,
      ipcError,
      rootChildren: document.getElementById("root")?.children.length ?? 0,
      readyState: document.readyState,
      url: location.href,
    };
  `;
  const { stdout } = await capture(process.execPath, [CDP_EVAL, String(port), expression]);
  return JSON.parse(stdout.trim());
}

function tailLog(log) {
  return log.length <= LOG_TAIL_CHARS ? log : `…（前段省略）\n${log.slice(-LOG_TAIL_CHARS)}`;
}

function failure(message, log) {
  return new Error(`${message}\n应用日志尾部：\n${tailLog(log) || "（空）"}`);
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", finish);
      resolvePromise(false);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", finish);
  });
}

/** 只杀这次启动的进程树；绝不按映像名杀用户自己的 Opennote。 */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 5000)) return;

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 5000);
}

/**
 * 启动打包产物并跑完全部断言。`build-mac.mjs` 直接 import 这个函数；
 * 新平台接入时只需传对应可执行文件，不要复制另一套启动逻辑。
 */
export async function smokePackagedApp({
  executable,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keepUserData = false,
  log = console.log,
} = {}) {
  if (!executable) throw new Error("没有指定打包产物的可执行文件");
  const exe = resolve(executable);
  if (!existsSync(exe)) {
    throw new Error(`没有找到打包产物：${exe}\n请先构建对应的 unpacked 目录。`);
  }
  const info = await stat(exe);
  if (!info.isFile()) throw new Error(`打包产物不是文件：${exe}`);

  const port = await freePort();
  const userData = await mkdtemp(join(tmpdir(), "opennote-smoke-"));
  const env = { ...process.env };
  // 这个变量会把 Electron 退化成纯 Node，窗口根本不会出现。CI / 本机都可能有残留。
  delete env.ELECTRON_RUN_AS_NODE;

  let child = null;
  let appLog = "";
  let exit = null;
  let spawnError = null;

  const appendLog = (chunk) => {
    appLog += chunk.toString();
    if (appLog.length > MAX_LOG_CHARS) appLog = appLog.slice(-Math.floor(MAX_LOG_CHARS * 0.75));
  };
  const assertAlive = () => {
    if (spawnError) throw failure(`启动进程失败：${spawnError.message}`, appLog);
    if (exit) throw failure(`应用启动后退出（exitCode=${exit.code}，signal=${exit.signal || "-"}）`, appLog);
    const fatal = findFatalStartupError(appLog);
    if (fatal) throw failure(`启动日志出现致命错误：${fatal}`, appLog);
  };

  log(`[smoke] 可执行文件：${exe}`);
  log(`[smoke] 独立 user-data-dir：${userData}`);

  try {
    child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    child.once("error", (error) => (spawnError = error));
    child.once("exit", (code, signal) => (exit = { code, signal }));

    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      assertAlive();
      if (!page) page = await findPage(port);
      if (page && appLog.includes(READY_MARKER)) break;
      await sleep(POLL_MS);
    }
    assertAlive();
    if (!page) throw failure(`${timeoutMs}ms 内没等到渲染进程（CDP 页面目标）`, appLog);
    if (!appLog.includes(READY_MARKER)) {
      throw failure(`渲染进程起来了，但 ${timeoutMs}ms 内主进程没有打出 "desktop ready"`, appLog);
    }

    await sleep(STARTUP_GRACE_MS);
    assertAlive();

    const renderDeadline = Math.min(deadline, Date.now() + RENDER_TIMEOUT_MS);
    let state = null;
    let problems = ["CDP 还没有读到页面状态"];
    let evaluationError = null;
    while (Date.now() < renderDeadline) {
      assertAlive();
      try {
        state = await readRendererState(port);
        evaluationError = null;
        problems = rendererStateProblems(state);
        if (problems.length === 0) break;
      } catch (error) {
        evaluationError = error;
      }
      await sleep(500);
    }

    assertAlive();
    if (problems.length > 0) {
      const detail = evaluationError ? `；最后一次 CDP 错误：${evaluationError.message}` : "";
      throw failure(
        `页面没有通过启动断言：${problems.join("；")}${detail}\n页面状态：${JSON.stringify(state)}`,
        appLog,
      );
    }

    log(
      `[smoke] PASS title=${JSON.stringify(state.title)}；bridge=${state.bridgeType}；IPC=${state.ipc}；` +
        `#root 子节点=${state.rootChildren}；readyState=${state.readyState}`,
    );
    return state;
  } finally {
    await stopChild(child);
    if (keepUserData) {
      log(`[smoke] 保留 user-data-dir：${userData}`);
    } else {
      try {
        await rm(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      } catch (error) {
        log(`[smoke] WARN 清理临时 user-data-dir 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function parseArgs(argv) {
  const options = { timeoutMs: DEFAULT_TIMEOUT_MS, keepUserData: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--executable" || arg === "-e") options.executable = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--keep-user-data") options.keepUserData = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms 必须是至少 1000 的毫秒数");
  }
  return options;
}

function printHelp() {
  console.log(`用法：node scripts/smoke-desktop.mjs [选项]

  --executable, -e <路径>   要启动的打包产物；默认按当前平台找 release/ 下的产物
  --timeout-ms <毫秒>       等待窗口与渲染完成的上限，默认 ${DEFAULT_TIMEOUT_MS}
  --keep-user-data          检查后保留临时 user-data-dir，便于排查
  --help, -h                显示这份帮助`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const executable = options.executable ? resolve(process.cwd(), options.executable) : defaultDesktopExecutable();
  await smokePackagedApp({
    executable,
    timeoutMs: options.timeoutMs,
    keepUserData: options.keepUserData,
  });
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[smoke] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
