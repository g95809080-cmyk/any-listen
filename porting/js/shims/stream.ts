/**
 * `node:stream` 最小替身。
 *
 * 上游唯一用途：`modules/proxyServer/proxy.ts:168` 用 `PassThrough` 把响应体同时
 * 写给调用方与缓存文件（tee）。Android 侧代理缓存改由 `HttpPort.downloadTo` 直接落盘
 * （`filePath` 语义），因此这条 tee 路径在正常情况下不会被触达；
 * 但仍需提供可用的 PassThrough，否则模块加载即失败。
 */

import { EventEmitter } from '@porting/shims/events'
import { Buffer } from '@porting/shims/buffer'

export type StreamData = Buffer | Uint8Array | string

export class Readable extends EventEmitter {
  readable = true

  push(chunk: StreamData | null): boolean {
    if (chunk === null) {
      this.readable = false
      this.emit('end')
      this.emit('close')
      return false
    }
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    this.emit('data', data)
    return true
  }

  pipe<T extends Writable>(dest: T): T {
    this.on('data', (chunk) => {
      dest.write(chunk as Buffer)
    })
    this.on('end', () => {
      dest.end()
    })
    return dest
  }

  destroy(err?: Error): void {
    this.readable = false
    if (err) this.emit('error', err)
    this.emit('close')
  }
}

export class Writable extends EventEmitter {
  writable = true

  write(chunk: StreamData, callback?: (error?: Error | null) => void): boolean {
    try {
      this.emit('data', typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
      callback?.(null)
      return true
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      callback?.(error)
      this.emit('error', error)
      return false
    }
  }

  end(chunk?: StreamData): void {
    if (chunk !== undefined) this.write(chunk)
    this.writable = false
    this.emit('finish')
    this.emit('close')
  }

  destroy(err?: Error): void {
    this.writable = false
    if (err) this.emit('error', err)
    this.emit('close')
  }
}

export class PassThrough extends Readable {
  private readonly sink: Writable

  constructor() {
    super()
    this.sink = new Writable()
    this.sink.on('data', (chunk) => {
      this.push(chunk as Buffer)
    })
  }

  write(chunk: StreamData, callback?: (error?: Error | null) => void): boolean {
    return this.sink.write(chunk, callback)
  }

  end(chunk?: StreamData): void {
    this.sink.end(chunk)
    this.push(null)
  }
}

export type Stream = Readable

export default { Readable, Writable, PassThrough }
