/**
 * CDP driver for the jump-probe.
 *
 * A copy of `scripts/cdp-eval.mjs` with one bug fixed: that script's `--file`
 * path does `(await import("node:fs/promises")).readFile(...)` **without**
 * awaiting the read, so `expression` is a Promise and the page receives the
 * literal text `[object Promise]` → `SyntaxError: Unexpected identifier 'Promise'`.
 * Nothing in the repo is modified; the fix lives here.
 *
 *   node .tmp-verify/jump-probe/cdp.mjs 9222 "<expression>"
 *   node .tmp-verify/jump-probe/cdp.mjs 9222 <file> --file
 *   node .tmp-verify/jump-probe/cdp.mjs 9222 <file> --file --out out/x.json
 */
import { readFile, writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const port = Number(argv[0] ?? 9222);
const target = argv[1] ?? "1+1";
const useFile = argv.includes("--file");
const outIndex = argv.indexOf("--out");
const outPath = outIndex >= 0 ? argv[outIndex + 1] : null;

const expression = useFile ? await readFile(target, "utf8") : target;

const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await listResponse.json();
const page = targets.find((t) => t.type === "page");
if (!page?.webSocketDebuggerUrl) {
  console.error("no page target found:", JSON.stringify(targets, null, 2));
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const started = Date.now();
const result = await send("Runtime.evaluate", {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true,
});

if (result.exceptionDetails) {
  console.error("EVAL ERROR:", result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  socket.close();
  process.exit(2);
}

const text =
  typeof result.result.value === "string" ? result.result.value : JSON.stringify(result.result.value, null, outPath ? 1 : 0);
if (outPath) await writeFile(outPath, text, "utf8");
console.log(text);
console.error(`[cdp] ${Date.now() - started} ms`);
socket.close();
