/**
 * `@any-listen/nodejs/tar` 的 Android 实现 → `TarPort`。
 *
 * 上游用 `tar` npm 包（依赖 node:zlib 的流式解包）。Android 侧改由 Kotlin
 * (Apache Commons Compress) 解包：更省内存，且扩展包可能含中文名/软链等
 * 需要与系统行为一致的文件。
 *
 * 注意：`unpack` 在扩展安装的热路径上（`extensionService/shared/index.ts:268`），
 * 调用方会 `catch` 后走「解包失败」分支，因此抛错语义必须清晰。
 */

import { ports } from '@porting/ports'

export interface UnpackOptions {
  strip?: number
  filter?: (filePath: string, entry: unknown) => boolean
  [key: string]: unknown
}

export const unpack = async (filePath: string, dist: string, opts: UnpackOptions = {}): Promise<void> => {
  if (opts.filter || opts.strip) {
    // Kotlin 侧的 tar 解包只支持整体解包；带过滤/去层级的调用目前不存在于上游。
    // 明确拒绝而不是静默忽略参数，避免行为与桌面版不一致。
    throw new Error('tar.unpack: options.filter / options.strip are not supported on Android')
  }
  await ports.tar.unpack(filePath, dist)
}

export const pack = async (dir: string, out: string): Promise<void> => ports.tar.pack(dir, out)

export default { unpack, pack }
