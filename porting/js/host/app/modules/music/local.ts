/**
 * `@/app/modules/music/local` 的 Android 版。
 *
 * 三处平台差异：
 * 1. 播放 URL 由 `FileSystemPort.toPlayableUrl()` 产出（loopback HTTP，支持 Range + 同源）。
 *    桌面版走 Koa 的 `/public/medias/*` 静态映射，Android 没有 Koa。
 * 2. `meta.deviceId !== appState.machineId` 的判定**保留**语义，但**不再静默返回 null**：
 *    改为抛 `MusicDeviceMismatchError`（`code = 'MUSIC_DEVICE_MISMATCH'`）。
 *    原因（team-lead 2026-xx 约束 / arch §5.3 Step B4）：用户直接拷贝桌面数据目录时，
 *    deviceId 还是桌面机器 id，静默 null 的表现是「点了不播，无任何提示」，
 *    现场无法定位。迁移脚本会重绑 deviceId，但手动拷贝这条路径必须可见。
 * 3. `verifyResourceBoolean` 走 HttpPort（`Range: bytes=0-1`），与桌面一致。
 */

import { getLocalFilePath } from '@any-listen/app/modules/music/utils'
import { writeProxyCache } from '@any-listen/app/modules/proxyServer'
import { isUrl } from '@any-listen/common/utils'
import { verifyResourceBoolean } from '@any-listen/nodejs/request'

import { appState } from '@/app/app'
import { workers } from '@/app/worker'
import { ports } from '@porting/ports'

import { createMediaPublicPath, createPicPublicPath } from '@porting/host/app/modules/fileSystem'
import { getCachedLyricInfo } from '@/app/modules/music/shared'

/** 领域错误码：本地音乐条目的 deviceId 不属于本机（需要重新绑定本地目录） */
export const MUSIC_DEVICE_MISMATCH = 'MUSIC_DEVICE_MISMATCH'

/**
 * 可识别的领域错误。
 *
 * 为什么不用通用 Error：message2call 会把 Error 序列化成 `{message, stack}` 丢到主线程，
 * `code` 会丢失，UI 就没法区分「设备不匹配」和「文件不存在」。因此这里把 `code`
 * 写进 message 前缀（`[MUSIC_DEVICE_MISMATCH] ...`）**同时**挂在实例上，两条路都能识别。
 */
export class MusicDeviceMismatchError extends Error {
  readonly code: typeof MUSIC_DEVICE_MISMATCH = MUSIC_DEVICE_MISMATCH
  readonly filePath: string
  readonly deviceId: string

  constructor(filePath: string, deviceId: string) {
    super(
      `[${MUSIC_DEVICE_MISMATCH}] 该歌曲需要重新绑定本地目录：当前条目属于设备 ${deviceId || '(空)'}，` +
        `本机是 ${appState.machineId || '(未初始化)'}。请在「设置 → 本地音乐」重新选择目录后让它重新入库。`,
    )
    this.name = 'MusicDeviceMismatchError'
    this.filePath = filePath
    this.deviceId = deviceId
  }
}

/** 判断是否是「devid 不匹配」——供上层（rendererEvent / UI）区分后给出引导文案 */
export function isMusicDeviceMismatch(err: unknown): err is MusicDeviceMismatchError {
  return err instanceof MusicDeviceMismatchError
}

/**
 * 设备归属校验。
 * 注意：`appState.machineId` 为空表示应用还没初始化完（启动竞态），此时也走同一错误，
 * 但把 `deviceId` 传空以便日志区分。
 */
function assertDeviceBound(musicInfo: AnyListen.Music.MusicInfoLocal): void {
  if (musicInfo.meta.deviceId === appState.machineId) return
  throw new MusicDeviceMismatchError(musicInfo.meta.filePath, musicInfo.meta.deviceId)
}

export const getMusicUrl = async ({
  musicInfo,
}: {
  musicInfo: AnyListen.Music.MusicInfoLocal
  isRefresh?: boolean
  quality?: string
}): Promise<AnyListen.IPCMusic.MusicUrlInfo | null> => {
  assertDeviceBound(musicInfo)
  const filePath = await getLocalFilePath(musicInfo)
  if (!filePath) return null

  if (filePath.endsWith('.strm')) {
    const strmUrl = await workers.utilService.getStrmFileUrl(filePath)
    if (!strmUrl) return null
    return { url: strmUrl, quality: '128k', isFromCache: false }
  }

  const url = await createMediaPublicPath(filePath)
  if (!url) return null
  return { url, quality: '128k', isFromCache: false }
}

export const getMusicPicUrl = async ({
  musicInfo,
  isRefresh = false,
}: {
  musicInfo: AnyListen.Music.MusicInfoLocal
  isRefresh?: boolean
}): Promise<AnyListen.IPCMusic.MusicPicInfo | null> => {
  assertDeviceBound(musicInfo)
  let refresh = isRefresh
  if (refresh && (!musicInfo.meta.picUrl || !(await verifyResourceBoolean(musicInfo.meta.picUrl)))) {
    refresh = false
  }
  if (refresh) return null

  const pic = await workers.utilService.getMusicFilePic(musicInfo.meta.filePath)
  if (pic) {
    if (typeof pic === 'string') {
      if (isUrl(pic)) return { url: pic, isFromCache: true }
      const url = await createPicPublicPath(musicInfo.meta.filePath, pic)
      if (url) return { url, isFromCache: false }
    } else {
      const cachePath = `${musicInfo.meta.filePath}.${pic.format}`
      return { url: await writeProxyCache(cachePath, pic.data), isFromCache: false }
    }
  }

  if (musicInfo.meta.picUrl) return { url: musicInfo.meta.picUrl, isFromCache: true }
  return null
}

export const getLyricInfo = async ({
  musicInfo,
  isRefresh = false,
}: {
  musicInfo: AnyListen.Music.MusicInfoLocal
  isRefresh?: boolean
}): Promise<AnyListen.IPCMusic.MusicLyricInfo | null> => {
  assertDeviceBound(musicInfo)
  if (isRefresh) return null

  const [lyricInfo, fileLyricInfo] = await Promise.all([
    getCachedLyricInfo(musicInfo),
    appState.appSetting['player.ignoreLocalLyrics']
      ? Promise.resolve(null)
      : workers.utilService.getMusicFileLyric(musicInfo.meta.filePath),
  ])

  if (lyricInfo?.lyric && lyricInfo.rawlrcInfo) {
    return {
      info: { ...lyricInfo, rawlrcInfo: fileLyricInfo ?? lyricInfo.rawlrcInfo },
      isFromCache: true,
    }
  }
  if (fileLyricInfo) {
    return {
      info: {
        ...fileLyricInfo,
        name: musicInfo.name,
        singer: musicInfo.singer,
        interval: musicInfo.interval,
      },
      isFromCache: true,
    }
  }
  if (lyricInfo?.lyric) return { info: lyricInfo, isFromCache: true }
  return null
}

/**
 * 迁移后把本地音乐条目的 `meta.deviceId` 重绑到本机 machineId。
 * `dbService` 侧对应 statement 见 README「数据迁移 · Step B4」。
 */
export const getMachineId = (): string => appState.machineId

export { ports }
