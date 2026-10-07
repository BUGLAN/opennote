/**
 * 页面内桥（`postMessage`）—— 网页版 Opennote 的剪藏入口（契约 02 §5.7 / FR-39）。
 *
 * **为什么需要它**：网页版的 CSP 是 `default-src 'self'` + `connect-src 'self'`
 * （`vite.config.ts` 的 `contentSecurityPolicyPlugin()`），页面**不能** fetch
 * `127.0.0.1` 的本地接口；桌面版才有本地桥。所以「剪藏扩展 → 已打开的网页版标签页」
 * 是网页版唯一的外部写入通道，载体只能是扩展的 content script 与页面之间的
 * `window.postMessage`。
 *
 * **一条必须写下来的订正**（02 §5.7 的页面侧第 2 条）：契约要求页面校验
 * `event.origin` 是扩展来源（`chrome-extension://<id>`）。这条在 postMessage 上
 * **不可实现** —— 内容脚本与页面共享同一个 window，同窗口消息的 `origin` 必然是
 * 页面自己的 origin（Chrome 官方文档："Although the execution environments of content
 * scripts and the pages that host them are isolated from each other, they share access
 * to the page's DOM"，两个方向的通信都只能走这个共享的窗口）。因此这里的判据是：
 *
 * ```
 * 1. event.source === window         拒绝 iframe 转发（官方文档给出的判据）
 * 2. event.origin === location.origin 同窗口消息
 * 3. data.type 以 "opennote:inpage:" 开头且 v === 1
 * 4. reqId 是字符串且 ≤ 64 字符
 * 5. 信封过 validateImportEnvelope()（由接收端负责）
 * 任一失败 → 不回复、不入库、console.warn 一条脱敏记录
 * ```
 *
 * 页面自己的脚本本来就能直接调用应用内部 API，一条假的 origin 判据只会制造
 * 「看起来更安全」的错觉。订正已记进 `docs/import/02-接口契约-导入信封与通道.md` §5.7。
 *
 * 本模块只做「收到什么、怎么判、回什么」，不碰 React、不碰 store：宿主（window /
 * postMessage / 监听器）从参数注入，所以判据可以在 node 里直接跑。
 */

import { setImportChannelContext, type EnvelopeOutcome } from "./receive";

/* ============================== 协议常量 ============================== */

/**
 * 消息类型前缀。**唯一事实源**：扩展侧的注入脚本（`content/inpage-bridge.js`）
 * 因为内容脚本不能 `import`，会重复这几个字面量 —— `extension/verify.mjs` 的 V21
 * 逐字比对两处，漂了当场红。
 */
export const INPAGE_PREFIX = "opennote:inpage:";
export const INPAGE_VERSION = 1;
export const INPAGE_HELLO = "opennote:inpage:hello";
export const INPAGE_READY = "opennote:inpage:ready";
export const INPAGE_IMPORT = "opennote:inpage:import";
export const INPAGE_RESULT = "opennote:inpage:result";
export const INPAGE_EVENT = "opennote:inpage:event";

/** `reqId` 上限（契约 §5.7 第 4 条）。 */
export const INPAGE_MAX_REQ_ID = 64;
/** 单条消息上限：1 MiB（契约 §5.7）。超过则扩展侧改走本地桥，页面这一侧只拒收。 */
export const INPAGE_MAX_BYTES = 1024 * 1024;

/** 已知的四条入站类型（`event` 只由页面发出，不在入站集合里）。 */
const INBOUND_TYPES: readonly string[] = [INPAGE_HELLO, INPAGE_IMPORT];

export interface InpageMessage {
  type: string;
  v: number;
  reqId: string;
  /** 仅 `opennote:inpage:import` 携带。 */
  envelope?: unknown;
}

/**
 * 处理结果的原因串。**只说结构、不含任何正文** —— 它会被写进 `console.warn`，
 * 而这条消息的来源本身就不被信任。
 */
export type InpageReason =
  | "not-self-window"
  | "foreign-origin"
  | "not-json"
  | "bad-prefix"
  | "bad-version"
  | "bad-reqid"
  | "unknown-type"
  | "too-large";

export interface InpageEventLike {
  source: unknown;
  origin: string;
  data: unknown;
}

