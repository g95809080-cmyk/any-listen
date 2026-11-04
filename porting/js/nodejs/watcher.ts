/**
 * `@any-listen/nodejs/watcher` 的 Android 实现 → `FileSystemPort.watch`。
 *
 * chokidar 在 Android 不可用（无 inotify 语义、权限模型不同），改由 Kotlin 侧
 * `FileObserver` / `ContentObserver` 实现，JS 只做事件转发。
 *
 * `options` 中的 `persistent` / `usePolling` / `ignorePermissionErrors` 在 Android 侧无意义，
 * 保留入参是为了让调用方（`musicList` 模块）零改动。
 */

import { isMusicFile } from '@porting/nodejs/music'
import { ports } from '@porting/ports'

export type FileAction = 'add' | 'change' | 'unlink'

export interface WatchOptions {
  recursive?: boolean
  persistent?: boolean
  usePolling?: false | { interval?: number; binaryInterval?: number }
  ignorePermissionErrors?: boolean
}

export const watchMusicDir = (
  dir: string,
  callback: (action: FileAction, path: string, ctimeMs?: number, mtimeMs?: number, size?: number) => void,
  onReady: () => void,
  onError: (message: string) => void,
  options: WatchOptions = {}
): (() => Promise<void>) => {
  let subscriptionId: string | null = null
  let closed = false

  void ports.fs
    .watch(
      dir,
      { recursive: options.recursive ?? false, extFilter: [] },
      (event) => {
        if (closed) return
        // 与上游 chokidar 的 `ignored` 回调等价：非音乐文件不回调
        if (event.action !== 'unlink' && !isMusicFile(event.path, true)) return
        callback(event.action, event.path, event.ctimeMs, event.mtimeMs, event.size)
      },
      () => {
        if (!closed) onReady()
      },
      (message) => {
        if (!closed) onError(message)
      }
    )
    .then((id) => {
      subscriptionId = id
      if (closed) void ports.fs.unwatch(id)
    })
    .catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err))
    })

  return async () => {
    closed = true
    if (subscriptionId) await ports.fs.unwatch(subscriptionId)
    subscriptionId = null
  }
}

export default { watchMusicDir }
