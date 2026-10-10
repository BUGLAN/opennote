import { createStore, useStore } from "../lib/store";
import { DEFAULT_UI, THEMES, clampSidebarWidth, type ThemeId, type UiSettings } from "./types";

export const STORAGE_KEY = "opennote.ui.v1";

/**
 * `localStorage` is not always reachable: when the browser blocks site data
 * (blocked cookies, enterprise policy, some embedded webviews) even *reading*
 * the property throws a `SecurityError`. Every access goes through these two
 * helpers so the app degrades to an in-memory session instead of a white page.
 */
let blockedReason: string | null = null;

function describeStorageError(error: unknown): string {
  if (error instanceof Error && error.message) return `${error.name}：${error.message}`;
  return String(error);
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    blockedReason ??= describeStorageError(error);
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    blockedReason ??= describeStorageError(error);
    /* Settings simply don't persist — the app keeps working in memory. */
  }
}

/** True when the browser refuses `localStorage` (see D04). */
export function isStorageBlocked(): boolean {
  return blockedReason !== null;
}

/** Why storage is unavailable, or `null` when it works. Used for the UI notice. */
export function storageBlockedReason(): string | null {
  return blockedReason;
}

function load(): UiSettings {
  const raw = readItem(STORAGE_KEY);
  if (!raw) return DEFAULT_UI;
  try {
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const ui = { ...DEFAULT_UI, ...parsed };
    // Guard against theme ids removed in a later version.
    if (!THEMES.some((theme) => theme.id === ui.theme)) ui.theme = DEFAULT_UI.theme;
    if (!ui.tabs.every((id) => typeof id === "string")) ui.tabs = [];
    // 只读锁是后来加的键：手改过 localStorage / 旧版本残留都可能不是数组，兜底成「没锁」。
    if (!Array.isArray(ui.lockedNotes) || !ui.lockedNotes.every((id) => typeof id === "string")) {
      ui.lockedNotes = [];
    }
    // 宽度是**用户拖出来的**：旧版本没有这个键、手改过 localStorage、拖到窗口外
    // 都会留下越界值，所以读取时统一夹一次，别让坏值把布局撑坏。
    ui.sidebarWidth = clampSidebarWidth(ui.sidebarWidth);
    // 自动保存模式是白名单枚举；延时夹进 300–5000。坏值一律回默认，别让 localStorage
    // 里的旧数据/手改值把保存节奏带坏。
    if (ui.autoSave !== "afterDelay" && ui.autoSave !== "onFocusChange" && ui.autoSave !== "onWindowChange") {
      ui.autoSave = DEFAULT_UI.autoSave;
    }
    ui.autoSaveDelay = Math.min(5000, Math.max(300, Math.round(Number(ui.autoSaveDelay)) || DEFAULT_UI.autoSaveDelay));
    return ui;
  } catch {
    return DEFAULT_UI;
  }
}

export const uiStore = createStore<UiSettings>(load());

export function useUi(): UiSettings {
  return useStore(uiStore);
}

export function getUi(): UiSettings {
  return uiStore.get();
}

export function patchUi(patch: Partial<UiSettings>): void {
  uiStore.set((prev) => {
    const next = { ...prev, ...patch };
    persist(next);
    applyUi(next);
    return next;
  });
}

function persist(ui: UiSettings): void {
  writeItem(STORAGE_KEY, JSON.stringify(ui));
}

/**
 * First visit: follow the operating system instead of forcing a light page.
 * Only ever writes when nothing was stored before, and never throws when
 * storage is blocked (the choice then simply lasts for this session).
 */
export function applySystemThemeOnFirstVisit(): void {
  const ui = uiStore.get();
  if (ui.theme !== "paper" || ui.appearance !== "light") return;
  if (readItem(STORAGE_KEY)) return; // anything stored (even "") means the user chose before
  if (!systemPrefersDark()) return;
  patchUi({ theme: ui.darkTheme, appearance: "dark" });
}

export function themeKind(id: ThemeId): "light" | "dark" {
  return THEMES.find((theme) => theme.id === id)?.kind ?? "light";
}

export function applyUi(ui: UiSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = ui.theme;
  root.dataset.accent = ui.accent;
  root.dataset.font = ui.font;
  root.dataset.width = ui.width;
  root.dataset.appearance = ui.appearance;
  root.style.setProperty("--doc-fs", `${ui.fontSize}px`);
  root.style.setProperty("--doc-lh", String(ui.lineHeight));
  // 侧栏宽度是**用户拖出来的尺寸**，和 `--doc-fs` 一样只能走内联自定义属性：
  // 桌面端展开态的列宽、移动端抽屉里的行宽都读同一个名字。
  root.style.setProperty("--sidebar-w", `${clampSidebarWidth(ui.sidebarWidth)}px`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", ui.appearance === "dark" ? "#14120f" : "#fbf8f3");
  }
  if (ui.font === "wenkai") ensureWenkaiFont();
}

let wenkaiRequested = false;

/** 霞鹜文楷 is a ~20 MB CJK family — fetch it on demand, never on first paint. */
function ensureWenkaiFont(): void {
  if (wenkaiRequested || typeof document === "undefined") return;
  wenkaiRequested = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css";
  link.crossOrigin = "anonymous";
  link.onerror = () => console.info("[opennote] 霞鹜文楷加载失败，已回退到系统楷体");
  document.head.appendChild(link);
}

export function toggleAppearance(): void {
  const ui = uiStore.get();
  const next: ThemeId = ui.appearance === "dark" ? ui.lightTheme : ui.darkTheme;
  patchUi({
    appearance: ui.appearance === "dark" ? "light" : "dark",
    theme: next,
    lightTheme: ui.appearance === "light" ? ui.theme : ui.lightTheme,
    darkTheme: ui.appearance === "dark" ? ui.theme : ui.darkTheme,
  });
}

export function setTheme(id: ThemeId): void {
  const ui = uiStore.get();
  const kind = themeKind(id);
  patchUi({
    theme: id,
    appearance: kind,
    lightTheme: kind === "light" ? id : ui.lightTheme,
    darkTheme: kind === "dark" ? id : ui.darkTheme,
  });
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}
