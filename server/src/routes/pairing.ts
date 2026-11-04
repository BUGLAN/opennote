/**
 * `/v1/pairing*`：「添加设备」的 6 位码配对（`docs/执行-同步重写-2026-11-02.md` 阶段 ④）。
 * 协议与「服务器看不到什么」见 `auth/pairing.ts` 模块头。
 *
 * | 接口 | 谁调 | 鉴权 |
 * | --- | --- | --- |
 * | `POST /pairing` | 已登录的设备 A | 会话令牌 |
 * | `GET /pairing/:id` · `POST /pairing/:id/approve` · `/reject` | A | 会话令牌（同一账号） |
 * | `POST /pairing/claim` · `POST /pairing/:id/result` | 新设备 B | 无（6 位码 / 认领票就是凭据） |
 *
 * B 拿到的是一条**自己的**设备会话（和密码登录发的一样），A 的令牌从不离开 A。
 */

import { Hono, type Context } from "hono";
import {
  pairingApproveRequestSchema,
  pairingClaimRequestSchema,
  pairingCreateRequestSchema,
  pairingResultRequestSchema,
} from "../../../shared/contract";
import { AccountError, type AccountRow, type AccountStore, type SessionRow } from "../auth/accounts";
import { PairingError, type PairingStore } from "../auth/pairing";
import { clientIpFrom, type ServerConfig } from "../config";
import type { NotebookStore } from "../notebooks";
import type { SettingsStore } from "../settings";
import { accountErrorResponse, bearerToken, issueDeviceSession } from "./auth";

export interface PairingRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  settings: SettingsStore;
  pairings: PairingStore;
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
  now?: () => number;
}

export function createPairingRoutes(deps: PairingRoutesDeps): Hono {
  const routes = new Hono();
  const now = (): number => deps.now?.() ?? Date.now();
  const json = (body: unknown, status: number): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const ipOf = (c: Context): string | null => clientIpFrom(c.req.raw.headers, deps.config);

  const parse = async <T>(c: Context, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }): Promise<T | Response> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? parsed.data : json({ error: parsed.error.issues[0]?.message ?? "请求体形状不对", code: "bad-request" }, 400);
  };

  const authenticate = (c: Context): { account: AccountRow; session: SessionRow } | Response => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    try {
      return deps.accounts.authenticateSession(token, now());
    } catch (error) {
      if (error instanceof AccountError) return accountErrorResponse(error);
      throw error;
    }
  };

  const pairingError = (error: unknown): Response => {
    if (!(error instanceof PairingError)) throw error;
    const status = { "not-found": 404, "too-many": 429, state: 409, throttled: 429 }[error.reason];
    return json({ error: error.message, code: error.reason }, status);
  };

  /* ---------------------------------------------------------- A：发起 / 查看 / 确认 */

  routes.post("/pairing", async (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const body = await parse(c, pairingCreateRequestSchema);
    if (body instanceof Response) return body;
    try {
      const created = deps.pairings.create({ accountId: auth.account.id, initiatorDeviceId: auth.session.device_id, publicKey: body.publicKey, now: now() });
      return json(created, 201);
    } catch (error) {
      return pairingError(error);
    }
  });

  routes.get("/pairing/:id", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    try {
      const pairing = deps.pairings.get(c.req.param("id"), auth.account.id, now());
      return json(
        {
          status: pairing.status,
          expiresAt: pairing.expiresAt,
          device: pairing.device ? { name: pairing.device.name, platform: pairing.device.platform, os: pairing.device.os ?? null } : null,
          publicKey: pairing.claimantKey,
        },
        200,
      );
    } catch (error) {
      return pairingError(error);
    }
  });

  routes.post("/pairing/:id/approve", async (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    const body = await parse(c, pairingApproveRequestSchema);
    if (body instanceof Response) return body;
    try {
      deps.pairings.approve(c.req.param("id"), auth.account.id, body.sealed, now());
      return json(null, 204);
    } catch (error) {
      return pairingError(error);
    }
  });

  routes.post("/pairing/:id/reject", (c) => {
    const auth = authenticate(c);
    if (auth instanceof Response) return auth;
    try {
      deps.pairings.reject(c.req.param("id"), auth.account.id, now());
      return json(null, 204);
    } catch (error) {
      return pairingError(error);
    }
  });

  /* ---------------------------------------------------------- B：认领 / 取结果 */

  routes.post("/pairing/claim", async (c) => {
    const body = await parse(c, pairingClaimRequestSchema);
    if (body instanceof Response) return body;
    try {
      const { pairing, claimToken } = deps.pairings.claim({
        code: body.code,
        publicKey: body.publicKey,
        device: body.device,
        // 没有可信代理头时所有人共用一个来源桶：宁可误伤，也不让换 IP 就能换次数。
        source: ipOf(c) ?? "unknown",
        now: now(),
      });
      const account = deps.accounts.findById(pairing.accountId);
      return json({ id: pairing.id, claimToken, publicKey: pairing.initiatorKey, expiresAt: pairing.expiresAt, email: account?.email ?? null }, 200);
    } catch (error) {
      return pairingError(error);
    }
  });

  routes.post("/pairing/:id/result", async (c) => {
    const body = await parse(c, pairingResultRequestSchema);
    if (body instanceof Response) return body;
    try {
      const pairing = deps.pairings.result(c.req.param("id"), body.claimToken, now());
      if (pairing.status === "claimed") return json({ status: "waiting" }, 200);
      if (pairing.status === "rejected") return json({ status: "rejected" }, 200);
      if (pairing.status === "done") return json({ error: "这次配对的结果已经取走了", code: "state" }, 409);
      // approved：发 B 自己的设备会话，交出密文，然后这条配对就作废了。
      const account = deps.accounts.findById(pairing.accountId);
      if (!account || account.status !== "active") return json({ error: "账号已被停用", code: "disabled" }, 403);
      const { sealed } = deps.pairings.deliver(pairing);
      const session = issueDeviceSession(deps, account, pairing.device as Parameters<typeof issueDeviceSession>[2], ipOf(c), now());
      deps.audit?.({ actorId: account.id, action: "pair_device", target: pairing.device?.deviceId ?? null, ip: ipOf(c), detail: pairing.device?.name ?? null });
      return json({ status: "done", ...session, sealed }, 200);
    } catch (error) {
      return pairingError(error);
    }
  });

  return routes;
}
