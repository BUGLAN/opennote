/**
 * 类级检查：**自由变量**（`no-undef` 的静态版）。
 *
 * 为什么需要它（两个真实事故，同一个类）：
 *  ① M2 删了 `src/lib/highlights.js` → `background.js` 里 `normalizeUrl` 成了自由变量（元素选择结果静默落盘失败）；
 *  ② M2 删了模板/高亮 → `popup.js:209` 的 `highlights` 成了自由变量 →
 *     `render()` 抛 `Uncaught ReferenceError: highlights is not defined` →
 *     **popup 永远停在「正在读取页面…」，界面完全不可用**（用户实测）。
 *
 * `node --check` 对这类问题**是盲的**：自由变量是**运行时** ReferenceError，不是语法错误。
 * 所以这里做一件窄而明确的事：把每个 `.js` 里「被使用但既没声明、也没 import、也不在环境白名单里」
 * 的标识符找出来 —— 删模块留下的孤儿一定命中。
 *
 * 实现是**词法级**的（没有依赖，也就没有完整 parser）：词法扫描 → 声明收集 → 使用收集 → 求差。
 * 已知边界（故意保守，宁可漏报也不误报）：
 *  - 属性访问 `a.b`、对象字面量键 `{ a: 1 }`、标签、`import.meta` 不算使用；
 *  - 环境全局必须写进下面的白名单（可审：一个数组）；
 *  - 不解析 `with` / `eval` 动态名字（本项目都不用，V4 另有禁令）。
 *
 * 跑：`node tools/no-undef-check.mjs`（0 = 干净，1 = 有自由变量）
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { walkFiles } from "./dist-guard.mjs";

export const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 运行环境提供的全局（浏览器扩展 + 浏览器 + JS 内置）。**这是白名单，必须可审**：
 * 只有出现在这里的名字才允许「不声明就使用」。
 */
export const ENV_GLOBALS = Object.freeze([
  // 扩展 API
  "chrome", "browser",
  // 浏览器
  "window", "document", "navigator", "location", "history", "screen", "self", "globalThis",
  "console", "performance", "crypto", "caches", "indexedDB", "matchMedia", "getComputedStyle",
  "fetch", "Request", "Response", "Headers", "FormData", "Blob", "File", "FileReader",
  "URL", "URLSearchParams", "AbortController", "AbortSignal", "TextEncoder", "TextDecoder",
  "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent", "Node", "Element",
  "HTMLElement", "HTMLInputElement", "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "requestAnimationFrame", "cancelAnimationFrame", "atob", "btoa", "structuredClone",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "alert", "confirm", "prompt", "open", "close", "focus", "blur", "scrollTo", "postMessage",
  // JS 内置
  "Object", "Array", "String", "Number", "Boolean", "BigInt", "Symbol", "Function", "Math",
  "JSON", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect",
  "Error", "TypeError", "RangeError", "SyntaxError", "EvalError", "ReferenceError", "AggregateError",
  "Intl", "Infinity", "NaN", "undefined", "null", "true", "false", "this", "super", "arguments",
  "import", "eval", "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "escape", "unescape", "ArrayBuffer",
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array",
  "Float32Array", "Float64Array", "DataView", "SharedArrayBuffer", "Atomics", "WeakRef",
  "FinalizationRegistry", "global",
]);

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof",
  "let", "new", "of", "return", "static", "switch", "throw", "try", "typeof", "var", "void",
  "while", "with", "yield", "async", "await", "get", "set", "as", "from", "null", "true", "false",
  "this", "super", "new.target",
]);

/** 跳过一段字符串/模板/注释 —— 只用于「找 `${}` 的匹配右花括号」，不产出 token。 */
function skipStringAt(src, i, quote) {
  i += 1;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipTemplateAt(src, i) {
  i += 1;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") return i + 1;
    if (src[i] === "$" && src[i + 1] === "{") { i = skipBracedAt(src, i + 2) + 1; continue; }
    i += 1;
  }
  return i;
}

