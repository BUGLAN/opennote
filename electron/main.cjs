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
 *   - fs 操作的 root 必须命中「会话授权集合」（用户经系统对话框选定，或来自
 *     recent-workspaces.json 的持久授权），见 requireAuthorizedRoot（审计 D20）
 *   - 解析后的路径既要在词法上落在 root 内（resolveInsideRoot），也要在 realpath
 *     之后仍落在 realpath(root) 内，链接（符号链接/junction）不得越界（审计 D31）
 *   - 所有 IPC 处理器都返回 Promise，失败时以中文错误信息 reject，绝不抛出到主进程之外；
 *     回传的消息一律不含宿主机绝对路径/用户名（审计 D35）
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron')
const { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } = require('node:fs/promises')
const { existsSync, watch, readdirSync, readFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const path = require('node:path')

// `opennote://` 深链解析（00 号 §6.14㉛）。零 Electron 依赖的纯函数，可被单测直接
// require —— 「路由与拒绝规则」不靠真机手点，见 electron/deeplink.cjs 的注释。
const { DEEPLINK_CHANNEL, PROTOCOL, deeplinkMessage, findDeeplinkInArgv, parseOpennoteUrl } =
  require('./deeplink.cjs')

const APP_ID = 'com.opennote.app'
const APP_NAME = 'Opennote'
const RECENT_LIMIT = 12
/** D11 关窗握手：等待渲染层 flush 的上限；超时也必须放行，绝不能把窗口卡死。 */
const FLUSH_TIMEOUT_MS = 1500
/** D08 工作区目录监听的去抖窗口。 */
const WATCH_DEBOUNCE_MS = 450
/**
 * D38 只对 file:// 响应注入的 CSP。dev server（http://127.0.0.1:5173）绝不注入，
 * 否则 script-src 'self' 会挡掉 Vite 的 HMR 脚本。桌面构建的 dist/index.html 不含
 * meta CSP，这条响应头就是桌面端唯一的策略来源。
 *
 * 唯一的远程例外是「霞鹜文楷」按需字体（src/data/ui.ts）：只放行
 * style-src / font-src 的 https://cdn.jsdelivr.net，script-src / connect-src /
 * default-src 绝不能添加该来源（Lead 裁决 2026-09-29，web 侧 meta 同步一致）。
 *
 * script-src 还会在启动时追加 index.html 内联启动脚本的 sha256（见
 * loadInlineScriptHashes）：桌面构建同样带着那个内联脚本（主题预设 + 启动兜底），
 * 不放行它就会被自己的 CSP 挡掉；用哈希而不是 'unsafe-inline'，保持严格。
 */
const CSP_INLINE_SCRIPT_HASHES = []

function cspPolicy() {
  return [
    "default-src 'none'",
    `script-src ${["'self'", 'file:', ...CSP_INLINE_SCRIPT_HASHES].join(' ')}`,
    "style-src 'self' file: 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' file: data: blob:",
    "font-src 'self' file: data: https://cdn.jsdelivr.net",
    "connect-src 'self' file:",
    "media-src 'self' file: blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
  ].join('; ')
}
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
/** D11：app.quit() 是否已在飞行中（close 的 preventDefault 会中止一次 quit，需要补发）。 */
let quitRequested = false

/** Windows 任务栏/通知需要 AppUserModelID；其它平台不需要调用。 */
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

// ---------------------------------------------------------------------------
// 根目录授权（D20）
// ---------------------------------------------------------------------------
//
// 只约束「相对路径不逃逸 root」是不够的：root 是渲染层传进来的，任何目录都能当 root，
// 于是 contextIsolation/sandbox 全部开对也没有意义。主进程因此维护一份授权集合，
// 只有下面两条来源可以进入：
//   1) 用户经系统对话框选定（opennote:dialog:pickFolder）——同时在最近工作区列表留痕；
//   2) userData/recent-workspaces.json —— 上一行写下的持久授权凭据，启动时读入。
// 渲染层没有任何 IPC 能给任意路径授权：opennote:fs:authorizeRoot 只认这两条来源，
// opennote:app:addRecentWorkspace 也受同一集合门控。

/** 会话内已授权的工作区根目录身份。 */
const authorizedRoots = new Set()
/** recent-workspaces.json 里的根目录身份（持久授权来源）。 */
const persistentRoots = new Set()
/** 本会话 pickSaveFile 返回过的绝对路径身份，dialog:saveFile 只能写这些路径。 */
const saveTargets = new Set()

/** Windows 上路径大小写不敏感，用折叠后的路径做集合键；其它平台原样。 */
function pathIdentity(absolutePath) {
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath
}

/** 归一化成合法的绝对路径；无效（非字符串/非绝对/含 NUL）返回 null，不做授权判断。 */
function normalizeAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return null
  try {
    if (!path.isAbsolute(value)) return null
    return path.resolve(value)
  } catch {
    return null
  }
}

function isAuthorizedRoot(root) {
  const normalized = normalizeAbsolutePath(root)
  if (!normalized) return false
  const identity = pathIdentity(normalized)
  return authorizedRoots.has(identity) || persistentRoots.has(identity)
}

/**
 * 所有 fs:* handler 的第一道关：root 必须已在授权集合内，否则一律拒绝。
 * @returns {string} 归一化后的绝对 root
 */
function requireAuthorizedRoot(root) {
  const normalized = normalizeAbsolutePath(root)
  if (!normalized || !isAuthorizedRoot(normalized)) throw new Error('未授权的工作区目录')
  return normalized
}

