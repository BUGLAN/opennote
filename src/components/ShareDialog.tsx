import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../lib/importBridge";
import { closeShareDialog, confirmShare, revokeShare, shareFileName, shareLink, useShareRequest, type SharePhase, type ShareRequest } from "../lib/share";
import { notify } from "../lib/toast";
import { formatDateTime } from "../lib/utils";
import { openInBrowser } from "../sync/account";
import { Icon } from "./Icons";
import { Modal } from "./Overlays";
import { Leaving, usePresence } from "./presence";

/**
 * 侧栏右键「分享此链接」/「分享此文件」的对话框（逻辑在 `src/lib/share.ts`）。
 *
 * 两步：先**确认**（后果几行：打开的是什么 / 之后的修改 / 同步 / 谁能看 / 加密），再**给链接**。
 * 「一次性快照、不同步」在两步里都写明 —— 公开链接最容易被误会成「会跟着更新的在线文档」。
 */
export function ShareDialogHost(): ReactNode {
  const { value: request, leaving } = usePresence(useShareRequest());
  if (!request) return null;
  return (
    <Leaving leaving={leaving}>
      <ShareDialog request={request} />
    </Leaving>
  );
}

function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

function ShareDialog({ request }: { request: ShareRequest }): ReactNode {
  const { phase, mode, note } = request;
  const fileName = shareFileName(note);
  const title = mode === "page" ? "分享此链接" : "分享此文件";

  if (phase.kind === "done") return <ShareDone request={request} phase={phase} />;

  const working = phase.kind === "working";
  const rows: { k: string; v: string }[] = [
    {
      k: "链接打开",
      v: mode === "page" ? "一个只读网页，排版与应用里一致；页面上也能下载原文件。" : `原文件本身（${fileName}），浏览器里直接打开或下载。`,
    },
    { k: "后续修改", v: "不会更新到链接里 —— 它是此刻的一次性快照。要新内容就再分享一次（会得到新链接）。" },
    { k: "同步", v: "这个链接不参与同步：打开它的人只能看，不能改，也连不到你的笔记本。" },
    { k: "谁能看", v: "拿到链接的任何人，不需要登录。可以随时撤销。" },
  ];
  if (request.encrypted) rows.push({ k: "加密", v: "快照以明文存在服务器上，不受笔记本的端到端加密保护。" });

  return (
    <Modal
      title={title}
      onClose={closeShareDialog}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={closeShareDialog}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={working} onClick={() => void confirmShare(request, copyText)}>
            {working ? "正在生成…" : phase.kind === "error" ? "重试" : "生成公开链接"}
          </button>
        </>
      }
    >
      <p className="dialog__message">
        把「{note.title}」此刻的内容上传到 <span className="share-dialog__host">{hostOf(request.server)}</span>，生成一个公开链接。
      </p>
      <dl className="dialog__rows">
        {rows.map((row) => (
          <div className="dialog__row" key={row.k}>
            <dt>{row.k}</dt>
            <dd>{row.v}</dd>
          </div>
        ))}
      </dl>
      {phase.kind === "error" ? (
        <p className="dialog__note dialog__note--warn" role="alert">
          {phase.message}
        </p>
      ) : null}
    </Modal>
  );
}

function ShareDone({ request, phase }: { request: ShareRequest; phase: Extract<SharePhase, { kind: "done" }> }): ReactNode {
  const { share, copied, revoked, revokeError } = phase;
  const link = shareLink(share, request.mode);
  const [justCopied, setJustCopied] = useState(copied);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!revoked) requestAnimationFrame(() => inputRef.current?.select());
  }, [revoked]);

  const copy = async () => {
    const ok = await copyText(link);
    setJustCopied(ok);
    if (!ok) notify("没能写入剪贴板，请手动选中链接复制", { kind: "danger" });
  };

  const revoke = async () => {
    setBusy(true);
    await revokeShare(request);
    setBusy(false);
  };

  return (
    <Modal
      title={revoked ? "链接已撤销" : request.mode === "page" ? "网页链接已生成" : "文件链接已生成"}
      onClose={closeShareDialog}
      footer={
        <>
          {revoked ? null : (
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void revoke()}>
              {busy ? "正在撤销…" : "撤销链接"}
            </button>
          )}
          <div className="spacer" />
          {revoked ? null : (
            <button type="button" className="btn" onClick={() => void openInBrowser(link)}>
              <Icon name="external" size={14} />
              在浏览器打开
            </button>
          )}
          <button type="button" className="btn btn--primary" onClick={closeShareDialog}>
            完成
          </button>
        </>
      }
    >
      {revoked ? (
        <p className="dialog__message">这个链接已经失效，打开它的人会看到「链接已失效」。笔记本身不受影响。</p>
      ) : (
        <>
          <div className="share-dialog__link">
            <input
              ref={inputRef}
              className="field share-dialog__url"
              value={link}
              readOnly
              aria-label="公开链接"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="btn" onClick={() => void copy()}>
              <Icon name={justCopied ? "check" : "copy"} size={14} />
              {justCopied ? "已复制" : "复制"}
            </button>
          </div>
          <p className="dialog__note">
            {request.mode === "page" ? "打开是一张只读网页；" : "打开就是原文件；"}
            这是 {formatDateTime(share.createdAt)} 的一次性快照，之后再改「{request.note.title}」，链接里的内容不会变，也不会同步。
          </p>
          {revokeError ? (
            <p className="dialog__note dialog__note--warn" role="alert">
              {revokeError}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
