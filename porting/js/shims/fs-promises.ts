/**
 * `node:fs/promises` 替身 → FileSystemPort。
 *
 * 三条硬约束：
 * 1. **全部异步**：Worker 内无法同步触达原生，本文件不提供任何 Sync 变体。
 * 2. 错误必须是 `NodeJS.ErrnoException` 形态（带 `code`/`syscall`/`path`），
 *    因为上游 `manage.ts:36`、`index.ts:63` 依赖 `e.code != 'ENOENT'` 做分支。
 * 3. 不吞异常：除 `remove`/`unlink` 之外不 catch。上游自己会用 `.catch()`。
 */

import { Buffer } from '@porting/shims/buffer'
import { ports, PortError, type FsEntry, type FsStat } from '@porting/ports'

export type PathLike = string | Buffer | URL
export type BinaryLike = string | Uint8Array

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_TRUNC: 512,
  O_APPEND: 1024,
} as const

export interface Stats {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  ctimeMs: number
  mtimeMs: number
}

export interface Dirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface ReadFileOptions {
  encoding?: BufferEncoding | null
  flag?: string
}

export interface WriteFileOptions {
  encoding?: BufferEncoding | null
  mode?: number
  flag?: string
}

export interface ReaddirOptions {
  withFileTypes?: boolean
  encoding?: BufferEncoding
}

export interface MkdirOptions {
  recursive?: boolean
  mode?: number
}

export interface RmOptions {
  recursive?: boolean
  force?: boolean
  maxRetries?: number
}

function toPath(p: PathLike): string {
  if (typeof p === 'string') return p
  if (Buffer.isBuffer(p)) return p.toString()
  if (p instanceof URL) return p.pathname
  throw new TypeError(`invalid path: ${String(p)}`)
}

/** 把 PortError 翻译成 NodeJS.ErrnoException 形态 */
export function toErrnoException(err: unknown, syscall: string, path: string): Error {
  if (err instanceof PortError) {
    const error = new Error(`${err.code}: ${err.message}, ${syscall} '${path}'`) as Error & {
      code?: string
      syscall?: string
      path?: string
      errno?: number
    }
    error.code = err.code
    error.syscall = syscall
    error.path = path
    return error
  }
  const fallback = err instanceof Error ? err : new Error(String(err))
  const error = fallback as Error & { code?: string; syscall?: string; path?: string }
  error.code ??= 'EUNKNOWN'
  error.syscall ??= syscall
  error.path ??= path
  return error
}

function wrapStats(stat: FsStat): Stats {
  return {
    isFile: () => stat.isFile,
    isDirectory: () => stat.isDirectory,
    isSymbolicLink: () => false,
    size: stat.size,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
  }
}

function wrapDirent(entry: FsEntry): Dirent {
  return {
    name: entry.name,
    isFile: () => entry.isFile,
    isDirectory: () => entry.isDirectory,
    isSymbolicLink: () => false,
  }
}

function decode(data: Uint8Array, encoding?: BufferEncoding | null): string | Buffer {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (encoding == null) return buf
  return buf.toString(encoding)
}

