#!/usr/bin/env node
/**
 * macOS 打包：`pnpm package:mac`
 *
 * 产物（都在 `release/`，命名与 electron-builder 的 `artifactName` 一致，能被
 * `pnpm checksums` 收进 SHA256SUMS）：
 *   release/mac-<arch>/Opennote.app              可直接双击运行的应用
 *   release/Opennote-<版本>-mac-<arch>.dmg       拖进「应用程序」即安装
 *   release/Opennote-<版本>-mac-<arch>.zip       解压即用（给不便挂载 DMG 的场景）
 *
 * 全程**不需要联网、不需要 Apple 开发者账号**。每一步为什么这么做：
 *
 * 1. 渲染层：`scripts/build-desktop.mjs`（打包版走 `file://`，资源必须是相对路径）。
 * 2. 组装：`electron-builder --mac --dir`。
 *    配置里 `mac.identity: null`，也就是 electron-builder **不签名**（原因见
 *    electron-builder.yml：`"-"` 会被它按子串匹配到不相干的证书上）。
 *    用 `--dir` 而不是默认目标：它自带的 `dmg` / `zip` 都要**联网下载**工具链
 *    （dmgbuild / 7zip），离线机器上只会卡在 `fetch failed`。
 * 3. ad-hoc 签名：Apple Silicon 上**必须**签，否则内核直接杀掉被改过的 bundle。
 *    用 electron-builder 自己依赖的 `@electron/osx-sign`（由内向外签，并按主程序 /
 *    GPU / Renderer / Plugin 分别套上 Electron 的标准 entitlements）；解析不到时退回
 *    系统 `codesign --deep`。签完复验签名，并确认 hardened runtime 是**关**的
 *    （ad-hoc + hardened runtime 会因为 library validation 起不来，见 adhocSign 注释）。
 * 4. 冒烟测试：真启动一次打包产物，等渲染进程起来、读出界面标题与桥对象。
 *    这一步是「打包没坏」的唯一证据 —— 签名看起来再对，dylib 加载失败也一样打不开。
 * 5. DMG：`hdiutil`（系统自带）。卷里除了 `Opennote.app` 再放一个 `/Applications` 软链接，
 *    用户拖进去就是安装。
 * 6. ZIP：`ditto`（系统自带）。**不要**换成 `zip`：`.app` 里全是符号链接与可执行位，
 *    zip/7z 会把符号链接解引用成副本，解出来的 Electron 框架结构就废了。
 * 7. 校验和：`scripts/make-checksums.mjs`（没签名，用户唯一能自查的就是哈希）。
 *
 * 退出码：0 = 打包完成、签名复验通过、冒烟测试通过；非 0 = 任一步失败（绝不发出半成品）。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const RELEASE = join(ROOT, "release");
const APP_DIR = join(RELEASE, `mac-${ARCH}`);
const APP = join(APP_DIR, "Opennote.app");
const DMG = join(RELEASE, `Opennote-${pkg.version}-mac-${ARCH}.dmg`);
const ZIP = join(RELEASE, `Opennote-${pkg.version}-mac-${ARCH}.zip`);
/** DMG 里那个「拖进这里安装」的软链接；只在生成 DMG 期间存在，用完就删。 */
const APPLICATIONS_LINK = join(APP_DIR, "Applications");

const TOTAL_STEPS = 7;
const step = (n, text) => console.log(`\n[opennote] (${n}/${TOTAL_STEPS}) ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 跑一个命令并把它的输出原样透到终端；非 0 退出即抛错。 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

/**
 * 跑一个命令并**收走**输出：成功返回 `{ stdout, stderr }`，失败时把 stderr 一起抛出来。
 *
 * 为什么要连 stderr 一起收：`codesign -dv` / `codesign --verify` 的结果是写到 **stderr**
 * 的，只看 stdout 会读到空字符串（踩过：明明签成了 ad-hoc，却被判成「不是 ad-hoc」）。
 */
function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} 退出码 ${code}\n${stderr.trim()}`)),
    );
  });
}

/**
 * ad-hoc 签名（`codesign -s -` 的等价物）。
 *
 * 为什么优先 `@electron/osx-sign` 而不是一句 `codesign --force --deep --sign -`：
 * 后者会把 entitlements **整个丢掉**（实测 `codesign -d --entitlements -` 为空），
 * 而 Electron 的 Helper（GPU / Renderer / Plugin）本来各自带着 `allow-jit`、
 * `disable-library-validation` 这些 —— 现在 hardened runtime 是关的，丢了也还能跑，
 * 但换成正式签名/公证时会变成「本地好好的、发出去起不来」。所以走和 electron-builder
 * 同一条签名路径，entitlements 由 osx-sign 按 Electron 的默认档自动分配。
 */
