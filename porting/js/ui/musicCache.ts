import { get, writable } from 'svelte/store'

import { ports } from '@porting/ports'
import { ipc } from '@ui/shared/ipc/ipc'

let proxyCacheDirPromise: Promise<string> | null = null

function getProxyCacheDir(): Promise<string> {
  proxyCacheDirPromise ??= ports.fs
    .getEnv()
    .then((env) => `${env.cachePath}/proxy`)
    .catch((error: unknown) => {
      proxyCacheDirPromise = null
      throw error
    })
  return proxyCacheDirPromise
}

function getProxyCacheName(url: string | null | undefined): string | null {
  return url?.match(/\/p_static\/([^/?#]+)(?:[?#]|$)/)?.[1] ?? null
}

interface MusicCacheIPC {
  getMusicUrl(info: {
    musicInfo: AnyListen.Music.MusicInfo
    isRefresh?: boolean
    quality?: string
  }): Promise<{ url: string; quality?: string }>
  getCachedMusicUrls(musicInfo: AnyListen.Music.MusicInfo): Promise<string[]>
}

export type MusicCacheTaskState = 'resolving' | 'queued' | 'downloading' | 'complete' | 'failed'

export interface MusicCacheTask {
  state: MusicCacheTaskState
  downloaded: number
  total: number
  error: string | null
  quality?: string
}

export interface PlaylistCacheTask {
  listId: string
  total: number
  completed: number
  cached: number
  downloaded: number
  failed: number
  active: boolean
  failedIds: string[]
}

export interface CacheMusicResult {
  state: 'cached' | 'downloaded' | 'failed'
  error?: string
}

const emptyTask: MusicCacheTask = {
  state: 'queued',
  downloaded: 0,
  total: -1,
  error: null,
}

export const musicCacheStore = writable<Record<string, MusicCacheTask>>({})
export const playlistCacheStore = writable<Record<string, PlaylistCacheTask>>({})

const activeMusicCaches = new Map<string, Promise<CacheMusicResult>>()
const activePlaylistCaches = new Map<string, Promise<void>>()

function updateMusicTask(id: string, patch: Partial<MusicCacheTask>): void {
  musicCacheStore.update((tasks) => ({
    ...tasks,
    [id]: {
      ...emptyTask,
      ...tasks[id],
      ...patch,
    },
  }))
}

export function getMusicCacheTask(id: string): MusicCacheTask | undefined {
  return get(musicCacheStore)[id]
}

function showCacheToast(message: string): void {
  ports.notification.showToast(message)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await ports.fs.stat(path)
    return stat?.isFile === true && stat.size > 0
  } catch {
    return false
  }
}

/**
 * 在线歌曲只有完整代理缓存落盘后才会被标记为可离线播放。
 *
 * `music_url` 保存的是 `/p_static/<虚拟文件名>`；Kotlin 侧在完整下载结束后才把
 * 临时 `.part` 原子改名为正式文件，因此这里检查正式文件即可，不需要读取音频。
 */
export async function hasCompleteMusicCache(musicInfo: AnyListen.Music.MusicInfo): Promise<boolean> {
  const urls = await (ipc as unknown as MusicCacheIPC).getCachedMusicUrls(musicInfo)
  const names = urls.map(getProxyCacheName).filter((name): name is string => Boolean(name))
  if (!names.length) return false

  const cacheDir = await getProxyCacheDir()
  const states = await Promise.all([...new Set(names)].map((name) => fileExists(`${cacheDir}/${name}`)))
  const complete = states.some(Boolean)
  if (complete) {
    // 冷启动时任务表是空的；列表已完成文件探测后同步回 store，让长按菜单也能
    // 立即显示禁用的“已缓存”，不必先点一次再依赖 cacheMusic() 去重。
    updateMusicTask(musicInfo.id, {
      state: 'complete',
      downloaded: 0,
      total: 0,
      error: null,
    })
  }
  return complete
}

async function runMusicCache(
  musicInfo: AnyListen.Music.MusicInfo,
  notify: boolean
): Promise<CacheMusicResult> {
  const id = musicInfo.id
  try {
    if (await hasCompleteMusicCache(musicInfo)) {
      updateMusicTask(id, {
        state: 'complete',
        error: null,
      })
      if (notify) showCacheToast('已缓存，可离线播放')
      return { state: 'cached' }
    }

    updateMusicTask(id, {
      state: 'resolving',
      downloaded: 0,
      total: -1,
      error: null,
    })

    // 强制重新解析一次，确保进程重启或旧音源地址失效后，Kotlin 侧仍有可下载目标。
    const musicUrl = await (ipc as unknown as MusicCacheIPC).getMusicUrl({
      musicInfo,
      isRefresh: true,
    })
    const name = getProxyCacheName(musicUrl.url)
    if (!name) throw new Error('当前音源没有返回可缓存的代理地址')

    updateMusicTask(id, {
      state: 'queued',
      quality: musicUrl.quality,
    })
    const result = await ports.http.cacheProxyTarget(name, (status) => {
      updateMusicTask(id, {
        state: status.state,
        downloaded: status.downloaded,
        total: status.total,
        error: status.error,
        quality: musicUrl.quality,
      })
    })

    if (result.state === 'complete') {
      updateMusicTask(id, {
        state: 'complete',
        downloaded: result.downloaded,
        total: result.total,
        error: null,
      })
      if (notify) showCacheToast('缓存完成，可离线播放')
      return { state: 'downloaded' }
    }

    updateMusicTask(id, {
      state: 'failed',
      downloaded: result.downloaded,
      total: result.total,
      error: result.error,
    })
    if (notify) showCacheToast('缓存失败，请检查网络后重试')
    return { state: 'failed', error: result.error ?? undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateMusicTask(id, {
      state: 'failed',
      error: message,
    })
    if (notify) showCacheToast('缓存失败，请检查网络后重试')
    return { state: 'failed', error: message }
  }
}

export function cacheMusic(
  musicInfo: AnyListen.Music.MusicInfo,
  options: { notify?: boolean } = {}
): Promise<CacheMusicResult> {
  if (musicInfo.isLocal) return Promise.resolve({ state: 'cached' })

  const current = activeMusicCaches.get(musicInfo.id)
  if (current) return current

  const task = runMusicCache(musicInfo, options.notify ?? false).finally(() => {
    if (activeMusicCaches.get(musicInfo.id) === task) activeMusicCaches.delete(musicInfo.id)
  })
  activeMusicCaches.set(musicInfo.id, task)
  return task
}

function uniqueMusic(list: AnyListen.Music.MusicInfo[]): AnyListen.Music.MusicInfo[] {
  return [...new Map(list.map((musicInfo) => [musicInfo.id, musicInfo])).values()]
}

export function cachePlaylist(listId: string, list: AnyListen.Music.MusicInfo[]): Promise<void> {
  const active = activePlaylistCaches.get(listId)
  if (active) return active

  const items = uniqueMusic(list).filter((musicInfo) => !musicInfo.isLocal)
  if (!items.length) return Promise.resolve()

  const failedIds = new Set<string>()
  let completed = 0
  let cached = 0
  let downloaded = 0
  let failed = 0
  let cursor = 0

  playlistCacheStore.update((tasks) => ({
    ...tasks,
    [listId]: {
      listId,
      total: items.length,
      completed: 0,
      cached: 0,
      downloaded: 0,
      failed: 0,
      active: true,
      failedIds: [],
    },
  }))

  const run = (async () => {
    const worker = async (): Promise<void> => {
      while (cursor < items.length) {
        const musicInfo = items[cursor++]
        const result = await cacheMusic(musicInfo)
        completed++
        if (result.state === 'cached') cached++
        else if (result.state === 'downloaded') downloaded++
        else {
          failed++
          failedIds.add(musicInfo.id)
        }
        playlistCacheStore.update((tasks) => ({
          ...tasks,
          [listId]: {
            listId,
            total: items.length,
            completed,
            cached,
            downloaded,
            failed,
            active: completed < items.length,
            failedIds: [...failedIds],
          },
        }))
      }
    }

    await Promise.all(Array.from({ length: Math.min(2, items.length) }, () => worker()))
    playlistCacheStore.update((tasks) => ({
      ...tasks,
      [listId]: {
        listId,
        total: items.length,
        completed,
        cached,
        downloaded,
        failed,
        active: false,
        failedIds: [...failedIds],
      },
    }))
  })().finally(() => {
    if (activePlaylistCaches.get(listId) === run) activePlaylistCaches.delete(listId)
  })

  activePlaylistCaches.set(listId, run)
  return run
}

export function retryFailedPlaylistCache(
  listId: string,
  list: AnyListen.Music.MusicInfo[]
): Promise<void> {
  const failedIds = new Set(get(playlistCacheStore)[listId]?.failedIds ?? [])
  return cachePlaylist(
    listId,
    list.filter((musicInfo) => failedIds.has(musicInfo.id))
  )
}
