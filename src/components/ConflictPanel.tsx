/**
 * 冲突裁决面板（`docs/…` §6.1 L3 收尾层）。
 *
 * ## 它要解决的那个具体场景
 *
 * 用户实测：**109 条冲突**，列表里只有「路径 + 两个按钮」，点开看不到任何内容 ——
 * 只能盲选。这个面板把「先看见、再决定」补上：
 *
 * | 层 | 做什么 |
 * | --- | --- |
 * | 列表 | 路径 + 冲突类型；**不动**任何东西 |
 * | 对比 | 本机 / 远端两份正文，**并排**或**统一**（用户自己切，选择记住） |
 * | 裁决 | 只有两个出口：用我的 / 用远端。放弃的那一份进「历史」，不是消失 |
 * | 批量 | 109 条不可能一条条点；但批量必须走应用内确认框，写清覆盖什么、不会什么 |
 *
 * ## 为什么不给「两个都留」
 *
 * 那是第三个心智模型：用户得先想「副本会叫什么、会不会又被同步上去、以后怎么合并」。
 * 而冲突的答案本来就只有两个 —— 留这边，或者留那边。少一个选项，就少一次犹豫。
 */
import { type ReactNode, useState } from "react";
import { Icon } from "./Icons";
import { askConfirm } from "../lib/dialogs";
import { manualSync, previewConflict, resolveConflict } from "../sync/appSync";
import type { ConflictPreview } from "../sync/resolution";
import { diffLines, diffStats } from "../sync/textDiff";

export interface ConflictItem {
  path: string;
  kind: string;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "both-modified":
      return "两边都改";
    case "deleted-locally-modified-remotely":
      return "本地已删 · 远端改过";
    case "deleted-remotely-modified-locally":
      return "远端已删 · 本地改过";
    default:
      return kind;
  }
}

