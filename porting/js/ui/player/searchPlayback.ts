import { createPlayMusicInfoList } from '@any-listen/common/tools'

import { setPause, setStop } from '@ui/plugins/player'
import * as commit from '@ui/modules/player/store/commit'
import { setPlayListMusic, setPlayListMusicUnplayedAll } from '@ui/modules/player/store/listRemoteAction'
import {
  resetRandomNextMusicInfo,
  setMusicUrl,
  setPlayMusicInfo,
  type OnlineListMetaInfo,
} from '@ui/modules/player/store/playerActions'
import { setPlayHistoryList } from '@ui/modules/player/store/playerRemoteAction'
import { playerState } from '@ui/modules/player/store/state'
import { settingState } from '@ui/modules/setting/store/state'

/**
 * 播放搜索结果列表。
 *
 * 上游 `playOnlineList()` 会先建立队列，再在后台调用
 * `fetchOnlineListDetailAll()` 刷新完整列表；该函数只认 `songlist` / `topSongs`，
 * 搜索页传入的 `search` 会直接抛 `unsupported source`。搜索结果是快照，本来就不需要
 * 这个刷新，因此这里复用同一套队列建立与起播步骤，但不发起后台补全。
 */
export const playOnlineSearchList = async (
  listId: string,
  targetList: AnyListen.Music.MusicInfo[],
  index: number,
  source: AnyListen.Player.SourceType,
  _metaInfo: OnlineListMetaInfo,
  isClianHistory = false,
) => {
  const targetMusicInfo = targetList[index]
  if (!targetMusicInfo) return

  const prevListId = playerState.playInfo.listId
  setPause()

  let targetPlayMusicInfo: AnyListen.Player.PlayMusicInfo | undefined
  if (prevListId == listId && playerState.playInfo.isLinkedList) {
    targetPlayMusicInfo = playerState.playList.find(
      (music) => !music.playLater && music.musicInfo.id == targetMusicInfo.id,
    )
    if (targetPlayMusicInfo) setPlayMusicInfo(targetPlayMusicInfo, index)
  } else {
    commit.setPlayListId(listId, source)
  }

  if (!targetPlayMusicInfo) {
    const newList = createPlayMusicInfoList({
      musicInfos: targetList,
      listId,
      source,
      playLater: false,
    })
    await setPlayListMusic({ list: newList, listId, source })
    commit.setIsLinkedList(true)
    targetPlayMusicInfo = newList.find((music) => music.musicInfo.id == targetMusicInfo.id)
    if (!targetPlayMusicInfo) return
    setPlayMusicInfo(targetPlayMusicInfo, index)
  } else if (isClianHistory && playerState.playList[0]?.playLater) {
    const firstRegularIndex = playerState.playList.findIndex((music) => !music.playLater)
    await setPlayListMusic({
      list: playerState.playList.slice(firstRegularIndex),
      listId: playerState.playInfo.listId,
      source: playerState.playInfo.source,
    })
  }

  commit.setPlaying(true)
  resetRandomNextMusicInfo()
  if (playerState.playMusicInfo) {
    setStop()
    setMusicUrl(playerState.playMusicInfo.musicInfo)
  }

  if (settingState.setting['player.isAutoCleanPlayedList'] || prevListId != listId || isClianHistory) {
    await Promise.all([setPlayListMusicUnplayedAll(), setPlayHistoryList([])])
  }
}
