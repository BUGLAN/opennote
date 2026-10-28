import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Note } from "../data/types";
import { desktopBridge } from "../desktop/bridge";
import { htmlExcerpt, isHtmlEmpty } from "../lib/htmlPage";
import { releasePage, stagePage } from "../lib/pageStage";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";
import { PageFullscreen } from "./PageFullscreen";

/**
 * HTML 页面（只读页面类型）的渲染视图。
 *
 * ## 两条通道，一套外观
 *
 * | 宿主 | 怎么渲染 | 为什么 |
 * | --- | --- | --- |
 * | 桌面（Electron） | `<iframe src="opennote-page://…" sandbox="allow-scripts">` | 页面脚本**真的执行**；协议响应自带独立 CSP |
 * | 网页 / 移动 | Service Worker 的 `/__page/<token>` + 同样的 iframe | 同一条隔离模型，载体换成 SW |
 *
 * 两条通道都**不给** `allow-same-origin`：页面因此是 opaque origin —— 拿不到
 * `localStorage`（里面有 `opennote.ui.v1` 与 GitHub 令牌）、拿不到 `window.parent.opennote@@、
 * 也读不到工作区里别的文件。这不是「顺手加的属性」：`allow-scripts` 与
 * `allow-same-origin` 同时给等于没沙箱（页面能直接摸父文档）。
 *
 * ## 为什么不把正文塞进 `srcdoc`
 *
 * 子框架**继承父文档的 CSP**。应用窗口的 `script-src` 只放行 `'self' file:` 与内联启动
 * 脚本的 sha256，原型页面的内联 `<script>` 会被静默挡掉 —— 页面看起来渲染了，
 * 但交互全死，只有控制台有一行 violation。必须让页面从一个**自带策略的 URL** 加载。
 *
 * ## 全屏为什么是「对这块容器」而不是「再挂一棵子树」
 *
 * 全屏要放大的是**同一个 iframe**。重新挂一棵子树 = 页面重新加载一轮，滚动位置、
 * 表单内容、动画进度全丢 —— 用户点一下全屏就看到页面「重启」。
 * 所以全屏按钮与它控制的容器在**同一个组件**里（按钮是容器的子元素）。
 */

interface HtmlPageViewProps {
  note: Note;
}

/**
 * iframe 的 sandbox 值 —— **导出成常量是为了能被测试钉住**。
 *
 * 静态渲染（`react-dom/server`）跑不到 effect，所以 iframe 在测试里根本不出现；
 * 而这条属性恰好是**最重要的安全断言**：多一个 `allow-same-origin` 就等于没有沙箱
 * （页面可以直接摸 `parent.document` 与 `localStorage`，后者存着 UI 设置与 GitHub 令牌），
 * 少一个 `allow-scripts` 则会让「允许脚本」这个需求悄悄失效。
 * 两种错误都**不会**被类型系统拦住，所以必须有一条用例直接读这个值。
 */
export const HTML_PAGE_SANDBOX = "allow-scripts";

/**
 * stage 状态机：有了它就**不可能**出现「既在加载又是错误」这种自相矛盾的渲染。
 *
 * 没有 `empty` 这一档 —— 空页面是渲染期就知道的事实（见 `empty`），不是异步过程的结果。
 * 把它放进状态机里会让「谁先判定」变成两个地方的事。
 */
type StageState =
  | { phase: "loading" }
  | { phase: "ready"; src: string; token: string | null }
  | { phase: "failed"; reason: string; retryable: boolean };