export function ConflictPanel({ conflicts }: { conflicts: ConflictItem[] }): ReactNode {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConflictPreview | null>(null);
  const [view, setView] = useState<"split" | "unified">("split");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 只看得见的那些类型才值得画 diff；删除类冲突没有两份正文。 */
  const canDiff = (kind: string): boolean => kind === "both-modified";

  const open = (path: string) => {
    if (openPath === path) {
      setOpenPath(null);
      setPreview(null);
      return;
    }
    setOpenPath(path);
    setPreview(null);
    setError(null);
    previewConflict(path)
      .then((result) => {
        if (result === null) setError("同步还没接上，读不到远端那一份。");
        else setPreview(result);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const act = (path: string, direction: "remote" | "local") => {
    setBusy(path);
    setError(null);
    resolveConflict(path, direction)
      .then((outcome) => {
        if (!outcome.ok) setError(`${path}：${outcome.error ?? "处理失败"}`);
        else {
          setOpenPath(null);
          setPreview(null);
          setNotice("裁决已生效，下一轮同步会把另一台设备收敛过来。");
        }
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  const bulk = async (direction: "remote" | "local") => {
    const total = conflicts.length;
    const ok = await askConfirm({
      title: `把 ${total} 条冲突全部${direction === "local" ? "改成你的版本" : "改成远端版本"}？`,
      message:
        direction === "local"
          ? `这会把本机的 ${total} 份内容推到远端，覆盖另一台设备在那 ${total} 篇上的改动。`
          : `这会把远端那 ${total} 份内容拉下来，覆盖你本机在那 ${total} 篇上的改动。`,
      rows: [
        {
          k: "覆盖",
          v: direction === "local" ? `${total} 篇远端内容` : `${total} 篇本机内容`,
        },
        { k: "不会", v: "删任何文件，也不会动其余的笔记" },
        { k: "可撤销", v: "每篇都有前像，可以从「历史」逐篇恢复" },
      ],
      confirmLabel: direction === "local" ? "全部用我的" : "全部用远端",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    // 逐条裁决：`resolveConflict` 一次只处理一条，串行避免把限流桶打满。
    for (const item of conflicts) {
      setBusy(item.path);
      // eslint-disable-next-line no-await-in-loop
      const outcome = await resolveConflict(item.path, direction);
      if (!outcome.ok) {
        setError(`${item.path}：${outcome.error ?? "处理失败"}`);
        break;
      }
    }
    setBusy(null);
    setNotice("批量裁决完成。点「立即同步」让两台设备收敛。");
  };

  const recheck = () => {
    setError(null);
    setNotice("正在重新核对（会跑一轮同步）…");
    void manualSync().then(() => setNotice("核对完成：两边内容相同的已自动去掉。"));
  };

  return (
    <section className="sync-dialog__card">
      <h3 className="sync-dialog__title">
        <Icon name="edit" size={13} /> 冲突（{conflicts.length}）
      </h3>
      <p className="dialog__note">
        两边都改过、引擎绝不替你猜。选定一边之后，另一台设备会在下一轮同步里收敛到同一份。
      </p>
      <div className="cf-bar">
        <span className="muted">待处理 {conflicts.length} 条</span>
        <span className="spacer" />
        <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={recheck}>
          重新核对
        </button>
        <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void bulk("local")}>
          全部用我的
        </button>
        <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void bulk("remote")}>
          全部用远端
        </button>
      </div>

      <ul className="cf-list">
        {conflicts.map((item) => (
          <li key={item.path} className="cf-item">
            <div className="cf-row">
              <span className="cf-path" title={item.path}>{item.path}</span>
              <span className="cf-kind">{kindLabel(item.kind)}</span>
              <span className="cf-acts">
                {canDiff(item.kind) ? (
                  <button type="button" className="btn btn--sm" onClick={() => open(item.path)}>
                    {openPath === item.path ? "收起" : "对比"}
                  </button>
                ) : null}
                <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => act(item.path, "local")}>
                  用我的
                </button>
                <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => act(item.path, "remote")}>
                  用远端
                </button>
              </span>
            </div>

            {openPath === item.path ? (
              <div className="cf-cmp">
                <div className="cf-cmp-head">
                  <div className="cf-seg">
                    <button type="button" className={view === "split" ? "is-on" : ""} onClick={() => setView("split")}>并排</button>
                    <button type="button" className={view === "unified" ? "is-on" : ""} onClick={() => setView("unified")}>统一</button>
                  </div>
                  <span className="spacer" />
                  {preview === null ? null : preview.local === null || preview.remote === null ? (
                    <span className="muted">不是文本文件，无法逐行对比</span>
                  ) : (
                    <span className="muted">
                      差 {(() => {
                        const stats = diffStats(diffLines(preview.local, preview.remote));
                        return stats.added + stats.removed;
                      })()} 行
                    </span>
                  )}
                </div>
                {preview === null ? (
                  <p className="dialog__note">正在读取两份内容…</p>
                ) : preview.local === null || preview.remote === null ? (
                  <p className="dialog__note">
                    {preview.local === null ? "本机这一份读不出来（可能已被删）。" : "远端这一份读不出来。"}
                  </p>
                ) : view === "split" ? (
                  <div className="cf-split">
                    <div className="cf-col">
                      <h5>本机版本</h5>
                      <pre>{preview.local}</pre>
                    </div>
                    <div className="cf-col">
                      <h5>远端版本</h5>
                      <pre>{preview.remote}</pre>
                    </div>
                  </div>
                ) : (
                  <pre className="cf-unified">
                    {diffLines(preview.local, preview.remote)
                      .map((row, index) => {
                        const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
                        return (
                          <span key={index} className={`cf-line is-${row.kind}`}>
                            {sign} {row.text}
                          </span>
                        );
                      })}
                  </pre>
                )}
                <div className="cf-foot">
                  <button type="button" className="btn btn--sm btn--primary" disabled={busy !== null} onClick={() => act(item.path, "local")}>
                    用我的版本
                  </button>
                  <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => act(item.path, "remote")}>
                    用远端版本
                  </button>
                  <span className="spacer" />
                  <span className="muted">放弃的那一份会进「历史」</span>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {busy ? <p className="dialog__note">正在处理 {busy} …</p> : null}
      {notice ? <p className="dialog__note">{notice}</p> : null}
      {error ? <p className="dialog__note sync-dialog__error">{error}</p> : null}
    </section>
  );
}
