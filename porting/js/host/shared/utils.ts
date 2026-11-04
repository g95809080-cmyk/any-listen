/**
 * `@/shared/utils` 的 Android 替身。
 *
 * 上游是 `checkAndCreateDirSync`（同步）+ `process.exit`。两者在 Worker 内都不可用，
 * 因此改为异步建目录；`exit()` 只记日志并抛错（调用点均为不可恢复的启动错误）。
 */

import { checkAndCreateDir as checkAndCreateDirAsync, removePath } from '@any-listen/nodejs'

export * from '@any-listen/nodejs'

export const exit = (message: string): never => {
  throw new Error(`[fatal] ${message}`)
}

export const checkAndCreateDir = (path: string): void => {
  // 调用方（app/modules/index.ts）在同步上下文里调用它；这里排队异步建目录，
  // 真正的 mkdir 由 bootstrap 的 ensureDataDirs() 在模块初始化前完成，避免竞态。
  void checkAndCreateDirAsync(path).catch((err: unknown) => {
    console.error(`[host] checkAndCreateDir failed: ${path}`, err)
  })
}

export { removePath }
