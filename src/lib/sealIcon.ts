/**
 * 侧栏左上角那枚印章的图标地址。
 *
 * 为什么是一张图而不是 CSS 画的方块：以前它是一个 `<span>記</span>` 加背景色 ——
 * 形状取决于机器上有没有宋体/思源宋体（没有就换个字形），也不和窗口/任务栏图标
 * 共用同一个绘制源。现在用 `pnpm icons` 生成的一套真图标（4 套强调色 × 明/暗），
 * 颜色逐字来自 `tokens.css`（见 `scripts/make_icons.py` 的 `read_accent_tokens`）。
 *
 * 路径写成**相对**（`./seal/...`）：桌面版 `base: "./"`、网页版 `VITE_BASE`、
 * 开发服务器三种情形都解析得到 —— 绝对路径 `/seal/...` 在 `file://` 下会指到磁盘根。
 */

import type { AccentId, ThemeKind } from "../data/types";

export function sealIconUrl(accent: AccentId, kind: ThemeKind): string {
  return `./seal/${accent}-${kind}.png`;
}
