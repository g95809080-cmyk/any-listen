/**
 * `@any-listen/nodejs/music` 的 Android 实现。
 *
 * 与上游一致，只是把 `import('music-metadata').parseFile` 换成本地 `parseFileBuffer`
 * （readFile + parseBuffer）。`.strm` 分支仍复用 `./strm`（纯 HTTP，无需改写）。
 */

import { sizeFormate } from '@any-listen/common/utils'
import type { IAudioMetadata } from 'music-metadata'

import { basename, checkFile, extname, getFileStats } from '@porting/nodejs/index'
import { getMetadataLyric, parseFileBuffer, parseBufferMetadata, isMusicFile, type FileMetadata } from '@porting/nodejs/music-metadata'
import { buildStrmFileMetadata, getStrmFileLyric, getStrmFilePic } from '@any-listen/nodejs/strm'

export { parseBufferMetadata, isMusicFile }
export type { FileMetadata }

export const buildFileMetadata = async (path: string, parseMetadata = true): Promise<FileMetadata | null> => {
  if (path.endsWith('.strm')) return buildStrmFileMetadata(path, parseMetadata)

  if (parseMetadata) {
    const { parseFileMetadata } = await import('./music-metadata')
    return parseFileMetadata(path)
  }
  const ext = extname(path)
  const name = basename(path, ext)
  return {
    unparsed: true,
    name,
    singer: '',
    interval: null,
    albumName: '',
    sizeStr: sizeFormate((await getFileStats(path))?.size ?? 0),
    ext: ext.replace(/^\./, ''),
    bitrateLabel: '',
    year: 0,
    trackNo: null,
    discNo: null,
  }
}

let prevFileInfo: { path: string; promise: Promise<IAudioMetadata | null> } = {
  path: '',
  promise: Promise.resolve(null),
}

const getFileMetadata = async (path: string): Promise<IAudioMetadata | null> => {
  if (prevFileInfo.path == path) return prevFileInfo.promise
  prevFileInfo.path = path
  prevFileInfo.promise = checkFile(path).then(async (isExist) => {
    if (!isExist) return null
    const parsed = await parseFileBuffer(path, { skipCovers: false })
    return parsed?.metadata ?? null
  })
  return prevFileInfo.promise
}

export const getFilePic = async (path: string) => {
  if (path.endsWith('.strm')) return getStrmFilePic(path)
  const metadata = await getFileMetadata(path)
  if (!metadata) return null
  const { selectCover } = await import('music-metadata')
  return selectCover(metadata.common.picture) || null
}

export const getFileLyric = async (path: string) => {
  if (path.endsWith('.strm')) return getStrmFileLyric(path)
  const metadata = await getFileMetadata(path)
  const lyric = getMetadataLyric(metadata)
  const { isLikelyGarbage } = await import('@any-listen/common/utils')
  if (lyric && isLikelyGarbage(lyric)) return null
  return lyric
}

export { getStrmFileUrl } from '@any-listen/nodejs/strm'

export default { buildFileMetadata, getFilePic, getFileLyric, parseBufferMetadata, isMusicFile }
