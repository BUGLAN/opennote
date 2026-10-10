import type { JSX } from "react";

export type IconName =
  | "file"
  | "folder"
  | "folderOpen"
  | "chevronRight"
  | "chevronLeft"
  | "chevronDown"
  | "search"
  | "plus"
  | "close"
  | "star"
  | "trash"
  | "tag"
  | "clock"
  | "settings"
  | "sun"
  | "moon"
  | "sidebar"
  | "outline"
  | "typewriter"
  | "focus"
  | "command"
  | "edit"
  | "download"
  | "upload"
  | "image"
  | "link"
  | "keyboard"
  | "check"
  | "copy"
  | "info"
  | "more"
  | "panelRight"
  | "rotate"
  | "hash"
  | "external"
  | "note"
  | "layers"
  | "shield"
  | "move"
  | "print"
  | "lock"
  | "unlock"
  | "winMin"
  | "winMax"
  | "winRestore";

const PATHS: Record<IconName, JSX.Element> = {
  file: (
    <>
      <path d="M14 3.5V8h4.5" />
      <path d="M15.5 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.1a2 2 0 0 1 1.6.8l.9 1.2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  folderOpen: (
    <>
      <path d="M3.5 8V6.5a2 2 0 0 1 2-2h3.1a2 2 0 0 1 1.6.8l.9 1.2h6.4a2 2 0 0 1 2 2v1" />
      <path d="M3.5 8.5h15.2a1.4 1.4 0 0 1 1.35 1.8l-1.7 6.3a2 2 0 0 1-1.93 1.5H5.2a2 2 0 0 1-1.93-1.5L2.6 10.6" />
    </>
  ),
  chevronRight: <path d="m9.5 6 5.5 6-5.5 6" />,
  chevronLeft: <path d="m14.5 6-5.5 6 5.5 6" />,
  chevronDown: <path d="m6 9.5 6 5.5 6-5.5" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.2" />
      <path d="m19.5 19.5-4-4" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  close: <path d="M17.5 6.5 6.5 17.5M6.5 6.5l11 11" />,
  star: <path d="m12 3.8 2.6 5.2 5.7.8-4.15 4 1 5.7-5.15-2.7-5.15 2.7 1-5.7-4.15-4 5.7-.8z" />,
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V5.4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="m6.5 7 .8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    </>
  ),
  tag: (
    <>
      <path d="M20.3 13.3 12.6 21 3.5 11.9V3.5h8.4l8.4 8.4a1 1 0 0 1 0 1.4z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.6V12l3 1.9" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7.5" cy="17" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </>
  ),
  moon: <path d="M20 14.4A8.4 8.4 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4z" />,
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <path d="M10 4.5v15" />
    </>
  ),
  outline: <path d="M8.5 6h12M8.5 12h12M8.5 18h12M3.8 6h.01M3.8 12h.01M3.8 18h.01" />,
  typewriter: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7.5 13.5h9" />
    </>
  ),
  focus: (
    <>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.8 5.8l1.8 1.8M16.4 16.4l1.8 1.8M18.2 5.8l-1.8 1.8M7.6 16.4l-1.8 1.8" />
    </>
  ),
  command: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.9-.9" />
    </>
  ),
  edit: (
    <>
      <path d="M4.5 19.5l4.2-1 9.3-9.3a2.1 2.1 0 0 0-3-3L5.7 15.5z" />
      <path d="M14.4 5.6l3 3" />
    </>
  ),
  download: <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" />,
  upload: <path d="M12 20V9m0 0 4 4m-4-4-4 4M5 4.5h14" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <circle cx="9" cy="9.5" r="1.4" />
      <path d="m5 17 4.6-4.6 3.2 3.2L16 12.4l3.5 3.5" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a4.2 4.2 0 0 0 6 0l2.6-2.6a4.2 4.2 0 0 0-6-6l-1.4 1.4" />
      <path d="M13.8 10.2a4.2 4.2 0 0 0-6 0l-2.6 2.6a4.2 4.2 0 0 0 6 6l1.4-1.4" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="2.4" />
      <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15.5 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11v5.2M12 7.9h.01" />
    </>
  ),
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  panelRight: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  rotate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V9h-4.4" />
    </>
  ),
  hash: <path d="M9.5 4.5 7.5 19.5M16.5 4.5l-2 15M5 9h14M4 15h14" />,
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14.5v3a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3" />
    </>
  ),
  note: (
    <>
      <path d="M5.5 4.5h13v15h-13z" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 8.5 4.6L12 12.7 3.5 8.1z" />
      <path d="m4 12.5 8 4.4 8-4.4M4 16.4l8 4.4 8-4.4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4-2.9 7.3-7 8.9-4.1-1.6-7-4.9-7-8.9V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  /* 「移动到…」：一个文件夹 + 一支向右的箭头（箭头在文件夹肚子里，笔画与其它图标同粗细）。 */
  move: (
    <>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h3.1a2 2 0 0 1 1.6.8l.9 1.2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M9.2 13.2h6m0 0-2.5-2.5M15.2 13.2l-2.5 2.5" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V4.5h10V9" />
      <rect x="4" y="9" width="16" height="7.5" rx="2" />
      <path d="M7.5 14.5h9v5h-9z" />
    </>
  ),
  /*
   * 自绘窗口按钮的三个字形（与 Windows 的 ─ □ ❐ ✕ 同一套语义）：
   * 最小化、最大化、还原。关闭复用上面的 `close`（同一个 ✕，不另画一份）。
   */
  winMin: <path d="M5.5 12h13" />,
  winMax: <rect x="5.8" y="5.8" width="12.4" height="12.4" rx="1.8" />,
  winRestore: (
    <>
      <path d="M9.2 9.2V7.9a1.7 1.7 0 0 1 1.7-1.7h5.3a1.7 1.7 0 0 1 1.7 1.7v5.3a1.7 1.7 0 0 1-1.7 1.7h-1.3" />
      <rect x="6.1" y="9.2" width="8.7" height="8.7" rx="1.7" />
    </>
  ),
};

export function Icon({
  name,
  size = 15,
  className,
  filled = false,
}: {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
