/**
 * 这台设备的同步登录凭据（`docs/执行-同步重写-2026-11-02.md` 阶段 ⑤）。
 *
 * 由 `keys.ts` 保管（桌面在主进程、网页在 localStorage），这里只管形状：
 *
 * | 字段 | 是什么 |
 * | --- | --- |
 * | `server` | 同步服务地址（去掉尾部斜杠） |
 * | `token` | 设备会话令牌 `ons_…`（登录 / GitHub / 配对换来的；服务端只存它的 sha256） |
 * | `accountId` · `email` | 登录的是谁 |
 * | `deviceName` | 登录时填的设备名（再次登录时预填） |
 * | `encRoot` | **可选**：解开过的加密根，只有用户勾了「记在这台设备上」才存 |
 *
 * 账号密码、加密口令**都不存**：前者换完令牌就丢，后者只用来解开 encRoot。
 */

export interface SyncCredentials {
  v: 2;
  server: string;
  token: string;
  accountId: string;
  email: string | null;
  deviceName: string;
  /** base64url 的 32 字节。 */
  encRoot?: string;
}

export function normalizeServer(raw: string): string {
  let text = raw.trim();
  if (text !== "" && !/^https?:\/\//i.test(text)) text = `https://${text}`;
  return text.replace(/\/+$/, "");
}

/** 形状不对就抛（`keys.ts` 据此拒绝写入、把坏值当「没有」）。 */
export function parseCredentials(text: string): SyncCredentials {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("同步登录信息已损坏");
  }
  const record = value as Partial<SyncCredentials> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    record.v !== 2 ||
    typeof record.server !== "string" ||
    !/^https?:\/\//.test(record.server) ||
    typeof record.token !== "string" ||
    !record.token.startsWith("ons_") ||
    typeof record.accountId !== "string" ||
    !/^[0-9a-f]{32}$/.test(record.accountId) ||
    (record.email !== null && typeof record.email !== "string") ||
    typeof record.deviceName !== "string" ||
    (record.encRoot !== undefined && (typeof record.encRoot !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.encRoot)))
  ) {
    throw new Error("同步登录信息已损坏");
  }
  return {
    v: 2,
    server: record.server,
    token: record.token,
    accountId: record.accountId,
    email: record.email ?? null,
    deviceName: record.deviceName,
    ...(record.encRoot === undefined ? {} : { encRoot: record.encRoot }),
  };
}

export function encodeCredentials(credentials: SyncCredentials): string {
  return JSON.stringify(credentials);
}
