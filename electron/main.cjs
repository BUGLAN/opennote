/**
 * Opennote 桌面端主进程（CommonJS，由 package.json 的 "main" 字段指向）。
 *
 * 为什么是 .cjs：Electron 的 electron 模块是 CommonJS 且通过 require 提供；
 * 用 ESM 导入时在本机实测拿不到 app/BrowserWindow（默认导出为空对象）。CJS 在
 * 开发运行与打包运行下行为一致，也不受宿主环境 ELECTRON_RUN_AS_NODE 影响之外
 * 的加载器差异干扰。
 *
 * 渲染进程通过 preload.cjs 暴露的 window.opennote 调用这里注册的 IPC 处理器，
 * 频道命名规则：opennote:<group>:<op>。
 *
 * 安全基线（不要放宽）：
 *   - contextIsolation: true / nodeIntegration: false / sandbox: true
 *   - webSecurity 保持开启，禁止关闭
 *   - 所有 fs 操作都必须落在调用方给定的工作区根目录内（见 resolveInsideRoot）
 *   - 所有 IPC 处理器都返回 Promise，失败时以中文错误信息 reject，绝不抛出到主进程之外
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')

const APP_ID = 'com.opennote.app'
const APP_NAME = 'Opennote'
const RECENT_LIMIT = 12
/** 与界面左上角印章一致的图标；打包后 exe 内嵌同一份 build/icon.ico。 */
const WINDOW_ICON = path.join(app.getAppPath(), 'build', 'icon.ico')

/**
 * 无边框标题栏：Windows 自带的那条标题栏（标题文字 + 最小化/最大化/关闭）
 * 和应用自己的头部（印章、标签页）功能重复，所以标题栏交给页面自己画。
 * Windows / Linux 用 titleBarOverlay 保留原生的三个窗口按钮，
 * macOS 用系统红绿灯（trafficLightPosition 让它落在印章右侧）。
 */
const IS_MAC = process.platform === 'darwin'
const TITLEBAR_HEIGHT = 40
const TITLEBAR_FALLBACK = { color: '#fbf8f3', symbolColor: '#97897a' }

/** 开发模式：scripts/dev-electron.mjs 会注入该变量；打包运行时不设置。 */
const DEV_URL = process.env.OPENNOTE_DEV_URL || ''
const IS_DEV = Boolean(DEV_URL) || !app.isPackaged

/** sandbox: true 要求 preload 必须是 CommonJS，扩展名为 .cjs。 */
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs')

let mainWindow = null
let readyLogged = false

/** Windows 任务栏/通知需要 AppUserModelID；其它平台不需要调用。 */
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 校验调用方传入的相对路径：必须是字符串、不能是绝对路径、不能包含 `..` 段或 NUL 字节。
 * relPath 为 '' / undefined / null 时表示工作区根目录本身。
 */
function assertRelativePath(relPath) {
  if (relPath === undefined || relPath === null || relPath === '') return ''
  if (typeof relPath !== 'string') throw new Error('路径无效：必须是字符串')
  if (relPath.includes('\0')) throw new Error('路径无效：包含非法字符')
  if (path.isAbsolute(relPath)) throw new Error('路径越界')

  const normalized = relPath.replace(/\\/g, '/')
  // Windows 盘符相对路径（如 "C:foo"）不算绝对路径，但会逃出根目录，直接拒绝。
  if (/^[a-zA-Z]:/.test(normalized)) throw new Error('路径越界')
  for (const segment of normalized.split('/')) {
    if (segment === '..') throw new Error('路径越界')
  }
  return relPath
}

/**
 * 唯一的路径解析入口：把 relPath 解析到 root 内部，越界一律抛 Error('路径越界')。
 * @returns {string} 绝对路径
 */
function resolveInsideRoot(root, relPath) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('根目录无效：必须是字符串')
  const rootResolved = path.resolve(root)
  const checked = assertRelativePath(relPath)
  const resolved = path.resolve(rootResolved, checked)

  const relative = path.relative(rootResolved, resolved)
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  if (escapes) throw new Error('路径越界')
  return resolved
}

// ---------------------------------------------------------------------------
// 错误信息与数据转换
// ---------------------------------------------------------------------------

/** 用户可见的失败信息统一带中文前缀，尽量附带上底层 errno 便于排查。 */
function fsError(prefix, relPath, error) {
  const label = typeof relPath === 'string' && relPath !== '' ? relPath : '.'
  const detail =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : ''
  return new Error(detail ? `${prefix}：${label}（${detail}）` : `${prefix}：${label}`)
}

/** 已经是中文的、面向用户的错误保持原样，其余统一包装成中文提示。 */
function asUserError(error, fallbackMessage) {
  if (error instanceof Error && error.message && /[\u3400-\u9fff]/.test(error.message)) return error
  if (error instanceof Error && error.message) return new Error(`${fallbackMessage}：${error.message}`)
  return new Error(fallbackMessage)
}

