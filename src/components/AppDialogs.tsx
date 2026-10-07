import { useEffect, useState, type ReactNode } from "react";
import { ACCENTS, FONTS, THEMES, WIDTHS, type Id, type Snapshot, type UiSettings } from "../data/types";
import { hasLegacyData } from "../data/legacy";
import { listSnapshots, restoreSnapshot, takeManualSnapshot } from "../data/library";
import type { WorkspaceRecord } from "../data/workspaces";
import type { UpdateStatus } from "../desktop/bridge";
import { patchUi, setTheme, toggleAppearance } from "../data/ui";
import type { AppCommand } from "../lib/appCommands";
import { askConfirm } from "../lib/dialogs";
import { notify } from "../lib/toast";
import type { UpdateAction } from "../lib/updateView";
import { updateSummaryFor } from "../lib/updateView";
import { cn, formatBytes, formatDateTime } from "../lib/utils";
import { Icon } from "./Icons";
import { ImportApiPanel } from "./ImportApiPanel";
import { Modal } from "./Overlays";

/* ================================ settings ============================== */

/**
 * 桌面端已经去掉了窗口内的原生菜单栏，因此「文件 / 编辑 / 视图 / 帮助」
 * 四组操作统一收进这里。每个分类里的按钮直接来自命令注册表
 * （src/lib/appCommands.ts），和快捷键、命令面板共用同一份定义，
 * 不会出现「菜单里有、面板里没有」这种漂移。
 */
