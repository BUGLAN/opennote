/**
 * 限流（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.11）。
 *
 * ## 三条与直觉相反的纪律
 *
 * ### ① **按账号限流，不按 socket IP**
 *
 * 出站隧道下，所有请求的来源地址都是**边缘的地址**（同一个 IP）。按 IP 限流会把
 * 「所有用户」当成一个人，于是第一个活跃用户就能把其他人全挡在外面。
 * 所以主限流维是**账号**（`accountId`），IP 只用于**全局限流兜底**。
 *
 * ⚠️ 但兜底那条必须拿到**真实的对端地址**：可信代理头（`cf-connecting-ip`）
 * 只在真的经过那个边缘时才存在。直连 `:8787` 的客户端不带它 —— 那时若不退回
 * socket 地址，所有直连客户端会共用一个 `unknown` 桶（实测事故：两台设备 +
 * 全体用户抢同一份 600/分钟，同步必然 429）。`app.ts` 负责这个兜底。
 *
 * ### ② 它的目的是**防 DoS，不是防爆破**
 *
 * 密钥即身份 ⇒ `authToken` 有 2²⁵⁶ 空间 ⇒ 撞库在数学上不可行 ⇒ **不需要撞库防护**
 * （§1.5「为什么不需要口令哈希」的同一推论）。限流要挡的是：
 * 一个坏掉的客户端疯狂重试、或者一个账号把库打满。
 *
 * ### ③ **令牌桶，不是固定窗口**（2026-10-22 改）
 *
 * 同步的流量形状是「先憋一大波、然后安静」：换设备/首次接入时**一篇笔记 = 一个请求**，
 * 500 篇就是 500 个请求在几秒内发出。固定窗口（每分钟 N 个，且**没有突发额度**）
 * 对这种流量只有一个结果：前 20 秒吃满、后 40 秒全员罚站 —— 客户端还会按
 * `Retry-After` 干等 30+ 秒，用户看到的是「同步卡死」。
 *
 * 令牌桶把「平均速率」与「突发容量」分成两个可解释的量：
 *
 * | 量 | 含义 | 谁需要关心 |
 * | --- | --- | --- |
 * | `perMinute` | 长期平均速率（挡住跑飞的循环） | 运维 |
 * | `burst` | 能一次性放行多少（吸收「首同步」那一波） | 运维 |
 *
 * 桶空之后的 `Retry-After` 是**再攒出一个令牌**的时间（通常 1~2 秒），
 * 而不是「等到下一个整分钟」—— 后者会把一次小突发放大成 30~60 秒的空转。
 */

import type { Context, Next } from "hono";

export interface RateLimitOptions {
  /** 长期平均速率：每分钟允许多少个请求。 */
  perMinute: number;
  /**
   * 桶容量 = **允许的突发量**。默认取 `perMinute / 10`（且至少 20）。
   *
   * 为什么不设成 `perMinute` 本身：那等于「一分钟的量可以在一秒内打完」，
   * 一个跑飞的客户端仍能把服务端打满。10 秒的量足够吸收「首同步那一波」。
   */
  burst?: number;
  /** 从请求里取限流键（返回 `null` = 这次不计入）。 */
  keyOf: (c: Context) => string | null;
  /** 当前时间（测试可注入）。 */
  now?: () => number;
}

interface Bucket {
  /** 当前令牌数（浮点：按毫秒补充）。 */
  tokens: number;
  /** 上次补充的时刻。 */
  updatedAt: number;
}

/**
 * 造一个内存令牌桶限流中间件。
 *
 * 超限时返回 **429** + `Retry-After`（秒）+ `x-ratelimit-limit` / `x-ratelimit-burst`
 * —— 客户端据此知道「等多久」以及「自己撞的是哪一档」，而不是盲退。
 */
export interface RateLimiter {
  (c: Context, next: Next): Promise<Response | void>;
  /** 当前桶数（证明定期清理真的在跑，而不是无限增长）。 */
  size(): number;
}

export function rateLimit(options: RateLimitOptions): RateLimiter {
  const perMinute = Math.max(1, Math.floor(options.perMinute));
  const burst = Math.max(1, Math.floor(options.burst ?? Math.max(20, Math.floor(perMinute / 10))));
  const now = options.now ?? (() => Date.now());
  const tokensPerMs = perMinute / 60_000;
  const buckets = new Map<string, Bucket>();

  /*
   * 定期清理过期桶。**必须清理**：每个 key 一个桶，不清理就是一条内存泄漏路径
   * （攻击者用随机 accountId 就能把表撑大 —— 而那时我们连「谁在攻击」都不知道）。
   *
   * 判据是「这桶就算一直空着也早该满了」—— 满了的桶与新桶没有区别。
   */
  const idleMs = Math.ceil(burst / tokensPerMs) + 60_000;
  let lastSweep = now();

  const sweep = (at: number): void => {
    if (at - lastSweep < 60_000) return;
    lastSweep = at;
    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt >= idleMs) buckets.delete(key);
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

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: burst, updatedAt: at };
      buckets.set(key, bucket);
    } else {
      // 先按流逝的时间补充（封顶 burst），再判断够不够一个。
      const elapsed = Math.max(0, at - bucket.updatedAt);
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * tokensPerMs);
      bucket.updatedAt = at;
    }

    if (bucket.tokens < 1) {
      /*
       * ★ `Retry-After` = **再攒出一个令牌**的时间，不是「等到下一分钟」。
       * 取 1 秒起点：只差一点点的请求不该被罚等一整秒以上。
       */
      const waitMs = Math.ceil((1 - bucket.tokens) / tokensPerMs);
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      return new Response(JSON.stringify({ error: "请求过于频繁，请稍后重试", code: "too-many" }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(retryAfter),
          // 客户端据此判断「撞的是哪一档」：账号桶 vs 全局桶。
          "x-ratelimit-limit": String(perMinute),
          "x-ratelimit-burst": String(burst),
        },
      });
    }

    bucket.tokens -= 1;
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
 * 全局兜底限流的键（§4.11、U19）。
 *
 * 优先用**配置里声明过的代理头**；拿不到就由调用方给一个**socket 对端地址**
 * （直连 `:8787` 的客户端没有 `cf-connecting-ip`，但它的对端地址是真实的）。
 * 两者都没有才退回 `unknown` —— 那时所有这样的请求共享一个桶，
 * 比按一个可伪造的头分桶安全：后者等于给攻击者一个「换头就换桶」的开关。
 */
export function globalRateLimitKey(clientIp: string | null): string {
  return `ip:${clientIp ?? "unknown"}`;
}

/** 只读快照（诊断/测试用）。 */
export interface RateLimitSnapshot {
  buckets: number;
}
