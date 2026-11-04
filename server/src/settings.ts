/**
 * 控制台可改、即时生效的服务设置（`server_settings` 表，v4 起）。
 *
 * 环境变量管「部署时就定死的」（地址、CouchDB 凭据、限流）；这里管「运营中会调的」
 * （谁能注册、新用户默认配额、登录方式……）。没写过的键回落到默认值，所以新加一项设置
 * 不需要迁移。
 */

import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config";

export type RegistrationMode = "invite" | "open" | "closed";

export interface ServerSettings {
  /** 谁可以注册：仅限邀请（默认）/ 开放 / 关闭。 */
  registration: RegistrationMode;
  /** 是否允许邮箱 + 密码登录。关掉后只剩 GitHub（要求 GitHub 已可用，见 `routes/admin.ts`）。 */
  passwordLogin: boolean;
  /** 新用户默认空间配额（字节）。账号自己的 `quota_bytes` 为空时用它。 */
  defaultQuotaBytes: number;
  /** 允许用 GitHub 登录（还要配好下面两项才真的可用，见 `githubAvailable`）。 */
  githubEnabled: boolean;
  /** GitHub OAuth App 的 Client ID。 */
  githubClientId: string;
  /** GitHub OAuth App 的 Client Secret。**只写不读**：管理接口返回的是 `publicView()`。 */
  githubClientSecret: string;
  /** 谁能用 GitHub 登录：只有已邀请 / 已绑定的（默认），或指定组织的成员自动加入。 */
  githubPolicy: GithubPolicy;
  /** `githubPolicy = org` 时放行的组织（小写 login）。 */
  githubOrgs: string[];
}

export type GithubPolicy = "invited" | "org";

/** 给控制台看的设置：Secret 只说「设过没有」。 */
export type PublicSettings = Omit<ServerSettings, "githubClientSecret"> & { githubClientSecretSet: boolean; githubAvailable: boolean };

type Key = keyof ServerSettings;

export class SettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: Pick<ServerConfig, "defaultAccountQuotaBytes">,
  ) {}

  private defaults(): ServerSettings {
    return {
      registration: "invite",
      passwordLogin: true,
      defaultQuotaBytes: this.config.defaultAccountQuotaBytes,
      githubEnabled: false,
      githubClientId: "",
      githubClientSecret: "",
      githubPolicy: "invited",
      githubOrgs: [],
    };
  }

  all(): ServerSettings {
    const rows = this.db.prepare("SELECT key, value FROM server_settings").all() as unknown as { key: string; value: string }[];
    const merged: Record<string, unknown> = { ...this.defaults() };
    for (const row of rows) {
      if (!(row.key in merged)) continue;
      try {
        merged[row.key] = JSON.parse(row.value);
      } catch {
        // 坏值当没写过（回落默认），不让一行脏数据拖垮整个服务。
      }
    }
    return merged as unknown as ServerSettings;
  }

  /** GitHub 登录此刻能不能用：开关开着，而且 Client ID / Secret 都填了。 */
  githubAvailable(): boolean {
    const all = this.all();
    return all.githubEnabled && all.githubClientId.trim() !== "" && all.githubClientSecret.trim() !== "";
  }

  publicView(): PublicSettings {
    const { githubClientSecret, ...rest } = this.all();
    return { ...rest, githubClientSecretSet: githubClientSecret !== "", githubAvailable: this.githubAvailable() };
  }

  get<K extends Key>(key: K): ServerSettings[K] {
    return this.all()[key];
  }

  set(patch: Partial<ServerSettings>, now = Date.now()): ServerSettings {
    const statement = this.db.prepare(
      "INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !(key in this.defaults())) continue;
      statement.run(key, JSON.stringify(value), now);
    }
    return this.all();
  }
}