/** 返回与 `${` 之后那个左花括号匹配的右花括号下标。 */
function skipBracedAt(src, i) {
  let depth = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") { i = skipTemplateAt(src, i); continue; }
    if (ch === '"' || ch === "'") { i = skipStringAt(src, i, ch); continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1; i += 2; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return i;
}

/** 词法扫描：切出标识符 / 字符串 / 注释（注释直接丢）/ 标点。模板字面量里的 `${}` 内容当代码继续扫。 */
export function tokenize(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  let prev = null; // 上一个「有意义」的 token（用来判断 `/` 是正则还是除号）
  const regexAllowed = () =>
    !prev ||
    prev.type === "punct" ||
    (prev.type === "ident" && ["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "do", "else", "yield", "await"].includes(prev.value));
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      // 正则字面量：跳到未转义的 `/`，跳过字符类里的 `/`，并把 flags 一起吃掉
      i += 1;
      let inClass = false;
      while (i < n) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
        else if (source[i] === "\n") break; // 不是正则，退回去
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/i.test(source[i])) i += 1; // flags: g i m s u y d
      const t = { type: "str", value: "/regex/" };
      tokens.push(t);
      prev = t;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      const t = { type: "str", value: "" };
      tokens.push(t);
      prev = t;
      continue;
    }
    if (c === "`") {
      i += 1;
      while (i < n) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "`") { i += 1; break; }
        if (source[i] === "$" && source[i + 1] === "{") {
          // `${` 里是**代码**（可能还嵌着模板）：找到匹配的 `}`，递归切出来当普通 token
          const close = skipBracedAt(source, i + 2);
          for (const t of tokenize(source.slice(i + 2, close))) tokens.push(t);
          i = close + 1;
          prev = tokens.at(-1) || prev;
          continue;
        }
        i += 1;
      }
      // 结束反引号已在上面 `i += 1; break;` 里越过 —— 这里**不能**再 += 1（会吃掉模板后面的一个字符）
      prev = tokens.at(-1) || prev;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const t = { type: "ident", value: source.slice(i, j) };
      tokens.push(t);
      prev = t;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObBeE._n]/.test(source[j])) j += 1;
      prev = { type: "num" };
      i = j;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    // 多字符标点：`=>` / `?.` / `...` 必须整体成 token，否则箭头函数参数会被当成自由变量
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    const OPS3 = ["...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??="];
    const OPS2 = ["=>", "?.", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**"];
    let value = c;
    if (OPS3.includes(three)) { value = three; i += 3; }
    else if (OPS2.includes(two)) { value = two; i += 2; }
    else i += 1;
    const t = { type: "punct", value };
    tokens.push(t);
    prev = t;
  }
  return tokens;
}