/* ============================== 校验 ============================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 一条入站消息的形状判据（不含 origin / source —— 那是 `validateInpageEvent` 的事）。 */
export function readInpageMessage(data: unknown): { ok: true; message: InpageMessage } | { ok: false; reason: InpageReason } {
  if (!isRecord(data)) return { ok: false, reason: "not-json" };
  const type = data.type;
  if (typeof type !== "string" || !type.startsWith(INPAGE_PREFIX)) return { ok: false, reason: "bad-prefix" };
  if (data.v !== INPAGE_VERSION) return { ok: false, reason: "bad-version" };
  const reqId = data.reqId;
  if (typeof reqId !== "string" || reqId.length === 0 || reqId.length > INPAGE_MAX_REQ_ID) {
    return { ok: false, reason: "bad-reqid" };
  }
  if (!INBOUND_TYPES.includes(type)) return { ok: false, reason: "unknown-type" };
  return { ok: true, message: { type, v: data.v, reqId, envelope: data.envelope } };
}

/**
 * 事件级判据：先看「是不是自己这个窗口发的」，再看 origin 与形状。
 * 失败只回原因串，**不回复任何消息**（不回执就不会给探测者任何信号）。
 */
export function validateInpageEvent(
  event: InpageEventLike,
  self: { window: unknown; origin: string },
): { ok: true; message: InpageMessage; origin: string } | { ok: false; reason: InpageReason } {
  if (event.source !== self.window) return { ok: false, reason: "not-self-window" };
  if (event.origin !== self.origin) return { ok: false, reason: "foreign-origin" };
  const read = readInpageMessage(event.data);
  if (!read.ok) return read;
  return { ok: true, message: read.message, origin: event.origin };
}

/**
 * 载荷字节数（`postMessage` 会把对象结构化复制一份，大对象会同时卡住两个页面）。
 *
 * 用 `JSON.stringify` 而不是结构化遍历：信封本来就是 JSON（`opennote.import/v1`
 * 要求整个请求体可序列化），而 `bodyFile` 那种外置形态在页面内桥上是不可达的
 * （页面没有工作区里的临时文件可读）。
 */
export function inpagePayloadBytes(data: unknown): number | null {
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return null; // 循环引用 / BigInt：不是我们能收的东西
  }
  if (typeof text !== "string") return null;
  return new TextEncoder().encode(text).byteLength;
}

/* ============================== 宿主与桥 ============================== */

/** 页面侧的环境（测试里注入假实现；浏览器里由 `installInpageBridge()` 填）。 */
export interface InpageHost {
  /** 页面自己的 `window`（与 `event.source` 比对）。 */
  window(): unknown;
  /** 页面自己的 origin（`location.origin`）。 */
  origin(): string;
  onMessage(handler: (event: InpageEventLike) => void): () => void;
  /** 发消息：`targetOrigin` **必须显式给出**（契约硬红线：绝不 `"*"`）。 */
  post(data: unknown, targetOrigin: string): void;
  /** 脱敏告警（不入库、不回复，只留一条可排查的记录）。 */
  warn(message: string): void;
}

export interface InpageBridgeDeps {
  /** 当前笔记本（`name` 为 null = 没有打开笔记本）。 */
  workspace(): { name: string | null; writable: boolean };
  /** 真正入库的入口（生产实现是 `receiveEnvelopeOutcome`，永不抛）。 */
  receive(raw: unknown): Promise<EnvelopeOutcome>;
}

/** 原因串 → 人话（只进 console，不进界面；正文一个字都不带）。 */
const REASON_TEXT: Record<InpageReason, string> = {
  "not-self-window": "不是本窗口发出的消息（iframe 转发一律拒绝）",
  "foreign-origin": "来源 origin 与页面不一致",
  "not-json": "数据不是对象",
  "bad-prefix": "type 前缀不是 opennote:inpage:",
  "bad-version": "v 不是 1",
  "bad-reqid": `reqId 不是 1–${INPAGE_MAX_REQ_ID} 字符的字符串`,
  "unknown-type": "类型不在已知集合里",
  "too-large": `载荷超过 ${INPAGE_MAX_BYTES} 字节`,
};