async function adhocSign(appPath) {
  let signer = null;
  try {
    // pnpm 的严格 node_modules 下 @electron/osx-sign 不在根上，得从 electron-builder 那里解析。
    // 注意必须用 `require.resolve` 拿到**真实路径**（.pnpm 里的那个），不能拼
    // `node_modules/electron-builder` 这个软链：createRequire 不解析软链，从软链位置
    // 找不到 electron-builder 的兄弟依赖（踩过：静默落到 codesign 兜底分支）。
    const rootRequire = createRequire(import.meta.url);
    const fromElectronBuilder = createRequire(rootRequire.resolve("electron-builder/package.json"));
    signer = await import(pathToFileURL(fromElectronBuilder.resolve("@electron/osx-sign")).href);
  } catch {
    signer = null;
  }

  if (typeof signer?.signAsync === "function") {
    await signer.signAsync({
      app: appPath,
      platform: "darwin",
      identity: "-", // ad-hoc：本地签，不需要证书
      identityValidation: false, // 别去钥匙串里找 "-" 这个名字
      // ⚠️ hardenedRuntime 必须走 optionsForFile，**顶层那个同名选项是无效的**：
      //    osx-sign 只把 optionsForFile() 的返回值合并进 per-file 选项
      //    （dist/cjs/sign.js 的 mergeOptionsForFile），顶层 opts.hardenedRuntime 根本没人读。
      //    实测踩坑：顶层写 false 被忽略 → 产物带上 `runtime` 标志 → ad-hoc 签名 +
      //    hardened runtime 会打开 library validation，主程序与 Electron Framework 都没有
      //    Team ID，dyld 直接报 "different Team IDs"、应用连启动都启动不了。
      //    electron-builder 自己也是走 optionsForFile 这条路（MacTargetHelper.getOptionsForFile）。
      optionsForFile: () => ({ hardenedRuntime: false }),
    });
    return "@electron/osx-sign (ad-hoc)";
  }

  console.log("  注意：解析不到 @electron/osx-sign，退回 codesign --deep（本次不带 entitlements）");
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  return "codesign --deep (ad-hoc)";
}

function sizeOf(file) {
  return `${(statSync(file).size / 1048576).toFixed(1)} MB`;
}

/** `.app` 是目录，直接量整个 bundle（不要量 Contents/MacOS 里那个几百 KB 的启动器）。 */
async function bundleSize(path) {
  const { stdout } = await capture("du", ["-sh", path]);
  return stdout.trim().split(/\s+/)[0];
}

const EXECUTABLE = join(APP, "Contents", "MacOS", "Opennote");

/**
 * 冒烟测试：真启动一次打包产物，确认渲染进程起来了、界面真渲染了。
 *
 * 只验签名是不够的：签名「有效」但动态库加载失败的产物一样打不开（本项目就踩过
 * hardened runtime + ad-hoc 导致 Electron Framework 加载被拒）。所以这里必须真跑。
 *
 * 两个坑：
 *   · 必须给独立的 `--user-data-dir`：打包版有单实例锁，本机只要已经有 Opennote 在跑，
 *     新进程会在 0.5 秒内以**退出码 0** 静默退出，看起来就像「打包坏了」。
 *   · 必须摘掉 `ELECTRON_RUN_AS_NODE`：它会让 Electron 二进制退化成纯 Node，
 *     连 `--user-data-dir` 都不认（报 `bad option`）。
 */
