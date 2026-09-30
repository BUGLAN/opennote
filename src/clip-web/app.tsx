import { useEffect, useReducer } from "react";

import type { ClipBoot } from "./contract";
import { renderPreview } from "./preview";
import { commitClip, loadFolders, loadStage } from "./requests";
import {
  canCommit,
  canRetryFolders,
  canRetryStage,
  clipReducer,
  commitLabel,
  createInitialState,
  draftNote,
  folderOptions,
  receiptView,
  stageFacts,
  statusLine,
} from "./view";

export interface ClipAppProps {
  boot: ClipBoot;
  /** 首次渲染完成：main.tsx 用它撤掉启动看门狗。 */
  onReady: () => void;
}

/**
 * 页面本体。这里只做装配：把状态画出来、把事件派回去、把请求发起/结果派回去。
 * 所有判断（能不能入库、回执怎么说、失败说什么）都在 `view.ts` / `contract.ts` 的纯函数里。
 */
export function ClipApp({ boot, onReady }: ClipAppProps) {
  const [state, dispatch] = useReducer(clipReducer, boot, createInitialState);

  // 画出来一次就算启动成功：此后每一次等待都由请求自己的超时兜着。
  useEffect(() => {
    onReady();
  }, [onReady]);

  /**
   * 读暂存与读目录各只跑一次：`boot` 在页面生命周期里不变，`dispatch` 是稳定的，
   * 所以这里的空依赖数组是故意的。也不套 StrictMode —— 开发期双跑会对桥多发一次请求。
   */
  useEffect(() => {
    void readStage();
    void readFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function readStage(): Promise<void> {
    dispatch({ type: "retry-stage" });
    const result = await loadStage(boot);
    if (result.ok) dispatch({ type: "stage-loaded", stage: result.value });
    else dispatch({ type: "stage-failed", message: result.message });
  }

  async function readFolders(): Promise<void> {
    dispatch({ type: "retry-folders" });
    const result = await loadFolders(boot);
    if (result.ok) dispatch({ type: "folders-loaded", folders: result.value });
    else dispatch({ type: "folders-failed", message: result.message });
  }

  /** 提交读的是**本次渲染的 `state.form`**：用户改过的标题/正文，和用户选好的落点。 */
  async function runCommit(): Promise<void> {
    dispatch({ type: "commit-started" });
    const result = await commitClip(boot, state.form);
    if (result.ok) dispatch({ type: "commit-succeeded", receipt: result.value });
    else dispatch({ type: "commit-failed", message: result.message });
  }

  const now = Date.now();
  const options = folderOptions(state);
  const preview = renderPreview(state.form.body);
  // 暂存还没读到时不谈"正文是空的"：那会变成一句不实的话。
  const draftHint = state.stage.kind === "ready" ? draftNote(state.draftSource) : null;
  const status = statusLine(state);
  const receipt = state.commit.kind === "done" ? receiptView(state.commit.receipt, state.form.folder) : null;

  return (
    <div className="clip">
      <header className="clip__bar">
        <div className="clip__brand">
          <span className="seal" aria-hidden="true">
            記
          </span>
          <span className="clip__brand-name">剪藏确认</span>
        </div>
        {state.stage.kind === "ready" ? (
          <ul className="clip__facts">
            {stageFacts(state.stage.stage, now).map((fact, index) => (
              <li key={index}>{fact}</li>
            ))}
          </ul>
        ) : (
          <p className="clip__bar-note">
            {state.stage.kind === "loading" ? "正在读取这次剪藏…" : "这次剪藏没有读到，下面是原因"}
          </p>
        )}
      </header>

      <main className="clip__body">
        {state.stage.kind === "failed" ? (
          <div className="clip__center">
            <div className="clip__card">
              <p className="clip__card-title">这次剪藏没能读出来</p>
              <p className="clip__note clip__error">{state.stage.message}</p>
              {canRetryStage(state) ? (
                <div className="clip__actions">
                  <button type="button" className="btn" onClick={() => void readStage()}>
                    重试读取
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          /*
           * 两栏顺序：**左预览、右编辑**（用户要求「编辑和预览换一下位置」）。
           * 这里换的是 **DOM 顺序**，不是 CSS 的 `order` —— 视觉顺序与 Tab 键顺序必须一致，
           * 否则键盘/读屏用户看到的焦点走向和眼睛看到的相反。
           * 相应地：`clip.css` 的分隔线从 `--edit` 挪到 `--preview`，
           * 正文标签里的「右边是预览」也要改成「左边」。
           */
          <>
            <section className="clip__pane clip__pane--preview" aria-label="渲染预览">
              <div className="clip__preview-scroll">
                {preview.empty ? (
                  <p className="clip__empty">正文是空的，这里会显示渲染后的效果。</p>
                ) : (
                  <article className="prose clip__prose" dangerouslySetInnerHTML={{ __html: preview.html }} />
                )}
              </div>
            </section>

            <section className="clip__pane clip__pane--edit" aria-label="编辑剪藏内容">
              <label className="clip__label" htmlFor="clip-title">
                标题
              </label>
              <input
                id="clip-title"
                className="field clip__title"
                type="text"
                value={state.form.title}
                placeholder="这次剪藏没有标题"
                onChange={(event) => dispatch({ type: "edit-title", title: event.target.value })}
              />
              <label className="clip__label" htmlFor="clip-body">
                正文（Markdown；左边是同一个渲染器出来的实时预览）
              </label>
              <textarea
                id="clip-body"
                className="clip__editor"
                value={state.form.body}
                spellCheck={false}
                placeholder="这次剪藏没有正文"
                onChange={(event) => dispatch({ type: "edit-body", body: event.target.value })}
              />
              {draftHint !== null ? <p className="clip__note">{draftHint}</p> : null}
            </section>
          </>
        )}
      </main>

      {receipt !== null ? (
        <section className="clip__receipt" aria-label="入库回执">
          <div className="clip__receipt-head">
            <p className="clip__card-title">{receipt.headline}</p>
            <button type="button" className="btn btn--ghost" onClick={() => dispatch({ type: "commit-dismiss" })}>
              收起回执
            </button>
          </div>
          <ul className="clip__card-lines">
            {receipt.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {receipt.warnings.length > 0 ? (
            <>
              <p className="clip__card-title clip__warn-title">接口给的提醒</p>
              <ul className="clip__card-warnings">
                {receipt.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="clip__card-next">{receipt.nextStep}</p>
        </section>
      ) : null}

      <footer className="clip__footer">
        <label className="clip__field" htmlFor="clip-folder">
          落点
        </label>
        <select
          id="clip-folder"
          className="field clip__select"
          value={state.form.folder}
          onChange={(event) => dispatch({ type: "pick-folder", folder: event.target.value })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {canRetryFolders(state) ? (
          <button type="button" className="btn btn--ghost" onClick={() => void readFolders()}>
            重试读取目录
          </button>
        ) : null}
        <span className="clip__grow" />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canCommit(state)}
          aria-busy={state.commit.kind === "running"}
          onClick={() => void runCommit()}
        >
          {commitLabel(state)}
        </button>
        <p className={`clip__status${status.tone === "error" ? " clip__error" : ""}`} role="status" aria-live="polite">
          {status.text}
        </p>
      </footer>
    </div>
  );
}
