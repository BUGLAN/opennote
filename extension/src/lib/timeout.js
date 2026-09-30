/**
 * 「等待必须有出口」—— popup 是一次性界面：**任何一个永不 settle 的 `await` 都等于永久白屏**。
 *
 * 用户实测就撞上了这件事：`opennote:load` 卡在 `chrome.scripting.executeScript`（注入没有超时），
 * 主按钮永远停在 `正在读取页面…`，界面完全不可用。这个模块只做一件事：给任意 promise
 * 一个**明确的时限与出口**，绝不无限 pending。
 *
 * 两种用法：
 *  - `withTimeout(promise, ms, label)`：超时 → reject `TimeoutError`（调用方必须处理）；
 *  - `settleWithin(promise, ms, label)`：不抛，返回 `{ ok, value }` / `{ ok:false, reason }`，
 *    调用方按 `reason`（`"timeout"` / `"error"`）给出用户可见的下一步。
 */

/** 超时专用错误：`instanceof` 可判别，`label` 说明是哪一步超时（用于如实报错，不吞掉原因）。 */
export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label || "操作"}在 ${ms}ms 内没有返回`);
    this.name = "TimeoutError";
    this.label = label || null;
    this.ms = ms;
  }
}

/** 超时 → reject(TimeoutError)；正常 → 原样返回结果；原 promise reject → 原样抛出（不吞错）。 */
export function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 不抛版本：调用方**必须**看 `ok`/`reason` 决定给用户看什么。 */
export async function settleWithin(promise, ms, label) {
  try {
    return { ok: true, value: await withTimeout(promise, ms, label) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof TimeoutError ? "timeout" : "error",
      error,
      message: error && error.message ? error.message : String(error),
    };
  }
}
