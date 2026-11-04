/**
 * `@any-listen/nodejs/Store` 的 Android 实现：建立在 `SafeFS`（内存同步）之上。
 *
 * 与上游 `Store.ts` 的接口完全一致：`get/getAll/has/set/delete/override`，
 * 构造函数签名 `(filePath, clearInvalidConfig = false, batch = false)`。
 */

import { Buffer } from '@porting/shims/buffer'
import SafeFS, { getCachedFile } from '@porting/nodejs/SafeFS'

export default class Store {
  private store: Record<string, unknown>
  private readonly safeFS: SafeFS

  private writeFile(): void {
    this.safeFS.writeFile(this.store)
  }

  private readStore(): Record<string, unknown> {
    const cached = getCachedFile(this.safeFSPath())
    if (cached == null || cached.length === 0) return {}
    return JSON.parse(cached.toString('utf8')) as Record<string, unknown>
  }

  private readonly filePath: string

  private safeFSPath(): string {
    return this.filePath
  }

  constructor(filePath: string, clearInvalidConfig = false, batch = false) {
    this.filePath = filePath
    this.safeFS = new SafeFS(filePath, batch)

    let store: Record<string, unknown>
    if (clearInvalidConfig) {
      try {
        store = this.readStore()
      } catch {
        store = {}
      }
    } else {
      store = this.readStore()
    }

    if (typeof store != 'object' || store === null) {
      if (clearInvalidConfig) store = {}
      else throw new Error(`parse data error: ${String(store)}`)
    }
    this.store = store
  }

  get<V>(key: string): V | null {
    return (this.store[key] as V) ?? null
  }

  getAll<V extends object>(): V {
    return this.store as V
  }

  has(key: string): boolean {
    return key in this.store
  }

  set<V = unknown>(key: string, value: V): void {
    this.store[key] = value
    this.writeFile()
  }

  delete(key: string): void {
    delete this.store[key]
    this.writeFile()
  }

  override(value: object): void {
    this.store = value as Record<string, unknown>
    this.writeFile()
  }

  /** 序列化当前内容（调试 / 导入导出用） */
  toBuffer(): Buffer {
    return Buffer.from(JSON.stringify(this.store, null, '\t'))
  }
}