/** 注册 IPC 处理器：任何异常都转成 reject 的 Promise，不会让主进程崩溃。 */
function handle(channel, fn, fallbackMessage) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      throw asUserError(error, fallbackMessage)
    }
  })
}

/** IPC 传来的字节可能是 Uint8Array（Electron 结构化克隆）或 ArrayBuffer。 */
function toNodeBuffer(data, label) {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  throw new Error(`数据无效：${label} 需要 Uint8Array`)
}

function isMissingPathError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function parseHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// fs 操作
// ---------------------------------------------------------------------------

async function ensureParentDir(target) {
  await mkdir(path.dirname(target), { recursive: true })
}

async function copyTree(source, target) {
  const info = await stat(source)
  if (info.isDirectory()) {
    await cp(source, target, { recursive: true })
    return
  }
  await copyFile(source, target)
}

function registerFsHandlers() {
  handle(
    'opennote:fs:list',
    async (root, relPath) => {
      const dir = resolveInsideRoot(root, relPath)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        throw fsError('读取失败', relPath, error)
      }

      // 返回全部条目（包含点文件/点目录），由渲染层自行过滤 .opennote。
      const items = []
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        let info
        let link
        try {
          link = await lstat(full)
          info = link.isSymbolicLink() ? await stat(full) : link
        } catch {
          continue // 失效的符号链接等无法读取的条目直接跳过
        }
        // 目录符号链接/junction 一律不进入：既可能形成循环（扫描永不结束），
        // 也可能指向工作区之外。链接到文件则照常列出、照常可读。
        if (link.isSymbolicLink() && info.isDirectory()) continue
        items.push({
          name: entry.name,
          kind: info.isDirectory() ? 'directory' : 'file',
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      }

      items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
      return items
    },
    '读取目录失败',
  )

  handle(
    'opennote:fs:readText',
    async (root, relPath) => {
      const target = resolveInsideRoot(root, relPath)
      try {
        return await readFile(target, 'utf8')
      } catch (error) {
        throw fsError('读取失败', relPath, error)
      }
    },
    '读取失败',
  )

  handle(
    'opennote:fs:readBytes',
    async (root, relPath) => {
      const target = resolveInsideRoot(root, relPath)
      try {
        const buffer = await readFile(target)
        // 必须返回纯 Uint8Array（而不是 Buffer）：Buffer 常常是内存池的视图，
        // 结构化克隆会把整块底层 ArrayBuffer 一起传过去。
        return new Uint8Array(buffer)
      } catch (error) {
        throw fsError('读取失败', relPath, error)
      }
    },
    '读取失败',
  )

  handle(
    'opennote:fs:writeText',
    async (root, relPath, text) => {
      if (typeof text !== 'string') throw new Error(`写入失败：${relPath} 的内容必须是字符串`)
      const target = resolveInsideRoot(root, relPath)
      try {
        await ensureParentDir(target)
        await writeFile(target, text, 'utf8')
      } catch (error) {
        throw fsError('写入失败', relPath, error)
      }
    },
    '写入失败',
  )

  handle(
    'opennote:fs:writeBytes',
    async (root, relPath, data) => {
      const buffer = toNodeBuffer(data, '写入内容')
      const target = resolveInsideRoot(root, relPath)
      try {
        await ensureParentDir(target)
        await writeFile(target, buffer)
      } catch (error) {
        throw fsError('写入失败', relPath, error)
      }
    },
    '写入失败',
  )

  handle(
    'opennote:fs:mkdir',
    async (root, relPath) => {
      const target = resolveInsideRoot(root, relPath)
      try {
        await mkdir(target, { recursive: true })
      } catch (error) {
        throw fsError('创建目录失败', relPath, error)
      }
    },
    '创建目录失败',
  )

  handle(
    'opennote:fs:remove',
    async (root, relPath, options) => {
      if (relPath === '' || relPath === undefined || relPath === null) throw new Error('不能删除笔记本根目录')
      const target = resolveInsideRoot(root, relPath)
      const recursive = options && typeof options === 'object' ? options.recursive === true : false
      try {
        await rm(target, { recursive, force: true })
      } catch (error) {
        throw fsError('删除失败', relPath, error)
      }
    },
    '删除失败',
  )

  handle(
    'opennote:fs:move',
    async (root, from, to) => {
      if (!from || !to) throw new Error('不能移动笔记本根目录')
      const source = resolveInsideRoot(root, from)
      const target = resolveInsideRoot(root, to)
      if (source === target) return
      if (target.startsWith(`${source}${path.sep}`)) throw new Error('不能将文件夹移动到自身内部')
      try {
        await stat(target)
        throw new Error(`目标路径已存在：${to}`)
      } catch (error) {
        if (!isMissingPathError(error)) throw error
      }
      try {
        await ensureParentDir(target)
        await rename(source, target)
      } catch (error) {
        if (!error || error.code !== 'EXDEV') throw fsError('移动失败', from, error)
        // 跨盘/跨设备：rename 不可用，退化成先复制再删除。
        try {
          await copyTree(source, target)
          await rm(source, { recursive: true, force: true })
        } catch (fallbackError) {
          throw fsError('移动失败', from, fallbackError)
        }
      }
    },
    '移动失败',
  )

  handle(
    'opennote:fs:exists',
    async (root, relPath) => {
      const target = resolveInsideRoot(root, relPath)
      try {
        await stat(target)
        return true
      } catch (error) {
        if (isMissingPathError(error)) return false
        throw fsError('读取失败', relPath, error)
      }
    },
    '读取失败',
  )

  handle(
    'opennote:fs:stat',
    async (root, relPath) => {
      const target = resolveInsideRoot(root, relPath)
      try {
        const info = await stat(target)
        return { size: info.size, mtimeMs: info.mtimeMs }
      } catch (error) {
        if (isMissingPathError(error)) return null
        throw fsError('读取失败', relPath, error)
      }
    },
    '读取失败',
  )
}

