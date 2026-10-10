import { useEffect, useState, type ReactNode } from "react";
import type { OpennoteBridge } from "../desktop/bridge";
import { Icon } from "./Icons";

interface WindowControlsProps {
  /** 只在桌面端渲染（没有桥就是浏览器/移动端，那里没有窗口按钮）。 */
  bridge: OpennoteBridge;
}

/**
 * 自绘的三个窗口按钮（最小化 / 最大化还原 / 关闭）。
 *
 * 为什么自绘：macOS 的红绿灯在左上、Windows 的三个按钮在右上，一边一套位置与观感，
 * 系统那一侧改不动 —— 用户要的是**两端一致**。所以两个平台的原生按钮全部隐藏
 * （见 `electron/main.cjs` 顶部说明），由这里画一份，样式与位置逐像素一致。
 *
 * 代价是失去原生绘制，所以三件事的行为必须自己接全：
 *   · 三个动作都经 `bridge.window.*` 转发（IPC 白名单频道，见 `registerWindowHandlers`）；
 *   · **关闭走 `window.close()`**，与点系统关闭按钮同一条路径（D11 的落盘握手挂在 close 上）；
 *   · 最大化状态由主进程推（`onChanged`）＋ 挂载时拉一次（`getState`）—— 用户双击标题栏、
 *     按系统快捷键（⌘M / Win+↑）时图标也要跟着换，不能只在自己点按钮时维护状态。
 *
 * 位置：固定在窗口右上角的浮层（见 `app.css` 的 `.win-controls`）。它不参与 `.app` 的
 * 栅格，所以侧栏收起、大纲开合都不影响它；右侧留白由 `--titlebar-inset` 统一给出。
 */
export function WindowControls({ bridge }: WindowControlsProps): ReactNode {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    // 挂载时先拉一次真实状态：窗口可能是在最大化状态下被打开/刷新的。
    void bridge.window
      .getState()
      .then((state) => {
        if (alive) setMaximized(state.maximized);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.window.onChanged((state) => setMaximized(state.maximized));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  return (
    <div className="win-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="win-controls__btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void bridge.window.minimize()}
      >
        <Icon name="winMin" size={13} />
      </button>
      <button
        type="button"
        className="win-controls__btn"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void bridge.window.toggleMaximize()}
      >
        <Icon name={maximized ? "winRestore" : "winMax"} size={13} />
      </button>
      <button
        type="button"
        className="win-controls__btn win-controls__btn--close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void bridge.window.close()}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
