/**
 * Desktop bundle: the packaged app is loaded through `file://`, so every asset
 * reference has to be relative. This script sets the flag vite.config.ts reads
 * and then runs the normal type-check + build.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  return new Promise((resolve, reject) => {
    // no shell: the command is a node binary path that may contain spaces
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, OPENNOTE_DESKTOP: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

console.log("[opennote] 构建桌面版（资源使用相对路径）…");
await run(process.execPath, [tsc, "--noEmit"]);
await run(process.execPath, [vite, "build"]);
console.log("[opennote] 完成：dist/ 可以直接被 Electron 以 file:// 加载");