const SECTIONS = [
  { id: "外观", hint: "主题、字体与排版" },
  { id: "文件", hint: "笔记本、导入与导出" },
  { id: "编辑", hint: "写作模式与格式" },
  { id: "视图", hint: "布局、模式与导航" },
  { id: "帮助", hint: "快捷键与关于" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** 设置面板的分栏 id。导出是为了让「打开某个分栏」的入口有稳定取值。 */
export type SettingsSectionId = SectionId;

export function SettingsDialog({
  settings,
  workspace,
  stats,
  commands,
  onRunCommand,
  onClose,
  onImport,
  onExport,
  onOpenLocalFolder,
  onCloseWorkspace,
  onMigrateLegacy,
  onShortcuts,
  initialSection,
  isDesktop,
  onOpenInbox,
  updateStatus,
  onCheckUpdate,
  onUpdateAction,
}: {
  settings: UiSettings;
  workspace: WorkspaceRecord | null;
  stats: { files: number; bytes: number };
  commands: AppCommand[];
  onRunCommand(id: string): void;
  onClose(): void;
  onImport(): void;
  onExport(): void;
  onOpenLocalFolder(): void;
  onCloseWorkspace(): void;
  onMigrateLegacy(): void;
  onShortcuts(): void;
  /** 直接落到某一栏（`opennote://settings/import` 与命令面板都要用）。 */
  initialSection?: SectionId;
  isDesktop: boolean;
  onOpenInbox(): void;
  /** 桌面端自更新状态（浏览器端恒为 null）。 */
  updateStatus: UpdateStatus | null;
  onCheckUpdate(): void;
  onUpdateAction(action: UpdateAction): void;
}): ReactNode {
  const [section, setSection] = useState<SectionId>(initialSection ?? "外观");
  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    void hasLegacyData().then(setLegacy);
  }, []);

  const byGroup = (...groups: AppCommand["group"][]): AppCommand[] =>
    commands.filter((command) => groups.includes(command.group));

  return (
    <Modal
      title="设置"
      settings
      tall
      onClose={onClose}
      footer={
        <>
          <span className="dialog__note">{SECTIONS.find((entry) => entry.id === section)?.hint}</span>
          <div className="spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="settings">
        <nav className="settings__rail" aria-label="设置分类">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cn("settings__tab", section === entry.id && "is-active")}
              onClick={() => setSection(entry.id)}
            >
              <span>{entry.id}</span>
              <small>{entry.hint}</small>
            </button>
          ))}
        </nav>

        <div className="settings__pane">
          {section === "外观" ? (
            <>
              <SettingRow label="主题" hint={THEMES.find((theme) => theme.id === settings.theme)?.hint}>
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
              </SettingRow>

              <SettingRow label="强调色" hint="标题、链接、光标与印章">
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
              </SettingRow>

              <SettingRow label="正文字体" hint={FONTS.find((font) => font.id === settings.font)?.hint}>
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
              </SettingRow>

              <SettingRow label="栏宽" hint="正文最大宽度">
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
              </SettingRow>

              <SettingRow label="字号 / 行高" hint="只影响正文，不影响界面">
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
              </SettingRow>
            </>
          ) : null}

          {section === "文件" ? (
            <>
              {/*
                「设置 · 文件 · 导入与接口」——设计稿把它放在「文件」分类里作为一段，
                不是独立的分栏。面板读桥状态**只走 IPC**，绝不 fetch 127.0.0.1，
                所以 CSP 的 connect-src 不需要也不会被放宽。
              */}
              <ImportApiPanel
                desktop={isDesktop}
                importConflict={settings.importConflict}
                onImportConflict={(value) => patchUi({ importConflict: value })}
                importNotify={settings.importNotify}
                onImportNotify={(value) => patchUi({ importNotify: value })}
                bridgeLog={settings.bridgeLog}
                onBridgeLog={(value) => patchUi({ bridgeLog: value })}
                onOpenInbox={onOpenInbox}
              />

              <SettingRow label="当前笔记本" hint={workspace ? workspaceHint(workspace) : "还没有打开任何文件夹"}>
                {workspace ? (
                  <>
                    <div className="setting__value">
                      <strong>{workspace.name}</strong>
                    </div>
                    <div className="setting__path">
                      {workspace.kind === "node" ? workspace.location : `opfs:/${workspace.location}`}
                    </div>
                    <div className="setting__meta">
                      已索引 {stats.files} 个 Markdown 文件 · {formatBytes(stats.bytes)}
                    </div>
                    <div className="swatches" style={{ marginTop: 10 }}>
                      <button type="button" className="btn" onClick={onOpenLocalFolder}>
                        <Icon name="folder" size={14} />
                        换一个文件夹
                      </button>
                      <button type="button" className="btn btn--danger" onClick={onCloseWorkspace}>
                        <Icon name="close" size={14} />
                        关闭笔记本
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="dialog__note">打开一个文件夹作为笔记本，Opennote 会直接读写里面的 .md 文件。</p>
                    <div className="swatches" style={{ marginTop: 10 }}>
                      <button type="button" className="btn btn--primary" onClick={onOpenLocalFolder}>
                        <Icon name="folder" size={14} />
                        打开文件夹
                      </button>
                    </div>
                  </>
                )}
              </SettingRow>

              <SettingRow label="导入 / 导出" hint="备份就是笔记本文件夹本身">
                <div className="swatches">
                  <button type="button" className="btn" onClick={onImport} disabled={!workspace}>
                    <Icon name="upload" size={14} />
                    导入文件或 zip
                  </button>
                  <button type="button" className="btn" onClick={onExport} disabled={!workspace}>
                    <Icon name="layers" size={14} />
                    导出整库 zip
                  </button>
                </div>
                <p className="dialog__note">
                  导入会写入当前文件夹，同名文件自动加序号；导出的 zip 解压后就是可继续打开的笔记本。
                </p>
              </SettingRow>

              <CommandGroup
                title="笔记与笔记本"
                commands={byGroup("笔记本", "笔记")}
                onRunCommand={onRunCommand}
              />
              <CommandGroup title="数据" commands={byGroup("数据")} onRunCommand={onRunCommand} />
            </>
          ) : null}

          {section === "编辑" ? (
            <>
              <SettingRow label="写作模式">
                <div className="switch-row">
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
              </SettingRow>

              <SettingRow label="粘贴的图片" hint="截图与拖入的文件怎么存">
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
                  资源模式把图片写进**跟笔记同名**的附件目录（<code>&lt;笔记名&gt;.assets/</code>），
                  正文里是相对路径，所以单篇笔记挪到别处图片照样跟着；内联模式让单篇 Markdown
                  自带图片，代价是文件更大。早年贴的图仍在原来的公共 <code>assets/</code> 里，
                  <strong>不迁移</strong>，照旧能读。
                </p>
              </SettingRow>

              <CommandGroup title="编辑操作" commands={byGroup("编辑")} onRunCommand={onRunCommand} />

              <CommandGroup title="格式" commands={byGroup("格式")} onRunCommand={onRunCommand} />
              <p className="dialog__note" style={{ marginTop: 8 }}>
                剪切 / 复制 / 粘贴 使用系统快捷键（Ctrl/⌘ + X / C / V），编辑器内 Ctrl/⌘ + F 查找替换。
                图片可以右键 →「复制图片」，复制进剪贴板的是能贴到别的应用里的 PNG。
              </p>
            </>
          ) : null}

          {section === "视图" ? (
            <>
              <SettingRow label="面板与模式">
                <div className="switch-row">
                  <label className="switch">
                    <input type="checkbox" checked={settings.sidebarOpen} onChange={(event) => patchUi({ sidebarOpen: event.target.checked })} />
                    侧栏
                  </label>
                  <label className="switch">
                    <input type="checkbox" checked={settings.outlineOpen} onChange={(event) => patchUi({ outlineOpen: event.target.checked })} />
                    大纲
                  </label>
                  <label className="switch">
                    <input type="checkbox" checked={settings.typewriter} onChange={(event) => patchUi({ typewriter: event.target.checked })} />
                    打字机
                  </label>
                  <label className="switch">
                    <input type="checkbox" checked={settings.focus} onChange={(event) => patchUi({ focus: event.target.checked })} />
                    专注
                  </label>
                </div>
                <div className="swatches" style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={toggleAppearance}>
                    <Icon name={settings.appearance === "dark" ? "sun" : "moon"} size={14} />
                    切换到{settings.appearance === "dark" ? "亮色" : "暗色"}
                  </button>
                  <button type="button" className="btn" onClick={() => window.location.reload()}>
                    <Icon name="rotate" size={14} />
                    重新加载界面
                  </button>
                </div>
              </SettingRow>

              <CommandGroup title="视图" commands={byGroup("视图")} onRunCommand={onRunCommand} />
              <CommandGroup title="导航" commands={byGroup("导航")} onRunCommand={onRunCommand} />
            </>
          ) : null}

          {section === "帮助" ? (
            <>
              <SettingRow label="快捷键" hint="也可以按 Ctrl/⌘ + / 随时查看">
                <div className="swatches">
                  <button type="button" className="btn" onClick={onShortcuts}>
                    <Icon name="keyboard" size={14} />
                    打开快捷键说明
                  </button>
                </div>
              </SettingRow>

              {legacy ? (
                <SettingRow label="旧数据" hint="0.1 版保存在浏览器 IndexedDB 里的笔记">
                  <div className="swatches">
                    <button type="button" className="btn" onClick={onMigrateLegacy}>
                      <Icon name="download" size={14} />
                      导入到当前笔记本
                    </button>
                  </div>
                  <p className="dialog__note">导入会把旧笔记与图片写成真实的 .md 文件与跟笔记走的 <code>&lt;笔记名&gt;.assets/</code> 目录，不会删除原数据。</p>
                </SettingRow>
              ) : null}

              <SettingRow label="更新" hint={isDesktop ? "桌面版：从 GitHub Releases 拉取" : "仅桌面版"}>
                <div className="setting__value">{updateSummaryFor(updateStatus)}</div>
                <div className="swatches" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!isDesktop || !updateStatus?.supported}
                    onClick={onCheckUpdate}
                  >
                    <Icon name="rotate" size={14} />
                    检查更新
                  </button>
                  {updateStatus?.phase === "available" ? (
                    <button type="button" className="btn btn--primary" onClick={() => onUpdateAction("download")}>
                      <Icon name="download" size={14} />
                      下载更新
                    </button>
                  ) : null}
                  {updateStatus?.phase === "downloading" ? (
                    <button type="button" className="btn" onClick={() => onUpdateAction("cancel")}>
                      <Icon name="close" size={14} />
                      取消下载
                    </button>
                  ) : null}
                  {updateStatus?.phase === "ready" ? (
                    <button type="button" className="btn btn--primary" onClick={() => onUpdateAction("restart")}>
                      <Icon name="rotate" size={14} />
                      重启并更新
                    </button>
                  ) : null}
                </div>
                <p className="dialog__note">
                  每次启动只读一次 GitHub Releases（不上传任何数据，GitHub 会看到你的 IP）；下载后由你点「重启并更新」，
                  Opennote 会先保存笔记再关闭、覆盖当前目录并自动重开。笔记文件在你自己的文件夹里，不受影响。
                </p>
              </SettingRow>

              <SettingRow label="关于">
                <div className="setting__value">
                  {/* 版本号只有**一个产地**：preload 的 `window.opennote.version`（→ `app.getVersion()` → package.json）。
    这里曾经硬编码 `v0.2.0`，从 0.3.0 起一直在对用户撒谎；而 preload 的兜底曾拿 **Electron 版本**冒充，
    会让用户看到 `v38.x` 并以为那是 Opennote 的版本。读不到就如实说「版本未知」——宁可知未知，不可冒充。 */}
    <strong>Opennote</strong> · 开源笔记 ·{" "}
    {(() => {
      const desktop = (window as unknown as { opennote?: { version?: string } }).opennote
      return desktop?.version ? `v${desktop.version}` : "版本未知"
    })()}{" "}
    · MIT License
                </div>
                <p className="dialog__note" style={{ marginTop: 4 }}>
                  纯前端、无后端、无账号、无遥测。笔记就是你磁盘上的 Markdown 文件，界面只是把它排版好给你看。
                </p>
                <p className="dialog__note">
                  桌面端：Electron（本机磁盘） · 网页端：Chrome/Edge 授权文件夹，其它浏览器用浏览器本地存储。
                </p>
              </SettingRow>

              <CommandGroup title="帮助" commands={byGroup("帮助")} onRunCommand={onRunCommand} />
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <div className="setting">
      <div className="setting__label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

function CommandGroup({
  title,
  commands,
  onRunCommand,
}: {
  title: string;
  commands: AppCommand[];
  onRunCommand(id: string): void;
}): ReactNode {
  if (!commands.length) return null;
  return (
    <div className="setting setting--stack">
      <div className="setting__label">{title}</div>
      <div className="setting__control">
        <div className="cmd-grid">
          {commands.map((command) => {
            const enabled = !command.enabled || command.enabled();
            return (
              <button
                key={command.id}
                type="button"
                className="cmd"
                disabled={!enabled}
                title={command.shortcut ? `${command.label}（${command.shortcut}）` : command.label}
                onClick={() => onRunCommand(command.id)}
              >
                <Icon name={command.icon} size={15} />
                <span className="cmd__label">{command.label}</span>
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
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
  ["打印或导出 PDF", "Ctrl/⌘ + P（别名 Ctrl/⌘ + Alt + P）"],
  ["编辑器内查找 / 替换", "Ctrl/⌘ + F（查找面板内含替换输入框；Ctrl/⌘ + Shift + L 选中全部匹配）"],
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
          <span className="dialog__note">浏览器会占用一部分快捷键；桌面端或安装为应用后全部生效。</span>
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
