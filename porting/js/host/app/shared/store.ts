/**
 * `@/app/shared/store` 的 Android 版。
 *
 * 与上游的差异：上游用 `fs.renameSync` 做损坏备份（同步 IO），这里是 fire-and-forget 的异步复制，
 * 并在文件未被 `preloadDir()` 预载时打警告 —— 因为我们的 `Store` 是「内存同步 + 异步落盘」，
 * 未预载就等于读到空设置，静默丢配置不可接受。
 */

import path from 'node:path'

import Store from '@any-listen/nodejs/Store'

import { appState } from '@/app/app'
import { log } from '@/app/shared/log'
import { isCached } from '@porting/nodejs/SafeFS'
import { ports } from '@porting/ports'

const stores = new Map<string, Store>()

export const getStore = (name: string, isIgnoredError = true, isShowErrorAlert = true): Store => {
  const existing = stores.get(name)
  if (existing) return existing

  const storePath = path.join(appState.dataPath, `${name}.json`)
  if (!isCached(storePath)) {
    log.warn(`[store] ${storePath} was not preloaded before getStore("${name}")`)
  }

  let store: Store
  try {
    store = new Store(storePath, false)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    if (!isIgnoredError) throw error

    const backupPath = `${storePath}.bak`
    void ports.fs.copy(storePath, backupPath).catch((copyErr: unknown) => {
      log.warn(`[store] backup failed: ${backupPath}`, copyErr)
    })
    if (isShowErrorAlert) {
      log.warn(`${name} data load error`)
      log.warn(`The broken ${name} file has been copied to: ${backupPath}\nError detail: ${error.message}`)
    }
    store = new Store(storePath, true)
  }

  stores.set(name, store)
  return store
}

export type { Store }
