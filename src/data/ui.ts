import { createStore, useStore } from "../lib/store";
import { DEFAULT_UI, THEMES, type ThemeId, type UiSettings } from "./types";

const STORAGE_KEY = "opennote.ui.v1";

function load(): UiSettings {
  if (typeof localStorage === "undefined") return DEFAULT_UI;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_UI;
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const ui = { ...DEFAULT_UI, ...parsed };
    // Guard against theme ids removed in a later version.
    if (!THEMES.some((theme) => theme.id === ui.theme)) ui.theme = DEFAULT_UI.theme;
    if (!ui.tabs.every((id) => typeof id === "string")) ui.tabs = [];
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
  } catch {
    /* storage may be full or blocked — the app still works in this session */
  }
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
