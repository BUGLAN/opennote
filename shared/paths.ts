/**
 * 两侧共用的路径纯函数（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.6、§3.3、§3.8）。
 *
 * ## 这个文件为什么存在
 *
 * 以前路径规则有**三份**实现（客户端 TS + 服务端 TS + CouchDB `_design` 里的 JS），
 * 靠契约夹具对齐。单仓之后客户端与服务端共用同一份 TS —— 这份就是那一份，
 * 剩下唯一的接缝是 `_design` 里的 JS（它跑在 CouchDB 的 JS 引擎里，既不是 TS 也不能
 * import 这里），由 `shared/fixtures/path-rules.cases.json` 驱动双方测试（§10.1 F1）。
 *
 * ## 纯度是被强制的，不是自觉的
 *
 * `shared/tsconfig.json` 的 `lib` 只有 `ES2022` 且不配 `types` ⇒ 这里写 `document`、
 * `window`、`import fs from "node:fs"` **直接编译不过**（U29 已实测）。
 * 也因此，连 `TextEncoder` / `btoa` 这类宿主全局都不在这里 —— 编码/解码自己实现，
 * 保证四个宿主（Electron 渲染层 / 主进程 / Capacitor WebView / 浏览器）逐字节一致。
 *
 * ## 全链路统一 NFC（§3.8）
 *
 * macOS 给 **NFD**，Linux/Windows 多为 **NFC** ⇒「看起来一样、字节不一样」会把同一篇笔记
 * 变成两个文档。所以 `idForPath()` 内部先做 NFC，**客户端与 Node 共用同一函数**。
 * 大小写**不折叠**（CouchDB 的 `_id` 大小写敏感），折叠冲突由调用方检测并告警，不自动改名。
 */

/** 与客户端 `src/fs/paths.ts` 一致的元数据目录名。 */
export const META_DIR = ".opennote";

/**
 * `String.prototype.normalize` 只有 ES2015 起的实现才有；`lib: ["ES2022"]` 已包含它。
 * 显式包一层是为了给出**统一的失败口径**：环境不支持时抛，而不是静默返回原串
 * （静默返回原串会让 NFC/NFD 分叉在运行时悄悄发生，比直接报错难查得多）。
 */
export function normalizeNfc(input: string): string {
  const value = String(input ?? "");
  if (typeof value.normalize !== "function") {
    throw new Error("当前环境不支持 String.prototype.normalize，无法做 NFC 归一");
  }
  return value.normalize("NFC");
}

/** POSIX 风格归一：反斜杠转 `/`、丢掉空段与 `.`、解析 `..`。`''` = 根。 */
export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const raw of String(input ?? "").replace(/\\/g, "/").split("/")) {
    // ⚠️ 段**首尾**空白被丢掉（`" a.md "` → `"a.md"`）。这是既有行为，保留它而不是「顺手改对」：
    //   用户输入与从剪贴板粘来的路径经常带空白，而磁盘上的文件名又以首尾空白为特例
    //   （Windows 会静默剥掉、macOS 的 HFS+ 也做过），不归一反而更容易撞出「两个文档」。
    //   代价如实记下：`" a.md"` 与 `"a.md"` 会被当成同一篇。
    //   段**内部**的空格保留（`"my notes/a.md"` 不受影响）。
    const segment = raw.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/** 拆成路径段（已归一）。 */
export function pathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized.length === 0 ? [] : normalized.split("/");
}

/** 拼接并归一（`null` / `undefined` / 空串段直接丢掉）。 */
export function joinPath(...parts: (string | null | undefined)[]): string {
  return normalizePath(parts.filter((part): part is string => Boolean(part && part.length)).join("/"));
}

/** 父目录（根返回 `''`）。 */
export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

/** 最后一段。 */
export function baseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/**
 * 扩展名（小写，含点）。**开头就是点的不算扩展名**（`.gitignore` → `''`）。
 *
 * 与 Node 的 `path.extname` 不同：那里 `.gitignore` 也会给出 `'.gitignore'`。
 * 这里跟客户端既有行为一致（`index <= 0` 就返回空）。
 */
export function extName(path: string): string {
  const name = baseName(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index).toLowerCase();
}

/** 去掉扩展名（保留原字符串的其余部分）。 */
export function stripExtension(path: string): string {
  const ext = extName(path);
  return ext ? path.slice(0, path.length - ext.length) : path;
}