function encode(data: BinaryLike, encoding?: BufferEncoding | null): Uint8Array {
  if (typeof data !== 'string') return data
  const buf = Buffer.from(data, encoding ?? 'utf8')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/* ------------------------------- 实现 ------------------------------- */

export async function access(path: PathLike, _mode?: number): Promise<void> {
  const target = toPath(path)
  const exists = await ports.fs.exists(target).catch((err: unknown) => {
    throw toErrnoException(err, 'access', target)
  })
  if (!exists) throw toErrnoException(new PortError('ENOENT', 'no such file or directory'), 'access', target)
}

export async function stat(path: PathLike): Promise<Stats> {
  const target = toPath(path)
  const result = await ports.fs.stat(target).catch((err: unknown) => {
    throw toErrnoException(err, 'stat', target)
  })
  if (!result) throw toErrnoException(new PortError('ENOENT', 'no such file or directory'), 'stat', target)
  return wrapStats(result)
}

export async function lstat(path: PathLike): Promise<Stats> {
  return stat(path)
}

export async function exists(path: PathLike): Promise<boolean> {
  return ports.fs.exists(toPath(path))
}

export async function readdir(path: PathLike, options?: ReaddirOptions): Promise<Dirent[] | string[]> {
  const target = toPath(path)
  const entries = await ports.fs.readdir(target).catch((err: unknown) => {
    throw toErrnoException(err, 'readdir', target)
  })
  if (options?.withFileTypes) return entries.map(wrapDirent)
  return entries.map((entry) => entry.name)
}

export async function readFile(path: PathLike, options?: BufferEncoding | ReadFileOptions): Promise<Buffer | string> {
  const target = toPath(path)
  const encoding = typeof options === 'string' ? options : (options?.encoding ?? null)
  const data = await ports.fs.readFile(target).catch((err: unknown) => {
    throw toErrnoException(err, 'readFile', target)
  })
  return decode(data, encoding)
}

export async function writeFile(
  path: PathLike,
  data: BinaryLike,
  options?: BufferEncoding | WriteFileOptions
): Promise<void> {
  const target = toPath(path)
  const encoding = typeof options === 'string' ? options : (options?.encoding ?? null)
  await ports.fs.writeFile(target, encode(data, encoding)).catch((err: unknown) => {
    throw toErrnoException(err, 'writeFile', target)
  })
}

export async function appendFile(
  path: PathLike,
  data: BinaryLike,
  options?: BufferEncoding | WriteFileOptions
): Promise<void> {
  const target = toPath(path)
  const encoding = typeof options === 'string' ? options : (options?.encoding ?? null)
  const text = typeof data === 'string' ? data : Buffer.from(data).toString(encoding ?? 'utf8')
  await ports.fs.appendFile(target, text).catch((err: unknown) => {
    throw toErrnoException(err, 'appendFile', target)
  })
}

export async function mkdir(path: PathLike, options?: MkdirOptions): Promise<string | undefined> {
  const target = toPath(path)
  if (options?.recursive) {
    await ports.fs.mkdirp(target).catch((err: unknown) => {
      throw toErrnoException(err, 'mkdir', target)
    })
    return target
  }
  const alreadyExists = await ports.fs.exists(target)
  if (alreadyExists) throw toErrnoException(new PortError('EEXIST', 'file already exists'), 'mkdir', target)
  await ports.fs.mkdirp(target).catch((err: unknown) => {
    throw toErrnoException(err, 'mkdir', target)
  })
  return undefined
}

export async function rm(path: PathLike, options?: RmOptions): Promise<void> {
  const target = toPath(path)
  const recursive = options?.recursive ?? false
  await ports.fs.remove(target, recursive).catch((err: unknown) => {
    if (err instanceof PortError && err.code === 'ENOENT' && options?.force) return
    throw toErrnoException(err, 'rm', target)
  })
}

export async function unlink(path: PathLike): Promise<void> {
  const target = toPath(path)
  await ports.fs.remove(target, false).catch((err: unknown) => {
    throw toErrnoException(err, 'unlink', target)
  })
}

export async function rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
  const from = toPath(oldPath)
  const to = toPath(newPath)
  const ok = await ports.fs.rename(from, to).catch((err: unknown) => {
    throw toErrnoException(err, 'rename', from)
  })
  if (!ok) throw toErrnoException(new PortError('EIO', 'rename failed'), 'rename', from)
}

export async function cp(src: PathLike, dest: PathLike, _options?: { recursive?: boolean }): Promise<void> {
  const from = toPath(src)
  const to = toPath(dest)
  await ports.fs.copy(from, to).catch((err: unknown) => {
    throw toErrnoException(err, 'cp', from)
  })
}

export async function copyFile(src: PathLike, dest: PathLike): Promise<void> {
  return cp(src, dest)
}

export async function realpath(path: PathLike): Promise<string> {
  const target = toPath(path)
  return ports.fs.realpath(target).catch((err: unknown) => {
    throw toErrnoException(err, 'realpath', target)
  })
}

export default {
  constants,
  access,
  stat,
  lstat,
  exists,
  readdir,
  readFile,
  writeFile,
  appendFile,
  mkdir,
  rm,
  unlink,
  rename,
  cp,
  copyFile,
  realpath,
}
