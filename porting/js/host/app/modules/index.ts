/**
 * `@/app/modules` 的 Android 版（`initModules`）。
 *
 * 与 web-server 版的差异只有两处：
 * 1. `initProxyServer` 不需要 dev host（Android 无 dev server），传 `'.'`。
 * 2. 日志目录用 `appState.dataPath`（与桌面同构）。
 */

import { initDislikeList } from '@any-listen/app/modules/dislikeList'
import { initProxyServer } from '@any-listen/app/modules/proxyServer'
import { API_PREFIX, PROXY_SERVER_PATH } from '@any-listen/common/constants'

import { appState } from '@/app/app'
import { workers } from '@/app/worker'

import { initCommand } from '@/app/modules/command'
import { initExtension } from '@/app/modules/extension'
import { initHotKey } from '@/app/modules/hotKey'
import { initMusicList } from '@/app/modules/musicList'
import { initPlayer } from '@/app/modules/player'
import { initResources } from '@/app/modules/resources'
import { initSync } from '@/app/modules/sync'
import { initTheme } from '@/app/modules/theme'
import { initAppLog } from '@any-listen/app/modules/logs'

export const initModules = async (): Promise<void> => {
  await Promise.all([
    initHotKey(),
    initPlayer(),
    initTheme(),
    initDislikeList(workers.dbService),
    initMusicList(),
    initExtension(),
    initResources(),
    initSync(),
    initProxyServer('.', `${API_PREFIX}${PROXY_SERVER_PATH}`, appState.cacheDataPath),
    initCommand(),
    initAppLog(appState.dataPath),
  ])
}
