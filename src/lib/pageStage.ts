/**
 * 网页版 HTML 页面的**载体**：把页面内容交给 Service Worker，换回一个带独立 CSP 的 URL。
 *
 * ## 为什么要绕这一圈
 *
 * 网页版的主文档 CSP 是构建期写进 `<meta http-equiv>` 的（`vite.config.ts` 的
 * `contentSecurityPolicyPlugin()`）。而 **srcdoc / blob: 子框架会继承父文档的 CSP** ——
 * 于是页面里的内联 `<script>` 会被 `script-src 'self'` 静默挡掉：
 * 布局看起来是对的，但按钮点了没反应、动画不跑，只有 DevTools 里有一行 violation。
 *
 * Service Worker 能在 `/__page/<token>` 上返回一个**自带 CSP** 的响应。
 * 那是一个真实 URL，所以子文档按**它自己的**策略执行，不再继承主页面的策略 ——
 * 与桌面端的 `opennote-page:` 协议是同一个安全模型，只是载体不同。
 *
 * ## 为什么 token 而不是把内容放进 URL
 *
 * 页面可能有几百 KB，塞进 URL 不现实；而且 URL 会进历史记录与日志。
 * token 是**页面侧生成**的一次性随机串，SW 只服务它内存里被 stage 过的那些 ——
 * 没 stage 过的一律 404，所以 SW 不会变成一个「托管任意 HTML」的开放服务。
 */

/** 页面 → SW 的 stage 消息类型。与 `src/sw.ts` 的常量**必须**逐字一致。 */
export const PAGE_STAGE_MESSAGE = "opennote:page:stage";

/** SW 路由前缀。改这里必须同步改 `src/sw.ts` 的匹配规则。 */
export const PAGE_ROUTE_PREFIX = "/__page/";

/** 等 SW 接管当前页面的上限（首次安装时 SW 要装完、激活、claim 才收得到消息）。 */
export const CONTROLLER_WAIT_MS = 8000;

/** stage 之后等 SW 回执的上限。 */
export const STAGE_REPLY_MS = 4000;

export interface PageStageReply {
  type: string;
  token: string;
  ok: boolean;
  /** `ok === false` 时的中文原因（界面直接显示，不要自己编文案）。 */
  reason?: string;
}

/** 只认 SW 回来的、与本次 token 匹配的回执。 */
function isStageReply(data: unknown, token: string): data is PageStageReply {
  if (!data || typeof data !== "object") return false;
  const value = data as Partial<PageStageReply>;
  return value.type === PAGE_STAGE_MESSAGE && value.token === token && typeof value.ok === "boolean";
}

/** 页面侧的 URL：与应用的 `base` 同源同前缀（子路径部署 `VITE_BASE` 也要正确）。 */
export function pageRouteUrl(token: string, baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return base + PAGE_ROUTE_PREFIX.slice(1) + encodeURIComponent(token);
}

/**
 * 等到「当前页面被 SW 接管」。
 *
 * 三种情况都要如实区分，因为它们的**处置不同**：
 *   - 没有 `navigator.serviceWorker`：浏览器不支持（或非安全上下文）→ 调用方走静态降级；
 *   - 有 SW 但一直没有 controller：可能在首次安装 → 等满超时后如实失败（提示刷新），
 *     而不是**假装成功**（假装成功 = 用户看到一个永远转圈或永远空的 iframe）；
 *   - 有 controller：直接用。
 */
export async function waitForController(options: { timeoutMs?: number } = {}): Promise<boolean> {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container) return false;
  if (container.controller) return true;
  const timeoutMs = options.timeoutMs ?? CONTROLLER_WAIT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    /*
     * 用全局的 `setTimeout` / `clearTimeout` 而不是 `window.setTimeout`：
     * 这个模块在**单测里跑在 node 环境**（没有 window），而窗口对象对计时器没有任何用处。
     * 反过来，写 `window.` 会让「同一个函数在浏览器里好好的、在测试里炸」变成默认状态。
     */
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      container.removeEventListener("controllerchange", onChange);
      resolve(ok);
    };
    const onChange = () => finish(Boolean(container.controller));
    const timer = setTimeout(() => finish(Boolean(container.controller)), timeoutMs);
    container.addEventListener("controllerchange", onChange);
  });
}