async function smokeTest(appPath) {
  const port = 9300 + Math.floor(Math.random() * 400);
  const userData = await mkdtemp(join(tmpdir(), "opennote-smoke-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(join(appPath, "Contents", "MacOS", "Opennote"), [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));

  try {
    const deadline = Date.now() + 60_000;
    let pageSeen = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`应用启动后立刻退出（exitCode=${child.exitCode}）。日志尾部：\n${log.slice(-2000)}`);
      }
      if (!pageSeen) {
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          pageSeen = targets.some((target) => target.type === "page");
        } catch {
          /* 调试端口还没起来，继续等 */
        }
      }
      // 两个条件都要等：CDP 的页面目标会**早于**主进程那句 "desktop ready" 出现
      // （实测抢跑过：页面目标有了、CSP 也放行了，但窗口/桥还没就绪）。
      // 只等页面目标就往下走，会偶发地把一个其实正常的包判成坏的。
      if (pageSeen && log.includes("desktop ready")) break;
      await sleep(300);
    }
    if (!pageSeen) throw new Error(`60 秒内没等到渲染进程。日志尾部：\n${log.slice(-2000)}`);
    if (!log.includes("desktop ready")) {
      throw new Error(`渲染进程起来了，但 60 秒内主进程没有打出 "desktop ready"。日志尾部：\n${log.slice(-2000)}`);
    }

    // 复用仓库已有的 CDP 小工具读界面状态，而不是在这里再写一套 WebSocket。
    const { stdout } = await capture(process.execPath, [
      join(ROOT, "scripts", "cdp-eval.mjs"),
      String(port),
      "return { title: document.title, bridge: typeof window.opennote, root: document.getElementById('root')?.children.length ?? 0 }",
    ]);
    const state = JSON.parse(stdout.trim());
    if (state.bridge !== "object" || state.root < 1) {
      throw new Error(`界面没有真正渲染出来：${JSON.stringify(state)}`);
    }
    return state;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      // 等它真的退出再删 userData：残留进程会占着单实例锁影响下一次打包。
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(5000).then(() => child.kill("SIGKILL")),
      ]);
    }
    await rm(userData, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.error(
      `FAIL  package:mac 只能在 macOS 上跑（要用系统自带的 hdiutil / ditto / codesign）。当前平台：${process.platform}`,
    );
    process.exit(1);
  }

  step(1, "构建渲染层（dist/ + dist-clip/，资源用相对路径）…");
  await run(process.execPath, [join(ROOT, "scripts", "build-desktop.mjs")]);

  step(2, `用 electron-builder 组装 Opennote.app（mac-${ARCH}，不签名）…`);
  await run(process.execPath, [join(ROOT, "node_modules", "electron-builder", "cli.js"), "--mac", "--dir"]);
  if (!existsSync(EXECUTABLE)) {
    throw new Error(`没有产出 ${APP} —— electron-builder 没按预期工作，见上面的输出`);
  }

  step(3, "ad-hoc 签名并复验…");
  const signer = await adhocSign(APP);
  console.log(`  签名方式：${signer}`);
  // --strict：不仅看签名在不在，还要它自洽（bundle 里每个东西都被覆盖到）。
  await capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);
  const { stdout, stderr } = await capture("codesign", ["-dv", "--verbose=4", APP]);
  const signature = `${stdout}\n${stderr}`;
  if (!/^Signature=adhoc$/m.test(signature)) {
    throw new Error(`签名复验通过，但它不是 ad-hoc —— 可能用到了本机某张证书，发布物不可复现：\n${signature.trim()}`);
  }
  // ad-hoc + hardened runtime = library validation 把关，Electron Framework 加载不了。
  const flags = signature.match(/^CodeDirectory .*flags=(\S+)/m)?.[1] ?? "";
  if (flags.includes("runtime")) {
    throw new Error(
      `签名是 ad-hoc 但带着 hardened runtime（flags=${flags}）—— 这样打出来的应用起不来：` +
        `主程序与 Electron Framework 都没有 Team ID，dyld 会以 "different Team IDs" 拒绝加载。` +
        `请检查 adhocSign() 的 optionsForFile 是否仍然返回 hardenedRuntime: false。`,
    );
  }
  console.log(`  PASS  codesign --verify --deep --strict；Signature=adhoc，flags=${flags}（无 runtime）`);

  step(4, "冒烟测试：真启动一次打包产物…");
  const state = await smokeTest(APP);
  console.log(`  PASS  渲染进程已就绪：title=${JSON.stringify(state.title)}，window.opennote=${state.bridge}，#root 子节点=${state.root}`);

  step(5, "用 hdiutil 生成 DMG（内含 /Applications 软链接）…");
  await rm(DMG, { force: true });
  // 不拷贝整个 .app：直接在 unpacked 目录里加一个软链接当 DMG 的卷内容，省掉一次
  // 可能弄坏符号链接/权限的复制。用完（含失败路径）一定删掉。
  await rm(APPLICATIONS_LINK, { force: true });
  try {
    await symlink("/Applications", APPLICATIONS_LINK);
    // -fs HFS+：UDZO 压缩卷用 HFS+ 的兼容性最好；-ov 覆盖同名旧文件。
    // -quiet：新版 macOS 会对 `hdiutil create` 打一条「请改用 diskutil image create」的
    // 弃用警告。**暂时不迁**：`diskutil image create from` 只有较新的 macOS 才有，
    // 迁过去等于把打包脚本的最低系统版本抬上去；hdiutil 目前仍然完全可用。
    await run("hdiutil", ["create", "-quiet", "-volname", "Opennote", "-srcfolder", APP_DIR, "-ov", "-format", "UDZO", "-fs", "HFS+", DMG]);
  } finally {
    await rm(APPLICATIONS_LINK, { force: true });
  }

  step(6, "用 ditto 生成 ZIP（保留符号链接与可执行位）…");
  await rm(ZIP, { force: true });
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", APP, ZIP]);

  step(7, "写 release/SHA256SUMS…");
  await run(process.execPath, [join(ROOT, "scripts", "make-checksums.mjs"), "release"]);

  const appSize = await bundleSize(APP);
  const rel = (path) => path.replace(`${ROOT}/`, "");
  console.log(
    [
      "",
      "[opennote] macOS 打包完成：",
      `  ${rel(APP)}   ${appSize}`,
      `  ${rel(DMG)}   ${sizeOf(DMG)}`,
      `  ${rel(ZIP)}   ${sizeOf(ZIP)}`,
      "",
      "  未签名（ad-hoc）——从网上下载后首次运行会被 Gatekeeper 拦下。用户侧的放行方式：",
      "    右键 Opennote.app →「打开」→「打开」，或 xattr -dr com.apple.quarantine <app 路径>",
      "  本机自测直接跑（打包脚本已自动做过一次启动冒烟）：",
      `    env -u ELECTRON_RUN_AS_NODE ${rel(EXECUTABLE)} --user-data-dir=$(mktemp -d)`,
      "",
    ].join("\n"),
  );
}

await main();