export function HtmlPageView({ note }: HtmlPageViewProps): ReactNode {
  const [state, setState] = useState<StageState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageTokenRef = useRef<string | null>(null);

  /*
   * 「空页面」在**渲染期**就判定，不等 effect。
   *
   * effect 里判定的问题是：空文件先闪一帧「正在打开页面」再变成「没有内容」——
   * 而空文件是我们**此刻就知道**的事实，没有任何东西需要等。
   */
  const empty = useMemo(() => isHtmlEmpty(note.content), [note.content]);
  const summary = useMemo(() => htmlExcerpt(note.content, 200), [note.content]);

  useEffect(() => {
    let cancelled = false;
    // 换页面 / 换版本 / 重试：先把上一次 stage 的内容释放掉，别让 SW 里堆着旧正文。
    const previous = stageTokenRef.current;
    if (previous) {
      releasePage(previous);
      stageTokenRef.current = null;
    }
    setState({ phase: "loading" });
    // 空页面在渲染期已经接管（见上面的 `empty`）：这里什么都不用做，也不必去 stage。
    if (empty) return;

    void (async () => {
      const bridge = desktopBridge();
      // ---- 桌面：主进程按路径服务文件（正文不过 IPC，iframe 直接从协议取）
      if (bridge?.page?.urlFor) {
        try {
          const src = await bridge.page.urlFor(note.id);
          if (!cancelled) setState({ phase: "ready", src, token: null });
        } catch (error) {
          if (!cancelled) {
            setState({
              phase: "failed",
              reason: error instanceof Error && error.message ? error.message : "取页面地址失败",
              retryable: true,
            });
          }
        }
        return;
      }
      // ---- 网页 / 移动：交给 Service Worker，换一个自带 CSP 的 URL
      const staged = await stagePage(note.content, { baseUrl: new URL(".", location.href).pathname });
      if (cancelled) {
        if (staged.ok) releasePage(tokenOfUrl(staged.url));
        return;
      }
      if (!staged.ok) {
        setState({ phase: "failed", reason: staged.reason, retryable: true });
        return;
      }
      const token = tokenOfUrl(staged.url);
      stageTokenRef.current = token || null;
      setState({ phase: "ready", src: staged.url, token: token || null });
    })();

    return () => {
      cancelled = true;
    };
    // note.content 进依赖：外部改了文件（磁盘赢）之后要重新 stage，否则显示的是旧内容。
  }, [note.id, note.content, empty, attempt]);

  // 卸载时释放 SW 里那一份：页面关掉之后正文不该继续留在 worker 的内存里。
  useEffect(() => {
    return () => {
      const token = stageTokenRef.current;
      if (token) releasePage(token);
      stageTokenRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("html-page", fullscreen && "html-page--fullscreen")}
      /*
       * `:fullscreen` 是给 CSS 用的钩子：原生全屏时容器本身就变成了全屏元素，
       * 需要把内边距与圆角清零、把 iframe 撑满（见 app.css 的 `.html-page:fullscreen`）。
       */
    >
      <PageFullscreen containerRef={containerRef} title={note.title} onFullscreenChange={setFullscreen} />

      {/* 空页面优先：empty 是渲染期算出来的事实，state 是 effect 里的异步过程。 */}
      {empty ? (
        <HtmlPageNotice
          icon="note"
          title="这个页面没有内容"
          body="文件存在，但里面只有标签骨架、注释或脚本。用你惯用的编辑器补上正文后，切走再切回来即可看到。"
          hint={note.id}
        />
      ) : state.phase === "ready" ? (
        <iframe
          /*
           * key 跟着 src 走：换页面 / 重试时**必须**换一个 iframe 实例。
           * 只改 src 而页面是同源的同一个文档时，浏览器可能复用文档（滚动与脚本状态沿用），
           * 而「重试」的语义就是重新加载一次。
           */
          key={state.src}
          className="html-page__frame"
          src={state.src}
          title={note.title}
          /*
           * allow-scripts：页面里的内联脚本要跑（「允许脚本」）。
           * **不含** allow-same-origin：opaque origin 是这里的核心边界。
           * 不含 allow-top-navigation / allow-popups / allow-forms / allow-modals：
           * 页面不能把整个应用导航走、不能开窗、不能自己弹确认框。
           */
          sandbox={HTML_PAGE_SANDBOX}
          referrerPolicy="no-referrer"
          /*
           * 不设 allow=""：默认就是**全部禁止**（摄像头、麦克风、地理位置、剪贴板…）。
           * 显式写一遍反而会让人以为「这些是可以谈的」。
           */
        />
      ) : state.phase === "failed" ? (
        <HtmlPageNotice
          icon="shield"
          title="页面没能打开"
          body={state.reason}
          hint={note.id}
          action={state.retryable ? { label: "重试", run: () => setAttempt((n) => n + 1) } : undefined}
        />
      ) : (
        <HtmlPageNotice icon="clock" title="正在打开页面" body={summary || "读取文件…"} hint={note.id} />
      )}
    </div>
  );
}

/** 从 `/__page/<token>` 里取回 token（释放时要用）。 */
function tokenOfUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

/** 三态共用的空 / 错 / 加载卡片（同一个组件，避免三处各写一套排版）。 */
function HtmlPageNotice({
  icon,
  title,
  body,
  hint,
  action,
}: {
  icon: "note" | "shield" | "clock";
  title: string;
  body: string;
  hint?: string;
  action?: { label: string; run: () => void };
}): ReactNode {
  return (
    <div className="html-page__notice" role="status">
      <span className="html-page__notice-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <p className="html-page__notice-title">{title}</p>
      <p className="html-page__notice-body">{body}</p>
      {hint ? (
        <p className="html-page__notice-hint" title={hint}>
          {hint}
        </p>
      ) : null}
      {action ? (
        <button type="button" className="btn" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
