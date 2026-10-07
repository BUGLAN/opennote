'use strict'

/**
 * 最小 ZIP 解压器（纯 Node 内建，零第三方依赖）。
 *
 * 为什么自己写：
 *   1. 主进程**不许** require 第三方包（`electron-builder.yml` 的 `files` 刻意排除
 *      `node_modules`，见 RELEASING.md 已知坑 #4）；渲染层那份 `jszip` 会把 380 MB
 *      解压结果全堆在内存里，不能用于 151 MB 的免安装包。
 *   2. Windows 自带的 `tar.exe` / `Expand-Archive` 是**系统工具**：版本、可用性、
 *      中文路径编码都不由我们掌握，而且没法在 vitest 里真跑。
 *
 * 只接受 electron-builder 实际产出的形态（store / deflate），其余一律**明确拒绝**：
 * ZIP64、加密条目、未知压缩方式、CRC 不符、截断文件、绝对路径与 `..` 越界。
 * 拒绝即抛错，调用方负责把半成品目录删掉 —— 绝不留下「看起来解压成功」的残缺目录。
 *
 * 安全边界：目标目录由调用方给定，但条目名来自**下载来的字节**，所以每一条都要过
 * `safeEntryPath()`（zip-slip 是这条链路上唯一能写到目标目录之外的入口）。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const zlib = require('node:zlib')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT_LENGTH = 0xffff
const ZIP64_MARKER_16 = 0xffff
const ZIP64_MARKER_32 = 0xffffffff
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const FLAG_ENCRYPTED = 0x0001

class ZipError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

/** CRC-32（IEEE 802.3）查表，与 zip 中央目录里存的 crc 同一套多项式。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * 增量 CRC32：状态以 `0xffffffff` 起、以 `^0xffffffff` 收尾。
 * 分块调用必须用同一个状态，不能每块各自 `crc32(chunk)` 再拼接。
 */
function crc32Update(state, chunk) {
  let crc = state >>> 0
  for (let index = 0; index < chunk.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return crc
}

function crc32(buffer) {
  return (crc32Update(0xffffffff, buffer) ^ 0xffffffff) >>> 0
}

/** 边流边算：解压时不可能把 246 MB 的 exe 读进内存再校验。 */
class Crc32Counter extends Transform {
  constructor() {
    super()
    this.state = 0xffffffff
    this.bytes = 0
  }

  _transform(chunk, _encoding, callback) {
    this.state = crc32Update(this.state, chunk)
    this.bytes += chunk.length
    callback(null, chunk)
  }

  digest() {
    return { crc: (this.state ^ 0xffffffff) >>> 0, bytes: this.bytes }
  }
}

/**
 * 条目名 → 目标相对路径。返回 `null` 表示这一条是目录项（不需要写文件）。
 * 越界/绝对路径/非法字符一律抛错，不做「悄悄改名」的兜底。
 */
function safeEntryPath(name) {
  if (typeof name !== 'string' || name === '') {
    throw new ZipError('BAD_ENTRY', '压缩包里有空条目名')
  }
  if (name.includes('\0')) {
    throw new ZipError('BAD_ENTRY', `压缩包条目名含非法字符：${name}`)
  }
  const normalized = name.replace(/\\/g, '/')
  if (normalized.endsWith('/')) return null
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ZipError('ABSOLUTE_PATH', `压缩包条目是绝对路径：${name}`)
  }
  const parts = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      throw new ZipError('PATH_TRAVERSAL', `压缩包条目试图越出目标目录：${name}`)
    }
    parts.push(part)
  }
  if (parts.length === 0) return null
  return parts.join(path.sep)
}

/** 从尾部回扫 End of Central Directory（注释最长 64 KB）。 */
async function readEndOfCentralDirectory(handle, size) {
  if (size < 22) throw new ZipError('TRUNCATED', '压缩包不完整（小于最小 zip 长度）')
  const tailSize = Math.min(size, 22 + MAX_COMMENT_LENGTH)
  const tail = Buffer.alloc(tailSize)
  await handle.read(tail, 0, tailSize, size - tailSize)
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength > tail.length) continue
    return {
      entryCount: tail.readUInt16LE(offset + 10),
      directorySize: tail.readUInt32LE(offset + 12),
      directoryOffset: tail.readUInt32LE(offset + 16),
    }
  }
  throw new ZipError('NOT_A_ZIP', '不是可识别的 zip 文件')
}

async function readCentralDirectory(handle, eocd) {
  if (
    eocd.entryCount === ZIP64_MARKER_16 ||
    eocd.directorySize === ZIP64_MARKER_32 ||
    eocd.directoryOffset === ZIP64_MARKER_32
  ) {
    throw new ZipError('ZIP64', '不支持 ZIP64 压缩包')
  }
  if (eocd.entryCount === 0) return []
  const directory = Buffer.alloc(eocd.directorySize)
  await handle.read(directory, 0, eocd.directorySize, eocd.directoryOffset)
  const entries = []
  let offset = 0
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (offset + 46 > directory.length) throw new ZipError('TRUNCATED', '中央目录被截断')
    if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError('BAD_DIRECTORY', '中央目录项签名不正确')
    }
    const flags = directory.readUInt16LE(offset + 8)
    const method = directory.readUInt16LE(offset + 10)
    const crc = directory.readUInt32LE(offset + 16)
    const compressedSize = directory.readUInt32LE(offset + 20)
    const uncompressedSize = directory.readUInt32LE(offset + 24)
    const nameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    const localOffset = directory.readUInt32LE(offset + 42)
    const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 解压单个条目。
 *
 * 数据起点必须用**本地头**里的名字/扩展域长度重算（中央目录里那份可能与本地不同，
 * 尤其是 extra 域），拿中央目录的偏移直接读会错位。
 */
