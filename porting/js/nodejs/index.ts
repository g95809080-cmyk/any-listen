/**
 * `@any-listen/nodejs`（根入口）的 Android 覆写。
 *
 * 策略：**能沿用的一律沿用上游**（`export * from` 到 `@any-listen/nodejs/uplink`，
 * 该 alias 指回上游原始 `index.ts`，不会递归）。上游 27 个 API 里绝大多数只是
 * `node:path` / `node:crypto` / `node:zlib` 的薄封装，而这些模块已经被 `shims/` 换成
 * 纯 Web 实现，因此可以直接复用，避免"抄一遍上游再慢慢对齐"的漂移风险。
 *
 * 只覆盖 4 个在 WebView 里**语义上不成立**的函数：
 * - `fileSha256`：上游用 `fs.createReadStream` 流式读，WebView 无流式文件句柄
 * - `createDirSync` / `checkAndCreateDirSync`：同步建目录（违反 Port 全异步约束）
 * - `getPlatform` / `getOSVersion` / `getNativeName`：桌面语义的返回值
 *
 * ESM 语义：显式本地导出会遮蔽 `export *` 的同名导出，因此下面每个函数都是"最终版本"。
 */

import { createHash } from '@porting/shims/crypto'
import { readFile } from '@porting/shims/fs-promises'
import { PortError } from '@porting/ports/types'

export * from '@any-listen/nodejs/uplink'

/* ------------------------------------------------------------------ *
 * 显式覆盖
 * ------------------------------------------------------------------ */

/**
 * 文件 sha256。上游是 `createReadStream` 流式累加；这里退化为「整读 + 增量 hash」。
 *
 * 只被 `shared/app/modules/worker/extensionService/shared/index.ts` 用于校验扩展包的
 * `.alix` 完整性，包体通常在几 MB 量级，整读可接受；> 64MB 的包请走 `FileSystemPort.readFile(range)`
 * 分段（该场景在自用场景下不存在，因此不预先实现）。
 */
export const fileSha256 = async (filePath: string): Promise<string> => {
  const buffer = await readFile(filePath)
  return String(createHash('sha256').update(buffer).digest('hex'))
}

export const createDirSync = (path: string): never => {
  throw new PortError(
    'EUNSUPPORTED',
    `createDirSync("${path}") 在 Android 上不可用：同步 IO 会阻塞 UI 线程，请改用 checkAndCreateDir()（异步）`,
  )
}

export const checkAndCreateDirSync = (path: string): never => {
  throw new PortError(
    'EUNSUPPORTED',
    `checkAndCreateDirSync("${path}") 在 Android 上不可用：同步 IO 会阻塞 UI 线程，请改用 checkAndCreateDir()（异步）`,
  )
}

/**
 * 平台标识。桌面版返回 `windows|mac|linux`；Android 需要独立取值，
 * 否则 UI 会走到「桌面」分支（如快捷键设置页）。
 */
export const getPlatform = (platform: string = process.platform): 'windows' | 'mac' | 'linux' | 'android' => {
  switch (platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'mac'
    case 'android':
      return 'android'
    default:
      return 'linux'
  }
}

/** `os.release()` 在 Android 上是内核版本，主版本号即 Android 版本（如 `5.15.78` → 15）时不可靠，直接取 Kotlin 上报值 */
export const getOSVersion = (): string => globalThis.__anylisten_os_version__ ?? '0'

/** 桌面版用于拼 `better_sqlite3.node` 的路径；Android 走 sql.js WASM，没有原生模块 */
export const getNativeName = (): string => 'android_arm64_v0'
