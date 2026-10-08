/**
 * Mobile bundle (Capacitor / Route B): same vite build as the web app, but with
 * `OPENNOTE_MOBILE=1` so vite.config.ts disables the PWA service worker (a
 * native app updates as a whole; a stale SW would serve old assets) and skips
 * the meta CSP (Capacitor injects its native bridge as an inline `<script>`,
 * which a hash-based policy would block). The WebView only ever loads bundled,
 * trusted content, so the native shell replaces the browser's CSP layer here.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, OPENNOTE_MOBILE: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

console.log("[opennote] 构建移动版 Web 产物（无 Service Worker、无 meta CSP）…");
await run(process.execPath, [tsc, "--noEmit"]);
await run(process.execPath, [vite, "build"]);
console.log("[opennote] 完成：dist/ 交给 `cap sync` 拷进原生工程");