/** 由主进程内部授权（对话框选定 / 启动时读入最近工作区）。 */
function grantRoot(root) {
  const normalized = normalizeAbsolutePath(root)
  if (!normalized) return null
  authorizedRoots.add(pathIdentity(normalized))
  return normalized
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 校验调用方传入的相对路径：必须是字符串、不能是绝对路径、不能包含 `..` 段、NUL 或 `:`。
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
  // D36：除首段盘符（上面已拦下）外，`:` 一律拒绝。Windows 上 'a.md:secret' 会挂
  // NTFS 备用数据流（ADS）：用户只看到空文件 a.md，隐藏内容却真实落盘。
  if (normalized.includes(':')) throw new Error('路径无效：包含非法字符')
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
// 链接（符号链接 / junction）越界检查（D31）
// ---------------------------------------------------------------------------
//
// 词法校验挡不住链接：工作区里的 junction 可以指向任意目录，于是 readText/writeText
// 都会落到工作区之外。这里对最终目标做 realpath，再确认它仍落在 realpath(root) 之内。

/** candidate 是否等于 root 或落在 root 内（path.relative 在 Windows 上已忽略大小写）。 */
function isInsideOrEqual(rootPath, candidate) {
  const relative = path.relative(rootPath, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

/**
 * realpath 的宽容版：目标不存在时逐级向上找最深的已存在祖先，再把剩余段拼回去。
 * 这样「父目录是 junction 指向工作区之外、文件名尚未创建」的写入场景同样能被发现。
 * 连一个祖先都不存在时返回 null（调用方退化为纯词法校验）。
 */
async function realpathForCheck(target) {
  let current = target
  const missing = []
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : path.join(real, ...missing.reverse())
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = path.dirname(current)
      if (parent === current) return null
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * 确认检查目标的真实落点仍在真实 root 之内；链接导致越界一律拒绝。
 * @param {string} rootResolved 词法解析后的 root
 * @param {string} checkTarget 读取类操作传目标本身；写入/删除类传其父目录
 */
async function assertRealPathInsideRoot(rootResolved, checkTarget) {
  const rootReal = await realpathForCheck(rootResolved)
  if (!rootReal) return
  const targetReal = await realpathForCheck(checkTarget)
  if (!targetReal) return
  if (!isInsideOrEqual(rootReal, targetReal)) throw new Error('路径越界：链接指向工作区之外')
}

/**
 * 所有 fs handler 的唯一入口：授权（D20）→ 词法解析 → realpath 越界检查（D31）。
 * @param {'target'|'parent'|'write'} mode
 *   target：对目标本身做链接检查（读取/列目录/stat/exists）
 *   parent：对父目录做链接检查（删除/移动/建目录）
 *   write ：父目录 + 目标自身都检查——只查父目录会漏掉「文件名本身是符号链接」的场景
 *           （原子写的 rename 会落到链接指向的位置，必须先确认它仍在工作区内）
 */
async function safePath(root, relPath, mode = 'target') {
  const safeRoot = requireAuthorizedRoot(root)
  const target = resolveInsideRoot(safeRoot, relPath)
  if (mode === 'write') {
    if (target === safeRoot) throw new Error('不能写入笔记本根目录')
    await assertRealPathInsideRoot(safeRoot, path.dirname(target))
    await assertRealPathInsideRoot(safeRoot, target)
  } else {
    const checkTarget = mode === 'parent' && target !== safeRoot ? path.dirname(target) : target
    await assertRealPathInsideRoot(safeRoot, checkTarget)
  }
  return { root: safeRoot, target }
}

// ---------------------------------------------------------------------------
// 错误信息与数据转换
// ---------------------------------------------------------------------------

/** 用户可见的失败信息统一带中文前缀，尽量附带上底层 errno 便于排查。 */
function fsError(prefix, relPath, error) {
  const label = typeof relPath === 'string' && relPath !== '' ? scrubAbsolutePaths(relPath) : '.'
  const detail =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? scrubAbsolutePaths(error.message)
        : ''
  return new Error(detail ? `${prefix}：${label}（${detail}）` : `${prefix}：${label}`)
}

/**
 * D35：回传给渲染层的错误消息绝不能带宿主机绝对路径/用户名。
 * 识别 Windows 盘符、UNC 与常见的 POSIX 绝对路径开头，统一替换成占位符。
 */
function scrubAbsolutePaths(text) {
  return String(text)
    .replace(/[A-Za-z]:[\\/][^\s'"，。）]*/g, '<路径已隐藏>')
    .replace(/\\\\[^\s'"，。）]+/g, '<路径已隐藏>')
    .replace(/(['"`])\/[^\s'"`]*\1/g, '$1<路径已隐藏>$1')
    .replace(
      /(^|[\s(=])\/(?:Users|home|root|tmp|var|etc|opt|mnt|media|private|Volumes|Applications)\/[^\s'"，。）]*/g,
      '$1<路径已隐藏>',
    )
}

function errorCodeOf(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
}

/**
 * D33：目标不存在（ENOENT/ENOTDIR）时的统一文案，与渲染层后端
 * （src/fs/io.ts）的「找不到：<relPath>」逐字对齐；其它 errno 仍走 fsError。
 */
function notFoundError(relPath) {
  const label = typeof relPath === 'string' && relPath !== '' ? scrubAbsolutePaths(relPath) : '.'
  return new Error(`找不到：${label}`)
}

/**
 * 已经是中文的、面向用户的错误（我们自己抛的，最多只带相对路径）原样回传；
 * 其余一律降级成「中文前缀（errno）」，绝不把 Node 的原始 message 直接回传。
 * 注意：判断基于**未脱敏**的原文——脱敏占位符本身含中文，若拿脱敏后的文本判断，
 * 带绝对路径的英文 errno 会被误判成「自己的中文提示」。
 */
function asUserError(error, fallbackMessage) {
  const raw = error instanceof Error && typeof error.message === 'string' ? error.message : ''
  const code = errorCodeOf(error)
  if (raw && /[\u3400-\u9fff]/.test(raw) && scrubAbsolutePaths(raw) === raw) return new Error(raw)
  if (code) return new Error(`${fallbackMessage}（${code}）`)
  if (raw) return new Error(`${fallbackMessage}：${scrubAbsolutePaths(raw)}`)
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

/**
 * D21：先写同目录临时文件再 rename 覆盖目标（同目录保证同卷，不会 EXDEV），
 * 进程被杀/断电最多丢掉这一次写入，不会留下半截正文；失败时清理临时文件。
 * 目标是符号链接时先解析到真实文件，保持「写链接 = 写它指向的文件」的语义。
 */
async function writeFileAtomic(target, data) {
  let destination = target
  try {
    destination = await realpath(target)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`,
  )
  try {
    await writeFile(temporary, data)
    await rename(temporary, destination)
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch {
      /* 清理失败不影响原始错误 */
    }
    throw error
  }
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
  // D20：渲染层可显式把「最近工作区」里的路径重新登记为会话授权。
  // 只认持久列表里的路径，返回是否成功；这不是给任意路径授权的入口。
  handle(
    'opennote:fs:authorizeRoot',
    async (root) => {
      const normalized = normalizeAbsolutePath(root)
      if (!normalized) return false
      const identity = pathIdentity(normalized)
      if (authorizedRoots.has(identity)) return true
      if (persistentRoots.has(identity)) {
        authorizedRoots.add(identity)
        return true
      }
      return false
    },
    '授权工作区失败',
  )

  handle(
    'opennote:fs:list',
    async (root, relPath) => {
      const { target: dir } = await safePath(root, relPath, 'target')
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isMissingPathError(error)) throw notFoundError(relPath)
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
      const { target } = await safePath(root, relPath, 'target')
      try {
        return await readFile(target, 'utf8')
      } catch (error) {
        if (isMissingPathError(error)) throw notFoundError(relPath)
        throw fsError('读取失败', relPath, error)
      }
    },
    '读取失败',
  )

  handle(
    'opennote:fs:readBytes',
    async (root, relPath) => {
      const { target } = await safePath(root, relPath, 'target')
      try {
        const buffer = await readFile(target)
        // 必须返回纯 Uint8Array（而不是 Buffer）：Buffer 常常是内存池的视图，
        // 结构化克隆会把整块底层 ArrayBuffer 一起传过去。
        return new Uint8Array(buffer)
      } catch (error) {
        if (isMissingPathError(error)) throw notFoundError(relPath)
        throw fsError('读取失败', relPath, error)
      }
    },
    '读取失败',
  )

  handle(
    'opennote:fs:writeText',
    async (root, relPath, text) => {
      const { target } = await safePath(root, relPath, 'write')
      if (typeof text !== 'string') throw new Error(`写入失败：${relPath} 的内容必须是字符串`)
      try {
        await ensureParentDir(target)
        await writeFileAtomic(target, text)
      } catch (error) {
        throw fsError('写入失败', relPath, error)
      }
    },
    '写入失败',
  )

  handle(
    'opennote:fs:writeBytes',
    async (root, relPath, data) => {
      const { target } = await safePath(root, relPath, 'write')
      const buffer = toNodeBuffer(data, '写入内容')
      try {
        await ensureParentDir(target)
        await writeFileAtomic(target, buffer)
      } catch (error) {
        throw fsError('写入失败', relPath, error)
      }
    },
    '写入失败',
  )

  handle(
    'opennote:fs:mkdir',
    async (root, relPath) => {
      const { target } = await safePath(root, relPath, 'parent')
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
      const { root: safeRoot, target } = await safePath(root, relPath, 'parent')
      // D29：不能只看 relPath 是不是空——'.'、'./'、'.\\'、'././' 都会被 path.resolve
      // 归一化成 root 本身，必须比较解析后的绝对路径（Windows 忽略大小写）。
      if (pathIdentity(target) === pathIdentity(safeRoot)) throw new Error('不能删除笔记本根目录')
      const recursive = options && typeof options === 'object' ? options.recursive === true : false
      try {
        await rm(target, { recursive, force: true })
      } catch (error) {
        // D6：Node 的 rm 对目录要求 recursive，不递归时若目标正好是空目录则回退 rmdir。
        const code = errorCodeOf(error)
        if (!recursive && (code === 'ERR_FS_EISDIR' || code === 'EISDIR')) {
          try {
            await rmdir(target)
            return
          } catch {
            /* 非空目录等原因：按原始错误上报 */
          }
        }
        throw fsError('删除失败', relPath, error)
      }
    },
    '删除失败',
  )

  handle(
    'opennote:fs:move',
    async (root, from, to) => {
      if (!from || !to) throw new Error('不能移动笔记本根目录')
      const source = (await safePath(root, from, 'parent')).target
      const target = (await safePath(root, to, 'parent')).target
      if (source === target) return
      if (target.startsWith(`${source}${path.sep}`)) throw new Error('不能将文件夹移动到自身内部')
      try {
        await stat(target)
        throw new Error(`目标路径已存在：${to}`)
      } catch (error) {
        // 目标存在是我们自己抛的中文错误；其余（非 ENOENT/ENOTDIR）统一包成 fsError，
        // 不把 Node 原始 message（含绝对路径）带回渲染层（D35）。
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
      const { target } = await safePath(root, relPath, 'target')
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
      const { target } = await safePath(root, relPath, 'target')
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
// D08：工作区变更通知（去抖，仅限已授权 root）
// ---------------------------------------------------------------------------
//
// 外部编辑器 / 同步盘改动工作区时，渲染层需要知道「该重扫了」。这里只做最小的
// 主进程侧管道：watchWorkspace/unwatchWorkspace 受授权集合门控，事件去抖后广播给
// 所有窗口（频道 opennote:fs:workspace-changed，payload 为工作区绝对路径）。
// 注意：渲染层何时调用它们是 T6/数据层的事，这里不改变任何既有 API。

/** identity → { watcher, timer } */
const workspaceWatchers = new Map()

function notifyWorkspaceChanged(absolutePath) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window || window.isDestroyed()) continue
    try {
      window.webContents.send('opennote:fs:workspace-changed', absolutePath)
    } catch {
      /* 窗口正在销毁：忽略 */
    }
  }
}

function closeWorkspaceWatcher(identity) {
  const state = workspaceWatchers.get(identity)
  if (!state) return false
  workspaceWatchers.delete(identity)
  if (state.timer) clearTimeout(state.timer)
  try {
    state.watcher.close()
  } catch {
    /* 已经关闭 */
  }
  return true
}

function registerFsWatchHandlers() {
  handle(
    'opennote:fs:watchWorkspace',
    async (root) => {
      const safeRoot = requireAuthorizedRoot(root)
      const identity = pathIdentity(safeRoot)
      // 渲染层打开笔记本时必调 watchWorkspace —— 这是主进程辨认「当前工作区」的信号，
      // 收件箱状态写入（唯一允许主进程写的文件）要用它定位绝对路径。
      currentWorkspaceRoot = safeRoot
      if (workspaceWatchers.has(identity)) return true

      const schedule = () => {
        const state = workspaceWatchers.get(identity)
        if (!state) return
        if (state.timer) clearTimeout(state.timer)
        state.timer = setTimeout(() => {
          const current = workspaceWatchers.get(identity)
          if (current) current.timer = null
          notifyWorkspaceChanged(safeRoot)
        }, WATCH_DEBOUNCE_MS)
        state.timer.unref?.()
      }
      const onChange = (_eventType, filename) => {
        // 应用自己的元数据（.opennote/**）改动不对外通知，避免「自写 → 自读重扫」循环。
        const name = typeof filename === 'string' ? filename.replace(/\\/g, '/') : ''
        if (name === '.opennote' || name.startsWith('.opennote/')) return
        schedule()
      }

      let watcher
      try {
        watcher = watch(safeRoot, { recursive: true, persistent: false }, onChange)
      } catch {
        try {
          // 平台不支持递归监听时退化成只监听根目录。
          watcher = watch(safeRoot, { persistent: false }, onChange)
        } catch (error) {
          throw fsError('监听工作区失败', '.', error)
        }
      }
      watcher.on('error', () => closeWorkspaceWatcher(identity))
      workspaceWatchers.set(identity, { watcher, timer: null })

      // 收件箱变更检测是**独立**的一条链路：`.opennote/**` 被上面的 onChange
      // 显式跳过（避免自写自读），所以它不能复用这个 watcher，也走独立频道。
      // 监听不到时如实降级为轮询，不假装有 watcher。
      void startInboxWatcher(safeRoot).catch(() => {})
      return true
    },
    '监听工作区失败',
  )

  handle(
    'opennote:fs:unwatchWorkspace',
    async (root) => {
      const normalized = normalizeAbsolutePath(root)
      if (!normalized) return false
      const identity = pathIdentity(normalized)
      if (currentWorkspaceRoot && pathIdentity(currentWorkspaceRoot) === identity) {
        currentWorkspaceRoot = null
      }
      closeInboxWatcher(identity)
      return closeWorkspaceWatcher(identity)
    },
    '取消监听失败',
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
      // D20：用户亲自选定 = 唯一能进入会话授权集合的入口；同时写入最近工作区列表，
      // 作为重启后仍被信任的持久授权来源。写列表失败不阻断本次会话（已在集合里）。
      const picked = grantRoot(result.filePaths[0])
      if (!picked) throw new Error('选择文件夹失败：路径无效')
      try {
        await rememberRecentWorkspace(picked)
      } catch (error) {
        console.error(`[opennote] 最近工作区写入失败（本次会话仍可用）：${errorCodeOf(error) || '未知错误'}`)
      }
      return picked
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
      const target = normalizeAbsolutePath(result.filePath)
      if (!target) throw new Error('选择保存位置失败：路径无效')
      // D20：记住用户亲自选过的保存位置，saveFile 只认这些路径。
      saveTargets.add(pathIdentity(target))
      return target
    },
    '选择保存位置失败',
  )

  handle(
    'opennote:dialog:saveFile',
    async (absolutePath, data) => {
      const target = normalizeAbsolutePath(absolutePath)
      if (!target) throw new Error('保存失败：路径无效')
      // D20 旁路封堵：任意绝对路径不再可写，只有本会话 pickSaveFile 返回过的路径才行。
      if (!saveTargets.has(pathIdentity(target))) throw new Error('保存失败：未授权的保存位置')
      try {
        await ensureParentDir(target)
        if (typeof data === 'string') await writeFileAtomic(target, data)
        else await writeFileAtomic(target, toNodeBuffer(data, '保存内容'))
        return true
      } catch (error) {
        // 契约要求返回 boolean，写盘失败不抛给渲染层；日志留主进程，不回传绝对路径。
        console.error(`[opennote] 保存失败 ${target}: ${errorCodeOf(error) || '未知错误'}`)
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

/** 原子写（D21 同款）：状态文件被截断过一次就足以丢掉用户的全部最近工作区。 */
async function writeRecentWorkspaces(list) {
  const file = recentWorkspacesFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, JSON.stringify(list, null, 2))
}

function sameWorkspacePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 追加/置顶一个最近工作区；调用方必须已经完成授权（pickFolder 或受门控的 IPC）。 */
async function rememberRecentWorkspace(absolutePath) {
  const current = await readRecentWorkspaces()
  const next = [absolutePath, ...current.filter((item) => !sameWorkspacePath(item, absolutePath))].slice(0, RECENT_LIMIT)
  await writeRecentWorkspaces(next)
}

/**
 * D20：recent-workspaces.json 是持久授权来源。只有主进程亲自写进去的路径才会出现在
 * 这里（对话框选定 / 受门控的 addRecentWorkspace），启动时读入即可让「重启后打开
 * 最近工作区」继续可用，而不是给任意路径开口子。
 */
async function loadPersistentRoots() {
  const list = await readRecentWorkspaces()
  for (const item of list) {
    const normalized = normalizeAbsolutePath(item)
    if (normalized) persistentRoots.add(pathIdentity(normalized))
  }
  return persistentRoots.size
}

function registerAppHandlers() {
  handle('opennote:app:getRecentWorkspaces', async () => readRecentWorkspaces(), '读取最近工作区失败')

  handle(
    'opennote:app:addRecentWorkspace',
    async (absolutePath) => {
      const entry = normalizeAbsolutePath(absolutePath)
      if (!entry) throw new Error('保存最近工作区失败：路径无效')
      // D20 门控：只接受「已在会话授权集合或已在 recent 列表中」的路径。
      // 否则渲染层就能用这条 IPC 给任意目录授权，白名单形同虚设。
      const identity = pathIdentity(entry)
      if (!authorizedRoots.has(identity) && !persistentRoots.has(identity)) {
        throw new Error('保存最近工作区失败：未授权的工作区目录')
      }
      authorizedRoots.add(identity)
      await rememberRecentWorkspace(entry)
    },
    '保存最近工作区失败',
  )
}

function registerIpcHandlers() {
  registerFsHandlers()
  registerFsWatchHandlers()
  registerDialogHandlers()
  registerShellHandlers()
  registerAppHandlers()
  registerImportHandlers()
  registerUpdateHandlers()

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

  // D11：渲染层 flush 完成后通知主进程放行关窗（见 requestRendererFlush）。
  ipcMain.on('opennote:app:flush-done', (event) => resolveFlushWaiters(event.sender))
}

// ---------------------------------------------------------------------------
// 导入通道：本地桥（默认关闭）+ 收件箱独立 watcher
// ---------------------------------------------------------------------------
//
// 三条不变式（违反任何一条都要返工）：
//   1) 主进程**不写笔记内容**。桥只做「传输 + 安全校验」，信封一律经
//      `opennote:import:receipt` 转交渲染层落盘——主进程直接写正文会被
//      `rescanWorkspace()` 起始的 `flushAll()` 覆盖，用户看到的是「导入成功但没东西」。
//      唯一例外是 `.opennote/inbox/<entry>/state.json`（队列状态，不是笔记内容）。
//   2) 桥**默认关闭**，必须由用户在设置里显式开启；窗口不在场时一律 IMP-4006，
//      **绝不假装成功**。
//   3) 收件箱的变更检测**不能复用**工作区 watcher：`.opennote/**` 被它显式跳过，
//      所以这里是一条独立的 watch，广播独立的 `opennote:inbox:changed`。

const INBOX_DEBOUNCE_MS = 450
/** 主进程 → 渲染层转交的等待上限。超时按「窗口不在场」处理，绝不假成功。 */
const RELAY_TIMEOUT_MS = 5000
/** 应用自己写 state.json 之后的静默窗口：避免自写自读的重扫循环。 */
const INBOX_SELF_WRITE_MUTE_MS = 500
const INBOX_DIR_NAME = 'inbox'

/**
 * 惰性加载本地桥。缺文件（或加载失败）时退化为「接口不存在」，
 * 而不是让整个桌面端起不来——导入接口是可选能力。
 */
let bridgeModule = null
let bridgeModuleTried = false
function loadBridgeModule() {
  if (bridgeModuleTried) return bridgeModule
  bridgeModuleTried = true
  try {
    // eslint-disable-next-line global-require
    bridgeModule = require('./bridge.cjs')
  } catch (error) {
    console.error(
      `[opennote] 本地接口模块加载失败，导入接口不可用：${error instanceof Error ? error.message : String(error)}`,
    )
    bridgeModule = null
  }
  return bridgeModule
}

let bridgeController = null
/**
 * `conflict:"overwrite"` 的第三道闸门（用户显式开启的进阶开关）。
 *
 * 本轮**没有**提供这个开关的界面，因此它恒为 false —— 任何 `overwrite` 请求
 * 都会在 L2 降级为 `new` + `IMP-4011`。这是**有意的保守选择**：契约要求
 * overwrite「四道闸门同时满足」，少一道就必须降级，而「静默覆盖用户内容」
 * 是绝不允许的失败模式。
 */
function getAdvancedOverwrite() {
  return false
}

/**
 * R8「记录本地接口日志」。渲染层经 `opennote:bridge:setLogEnabled` 推过来，
 * 桥用它决定是否往 `bridge.log` 落行。默认 `true`（与 `DEFAULT_UI.bridgeLog` 一致）。
 */
let bridgeLogEnabled = true

/** reqId → { resolve, timer }：主进程在等渲染层的回执。 */
const importRelays = new Map()
let importRelaySeq = 0

function isTrustedSender(event) {
  const window = mainWindow
  if (!window || window.isDestroyed()) return false
  return event && event.sender === window.webContents
}

/**
 * 把一次操作转交给渲染层，等它用 `opennote:import:reply` 回执。
 * 返回 null 表示**窗口不在场或没回执**——调用方必须据此报 IMP-4006，不得假成功。
 */
function relayToRenderer(channel, payload) {
  return new Promise((resolve) => {
    const window = mainWindow
    if (!window || window.isDestroyed()) {
      resolve(null)
      return
    }
    const reqId = `r${++importRelaySeq}`
    const timer = setTimeout(() => {
      importRelays.delete(reqId)
      resolve(null)
    }, RELAY_TIMEOUT_MS)
    timer.unref?.()
    importRelays.set(reqId, { resolve, timer })
    try {
      window.webContents.send(channel, { reqId, ...payload })
    } catch {
      clearTimeout(timer)
      importRelays.delete(reqId)
      resolve(null)
    }
  })
}

function settleImportRelay(payload) {
  if (!payload || typeof payload !== 'object') return
  const reqId = payload.reqId
  if (typeof reqId !== 'string') return
  const pending = importRelays.get(reqId)
  if (!pending) return
  clearTimeout(pending.timer)
  importRelays.delete(reqId)
  pending.resolve(payload.outcome === undefined ? null : payload.outcome)
}

/** 契约 §6.1 的错误体；`detail` 绝不带宿主机绝对路径、用户名或令牌。 */
function importError(code, userMessage, http, retryable) {
  return { ok: false, error: { code, message: code, userMessage, http, retryable } }
}

const NO_WINDOW_ERROR = () =>
  importError(
    'IMP-4006',
    // 逐字与 `electron/bridge.cjs` 的 `ERROR_TABLE['IMP-4006']`、`02` 附录 A.3 一致
    // （00 号 §6.14㉗）。主进程这条与桥那条是同一个 code 的两个产地，措辞必须相同，
    // 否则客户端会看到两套「Opennote 没运行」的说法。`verify-contract.cjs` 的 C-6c
    // 只逐字比对桥的 ERROR_TABLE，盖不住这里 —— 靠这条注释与代码审查守住。
    'Opennote 没有在运行。请先打开 Opennote，再试一次。',
    409,
    true,
  )

// --- 收件箱：独立 watcher + 状态文件 ------------------------------------------

/** identity → { watcher, timer } */
const inboxWatchers = new Map()
let inboxSelfWriteUntil = 0

async function countInboxPending(root) {
  const dir = path.join(root, '.opennote', INBOX_DIR_NAME)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let pending = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = await readFile(path.join(dir, entry.name, 'state.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const status = parsed && typeof parsed.status === 'string' ? parsed.status : 'pending'
      if (status === 'pending') pending += 1
    } catch {
      // 没有 state.json = 外部投递还没登记，算待确认。
      pending += 1
    }
  }
  return pending
}

async function notifyInboxChanged(root) {
  const pending = await countInboxPending(root)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window || window.isDestroyed()) continue
    try {
      window.webContents.send('opennote:inbox:changed', { root, pending })
    } catch {
      /* 窗口正在销毁：忽略 */
    }
  }
}

function closeInboxWatcher(identity) {
  const state = inboxWatchers.get(identity)
  if (!state) return false
  inboxWatchers.delete(identity)
  if (state.timer) clearTimeout(state.timer)
  try {
    state.watcher.close()
  } catch {
    /* 已经关闭 */
  }
  return true
}

/**
 * 为已授权工作区启动收件箱监听；目录不存在先建。
 * 返回 'watch' | 'poll' —— 监听不可用时如实降级为轮询（设置面板要显示真实状态）。
 */
async function startInboxWatcher(root) {
  const identity = pathIdentity(root)
  if (inboxWatchers.has(identity)) return 'watch'
  const dir = path.join(root, '.opennote', INBOX_DIR_NAME)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    return 'poll'
  }

  const schedule = () => {
    const state = inboxWatchers.get(identity)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      const current = inboxWatchers.get(identity)
      if (current) current.timer = null
      // 应用自己写的 state.json 不触发通知（否则会自写自读转圈）。
      if (Date.now() < inboxSelfWriteUntil) return
      void notifyInboxChanged(root).catch(() => {})
    }, INBOX_DEBOUNCE_MS)
    state.timer.unref?.()
  }

  let watcher
  try {
    watcher = watch(dir, { recursive: true, persistent: false }, schedule)
  } catch {
    try {
      watcher = watch(dir, { persistent: false }, schedule)
    } catch {
      return 'poll'
    }
  }
  watcher.on('error', () => closeInboxWatcher(identity))
  inboxWatchers.set(identity, { watcher, timer: null })
  return 'watch'
}

/** 收件箱监听是否真的在跑（供 status 如实汇报）。 */
function inboxWatchMode() {
  return inboxWatchers.size > 0 ? 'watch' : 'off'
}

/**
 * 唯一允许主进程写的内容：`.opennote/inbox/<entry>/state.json`。
 * 仍然走 `safePath`（授权 root + 相对路径校验 + realpath 边界），原子写 tmp + rename，
 * 写完广播 `opennote:inbox:changed`。绝不写笔记正文、索引、日志或前像。
 */
const INBOX_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * 当前打开的工作区根。主进程不持有工作区状态，但 `watchWorkspace` 就是
 * 「用户打开了这个笔记本」的信号（渲染层打开工作区时必调），所以这里跟着它走。
 * 收件箱状态写入需要绝对路径，而桥给的状态写入挂钩只带条目 id。
 */
let currentWorkspaceRoot = null

async function writeInboxStateAtomic(root, entryId, stateJson) {
  const safeRoot = requireAuthorizedRoot(root)
  if (typeof entryId !== 'string' || !INBOX_ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error('写收件箱状态失败：条目 id 不合法')
  }
  if (typeof stateJson !== 'string' || stateJson.trim() === '') {
    throw new Error('写收件箱状态失败：状态内容无效')
  }
  // 只接受 JSON 文本，避免把任意字节写进工作区。
  JSON.parse(stateJson)
  const relPath = `.opennote/${INBOX_DIR_NAME}/${entryId}/state.json`
  const target = await safePath(safeRoot, relPath, 'target')
  await ensureParentDir(target)
  inboxSelfWriteUntil = Date.now() + INBOX_SELF_WRITE_MUTE_MS
  await writeFileAtomic(target, stateJson)
  void notifyInboxChanged(safeRoot).catch(() => {})
  return true
}

/** 桥的挂钩形态是 `onInboxStateWrite(entryId, stateJson)`（根由主进程自己认）。 */
function writeInboxStateForBridge(entryId, stateJson) {
  const root = currentWorkspaceRoot
  if (!root) throw new Error('写收件箱状态失败：当前没有打开的工作区')
  return writeInboxStateAtomic(root, entryId, stateJson)
}

/**
 * 网页版剪藏页的「落点」候选：工作区里**已存在**的目录（工作区相对路径）。
 *
 * 为什么由主进程从磁盘现读，而不是问渲染层要：`folder` 的契约是「非空必须是**已存在的
 * 目录**，不自动创建」，这句话说的是**文件系统事实**，而文件系统事实的产地就是磁盘。
 * 让渲染层的内存树再产一份，就会出现「渲染层以为有、磁盘上没有」这种第二种事实。
 *
 * 跳过规则与渲染层一致（`src/data/library.ts` 的 rescan：隐藏目录 / node_modules /
 * dist / release 不当文件夹），另加两条剪藏自己引入的：公共 `assets/` 与
 * `<笔记名>.assets/` 是**附件目录，不是落点**。
 * **规则改一处就要改两处** —— 所以两边的注释互相点名（这边指向 library.ts，那边指向这里）。
 *
 * 有界：最多 3 层、最多 400 个目录。无工作区、读不动、结果为空一律如实回空数组，
 * 绝不用一个假的默认值冒充「工作区里没有别的目录」。
 */
const CLIP_FOLDER_SKIP = new Set(['node_modules', 'dist', 'release', 'assets', '.git'])
function listWorkspaceFoldersForClip(root) {
  if (!root) return []
  const out = []
  const walk = (dir, prefix, depth) => {
    if (depth > 3 || out.length >= 400) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= 400) return
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (!name || name.startsWith('.') || CLIP_FOLDER_SKIP.has(name) || name.endsWith('.assets')) continue
      const rel = prefix ? `${prefix}/${name}` : name
      out.push(rel)
      walk(path.join(dir, name), rel, depth + 1)
    }
  }
  walk(root, '', 1)
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

// --- 本地桥装配 ---------------------------------------------------------------

function bridgeStatusPayload() {
  const controller = bridgeController
  if (!controller) {
    // 桥模块加载失败（打包缺文件等）。状态如实报 `failed`，并给出可执行的下一步，
    // 其余可选字段一律给 `null` 而不是省略——渲染层不必为「字段不存在」写分支。
    return {
      state: 'failed',
      port: null,
      endpoint: null,
      tokenLast4: null,
      tokenSet: false,
      origins: [],
      logPath: null,
      inboxWatch: inboxWatchMode(),
      tokenPersisted: false,
      // ㊴（原 ㊲）：没有 controller 时如实回「没有可用的令牌明文（㊴ 后明文落盘，此处是桥模块加载失败的兜底）」，而不是省略字段——
      // 省略会让渲染层的 undefined 与 false 混在一起，面板就得写第二套分支。
      tokenVisible: false,
      address: null,
      error: '本地接口模块没能加载，请重新安装 Opennote。',
      lastRejectedOrigin: null,
      startPort: null,
      portRange: null,
    }
  }
  const raw = controller.status() || {}
  return {
    // `...raw` 必须在最前面：桥的状态里还有 address / error / lastRejectedOrigin /
    // startPort / portRange 等字段，逐字段重建会把它们**静默丢掉**
    // ——渲染层拿不到 `lastRejectedOrigin` 就永远显示不了 R8 的拒绝记录行，
    // 拿不到 `error` 就说不出「8787 到 8796 都被占用了」那句可执行的下一步。
    // 显式字段在下面覆盖，仍会赢；这份白名单只用来把类型收紧到 contract 那样。
    ...raw,
    state: raw.state,
    port: typeof raw.port === 'number' ? raw.port : null,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : null,
    tokenLast4: typeof raw.tokenLast4 === 'string' ? raw.tokenLast4 : null,
    tokenSet: raw.tokenSet === true,
    origins: Array.isArray(raw.origins) ? raw.origins.filter((item) => typeof item === 'string') : [],
    logPath: typeof raw.logPath === 'string' ? raw.logPath : null,
    // 桥自己不知道收件箱 watcher，由主进程如实填。
    inboxWatch: raw.inboxWatch === true ? 'watch' : inboxWatchMode(),
    tokenPersisted: raw.tokenPersisted === true,
  }
}

function ensureBridge() {
  if (bridgeController) return bridgeController
  const module = loadBridgeModule()
  if (!module || typeof module.createBridge !== 'function') return null

  bridgeController = module.createBridge({
    // 契约要求 userData/bridge.json 与 userData/bridge.log。
    // ㊴ 起 bridge.json **同时存令牌明文**（与 sha256 / last4 并列，用户知情选择的取舍），
    // 所以不再写「只存 sha256」—— 注释里的旧事实也是「同一个事实的第二个产地」。
    dataDir: app.getPath('userData'),
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    /**
     * 桥不落盘：把信封转交渲染层，拿回执映射成 HTTP 状态码。
     * 渲染层不在场 → IMP-4006（409，retryable），绝不假成功。
     */
    onEnvelope: async (envelopeJson, client) => {
      const outcome = await relayToRenderer('opennote:import:receipt', {
        envelope: envelopeJson,
        client,
      })
      if (!outcome || typeof outcome !== 'object') return NO_WINDOW_ERROR()
      return outcome
    },
    onInboxStateWrite: (entryId, stateJson) => writeInboxStateForBridge(entryId, stateJson),
    getAdvancedOverwrite,
    // R8：关掉后桥不再往 bridge.log 落行（既有日志不删）。
    isLogEnabled: () => bridgeLogEnabled,
    /**
     * 交付模式（只读，00 号 §6.14㉕）。桥把它透传到 `/v1/health` 与 `/v1/workspace`
     * 的 `inboxMode`，让客户端知道「现在这次导入会不会先进收件箱」。
     * 三态：`"inbox"` / `"direct"` / `null`（= 桥不知道，客户端**不得推断**，
     * 一律以导入回执的 `status` 为准）。
     */
    getInboxMode: () => inboxMode,
    /**
     * 「工作区是否打开」。**这一条原先漏传**，桥侧
     * `typeof options.getWorkspaceInfo === 'function'` 判 false → `workspace.open`
     * 恒为 `false` → 插件对着一本开着的笔记本也显示
     * `IMP-4007「Opennote 里还没有打开笔记本」`。
     * 与 `bridgeStatusPayload()` 逐字段重建截断 6 个字段是同一类缺陷：
     * **桥声明了挂钩，装配处漏接**，而两侧各自单测都是绿的。
     * 只回笔记本名与开关，绝不回绝对路径（契约 7 安全模型）。
     */
    getWorkspaceInfo: () => ({
      open: Boolean(currentWorkspaceRoot),
      name: currentWorkspaceRoot ? path.basename(currentWorkspaceRoot) : null,
    }),
    // `/v1/health` 的 app 字段：如实回真实版本，不要回桥自己的常量兜底。
    getAppVersion: () => app.getVersion(),
    // 收件箱是本版本的内建能力，没有单独的开关。
    getInboxEnabled: () => true,
    // 落点默认是工作区根（00 号 §6.13⑤ 裁定：default landing = workspace root），
    // `null` 即「根目录」。
    getDefaultFolder: () => null,
    /**
     * 网页版剪藏页的落点候选（`GET /v1/clip/folders`）与
     * `POST /v1/clip/commit` 的 `folder` 合法性校验共用这一份。
     *
     * 契约（00 号 §6.14㉕ + 本轮冻结）：`""` = 进收件箱；非空必须是**已存在的目录**，
     * 不自动创建。桥负责把 `""` 放在第一项 —— 主进程只回**真实存在**的目录名，
     * 不在这里掺一个「收件箱」的假目录（否则「收件箱」会同时是目录名和落点模式两种含义）。
     *
     * 拿不到工作区时回空数组：桥必须把「空」和「读失败」分开报，绝不回一个假列表。
     */
    getFolders: () => listWorkspaceFoldersForClip(currentWorkspaceRoot),
    log: (event, fields) => {
      // 契约要求日志不含令牌、配对码、正文与 userData 绝对路径；
      // 桥自己已经脱敏，这里只补一条事件名，避免把整个 fields 打进主进程日志。
      const code = fields && typeof fields.code === 'string' ? ` code=${fields.code}` : ''
      console.log(`[opennote] bridge ${event}${code}`)
    },
  })
  return bridgeController
}

/** 桥的生命周期跟随窗口：窗口关闭即停止监听。 */
function stopBridgeQuietly() {
  const controller = bridgeController
  if (!controller) return Promise.resolve()
  return Promise.resolve(controller.stop()).catch(() => {})
}

async function registerImportHandlers() {
  // 渲染层回执（信封与收件箱操作共用一条频道，靠 reqId 配对）。
  ipcMain.on('opennote:import:reply', (event, payload) => {
    if (!isTrustedSender(event)) return
    settleImportRelay(payload)
  })

  handle(
    'opennote:bridge:status',
    async () => bridgeStatusPayload(),
    '读取本地接口状态失败',
  )

  handle(
    'opennote:bridge:start',
    async (options) => {
      const controller = ensureBridge()
      if (!controller) {
        return { ...bridgeStatusPayload(), state: 'failed' }
      }
      // 未设置令牌时桥不允许开启（桥自己会拒绝），界面先引导「生成令牌」。
      const port = options && typeof options === 'object' ? options.port : undefined
      await controller.startWithPort(port)
      return bridgeStatusPayload()
    },
    '开启本地接口失败',
  )

  handle(
    'opennote:bridge:stop',
    async () => {
      // task-27：这里是**用户在面板上显式关闭**接口 —— 必须同时把「用户偏好」置 false，
      // 否则下次启动会被自动恢复，变成反方向的 bug（「我明明关了它还自己开」）。
      // 生命周期停止（before-quit / 窗口关闭）走 stopBridgeQuietly() → 纯 stop()，**不动偏好**。
      // 即：`enabled` 只表示「用户想不想开着」，不表示「现在在不在监听」。
      const controller = ensureBridge()
      if (controller) {
        await Promise.resolve(controller.stop({ disable: true })).catch(() => {})
      }
      return bridgeStatusPayload()
    },
    '停止本地接口失败',
  )

  handle(
    'opennote:bridge:newToken',
    async (options) => {
      const controller = ensureBridge()
      if (!controller) throw new Error('生成令牌失败：本地接口模块不可用')
      const origin = options && typeof options === 'object' ? options.origin : undefined
      const token = controller.regenerateToken()
      if (typeof origin === 'string' && origin !== '') controller.addAllowedOrigin(origin)
      // 唯一一次返回明文；服务端只留 sha256 与后四位。
      return { token, last4: token.slice(-4) }
    },
    '生成令牌失败',
  )

  /**
   * 配对已在 0.3.1 删除（00 号 §6.15㉞）：客户端改为**粘贴长期令牌**。
   *
   * 这里**保留频道与 handler**（而不是删掉）：`ipc-safety-check.cjs` 的「既有方法名
   * 与参数个数不变」断言以 HEAD 的 preload 面为基线，删方法会让那条护栏误判为
   * 「破坏了既有契约」。保留但**明确报「已下线」**，比留一个调用即抛
   * `TypeError` 的幽灵方法好 —— 前者用户看得懂，后者只会在控制台里冒一句英文。
   */
  handle(
    'opennote:bridge:newPairCode',
    async () => {
      // 用 IMP-3005（路径/方法不存在）而不是 IMP-2004：后者是**已作废**的配对码错误码，
      // 00 号 §6.15㉞ 明确「保留码号但不得复用」——拿它报「配对这条路没了」是语义错位。
      throw Object.assign(new Error('配对功能已下线。请在设置里复制令牌，粘贴到客户端。'), {
        code: 'IMP-3005',
        userMessage: '配对功能已经取消。请在 Opennote 的「导入与接口」里复制令牌，粘贴到客户端。',
      })
    },
    '生成配对码失败',
  )

  handle(
    'opennote:bridge:removeOrigin',
    async (options) => {
      const controller = ensureBridge()
      const origin = options && typeof options === 'object' ? options.origin : undefined
      if (!controller) throw new Error('移除来源失败：本地接口模块不可用')
      if (typeof origin !== 'string' || origin === '') throw new Error('移除来源失败：来源无效')
      controller.removeAllowedOrigin(origin)
      return bridgeStatusPayload()
    },
    '移除来源失败',
  )

  handle(
    'opennote:bridge:openLog',
    async () => {
      const controller = ensureBridge()
      const logPath = controller && controller.getLogPath()
      if (typeof logPath !== 'string' || logPath === '') return
      if (existsSync(logPath)) shell.showItemInFolder(logPath)
      else shell.showItemInFolder(path.dirname(logPath))
    },
    '打开本地接口日志失败',
  )

  /**
   * R8「记录本地接口日志」。开关的真实行为在**主进程**：它决定桥是否往
   * `bridge.log` 落行。渲染层只管把用户的偏好推过来——否则就是个「开关能点、
   * 但落盘行为不变」的假开关。用户关掉后，之前的日志**不删除**（那是用户的
   * 文件，删它比留着更糟），只是不再增长。
   */
  handle(
    'opennote:bridge:setLogEnabled',
    async (args) => {
      const enabled = !args || args.enabled !== false
      bridgeLogEnabled = enabled
      return { enabled: bridgeLogEnabled }
    },
    '设置本地接口日志开关失败',
  )

  /**
   * 交付模式（00 号 §6.14㉕）。渲染层把 `ui.importConflict` 推过来，桥据此在
   * `/v1/health`、`/v1/workspace` 里如实回报 `inboxMode`。
   * **只认 `"inbox"` 与 `"direct"`**：不认识的值一律落到 `"direct"`，绝不猜一个
   * 对用户有承诺含义的模式（0.3.0 默认 `"inbox"`，由渲染层启动时推一次）。
   */
  handle(
    'opennote:bridge:setInboxMode',
    async (args) => {
      const raw = args && typeof args === 'object' ? args.mode : args
      inboxMode = raw === 'inbox' ? 'inbox' : 'direct'
      return { mode: inboxMode }
    },
    '设置交付模式失败',
  )

  /**
   * ㊴（原 ㊲，存储位置由 ㊴ 改为落盘）：只读取回当前令牌明文，**绝不轮换**。加它的理由是一个真实缺口：
   * **整窗重载（Ctrl+R）不是应用重启** —— 主进程仍持有明文，而渲染层的模块缓存
   * 没了，于是「复制令牌」会变成一个点不动的死按钮，而用户此刻往往正想配 agent。
   * 本会话不再持有（应用重启过）时返回 null，绝不假装可用。
   */
  handle(
    'opennote:bridge:token',
    async () => {
      const controller = ensureBridge()
      const read =
        controller && typeof controller.getSessionPlaintext === 'function'
          ? controller.getSessionPlaintext
          : null
      return { token: typeof read === 'function' ? read() ?? null : null }
    },
    '读取本地接口令牌失败',
  )

  /**
   * 其余导入/收件箱操作只有一份实现：渲染层的 `src/data/*`。
   * 主进程不复制一套读写逻辑（否则会与渲染层漂移）。
   */
  const relayHandler = (op) =>
    handle(
      `opennote:${op === 'recent' || op === 'undo' || op === 'log' ? 'import' : 'inbox'}:${
        op === 'inboxList' ? 'list' : op === 'inboxCommit' ? 'commit' : op === 'inboxDiscard' ? 'discard' : op
      }`,
      async (args) => {
        const outcome = await relayToRenderer('opennote:import:request', { op, args })
        if (!outcome || typeof outcome !== 'object') {
          throw asUserError(NO_WINDOW_ERROR(), '转交失败')
        }
        if (outcome.ok === false) {
          const error = new Error(
            (outcome.error && outcome.error.userMessage) || '导入操作失败',
          )
          error.userMessage = outcome.error && outcome.error.userMessage
          error.code = outcome.error && outcome.error.code
          throw error
        }
        return outcome.result
      },
      '导入操作失败',
    )

  relayHandler('recent')
  relayHandler('undo')
  relayHandler('log')
  relayHandler('inboxList')
  relayHandler('inboxCommit')
  relayHandler('inboxDiscard')
}

// ---------------------------------------------------------------------------
// 自更新（GitHub Releases → 下载校验 → 退出覆盖 → 重开）
// ---------------------------------------------------------------------------
//
// 分工：网络/磁盘/进程控制全在 `electron/update.cjs`（那里是唯一产地），这里只做
// 「接线」——注册 IPC、把状态广播给窗口、以及用户点「重启并更新」之后的编排。
//
// 不变式（改动前先读 `electron/update.cjs` 的头部注释）：
//   1) 渲染层不能指定 URL / 路径 / 版本，只能调下面这五条；唯一可配的是主进程环境变量
//      `OPENNOTE_UPDATE_API_BASE`（镜像与 e2e 用，渲染层碰不到）。
//   2) CSP **不动**：网络只在主进程发生，渲染层仍然没有 `connect-src http(s)`。
//   3) 只有 `app.isPackaged && win32 && x64` 才启用（没有产物的平台显示了就是撒谎）。
//   4) 覆盖安装必须由用户点「重启并更新」触发，且必须先走 D11 落盘握手。

const UPDATE_STATUS_CHANNEL = 'opennote:update:status'
const UPDATE_CHECK_CHANNEL = 'opennote:update:check'
const UPDATE_DOWNLOAD_CHANNEL = 'opennote:update:download'
const UPDATE_CANCEL_CHANNEL = 'opennote:update:cancel'
const UPDATE_RESTART_CHANNEL = 'opennote:update:restart'
const UPDATE_CHANGED_CHANNEL = 'opennote:update:changed'
/** 启动后多久做那一次静默检查：等窗口先画出来，别和首屏抢资源。 */
const UPDATE_STARTUP_CHECK_DELAY_MS = 5000

let updateModule = null
let updateModuleTried = false
let updateController = null

/**
 * 惰性加载更新模块。缺文件（或加载失败）时退化为「更新能力不存在」，
 * 而不是让整个桌面端起不来 —— 与 `loadBridgeModule()` 同一套取舍。
 */
function loadUpdateModule() {
  if (updateModuleTried) return updateModule
  updateModuleTried = true
  try {
    updateModule = require('./update.cjs')
  } catch (error) {
    updateModule = null
    console.warn(
      `[opennote] 更新模块加载失败，本次运行不提供自更新：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return updateModule
}

/** 硬门：只有「打包版 + Windows x64」有可用的免安装包。 */
function updateSupported() {
  return app.isPackaged && process.platform === 'win32' && process.arch === 'x64'
}

function updateDirectory() {
  return path.join(app.getPath('userData'), 'updates')
}

/**
 * 仓库身份只认打包内 `package.json` 的 `repository.url`。
 * 为什么值得写一条注释：0.6.0 端到端第一次真跑就抓到它写着**不存在的组织**（`opennote/opennote`），
 * 于是「检查更新」永远 404。现在 `src/desktop/repository.test.ts` 咬住「能解析 + 与 homepage 同仓库」。
 */
function repositoryUrlFromPackage() {
  try {
    const raw = readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.repository?.url === 'string' ? parsed.repository.url : ''
  } catch {
    return ''
  }
}

function unsupportedUpdateStatus() {
  return {
    supported: false,
    current: app.getVersion(),
    phase: 'idle',
    latest: null,
    releaseUrl: null,
    asset: null,
    progress: null,
    error: null,
    canAutoInstall: false,
    checkedAt: null,
  }
}

function ensureUpdater() {
  if (updateController) return updateController
  const module = loadUpdateModule()
  if (!module || typeof module.createUpdater !== 'function') return null
  updateController = module.createUpdater({
    appVersion: app.getVersion(),
    repositoryUrl: repositoryUrlFromPackage(),
    // 环境变量只在这里读一次：e2e 与将来的国内镜像都走它，渲染层无权设置。
    apiBase: process.env.OPENNOTE_UPDATE_API_BASE || undefined,
    downloadBase: process.env.OPENNOTE_UPDATE_DOWNLOAD_BASE || undefined,
    updatesDir: updateDirectory(),
    installDir: path.dirname(app.getPath('exe')),
    platform: process.platform,
    arch: process.arch,
    supported: updateSupported(),
    onChange: (status) => {
      const window = mainWindow
      if (!window || window.isDestroyed()) return
      try {
        window.webContents.send(UPDATE_CHANGED_CHANNEL, status)
      } catch {
        /* 窗口正在销毁时广播失败无所谓 */
      }
    },
    log: (message) => console.log(`[opennote] update ${message}`),
    apply: (plan) => applyUpdatePlan(plan),
  })
  return updateController
}

/** 状态里附上「上一次覆盖的结果」，只交付一次（成功/失败都要如实说一次）。 */
function updateStatusForRenderer() {
  const controller = ensureUpdater()
  if (!controller) return unsupportedUpdateStatus()
  const status = controller.status()
  const applyResult = controller.takeApplyResult()
  return applyResult ? { ...status, applyResult } : status
}

/**
 * 覆盖脚本与握手文件都写到真实路径（helper 在 RUN_AS_NODE 下读不到 asar）。
 */
async function prepareUpdateApply(plan) {
  const module = loadUpdateModule()
  const protocol = (module && module.PROTOCOL) || {}
  const helperName = protocol.helperName || '.apply-update.cjs'
  const applyingMarker = protocol.applyingMarker || '.applying'
  const handoffFile = protocol.handoffFile || 'handoff.json'
  const resultFile = protocol.resultFile || 'result.json'
  const logFile = protocol.logFile || 'apply.log'

  const updatesDir = updateDirectory()
  await mkdir(updatesDir, { recursive: true })
  const helperTarget = path.join(plan.stagingDir, helperName)
  await copyFile(path.join(app.getAppPath(), 'electron', 'update-helper.cjs'), helperTarget)
  await writeFile(
    path.join(plan.stagingDir, applyingMarker),
    JSON.stringify({ version: plan.version, at: new Date().toISOString() }),
    'utf8',
  )

  const handoffPath = path.join(updatesDir, handoffFile)
  const handoff = {
    pid: process.pid,
    installDir: path.dirname(app.getPath('exe')),
    stagingDir: plan.stagingDir,
    exeName: plan.exeName || 'Opennote.exe',
    // 原样带走启动参数：`--user-data-dir` 之类必须跟着新进程走。
    argv: process.argv.slice(1),
    logPath: path.join(updatesDir, logFile),
    version: plan.version,
    resultPath: path.join(updatesDir, resultFile),
    from: app.getVersion(),
  }
  await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8')
  return { handoffPath, helperName, stagedExe: path.join(plan.stagingDir, handoff.exeName) }
}

/**
 * 编排「重启并更新」：
 *   准备 helper 与握手 → 用 **staging 里的新 exe** 起 helper（它等我们退出）→ 关窗
 *   （走 D11 落盘握手）→ 进程退出后 helper 覆盖并启动新版本。
 *
 * 为什么 helper 用 staging 里的 exe：Windows 上正在运行的 exe 锁着自己，只有让
 * helper 从 staging 跑，旧安装目录才没有任何进程、可以被直接覆盖。
 *
 * 「确定要重启吗」由**渲染层的应用内确认框**负责（`src/lib/update.ts` 的 `askConfirm`）：
 * 主进程在这里弹原生模态会挡住 e2e 与自动化，而且这一步本来就是界面的事。
 */
async function applyUpdatePlan(plan) {
  const window = mainWindow
  if (!window || window.isDestroyed()) return { ok: false, reason: 'NO_WINDOW' }
  if (!plan || typeof plan.stagingDir !== 'string') return { ok: false, reason: 'NO_PLAN' }

  const { handoffPath, stagedExe } = await prepareUpdateApply(plan)
  const child = spawn(stagedExe, [path.join(plan.stagingDir, '.apply-update.cjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENNOTE_UPDATE_HANDOFF: handoffPath,
    },
  })
  child.on('error', (error) => {
    console.warn(`[opennote] 更新脚本启动失败：${error instanceof Error ? error.message : String(error)}`)
  })
  child.unref()

  // 先把 IPC 回执发出去，再关窗（关窗会触发渲染层的落盘握手，最多等 1.5s）。
  const timer = setTimeout(() => {
    const target = mainWindow
    if (target && !target.isDestroyed()) target.close()
    else app.quit()
  }, 200)
  timer.unref?.()
  console.log(`[opennote] update 准备覆盖到 v${plan.version}，等待用户重启`)
  return { ok: true }
}

/** 启动时收尾：读回上次覆盖结果、恢复「已下载待重启」、清理半成品。 */
async function resumeUpdateOnStartup() {
  const controller = ensureUpdater()
  if (!controller) return
  try {
    await controller.resume()
  } catch (error) {
    console.warn(`[opennote] 更新状态恢复失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 上一次覆盖的结果**不在这里消费**：它随渲染层第一次 `status` 调用一起交付
  // （`updateStatusForRenderer`），否则窗口还没订阅时发出去就等于丢了。
}

/**
 * 更新通道的处理器包装：来源校验 + 与 `handle()` 同一套错误降级。
 *
 * 为什么不用 `handle()`：它不把 `event` 交给回调，而更新能覆盖磁盘上的可执行文件，
 * 必须校验来源（`ipc-safety-check.cjs` 有「未授权来源被拒」的断言）。
 * 注册处一律写成 `ipcMain.handle(常量, …)`：`verify-contract.cjs` 的 C-12a 靠
 * 「常量可解析」把两侧配对咬住，套一层自定义函数名会让通道名解析不出来。
 */
function trustedUpdateHandler(fn, fallbackMessage) {
  return async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('未授权的调用来源')
    try {
      return await fn(...args)
    } catch (error) {
      throw asUserError(error, fallbackMessage)
    }
  }
}

function registerUpdateHandlers() {
  ipcMain.handle(
    UPDATE_STATUS_CHANNEL,
    trustedUpdateHandler(async () => updateStatusForRenderer(), '读取更新状态失败'),
  )
  ipcMain.handle(
    UPDATE_CHECK_CHANNEL,
    trustedUpdateHandler(async (options) => {
      const controller = ensureUpdater()
      if (!controller) return unsupportedUpdateStatus()
      await controller.check({ force: options?.force === true })
      return controller.status()
    }, '检查更新失败'),
  )
  ipcMain.handle(
    UPDATE_DOWNLOAD_CHANNEL,
    trustedUpdateHandler(async () => {
      const controller = ensureUpdater()
      if (!controller) return unsupportedUpdateStatus()
      return controller.download()
    }, '下载更新失败'),
  )
  ipcMain.handle(
    UPDATE_CANCEL_CHANNEL,
    trustedUpdateHandler(async () => {
      const controller = ensureUpdater()
      if (!controller) return unsupportedUpdateStatus()
      return controller.cancel()
    }, '取消更新失败'),
  )
  ipcMain.handle(
    UPDATE_RESTART_CHANNEL,
    trustedUpdateHandler(async () => {
      const controller = ensureUpdater()
      if (!controller) return { ok: false, reason: 'UNSUPPORTED' }
      return controller.restart()
    }, '重启更新失败'),
  )
}

// ---------------------------------------------------------------------------
// D38：Content-Security-Policy（只对 file:// 注入）
// ---------------------------------------------------------------------------

function isFileUrl(url) {
  return typeof url === 'string' && url.startsWith('file://')
}

/**
 * 收集桌面构建 index.html 里内联脚本的 sha256（CSP 哈希只覆盖脚本正文，不含标签）。
 * 换行必须先归一成 LF：HTML 输入流预处理会把 CRLF/CR 变成 LF，哈希按归一化后的正文
 * 计算才与浏览器一致。读不到文件（尚未构建等）时保持空数组，策略退化成冻结基线。
 */
async function loadInlineScriptHashes() {
  try {
    const html = await readFile(path.join(app.getAppPath(), 'dist', 'index.html'), 'utf8')
    const hashes = new Set()
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const body = match[1].replace(/\r\n?/g, '\n')
      if (body.trim() === '') continue
      hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
    }
    CSP_INLINE_SCRIPT_HASHES.length = 0
    CSP_INLINE_SCRIPT_HASHES.push(...hashes)
    if (hashes.size > 0) console.log(`[opennote] CSP：已放行 ${hashes.size} 个内联启动脚本（sha256）`)
  } catch {
    /* 没有 dist/index.html：保持不含内联脚本的严格基线 */
  }
}

/**
 * 只对 file:// 响应注入 CSP。dev server 走 http://127.0.0.1:5173，
 * 一旦注入 script-src 'self' 就会挡掉 Vite 的 HMR 脚本，所以绝不注入。
 */
function installContentSecurityPolicy() {
  try {
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, (details, callback) => {
      if (!isFileUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      const responseHeaders = { ...(details.responseHeaders || {}) }
      // 去掉可能已存在的同名头（大小写不敏感），避免两条策略求交后把脚本挡死。
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key]
      }
      responseHeaders['Content-Security-Policy'] = [cspPolicy()]
      callback({ responseHeaders })
    })
  } catch (error) {
    // 注入失败不能拖垮启动；此时渲染层仍有 DOMPurify 等既有防线。
    console.error(`[opennote] CSP 注入注册失败：${errorCodeOf(error) || '未知错误'}`)
  }
}

// ---------------------------------------------------------------------------
// D11：关窗握手（渲染层 flush 完成后再放行，最多 1.5s）
// ---------------------------------------------------------------------------

/** 等待 flush 完成的 { webContents, resolve } 集合；对应渲染层调用 app.flushDone() 时放行。 */
const flushWaiters = new Set()

function resolveFlushWaiters(sender) {
  for (const waiter of [...flushWaiters]) {
    if (!sender || waiter.webContents === sender) waiter.resolve()
  }
}

/**
 * 请渲染层落盘，并等待 flush-done；超时（或发送失败）也一定放行，
 * 绝不把窗口卡死。
 */
function requestRendererFlush(window) {
  return new Promise((resolve) => {
    if (!window || window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) {
      resolve()
      return
    }
    const waiter = { webContents: window.webContents, resolve: () => {} }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      flushWaiters.delete(waiter)
      resolve()
    }
    waiter.resolve = finish
    const timer = setTimeout(finish, FLUSH_TIMEOUT_MS)
    timer.unref?.()
    flushWaiters.add(waiter)
    try {
      window.webContents.send('opennote:app:request-flush')
    } catch {
      finish()
    }
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
    // 桥的生命周期跟随窗口：窗口没了就不该还有人在监听 127.0.0.1。
    void stopBridgeQuietly()
    // macOS ⌘Q：第一次 app.quit() 被 close 的 preventDefault 中止，flush 完成后要补一次。
    if (quitRequested) app.quit()
  })

  // D11：关窗时先让渲染层 flush，最多等 1.5s；超时也放行，绝不卡死窗口。
  let closeApproved = false
  let flushPending = false
  window.on('close', (event) => {
    if (closeApproved || window.isDestroyed()) return
    event.preventDefault()
    if (flushPending) return
    flushPending = true
    void requestRendererFlush(window).then(() => {
      flushPending = false
      closeApproved = true
      if (window.isDestroyed()) return
      window.close()
      // 兜底：渲染层的 beforeunload 若仍取消关闭，强制销毁（数据已在 flush 阶段落盘）。
      const force = setTimeout(() => {
        if (!window.isDestroyed()) window.destroy()
      }, 800)
      force.unref?.()
    })
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
// opennote:// 深链（00 号 §6.14㉛ / 02 号 §5.6）
// ---------------------------------------------------------------------------

/**
 * 本次只实现两条**只读**路由：`API-11 opennote://settings/import`（02 号定为 P0）
 * 与 `API-12 opennote://open?path=…`。`API-09 opennote://clip?d=…` **明确不做**
 * （用户已确认剪藏主路径是「应用开着 + 本地桥」）。
 *
 * 未实现 / 非法的路由**必须显式告知**，绝不静默无反应 —— 0.2.0 那个
 * 「打开 Opennote 设置」死按钮就是因为我们从来没注册协议，点了什么都不发生。
 */
let pendingDeeplink = null
let startupDeeplinkNotice = null
let inboxMode = 'inbox'

function focusMainWindow() {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.focus()
}

function notifyDeeplinkProblem(message) {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (window) {
    void dialog.showMessageBox(window, { type: 'info', message, buttons: ['知道了'] }).catch(() => {})
    return
  }
  // 没有窗口时（启动早期）先记下来，等窗口建好再显示，不能吞掉。
  startupDeeplinkNotice = message
}

function sendDeeplink(parsed) {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!window || window.webContents.isLoading()) {
    // 窗口还没就绪：记下来，等 did-finish-load 再发。丢在这里就等于静默失败。
    pendingDeeplink = parsed
    return
  }
  focusMainWindow()
  window.webContents.send(DEEPLINK_CHANNEL, parsed)
}

function handleDeeplink(raw) {
  const parsed = parseOpennoteUrl(raw)
  if (!parsed.ok) {
    console.warn(`[opennote] deeplink 已拒绝：${parsed.reason} route=${parsed.route || '(空)'}`)
    notifyDeeplinkProblem(deeplinkMessage(parsed))
    return false
  }
  sendDeeplink(parsed)
  return true
}

/** 窗口就绪后把启动期攒下的深链与提示补发出去（不能丢）。 */
function flushDeeplink() {
  const notice = startupDeeplinkNotice
  startupDeeplinkNotice = null
  if (notice) notifyDeeplinkProblem(notice)

  const pending = pendingDeeplink
  pendingDeeplink = null
  if (!pending) return
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!window) return
  // 页面还在加载时 `webContents.send` 会丢：放回 pending，等加载完再发一次。
  if (window.webContents.isLoading()) {
    pendingDeeplink = pending
    window.webContents.once('did-finish-load', () => flushDeeplink())
    return
  }
  window.webContents.send(DEEPLINK_CHANNEL, pending)
}

/**
 * 注册 `opennote://` 协议。开发期（`electron .`）必须把入口脚本一起注册，
 * 否则系统唤起的是裸 electron 而不是这个应用。
 */
function registerProtocolClient() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
    }
    return app.setAsDefaultProtocolClient(PROTOCOL)
  } catch (error) {
    console.warn(
      `[opennote] 注册 ${PROTOCOL}:// 失败：${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

// 契约 02:1118：拿不到单实例锁的进程立即退出，命令行参数交给已运行实例。
// 第二个实例必须**不能**继续走到 app.whenReady()，否则会出现两个窗口抢同一个桥端口。
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  registerProtocolClient()
  // 启动参数里可能直接带着深链（Windows/Linux 双击链接）。
  const startupLink = findDeeplinkInArgv(process.argv)
  if (startupLink) {
    const parsed = parseOpennoteUrl(startupLink)
    if (parsed.ok) pendingDeeplink = parsed
    else startupDeeplinkNotice = deeplinkMessage(parsed)
  }

  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    const link = findDeeplinkInArgv(argv)
    if (link) handleDeeplink(link)
  })

  // macOS 走 open-url（不经过 argv）。
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeeplink(url)
  })
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  if (!singleInstance) return
  registerIpcHandlers()
  installApplicationMenu()
  await loadPersistentRoots()
  await loadInlineScriptHashes()
  installContentSecurityPolicy()

  try {
    await createWindow()
    if (!readyLogged) {
      readyLogged = true
      const iconNote = existsSync(WINDOW_ICON) ? WINDOW_ICON : 'exe 内嵌图标'
      const frameNote = mainWindow && !mainWindow.isDestroyed()
        ? `窗口=${mainWindow.getBounds().height}px 内容=${mainWindow.getContentBounds().height}px`
        : '窗口未就绪'
      console.log(
        `[opennote] desktop ready ${app.getVersion()}（icon=${iconNote}；${frameNote}；持久授权工作区=${persistentRoots.size}）`,
      )
    }

    // 窗口就绪：把启动期攒下的 `opennote://` 深链补发出去（不丢）。
    flushDeeplink()

    // 自更新：先收尾上次的覆盖结果，再按「每次启动检查一次」查一遍。
    // 只有打包版 Windows x64 才启用（没有产物的平台不显示图标，也不发请求）。
    if (updateSupported()) {
      await resumeUpdateOnStartup()
      const updateTimer = setTimeout(() => {
        const controller = ensureUpdater()
        if (controller) void controller.check()
      }, UPDATE_STARTUP_CHECK_DELAY_MS)
      updateTimer.unref?.()
    }

    // 本地接口：默认关闭。只有用户上次显式开启过（bridge.json 里 enabled=true，
    // 此时桥的初始状态是 stopped 而不是 disabled）才在启动时自动恢复监听。
    const controller = ensureBridge()
    if (controller) {
      const raw = controller.status() || {}
      if (raw.state === 'stopped') {
        void Promise.resolve(controller.start()).catch(() => {})
      }
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

app.on('before-quit', () => {
  quitRequested = true
  // 契约：关掉本地接口 = 立刻 server.close() + 断开全部 keep-alive 连接。
  void stopBridgeQuietly()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
