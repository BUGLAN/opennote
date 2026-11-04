/**
 * 管理接口的鉴权闸门：**同时认 Bearer 与控制台 cookie**（`docs/执行-同步重写-2026-11-02.md` 阶段 ②）。
 *
 * | 来源 | 谁用 | 收什么会话 |
 * | --- | --- | --- |
 * | `Authorization: Bearer ons_…` | 脚本、测试、客户端 | 任意 kind |
 * | `Cookie: opennote_panel=ons_…` | 浏览器里的 `/admin` | 只收 `kind = panel` |
 *
 * cookie 只认控制台会话：设备令牌不该出现在 cookie 里，出现了就当没登录 ——
 * 这样「cookie 会话」与「CSRF 闸门保护的东西」是同一个集合（见 `panelSecurity.csrfGuard`）。
 *
 * 判断「是不是管理员」只看 `accounts.is_admin`，并且发生在**任何业务读之前**（见 `admin.ts` 模块头）。
 */

import type { Context } from "hono";
import { AccountError, type AccountRow, type AccountStore, type SessionRow } from "../auth/accounts";
import { PANEL_COOKIE, readCookie } from "../panelSecurity";
import { bearerToken } from "./auth";

export interface AdminGateDeps {
  accounts: AccountStore;
  now?: () => number;
}

type HeaderSource = Pick<Context, "req"> | { req: { header: (name: string) => string | undefined } };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** 请求里带的会话令牌与来源。Bearer 优先（脚本里同时带了 cookie 也以显式的为准）。 */
export function sessionTokenOf(c: HeaderSource): { token: string; via: "bearer" | "cookie" } | null {
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer) return { token: bearer, via: "bearer" };
  const cookie = readCookie(c.req.header("cookie"), PANEL_COOKIE);
  return cookie ? { token: cookie, via: "cookie" } : null;
}

/** 认证（不判管理员）：控制台的 `/v1/panel/session` 也用它。 */
export function authenticateAdminRequest(
  deps: AdminGateDeps,
  c: HeaderSource,
): { account: AccountRow; session: SessionRow; via: "bearer" | "cookie" } | Response {
  const found = sessionTokenOf(c);
  if (!found) return json({ error: "请先登录", code: "unauthorized" }, 401);
  try {
    const { account, session } = deps.accounts.authenticateSession(found.token, deps.now?.() ?? Date.now());
    if (found.via === "cookie" && session.kind !== "panel") return json({ error: "请先登录", code: "unauthorized" }, 401);
    return { account, session, via: found.via };
  } catch (error) {
    if (error instanceof AccountError) {
      const disabled = error.rejection === "disabled";
      return json({ error: error.message, code: disabled ? "disabled" : "unauthorized" }, disabled ? 403 : 401);
    }
    throw error;
  }
}

/**
 * **管理员闸门。** 返回 `Response` = 拒绝（此刻还没碰过任何业务表）；返回账号 = 通过。
 *
 * 401（没登录）与 403（不是管理员）分开，两者都不透露别的账号的任何信息。
 */
export function createAdminGate(deps: AdminGateDeps): (c: HeaderSource) => AccountRow | Response {
  return (c) => {
    const result = authenticateAdminRequest(deps, c);
    if (result instanceof Response) return result;
    if (result.account.is_admin !== 1) return json({ error: "需要管理员权限", code: "forbidden" }, 403);
    return result.account;
  };
}
