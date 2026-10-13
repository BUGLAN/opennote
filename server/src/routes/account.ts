/**
 * `/v1/account/*`：注册、解锁、轮换、删除（`docs/执行-三端同步…` §4.7、§1.5 的三个流程）。
 *
 * ## 三条与红线 3 直接相关的纪律
 *
 * 1. **服务端不生成密钥材料**：`accountId` / `authToken` / `wrappedEncRoot` 全部来自客户端。
 *    这个文件里**没有**任何生成它们的调用（`newAccountId()` 只给控制台与测试用）。
 * 2. **`isAdmin` 只由引导码决定**：邀请码注册出来的账号 `isAdmin = false`，
 *    **不看请求体里的任何字段** —— 否则一次伪造请求就能造出管理员（§10.1 K2）。
 * 3. **响应里绝不回显任何密钥材料**：`wrappedEncRoot` 只在 `unlock` 时返回给
 *    已经用 `authToken` 认证过的同一个账号（新人拿到它也没用：解不开，缺 `wrapKey`）。
 *
 * ## 错误形状
 *
 * 一律 `{ error, code }`，`code` 是**机器可读**的（客户端据此给明确文案，
 * 例如「此设备的密钥已被轮换，请导入新密钥」而不是含糊的「登录失效」，§1.5 代价 2）。
 */

import { Hono } from "hono";
import {
  ContractError,
  accountCreateRequestSchema,
  accountCreateResponseSchema,
  accountInfoSchema,
  accountRotateRequestSchema,
  accountUnlockResponseSchema,
  parseContract,
  PROTOCOL_VERSION,
  type Quota,
} from "../../../shared/contract";
import { AccountError, AccountStore, type AccountRow } from "../auth/accounts";
import type { NotebookStore } from "../notebooks";
import type { ServerConfig } from "../config";

/** 账号注册被拒 → HTTP 状态与机器可读 code。 */
function rejectionToHttp(error: AccountError): { status: 400 | 401 | 403 | 404 | 409; code: string } {
  switch (error.rejection) {
    case "account-exists":
      return { status: 409, code: "conflict" };
    case "missing-code":
    case "bad-bootstrap-code":
    case "bad-invite-code":
      return { status: 400, code: "bad-request" };
    case "bootstrap-code-used":
    case "bootstrap-code-expired":
    case "invite-revoked":
    case "invite-expired":
    case "invite-exhausted":
      return { status: 400, code: "bad-request" };
    case "unauthorized":
      return { status: 401, code: "unauthorized" };
    // ★ 轮换之后旧令牌走这一条：客户端要能给出**明确文案**（§1.5 代价 2）。
    case "disabled":
      return { status: 403, code: "disabled" };
    case "not-found":
      return { status: 404, code: "not-found" };
    default:
      return { status: 400, code: "bad-request" };
  }
}

export interface AccountRoutesDeps {
  accounts: AccountStore;
  notebooks: NotebookStore;
  config: ServerConfig;
  /** 记账（审计表；**永不包含正文或密钥材料**，§4.3）。 */
  audit?: (event: { actorId: string | null; action: string; target?: string | null; ip?: string | null; detail?: string | null }) => void;
}

/** 把配额算成契约形状（读 + 写两个上限都带上）。 */
function quotaFor(deps: AccountRoutesDeps, accountId: string): Quota {
  const usage = deps.notebooks.quotaOf(accountId);
  return {
    bytesUsed: usage.bytesUsed,
    bytesLimit: deps.config.defaultAccountQuotaBytes,
    notebooks: usage.notebooks,
    notebooksLimit: deps.config.defaultAccountQuotaNotebooks,
  };
}