/**
 * 装一条页面内桥，返回退订函数。装一次即可（`App.tsx` 在根上装）。
 *
 * 纪律：**任何一条入站消息都先过 `validateInpageEvent`**；`hello` 只回 `ready`
 * （不落盘），`import` 才入库，且入库前先把通道声明成 `"inpage"` —— 不声明的话
 * 通道会停在模块默认的 `"in-app"`，于是「外部导入先进收件箱」（00 §6.14㉕）与
 * `overwrite` 的通道闸门会同时静默失效（App.tsx 里本地桥那条注释记的是同一件事）。
 */
export function createInpageBridge(host: InpageHost, deps: InpageBridgeDeps): () => void {
  /** 回复一律回到**校验过的**那个 origin，绝不用 "*"。 */
  const reply = (data: unknown, origin: string): void => {
    host.post(data, origin);
  };

  const handleHello = (message: InpageMessage, origin: string): void => {
    const workspace = deps.workspace();
    reply(
      {
        type: INPAGE_READY,
        v: INPAGE_VERSION,
        reqId: message.reqId,
        ok: true,
        workspace: { name: workspace.name, writable: workspace.writable },
      },
      origin,
    );
  };

  const handleImport = async (message: InpageMessage, origin: string): Promise<void> => {
    const bytes = inpagePayloadBytes(message.envelope);
    if (bytes === null || bytes > INPAGE_MAX_BYTES) {
      // 渠道级上限：**如实拒绝**，不回一条假装成功的空结果。
      reply(
        {
          type: INPAGE_RESULT,
          v: INPAGE_VERSION,
          reqId: message.reqId,
          ok: false,
          error: {
            code: "IMP-4005",
            message: `envelope exceeds the in-page bridge limit (${bytes ?? "unserializable"} bytes)`,
            userMessage: "这次剪藏的内容超过了网页版通道的 1 MB 上限，没有入库。",
            http: 413,
            retryable: false,
          },
        },
        origin,
      );
      return;
    }
    setImportChannelContext({ channel: "inpage" });
    const outcome = await deps.receive(message.envelope);
    reply(
      outcome.ok
        ? { type: INPAGE_RESULT, v: INPAGE_VERSION, reqId: message.reqId, ok: true, result: outcome.result }
        : { type: INPAGE_RESULT, v: INPAGE_VERSION, reqId: message.reqId, ok: false, error: outcome.error },
      origin,
    );
  };

  return host.onMessage((event) => {
    const verdict = validateInpageEvent(event, { window: host.window(), origin: host.origin() });
    if (!verdict.ok) {
      host.warn(`[opennote] 忽略一条来源不明的页面内桥消息（${verdict.reason}：${REASON_TEXT[verdict.reason]}）`);
      return;
    }
    const { message, origin } = verdict;
    if (message.type === INPAGE_HELLO) {
      handleHello(message, origin);
      return;
    }
    void handleImport(message, origin).catch((error) => {
      // `receive` 约定永不抛（见其注释）；真抛了也只能如实回一条失败，不能静默。
      reply(
        {
          type: INPAGE_RESULT,
          v: INPAGE_VERSION,
          reqId: message.reqId,
          ok: false,
          error: {
            code: "IMP-5001",
            message: error instanceof Error ? error.message : String(error),
            userMessage: "写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。",
            http: 500,
            retryable: true,
          },
        },
        origin,
      );
    });
  });
}

/**
 * 浏览器里的宿主实现。**只读环境**（`window` 之外的东西）都在这里，
 * 逻辑那一半留在上面，判据才能在没有 DOM 的 node 里跑。
 */
export function installInpageBridge(deps: InpageBridgeDeps): () => void {
  return createInpageBridge(
    {
      window: () => window,
      origin: () => window.location.origin,
      onMessage: (handler) => {
        const listener = (event: MessageEvent): void => {
          handler({ source: event.source, origin: event.origin, data: event.data });
        };
        window.addEventListener("message", listener);
        return () => window.removeEventListener("message", listener);
      },
      post: (data, targetOrigin) => {
        window.postMessage(data, targetOrigin);
      },
      warn: (message) => console.warn(message),
    },
    deps,
  );
}
