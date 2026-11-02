/**
 * 登录密码的哈希与校验（`docs/执行-同步重写-2026-11-02.md`「身份模型」）。
 *
 * ## 为什么是 scrypt
 *
 * 密码是**低熵的人类输入**，库被拖走后要扛得住离线爆破，所以必须是慢 KDF。
 * `node:crypto` 自带 scrypt，不用引新依赖（Argon2 需要原生模块，Docker 镜像要多装编译链）。
 *
 * 参数 N=2¹⁵、r=8、p=1：单次约 50–100ms、占 32 MiB 内存，是 OWASP 给 scrypt 的推荐下限。
 * 参数写进哈希串里（`scrypt$N$r$p$salt$hash`），以后调高参数时旧哈希仍能校验。
 *
 * ## 这里不是加密
 *
 * 只有单向哈希，没有任何能还原明文的东西（`scripts/check-boundaries.mjs` 的 B3/B4 仍然成立）。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** 密码最短长度。界面上的提示文案与这里同一个数。 */
export const PASSWORD_MIN_LENGTH = 10;
/** 上限只为挡住「拿超长输入打 KDF」的滥用。 */
export const PASSWORD_MAX_LENGTH = 256;

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_BYTES, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** 返回给用户看的「为什么这个密码不行」；可用时返回 null。 */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`;
  return null;
}

export async function hashPassword(password: string, params: { N: number; r: number; p: number } = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** 校验失败（包括哈希串损坏）一律返回 false，不抛错 —— 调用方只需要「对 / 不对」。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const actual = await scrypt(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}

/** 测试用的低成本参数（N=2⁴）：生产代码不许用。 */
export const FAST_PARAMS_FOR_TESTS = { N: 16, r: 1, p: 1 } as const;