/**
 * 把页面内容交给 SW，返回可以塞进 `<iframe src>` 的 URL。
 *
 * 失败时返回 `{ ok: false, reason }` 而**不抛**：调用方（`HtmlPageView`）要按原因
 * 显示不同的提示，抛异常只会让它再 catch 一次。
 */
/**
 * 是不是跑在 Capacitor 的原生壳里（手机 App）。
 *
 * 为什么在页面侧看一眼而不是 import `@capacitor/core`：后者会把整个 Capacitor 运行时
 * 打进**网页版**的主包，只为判断一个布尔值。Capacitor 会在页面脚本之前注入
 * `window.Capacitor`，直接读它就够了（读不到 = 不是原生壳，与「网页版」同一分支）。
 */
function isNativeShell(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

export async function stagePage(
  html: string,
  options: { token?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (isNativeShell()) {
    /*
     * 手机壳里**如实说不支持**，而不是等 8 秒超时再报「还没准备好」。
     *
     * 原因：Capacitor 的 WebView 不注册我们的 Service Worker（壳用自己的 scheme 加载页面），
     * 所以「等一等就会好」是假话 —— 等多久都不会好。这条与 C-12 家族的纪律一致：
     * 失败要**按真实原因**说，不能让用户对着一个含糊的提示反复重试。
     */
    return { ok: false, reason: "手机 App 暂不支持在应用内渲染 HTML 页面，请用桌面版或网页版打开" };
  }
  if (!container) return { ok: false, reason: "这个浏览器没有 Service Worker，无法以页面模式显示" };
  const ready = await waitForController();
  // 取一次并**留在这个局部变量里**：`container.controller` 是实时 getter，
  // 等待期间它可能变回 null（SW 被回收），闭包后再读会让类型与事实都失真。
  const controller = container.controller;
  if (!ready || !controller) {
    return { ok: false, reason: "页面模式还没准备好（Service Worker 尚未接管），刷新一次即可" };
  }
  const token = options.token ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
  const reply = await new Promise<PageStageReply | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), options.timeoutMs ?? STAGE_REPLY_MS);
    const onMessage = (event: MessageEvent) => {
      /*
       * 只认**自己窗口或自己那个 SW** 发来的消息，且 token 对得上：
       * 别的页面 / 浏览器扩展广播进来的同类消息一律忽略。
       * （`window` 可能不存在 —— node 测试环境；那时只剩 controller 一条来源，语义仍然正确。）
       */
      const ownWindow = typeof window === "undefined" ? undefined : window;
      if (event.source !== ownWindow && event.source !== controller) return;
      if (!isStageReply(event.data, token)) return;
      clearTimeout(timeout);
      container.removeEventListener("message", onMessage);
      resolve(event.data);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    controller.postMessage({ type: PAGE_STAGE_MESSAGE, token, html });
  });
  if (!reply) return { ok: false, reason: "页面内容没有送到本地缓存（超时），请重试" };
  if (!reply.ok) return { ok: false, reason: reply.reason || "页面内容无法缓存" };
  return { ok: true, url: pageRouteUrl(token, options.baseUrl ?? location.pathname) };
}

/**
 * 页面卸载 / 切标签时撤掉 SW 里那一份内容（不让它长期占着内存）。
 *
 * **不**等待回执：这是清理动作，失败也无妨（SW 侧还有条数上限兜底）。
 */
export function releasePage(token: string): void {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container || !container.controller) return;
  try {
    container.controller.postMessage({ type: PAGE_STAGE_MESSAGE, token, html: null });
  } catch {
    /* 无所谓：SW 侧的条数上限会把它挤掉 */
  }
}
