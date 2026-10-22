import type { WidthId } from "./types";
import { normalizeContentWidth } from "../lib/contentWidth";

/**
 * 「正文栏宽度」的持久化与 CSS 变量应用。
 *
 * 与 `sidebarWidth` 不同，正文栏宽度**不写进 UiSettings**：它是一个覆盖值，只在
 * 「用户拖过」之后才存在。默认状态必须让 CSS 里的 `[data-width]` 预设继续生效，
 * 所以这里用单独一个 localStorage 键，并且记录**拖拽发生时**的栏宽预设：
 * 用户后来在设置里把「栏宽」从「标准」改成「宽」，旧的自定义宽度就不该再把
 * 「宽」盖回去 —— 此时整条记录直接作废。
 *
 * 值的形状：`{ width: number; preset: WidthId }`。只存数字，不存 JSON 以外的东西；
 * 解析失败、键不存在、preset 对不上都当作「没有自定义宽度」。
 */
export const CONTENT_WIDTH_STORAGE_KEY = "opennote.contentWidth.v1";

interface StoredContentWidth {
  width: number;
  preset: WidthId;
}

/** localStorage 在隐私模式 / 企业策略下可能连读都抛异常：与 data/ui.ts 同一条降级路径。 */
function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 存不下就只在本次会话里生效，正文编辑不受影响。 */
  }
}

/**
 * 读取当前栏宽预设下保存的自定义宽度；没有 / 坏了 / 预设变了都返回 `null`。
 *
 * 预设对不上时顺手把记录删掉：下一次切回旧预设也不该让一个「消失很久」的宽度复活。
 */
export function readContentWidthPreference(preset: WidthId): number | null {
  const raw = readItem(CONTENT_WIDTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredContentWidth>;
    if (parsed.preset !== preset) {
      writeItem(CONTENT_WIDTH_STORAGE_KEY, null);
      return null;
    }
    return normalizeContentWidth(parsed.width);
  } catch {
    writeItem(CONTENT_WIDTH_STORAGE_KEY, null);
    return null;
  }
}

/** 保存自定义宽度；传 `null` = 清除（双击拖拽条 / 切换栏宽预设）。 */
export function writeContentWidthPreference(width: number | null, preset: WidthId): void {
  if (width === null || !Number.isFinite(width)) {
    writeItem(CONTENT_WIDTH_STORAGE_KEY, null);
    return;
  }
  writeItem(CONTENT_WIDTH_STORAGE_KEY, JSON.stringify({ width: Math.round(width), preset } satisfies StoredContentWidth));
}

/**
 * 把自定义宽度写到 `:root` 的 `--measure-override` 上。
 *
 * **刻意不覆盖 `--measure` 本身**：`--measure` 是「栏宽预设」的产地（tokens.css 的
 * `[data-width]` 规则），保留它我们才能随时算出默认宽度（双击恢复、最小宽度）。
 * 各消费方写成 `max-width: var(--measure-override, var(--measure))`，只在有覆盖值时
 * 才走覆盖值。
 */
export function applyContentWidthOverride(width: number | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (width === null || !Number.isFinite(width)) root.style.removeProperty("--measure-override");
  else root.style.setProperty("--measure-override", `${Math.round(width)}px`);
}