/**
 * 拒绝绝对路径 / `..` / 空字节 / NTFS 备用数据流（段内 `:`）。
 *
 * 这是**明文笔记本的第一道防线**（Node 侧每个写请求都过它）。
 * ⚠️ **模式 B（E2EE）下 Node 看不到明文路径**，只能校验 `did` 的形状 ——
 * 路径安全完全由客户端保证，这是 E2EE 的固有代价（§3.8 防线 1）。
 */
export function assertSafeRelative(input: string): string {
  const value = String(input ?? "");
  if (value.includes("\0")) throw new Error("路径包含非法字符");
  if (/^([a-zA-Z]:|[\\/])/.test(value.trim())) throw new Error("不允许使用绝对路径");
  // D36: Windows 上 `a.md:secret` 是 NTFS 备用数据流——list() 看不到、内容却真实存在，
  // 破坏「文件即笔记」的不变量。
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment.includes(":")) throw new Error("路径不能包含冒号");
  }
  if (value.replace(/\\/g, "/").split("/").includes("..")) throw new Error("路径越界");
  return normalizePath(value);
}

/** 这些段里有没有以 `.` 开头的（隐藏文件 / 目录）。 */
export function isHiddenPath(path: string): boolean {
  return pathSegments(path).some((segment) => segment.startsWith("."));
}

/* ------------------------------------------------------------ base64url */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** UTF-8 编码（自己实现：`TextEncoder` 不在 `lib: ["ES2022"]` 里）。 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    // 组合代理对（emoji 等）：路径里完全可能出现。
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

