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

export class PreloadCanceledError extends Error {
  readonly code = 'ESTALE'

  constructor(filePath: string) {
    super(`[safeFS] preload canceled after path changed: ${filePath}`)
    this.name = 'PreloadCanceledError'
  }
}

const cache = new Map<string, CacheEntry>()
const pendingFlush = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Map<string, Promise<void>>()
const preloads = new Map<string, { revision: number; promise: Promise<void> }>()
const revisions = new Map<string, number>()

const DEFAULT_DEBOUNCE_MS = 300

function getRevision(filePath: string): number {
  return revisions.get(filePath) ?? 0
}

function bumpRevision(filePath: string): void {
  revisions.set(filePath, getRevision(filePath) + 1)
}

export function getCachedFile(filePath: string): Buffer | null {
  return cache.get(filePath)?.data ?? null
}

export function isCached(filePath: string): boolean {
  return cache.has(filePath)
}

/** 启动期或首次使用时预载单个文件到同步缓存 */
export async function preloadFile(filePath: string): Promise<void> {
  if (cache.has(filePath)) return

  const revision = getRevision(filePath)
  const existing = preloads.get(filePath)
  if (existing?.revision === revision) {
    await existing.promise
    return
  }

  const load = (async () => {
    let data: Buffer
    try {
      const bytes = await ports.fs.readFile(filePath)
      data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } catch (err) {
      // ENOENT 是正常情况（首次启动），其它错误必须暴露
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') throw err
      data = Buffer.alloc(0)
    }

    // 慢读期间可能已经写入新值、卸载或重装。旧读只能放弃，不能覆盖新的缓存。
    if (getRevision(filePath) !== revision) {
      // 已有新的完整缓存（例如写穿或重装后的预载）时直接用新值即可；
      // 缓存为空说明这一代已被 evict，必须让调用方知道读取已失效，
      // 不能把"没有缓存"当成真实的空配置继续处理。
      if (cache.has(filePath)) return
      throw new PreloadCanceledError(filePath)
    }
    if (cache.has(filePath)) return
    cache.set(filePath, { data, dirty: false })
  })()
  const entry = { revision, promise: load }
  preloads.set(filePath, entry)
  try {
    await load
  } finally {
    if (preloads.get(filePath) === entry) preloads.delete(filePath)
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

/**
 * 丢弃一个路径的内存缓存。
 *
 * 扩展卸载后 `configStore` 仍可能持有同 ID 的旧缓存；如果只删 Store 而不删这份缓存，
 * 同 ID 重装会把已删除的旧配置重新读回来并再次落盘。先等当前写入结束，再删缓存，
 * 避免旧写入在新文件预载后完成并覆盖新内容；revision 递增也会让慢读放弃旧内容。
 */
export async function evictFile(filePath: string): Promise<void> {
  while (true) {
    const timer = pendingFlush.get(filePath)
    if (timer) clearTimeout(timer)
    pendingFlush.delete(filePath)

    const pending = inFlight.get(filePath)
    if (!pending) break
    try {
      await pending
    } catch {
      // flushFile 已经记录错误；卸载/重装不应被旧路径的写入失败卡住
    }
  }
  bumpRevision(filePath)
  cache.delete(filePath)
  preloads.delete(filePath)
}

function scheduleFlush(filePath: string, debounceMs: number): void {
  const existing = pendingFlush.get(filePath)
  if (existing) clearTimeout(existing)
  pendingFlush.set(
    filePath,
    setTimeout(() => {
      pendingFlush.delete(filePath)
      void flushFile(filePath).catch(() => { /* flushFile 已记录错误，保留 dirty 等待下次重试 */ })
    }, debounceMs)
  )
}

export async function flushFile(filePath: string): Promise<void> {
  const scheduled = pendingFlush.get(filePath)
  if (scheduled) {
    clearTimeout(scheduled)
    pendingFlush.delete(filePath)
  }
  while (true) {
    const pending = inFlight.get(filePath)
    if (pending) {
      await pending
      continue
    }
    const entry = cache.get(filePath)
    if (!entry || !entry.dirty) return
    entry.dirty = false
    const write = ports.fs.writeFileAtomic(filePath, entry.data)
      .catch((error: unknown) => {
        const current = cache.get(filePath)
        if (current) current.dirty = true
        console.error(`[safeFS] flush failed: ${filePath}`, error)
        throw error
      })
      .finally(() => { inFlight.delete(filePath) })
    inFlight.set(filePath, write)
    await write
  }
}

/** 生命周期强制落盘（onBackground / onBeforeTerminate / onTrimMemory） */
export async function flushAll(): Promise<void> {
  for (const timer of pendingFlush.values()) clearTimeout(timer)
  pendingFlush.clear()
  const targets = new Set([...inFlight.keys(), ...[...cache.entries()].filter(([, entry]) => entry.dirty).map(([filePath]) => filePath)])
  await Promise.all([...targets].map((filePath) => flushFile(filePath)))
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
    bumpRevision(this.filePath)
    scheduleFlush(this.filePath, this.batch ? this.debounceMs : 0)
  }

  /** 非 batch 模式下同步落盘的语义不能保留，改为立即排一次 flush */
  flush(): Promise<void> {
    return flushFile(this.filePath)
  }
}
