/**
 * `chrome.storage.local` 的唯一入口（端口/token 快照、上次落点、离线队列）。
 *
 * 02 §5.2.3：令牌只存在客户端本地；扩展里也只落 `chrome.storage.local`，
 * **绝不写进 URL、绝不进 console 日志**。
 */

const KEY = "opennote.clip.state.v1";

export function defaultState() {
  return {
    /** 47 字符 `opn_…` 令牌；null = 还没配对。 */
    token: null,
    /** 上次成功的端口（只是线索，探测仍按 8787→8796 顺序）。 */
    port: null,
    endpoint: null,
    lastOkAt: null,
    /** 落点（上次使用的目录，空串 = 根目录）。 */
    folder: "",
    /** 标签历史（自动补全 + 默认回填）。 */
    tags: [],
    /** 离线暂存队列。 */
    pending: [],
    /** 兼容 `/v1/workspace` 的 P1 缓存。 */
    workspace: null,
    /** 上次剪藏范围：selection | page。 */
    mode: "selection",
  };
}

function area() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    throw new Error("chrome.storage.local 不可用（本模块只能在扩展环境里用）");
  }
  return chrome.storage.local;
}

export async function readState() {
  const bag = await area().get(KEY);
  const stored = bag && bag[KEY];
  return { ...defaultState(), ...(stored && typeof stored === "object" ? stored : {}) };
}

export async function writeState(next) {
  await area().set({ [KEY]: next });
  return next;
}

/** 串行化的读改写，避免 SW 里并发消息互相覆盖。 */
let chain = Promise.resolve();
export function mutate(fn) {
  const run = chain.then(async () => {
    const state = await readState();
    const patch = (await fn(state)) || {};
    const next = { ...state, ...patch };
    await writeState(next);
    return next;
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function clearToken() {
  return mutate(() => ({ token: null, endpoint: null, port: null }));
}

export const STATE_KEY = KEY;
