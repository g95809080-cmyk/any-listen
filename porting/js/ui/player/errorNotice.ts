import { showNotify } from '@ui/components/apis/notify'
import { playerEvent } from '@ui/modules/player/store/event'
import { playerState } from '@ui/modules/player/store/state'
import { writable } from 'svelte/store'

import { formatPlayerStatus } from '@porting/ui/statusText'

let lastMessage = ''
let lastAt = 0

/**
 * 播放失败后的常驻文案。
 *
 * `playerState.statusText` 会继续停留在失败前的「歌曲链接获取中…」，
 * 迷你播放器和播放页因此看不到最终原因。失败发生时把文案存下来，
 * 等新曲开始或真正播放成功后再清除。
 */
export const playbackErrorStatus = writable('')

/**
 * 取流失败的 `statusText` 只在播放页底部短暂显示，而且 `playerPlaying` 为 true 时会被隐藏；
 * 内置 online-metadata 这类没有 `musicUrl` 的音源，用户最后只会看到“歌曲链接获取中…”消失。
 * 这里在播放器 error 事件上补一条可行动 toast，并对短时间内的重复错误去重。
 */
export const installPlaybackErrorNotify = () => {
  playerEvent.on('musicChanged', () => {
    playbackErrorStatus.set('')
  })
  playerEvent.on('playerPlaying', () => {
    playbackErrorStatus.set('')
  })
  playerEvent.on('error', () => {
    const message = formatPlayerStatus(playerState.statusText)
    if (!message) return

    playbackErrorStatus.set(message)
    const now = performance.now()
    if (message === lastMessage && now - lastAt < 3000) return
    lastMessage = message
    lastAt = now
    showNotify(message, 6, true)
  })
}
