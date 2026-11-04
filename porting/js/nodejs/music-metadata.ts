/**
 * `@any-listen/nodejs/music-metadata` 的 Android 实现。
 *
 * 与上游唯一的差异：`parseFile(path)` → `readFile(path)` + `parseBuffer(bytes)`。
 * 原因：`music-metadata` 的 `parseFile` 走 `strtok3.fromFile`（node:fs），WebView 无此能力。
 * 其余逻辑（`getMetadataLyric` / `getWavFileArtist` / `bitrateFormat` / `isMusicFile`）
 * 与上游逐行一致，避免元数据字段语义漂移。
 *
 * 内存提示：整文件读入。单个音频文件（FLAC 40MB 级）在 util-worker 内可接受；
 * 若后续遇到超大文件，可改用 `FileSystemPort.readFile(path, {start,end})` 做分段解析。
 */

import { MEDIA_FILE_TYPES, MEDIA_FILE_TYPES_LOCAL } from '@any-listen/common/constants'
import { singerFormat } from '@any-listen/common/tools'
import { formatPlayTime, isLikelyGarbage, sizeFormate } from '@any-listen/common/utils'
import type { IAudioMetadata } from 'music-metadata'

import { basename, checkFile, extname, getFileStats, readFile } from '.'

const bitrateFormat = (formate: IAudioMetadata['format']) => {
  if (formate.lossless) {
    if (formate.bitsPerSample) return `${formate.bitsPerSample}bit`
  }
  if (formate.bitrate) return `${Math.trunc(formate.bitrate / 1000)}k`
  return ''
}

type IComment = NonNullable<IAudioMetadata['common']['comment']> extends Array<infer U> ? U : never

export const getMetadataLyric = (metadata: IAudioMetadata | null) => {
  if (!metadata) return null
  for (const info of Object.values(metadata.native)) {
    for (const ust of info) {
      switch (ust.id) {
        case 'LYRICS': {
          const value = typeof ust.value == 'string' ? ust.value : (ust as IComment).text
          if (value && value.length > 10) return value
          break
        }
        case 'USLT': {
          const value = ust.value as IComment
          if (value.text && value.text.length > 10) return value.text
          break
        }
      }
    }
  }
  return null
}

/** get artist for wav file（https://github.com/any-listen/any-listen/issues/132） */
const getWavFileArtist = (metadata: IAudioMetadata) => {
  if (!metadata.common.artists?.length) return ''
  if (metadata.common.artists.length > 1) {
    const { exif, ...infos } = metadata.native
    const artists: string[] = []
    for (const info of Object.values(infos)) {
      for (const ust of info) {
        if (ust.id === 'IART') {
          if (typeof ust.value == 'string') artists.push(ust.value)
        } else if (ust.id === 'TPE1') {
          if (typeof ust.value == 'string') artists.push(ust.value)
        }
      }
    }
    if (artists.length) return singerFormat(artists.join(';'))
  } else if (metadata.common.artist) return singerFormat(metadata.common.artist)
  return ''
}

const getArtist = (ext: string, metadata: IAudioMetadata) => {
  if (ext === 'wav') return getWavFileArtist(metadata)
  return metadata.common.artists?.length ? singerFormat(metadata.common.artists.join(';')) : ''
}

export interface FileMetadata {
  unparsed: boolean
  name: string
  singer: string
  interval: string | null
  albumName: string
  sizeStr: string
  ext: string
  bitrateLabel: string
  year: number
  trackNo: number | null
  discNo: number | null
}

export const parseBufferMetadata = async (buffer: Uint8Array, mimeType: string, ext: string) => {
  const { parseBuffer, selectCover } = await import('music-metadata')
  const metadata = await parseBuffer(buffer, mimeType || { mimeType: 'application/octet-stream' }, {
    skipPostHeaders: true,
    duration: false,
  })
  let name = (metadata.common.title || '').trim()
  const isLikelyNameGarbage = isLikelyGarbage(name)
  if (isLikelyNameGarbage) name = ''
  const singer = isLikelyNameGarbage ? '' : getArtist(ext, metadata)
  const albumName = isLikelyNameGarbage ? '' : (metadata.common.album?.trim() ?? '')
  const interval =
    metadata.format.duration && metadata.format.duration > 2 ? formatPlayTime(metadata.format.duration) : null

  return {
    name,
    singer,
    interval,
    albumName,
    bitrateLabel: bitrateFormat(metadata.format),
    year: metadata.common.year ?? 0,
    trackNo: metadata.common.track.no,
    discNo: metadata.common.disk.no,
    pic: selectCover(metadata.common.picture) || null,
    lyric: getMetadataLyric(metadata),
  }
}

/** 把磁盘文件读入后交给 `parseBuffer` —— 这是与上游唯一的行为差异 */
export const parseFileBuffer = async (
  path: string,
  options: { skipCovers?: boolean } = {}
): Promise<{ metadata: IAudioMetadata; size: number } | null> => {
  if (!(await checkFile(path))) return null
  const { parseBuffer } = await import('music-metadata')
  const buffer = await readFile(path)
  try {
    const metadata = await parseBuffer(buffer, { path, size: buffer.length }, { skipCovers: options.skipCovers ?? false })
    return { metadata, size: buffer.length }
  } catch (err) {
    console.log(`Error parsing file metadata: ${path}`)
    console.error(err)
    return null
  }
}

export const parseFileMetadata = async (path: string): Promise<FileMetadata | null> => {
  const parsed = await parseFileBuffer(path, { skipCovers: true })
  if (!parsed) return null
  const { metadata, size } = parsed

  const ext = extname(path)
  let name = (metadata.common.title || '').trim()
  const isLikelyNameGarbage = isLikelyGarbage(name)
  if (isLikelyNameGarbage) name = ''
  name ||= basename(path, ext)
  const singer = isLikelyNameGarbage ? '' : getArtist(ext.replace(/^\./, ''), metadata)
  const interval =
    metadata.format.duration && metadata.format.duration > 2 ? formatPlayTime(metadata.format.duration) : null
  const albumName = isLikelyNameGarbage ? '' : (metadata.common.album?.trim() ?? '')

  // 上游再次 stat 取 size；这里复用已读入的长度，省一次跨线程往返
  const sizeStr = sizeFormate(size || (await getFileStats(path))?.size || 0)

  return {
    unparsed: false,
    name,
    singer,
    interval,
    albumName,
    sizeStr,
    ext: ext.replace(/^\./, ''),
    bitrateLabel: bitrateFormat(metadata.format),
    year: metadata.common.year ?? 0,
    trackNo: metadata.common.track.no,
    discNo: metadata.common.disk.no,
  }
}

const musicExtensions = MEDIA_FILE_TYPES.map((ext) => `.${ext}`)
const localMusicExtensions = MEDIA_FILE_TYPES_LOCAL.map((ext) => `.${ext}`)

export const isMusicFile = (filePath: string, isLocal?: boolean): boolean => {
  return (isLocal ? localMusicExtensions : musicExtensions).includes(extname(filePath))
}