/** 从 `Authorization: Bearer <token>` 取令牌；没有就返回 `null`。 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export function createAccountRoutes(deps: AccountRoutesDeps): Hono {
  const routes = new Hono();
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  /**
   * 认证中间件：把 `authToken` 换成 `AccountRow`。
   *
   * 这是**唯一**的认证链路（§4.4）：`sha256(authToken)` → 唯一索引查表 → 状态检查。
   * **没有会话表** —— 令牌本身就是身份。
   */
  const authenticate = (c: { req: { header: (name: string) => string | undefined } }): AccountRow | Response => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return json({ error: "缺少 Authorization: Bearer 令牌", code: "unauthorized" }, 401);
    try {
      const row = deps.accounts.authenticate(token);
      deps.accounts.touch(row.id);
      return row;
    } catch (error) {
      if (error instanceof AccountError) {
        const mapped = rejectionToHttp(error);
        return json({ error: error.message, code: mapped.code }, mapped.status);
      }
      throw error;
    }
  };

  /* ------------------------------------------------------------ 注册 */

  routes.post("/account", async (c) => {
    const raw = await c.req.json().catch(() => null);
    let input;
    try {
      input = parseContract(accountCreateRequestSchema, raw, "POST /v1/account");
    } catch (error) {
      const message = error instanceof ContractError ? error.message : String(error);
      return json({ error: message, code: "bad-request" }, 400);
    }

    /*
     * ★ `isAdmin` **只由引导码决定**，不看请求体（§10.1 K2：不存在抢注路径）。
     * 一句话：能拿到 CLI 打印的引导码的人，才有资格成为管理员。
     */
    const isAdmin = Boolean(input.bootstrapCode);

    try {
      const row = deps.accounts.create({
        accountId: input.accountId,
        authToken: input.authToken,
        wrappedEncRoot: input.wrappedEncRoot,
        isAdmin,
        label: input.label ?? null,
        ...(input.bootstrapCode === undefined ? {} : { bootstrapCode: input.bootstrapCode }),
        ...(input.inviteCode === undefined ? {} : { inviteCode: input.inviteCode }),
      });
      deps.notebooks.recomputeNotebookCount(row.id);
      deps.audit?.({ actorId: row.id, action: "create_account", target: row.id, ip: null, detail: isAdmin ? "bootstrap" : "invite" });
      const body = parseContract(
        accountCreateResponseSchema,
        { accountId: row.id, isAdmin: row.is_admin === 1, protocolVersion: PROTOCOL_VERSION },
        "POST /v1/account 响应",
      );
      return json(body, 201);
    } catch (error) {
      if (error instanceof AccountError) {
        const mapped = rejectionToHttp(error);
        return json({ error: error.message, code: mapped.code }, mapped.status);
      }
      throw error;
    }
  });

  /* ------------------------------------------------------------ 解锁 */

  /** 新设备：换回 `wrappedEncRoot`，客户端自己用 `wrapKey` 解（服务端解不开）。 */
  routes.post("/account/unlock", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const body = parseContract(
      accountUnlockResponseSchema,
      {
        accountId: auth.id,
        wrappedEncRoot: auth.wrapped_enc_root,
        quota: quotaFor(deps, auth.id),
        protocolVersion: PROTOCOL_VERSION,
      },
      "POST /v1/account/unlock 响应",
    );
    return json(body, 200);
  });

  /* ------------------------------------------------------------ 轮换 */

  routes.post("/account/rotate", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;

    const raw = await c.req.json().catch(() => null);
    let input;
    try {
      input = parseContract(accountRotateRequestSchema, raw, "POST /v1/account/rotate");
    } catch (error) {
      return json({ error: error instanceof ContractError ? error.message : String(error), code: "bad-request" }, 400);
    }

    /*
     * **零重加密**：一条 UPDATE 换掉 `auth_hash` 与 `wrapped_enc_root`，`encRoot` 不变
     * （§1.5 流程③）。旧 `authToken` **立即失效** —— 这正是「一个密钥 = 一个账号」的
     * 固有结果，也是控制台要提示「其它设备需要重新导入」的原因（§1.5 代价 2）。
     */
    deps.accounts.rotate(auth.id, input.newAuthToken, input.newWrappedEncRoot);
    deps.audit?.({ actorId: auth.id, action: "rotate_key", target: auth.id, ip: null, detail: null });
    return new Response(null, { status: 204 });
  });

  /* ------------------------------------------------------------ 读取 */

  routes.get("/account", (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;
    const body = parseContract(accountInfoSchema, deps.accounts.info(auth, quotaFor(deps, auth.id)), "GET /v1/account 响应");
    return json(body, 200);
  });

  /* ------------------------------------------------------------ 删除 */

  routes.delete("/account", async (c) => {
    const auth = authenticate(c as never);
    if (auth instanceof Response) return auth;

    /*
     * 删账号（§7.1）：**只做控制面**的两件事 —— 清成员行、级联逻辑删掉它**独占**的笔记本。
     * CouchDB 库的物理删除由调用方（控制台/CLI 的编排）按 `exclusive` 决定并执行；
     * 这里不直接删库，因为「决定」与「执行」分开才可回滚、可审计。
     */
    const owned = deps.notebooks.listForAccount(auth.id).filter((item) => item.role === "owner");
    const deleted: string[] = [];
    const transferred: string[] = [];
    for (const { notebook } of owned) {
      const { exclusive, otherMembers } = deps.notebooks.markDeleted(notebook.id);
      if (exclusive) {
        deleted.push(notebook.id);
      } else {
        // 有别的成员 ⇒ **移交**给第一个非 owner 成员，而不是删库（§7.1）。
        deps.notebooks.transferOwnership(notebook.id, otherMembers[0]!);
        transferred.push(notebook.id);
      }
    }
    deps.notebooks.removeMembershipsOf(auth.id);
    deps.accounts.delete(auth.id);
    deps.audit?.({
      actorId: auth.id,
      action: "delete_account",
      target: auth.id,
      ip: null,
      detail: `notebooksDeleted=${deleted.length},notebooksTransferred=${transferred.length}`,
    });
    return new Response(null, { status: 204 });
  });

  return routes;
}
