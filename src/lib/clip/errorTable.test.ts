import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { IMPORT_ERRORS, IMPORT_WARNINGS } from "./envelope";

/**
 * 错误码表的「多产地逐字」护栏（`scripts/verify-contract.cjs` 的 `C-6f` 单元版）。
 *
 * 为什么需要它：同一个错误码的 `userMessage` 在**三个产地**各写一份 ——
 * `src/lib/clip/envelope.ts`（接收端）、`electron/bridge.cjs`（桥）、`src/data/inbox.ts`（收件箱）。
 * 现实里已经漂移过一次：`IMP-4008` 的文案从 `02` 附录 A.3 的表格里抄下来时，
 * **把 Markdown 的内联代码标记（反引号）也一起抄进了字符串** —— 用户会看到「不能使用 `..`」。
 * 这类错「看着一样」，只能按类扫全表（不按条目扫）才抓得住。
 */
interface BridgeErrorRow {
  http?: number;
  retryable?: boolean;
  message?: string;
  userMessage?: string;
}

/** 用 `createRequire` 读桥的错误表：`bridge.cjs` 顶层只 require node 内建，不会拉起 Electron 运行时。 */
function bridgeErrorTable(): Record<string, BridgeErrorRow> {
  const requireCjs = createRequire(import.meta.url);
  const bridge = requireCjs("../../../electron/bridge.cjs") as { ERROR_TABLE?: Record<string, BridgeErrorRow> };
  if (!bridge.ERROR_TABLE) throw new Error("electron/bridge.cjs 没有导出 ERROR_TABLE");
  return bridge.ERROR_TABLE;
}

describe("错误码表 · 与桥逐字对齐（C-6f）", () => {
  it("IMP-4008 的 userMessage 与 electron/bridge.cjs 的 ERROR_TABLE 逐字相等（且不含反引号）", () => {
    const row = bridgeErrorTable()["IMP-4008"];
    expect(row?.userMessage).toBeTruthy();

    expect(IMPORT_ERRORS["IMP-4008"].userMessage).toBe(row.userMessage);
    expect(IMPORT_ERRORS["IMP-4008"].userMessage).not.toContain("`");
    expect(IMPORT_ERRORS["IMP-4008"].http).toBe(row.http);
    expect(IMPORT_ERRORS["IMP-4008"].retryable).toBe(row.retryable);
  });

  it("全表扫描：任何一条 userMessage / message 都不得含反引号（Markdown 代码标记不是文案）", () => {
    const offenders: string[] = [];
    for (const [code, entry] of Object.entries(IMPORT_ERRORS)) {
      for (const field of ["userMessage", "message"] as const) {
        if (entry[field].includes("`")) offenders.push(`${code}.${field}: ${entry[field]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("全表扫描：警告文案同样不得含反引号", () => {
    const offenders = Object.entries(IMPORT_WARNINGS)
      .filter(([, text]) => text.includes("`"))
      .map(([code, text]) => `${code}: ${text}`);
    expect(offenders).toEqual([]);
  });
});