/** 从 token 流里收「声明的名字」。 */
export function collectDeclared(tokens) {
  const declared = new Set();
  /** 不是「使用」的 token 下标：方法名、import 子句里的名字等。 */
  const skip = new Set();
  const take = (pattern) => {
    for (const name of pattern) declared.add(name);
  };
  // 绑定模式：标识符 / {a, b: c, ...d} / [a, b] / 默认值
  // `params: true` → 逗号是**参数分隔符**（不结束模式），只有 `)` 才结束。
  const patternAt = (start, { params = false } = {}) => {
    const names = [];
    let i = start;
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (!t) break;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "[") depth += 1;
        else if (t.value === "}" || t.value === "]") { depth -= 1; if (depth < 0) break; }
        else if (t.value === "," && depth === 0 && !params) break;
        else if (t.value === ";" && depth === 0) break;
        else if (t.value === "=" && depth === 0 && !params) break;
        else if (t.value === ")" && depth === 0) break;
        i += 1;
        continue;
      }
      if (t.type === "ident" && !KEYWORDS.has(t.value)) {
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        // `{ a: b }` → a 是键（不算声明），b 算；`{ a = 1 }` / `{ a }` → a 算
        const isKey = prev && prev.type === "punct" && (prev.value === "{" || prev.value === ",") && next && next.type === "punct" && next.value === ":";
        const isProp = prev && prev.type === "punct" && prev.value === "."; // 不该出现在模式里
        if (!isKey && !isProp) names.push(t.value);
      }
      i += 1;
    }
    return names;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    // 箭头函数的参数列表：`(a, b) =>` —— 它不在 ident 分支里，必须单独处理
    if (t.type === "punct" && t.value === "(") {
      let depth = 0;
      const names = [];
      let k = i;
      let sawIdent = false;
      while (k < tokens.length) {
        const u = tokens[k];
        if (u.type === "punct") {
          if (u.value === "(") depth += 1;
          else if (u.value === ")") { depth -= 1; if (depth === 0) break; }
        }
        if (u.type === "ident" && depth === 1 && !KEYWORDS.has(u.value)) {
          const prev = tokens[k - 1];
          const isKey = prev && prev.type === "punct" && prev.value === "{";
          if (!isKey) { names.push(u.value); sawIdent = true; }
        }
        k += 1;
      }
      const after = tokens[k + 1];
      const before = tokens[i - 1];
      const plausible = !before || before.type !== "ident" || KEYWORDS.has(before.value);
      if (after && after.type === "punct" && after.value === "=>" && plausible) {
        if (sawIdent) take(names);
        for (let x = i; x <= k; x += 1) skip.add(x);
        i = k;
      }
      continue;
    }
    if (t.type !== "ident") continue;
    const next = tokens[i + 1];
    // import ... from "x"
    if (t.value === "import") {
      // import { a, b as c } from / import d from / import * as e from
      let j = i + 1;
      while (j < tokens.length) {
        const u = tokens[j];
        skip.add(j);
        if (u.type === "str") break;
        if (u.type === "ident" && u.value === "from") break;
        if (u.type === "ident" && !KEYWORDS.has(u.value)) {
          const prev = tokens[j - 1];
          const after = tokens[j + 1];
          if (prev && prev.type === "ident" && prev.value === "as") {
            declared.add(u.value); // `x as y`：y 才是本地名
          } else if (after && after.type === "ident" && after.value === "as") {
            // `x as y` 里的原名 x：不是本地名，也不算使用
          } else {
            declared.add(u.value);
          }
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (t.value === "const" || t.value === "let" || t.value === "var") {
      // 一条语句可以有多个声明：`const b = 1, c = 2;` —— 逐个声明名 + 跳过初始化表达式
      let j = i + 1;
      while (j < tokens.length) {
        take(patternAt(j));
        let depth = 0;
        while (j < tokens.length) {
          const u = tokens[j];
          if (u.type === "punct") {
            if (u.value === "(" || u.value === "[" || u.value === "{") depth += 1;
            else if (u.value === ")" || u.value === "]" || u.value === "}") { depth -= 1; if (depth < 0) { depth = 0; break; } }
            else if (u.value === "," && depth === 0) break;
            else if (u.value === ";" && depth === 0) break;
          }
          j += 1;
        }
        if (tokens[j] && tokens[j].type === "punct" && tokens[j].value === ",") { j += 1; continue; }
        break;
      }
      continue;
    }
    if (t.value === "function") {
      // function name(...) / function* name(...) / function (...
      let j = i + 1;
      if (tokens[j] && tokens[j].type === "punct" && tokens[j].value === "*") j += 1;
      const nameTok = tokens[j];
      if (nameTok && nameTok.type === "ident" && !KEYWORDS.has(nameTok.value)) {
        declared.add(nameTok.value);
        j += 1;
      }
      if (tokens[j] && tokens[j].type === "punct" && tokens[j].value === "(") take(patternAt(j + 1, { params: true }));
      continue;
    }
    if (t.value === "class") {
      const nameTok = tokens[i + 1];
      if (nameTok && nameTok.type === "ident") declared.add(nameTok.value);
      continue;
    }
    if (t.value === "catch") {
      if (next && next.type === "punct" && next.value === "(") take(patternAt(i + 2, { params: true }));
      continue;
    }
    if (KEYWORDS.has(t.value)) continue; // `if (` / `return (` / `while (` 不是方法声明
    // 方法参数：`{ m(a, b) {} }` / 类里的 `m(a) {}` / 函数表达式的 `foo(a) {`
    if (next && next.type === "punct" && next.value === "(") {
      const prev = tokens[i - 1];
      const plausibleParamPos =
        !prev ||
        (prev.type === "punct" && ["{", ",", "}", ";", "=>"].includes(prev.value)) ||
        (prev.type === "ident" && prev.value === "async");
      if (plausibleParamPos) {
        // 找到匹配的 `)`：**后面紧跟 `{`（方法体）才算方法声明** —— `g();` 这种调用不算
        let k = i + 1;
        let depth = 0;
        while (k < tokens.length) {
          const u = tokens[k];
          if (u.type === "punct") {
            if (u.value === "(") depth += 1;
            else if (u.value === ")") { depth -= 1; if (depth === 0) break; }
          }
          k += 1;
        }
        const body = tokens[k + 1];
        if (body && body.type === "punct" && body.value === "{") {
          take(patternAt(i + 2, { params: true }));
          skip.add(i); // 方法名本身不是「使用」
        }
      }
      continue;
    }
    // 箭头函数的参数：`a =>`
    if (next && next.type === "punct" && next.value === "=>") {
      declared.add(t.value);
      continue;
    }
  }
  return { declared, skip };
}

/** 从 token 流里收「使用了但可能没声明的名字」；`skip` 里的下标不算使用（方法名、import 子句…）。 */
export function collectUsed(tokens, skip = new Set()) {
  const used = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== "ident") continue;
    if (skip.has(i)) continue;
    if (KEYWORDS.has(t.value)) continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) continue; // 属性名
    if (next && next.type === "punct" && next.value === ":") {
      // 对象字面量键 / 标签 / case 表达式：`{ a: 1 }`、`a: for(...)`
      if (prev && prev.type === "punct" && ["{", ",", "("].includes(prev.value)) continue;
      if (prev && prev.type === "ident" && ["case", "default"].includes(prev.value)) continue;
    }
    if (prev && prev.type === "ident" && (prev.value === "as" || prev.value === "from")) continue; // import/export 子句
    used.push({ name: t.value, index: i });
  }
  return used;
}

