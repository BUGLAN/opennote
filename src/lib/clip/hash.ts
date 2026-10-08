/**
 * 导入信封的三个哈希（`docs/import/02-接口契约-导入信封与通道.md` §4.2）。
 *
 * ```text
 * sourceHash  = "sha256:" + hex(sha256(utf8(source.url ?? "")))[0..16]
 * bodyHash    = "sha256:" + hex(sha256(utf8(normalizeEol(body))))[0..16]
 * contentHash = "sha256:" + hex(sha256(utf8(sourceHash + "\n" + bodyHash)))[0..16]
 * ```
 *
 * 要点（逐条来自契约，不要在别处另写一份实现）：
 * - **只哈希「来源 URL + 正文」**，不哈希 `title` / `tags` / `capturedAt`：同一篇文章
 *   换个标题、补个标签、隔十分钟再剪，仍然应该被认出来；
 * - 哈希前先 `normalizeEol()`，避免 `\r\n` 与 `\n` 的差异造成「同一段文字两个哈希」；
 * - 截断到 16 个十六进制字符（64 bit）。碰撞的后果只是「误判为重复」，对本地笔记应用
 *   而言代价远小于存储完整 256 bit。
 */

import { normalizeEol } from "../utils";

const encoder = new TextEncoder();

/** 十六进制 sha256（小写）。Web Crypto 在浏览器与 Node 18+ 上都是全局可用的。 */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `sha256:` + 前 16 个十六进制字符。 */
export function shortRef(hex: string): string {
  return `sha256:${hex.slice(0, 16)}`;
}

/** `sha256:<16 hex>`，供 `sourceHash` / `bodyHash` / `contentHash` / 前像摘要使用。 */
export async function sha256Ref(data: Uint8Array | string): Promise<string> {
  return shortRef(await sha256Hex(data));
}

export async function sourceHashOf(url: string | null | undefined): Promise<string> {
  return sha256Ref(url ?? "");
}

export async function bodyHashOf(body: string): Promise<string> {
  return sha256Ref(normalizeEol(body));
}

export async function contentHashOf(sourceHash: string, bodyHash: string): Promise<string> {
  return sha256Ref(`${sourceHash}\n${bodyHash}`);
}

/** 附件落盘名前缀：`sha256(bytes)` 的前 8 个十六进制字符（契约 §3.4）。 */
export async function contentHash8(bytes: Uint8Array): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 8);
}

/**
 * 附件落盘名用的 **UUID 形态标识**（0.4.0 用户要求：「默认为 …uuid 命名即可」）。
 *
 * 由**内容**派生（不是随机）：同一份字节永远得到同一个 uuid —— 重试、重复剪藏都命中
 * 同一路径，「同名不覆盖、不堆 `x-2.png` 垃圾」的性质原样保留。
 *
 * 为什么必须换掉旧名：旧名是 `contentHash8 + "-" + 原始名`，而原始名来自图片 URL 末段 ——
 * 有些站点（聊天页/图床）把整条 URL 编成十六进制塞在路径里，于是文件名长成
 * `63e80eb9-68747470733a2f2f7169616e77656e2d7265732e6f73732d636e2d6265696a696e67…`（用户实测截图）。
 *
 * 取 sha256 前 16 字节，按 RFC 4122 摆成 `8-4-4-4-12`：版本位写 5（内容派生），变体位写 10xx。
 */
export async function contentUuid(bytes: Uint8Array): Promise<string> {
  const hex = (await sha256Hex(bytes)).slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8), hex.slice(8, 12), `5${hex.slice(13, 16)}`, `${variant}${hex.slice(17, 20)}`, hex.slice(20, 32)].join(
    "-",
  );
}
