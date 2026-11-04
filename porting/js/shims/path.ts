/**
 * `node:path` 替身 —— **POSIX 语义**。
 *
 * Android 的 `FileSystemPort` 只暴露 `/data/data/...`、`/storage/emulated/0/...` 这类 POSIX 路径，
 * 因此这里必须实现 posix 版本而不是 win32。`path.sep` 恒为 `/`，
 * 这也是 D4（MANAGE_EXTERNAL_STORAGE 真实路径）能与桌面 `meta.filePath` 语义保持一致的前提。
 */

const CHAR_DOT = 46
const CHAR_FORWARD_SLASH = 47

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string. Received ${String(path)}`)
  }
}

function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = ''
  let lastSegmentLength = 0
  let lastSlash = -1
  let dots = 0
  let code = 0
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i)
    else if (code === CHAR_FORWARD_SLASH) break
    else code = CHAR_FORWARD_SLASH

    if (code === CHAR_FORWARD_SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== CHAR_DOT ||
          res.charCodeAt(res.length - 2) !== CHAR_DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/')
            if (lastSlashIndex === -1) {
              res = ''
              lastSegmentLength = 0
            } else {
              res = res.slice(0, lastSlashIndex)
              lastSegmentLength = res.length - 1 - res.lastIndexOf('/')
            }
            lastSlash = i
            dots = 0
            continue
          } else if (res.length !== 0) {
            res = ''
            lastSegmentLength = 0
            lastSlash = i
            dots = 0
            continue
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..'
          lastSegmentLength = 2
        }
      } else {
        if (res.length > 0) res += `/${path.slice(lastSlash + 1, i)}`
        else res = path.slice(lastSlash + 1, i)
        lastSegmentLength = i - lastSlash - 1
      }
      lastSlash = i
      dots = 0
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots
    } else {
      dots = -1
    }
  }
  return res
}

export function normalize(path: string): string {
  assertPath(path)
  if (path.length === 0) return '.'
  const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH
  path = normalizeString(path, !isAbsolute)
  if (path.length === 0) {
    if (isAbsolute) return '/'
    return trailingSeparator ? './' : '.'
  }
  if (trailingSeparator) path += '/'
  return isAbsolute ? `/${path}` : path
}

export function isAbsolute(path: string): boolean {
  assertPath(path)
  return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH
}

export function join(...args: string[]): string {
  if (args.length === 0) return '.'
  let joined: string | undefined
  for (const arg of args) {
    assertPath(arg)
    if (arg.length > 0) joined = joined === undefined ? arg : `${joined}/${arg}`
  }
  return joined === undefined ? '.' : normalize(joined)
}

export function resolve(...args: string[]): string {
  let resolvedPath = ''
  let resolvedAbsolute = false
  for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? args[i]! : '/'
    assertPath(path)
    if (path.length === 0) continue
    resolvedPath = `${path}/${resolvedPath}`
    resolvedAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute)
  if (resolvedAbsolute) return `/${resolvedPath}`
  return resolvedPath.length > 0 ? resolvedPath : '.'
}

export function relative(from: string, to: string): string {
  assertPath(from)
  assertPath(to)
  if (from === to) return ''
  from = resolve(from)
  to = resolve(to)
  if (from === to) return ''

  const fromStart = 1
  const fromEnd = from.length
  const fromLen = fromEnd - fromStart
  const toStart = 1
  const toLen = to.length - toStart

  const length = fromLen < toLen ? fromLen : toLen
  let lastCommonSep = -1
  let i = 0
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i)
    if (fromCode !== to.charCodeAt(toStart + i)) break
    else if (fromCode === CHAR_FORWARD_SLASH) lastCommonSep = i
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) return to.slice(toStart + i + 1)
      if (i === 0) return to.slice(toStart + i)
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) lastCommonSep = i
      else if (i === 0) lastCommonSep = 0
    }
  }
  let out = ''
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      out += out.length === 0 ? '..' : '/..'
    }
  }
  return `${out}${to.slice(toStart + lastCommonSep)}`
}

export function dirname(path: string): string {
  assertPath(path)
  if (path.length === 0) return '.'
  const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  if (hasRoot && end === 1) return '//'
  return path.slice(0, end)
}

export function basename(path: string, ext?: string): string {
  assertPath(path)
  if (ext !== undefined) assertPath(ext)
  let start = 0
  let end = -1
  let matchedSlash = true
  if (ext !== undefined && ext.length > 0 && ext.length <= path.length) {
    if (ext === path) return ''
    let extIdx = ext.length - 1
    let firstNonSlashEnd = -1
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i)
      if (code === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1
          break
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false
          firstNonSlashEnd = i + 1
        }
        if (extIdx >= 0) {
          if (code === ext.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i
          } else {
            extIdx = -1
            end = firstNonSlashEnd
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd
    else if (end === -1) end = path.length
    return path.slice(start, end)
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  return end === -1 ? '' : path.slice(start, end)
}

export function extname(path: string): string {
  assertPath(path)
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  let preDotState = 0
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i)
    if (code === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === CHAR_DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return ''
  }
  return path.slice(startDot, end)
}

export interface ParsedPath {
  root: string
  dir: string
  base: string
  ext: string
  name: string
}

export function parse(path: string): ParsedPath {
  assertPath(path)
  const ret: ParsedPath = { root: '', dir: '', base: '', ext: '', name: '' }
  if (path.length === 0) return ret
  const isAbs = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  if (isAbs) {
    ret.root = '/'
    path = path.slice(1)
  }
  const ext = extname(path)
  const base = basename(path)
  ret.ext = ext
  ret.base = base
  ret.name = ext ? base.slice(0, base.length - ext.length) : base
  const dir = dirname(isAbs ? `/${path}` : path)
  ret.dir = dir === '/' && isAbs ? '/' : dir
  return ret
}

export function format(p: Partial<ParsedPath>): string {
  const dir = p.dir || p.root || ''
  const base = p.base || `${p.name ?? ''}${p.ext ?? ''}`
  if (!dir) return base
  return dir === p.root ? `${dir}${base}` : `${dir}/${base}`
}

export const sep = '/'
export const delimiter = ':'

const posix = { normalize, isAbsolute, join, resolve, relative, dirname, basename, extname, parse, format, sep, delimiter }
export const win32 = posix

export default posix
