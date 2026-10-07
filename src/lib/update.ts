import { useCallback, useEffect, useRef, useState } from "react";
import { desktopBridge, type UpdateApplyResult, type UpdateStatus } from "../desktop/bridge";
import { askConfirm } from "./dialogs";
import { createStore, useStore } from "./store";
import { notify } from "./toast";
import { updateApplyToastFor, updateViewFor, type UpdateAction, type UpdateView } from "./updateView";

/**
 * 渲染层的更新接线：订阅主进程广播、把状态放进 store、把「点图标」翻译成一次 IPC。
 *
 * 这里**不判断任何更新逻辑**（版本谁新、包从哪来、能不能覆盖都在主进程）：渲染层只
 * 「显示状态 + 转发动作」。所以浏览器端（没有 `window.opennote`）天然没有更新入口。
 */

export const updateStore = createStore<UpdateStatus | null>(null);

export function useUpdateStatus(): UpdateStatus | null {
  return useStore(updateStore);
}

export interface UpdateController {
  status: UpdateStatus | null;
  view: UpdateView;
  /** 红框图标被点击时调用（动作来自 `updateViewFor`，不是调用方自己猜的）。 */
  act(action: UpdateAction): void;
  /** 设置面板里的「检查更新」（手动检查 → 失败要看得见）。 */
  check(): void;
  restart(): void;
}

export function useUpdateController(): UpdateController {
  const status = useUpdateStatus();
  const [showError, setShowError] = useState(false);
  /** 同一次下载只提示一次「已下载」，避免主进程重复广播时反复弹 toast。 */
  const announcedReady = useRef<string | null>(null);
  const announcedApply = useRef(false);
  const actRef = useRef<(action: UpdateAction) => void>(() => {});

  const announceApply = useCallback((result: UpdateApplyResult | null | undefined) => {
    if (!result || announcedApply.current) return;
    announcedApply.current = true;
    const toast = updateApplyToastFor(result);
    if (toast) notify(toast.message, { kind: toast.kind, detail: toast.detail });
  }, []);

  const announceReady = useCallback((next: UpdateStatus) => {
    if (next.phase !== "ready" || !next.latest) return;
    if (announcedReady.current === next.latest) return;
    announcedReady.current = next.latest;
    notify(`v${next.latest} 已下载。点左上角的 ⟳ 重启并更新 —— 笔记会先保存。`, {
      action: { label: "立即重启", run: () => actRef.current("restart") },
      duration: 8000,
    });
  }, []);

  useEffect(() => {
    const update = desktopBridge()?.update;
    if (!update) return;
    let alive = true;
    const off = update.onChanged((next) => {
      if (!alive || !next) return;
      updateStore.set(next);
      announceApply(next.applyResult);
      announceReady(next);
    });
    void update
      .status()
      .then((next) => {
        if (!alive || !next) return;
        updateStore.set(next);
        // 「上次覆盖的结果」只在启动后第一次 status 上出现一次，这里必须接住。
        announceApply(next.applyResult);
        announceReady(next);
      })
      .catch(() => {
        /* 读不到状态就不显示更新入口，不打扰用户 */
      });
    return () => {
      alive = false;
      off();
    };
  }, [announceApply, announceReady]);

  const act = useCallback((action: UpdateAction) => {
    const update = desktopBridge()?.update;
    if (!update) return;
    setShowError(true);
    void (async () => {
      try {
        if (action === "cancel") {
          updateStore.set(await update.cancel());
          return;
        }
        if (action === "restart") {
          // 确认框放在渲染层（应用内对话框）：这一步会关闭应用并覆盖安装目录，
          // 而主进程弹原生模态会挡住自动化与 e2e。
          const status = updateStore.get();
          const confirmed = await askConfirm({
            title: `重启并更新到 v${status?.latest ?? ""}？`,
            message: "Opennote 会先保存尚未落盘的笔记，然后关闭、用新版本覆盖当前目录，再自动打开。",
            note: "笔记文件在你自己的文件夹里，不受影响。",
            confirmLabel: "重启并更新",
          });
          if (!confirmed) return;
          const result = await update.restart();
          if (!result.ok && result.reason === "CANCELLED") {
            notify("已取消。随时可以再点重启更新。");
          } else if (!result.ok) {
            notify("重启更新没能开始", { kind: "danger", detail: result.reason ?? "未知原因" });
          }
          return;
        }
        // download / retry：重试先重新查一遍，避免拿着过期的资产信息去下 151 MB。
        if (action === "retry") {
          const checked = await update.check({ force: true });
          updateStore.set(checked);
        }
        const phase = updateStore.get()?.phase;
        if (phase === "available" || phase === "error") {
          updateStore.set(await update.download());
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "更新操作失败", { kind: "danger" });
      }
    })();
  }, []);

  actRef.current = act;

  const check = useCallback(() => {
    const update = desktopBridge()?.update;
    if (!update) return;
    setShowError(true);
    void (async () => {
      try {
        const next = await update.check({ force: true });
        updateStore.set(next);
        if (next.phase === "idle") notify(`已是最新版本 v${next.current}`);
        else if (next.phase === "error") notify(next.error?.message ?? "检查更新失败", { kind: "danger" });
      } catch (error) {
        notify(error instanceof Error ? error.message : "检查更新失败", { kind: "danger" });
      }
    })();
  }, []);

  const restart = useCallback(() => act("restart"), [act]);

  return { status, view: updateViewFor(status, { showError }), act, check, restart };
}
