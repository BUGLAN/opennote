/**
 * 限流与装配的用例（`docs/执行-三端同步…` §4.11、§2.4、§10.1 M12）。
 *
 * 限流的用例要钉住的**不是「能不能限」**，而是几条容易被写错的纪律：
 *
 * 1. **按账号限流，不按 IP** —— 隧道下所有请求的来源地址都是**边缘的地址**，
 *    按 IP 限流等于「第一个活跃用户把其他人全挡在外面」；
 * 2. **取不到键时放行**（fail-open）—— 一个取键失败不该把整个服务锁死；
 * 3. **令牌桶要吸收突发**（`burst`），而不是「前 20 秒吃满、后 40 秒全员罚站」；
 * 4. **桶会定期清理**（否则就是一条内存泄漏路径）。
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { globalRateLimitKey, rateLimit, rateLimitKeyFromHeader } from "./ratelimit";

const shortHash = (value: string): string => `h(${value.slice(0, 6)})`;

/** 造一个最小的 Hono 应用，把中间件挂上。 */
function makeApp(options: Parameters<typeof rateLimit>[0]): Hono {
  const app = new Hono();
  app.use("*", rateLimit(options));
  app.get("/ok", (c) => c.text("ok"));
  return app;
}

describe("令牌桶限流", () => {
  it("突发容量内全放行，超出 → 429 且 `Retry-After` = **再攒一个**的时间", async () => {
    let clock = 1_000_000;
    // 每分钟 60 个 = 每秒 1 个；桶容量 3。
    const app = makeApp({ perMinute: 60, burst: 3, keyOf: () => "k", now: () => clock });

    for (let index = 1; index <= 3; index += 1) {
      const response = await app.request("http://localhost/ok");
      expect(response.status, `第 ${index} 次应当放行（在突发容量内）`).toBe(200);
    }
    const blocked = await app.request("http://localhost/ok");
    expect(blocked.status).toBe(429);
    // ★ 不是「等到下一分钟」（那会把一次小突发放大成几十秒空转），而是「再攒 1 个」。
    expect(blocked.headers.get("retry-after")).toBe("1");
    // 客户端据此知道撞的是哪一档。
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("60");
    expect(blocked.headers.get("x-ratelimit-burst")).toBe("3");
    expect(((await blocked.json()) as { code: string }).code).toBe("too-many");

    // 一秒后攒出一个令牌。
    clock += 1_000;
    expect((await app.request("http://localhost/ok")).status).toBe(200);
  });

  it("补充是**按流逝时间连续**的，不是整秒跳变", async () => {
    let clock = 1_000_000;
    const app = makeApp({ perMinute: 60, burst: 5, keyOf: () => "k", now: () => clock });
    for (let index = 0; index < 5; index += 1) await app.request("http://localhost/ok");
    expect((await app.request("http://localhost/ok")).status).toBe(429);

    clock += 2_000; // 2 秒 = 2 个令牌
    expect((await app.request("http://localhost/ok")).status).toBe(200);
    expect((await app.request("http://localhost/ok")).status).toBe(200);
    expect((await app.request("http://localhost/ok")).status).toBe(429);
  });

  it("空闲足够久之后桶回满（不会永久降级）", async () => {
    let clock = 1_000_000;
    const app = makeApp({ perMinute: 60, burst: 4, keyOf: () => "k", now: () => clock });
    for (let index = 0; index < 6; index += 1) await app.request("http://localhost/ok");
    clock += 10_000;
    for (let index = 0; index < 4; index += 1) {
      expect((await app.request("http://localhost/ok")).status, "回满后应当放行满 burst").toBe(200);
    }
    expect((await app.request("http://localhost/ok")).status).toBe(429);
  });

  it("不同键各自计数（一个账号超限不影响另一个）", async () => {
    let key = "a";
    const app = makeApp({ perMinute: 60, burst: 1, keyOf: () => key });
    expect((await app.request("http://localhost/ok")).status).toBe(200);
    expect((await app.request("http://localhost/ok")).status).toBe(429);
    // 换个人：照样能用 —— 这正是「按账号限流」的意义。
    key = "b";
    expect((await app.request("http://localhost/ok")).status).toBe(200);
  });

  it("`keyOf` 返回 `null` ⇒ **放行且不记账**（fail-open）", async () => {
    const app = makeApp({ perMinute: 1, burst: 1, keyOf: () => null });
    for (let index = 0; index < 5; index += 1) {
      expect((await app.request("http://localhost/ok")).status).toBe(200);
    }
  });

  it("**桶会定期清理**（否则随机 key 就能把内存撑大）", async () => {
    let clock = 1_000_000;
    let counter = 0;
    const limiter = rateLimit({ perMinute: 60, burst: 5, keyOf: () => `k${(counter += 1)}`, now: () => clock });
    const app = new Hono();
    app.use("*", limiter);
    app.get("/ok", (c) => c.text("ok"));

    for (let index = 0; index < 10; index += 1) await app.request("http://localhost/ok");
    expect(limiter.size()).toBe(10);
    // 推进得足够久：空桶也早该回满了，与新桶没有区别。
    clock += 200_000;
    await app.request("http://localhost/ok");
    expect(limiter.size()).toBe(1);
  });

  it("`perMinute` / `burst` 非正数被夹到 1（别让它变成「谁都能用」）", async () => {
    const app = makeApp({ perMinute: 0, burst: 0, keyOf: () => "k" });
    expect((await app.request("http://localhost/ok")).status).toBe(200);
    expect((await app.request("http://localhost/ok")).status).toBe(429);
  });

  it("默认突发容量 = 每分钟速率的 1/10（至少 20）", async () => {
    let clock = 1_000_000;
    // 600/分钟 ⇒ 默认 burst = 60。
    const limiter = rateLimit({ perMinute: 600, keyOf: () => "k", now: () => clock });
    const app = new Hono();
    app.use("*", limiter);
    app.get("/ok", (c) => c.text("ok"));
    let allowed = 0;
    for (let index = 0; index < 80; index += 1) {
      if ((await app.request("http://localhost/ok")).status === 200) allowed += 1;
    }
    expect(allowed).toBe(60);
  });
});

