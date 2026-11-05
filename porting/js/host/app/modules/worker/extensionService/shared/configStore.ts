/**
 * 扩展配置 Store 的 Android 覆写。
 *
 * 上游 `configStore.saveConfig()` 只调用同步的 `store.override()`；Android 的 Store
 * 实际是「同步内存 + 异步原子落盘」，如果这里不等待 flush，调用方返回时配置仍在
 * 300ms debounce 窗口里，ext worker 被销毁就会丢配置。
 *
 * - `getConfig`：先预载文件，覆盖运行期新安装/重装扩展，不依赖启动扫描时序。
 *   若预载期间配置被卸载（evict），会抛 `ESTALE`，不会把空缓存当成空配置返回。
 * - `saveConfig`：override 后等待该 Store 落盘；UI 与插件 API 都走 shared 的
 *   `updateExtensionSettings`，因此这一处覆盖了所有配置写入口。
 * - `unloadConfig`：连同 SafeFS 内存缓存一起失效，避免同 ID 卸载重装读回旧配置。
 */

import { extensionEvent } from '@any-listen/app/modules/worker/extensionService/event'

import Store from '@porting/nodejs/Store'
import { evictFile, preloadFile } from '@porting/nodejs/SafeFS'
import path from '@porting/shims/path'

const stores = new Map<string, Store>()

const getConfigPath = (extension: AnyListen.Extension.Extension): string =>
  path.join(extension.dataDirectory, 'configuration.json')

const getStore = (extension: AnyListen.Extension.Extension): Store => {
  let store = stores.get(extension.id)
  if (store) return store
  try {
    store = new Store(getConfigPath(extension), false, true)
  } catch (err) {
    extensionEvent.error(`init config store error: ${(err as Error).stack ?? (err as Error).message}`)
    store = new Store(extension.dataDirectory, true, true)
  }
  stores.set(extension.id, store)
  return store
}

export const getConfig = async (extension: AnyListen.Extension.Extension): Promise<Record<string, unknown>> => {
  await preloadFile(getConfigPath(extension))
  return getStore(extension).getAll<Record<string, unknown>>()
}

export const saveConfig = async (
  extension: AnyListen.Extension.Extension,
  config: Record<string, unknown>,
): Promise<void> => {
  await preloadFile(getConfigPath(extension))
  const store = getStore(extension)
  store.override(config)
  await store.flush()
}

export const unloadConfig = async (extension: AnyListen.Extension.Extension): Promise<void> => {
  stores.delete(extension.id)
  await evictFile(getConfigPath(extension))
}
