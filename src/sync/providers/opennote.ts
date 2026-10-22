/**
 * `opennote` provider —— 真实 `/v1/*` 的 `SyncProvider` 实现
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.7、§3.3、§3.5、§6.4、§10.1 A/G）。
 *
 * ## 这一层是**纯适配**：它不做任何语义决定
 *
 * | 它做的事 | 它**不**做的事（那些是 CouchDB 或引擎的） |
 * | --- | --- |
 * | `did` ↔ 查询参数 | 生成版本号 |
 * | `hash` ↔ `If-Match` 的转写 | 裁决冲突（只**上报**） |
 * | 不透明 cursor 的原样搬运 | 解析 / 比较 / 假设 cursor 单调 |
 * | 把 HTTP 状态映射成 `SyncProviderError.code` | 决定「该不该重试」（那是传输层的） |
 *
 * ## 三处刻意的实现细节
 *
 * ### ① 明文模式下 `path` 由 provider 从 `did` 反解（不是让引擎传进来）
 *
 * 引擎**只有 `did`**（`provider-types.ts` 模块头：这是设计上的要求，E2EE 下它必须看不到路径）。
 * 而模式 A 的 `did = "f:" + base64url(nfc(path))` **本来就可逆**（§3.3 表：模式 A 服务端能看到路径）。
 * 所以 provider 自己解 —— 这样引擎的签名不必为了一个只在模式 A 需要的字段而变形。
 *
 * ⚠️ 模式 B（`h:`）**不解**，也传不出 `path`：服务端在 E2EE 下不写该字段（§3.4）。
 *
 * ### ② `409` 是**返回值**，不是异常
 *
 * `put()` / `delete()` 的 CAS 失败走 `{ conflict }` 返回。理由在
 * `provider-types.ts` 已经写了：把它做成异常只会诱使有人写一个宽泛的 `catch` 把它吞掉，
 * 而调用方**必须**处理它才能做三方 diff。
 *
 * ### ③ `truncated` 原样上报，不「聪明地」多取几页
 *
 * §6.4 规则 1：`truncated` 是「禁止推断删除」的开关。这里若偷偷循环取完，
 * 就把「远端明确说没列全」这个信号抹掉了 —— 而那个信号正是防误删的。
 * 分页取完是**调用方**（引擎）的事，它需要知道每一页的全不全。
 */

import type { CryptoMode } from "../../../shared/contract";
import { pathFromLegacyId } from "../../../shared/paths";
import { HttpTransport, type HttpTransportOptions } from "../http";
import {
  SyncProviderError,
  type ProviderChanges,
  type ProviderDeleteInput,
  type ProviderPutInput,
  type ProviderPutResult,
  type ProviderReadResult,
  type ProviderTree,
  type ProviderTreeEntry,
  type SyncProvider,
} from "../provider-types";

export interface OpenNoteProviderOptions extends Omit<HttpTransportOptions, "notebookId"> {
  notebookId: string;
  cryptoMode: CryptoMode;
  /**
   * 设备 id（写检查点用，§3.7）。
   *
   * 可以不给：检查点是**优化**而不是正确性依赖（丢了最多重扫一次）。
   * 但一个**空字符串**要显式当成「没有」处理（见 `checkpoint()`），
   * 否则会往 `_local/device-` 写一个畸形文档 id。
   */
  deviceId?: string;
  /** provider 名字（日志用；默认 `opennote`）。 */
  name?: string;
}

/** `/v1/tree` 的响应形状（与 `shared/contract.ts` 的 `treeResponseSchema` 对应）。 */
interface TreeResponse {
  cursor: string | null;
  truncated: boolean;
  nextStartKey?: string;
  files: { did: string; path?: string; hash?: string; ehash?: string; size?: number; esize?: number; rev: string; deleted?: boolean }[];
}

interface ChangesResponse {
  cursor: string | null;
  resync: boolean;
  truncated?: boolean;
  changes: { did: string; op: "add" | "update" | "delete"; path?: string; hash?: string; ehash?: string }[];
}

