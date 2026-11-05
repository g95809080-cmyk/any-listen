import { onRelease } from '@ui/modules/app/shared'
import { playerEvent } from '@ui/modules/player/store/event'
import { playerState } from '@ui/modules/player/store/state'
import { settingEvent } from '@ui/modules/setting/store/event'
import { settingState } from '@ui/modules/setting/store/state'
import { getCurrentTime as getPlayerCurrentTime } from '@ui/plugins/player'
import { createUnsubscriptionSet } from '@ui/shared'

import { filterLyricMetadata } from '@porting/ui/lyric/filterMetadata'

import * as lyric from '@ui/modules/lyric/lyric'
import { initMacStatusBarLyric } from '@ui/modules/lyric/macStatusBarLyric'
import { setOffset } from '@ui/modules/lyric/store/action'
import { initTitleLyric } from '@ui/modules/lyric/titleLyric'

const getCurrentTime = () => {
  return getPlayerCurrentTime() * 1000
}

const play = () => {
  lyric.play(getCurrentTime())
}
const pause = () => {
  lyric.pause()
}

const stop = () => {
  lyric.stop()
}

const setLyricOffset = (offset: number) => {
  lyric.setOffset(offset)
  setOffset(offset)
  playerEvent.lyricOffsetUpdated(offset)
  if (playerState.playerPlaying) setTimeout(play)
}

const setPlaybackRate = (rate: number) => {
  lyric.setPlaybackRate(rate)
  if (playerState.playerPlaying) setTimeout(play)
}

const setLyric = () => {
  if (!playerState.musicInfo.id) return
  if (playerState.musicInfo.lrc) {
    const extendedLyrics = []
    if (settingState.setting['player.isShowLyricRoma'] && playerState.musicInfo.rlrc) {
      extendedLyrics.push(playerState.musicInfo.rlrc)
    }
    if (settingState.setting['player.isShowLyricTranslation'] && playerState.musicInfo.tlrc) {
      extendedLyrics.push(playerState.musicInfo.tlrc)
    }
    if (settingState.setting['player.isSwapLyricTranslationAndRoma']) {
      extendedLyrics.reverse()
    }
    lyric.setLyric(
      filterLyricMetadata(
        settingState.setting['player.isPlayAwlrc'] && playerState.musicInfo.awlrc
          ? playerState.musicInfo.awlrc
          : playerState.musicInfo.lrc
      ),
      extendedLyrics
    )
  }

  if (playerState.playerPlaying) setTimeout(play)
}
const watchSettings = [
  'player.isShowLyricTranslation',
  'player.isShowLyricRoma',
  'player.isSwapLyricTranslationAndRoma',
  'player.isPlayAwlrc',
] satisfies Array<keyof AnyListen.AppSetting>

const unregistered = createUnsubscriptionSet()
export const initLyric = () => {
  onRelease(() => {
    stop()
    unregistered.clear()
  })
  settingEvent.on('inited', () => {
    unregistered.register((subscriptions) => {
      subscriptions.add(lyric.initLyric())
      if (import.meta.env.VITE_IS_MAC) subscriptions.add(initMacStatusBarLyric()) // 需在 initTitleLyric 之前初始化
      subscriptions.add(initTitleLyric())
      subscriptions.add(playerEvent.on('lyricUpdated', setLyric))
      subscriptions.add(playerEvent.on('setLyricOffset', setLyricOffset))
      subscriptions.add(playerEvent.on('setPlaybackRate', setPlaybackRate))
      subscriptions.add(
        settingEvent.on('updated', (keys) => {
          if (watchSettings.some((k) => keys.includes(k))) setLyric()
        })
      )
      subscriptions.add(playerEvent.on('musicChanged', stop))
      subscriptions.add(playerEvent.on('play', play))
      subscriptions.add(playerEvent.on('pause', pause))
      subscriptions.add(playerEvent.on('stop', stop))
      subscriptions.add(playerEvent.on('error', pause))
    })
  })
}
