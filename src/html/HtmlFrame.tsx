import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { desktopBridge } from "../desktop/bridge";
import { cn } from "../lib/utils";
import {
  HTML_SANDBOX_FLAGS,
  MSG_OPEN,
  MSG_READY,
  MSG_RENDER,
  htmlSandboxUrl,
  isOpenableUrl,
  prepareSandboxDocument,
} from "./sandbox";

/**
 * 一个 HTML 文档的沙箱渲染框（协议与隔离理由见 `./sandbox.ts`）。
 *
 * 页面视图（`HtmlView`）与收件箱预览（`InboxPanel`）共用它 —— 两处走同一套 sandbox 令牌、
 * 同一份 CSP、同一条外链放行规则，不各写一遍。
 */

/** 宿主页多久没报到就算加载失败（被代理挡了、文件缺了、CSP 拦了 frame）。 */
const LOAD_TIMEOUT_MS = 8000;

let frameSeq = 0;

interface HtmlFrameProps {
  /** 要渲染的完整文档（资源应已内联；渲染前在这里注入 CSP 与外链拦截）。 */
  html: string;
  /** iframe 的无障碍名称。 */
  title: string;
  className?: string;
}

export function HtmlFrame({ html, title, className }: HtmlFrameProps): ReactNode {
  const doc = useMemo(() => prepareSandboxDocument(html), [html]);
  // 换文档 = 重建 iframe：宿主页只渲染一次（`document.open()` 之后它的消息监听已被清掉），
  // 重建也顺带把上一篇页面里残留的定时器、动画、音视频一并结束。
  const generation = useMemo(() => {
    frameSeq += 1;
    return frameSeq;
  }, [doc]);
  return <SandboxFrame key={generation} doc={doc} title={title} className={className} />;
}

function SandboxFrame({ doc, title, className }: { doc: string; title: string; className?: string }): ReactNode {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [failed, setFailed] = useState(false);

  // layout effect：先挂监听、再给 src —— 宿主页的「就绪」消息不可能早于监听到达。
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let rendered = false;
    const onMessage = (event: MessageEvent) => {
      const target = frame.contentWindow;
      if (!target || event.source !== target) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === MSG_READY && !rendered) {
        rendered = true;
        // 目标源只能是 `*`：沙箱页是不透明源，没有可写的 origin。文档本来就是要给它看的。
        target.postMessage({ type: MSG_RENDER, html: doc }, "*");
        setFailed(false);
        return;
      }
      if (data.type === MSG_OPEN && isOpenableUrl(data.url) && hasUserActivation()) openExternalUrl(data.url);
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => {
      if (!rendered) setFailed(true);
    }, LOAD_TIMEOUT_MS);
    frame.src = htmlSandboxUrl();
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [doc]);

  return (
    <>
      <iframe
        ref={frameRef}
        className={cn("html-frame", className)}
        title={title}
        sandbox={HTML_SANDBOX_FLAGS}
        referrerPolicy="no-referrer"
      />
      {failed ? (
        <div className="html-frame__failed" role="alert">
          页面没能载入：沙箱宿主页（html-sandbox.html）没有响应。
          <br />
          自托管部署时请确认它与应用同源，且没有被加上 X-Frame-Options: DENY。
        </div>
      ) : null}
    </>
  );
}

/**
 * 外链只在**真实用户点击**之后打开：沙箱里的点击会把用户激活传到父页面
 * （User Activation v2 向祖先传播），而页面脚本自己发的消息拿不到这个状态。
 * 不支持该 API 的引擎退回放行 —— 那里本来也没有别的判据。
 */
function hasUserActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return activation ? activation.isActive : true;
}

function openExternalUrl(url: string): void {
  // 桌面版交给主进程（系统默认浏览器）；纯浏览器里开新标签（与收件箱「打开来源」同一条路）。
  const external = desktopBridge()?.shell?.openExternal;
  if (typeof external === "function") {
    void external(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