/** 对一个源文件做检查：返回自由变量名（去重、保持出现顺序）。 */
export function freeVariables(source) {
  const tokens = tokenize(source);
  const { declared, skip } = collectDeclared(tokens);
  const env = new Set(ENV_GLOBALS);
  const out = [];
  for (const { name } of collectUsed(tokens, skip)) {
    if (declared.has(name) || env.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 扫 `src/**\/*.js`；返回 `[{ file, free }]`（只列有自由变量的文件）。 */
export function scanTree(dir = join(EXT_DIR, "src")) {
  const results = [];
  for (const rel of walkFiles(dir, dir)) {
    if (!rel.endsWith(".js")) continue;
    const text = readFileSync(join(dir, rel), "utf8");
    const free = freeVariables(text);
    if (free.length) results.push({ file: rel.replaceAll(sep, "/"), free });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bad = scanTree();
  if (bad.length === 0) {
    console.log(`✓ 自由变量检查通过：src 下每个 .js 的标识符都「声明过 / import 过 / 在白名单里」`);
    process.exit(0);
  }
  console.error("✗ 发现自由变量（删模块留下的孤儿；运行时会抛 ReferenceError）:");
  for (const item of bad) console.error(`  - src/${item.file}: ${item.free.join(", ")}`);
  process.exit(1);
}