async function extractEntry(handle, zipPath, destinationDir, entry, signal) {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new ZipError('ENCRYPTED', `压缩包条目已加密，无法解压：${entry.name}`)
  }
  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    throw new ZipError('UNSUPPORTED_METHOD', `不支持的压缩方式（${entry.method}）：${entry.name}`)
  }
  if (entry.compressedSize === ZIP64_MARKER_32 || entry.uncompressedSize === ZIP64_MARKER_32) {
    throw new ZipError('ZIP64', `不支持 ZIP64 条目：${entry.name}`)
  }

  const header = Buffer.alloc(30)
  await handle.read(header, 0, 30, entry.localOffset)
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ZipError('BAD_ENTRY', `本地头签名不正确：${entry.name}`)
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength

  const target = path.join(destinationDir, entry.relative)
  await fsp.mkdir(path.dirname(target), { recursive: true })

  const counter = new Crc32Counter()
  if (entry.compressedSize === 0) {
    const empty = fs.createWriteStream(target)
    empty.end()
    await new Promise((resolve, reject) => {
      empty.on('finish', resolve)
      empty.on('error', reject)
    })
  } else {
    const source = fs.createReadStream(zipPath, {
      start: dataOffset,
      end: dataOffset + entry.compressedSize - 1,
    })
    const stages =
      entry.method === METHOD_DEFLATE
        ? [source, zlib.createInflateRaw(), counter, fs.createWriteStream(target)]
        : [source, counter, fs.createWriteStream(target)]
    await pipeline(...stages, signal ? { signal } : {})
  }

  const { crc, bytes } = counter.digest()
  if (bytes !== entry.uncompressedSize) {
    throw new ZipError('SIZE_MISMATCH', `解压后大小不符：${entry.name}`)
  }
  if (crc !== entry.crc) {
    throw new ZipError('CRC_MISMATCH', `压缩包条目校验失败：${entry.name}`)
  }
}

/**
 * 在「关掉 asar 支持」的前提下跑一段 fs 操作。
 *
 * 为什么必须要有它：Electron 的 fs 补丁会把**任何路径里含 `.asar` 的写操作**当成
 * 「在 asar 包里写文件」。免安装包里恰好有 `resources/app.asar`，把它解压到磁盘时，
 * 补丁会去 open 那个**还不存在 / 正写到一半**的归档，直接抛 `Invalid package`
 * （实测栈：`WriteStream._construct → Object.open → createError('Invalid package …')`）。
 * 没有这一步，「下载成功 → 解压必失败」，整条更新链路在生产里根本走不通。
 *
 * `process.noAsar` 是 Electron 官方给的开关。这里只在解压/清理期间打开、结束立刻恢复
 * —— 主进程其它地方仍然需要 asar 支持去读打包内的文件（如 `electron/update-helper.cjs`）。
 * 纯 Node 下这个属性没有任何副作用（vitest 里跑的就是纯 Node）。
 */
function withAsarDisabled(fn) {
  const previous = process.noAsar
  process.noAsar = true
  const restore = () => {
    process.noAsar = previous
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') return result.finally(restore)
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

/**
 * 解压 `zipPath` 到 `destinationDir`（会被创建）。
 *
 * @param {string} zipPath
 * @param {string} destinationDir
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ entries: number }>}
 */
async function extract(zipPath, destinationDir, options = {}) {
  return withAsarDisabled(() => extractArchive(zipPath, destinationDir, options))
}

async function extractArchive(zipPath, destinationDir, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const signal = options.signal
  const stat = await fsp.stat(zipPath)
  const handle = await fsp.open(zipPath, 'r')
  try {
    const eocd = await readEndOfCentralDirectory(handle, stat.size)
    const central = await readCentralDirectory(handle, eocd)
    const files = []
    for (const entry of central) {
      const relative = safeEntryPath(entry.name)
      if (relative === null) continue
      files.push({ ...entry, relative })
    }
    if (files.length === 0) throw new ZipError('EMPTY', '压缩包里没有文件')
    await fsp.mkdir(destinationDir, { recursive: true })
    let done = 0
    for (const file of files) {
      if (signal && signal.aborted) throw new ZipError('ABORTED', '解压已取消')
      try {
        await extractEntry(handle, zipPath, destinationDir, file, signal)
      } catch (error) {
        if (error && error.name === 'AbortError') throw new ZipError('ABORTED', '解压已取消')
        throw error
      }
      done += 1
      if (onProgress) onProgress(done, files.length)
    }
    return { entries: files.length }
  } finally {
    await handle.close().catch(() => {})
  }
}

module.exports = {
  extract,
  withAsarDisabled,
  safeEntryPath,
  crc32,
  crc32Update,
  ZipError,
  METHOD_STORE,
  METHOD_DEFLATE,
}
