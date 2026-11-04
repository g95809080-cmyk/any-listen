/**
 * `node:zlib` 替身 → fflate。
 *
 * 上游 2 处使用：`modules/sync/webdav/modules/shared.ts`（gzip/gunzip）
 * 与 `extensionApis/utils.ts`（同步 gzipSync/gunzipSync 之类）。
 */

import { Buffer } from '@porting/shims/buffer'
import {
  deflateSync as fflateRawDeflateSync,
  gunzipSync as fflateGunzipSync,
  gzipSync as fflateGzipSync,
  inflateSync as fflateRawInflateSync,
  unzlibSync as fflateUnzlibSync,
  zlibSync as fflateZlibSync,
} from 'fflate'

import { PortError } from '@porting/ports/types'

export type InputType = string | Uint8Array

/**
 * 取「精确边界」的字节副本。
 *
 * 必须复制，不能直接把入参交给 fflate：Node 的 `Buffer` 是**池化**的（小 Buffer 共用一个大
 * ArrayBuffer，`byteOffset` 非 0），fflate 内部会按 `buffer` 整块读，于是读到池子里的垃圾数据
 * ——表现为 `incorrect header check`。`Uint8Array.from()` 按视图拷贝，彻底规避。
 */
function toBytes(data: InputType): Uint8Array {
  return typeof data === 'string' ? Uint8Array.from(Buffer.from(data)) : Uint8Array.from(data)
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export function gzipSync(data: InputType): Buffer {
  return toBuffer(fflateGzipSync(toBytes(data)))
}

export function gunzipSync(data: InputType): Buffer {
  return toBuffer(fflateGunzipSync(toBytes(data)))
}

export type ZlibCallback = (error: Error | null, result?: Buffer) => void

export function gzip(data: InputType, callback: ZlibCallback): void {
  try {
    callback(null, gzipSync(data))
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)))
  }
}

export function gunzip(data: InputType, callback: ZlibCallback): void {
  try {
    callback(null, gunzipSync(data))
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)))
  }
}

export function gzipSyncAsync(data: InputType): Promise<Buffer> {
  return Promise.resolve().then(() => gzipSync(data))
}

/**
 * Node 的 `deflate`/`inflate` 带 **zlib 封装头**，对应 fflate 的 `zlibSync`/`unzlibSync`；
 * fflate 的 `deflateSync`/`inflateSync` 是**裸 DEFLATE**，语义上等于 Node 的 `deflateRaw`/`inflateRaw`。
 * 搞错这一层会导致「自己压自己解没问题，但和桌面版数据/第三方服务互通时 header check 失败」。
 *
 * 扩展 API（`extensionApis/utils.ts`）用它做**裸 zlib 流**压缩。
 * 参数第三位是 flush 选项（`Z_FINISH` / `Z_SYNC_FLUSH`），fflate 没有等价概念
 * —— 扩展场景只做一次性整块压缩，按 `Z_FINISH` 处理即语义等价。
 */
/** Node `deflate` 语义（zlib 封装） */
export function deflateSync(data: InputType): Buffer {
  return toBuffer(fflateZlibSync(toBytes(data)))
}

/** Node `inflate` 语义（zlib 封装） */
export function inflateSync(data: InputType): Buffer {
  return toBuffer(fflateUnzlibSync(toBytes(data)))
}

export function deflate(data: InputType, callback: ZlibCallback): void
export function deflate(data: InputType, options: unknown, callback: ZlibCallback): void
export function deflate(data: InputType, arg2: unknown, arg3?: ZlibCallback): void {
  const callback = typeof arg2 === 'function' ? (arg2 as ZlibCallback) : arg3
  if (!callback) throw new PortError('EUNSUPPORTED', 'zlib.deflate 需要 callback 参数')
  try {
    callback(null, deflateSync(data))
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)))
  }
}

export function inflate(data: InputType, callback: ZlibCallback): void
export function inflate(data: InputType, options: unknown, callback: ZlibCallback): void
export function inflate(data: InputType, arg2: unknown, arg3?: ZlibCallback): void {
  const callback = typeof arg2 === 'function' ? (arg2 as ZlibCallback) : arg3
  if (!callback) throw new PortError('EUNSUPPORTED', 'zlib.inflate 需要 callback 参数')
  try {
    callback(null, inflateSync(data))
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)))
  }
}

/** Node 的 flush 常量。取值与 Node 一致，扩展代码可能直接比较数值。 */
export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_DEFAULT_COMPRESSION: -1,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
} as const

/** Node `deflateRaw` 语义（裸 DEFLATE） */
export function deflateRawSync(data: InputType): Buffer {
  return toBuffer(fflateRawDeflateSync(toBytes(data)))
}

/** Node `inflateRaw` 语义（裸 DEFLATE） */
export function inflateRawSync(data: InputType): Buffer {
  return toBuffer(fflateRawInflateSync(toBytes(data)))
}

export default {
  gzip,
  gunzip,
  gzipSync,
  gunzipSync,
  deflate,
  inflate,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  constants,
}
