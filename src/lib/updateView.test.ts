import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../desktop/bridge";
import { updateApplyToastFor, updateSummaryFor, updateViewFor } from "./updateView";

/**
 * 「六态 → 图标/颜色/可点行为/文案」的判据。
 *
 * 这几条是**用户看得见的唯一出口**：红框处那个图标画成什么、点了做什么、提示写什么。
 * 一旦漂移（比如 ready 却画成下载图标），用户会按提示点错东西，所以逐条咬死。
 */

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    supported: true,
    current: "0.5.0",
    phase: "idle",
    latest: null,
    releaseUrl: "https://github.com/BUGLAN/opennote/releases/tag/v0.6.0",
    asset: null,
    progress: null,
    error: null,
    canAutoInstall: true,
    checkedAt: null,
    ...patch,
  };
}

describe("图标与可点行为", () => {
  it("没有状态 / 平台不支持 / 已是最新 → 不占位（红框处空着）", () => {
    expect(updateViewFor(null).visible).toBe(false);
    expect(updateViewFor(status({ supported: false })).visible).toBe(false);
    expect(updateViewFor(status()).visible).toBe(false);
  });

  it("正在检查 → 灰色旋转图标，不可点", () => {
    const view = updateViewFor(status({ phase: "checking" }));
    expect(view).toMatchObject({ visible: true, icon: "rotate", tone: "muted", action: null, ring: null });
    expect(view.title).toContain("正在检查");
  });

  it("有更新 → 强调色下载图标，点击即下载，tooltip 带版本与体积", () => {
    const view = updateViewFor(
      status({ phase: "available", latest: "0.6.0", asset: { name: "Opennote-0.6.0-win-x64.zip", size: 158472430 } }),
    );
    expect(view).toMatchObject({ visible: true, icon: "download", tone: "accent", action: "download" });
    expect(view.title).toContain("v0.6.0");
    expect(view.title).toContain("v0.5.0");
    expect(view.title).toContain("151.1 MB");
  });

  it("下载中 → 画进度弧、点击是取消；解压阶段措辞必须换成「正在解压」", () => {
    const downloading = updateViewFor(
      status({ phase: "downloading", latest: "0.6.0", progress: { kind: "download", received: 10, total: 100, percent: 42 } }),
    );
    expect(downloading).toMatchObject({ icon: "download", tone: "accent", action: "cancel", ring: 42 });
    expect(downloading.title).toContain("正在下载");
    expect(downloading.title).toContain("42%");

    const extracting = updateViewFor(
      status({ phase: "downloading", latest: "0.6.0", progress: { kind: "extract", received: 3, total: 6, percent: 50 } }),
    );
    expect(extracting.title).toContain("正在解压");
  });

  it("下载完成 → 强调色重启图标（与「下载」是两个不同的图标）", () => {
    const view = updateViewFor(status({ phase: "ready", latest: "0.6.0" }));
    expect(view).toMatchObject({ visible: true, icon: "rotate", tone: "accent", action: "restart", ring: null });
    expect(view.title).toContain("点击重启并更新");
  });

  it("失败：启动静默检查不打扰用户，用户主动检查过才显示可重试图标", () => {
    const failed = status({ phase: "error", error: { code: "NETWORK", message: "连接更新服务失败，请检查网络后重试" } });
    expect(updateViewFor(failed).visible).toBe(false);
    const shown = updateViewFor(failed, { showError: true });
    expect(shown).toMatchObject({ visible: true, tone: "accent", action: "retry" });
    expect(shown.title).toContain("连接更新服务失败");
    expect(shown.title).toContain("点击重试");
  });
});

describe("设置面板里的状态说明", () => {
  it("逐态给出一句话，且都带当前版本", () => {
    expect(updateSummaryFor(status())).toContain("已是最新");
    expect(updateSummaryFor(status({ phase: "checking" }))).toContain("正在检查");
    expect(
      updateSummaryFor(status({ phase: "available", latest: "0.6.0", asset: { name: "x.zip", size: 158472430 } })),
    ).toContain("最新 v0.6.0");
    expect(updateSummaryFor(status({ phase: "ready", latest: "0.6.0" }))).toContain("重启并更新");
    expect(updateSummaryFor(status({ phase: "error", error: { code: "DISK_FULL", message: "磁盘空间不足" } }))).toContain(
      "磁盘空间不足",
    );
  });

  it("平台不支持时说清楚「为什么没有自动更新」，而不是假装能更新", () => {
    const text = updateSummaryFor(status({ supported: false }));
    expect(text).toContain("Windows x64");
    expect(text).toContain("v0.5.0");
  });

  it("读到检查时间时把时间也写出来（一个事实一个产地）", () => {
    const text = updateSummaryFor(status({ checkedAt: "2026-10-06T11:27:59.000Z" }));
    expect(text).toMatch(/检查/);
  });

  it("桌面端桥读不到时才说「读取更新状态失败」", () => {
    expect(updateSummaryFor(null, { desktop: true })).toContain("读取更新状态失败");
  });
});

describe("网页版的更新说明", () => {
  it("网页版不撒谎说「读取失败」：说明仅桌面版可更新，并带上构建时的版本号", () => {
    (globalThis as Record<string, unknown>).__OPENNOTE_VERSION__ = "0.7.3";
    try {
      const text = updateSummaryFor(null, { desktop: false });
      expect(text).toContain("网页版");
      expect(text).toContain("v0.7.3");
      expect(text).toContain("桌面版");
      expect(text).not.toContain("读取更新状态失败");
    } finally {
      delete (globalThis as Record<string, unknown>).__OPENNOTE_VERSION__;
    }
  });

  it("构建常量也读不到（退化环境）→ 只说清「仅桌面版」，不报错", () => {
    const text = updateSummaryFor(null, { desktop: false });
    expect(text).toContain("桌面版");
    expect(text).not.toContain("读取更新状态失败");
  });
});

describe("上次覆盖结果的提示", () => {
  it("成功 → 告诉用户新版本号与原来版本", () => {
    const toast = updateApplyToastFor({ ok: true, from: "0.5.0", to: "0.6.0", error: null });
    expect(toast?.kind).toBe("info");
    expect(toast?.message).toContain("0.6.0");
    expect(toast?.detail).toContain("0.5.0");
  });

  it("失败 → 明确说「仍在运行旧版本」，并把原因带上", () => {
    const toast = updateApplyToastFor({ ok: false, from: "0.5.0", to: "0.6.0", error: "复制失败：Opennote.exe" });
    expect(toast?.kind).toBe("danger");
    expect(toast?.message).toContain("旧版本");
    expect(toast?.detail).toContain("复制失败");
  });

  it("没有结果 → 不弹任何东西", () => {
    expect(updateApplyToastFor(null)).toBeNull();
  });
});
