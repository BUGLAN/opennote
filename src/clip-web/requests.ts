import {
  COMMIT_TIMEOUT_MS,
  FOLDERS_TIMEOUT_MS,
  STAGE_TIMEOUT_MS,
  describeNetworkFailure,
  parseCommitPayload,
  parseFoldersPayload,
  parseStagePayload,
  type ClipBoot,
  type ClipReceipt,
  type ClipStage,
  type Parsed,
} from "./contract";

/** 页面里最后真正会入库的三个字段。 */
export interface ClipForm {
  title: string;
  body: string;
  folder: string;
}

/** `POST /v1/clip/commit` 的请求体（契约字段：stageId / k / title / body / folder）。 */
export interface ClipCommitBody {
  stageId: string;
  k: string;
  title: string;
  body: string;
  folder: string;
}

export const COMMIT_URL = "/v1/clip/commit";

/**
 * 提交体只有一个产地：它读**当前表单**（用户改过的 title/body 与用户选的落点），
 * 不读暂存里的原值、也不改写落点。`folder: ""` 就是收件箱（契约㉕）。
 */
export function buildCommitBody(boot: ClipBoot, form: ClipForm): ClipCommitBody {
  return {
    stageId: boot.stageId,
    k: boot.k,
    title: form.title,
    body: form.body,
    folder: form.folder,
  };
}

/** 页面与接口同源，所以用绝对路径（从 `/clip/<stageId>` 解析出来仍是根路径下的接口）。 */
export function stageUrl(boot: ClipBoot): string {
  return `/v1/clip/stage?stageId=${encodeURIComponent(boot.stageId)}&k=${encodeURIComponent(boot.k)}`;
}

export function foldersUrl(boot: ClipBoot): string {
  return `/v1/clip/folders?stageId=${encodeURIComponent(boot.stageId)}&k=${encodeURIComponent(boot.k)}`;
}

type FetchResult = { ok: true; status: number; text: string } | { ok: false; message: string };

interface RequestOptions {
  method: "GET" | "POST";
  body?: string;
  timeoutMs: number;
}

/**
 * 唯一的出网口。三件事一处做掉，免得有第二个地方漏掉其中一件：
 * 1. 每个请求都带 `AbortSignal.timeout` —— 一次性页面不许出现没有上限的等待；
 * 2. 不带凭据（页面永不持有长期令牌）、不读缓存（缓存会把过期条目当成还在）；
 * 3. 连不上/超时都说一句人话（`describeNetworkFailure`）。
 */
async function requestText(url: string, options: RequestOptions): Promise<FetchResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  try {
    const response = await fetch(url, {
      method: options.method,
      credentials: "omit",
      cache: "no-store",
      headers,
      body: options.body,
      // signal 同时管住响应头和响应体：await response.text() 超时同样会被中止并报超时。
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    // 先取文本再交给契约层解析：非 JSON 的错误页也能读到 HTTP 码。
    const text = await response.text();
    return { ok: true, status: response.status, text };
  } catch (error) {
    return { ok: false, message: describeNetworkFailure(error, options.timeoutMs) };
  }
}

export async function loadStage(boot: ClipBoot, timeoutMs = STAGE_TIMEOUT_MS): Promise<Parsed<ClipStage>> {
  const response = await requestText(stageUrl(boot), { method: "GET", timeoutMs });
  return response.ok ? parseStagePayload(response.status, response.text) : response;
}

export async function loadFolders(boot: ClipBoot, timeoutMs = FOLDERS_TIMEOUT_MS): Promise<Parsed<string[]>> {
  const response = await requestText(foldersUrl(boot), { method: "GET", timeoutMs });
  return response.ok ? parseFoldersPayload(response.status, response.text) : response;
}

export async function commitClip(
  boot: ClipBoot,
  form: ClipForm,
  timeoutMs = COMMIT_TIMEOUT_MS,
): Promise<Parsed<ClipReceipt>> {
  const response = await requestText(COMMIT_URL, {
    method: "POST",
    body: JSON.stringify(buildCommitBody(boot, form)),
    timeoutMs,
  });
  return response.ok ? parseCommitPayload(response.status, response.text) : response;
}
