/**
 * `@any-listen/nodejs/SafeFS` 的 Android 实现：**同步内存 + 异步原子落盘**。
 *
 * 为什么不能直接 alias 上游：上游 `SafeFS.ts:20-33` 用 `readFileSync/writeFileSync/mkdirSync/renameSync`
 * 全同步实现。Worker 内无法同步触达 Kotlin（`@JavascriptInterface` 只在主 frame），
 * 因此必须改成「启动时异步预载进内存 + 变更后异步原子落盘」。
 *
 * 一致性策略：
 * - 读：只读内存缓存；未预载的路径返回 `null`（等价于"文件不存在"）并记一条 warn，
 *   因此 `bootstrap()` 必须在任何模块初始化之前 `await preloadDir(dataPath)`。
 * - 写：先写内存（对上层立即可见），再 debounce 落盘（默认 300ms）；`flushNow()` 强制落盘，
 *   由 `LifecyclePort.onBackground/onBeforeTerminate` 调用。
 */

import { Buffer } from '@porting/shims/buffer'
import { ports } from '@porting/ports'

interface CacheEntry {
  data: Buffer
  dirty: boolean
}

const cache = new Map<string, CacheEntry>()
const pendingFlush = new Map<string, ReturnType<typeof setTimeout>>()

const DEFAULT_DEBOUNCE_MS = 300

export function getCachedFile(filePath: string): Buffer | null {
  return cache.get(filePath)?.data ?? null
}

export function isCached(filePath: string): boolean {
  return cache.has(filePath)
}

/** 启动期预载单个文件到同步缓存 */
export async function preloadFile(filePath: string): Promise<void> {
  if (cache.has(filePath)) return
  try {
    const data = await ports.fs.readFile(filePath)
    cache.set(filePath, { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), dirty: false })
  } catch (err) {
    // ENOENT 是正常情况（首次启动），其它错误必须暴露
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      cache.set(filePath, { data: Buffer.alloc(0), dirty: false })
      return
    }
    throw err
  }
}

/** 预载目录下所有 *.json（config.json / data.json / theme.json … 都是 Store 文件） */
export async function preloadDir(dirPath: string, extFilter = ['.json']): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof ports.fs.readdir>>
  try {
    entries = await ports.fs.readdir(dirPath)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return []
    throw err
  }
  const loaded: string[] = []
  for (const entry of entries) {
    if (!entry.isFile) continue
    if (!extFilter.some((ext) => entry.name.endsWith(ext))) continue
    await preloadFile(entry.path)
    loaded.push(entry.path)
  }
  return loaded
}

function scheduleFlush(filePath: string, debounceMs: number): void {
  const existing = pendingFlush.get(filePath)
  if (existing) clearTimeout(existing)
  pendingFlush.set(
    filePath,
    setTimeout(() => {
      pendingFlush.delete(filePath)
      void flushFile(filePath)
    }, debounceMs)
  )
}

export async function flushFile(filePath: string): Promise<void> {
  const entry = cache.get(filePath)
  if (!entry || !entry.dirty) return
  entry.dirty = false
  try {
    await ports.fs.writeFileAtomic(filePath, entry.data)
  } catch (err) {
    entry.dirty = true
    console.error(`[safeFS] flush failed: ${filePath}`, err)
  }
}

/** 生命周期强制落盘（onBackground / onBeforeTerminate / onTrimMemory） */
export async function flushAll(): Promise<void> {
  for (const timer of pendingFlush.values()) clearTimeout(timer)
  pendingFlush.clear()
  const targets = [...cache.entries()].filter(([, entry]) => entry.dirty).map(([filePath]) => filePath)
  await Promise.all(targets.map((filePath) => flushFile(filePath)))
}

export default class SafeFS {
  private readonly filePath: string
  private readonly batch: boolean
  private debounceMs = DEFAULT_DEBOUNCE_MS

  constructor(filePath: string, batch = false) {
    this.filePath = filePath
    this.batch = batch
    if (batch) this.debounceMs = DEFAULT_DEBOUNCE_MS
  }

  /** 同步读：来自预载缓存 */
  readFile(): Buffer | null {
    const entry = cache.get(this.filePath)
    if (!entry) {
      console.warn(`[safeFS] ${this.filePath} was not preloaded; treated as empty`)
      return null
    }
    return entry.data
  }

  writeFile(data: string | Record<string, unknown> | Buffer | Uint8Array): void {
    const bytes =
      typeof data === 'string'
        ? Buffer.from(data)
        : data instanceof Uint8Array
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(typeof data === 'object' ? JSON.stringify(data, null, '\t') : String(data))
    cache.set(this.filePath, { data: bytes, dirty: true })
    scheduleFlush(this.filePath, this.batch ? this.debounceMs : 0)
  }

  /** 非 batch 模式下同步落盘的语义不能保留，改为立即排一次 flush */
  flush(): Promise<void> {
    return flushFile(this.filePath)
  }
}
