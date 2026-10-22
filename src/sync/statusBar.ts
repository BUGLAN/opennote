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
  /**
   * 逐字显示的那一小段。**不带「同步 · 」前缀** —— 前缀本身就是噪音。
   *
   * `null` = 不写字，只留图标：
   * - 安静态（一切正常）；
   * - **正在同步** —— 只显示一个旋转的小环。写字会让右侧按钮组变宽、整条底栏重排。
   */
  label: string | null;
  /** 悬浮说明。进度数字只在这里出现（不再画那条横穿的进度线）。 */
  title: string;
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
 * | 正在同步 | **只转一个 13px 小环**（不写字、不画线） | 有东西在动；底栏是写作时的余光区域 |
 * | 需要他动手 | N 处冲突 / 密钥失效 / 未导入密钥 | 只有他能解决，不说就是死锁 |
 * | 出了状况 | 离线 / 失败 / 远端列表不完整 | 沉默会被误读成「同步好了」 |
 *
 * ## ★ 不许再画底部进度横线
 *
 * 以前「正在同步」会在底栏顶边拉一条 2px 横线（`.statusbar__track`），从 0 扫到 100%。
 * 它贴着屏幕底部横穿整幅宽度，而写文档时人眼对余光里的**横向移动**最敏感：
 * 每推进一格就把注意力拽走一次，「进度条没到头」本身还在持续制造未完成感。
 *
 * 现在只转一颗 13px 的小环（与安静态图标同一个槽位 ⇒ 底栏不重排），
 * 进度数字退到悬浮说明里；想看清就去悬停 / 打开同步对话框。
 *
 * 「没开同步」也返回 `null`：同步是逐笔记本的开关，关着就是一个普通笔记本，
 * 不该常驻一句「同步 · 关」提醒他去开。
 */
export function syncStatusBarInfo(state: SyncUiState, hasWorkspace: boolean): SyncBarInfo | null {
  if (!hasWorkspace) return null;

  // ① 前置：没有密钥就谈不上同步，而这条**只有用户能解决**。
  if (!state.hasKey) {
    return { tone: "warn", label: "未导入密钥", title: "这台设备还没有账号密钥；导入之后才能同步" };
  }
  if (state.reason === "incomplete") {
    return { tone: "warn", label: "同步未配置完", title: "还差服务地址或远端笔记本；点击补全" };
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
        // 不写字：小环转起来就够了，而文字一出现按钮组就变宽、底栏会跳一下。
        label: null,
        // 进度没有消失，只是退到悬浮说明里 —— 想看得细的人自己去拿。
        title: known ? `正在同步：${progress.done} / ${progress.total} 个文件` : "正在同步…",
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
        };
      }
      const suspended = state.last?.suspendedDeletes ?? 0;
      if (suspended > 0) {
        return {
          tone: "warn",
          label: `${suspended} 条删除已暂缓`,
          title: "远端说这些笔记没了，但它上次没把列表给全，所以先不删本机文件",
        };
      }
      if (state.last?.treeTruncated) {
        return {
          tone: "warn",
          label: "远端列表不完整",
          title: "这一轮没拿到完整的远端文件列表，删除判断被暂停了",
        };
      }
      /*
       * ★ 本地扫描不全（H3）：某个目录读不到（被占用 / 没权限）时，**推送侧的删除**会被挂起。
       * 必须说出来 —— 否则用户看到的是「我删了东西但远端没变」，以为同步坏了。
       */
      if (state.last?.scanIncomplete === true || (state.last?.suspendedPushDeletes ?? 0) > 0) {
        return {
          tone: "warn",
          label: "本地目录没读全",
          title: "有目录这一轮没读出来，所以没有推断删除（新增与修改照常同步）",
        };
      }
      return null;
    }
    // offline / error / key-rotated：都要让人看见。
    return {
      tone: text.tone === "error" ? "error" : "warn",
      label: text.label,
      title: text.detail === null ? text.label : `${text.label} — ${text.detail}`,
    };
  }

  // ④ 正在接上（正常是一瞬间；真卡住时用户至少看得见，而不是一片空白）
  if (state.phase === "attaching") {
    // 同样只转图标：接上的过程不该在底栏里换来换去。
    return { tone: "busy", label: null, title: "正在接上同步服务…" };
  }
  return null;
}
