/**
 * 限流（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.11）。
 *
 * ## 两条与直觉相反的纪律
 *
 * ### ① **按账号限流，不按 socket IP**
 *
 * 出站隧道下，所有请求的来源地址都是**边缘的地址**（同一个 IP）。按 IP 限流会把
 * 「所有用户」当成一个人，于是第一个活跃用户就能把其他人全挡在外面。
 * 所以主限流维是**账号**（`accountId`），IP 只用于**全局限流兜底**。
 *
 * ### ② 它的目的是**防 DoS，不是防爆破**
 *
 * 密钥即身份 ⇒ `authToken` 有 2²⁵⁶ 空间 ⇒ 撞库在数学上不可行 ⇒ **不需要撞库防护**
 * （§1.5「为什么不需要口令哈希」的同一推论）。限流要挡的是：
 * 一个坏掉的客户端疯狂重试、或者一个账号把库打满。
 *
 * ## 为什么不用漏桶/令牌桶
 *
 * 固定窗口 + 内存计数足够挡「疯狂重试」，而它**没有**令牌桶那套「桶大小 / 补充速率」
 * 两个需要调参的量。这个服务的正确性不依赖限流的精确度 —— 依赖它的是**可用性**，
 * 所以取「便宜、可解释、不容易配错」的那一个。
 */

import type { Context, Next } from "hono";

export interface RateLimitOptions {
  /** 窗口长度（毫秒）。默认 60 秒。 */
  windowMs?: number;
  /** 窗口内允许的请求数。 */
  limit: number;
  /** 从请求里取限流键（返回 `null` = 这次不计入）。 */
  keyOf: (c: Context) => string | null;
  /** 当前时间（测试可注入）。 */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 造一个内存固定窗口限流中间件。
 *
 * 返回的中间件在超限时直接返回 **429** + `Retry-After`（秒）—— 明确的头比只给状态码有用
 * （客户端可以据此退避，而不是马上再撞一次）。
 */
export interface RateLimiter {
  (c: Context, next: Next): Promise<Response | void>;
  /** 当前桶数（证明定期清理真的在跑，而不是无限增长）。 */
  size(): number;
}

export function rateLimit(options: RateLimitOptions): RateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const limit = Math.max(1, Math.floor(options.limit));
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();
  /*
   * 定期清理过期桶。**必须清理**：每个 accountId 一个桶，不清理就是一条内存泄漏路径
   * （攻击者用随机 accountId 就能把表撑大 —— 而那时我们连「谁在攻击」都不知道）。
   */
  let lastSweep = now();

  const sweep = (at: number): void => {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  };

  const middleware = (async (c: Context, next: Next) => {
    const key = options.keyOf(c);
    if (key === null) {
      // 取不到键（例如健康检查）：**放行**而且**不记账**。
      // 这里刻意不 fail-closed —— 否则一个取键失败会把整个服务锁死。
      return next();
    }
    const at = now();
    sweep(at);

    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= at) {
      buckets.set(key, { count: 1, resetAt: at + windowMs });
      return next();
    }
    existing.count += 1;
    if (existing.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - at) / 1000));
      return new Response(JSON.stringify({ error: "请求过于频繁，请稍后重试", code: "too-many" }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(retryAfter),
          "x-ratelimit-limit": String(limit),
        },
      });
    }
    return next();
  }) as RateLimiter;

  middleware.size = () => buckets.size;
  return middleware;
}

/**
 * 从 `Authorization: Bearer <token>` 派生限流键。
 *
 * ⚠️ **不解析令牌、不查库** —— 这里只是拿它当一个高熵的稳定键（`sha256` 前 16 位）。
 * 理由有两条：
 *   1. 限流必须**比认证更便宜**，否则它自己就是 DoS 面；
 *   2. 未认证的请求也要能按「同一个假令牌」被限住（否则伪造令牌刷接口就没有成本）。
 *
 * 用 `sha256` 而不是原串：内存里的键不该是可用的凭据（内存转储 / 日志泄露时更安全）。
 */
export function rateLimitKeyFromHeader(c: Context, hash: (value: string) => string): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return `bearer:${hash(match[1]!.trim())}`;
}

/**
 * 全局兜底限流的键：**只信任配置里声明过的代理头**（§4.11、U19）。
 *
 * 拿不到就退回 `unknown`（所有这样的请求共享一个桶）—— 比按一个可伪造的头分桶安全：
 * 后者等于给攻击者一个「换头就换桶」的开关。
 */
export function globalRateLimitKey(trustedIp: string | null): string {
  return `ip:${trustedIp ?? "unknown"}`;
}

/** 只读快照（诊断/测试用）。 */
export interface RateLimitSnapshot {
  buckets: number;
}