// ---------------------------------------------------------------------------
// 对话框 / shell / 最近工作区
// ---------------------------------------------------------------------------

function focusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}

function registerDialogHandlers() {
  handle(
    'opennote:dialog:pickFolder',
    async () => {
      const options = {
        title: '选择文件夹',
        buttonLabel: '打开',
        properties: ['openDirectory', 'createDirectory'],
      }
      const parent = focusedWindow()
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    },
    '选择文件夹失败',
  )

  handle(
    'opennote:dialog:pickSaveFile',
    async (options) => {
      const input = options && typeof options === 'object' ? options : {}
      const defaultName = typeof input.defaultName === 'string' && input.defaultName !== '' ? input.defaultName : '未命名.md'
      const filters = Array.isArray(input.filters)
        ? input.filters
            .filter((item) => item && typeof item.name === 'string' && Array.isArray(item.extensions))
            .map((item) => ({ name: item.name, extensions: item.extensions.map(String) }))
        : undefined

      const dialogOptions = { title: '保存文件', defaultPath: defaultName, filters }
      const parent = focusedWindow()
      const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      if (result.canceled || !result.filePath) return null
      return result.filePath
    },
    '选择保存位置失败',
  )

  handle(
    'opennote:dialog:saveFile',
    async (absolutePath, data) => {
      if (typeof absolutePath !== 'string' || absolutePath.trim() === '' || absolutePath.includes('\0')) {
        throw new Error('保存失败：路径无效')
      }
      if (!path.isAbsolute(absolutePath)) throw new Error('保存失败：必须是绝对路径')
      const target = path.resolve(absolutePath)
      try {
        await ensureParentDir(target)
        if (typeof data === 'string') await writeFile(target, data, 'utf8')
        else await writeFile(target, toNodeBuffer(data, '保存内容'))
        return true
      } catch (error) {
        // 契约要求返回 boolean，写盘失败不抛给渲染层。
        console.error(`[opennote] 保存失败 ${target}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    '保存失败',
  )
}

function registerShellHandlers() {
  handle(
    'opennote:shell:showItemInFolder',
    async (absolutePath) => {
      if (typeof absolutePath !== 'string' || absolutePath.trim() === '' || absolutePath.includes('\0')) {
        throw new Error('打开失败：路径无效')
      }
      shell.showItemInFolder(path.resolve(absolutePath))
    },
    '打开失败',
  )

  handle(
    'opennote:shell:openExternal',
    async (url) => {
      const parsed = parseHttpUrl(url)
      if (!parsed) throw new Error('打开链接失败：仅支持 http/https 链接')
      await shell.openExternal(parsed.toString())
    },
    '打开链接失败',
  )
}

function recentWorkspacesFile() {
  return path.join(app.getPath('userData'), 'recent-workspaces.json')
}

async function readRecentWorkspaces() {
  try {
    const raw = await readFile(recentWorkspacesFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

async function writeRecentWorkspaces(list) {
  const file = recentWorkspacesFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(list, null, 2), 'utf8')
}

function sameWorkspacePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function registerAppHandlers() {
  handle('opennote:app:getRecentWorkspaces', async () => readRecentWorkspaces(), '读取最近工作区失败')

  handle(
    'opennote:app:addRecentWorkspace',
    async (absolutePath) => {
      if (typeof absolutePath !== 'string' || absolutePath.trim() === '' || absolutePath.includes('\0')) {
        throw new Error('保存最近工作区失败：路径无效')
      }
      const entry = path.resolve(absolutePath)
      const current = await readRecentWorkspaces()
      const next = [entry, ...current.filter((item) => !sameWorkspacePath(item, entry))].slice(0, RECENT_LIMIT)
      await writeRecentWorkspaces(next)
    },
    '保存最近工作区失败',
  )
}

function registerIpcHandlers() {
  registerFsHandlers()
  registerDialogHandlers()
  registerShellHandlers()
  registerAppHandlers()

  // 主题切换时同步标题栏按钮（叠加层）的底色与符号色。
  ipcMain.handle('opennote:window:titlebar', (event, colors) => {
    if (IS_MAC) return false
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return false
    const color = colors && typeof colors.color === 'string' ? colors.color : TITLEBAR_FALLBACK.color
    const symbolColor =
      colors && typeof colors.symbolColor === 'string' ? colors.symbolColor : TITLEBAR_FALLBACK.symbolColor
    window.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT })
    return true
  })

  // preload 需要同步拿到 app.getVersion()（sandbox 下 preload 拿不到 app 模块）。
  ipcMain.on('opennote:app:version', (event) => {
    event.returnValue = app.getVersion()
  })
}

// ---------------------------------------------------------------------------
// 菜单：桌面端不使用窗口内的菜单栏
// ---------------------------------------------------------------------------
//
// 「文件 / 编辑 / 视图 / 帮助」的操作已经全部收进应用内的设置面板，
// 快捷键由渲染层的命令注册表统一处理（见 src/lib/appCommands.ts）。
// Windows / Linux 直接移除菜单栏，避免窗口顶部多出一条横条；
// macOS 例外：系统要求存在应用菜单，否则 ⌘C/⌘V/⌘Q 等标准快捷键不生效，
// 因此只在 darwin 上安装一份纯 role 的最小菜单（不额外增加自定义项）。

function installApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    console.log(`[opennote] 已移除窗口菜单栏（applicationMenu=${Menu.getApplicationMenu() === null ? 'null' : 'set'}）`)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      IS_DEV ? { role: 'viewMenu' } : { role: 'windowMenu' },
    ]),
  )
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/** 应用自身的 URL 白名单：开发态是 dev server 的 origin，生产态是 file://。 */
function isAppUrl(url) {
  if (DEV_URL) {
    try {
      return new URL(url).origin === new URL(DEV_URL).origin
    } catch {
      return false
    }
  }
  return url.startsWith('file://') || url === 'about:blank'
}

function openExternalSafely(url) {
  const parsed = parseHttpUrl(url)
  if (!parsed) return
  shell.openExternal(parsed.toString()).catch(() => {
    /* 忽略：外链打开失败不影响应用 */
  })
}

function hardenWebContents(window) {
  // 新窗口一律拒绝，http(s) 交给系统浏览器，其它协议（file://、自定义协议等）直接丢弃。
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // 禁止导航离开应用自身（dev server origin 或 file://）。
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalSafely(url)
  })
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#fbf8f3',
    // 无边框标题栏：标题文字不再占用一行，页面自己的头部就是标题栏。
    // 原生窗口按钮由 titleBarOverlay（Windows/Linux）或系统红绿灯（macOS）提供。
    titleBarStyle: 'hidden',
    ...(IS_MAC
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { ...TITLEBAR_FALLBACK, height: TITLEBAR_HEIGHT } }),
    // 不显示窗口内的菜单栏：操作都在应用内设置里（见 installApplicationMenu）。
    autoHideMenuBar: true,
    icon: existsSync(WINDOW_ICON) ? WINDOW_ICON : undefined,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = window
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return // -3 = ERR_ABORTED，正常导航取消
    console.error(`[opennote] 加载失败 ${validatedURL}: ${errorDescription} (${errorCode})`)
    if (!window.isDestroyed()) window.show()
  })

  hardenWebContents(window)

  if (DEV_URL) await window.loadURL(DEV_URL)
  else await window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))

  return window
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  registerIpcHandlers()
  installApplicationMenu()

  try {
    await createWindow()
    if (!readyLogged) {
      readyLogged = true
      const iconNote = existsSync(WINDOW_ICON) ? WINDOW_ICON : 'exe 内嵌图标'
      const frameNote = mainWindow && !mainWindow.isDestroyed()
        ? `窗口=${mainWindow.getBounds().height}px 内容=${mainWindow.getContentBounds().height}px`
        : '窗口未就绪'
      console.log(`[opennote] desktop ready ${app.getVersion()}（icon=${iconNote}；${frameNote}）`)
    }
  } catch (error) {
    console.error(`[opennote] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        console.error(`[opennote] 创建窗口失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