/** base64（带填充）→ 字节。宿主都有 `atob`，不引依赖。 */
function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export class OpenNoteProvider implements SyncProvider {
  readonly name: string;
  readonly cryptoMode: CryptoMode;
  private readonly transport: HttpTransport;
  private readonly deviceId: string;

  constructor(options: OpenNoteProviderOptions) {
    this.name = options.name ?? "opennote";
    this.cryptoMode = options.cryptoMode;
    this.transport = new HttpTransport(options);
    /*
     * 检查点用 `_local/device-<deviceId>`（§3.7）。设备 id 为空的话**不报错**，
     * 只是检查点不写 —— 检查点是优化而不是正确性依赖（丢了最多重扫一次），
     * 而为一个可选功能让整个同步起不来是不划算的。
     */
    this.deviceId = options.deviceId ?? "";
  }

  /** 模式 A 下从 `did` 反解明文路径；模式 B（或形状不对）返回 `undefined`。 */
  private pathOf(did: string): string | undefined {
    if (!did.startsWith("f:")) return undefined;
    try {
      return pathFromLegacyId(did);
    } catch {
      // 形状不对（服务端理论上不会给）：**不要抛** —— 它不该让整次同步失败，
      // 只是这一条的 `path` 缺失（模式 A 下服务端会用 did 自己解，不缺这一份）。
      return undefined;
    }
  }

  async tree(options: { limit?: number; startKey?: string } = {}): Promise<ProviderTree> {
    const response = await this.transport.request<TreeResponse>(
      {
        method: "GET",
        path: "/v1/tree",
        query: {
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.startKey === undefined ? {} : { startkey: options.startKey }),
        },
      },
      (raw) => HttpTransport.json<TreeResponse>(raw),
    );

    const entries: ProviderTreeEntry[] = [];
    for (const file of response.files ?? []) {
      // 内容标识：明文取 `hash`，E2EE 取 `ehash`。两者都没有 ⇒ 这一条是坏的，跳过。
      const hash = file.hash ?? file.ehash;
      if (!hash) continue;
      // tombstone 不进树（它用 `changes()` 的 `op: "delete"` 表达，§6.4 规则 3）。
      if (file.deleted === true) continue;
      const size = file.size ?? file.esize;
      entries.push({
        did: file.did,
        // ★ 只认**模式 A** 的明文路径；模式 B 下服务端本来就不会给（§3.4）。
        ...(this.cryptoMode === "none" && typeof file.path === "string" ? { path: file.path } : {}),
        hash,
        ...(size === undefined ? {} : { size }),
        rev: file.rev,
      });
    }

    return {
      cursor: response.cursor ?? null,
      // ★ 原样上报（见模块头 ③）。
      truncated: response.truncated === true,
      ...(typeof response.nextStartKey === "string" ? { nextStartKey: response.nextStartKey } : {}),
      entries,
    };
  }

  async changes(options: { since?: string | null } = {}): Promise<ProviderChanges> {
    const response = await this.transport.request<ChangesResponse>(
      {
        method: "GET",
        path: "/v1/changes",
        query: options.since === undefined || options.since === null ? {} : { since: options.since },
      },
      (raw) => HttpTransport.json<ChangesResponse>(raw),
    );
    return {
      cursor: response.cursor ?? null,
      ...(response.resync === true ? { resync: true } : {}),
      ...(response.truncated === true ? { truncated: true } : {}),
      changes: (response.changes ?? []).map((change) => {
        /*
         * 内容标识：明文看 `hash`，E2EE 看 `ehash`。两者都只当**不透明串**用
         * （引擎只比相等，不做任何假设）。
         */
        const hash = change.hash ?? change.ehash;
        return {
          did: change.did,
          op: change.op,
          ...(typeof change.path === "string" ? { path: change.path } : {}),
          ...(hash === undefined ? {} : { hash }),
        };
      }),
    };
  }

  /**
   * 一次读多条（`POST /v1/files`）。
   *
   * 失败时**不在这里兜底**：抛给引擎，让引擎退回逐条 `read()`。
   * 理由是这个方法只在「一次很多条」时被调用，而那种场景下「批量接口不存在」
   * （老服务端 404）是**预期之内**的退化路径，不是错误。
   */
  async readMany(dids: string[]): Promise<Map<string, ProviderReadResult>> {
    if (dids.length === 0) return new Map();
    const response = await this.transport.request<{ files: { did: string; hash: string; rev: string; data: string }[] }>(
      {
        method: "POST",
        path: "/v1/files",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dids }),
      },
      (raw) => HttpTransport.json<{ files: { did: string; hash: string; rev: string; data: string }[] }>(raw),
    );
    const out = new Map<string, ProviderReadResult>();
    for (const file of response.files ?? []) {
      out.set(file.did, { bytes: base64ToBytes(file.data), hash: file.hash, rev: file.rev });
    }
    return out;
  }
  async read(did: string): Promise<ProviderReadResult | null> {
    const response = await this.transport.send({ method: "GET", path: "/v1/file", query: { did } });
    // `404` = 这一条不在了。**这是正常结果，不是异常**（接口约定返回 `null`）。
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw this.transport.errorFrom(response);

    const hash = response.headers["x-opennote-hash"];
    const rev = response.headers["x-opennote-rev"];
    if (!hash || !rev) {
      /*
       * 服务端没给标识头。这**不该发生**（`/v1/file` 总会带），但如果发生了，
       * 静默用空字符串会让基线写进一个假 hash，下次 CAS 必然对不上 —— 一个
       * 很难追的「同步总是冲突」。所以这里明确报错。
       */
      throw new SyncProviderError("server", "远端没返回内容标识（x-opennote-hash / x-opennote-rev）", response.status);
    }
    return { bytes: response.bytes, hash, rev };
  }

  async put(input: ProviderPutInput): Promise<ProviderPutResult | { conflict: { did: string; current: { hash: string; rev: string } | null } }> {
    const path = this.pathOf(input.did);
    const response = await this.transport.send({
      method: "PUT",
      path: "/v1/file",
      query: { did: input.did, ...(path === undefined ? {} : { path }) },
      headers: {
        // ★ CAS 用的**不是** `_rev`，而是内容标识 —— 转写由服务端做（§4.7 设计点 3）。
        ...(input.baseHash === null ? {} : { "if-match": input.baseHash }),
        /*
         * ★ `If-Match` 是「我以为远端现在是哪一版」（CAS），**不是**「我这次写的是什么」。
         * 这一版的内容标识必须单独送 —— 否则新建时 `If-Match` 缺省，服务端就没有任何
         * 地方能拿到 hash，写进去的文档没有内容标识（症状：`/v1/tree` 过不了契约、
         * 下一次 CAS 永远对不上）。
         */
        "x-opennote-hash": input.hash,
        "content-type": "application/octet-stream",
      },
      body: input.bytes,
    });

    if (response.status === 409) {
      // ★ 业务结果，不是异常。把当前值原样带回去给调用方做三方 diff。
      try {
        const parsed = HttpTransport.json<{ current?: { hash: string; rev: string } | null }>(response);
        return { conflict: { did: input.did, current: parsed.current ?? null } };
      } catch {
        return { conflict: { did: input.did, current: null } };
      }
    }
    if (response.status < 200 || response.status >= 300) throw this.transport.errorFrom(response);

    const parsed = HttpTransport.json<{ rev?: string; hash?: string | null }>(response);
    return { hash: parsed.hash ?? input.hash, rev: parsed.rev ?? "" };
  }

  async delete(input: ProviderDeleteInput): Promise<{ rev: string } | { conflict: { did: string; current: { hash: string; rev: string } | null } } | { gone: true }> {
    const response = await this.transport.send({
      method: "DELETE",
      path: "/v1/file",
      query: { did: input.did },
      headers: input.baseHash === null ? {} : { "if-match": input.baseHash },
    });

    // `410 Gone` = 远端已经没有了。**这是成功**（目标状态已达成），不是失败 ——
    // 把它当失败会让「删除一条已经被别人删掉的文件」永远卡在错误状态里。
    if (response.status === 410) return { gone: true };
    if (response.status === 409) {
      try {
        const parsed = HttpTransport.json<{ current?: { hash: string; rev: string } | null }>(response);
        return { conflict: { did: input.did, current: parsed.current ?? null } };
      } catch {
        return { conflict: { did: input.did, current: null } };
      }
    }
    if (response.status === 404) return { gone: true };
    if (response.status < 200 || response.status >= 300) throw this.transport.errorFrom(response);
    // `204` 没有响应体 ⇒ 没有新 rev。空 rev 是诚实的结果：
    // 调用方拿不到新 rev 时应当重列树，而不是猜一个。
    return { rev: "" };
  }

  async checkpoint(cursor: string | null): Promise<void> {
    if (!this.deviceId) return; // 见构造函数：没有 deviceId 就不写检查点（可选功能）。
    const body = JSON.stringify({ deviceId: this.deviceId, cursor });
    await this.transport.request(
      { method: "PUT", path: "/v1/checkpoint", headers: { "content-type": "application/json" }, body },
      () => undefined,
    );
  }
}

/** 便捷构造（`new` 太啰嗦的地方用）。 */
export function createOpenNoteProvider(options: OpenNoteProviderOptions): OpenNoteProvider {
  return new OpenNoteProvider(options);
}
