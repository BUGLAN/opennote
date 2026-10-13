/**
 * 控制台的会话与安全响应头（`docs/执行-三端同步…` §4.6「访问控制」、§7.3 Node 第 2/3 条）。
 *
 * ## 三件事，每一件都有一个容易被写错的细节
 *
 * ### ① 没有登录表单：`authToken` 从「密钥」派生，然后塞进 HttpOnly cookie
 *
 * 控制台与客户端**共用同一个凭据**（§4.6：一个凭据贯穿所有入口）。所以这里是：
 * 浏览器上粘账号密钥 → 页面 JS 用 HKDF 派生 `authToken` → 提交给服务端 → 服务端
 * 把它写进 `HttpOnly` cookie → 之后浏览器每次请求自动带上。
 *
 * ⚠️ **服务端从不生成、也从不返回 `authToken`** —— 它只是把客户端递过来的那个存进 cookie。
 * 这与红线 3 一致：密钥材料只在客户端产生。
 *
 * ### ② CSRF 靠**自定义头**，不靠 token
 *
 * 变更类请求要求 `X-Requested-With: opennote-panel`。跨源页面**无法**在不触发预检的
 * 情况下发送自定义头，而我们的服务端**不发任何 CORS 头**（§2.4），所以预检必然失败。
 * 这比「双提交 cookie / 同步 token」简单，而且**没有状态**（没有会话表就没有 token 表）。
 *
 * ### ③ `Secure` 要跟着 `EXTERNAL_BASE_URL` 走，不能写死
 *
 * 生产是 https（隧道），必须 `Secure`。但本地开发是 `http://localhost:8787`，
 * 写死 `Secure` 会让 cookie **根本存不下来**，而症状是「登录之后立刻又是未登录」——
 * 一个会让人怀疑到自己代码逻辑上的假象。所以按公开地址是否 https 决定。
 *
 * ⚠️ 但**不能**因为「有反代」就放宽：判断依据只看 `EXTERNAL_BASE_URL`，
 * 不看 `X-Forwarded-Proto`（那是可伪造的头，§4.11 U19 的同一教训）。
 */

import type { Context, Next } from "hono";
import type { ServerConfig } from "./config";

/** 控制台 cookie 名。带 `__Host-` 前缀时浏览器会强制要求 `Secure` + `Path=/` + 无 `Domain`。 */
export const PANEL_COOKIE = "opennote_panel";

/**
 * 变更类请求必须带的自定义头（§4.6）。
 *
 * HTTP 头名大小写不敏感，所以比较用小写；但**给人看的文案用规范写法**
 * （`X-Requested-With`）—— 报错信息是要被照着做的，别让人去猜大小写。
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_DISPLAY = "X-Requested-With";
export const CSRF_VALUE = "opennote-panel";

/** 读请求（不需要 CSRF 头）。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 安全响应头（§7.3 Node 第 2 条）。
 *
 * `csp` 是**控制台自己**的策略：它必须能跑自己的 JS（`'self'`），
 * 而**不能**有 `'unsafe-inline'`（那等于把 CSP 关掉）。
 */
export interface SecurityHeaderOptions {
  /** 控制台自己的 CSP。`null` = 不发 CSP（例如静态资源响应）。 */
  csp?: string | null;
  /** 是否强制 https 特性（HSTS）。跟随 `EXTERNAL_BASE_URL`。 */
  https: boolean;
}

/** 控制台页面的 CSP：只允许同源脚本与样式，禁掉内联与一切外部源。 */
export const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  // 控制台不发外部请求（同源部署，§2.4）——`connect-src 'self'` 就是全部。
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** 一组基础安全头（所有响应都发）。 */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  return {
    // ★ `nosniff`：没有它，浏览器可能把用户上传的 `.md`（含脚本）当成 HTML 执行。
    // 这个服务到处在传「用户可控的字节」，所以这一条不是可选项。
    "x-content-type-options": "nosniff",
    // 控制台绝不嵌入 iframe（`frame-ancestors` 是 CSP 版，这里是给老浏览器兜底）。
    "x-frame-options": "DENY",
    // 跨站跳转时不要泄露完整 URL（里面可能带 `nb=` 之类的 id）。
    "referrer-policy": "same-origin",
    // 不给任何不需要的能力（浏览器支持度不一，但代价为零）。
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    ...(options.https
      ? {
          // ★ 只在公开地址是 https 时发：本地 http 开发下发 HSTS 会让浏览器
          // 把 localhost 也升级成 https，然后整个服务在本地就用不了了。
          "strict-transport-security": "max-age=31536000; includeSubDomains",
        }
      : {}),
    ...(options.csp === null ? {} : { "content-security-policy": options.csp ?? PANEL_CSP }),
  };
}

/**
 * CSRF 闸门：变更类请求必须带 `X-Requested-With: opennote-panel`。
 *
 * **只对「带 cookie 的浏览器请求」生效** —— `Authorization: Bearer` 的 API 请求不受影响。
 * 理由：客户端（桌面/Android）用 Bearer，跨源页面**拿不到**那个头，所以它们本来就不受
 * CSRF 影响；而控制台用 cookie，cookie 会被浏览器自动带上，那才是 CSRF 的入口。
 *
 * 换句话说：**这道闸门保护的是 cookie 会话**，不是整个服务。
 */
export function csrfGuard(): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    // 没有 cookie 的请求（纯 Bearer 客户端）不走这条闸门。
    if (!readCookie(c.req.header("cookie"), PANEL_COOKIE)) return next();
    if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
      return new Response(
        JSON.stringify({
          error: `变更类请求必须带 ${CSRF_HEADER_DISPLAY}: ${CSRF_VALUE}（防 CSRF；跨源页面发不出自定义头）`,
          code: "bad-request",
        }),
        { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    return next();
  };
}

/** 从 `Cookie` 头里取一个值（不引依赖：这只需要几行）。 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // 坏编码就当它不存在（不要抛：一个畸形 cookie 不该让请求 500）。
      return null;
    }
  }
  return null;
}

/**
 * 造一个 `Set-Cookie` 值。
 *
 * `HttpOnly` + `SameSite=Lax` + （https 时）`Secure`，`Path=/` 且**不设 `Domain`**
 * —— 于是它只回给这一个 host，`__Host-` 那套约束的精神在这里也成立。
 *
 * `SameSite=Lax`（不是 `Strict`）：控制台要从隧道域名下的链接进来，
 * `Strict` 会让「从别处点链接过来」的第一次请求不带 cookie，表现为「刚登录又要登录」。
 */
export function buildSessionCookie(token: string, options: { https: boolean; maxAgeSeconds?: number }): string {
  const parts = [`${PANEL_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.https) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join("; ");
}

/** 清掉会话 cookie（退出 / 轮换之后）。`Max-Age=0` 立刻失效。 */
export function buildClearCookie(options: { https: boolean }): string {
  return buildSessionCookie("", { https: options.https, maxAgeSeconds: 0 });
}

/** 公开地址是不是 https（决定 `Secure` / HSTS；**不看可伪造的转发头**）。 */
export function isHttps(config: ServerConfig): boolean {
  return config.externalBaseUrl.startsWith("https://");
}
