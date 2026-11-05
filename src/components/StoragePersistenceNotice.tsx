import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceRecord } from "../data/workspaces";
import {
  shouldShowStorageNotice,
  useStoragePersistence,
  type StoragePersistenceStatus,
} from "../data/storagePersistence";
import { noticeStack } from "../lib/noticeStack";

const LEAD: Record<"denied" | "unsupported" | "unknown", string> = {
  denied: "当前浏览器没有批准持久存储：",
  unsupported: "当前浏览器不支持持久存储：",
  unknown: "无法确认浏览器是否会保留数据：",
};

const BODY = "这个浏览器可能会清掉浏览器笔记本，重要内容请开同步或改用「打开本机文件夹」。";

function noticeText(status: StoragePersistenceStatus | null): string {
  if (status === "denied" || status === "unsupported" || status === "unknown") return LEAD[status] + BODY;
  return "";
}

/**
 * 浏览器笔记本（OPFS）没拿到持久存储时的顶部提示（issue #2）。
 *
 * - 可关闭，按笔记本分别记：关掉 A、再关掉 B，回到 A 也不会再冒出来（本会话内）。
 * - 读屏：可见提示条本身不是 live region（按钮不该被播报）；另有一个常驻的
 *   `aria-live="polite"` 文本容器，提示出现时只播报那句话。
 */
export function StoragePersistenceNotice({ workspace }: { workspace: WorkspaceRecord | null }): ReactNode {
  const { status } = useStoragePersistence();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = shouldShowStorageNotice(workspace, status, dismissed);
  const text = visible ? noticeText(status) : "";

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {text}
      </p>
      {visible && workspace
        ? createPortal(
            <div id="storage-persistence-notice" className="storage-notice storage-notice--persistence">
              <p className="storage-notice__text">{text}</p>
              <button
                type="button"
                className="storage-notice__close"
                onClick={() => setDismissed((prev) => new Set(prev).add(workspace.id))}
              >
                知道了
              </button>
            </div>,
            noticeStack(),
          )
        : null}
    </>
  );
}
