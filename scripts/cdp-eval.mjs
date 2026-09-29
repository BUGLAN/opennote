/**
 * Tiny CDP driver used to verify the packaged/desktop build: connects to an
 * Electron (or Chrome) instance started with `--remote-debugging-port`, runs an
 * expression in the page and prints the JSON result.
 *
 * Node 22 ships a global WebSocket, so this needs no dependencies.
 *
 *   node scripts/cdp-eval.mjs 9222 "document.title"
 *   node scripts/cdp-eval.mjs 9222 --file expr.js
 */
const port = Number(process.argv[2] ?? 9222);
const inline = process.argv[3] ?? "1+1";
const useFile = process.argv[4] === "--file";
const useInput = process.argv[4] === "--input";
const expression = useInput
  ? "return 'typed'"
  : useFile
    ? (await import("node:fs/promises")).readFile(inline, "utf8")
    : inline;

const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await listResponse.json();
const page = targets.find((target) => target.type === "page") ?? targets[0];
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

if (useInput) {
  // type like a user, so the editor's real input path is exercised
  await send("Input.insertText", { text: inline });
  console.log("typed");
  socket.close();
  process.exit(0);
}

const result = await send("Runtime.evaluate", {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true,
});

if (result.exceptionDetails) {
  console.error("EVAL ERROR:", JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails));
  socket.close();
  process.exit(2);
}
console.log(typeof result.result.value === "string" ? result.result.value : JSON.stringify(result.result.value));
socket.close();
