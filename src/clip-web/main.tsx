import { createRoot } from "react-dom/client";

/* 与应用同一套字体（self-hosted，无 CDN 往返）：预览的字形要和 Opennote 里看到的一致。 */
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/figtree/index.css";
import "@fontsource-variable/figtree/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";

/* 只读引用应用的样式：令牌与正文排版各只有一处产地。 */
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/prose.css";
import "./clip.css";

import { applySystemThemeOnFirstVisit, applyUi, getUi } from "../data/ui";
import { ClipApp } from "./app";
import { checkBootPort, parseBoot } from "./contract";
import { renderFatalCard } from "./fatal-card";

/**
 * 启动看门狗：模块开始执行了、React 却一直没画出来（组件抛错、某个 import 没回来）时，
 * 12 秒后把静态占位换成一张说实话的失败卡。一次性页面不允许"永久等待"。
 *
 * 它能覆盖的只是"模块已经开始执行"这一段。模块根本没跑（被 CSP 拦下、资源 404、JS 被禁用）时，
 * 兜底的是 `clip/index.html` 里那段静态文字加一句可照做的指引。
 * 每一条网络请求另有 `AbortSignal.timeout`（见 requests.ts），那是第三层。
 */
const BOOT_WATCHDOG_MS = 12000;

const host = document.getElementById("clip-root") ?? document.body;

function fatal(title: string, message: string, note?: string): void {
  window.clearTimeout(watchdog);
  renderFatalCard(host, {
    title,
    message,
    note,
    onRetry: () => location.reload(),
  });
}

const watchdog = window.setTimeout(() => {
  fatal(
    "剪藏页没能启动",
    `等了 ${BOOT_WATCHDOG_MS / 1000} 秒，页面还是没有完成初始化，通常是脚本报错或者资源没加载成功。`,
    "这次剪藏的内容还在本地接口的暂存里：重新载入本页，或者回扩展弹窗重新发起剪藏都可以。",
  );
}, BOOT_WATCHDOG_MS);

// 与应用同一套：首次访问跟随系统主题，再套用 UI 设置（主题/字体预设/字号/行高等令牌）。
applySystemThemeOnFirstVisit();
applyUi(getUi());

const boot = parseBoot(document.getElementById("clip-boot")?.textContent ?? null);

if (!boot.ok) {
  fatal(
    "剪藏页没能打开",
    boot.message,
    "这次剪藏的内容可能还在本地接口的暂存里，但页面拿不到它的编号，所以只能请你重新发起一次。",
  );
} else {
  const portIssue = checkBootPort(boot.value, location.port);
  if (portIssue !== null) {
    // 端口对不上就一个请求都不发：宁可不做事，也不把内容提交到别的服务。
    fatal("剪藏页没有连上正确的接口", portIssue);
  } else {
    // 明确接管容器：不让静态占位和 React 同时留在页面上。
    host.textContent = "";
    createRoot(host).render(<ClipApp boot={boot.value} onReady={() => window.clearTimeout(watchdog)} />);
  }
}