describe("§4.11 · 限流键的取法", () => {
  it("按 **Bearer 令牌的短哈希**取键，而不是原串（内存里不该有可用凭据）", async () => {
    const app = new Hono();
    app.get("/ok", (c) => c.text("x"));
    expect((await app.request("http://localhost/ok", { headers: { authorization: "Bearer secret-token-value" } })).status).toBe(200);

    const fakeContext = { req: { header: () => "Bearer secret-token-value" } };
    const key = rateLimitKeyFromHeader(fakeContext as never, shortHash);
    // 键里只该有**短哈希**，不该有令牌原文。
    expect(key).toContain("h(secret");
    expect(key).not.toContain("secret-token-value");
  });

  it("没有 / 畸形 Authorization 头 → `null`（不记账，而不是建一个共用桶）", () => {
    for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer   "]) {
      const fake = { req: { header: () => header } };
      expect(rateLimitKeyFromHeader(fake as never, shortHash)).toBeNull();
    }
  });

  it("全局兜底键：**可信头 → socket 地址 → unknown** 三级退化", () => {
    // 可信头（真机是 cf-connecting-ip）优先。
    expect(globalRateLimitKey("1.2.3.4")).toBe("ip:1.2.3.4");
    // 直连 `:8787` 的客户端没有可信头 —— 调用方传 socket 地址，于是它仍按自己分桶。
    expect(globalRateLimitKey("203.0.113.9")).toBe("ip:203.0.113.9");
    // 两者都没有（测试里的 `app.request()`、或拿不到 socket）：才退回共用桶。
    expect(globalRateLimitKey(null)).toBe("ip:unknown");
  });
});

describe("应用装配（§2.4）", () => {
  /*
   * ⚠️ **只装配一次**，两条用例共用。
   *
   * 第一版每条用例都自己 `createApp()`，而它内部会开一个 SQLite 句柄、
   * 建两个 CouchDB 客户端（都带连接池）。几十次加起来足以把 vitest 的
   * worker 池拖到别的文件开始**超时**（实测 `workspaces.test.ts` 报
   * 「Test timed out in 5000ms」——和它自己的逻辑毫无关系）。
   * 这类「测试互相拖垮」的现象很难查：失败信息指向完全无关的文件。
   */
  let built: Awaited<ReturnType<typeof buildApp>> | null = null;
  const appOf = async () => (built ??= await buildApp());

  it("装配出来的 app 真的挂上了各条路由（不是「函数存在」这种空断言）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = await appOf();

    // ① 公开健康检查：**不需要令牌**就要能打（隧道/监控靠它）。
    const health = await app.request("http://localhost/v1/health");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { protocolVersion: number }).protocolVersion).toBe(1);

    // ② 受保护路由：没有令牌 → 401（说明它确实挂上了，而不是落到 404）。
    expect((await app.request("http://localhost/v1/account")).status).toBe(401);
    expect((await app.request("http://localhost/v1/notebooks")).status).toBe(401);
    expect((await app.request("http://localhost/v1/admin/accounts")).status).toBe(401);

    // ③ 未知路径 404（与「挂上了但被拒」区分开）。
    expect((await app.request("http://localhost/v1/nope")).status).toBe(404);

    // ④ 装配把 store 也一并交出来了（CLI / 控制台要复用同一份）。
    expect(built!.accounts).toBeTruthy();
    expect(built!.notebooks).toBeTruthy();
  });

  it("**不发 CORS 头**（同源部署；一个宽泛的 `*` 会让任意网页拿用户凭据打我们的 API）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = await appOf();

    // 带 `Origin` 的请求（浏览器跨域时会带）：响应里**不该**出现任何 CORS 放行头。
    const response = await app.request("http://localhost/v1/health", { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

/** 装配一个测试用 app（假 CouchDB + 内存 SQLite）。 */
async function buildApp() {
  const { createApp } = await import("./app");
  const { openDatabase } = await import("./db");
  const { loadConfig } = await import("./config");
  const { FakeCouch, couchClient } = await import("./couch/fakeCouch.test-helper");
  const fake = new FakeCouch();
  return createApp({
    config: loadConfig({
      EXTERNAL_BASE_URL: "https://notes.example.com",
      COUCH_URL: "http://couchdb:5984",
      COUCH_USER: "sync-service",
      COUCH_PASSWORD: "pw",
      COUCH_ADMIN_USER: "admin",
      COUCH_ADMIN_PASSWORD: "apw",
    }),
    db: openDatabase({ path: ":memory:" }),
    couch: couchClient(fake),
    couchAdmin: couchClient(fake),
  });
}

describe("兜底 404 / 500 的形状", () => {
  it("未知路径返回**与其它错误一致**的 `{error, code}` 形状", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = await buildApp();

    const notFound = await app.request("http://localhost/v1/definitely-not-a-route");
    expect(notFound.status).toBe(404);
    const body = (await notFound.json()) as { error: string; code: string };
    expect(body.code).toBe("not-found");
    expect(body.error).toContain("没有这个接口");
  });
});
