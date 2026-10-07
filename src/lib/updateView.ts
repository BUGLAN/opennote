import type { IconName } from "../components/Icons";
import type { UpdateStatus } from "../desktop/bridge";
import { appVersion } from "./appVersion";
import { formatBytes, formatDateTime } from "./utils";

/**
 * 「更新状态 → 图标 / 颜色 / 可点行为 / 文案」的**唯一产地**。
 *
 * 为什么单独一个纯模块：vitest 是 node 环境（没有 DOM），Sidebar 与设置面板都不进单测，
 * 但「哪个状态该画哪个图标、哪句话、点了做什么」恰恰是最容易漂移的部分
 * （同一个事实写两处，就会出现「图标说有更新、面板说已是最新」这种自相矛盾）。
 * 所以这里做成纯函数，两边都只消费它。
 *
 * 颜色：普通 `.icon-btn` 是 `--ink-2`（灰），更新按钮用 `--accent`（每个主题的强调色）
 * —— 这是需求里明确要求的「图标颜色需区分正常图标」。
 */

export type UpdateAction = "download" | "cancel" | "restart" | "retry";

export interface UpdateView {
  visible: boolean;
  icon: IconName;
  /** `accent` = 需要用户注意（可下载 / 待重启 / 失败）；`muted` = 进行中，不抢注意力。 */
  tone: "accent" | "muted";
  title: string;
  action: UpdateAction | null;
  /** 0..100 的进度弧；`null` = 不画。 */
  ring: number | null;
}

const HIDDEN: UpdateView = {
  visible: false,
  icon: "download",
  tone: "muted",
  title: "",
  action: null,
  ring: null,
};

/**
 * @param status 主进程给的更新状态（`null` = 还没读到 / 浏览器端）
 * @param options.showError 只有「用户主动检查过」才把失败显示成图标；
 *        启动时的静默检查失败（断网、限流）不该每次开机都弹一个红叉。
 */
export function updateViewFor(status: UpdateStatus | null, options: { showError?: boolean } = {}): UpdateView {
  if (!status || !status.supported) return HIDDEN;
  switch (status.phase) {
    case "idle":
      return HIDDEN;
    case "checking":
      return { visible: true, icon: "rotate", tone: "muted", title: "正在检查更新…", action: null, ring: null };
    case "available": {
      const size = status.asset && status.asset.size > 0 ? `（${formatBytes(status.asset.size)}）` : "";
      return {
        visible: true,
        icon: "download",
        tone: "accent",
        title: `发现新版本 v${status.latest ?? ""}（当前 v${status.current}）· 点击下载${size}`,
        action: "download",
        ring: null,
      };
    }
    case "downloading": {
      const percent = Math.max(0, Math.min(100, status.progress?.percent ?? 0));
      const label = status.progress?.kind === "extract" ? "正在解压" : "正在下载";
      return {
        visible: true,
        icon: "download",
        tone: "accent",
        title: `${label} v${status.latest ?? ""} — ${percent}%（点击取消）`,
        action: "cancel",
        ring: percent,
      };
    }
    case "ready":
      return {
        visible: true,
        icon: "rotate",
        tone: "accent",
        title: `v${status.latest ?? ""} 已下载 · 点击重启并更新`,
        action: "restart",
        ring: null,
      };
    case "error": {
      if (!options.showError) return HIDDEN;
      const message = status.error?.message ?? "更新失败";
      return { visible: true, icon: "download", tone: "accent", title: `${message} · 点击重试`, action: "retry", ring: null };
    }
    default:
      return HIDDEN;
  }
}

/** 设置面板「更新」那一行左侧的说明文字。与 tooltip 同一批事实，措辞不同。 */
export function updateSummaryFor(status: UpdateStatus | null, options: { desktop?: boolean } = {}): string {
  // 只有**显式** `desktop: false`（网页版）才走这一分支：不传参数的旧调用一律按桌面端
  // 语义处理，别让默认值悄悄改掉「读取更新状态失败」这句话的适用范围。
  if (options.desktop === false) {
    // 网页版没有更新通道，「读取更新状态失败」在这里是撒谎——那是桌面端桥读不到时的话。
    // 如实说明 + 带上构建时烧进包里的版本号（`appVersion()`），别让用户对着一句错误发呆。
    const version = appVersion();
    return version ? `网页版 v${version} · 自动更新只在桌面版提供` : "自动更新只在桌面版提供";
  }
  if (!status) return "读取更新状态失败";
  if (!status.supported) {
    return `当前 v${status.current} · 这个平台没有免安装包，不提供自动更新（只有打包版 Windows x64 可以）`;
  }
  switch (status.phase) {
    case "checking":
      return `当前 v${status.current} · 正在检查…`;
    case "available":
      return `当前 v${status.current} · 最新 v${status.latest ?? ""}${
        status.asset && status.asset.size > 0 ? `（${formatBytes(status.asset.size)}）` : ""
      }`;
    case "downloading": {
      const percent = Math.max(0, Math.min(100, status.progress?.percent ?? 0));
      const label = status.progress?.kind === "extract" ? "解压" : "下载";
      return `正在${label} v${status.latest ?? ""} — ${percent}%`;
    }
    case "ready":
      return `v${status.latest ?? ""} 已下载，点「重启并更新」完成覆盖`;
    case "error":
      return `更新失败：${status.error?.message ?? "未知原因"}`;
    default:
      return status.checkedAt
        ? `已是最新 · v${status.current}（${formatDateTime(Date.parse(status.checkedAt))} 检查）`
        : `已是最新 · v${status.current}`;
  }
}

/** 上一次覆盖安装的结果 → 一句提示（成功与失败都要如实说一次）。 */
export function updateApplyToastFor(
  result: { ok: boolean; from: string; to: string; error: string | null } | null,
): { message: string; detail?: string; kind: "info" | "danger" } | null {
  if (!result) return null;
  if (result.ok) {
    return { message: `已更新到 v${result.to}`, detail: result.from ? `原来是 v${result.from}` : undefined, kind: "info" };
  }
  return {
    message: "上次更新没有完成，仍在运行旧版本",
    detail: result.error ?? undefined,
    kind: "danger",
  };
}
