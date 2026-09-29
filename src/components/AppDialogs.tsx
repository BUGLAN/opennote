import { useEffect, useState, type ReactNode } from "react";
import { ACCENTS, FONTS, THEMES, WIDTHS, type Id, type Snapshot, type UiSettings } from "../data/types";
import { hasLegacyData } from "../data/legacy";
import { listSnapshots, restoreSnapshot, takeManualSnapshot } from "../data/library";
import type { WorkspaceRecord } from "../data/workspaces";
import { patchUi, setTheme, toggleAppearance } from "../data/ui";
import { askConfirm } from "../lib/dialogs";
import { notify } from "../lib/toast";
import { cn, formatBytes, formatDateTime } from "../lib/utils";
import { Icon } from "./Icons";
import { Modal } from "./Overlays";

/* ================================ settings ============================== */

export function SettingsDialog({
  settings,
  workspace,
  stats,
  onClose,
  onImport,
  onExport,
  onOpenLocalFolder,
  onCloseWorkspace,
  onMigrateLegacy,
  onShortcuts,
}: {
  settings: UiSettings;
  workspace: WorkspaceRecord | null;
  stats: { files: number; bytes: number };
  onClose(): void;
  onImport(): void;
  onExport(): void;
  onOpenLocalFolder(): void;
  onCloseWorkspace(): void;
  onMigrateLegacy(): void;
  onShortcuts(): void;
}): ReactNode {
  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    void hasLegacyData().then(setLegacy);
  }, []);

  return (
    <Modal
      title="设置"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onShortcuts}>
            <Icon name="keyboard" size={14} />
            快捷键
          </button>
          <div className="spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="setting">
        <div className="setting__label">
          主题
          <small>{THEMES.find((theme) => theme.id === settings.theme)?.hint}</small>
        </div>
        <div className="setting__control">
          <div className="swatches">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={cn("swatch", settings.theme === theme.id && "is-active")}
                onClick={() => setTheme(theme.id)}
                title={theme.hint}
              >
                <span
                  className="swatch__dot"
                  style={{
                    background:
                      theme.kind === "dark"
                        ? "linear-gradient(135deg,#1c1915 50%,#eae3d7 50%)"
                        : "linear-gradient(135deg,#fffdf9 50%,#f2ece1 50%)",
                  }}
                />
                {theme.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">
          强调色
          <small>标题、链接、光标与印章</small>
        </div>
        <div className="setting__control">
          <div className="swatches">
            {ACCENTS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                className={cn("swatch", settings.accent === accent.id && "is-active")}
                onClick={() => patchUi({ accent: accent.id })}
              >
                <span className="swatch__dot" style={{ background: accent.swatch }} />
                {accent.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">
          正文字体
          <small>{FONTS.find((font) => font.id === settings.font)?.hint}</small>
        </div>
        <div className="setting__control">
          <div className="segmented">
            {FONTS.map((font) => (
              <button
                key={font.id}
                type="button"
                className={cn(settings.font === font.id && "is-active")}
                onClick={() => patchUi({ font: font.id })}
              >
                {font.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">
          栏宽
          <small>正文最大宽度</small>
        </div>
        <div className="setting__control">
          <div className="segmented">
            {WIDTHS.map((width) => (
              <button
                key={width.id}
                type="button"
                className={cn(settings.width === width.id && "is-active")}
                onClick={() => patchUi({ width: width.id })}
              >
                {width.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">
          字号 / 行高
          <small>只影响正文，不影响界面</small>
        </div>
        <div className="setting__control">
          <div className="range">
            <input
              type="range"
              min={13}
              max={22}
              step={0.5}
              value={settings.fontSize}
              onChange={(event) => patchUi({ fontSize: Number(event.target.value) })}
            />
            <output>{settings.fontSize.toFixed(1)} px</output>
          </div>
          <div className="range" style={{ marginTop: 8 }}>
            <input
              type="range"
              min={1.4}
              max={2.2}
              step={0.02}
              value={settings.lineHeight}
              onChange={(event) => patchUi({ lineHeight: Number(event.target.value) })}
            />
            <output>{settings.lineHeight.toFixed(2)}</output>
          </div>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">写作模式</div>
        <div className="setting__control" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <label className="switch">
            <input type="checkbox" checked={settings.typewriter} onChange={(event) => patchUi({ typewriter: event.target.checked })} />
            打字机
          </label>
          <label className="switch">
            <input type="checkbox" checked={settings.focus} onChange={(event) => patchUi({ focus: event.target.checked })} />
            专注
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.showWordCount}
              onChange={(event) => patchUi({ showWordCount: event.target.checked })}
            />
            字数统计
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.spellcheck}
              onChange={(event) => patchUi({ spellcheck: event.target.checked })}
            />
            拼写检查
          </label>
          <label className="switch">
            <input type="checkbox" checked={settings.snapshots} onChange={(event) => patchUi({ snapshots: event.target.checked })} />
            自动历史快照
          </label>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">
          粘贴的图片
          <small>截图与拖入的文件怎么存</small>
        </div>
        <div className="setting__control">
          <div className="segmented">
            <button
              type="button"
              className={cn(settings.imageMode === "asset" && "is-active")}
              onClick={() => patchUi({ imageMode: "asset" })}
            >
              存为资源（推荐）
            </button>
            <button
              type="button"
              className={cn(settings.imageMode === "inline" && "is-active")}
              onClick={() => patchUi({ imageMode: "inline" })}
            >
              内联 base64
            </button>
          </div>
          <p className="dialog__note">
            资源模式把图片存进 IndexedDB，导出时自动改写成 <code>./assets/…</code>；内联模式让单篇 Markdown
            自带图片，代价是文件更大。
          </p>
        </div>
      </div>

      <div className="setting">
        <div className="setting__label">
          笔记本
          <small>{workspace ? workspaceHint(workspace) : "还没有打开任何文件夹"}</small>
        </div>
        <div className="setting__control">
          {workspace ? (
            <>
              <div style={{ fontSize: 13, color: "var(--ink)" }}>
                <strong>{workspace.name}</strong>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", wordBreak: "break-all", marginTop: 2 }}>
                {workspace.kind === "node" ? workspace.location : `opfs:/${workspace.location}`}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 8 }}>
                已索引 {stats.files} 个 Markdown 文件 · {formatBytes(stats.bytes)}
              </div>
            </>
          ) : (
            <p className="dialog__note">打开一个文件夹作为笔记本，Opennote 会直接读写里面的 .md 文件。</p>
          )}
          <div className="swatches" style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={onOpenLocalFolder}>
              <Icon name="folder" size={14} />
              打开文件夹
            </button>
            <button type="button" className="btn" onClick={onExport} disabled={!workspace}>
              <Icon name="layers" size={14} />
              导出整库 zip
            </button>
            <button type="button" className="btn" onClick={onImport} disabled={!workspace}>
              <Icon name="upload" size={14} />
              导入文件
            </button>
            {workspace ? (
              <button type="button" className="btn btn--danger" onClick={onCloseWorkspace}>
                <Icon name="close" size={14} />
                关闭笔记本
              </button>
            ) : null}
          </div>
          <p className="dialog__note">
            笔记就是磁盘上的文件，Opennote 不做任何格式封装；`.opennote/` 里只放星标、历史快照这些附加信息，删掉也不影响正文。
          </p>
        </div>
      </div>

      {legacy ? (
        <div className="setting">
          <div className="setting__label">
            旧数据
            <small>0.1 版保存在浏览器 IndexedDB 里的笔记</small>
          </div>
          <div className="setting__control">
            <button type="button" className="btn" onClick={onMigrateLegacy}>
              <Icon name="download" size={14} />
              导入到当前笔记本
            </button>
            <p className="dialog__note">导入会把旧笔记和图片写成真实的 .md 与 assets/ 文件，不会删除原数据。</p>
          </div>
        </div>
      ) : null}

      <div className="setting">
        <div className="setting__label">关于</div>
        <div className="setting__control" style={{ color: "var(--ink-2)", lineHeight: 1.8, fontSize: 13 }}>
          <p>
            <strong>Opennote</strong> · 开源笔记 · v0.2.0 · MIT License
          </p>
          <p className="dialog__note" style={{ marginTop: 4 }}>
            纯前端、无后端、无账号、无遥测。Markdown 存原文，界面只是把它排版好给你看。
          </p>
          <div className="swatches" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn--ghost" onClick={toggleAppearance}>
              <Icon name={settings.appearance === "dark" ? "sun" : "moon"} size={14} />
              切换亮/暗
            </button>
            <button type="button" className="btn btn--ghost" onClick={onShortcuts}>
              <Icon name="keyboard" size={14} />
              快捷键
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function workspaceHint(workspace: WorkspaceRecord): string {
  if (workspace.kind === "node") return "直接读写本机磁盘上的文件夹";
  if (workspace.kind === "fsa") return "浏览器已授权的磁盘文件夹（刷新后可能需要重新授权）";
  return "浏览器自己的文件系统（OPFS），重开浏览器依然在";
}

/* ================================= history ============================== */

export function HistoryDialog({ noteId, onClose }: { noteId: Id; onClose(): void }): ReactNode {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => {
    void listSnapshots(noteId).then((list) => {
      setSnapshots(list);
      setSelected(list[0]?.id ?? null);
    });
  };

  useEffect(load, [noteId]);

  const current = snapshots?.find((snapshot) => snapshot.id === selected) ?? null;

  return (
    <Modal
      title="历史版本"
      wide
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={async () => {
              await takeManualSnapshot(noteId);
              load();
              notify("已记录当前版本");
            }}
          >
            <Icon name="plus" size={14} />
            记录当前版本
          </button>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!current}
            onClick={async () => {
              if (!current) return;
              const ok = await askConfirm({
                title: "恢复这个版本？",
                message: `将用 ${formatDateTime(current.createdAt)} 的内容替换当前正文，现在的版本会先被存进历史。`,
                confirmLabel: "恢复",
              });
              if (!ok) return;
              await restoreSnapshot(current);
              notify("已恢复到所选版本");
              onClose();
            }}
          >
            恢复此版本
          </button>
        </>
      }
    >
      {snapshots === null ? (
        <p className="dialog__note">正在读取历史…</p>
      ) : snapshots.length === 0 ? (
        <p className="dialog__message">
          还没有历史版本。Opennote 会在写作过程中自动留档（每 3 分钟一次，最多保留 60 份），也可以随时手动记录。
        </p>
      ) : (
        <div className="history">
          <div className="history__list">
            {snapshots.map((snapshot) => (
              <button
                key={snapshot.id}
                type="button"
                className={cn("history__item", snapshot.id === selected && "is-active")}
                onClick={() => setSelected(snapshot.id)}
              >
                {formatDateTime(snapshot.createdAt)}
                <time>
                  {snapshot.reason === "auto" ? "自动留档" : snapshot.reason === "manual" ? "手动记录" : "恢复前的备份"} ·{" "}
                  {snapshot.content.length} 字符
                </time>
              </button>
            ))}
          </div>
          <pre className="history__preview">{current?.content ?? ""}</pre>
        </div>
      )}
    </Modal>
  );
}

/* =============================== shortcuts ============================== */

const SHORTCUTS: [string, string][] = [
  ["命令面板 / 快速打开", "Ctrl/⌘ + K（别名 Alt + K）"],
  ["命令面板：只看命令", "Ctrl/⌘ + Shift + P"],
  ["全局搜索", "Ctrl/⌘ + Shift + F"],
  ["新建笔记", "Ctrl/⌘ + N"],
  ["新建文件夹", "Ctrl/⌘ + Shift + N"],
  ["立即保存", "Ctrl/⌘ + S"],
  ["关闭当前标签", "Alt + W（安装为应用后 Ctrl/⌘ + W 也可）"],
  ["下一个 / 上一个标签", "Alt + → / ←"],
  ["加粗 / 斜体", "Ctrl/⌘ + B / I"],
  ["行内代码", "Ctrl/⌘ + E"],
  ["插入链接", "Ctrl/⌘ + Shift + K"],
  ["删除线 / 高亮", "Ctrl/⌘ + Shift + X / H"],
  ["标题 1–6 级", "Ctrl/⌘ + 1 … 6"],
  ["无序 / 有序 / 任务列表", "Ctrl/⌘ + Shift + 8 / 7 / 9"],
  ["引用 / 代码块", "Ctrl/⌘ + Shift + Q / C"],
  ["表格 / 公式块 / 图表", "Ctrl/⌘ + Shift + T / M / G"],
  ["折叠侧栏 / 大纲", "Ctrl/⌘ + \\ / Shift + O"],
  ["切换亮 / 暗", "Ctrl/⌘ + Alt + T"],
  ["打字机 / 专注模式", "Ctrl/⌘ + Shift + Y / D"],
  ["设置 / 快捷键", "Ctrl/⌘ + , / Ctrl/⌘ + /"],
  ["打印或导出 PDF", "Ctrl/⌘ + P"],
  ["编辑器内查找 / 替换", "Ctrl/⌘ + F / Ctrl/⌘ + Alt + F"],
  ["移动行 / 复制行", "Alt + ↑ / ↓ · Shift + Alt + ↑ / ↓"],
];

export function ShortcutsDialog({ onClose }: { onClose(): void }): ReactNode {
  return (
    <Modal
      title="键盘快捷键"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="dialog__note">浏览器会占用一部分快捷键；把它「安装为应用」后全部生效。</span>
          <div className="spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            知道了
          </button>
        </>
      }
    >
      <div className="shortcuts">
        {SHORTCUTS.map(([label, keys]) => (
          <div className="shortcuts__row" key={label}>
            <span>{label}</span>
            <kbd>{keys}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}