/** UTF-8 解码；非法字节序列抛错（不静默产出替换字符）。 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index]!;
    let code: number;
    let extra: number;
    if (first < 0x80) {
      code = first;
      extra = 0;
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f;
      extra = 1;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      extra = 2;
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07;
      extra = 3;
    } else {
      throw new Error("不是合法的 UTF-8 字节序列");
    }
    if (index + extra >= bytes.length) throw new Error("UTF-8 字节序列被截断");
    for (let step = 1; step <= extra; step += 1) {
      const next = bytes[index + step]!;
      if ((next & 0xc0) !== 0x80) throw new Error("不是合法的 UTF-8 续字节");
      code = (code << 6) | (next & 0x3f);
    }
    index += extra + 1;
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** base64url（无填充）编码。`+`→`-`、`/`→`_`，**去掉 `=`**（要进 URL 与文档 id）。 */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]!;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** base64url 解码；非法字符 / 被截断的输入抛错。 */
export function base64urlDecode(text: string): Uint8Array {
  const value = String(text ?? "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const digit = B64_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`不是合法的 base64url 字符：${char}`);
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/* ------------------------------------------------------- 文档标识（did） */

/**
 * 模式 A（`crypto_mode='none'`）：`"f:" + base64url(utf8(nfc(path)))`。
 *
 * **为什么用 base64url 而不是裸路径**（§3.3）：
 * - 路径里的 `/` 不必再赌中间层不还原 `%2F`；
 * - `#`、`?`、`%`、空格全部天然安全；
 * - 超长路径不会撞 URL 长度限制；
 * - 人类可读性由 CouchDB view 的 key（明文 `path`）负责，不靠 `_id`。
 *
 * ⚠️ **这是可逆的**（`pathFromLegacyId`）—— 所以它只用于明文笔记本。
 * 真实路径**不做**.trim()：`" a.md"` 与 `"a.md"` 是两篇不同的笔记。
 */
export function idForPath(path: string): string {
  const normalized = normalizePath(normalizeNfc(path));
  return `f:${base64urlEncode(utf8Encode(normalized))}`;
}

/** `idForPath()` 的逆运算（只对合法的 `f:` 前缀有效）。 */
export function pathFromLegacyId(id: string): string {
  const value = String(id ?? "");
  if (!value.startsWith("f:")) throw new Error(`不是模式 A 的文档标识：${value.slice(0, 8)}…`);
  return utf8Decode(base64urlDecode(value.slice(2)));
}

/**
 * 模式 A 的 `did` 形状校验（服务端在**看不到明文路径**时唯一能做的检查）。
 *
 * E2EE 的 `did` 形状（`"h:" + 32 位十六进制）不能在这里校验 —— 那需要 `idKey`。
 * 服务端只校验前缀与字符集，**不尝试解密**（§4.2 红线 3）。
 */
export function isValidPathDocId(id: string): boolean {
  const value = String(id ?? "");
  if (!value.startsWith("f:")) return false;
  const body = value.slice(2);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return false;
  try {
    // 必须能解回一个合法的相对路径，否则形状对但内容是坏的。
    assertSafeRelative(pathFromLegacyId(value));
    return true;
  } catch {
    return false;
  }
}

/** 大小写折叠后的键（用于**检测**折叠冲突，不用于改名）。 */
export function foldCaseKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

/** 笔记类文件（`.md` 一族与 `.txt`）。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|txt)$/i.test(path);
}

/** 图片（附件里最常见的一类，要用 `writeBytes` 而不是 `writeText`）。 */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
}

/**
 * 「这个路径该不该被物化到本地」——**唯一产地**。
 *
 * 只认笔记与图片；其余（源码、配置、CI…）只进基线账本、**永不落地**。
 * 这条判据曾经在 `planPull()` 里漏成「只要远端 sha 变了就下载」，后果不是多下几个文件，
 * 而是**把仓库源码写进笔记本、下一次推送又把它当成新笔记推回去**。
 *
 * 放在 `shared/` 是因为**导入与拉取必须共用同一条**，而它们在单仓下本来就该是同一份。
 */
export function isMaterializable(path: string): boolean {
  return isMarkdownPath(path) || isImagePath(path);
}

export interface CaseFoldCollision {
  /** 折叠后相同的两个路径（按原样返回，不修改）。 */
  a: string;
  b: string;
  /** 折叠后的共同键（大小写不敏感的文件系统上它们**是同一个文件**）。 */
  key: string;
}

/**
 * 两份字节**完全相同**吗（长度 + 逐字节）。
 *
 * 「这个路径已经存在」不等于「里面的内容就是我们的」：附件目录里可能有用户手放的
 * 同名文件，也可能发生（极端的）哈希碰撞。凡是要拿内容当判据的地方都走这一条。
 * 常量时间比较（哈希）会引入「哈希碰撞即误判」的新风险，逐字节比不会。
 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** 文件名安全化，并保留 CJK 可读性。 */
export function sanitizeName(name: string, fallback = "未命名"): string {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

/**
 * `a.md` → `a 2.md`（当 `a.md` 已被占用）。
 *
 * D30：调用方可以要求按大小写折叠比较（Windows / macOS 的磁盘上 `README.md` 与
 * `readme.md` 是同一个文件）。默认保持大小写敏感，因为浏览器 OPFS 实测是大小写
 * 敏感的 ——「哪个后端不敏感」是后端的能力，不能靠平台猜测写死在这里。
 */
export function uniquePath(
  candidate: string,
  taken: Set<string>,
  options: { foldCase?: boolean } = {},
): string {
  const key = (value: string) => (options.foldCase ? value.toLowerCase() : value);
  const has = (value: string): boolean => {
    if (taken.has(value)) return true;
    if (!options.foldCase) return false;
    const folded = key(value);
    for (const entry of taken) {
      if (key(entry) === folded) return true;
    }
    return false;
  };
  if (!has(candidate)) return candidate;
  const dir = parentPath(candidate);
  const ext = extName(candidate);
  const base = baseName(stripExtension(candidate));
  let counter = 2;
  let next = joinPath(dir, `${base} ${counter}${ext}`);
  while (has(next)) {
    counter += 1;
    next = joinPath(dir, `${base} ${counter}${ext}`);
  }
  return next;
}

/**
 * 找出「大小写折叠后重复」的路径（§3.8）。
 *
 * Windows / macOS 的磁盘大小写不敏感，CouchDB 的 `_id` 却**大小写敏感** ⇒ 同名不同大小写
 * 会永久分叉。这里只**检测并报告**，绝不自动改名（改名是用户的决定）。
 */
export function findCaseFoldCollisions(paths: readonly string[]): CaseFoldCollision[] {
  const seen = new Map<string, string>();
  const out: CaseFoldCollision[] = [];
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!normalized) continue;
    const key = foldCaseKey(normalized);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, normalized);
      continue;
    }
    if (previous === normalized) continue; // 同一条路径重复出现，不是冲突
    out.push({ a: previous, b: normalized, key });
  }
  return out;
}
