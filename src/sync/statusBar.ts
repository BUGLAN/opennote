/**
 * 状态栏同步位：**什么时候出现、出现时说什么**。
 *
 * 单独成文件是为了**能被单独测** —— 它是纯函数，但住在 `appSync.ts` 里时
 * 会连带拉起密钥存储、工作区注册表那一整套单例，用例根本 import 不动。
 */

import { describeSyncStatus } from "./runner";
import type { SyncUiState } from "./appSync";

/** 状态栏同步位的色调（决定那个圆点的颜色）。 */
export type SyncBarTone = "busy" | "warn" | "error";

/** 状态栏同步位要显示的东西。*/
export interface SyncBarInfo {
  tone: SyncBarTone;
  /** 逐字显示的那一小段。**不带「同步 · 」前缀** —— 前缀本身就是噪音。 */
  label: string;
  /** 悬浮说明（说清「点它之后会怎样」或「这条为什么出现」）。 */
  title: string;
  /** 0–1；只有「正在同步且知道总数」时才有，其余一律 `null`。 */
  progress: number | null;
}

/**
 * 状态栏那一位要不要出现、出现时说什么。
 *
 * ## ★ 一条规矩：**正常时闭嘴**
 *
 * 以前这里永远返回一句话（「同步 · 已同步」），于是底栏常驻一条
 * 「一切正常」的播报 —— 它永远为真，因此永远没有信息量，只是占位。
 * 现在：**同步正常就返回 `null`，整个渲染位消失**。
 *
 * 只有三种情况值得占用这一条：
 *
 * | 何时 | 说什么 | 为什么值得说 |
 * | --- | --- | --- |
 * | 正在同步 | 同步中 12 / 558 + 2px 进度 | 有东西在动，用户需要知道「还要多久」 |
 * | 需要他动手 | N 处冲突 / 密钥失效 / 未导入密钥 | 只有他能解决，不说就是死锁 |
 * | 出了状况 | 离线 / 失败 / 远端列表不完整 | 沉默会被误读成「同步好了」 |
 *
 * 「没开同步」也返回 `null`：同步是逐笔记本的开关，关着就是一个普通笔记本，
 * 不该常驻一句「同步 · 关」提醒他去开。
 */
export function syncStatusBarInfo(state: SyncUiState, hasWorkspace: boolean): SyncBarInfo | null {
  if (!hasWorkspace) return null;

  // ① 前置：没有密钥就谈不上同步，而这条**只有用户能解决**。
  if (!state.hasKey) {
    return { tone: "warn", label: "未导入密钥", title: "这台设备还没有账号密钥；导入之后才能同步", progress: null };
  }
  if (state.reason === "incomplete") {
    return { tone: "warn", label: "同步未配置完", title: "还差服务地址或远端笔记本；点击补全", progress: null };
  }
  // ② 没开同步：不是异常，别常驻。
  if (state.reason === "disabled") return null;

  // ③ 正在跑
  if (state.status) {
    const text = describeSyncStatus(state.status);
    if (state.status.phase === "syncing") {
      const progress = state.status.progress;
      const known = progress !== null && progress.total > 0;
      return {
        tone: "busy",
        label: known ? `同步中 ${progress.done} / ${progress.total}` : "同步中…",
        title: "正在把这台设备和远端对齐",
        progress: known ? progress.done / progress.total : null,
      };
    }
    if (state.status.phase === "idle") {
      /*
       * ★ **一切正常 ⇒ 不说话。**
       *
       * 下面三种是「同步本身成功，但有东西要你看」的情况 —— 它们才是这一位该出现的理由。
       */
      if (state.status.conflicts > 0) {
        return {
          tone: "warn",
          label: `${state.status.conflicts} 处冲突待处理`,
          title: text.detail ?? "两边都改过同一篇，需要你决定保留哪一份",
          progress: null,
        };
      }
      const suspended = state.last?.suspendedDeletes ?? 0;
      if (suspended > 0) {
        return {
          tone: "warn",
          label: `${suspended} 条删除已暂缓`,
          title: "远端说这些笔记没了，但它上次没把列表给全，所以先不删本机文件",
          progress: null,
        };
      }
      if (state.last?.treeTruncated) {
        return {
          tone: "warn",
          label: "远端列表不完整",
          title: "这一轮没拿到完整的远端文件列表，删除判断被暂停了",
          progress: null,
        };
      }
      return null;
    }
    // offline / error / key-rotated：都要让人看见。
    return {
      tone: text.tone === "error" ? "error" : "warn",
      label: text.label,
      title: text.detail === null ? text.label : `${text.label} — ${text.detail}`,
      progress: null,
    };
  }

  // ④ 正在接上（正常是一瞬间；真卡住时用户至少看得见，而不是一片空白）
  if (state.phase === "attaching") {
    return { tone: "busy", label: "正在接上…", title: "正在接上同步服务", progress: null };
  }
  return null;
}
