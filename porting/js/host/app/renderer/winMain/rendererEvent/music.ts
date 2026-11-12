import { appState } from '@/app/app'
import { getLyricInfo, getMusicPic, getMusicUrl } from '@/app/modules/music'
import { workers } from '@/app/worker'
import { buildMusicCacheId } from '@any-listen/common/tools'

import type { ExposeClientFunctions } from '@/app/renderer/winMain/rendererEvent'

// 暴露给前端的方法
export const createExposeMusic = () => {
  const expose = {
    async getMusicUrl(event, info) {
      return getMusicUrl(info)
    },
    async getMusicUrlCount(event) {
      return workers.dbService.musicUrlCount()
    },
    async clearMusicUrl(event) {
      return workers.dbService.musicUrlClear()
    },

    async getMusicPic(event, info) {
      return getMusicPic(info)
    },

    async getMusicLyric(event, info) {
      return getLyricInfo(info)
    },
    async setMusicLyric(event, id, info) {
      return workers.dbService.editedLyricSave(id, info)
    },
    async removeMusicLyric(event, id) {
      return workers.dbService.editedLyricRemove([id])
    },
    async getMusicLyricCount(event) {
      return workers.dbService.rawLyricCount()
    },
    async clearMusicLyric(event) {
      return workers.dbService.rawLyricClear()
    },
    async createLocalMusicInfos(event, paths) {
      return workers.utilService.createLocalMusicInfos(paths, appState.machineId, true)
    },
  } satisfies Partial<ExposeClientFunctions>

  return {
    ...expose,
    /**
     * 只读取已经保存的 `music_url`，不调用音源扩展。
     *
     * 同一歌曲可能在不同音质下各有一份缓存；按当前可用音质逐一查映射，找到任意
     * 一份即可由界面继续确认正式缓存文件是否完整存在。
     */
    async getCachedMusicUrls(
      _event: unknown,
      musicInfo: AnyListen.Music.MusicInfo,
      quality?: string
    ): Promise<string[]> {
      const qualities = new Set([
        quality ?? appState.appSetting['player.playQuality'],
        ...('qualitys' in musicInfo.meta ? Object.keys(musicInfo.meta.qualitys ?? {}) : []),
      ])
      const urls = await Promise.all(
        [...qualities]
          .filter((targetQuality): targetQuality is string => Boolean(targetQuality))
          .map((targetQuality) => workers.dbService.getMusicUrl(buildMusicCacheId(musicInfo, targetQuality)))
      )
      return [...new Set(urls.filter((url): url is string => Boolean(url)))]
    },
  }
}
