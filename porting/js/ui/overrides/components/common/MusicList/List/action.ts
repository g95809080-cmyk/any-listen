/**
 * 修复搜索页 `Play all` / `Shuffle` 的 `unsupported source`。
 *
 * 上游 `playOnlineList()` 在起播后无条件后台刷新列表，而刷新接口只支持
 * `songlist` / `topSongs`；搜索页的 `source: 'search'` 会在这里抛错。
 * 搜索结果是快照，不需要后台补全，因此搜索来源改走
 * `ui/player/searchPlayback.ts`，其余来源仍完全沿用上游实现。
 */
import {
  playMusic as playMusicRaw,
  playOnlineListMusic as playOnlineListMusicRaw,
} from '@ui-raw/components/common/MusicList/List/action'

import { playOnlineSearchList } from '@porting/ui/player/searchPlayback'

export * from '@ui-raw/components/common/MusicList/List/action'

export const playOnlineListMusic = async (
  listId: string,
  list: AnyListen.Music.MusicInfo[],
  musicInfo: AnyListen.Music.MusicInfo,
  source: AnyListen.Player.SourceType,
  metaInfo: import('@ui/modules/player/store/playerActions').OnlineListMetaInfo,
  isClianHistory?: boolean,
) => {
  if (source != 'search') {
    return playOnlineListMusicRaw(listId, list, musicInfo, source, metaInfo, isClianHistory)
  }

  const index = list.findIndex((music) => music.id == musicInfo.id)
  if (index < 0) return
  await playOnlineSearchList(listId, list, index, source, metaInfo, isClianHistory)
}

export const playMusic = async (
  listId: string,
  list: AnyListen.Music.MusicInfo[],
  musicInfo: AnyListen.Music.MusicInfo,
  source: AnyListen.Player.SourceType,
  metaInfo?: import('@ui/modules/player/store/playerActions').OnlineListMetaInfo,
  isClianHistory?: boolean,
) => {
  if (source == 'local') {
    return playMusicRaw(listId, list, musicInfo, source, metaInfo, isClianHistory)
  }
  if (!metaInfo) throw new Error('miss metaInfo for online music')
  return playOnlineListMusic(listId, list, musicInfo, source, metaInfo, isClianHistory)
}
