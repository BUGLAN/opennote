/**
 * 画布节点 / 边的 id 生成。
 *
 * JSON Canvas 对 id 形态没有硬性要求；Obsidian 落盘用的是 16 位十六进制串，
 * 这里保持同款形态（小写 hex、16 位），让手工编辑过 .canvas 的用户在两边看到
 * 一致的观感。随机性来自 crypto（浏览器与 Node 20+ 都有全局 crypto），
 * 退化路径是 Math.random —— 只影响不可预测性，不影响形态。
 */

const HEX = "0123456789abcdef";
const ID_LENGTH = 16;

function randomHexId(): string {
  const bytes = new Uint8Array(ID_LENGTH / 2);
  const globalCrypto = typeof crypto !== "undefined" ? crypto : undefined;
  if (globalCrypto?.getRandomValues) {
    globalCrypto.getRandomValues(bytes);
    let out = "";
    for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 0x0f];
    return out;
  }
  let out = "";
  for (let i = 0; i < ID_LENGTH; i += 1) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

/** 新节点 id；alreadyTaken 里出现过的 id 会让位（防御手工编辑造成的撞号）。 */
export function newCanvasNodeId(alreadyTaken: Iterable<string> = []): string {
  const taken = new Set(alreadyTaken);
  let id = randomHexId();
  while (taken.has(id)) id = randomHexId();
  return id;
}

/** 新边 id；语义同 {@link newCanvasNodeId}。 */
export function newCanvasEdgeId(alreadyTaken: Iterable<string> = []): string {
  const taken = new Set(alreadyTaken);
  let id = randomHexId();
  while (taken.has(id)) id = randomHexId();
  return id;
}
