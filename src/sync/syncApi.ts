/**
 * 同步服务的账号类接口客户端（`docs/执行-同步重写-2026-11-02.md` 阶段 ⑤）。
 *
 * 文件协议（`/v1/tree|changes|file…`）走 `providers/opennote.ts`；这里是其余的：
 * 健康检查、登录、我、设备、笔记本、加密口令、GitHub 交接、配对。
 *
 * 传输复用 `resolveSend`：桌面端经主进程代理（令牌由主进程贴，渲染层只交一次），
 * 网页 / 手机直接 fetch。没登录时（探测服务器、登录、配对认领）令牌是空的。
 */

import type {
  DeviceDescriptor,
  DeviceInfo,
  EncryptionState,
  HealthResponse,
  KdfParams,
  Me,
  NotebookSummary,
} from "../../shared/contract";
import { resolveSend, type HttpSend } from "./http";

export class SyncApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 服务端的 `code`（`bad-credentials` / `locked` / `email-taken` …）；连不上时是 `network`。 */
    readonly code: string,
  ) {
    super(message);
    this.name = "SyncApiError";
  }
}

export type PairingStatus = "waiting" | "claimed" | "approved" | "done" | "rejected";

export interface SyncApi {
  readonly server: string;
  health(): Promise<HealthResponse>;
  login(input: { email: string; password: string; device: DeviceDescriptor }): Promise<{ token: string; me: Me }>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  removeDevice(deviceId: string): Promise<void>;
  notebooks(): Promise<NotebookSummary[]>;
  createNotebook(input: { name: string; cryptoMode: "none" | "user-key" }): Promise<NotebookSummary>;
  encryption(): Promise<EncryptionState>;
  putEncryption(input: { wrappedEncRoot: string; kdf: KdfParams; expected: string | null }): Promise<void>;
  githubExchange(input: { code: string; verifier: string; device: DeviceDescriptor }): Promise<{ token: string; me: Me }>;
  githubLink(): Promise<{ url: string }>;
  githubUnlink(): Promise<Me>;
  pairingCreate(publicKey: string): Promise<{ id: string; code: string; expiresAt: number }>;
  pairingGet(id: string): Promise<{ status: PairingStatus; expiresAt: number; device: { name: string; platform: string; os: string | null } | null; publicKey: string | null }>;
  pairingApprove(id: string, sealed: string | null): Promise<void>;
  pairingReject(id: string): Promise<void>;
  pairingClaim(input: { code: string; publicKey: string; device: DeviceDescriptor }): Promise<{ id: string; claimToken: string; publicKey: string; expiresAt: number; email: string | null }>;
  pairingResult(id: string, claimToken: string): Promise<{ status: "waiting" | "rejected" } | { status: "done"; token: string; me: Me; sealed: string | null }>;
}

/** 把一个错误说成人话（连不上 / 不是 Opennote / 服务端给的那句）。 */
function describeFailure(status: number, text: string): { message: string; code: string } {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof parsed.error === "string") return { message: parsed.error, code: typeof parsed.code === "string" ? parsed.code : "http" };
  } catch {
    /* 不是 JSON：反代错误页等 */
  }
  if (status === 404) return { message: "这个地址上没有 Opennote 同步服务", code: "not-opennote" };
  if (status >= 500) return { message: `同步服务出错了（${status}），稍后再试`, code: "server" };
  return { message: `同步服务返回 ${status}`, code: "http" };
}

export async function openSyncApi(options: { server: string; token?: string | null; send?: HttpSend }): Promise<SyncApi> {
  const base = options.server.replace(/\/+$/, "");
  const token = options.token ?? "";
  let send: HttpSend;
  try {
    send = options.send ?? (await resolveSend({ baseUrl: base, authToken: token }));
  } catch (error) {
    // 桌面端换服务器时主进程会弹确认框；用户点了「不允许」就走到这里。
    throw new SyncApiError(0, error instanceof Error ? error.message : "没能连接这个服务器", "refused");
  }
  const decoder = new TextDecoder();

  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    let response;
    try {
      response = await send({
        method,
        url: `${base}${path}`,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new SyncApiError(0, `连不上 ${base.replace(/^https?:\/\//, "")}：${error instanceof Error ? error.message : String(error)}`, "network");
    }
    const text = decoder.decode(response.bytes);
    if (response.status < 200 || response.status >= 300) {
      const failure = describeFailure(response.status, text);
      throw new SyncApiError(response.status, failure.message, failure.code);
    }
    if (text === "") return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SyncApiError(response.status, "这个地址返回的不是 Opennote 同步服务的响应", "not-opennote");
    }
  }

  const id = (value: string): string => encodeURIComponent(value);
  return {
    server: base,
    health: () => request("GET", "/v1/health"),
    login: (input) => request("POST", "/v1/auth/login", input),
    logout: () => request("POST", "/v1/auth/logout", {}),
    me: () => request("GET", "/v1/me"),
    changePassword: (input) => request("POST", "/v1/me/password", input),
    devices: async () => (await request<{ devices: DeviceInfo[] }>("GET", "/v1/me/devices")).devices,
    removeDevice: (deviceId) => request("DELETE", `/v1/me/devices/${id(deviceId)}`),
    notebooks: async () => (await request<{ notebooks: NotebookSummary[] }>("GET", "/v1/notebooks")).notebooks,
    createNotebook: (input) => request("POST", "/v1/notebooks", input),
    encryption: () => request("GET", "/v1/me/encryption"),
    putEncryption: (input) => request("PUT", "/v1/me/encryption", input),
    githubExchange: (input) => request("POST", "/v1/auth/github/exchange", input),
    githubLink: () => request("POST", "/v1/me/github/link", {}),
    githubUnlink: () => request("DELETE", "/v1/me/github"),
    pairingCreate: (publicKey) => request("POST", "/v1/pairing", { publicKey }),
    pairingGet: (pairingId) => request("GET", `/v1/pairing/${id(pairingId)}`),
    pairingApprove: (pairingId, sealed) => request("POST", `/v1/pairing/${id(pairingId)}/approve`, { sealed }),
    pairingReject: (pairingId) => request("POST", `/v1/pairing/${id(pairingId)}/reject`, {}),
    pairingClaim: (input) => request("POST", "/v1/pairing/claim", input),
    pairingResult: (pairingId, claimToken) => request("POST", `/v1/pairing/${id(pairingId)}/result`, { claimToken }),
  };
}
