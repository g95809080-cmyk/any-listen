/**
 * `@/app/modules/fileSystem` 的 Android 版。
 *
 * 与 web-server 版的核心差异（§9.3）：
 * 1. 没有 `allowPublicDir` 配置概念：Android 主方案 `MANAGE_EXTERNAL_STORAGE` 下整机可读，
 *    白名单只用于「扩展目录」这类需要越权校验的场景。
 * 2. `read_root_dir` 返回真实绝对路径（外部存储根）。**不能返回「内部存储」这类显示名** ——
 *    上游把 `File.name` 兼职当路径用，详见 `getRootDirs()` 的注释。
 * 3. `read_dir` 走 `FileSystemPort.listTree(maxDepth: 1)`（复用批量接口，不新增 Port 方法）。
 * 4. 播放/图片 URL 由 `FileSystemPort.toPlayableUrl` 产出
 *    （`http://127.0.0.1:<PORT>/stream/<sha256>.<ext>`，与 SPA 同源 → AudioWorklet 可用）。
 */

import path from 'node:path'

import { MEDIA_FILE_TYPES, PIC_FILE_TYPES } from '@any-listen/common/constants'
import { extname, joinPath, normalizePath } from '@any-listen/nodejs'

import { appState } from '@/app/app/state'
import { ports } from '@porting/ports'

/**
 * 根目录列表（UI 的文件浏览入口）。
 *
 * ⚠️ **`name` 必须是真实绝对路径，不能下发「内部存储」这类显示名。**
 *
 * `AnyListen.FileSystem.File` 只有 `name` / `isFile` 两个字段，上游把 `name` 兼职当路径用：
 * `web-server/src/app/modules/fileSystem/index.ts:85-90` 的 `readRootDir()` 返回的就是绝对路径。
 * UI 侧 `material/fileExplorerModal/shared.ts:47-52` 的 `buildFilesPath('', [file])` 直接拿
 * `file.name` 当路径，`Open.svelte` 再 `gotoDir(...)` → `readDir(file.name)`。
 * 下发显示名的后果：`read_dir` 收到 `'内部存储'` 这种相对路径 → **导入音乐在第一层就失败**。
 *
 * 显示名与路径分离（给类型加 `path` 字段）要改 `source/packages/shared/types`，违反零改上游，
 * 所以这里先接受 UI 第一层显示 `/storage/emulated/0`，后续再用覆写文件浏览器的方式做展示层映射。
 */
export const getRootDirs = async (): Promise<Array<{ name: string; isFile: boolean }>> => {
  const env = await ports.fs.getEnv()
  const roots: Array<{ name: string; isFile: boolean }> = []
  if (env.externalRoot) roots.push({ name: env.externalRoot, isFile: false })
  return roots
}

export const checkAllowPath = (filePath: string, allowedDirs: string[] = []): boolean => {
  if (!filePath.length || filePath.length > 1024) return false
  const withSep = filePath.endsWith(path.sep) ? filePath : `${filePath}${path.sep}`
  const normalized = normalizePath(withSep)
  if (!allowedDirs.length) return true
  return allowedDirs.some((dir) => normalized.startsWith(dir))
}

export const checkAllowPathError = (filePath: string, allowedDirs: string[] = []): void => {
  if (checkAllowPath(filePath, allowedDirs)) return
  throw new Error(`Not allow path: ${filePath}`)
}

/** 媒体文件 → 可播放 URL（同源 loopback HTTP，支持 Range） */
export const createMediaPublicPath = async (filePath: string): Promise<string | undefined> => {
  const extName = extname(filePath).substring(1) as (typeof MEDIA_FILE_TYPES)[number]
  if (!MEDIA_FILE_TYPES.includes(extName)) return undefined
  const url = await ports.fs.toPlayableUrl(filePath)
  return url ?? undefined
}

export const createExtensionIconPublicPath = async (extDir: string, filePath: string): Promise<string> => {
  checkAllowPathError(filePath, [extDir])
  const extName = extname(filePath).substring(1)
  if (!PIC_FILE_TYPES.includes(extName.toLowerCase() as (typeof PIC_FILE_TYPES)[number])) {
    throw new Error(`Not allow file type: ${extName}`)
  }
  const url = await ports.fs.toPlayableUrl(filePath)
  return url ?? ''
}

export const removeExtensionIconPublicPath = async (filePath: string): Promise<void> => {
  const url = await ports.fs.toPlayableUrl(filePath).catch(() => null)
  if (url) await ports.fs.revokePlayableUrl(url)
}

/** 图片文件 → URL；`rawPath` 仅用于缓存键，与桌面版语义一致 */
export const createPicPublicPath = async (rawPath: string, filePath: string, allowedDirs: string[] = []): Promise<string | null> => {
  checkAllowPathError(filePath, allowedDirs)
  const format = extname(filePath).substring(1)
  if (!PIC_FILE_TYPES.includes(format as (typeof PIC_FILE_TYPES)[number])) return null
  const url = await ports.fs.toPlayableUrl(filePath)
  return url
}

/** 内嵌封面（字节）→ 写临时文件 → 返回 URL */
export const createPicFilePublicPath = async (
  rawPath: string,
  format: string,
  file: Uint8Array,
  allowedDirs: string[] = []
): Promise<string | null> => {
  if (!PIC_FILE_TYPES.includes(format as (typeof PIC_FILE_TYPES)[number])) return null
  checkAllowPathError(rawPath, allowedDirs)
  const fileName = `${await (await import('@any-listen/nodejs')).toSha256(rawPath)}.${format}`
  const filePath = joinPath(appState.tempDataPath, fileName)
  await ports.fs.writeFile(filePath, file)
  const url = await ports.fs.toPlayableUrl(filePath)
  return url
}

const readDir = async (filePath: string, isDirOnly = false, fileFilter: string[] = []): Promise<AnyListen.FileSystem.File[]> => {
  const entries: AnyListen.FileSystem.File[] = []
  await ports.fs.listTree(filePath, { maxDepth: 0 }, (batch) => {
    for (const entry of batch) {
      entries.push({ name: entry.name, isFile: entry.isFile })
    }
  })
  if (isDirOnly) return entries.filter((entry) => !entry.isFile)
  const normalizedFilter = fileFilter.map((item) => item.trim()).filter(Boolean)
  if (!normalizedFilter.length) return entries
  return entries.filter((entry) => !entry.isFile || normalizedFilter.includes(extname(entry.name).substring(1)))
}

export const fileSystemAction = async <T extends keyof AnyListen.FileSystem.Actions>(
  action: AnyListen.FileSystem.Actions[T][0]
): Promise<AnyListen.FileSystem.Actions[T][1]> => {
  switch (action.action) {
    case 'read_root_dir':
      return (await getRootDirs()) as AnyListen.FileSystem.Actions[T][1]
    case 'read_dir':
      return (await readDir(action.data.path, action.data.isDirOnly, action.data.fileFilter)) as AnyListen.FileSystem.Actions[T][1]
    case 'rename':
      await ports.fs.rename(action.data.path, action.data.newPath)
      return undefined as AnyListen.FileSystem.Actions[T][1]
    case 'create_dir':
      await ports.fs.mkdirp(joinPath(action.data.path, action.data.name))
      return joinPath(action.data.path, action.data.name) as AnyListen.FileSystem.Actions[T][1]
  }
}
