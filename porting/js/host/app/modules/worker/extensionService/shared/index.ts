/**
 * `extensionService/shared` 的 Android 薄包装。
 *
 * 上游 `updateExtensionSettings()` 是两次独立的 `await`：
 * `getConfig()` → 合并补丁 → `saveConfig()`。两个并发请求会读到同一份旧配置，
 * 各自覆盖完整对象，后写者把前一个字段丢掉。Android 的 Store 虽然是内存同步 +
 * 异步落盘，但这个读改写窗口仍存在，因此按扩展 ID 串行调用上游原函数。
 *
 * 队列只解决**同一扩展**的更新顺序；不同扩展各用一条队列，互不阻塞。失败后
 * 下一条仍会继续，不会把整个扩展的配置写入永久卡死。
 *
 * `@any-listen/app/.../shared/index` 是 Vite 的包级别名（直指上游 `source/packages`），
 * 不会命中本文件的相对导入覆写，因此这里拿到的是真正的上游实现。上游源码内部对
 * `./shared` / `../shared` 的引用会命中覆写并进入本包装；当前没有绝对路径形式的
 * `@any-listen/app/.../shared` 导入，避免了两套实例。
 */

export * from '@any-listen/app/modules/worker/extensionService/shared/index'
import { updateExtensionSettings as updateExtensionSettingsRaw } from '@any-listen/app/modules/worker/extensionService/shared/index'

const updateQueues = new Map<string, Promise<void>>()

export const updateExtensionSettings = async (
  id: string,
  config: Record<string, unknown>,
): Promise<void> => {
  const previous = updateQueues.get(id)
  const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() =>
    updateExtensionSettingsRaw(id, config)
  )
  updateQueues.set(id, run)
  try {
    await run
  } finally {
    if (updateQueues.get(id) === run) updateQueues.delete(id)
  }
}
