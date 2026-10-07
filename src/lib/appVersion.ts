/**
 * 应用版本号在渲染层的**唯一产地**。
 *
 * 两个来源，按「描述谁在运行」的可信度取先：
 *   1. 桌面端 preload 注入的 `window.opennote.version`（→ `app.getVersion()` →
 *      打包内 package.json）——它描述**正在运行的二进制**，桌面端永远信它；
 *   2. 构建时 Vite `define` 烧进包里的 `__OPENNOTE_VERSION__`（构建那一刻的根
 *      package.json）——网页版没有 preload，之前关于页只能写「版本未知」，
 *      现在网页包自己带着版本号。同一个根 package.json，不是冒充。
 *
 * 历史：关于页曾硬编码 `v0.2.0`，从 0.3.0 起一直对用户撒谎；后来 preload 的兜底
 * 又拿 **Electron 版本**冒充过（用户会看到 v38.x 并以为那是 Opennote 的版本）。
 * 所以这里宁缺毋滥：两处都读不到时返回 null，由调用方如实显示「版本未知」。
 */
declare const __OPENNOTE_VERSION__: unknown;

export function appVersion(): string | null {
  if (typeof window !== "undefined") {
    const desktop = (window as { opennote?: { version?: unknown } }).opennote;
    if (desktop && typeof desktop.version === "string" && desktop.version) return desktop.version;
  }
  return typeof __OPENNOTE_VERSION__ === "string" && __OPENNOTE_VERSION__ ? __OPENNOTE_VERSION__ : null;
}
