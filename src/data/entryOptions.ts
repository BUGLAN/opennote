/**
 * 「笔记本从哪来」的入口开关（欢迎页 / 侧栏笔记本菜单 / 命令面板共用这一份判断）。
 *
 * 桌面版（Electron）有真正的本机文件系统，网页版那两条替代路径在这里只剩坏处：
 *   · 新建浏览器笔记本 —— 笔记进 OPFS 私仓，文件树、外部编辑器、同步、备份全都看不见；
 *   · 导入文件夹到浏览器 —— 更是把磁盘上的文件夹**拷一份**藏进私仓，之后两边各写各的。
 * 所以桌面版这两项直接**不出现**（`false`），而不是渲染成禁用按钮 —— 假按钮是这个项目
 * 反复修掉的老毛病（同 `appCommands.ts` 里 GitHub 那一组的做法）。
 *
 * 手机壳（Capacitor）不走这条判断：手机上只有 `Documents/OpenNote` 这一个固定位置，
 * 「导入文件夹」是把已有文件夹带进手机的正经路径，两条都保留。
 */

export interface EntryCapabilities {
  /** Electron 桌面版。 */
  desktop: boolean;
  /** 能直接选一个磁盘 / 手机文件夹（桌面版、Chrome/Edge、手机壳）。 */
  localFolder: boolean;
  /** 这个运行时有没有 OPFS（Chromium 系都有，包括桌面版）。 */
  browserWorkspace: boolean;
}

export interface EntryOptions {
  /** 「打开本机文件夹」（手机壳里是「新建手机笔记本」）。 */
  localFolder: boolean;
  /** 「新建浏览器笔记本」。 */
  browserWorkspace: boolean;
  /** 「导入文件夹到浏览器」。 */
  uploadFolder: boolean;
}

export function entryOptions(caps: EntryCapabilities): EntryOptions {
  return {
    localFolder: caps.localFolder,
    browserWorkspace: caps.browserWorkspace && !caps.desktop,
    uploadFolder: !caps.desktop,
  };
}
