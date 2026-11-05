/**
 * `better-sqlite3` 兼容的 SQLite 适配器（sql.js / WASM）。
 *
 * 为什么必须同步：`dbService` 有 292 处同步调用、41 处 `db.transaction(fn)` 函数式事务，
 * 改成异步等于重写 4,773 行。sql.js 的同步 API + 全库内存正好满足。
 * 只用到 better-sqlite3 的 6 个方法（Phase 2 §1.4 实测）：`prepare/run/get/all/transaction/exec/pragma/backup`。
 *
 * 落盘策略（§4.2）：
 * - 每个写操作标记 dirty，debounce **1.5s** 执行 `db.export()` → `FileSystemPort.writeFileAtomic`
 *   （`.tmp` + fsync + rename），保证崩溃时文件要么是旧版本要么是新版本。
 * - `flushNow()` 供 `LifecyclePort.onBackground / onBeforeTerminate / onTrimMemory` 强制刷盘。
 * - `close()` **不刷盘**：`db.ts:72-75` 在 `verifyDB` 失败时会先 `close()` 再备份原文件，
 *   此时刷盘会把「刚建的空库」覆盖到用户数据上。刷盘只能由显式 flush 触发。
 */

import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type Statement as SqlJsStatement } from 'sql.js'

import { resolveBoundParams } from '@porting/ports/sql-params'
import { Buffer } from '@porting/shims/buffer'
import { ports } from '@porting/ports/index'
import { PortError } from '@porting/ports/types'

const FLUSH_DEBOUNCE_MS = 1500

let sqlJs: SqlJsStatic | null = null
let locateFile: (file: string) => string = (file) => `/wasm/${file}`

export interface SqliteInitOptions {
  locateFile?: (file: string) => string
}

/** 主线程 / Worker 启动时调用一次（加载 wasm） */
export async function initSqlite(options: SqliteInitOptions = {}): Promise<void> {
  if (sqlJs) return
  if (options.locateFile) locateFile = options.locateFile
  sqlJs = await initSqlJs({ locateFile })
}

function requireSqlJs(): SqlJsStatic {
  if (!sqlJs) throw new PortError('EUNSUPPORTED', 'sql.js is not initialized, call initSqlite() at worker startup')
  return sqlJs
}

/** 预载：把磁盘上的 .db 读进内存，供同步的 `new Database()` 使用 */
const preloaded = new Map<string, Uint8Array>()
const openDatabases = new Set<Database>()
let lifecycleRegistered = false

/** 在 db worker 的原生桥接就绪后调用一次。 */
export function registerSqliteLifecycle(): void {
  if (lifecycleRegistered) return
  lifecycleRegistered = true
  const flush = () => {
    void flushOpenDatabases().catch((error: unknown) => console.error('[sqlite] lifecycle flush failed', error))
  }
  ports.lifecycle.onBackground(flush)
  ports.lifecycle.onTrimMemory(flush)
  ports.lifecycle.onBeforeTerminate((id) => {
    void flushOpenDatabases()
      .then(() => ports.lifecycle.acknowledgeTermination(id, 'db'))
      .catch((error: unknown) => console.error('[sqlite] termination flush failed', error))
  })
}

export async function flushOpenDatabases(): Promise<void> {
  await Promise.all([...openDatabases].map((db) => db.flushNow()))
}

export async function preloadDatabase(databasePath: string): Promise<boolean> {
  if (preloaded.has(databasePath)) return true
  const exists = await ports.fs.exists(databasePath)
  if (!exists) return false
  const bytes = await ports.fs.readFile(databasePath)
  preloaded.set(databasePath, bytes)
  return true
}

/* ------------------------------- Statement ------------------------------- */

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

class Statement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly stmt: SqlJsStatement
  ) {}

  /**
   * sql.js / SQLite 抛出的错误（如 `column index out of range`）**完全不带上下文**：
   * 既没有语句文本也没有参数，只留一句裸错误，日志里根本无从定位。
   * 这里统一补上，代价只在失败路径上。
   */
  private reportFailure(operation: string, params: unknown[], err: unknown): never {
    console.error(`[sqlite] ${operation} 失败：${this.sql.trim().replace(/\s+/g, ' ')}`, { params }, err)
    throw err
  }

  run(...params: unknown[]): RunResult | void {
    try {
      this.stmt.reset()
      const values = resolveBoundParams(this.sql, params)
      if (values.length) this.stmt.bind(values as never)
      this.stmt.step()
      this.stmt.reset()
      this.db.markDirty()
      const changes = this.db.raw.getRowsModified()
      this.db.releaseResultSets?.()
      return { changes, lastInsertRowid: this.db.lastInsertRowid() }
    } catch (err) {
      this.reportFailure('run', params, err)
    }
  }

  get(...params: unknown[]): unknown {
    try {
      this.stmt.reset()
      const values = resolveBoundParams(this.sql, params)
      if (values.length) this.stmt.bind(values as never)
      try {
        if (!this.stmt.step()) return undefined
        return this.stmt.getAsObject()
      } finally {
        this.stmt.reset()
      }
    } catch (err) {
      this.reportFailure('get', params, err)
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      this.stmt.reset()
      const values = resolveBoundParams(this.sql, params)
      if (values.length) this.stmt.bind(values as never)
      const rows: unknown[] = []
      try {
        while (this.stmt.step()) rows.push(this.stmt.getAsObject())
      } finally {
        this.stmt.reset()
      }
      return rows
    } catch (err) {
      this.reportFailure('all', params, err)
    }
  }

  /** better-sqlite3 的 API 面里我们不需要它，但保持存在以免调用方崩溃 */
  raw(): never {
    throw new PortError('EUNSUPPORTED', 'stmt.raw() is not supported by the Android sql.js adapter')
  }
}

/* ------------------------------- Database ------------------------------- */

export interface DatabaseOptions {
  fileMustExist?: boolean
  readonly?: boolean
  nativeBinding?: string
  verbose?: (sql: string) => void
}

export default class Database {
  readonly name: string
  readonly raw: SqlJsDatabase
  private readonly statements = new Map<string, SqlJsStatement>()
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private flushing: Promise<void> | null = null

  constructor(databasePath: string, options: DatabaseOptions = {}) {
    this.name = databasePath
    const SQL = requireSqlJs()
    const bytes = preloaded.get(databasePath)
    if (!bytes && options.fileMustExist) {
      // 与 better-sqlite3 的 `fileMustExist: true` 语义一致：抛 SQLITE_CANTOPEN
      const error = new Error(`SQLITE_CANTOPEN: unable to open database file: ${databasePath}`) as Error & {
        code?: string
      }
      error.code = 'SQLITE_CANTOPEN'
      throw error
    }
    this.raw = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database()
    openDatabases.add(this)
  }

  prepare(sql: string): Statement {
    let raw = this.statements.get(sql)
    if (!raw) {
      raw = this.raw.prepare(sql)
      this.statements.set(sql, raw)
    }
    return new Statement(this, sql, raw)
  }

  exec(sql: string): void {
    this.raw.exec(sql)
    this.markDirty()
  }

  pragma(name: string, value?: unknown): unknown {
    const sql = value === undefined ? `PRAGMA ${name}` : `PRAGMA ${name} = ${String(value)}`
    // journal_mode=WAL 在内存库上无意义，sql.js 会返回 'memory'，调用方不看返回值
    const result = this.raw.exec(sql)
    return result
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const self = this
    const wrapped = (...args: Parameters<T>): ReturnType<T> => {
      self.raw.exec('BEGIN')
      try {
        const result = fn(...args)
        if (result instanceof Promise) {
          throw new PortError('EUNSUPPORTED', 'async transaction callbacks are not supported')
        }
        self.raw.exec('COMMIT')
        self.markDirty()
        return result as ReturnType<T>
      } catch (err) {
        self.raw.exec('ROLLBACK')
        throw err
      }
    }
    return wrapped as unknown as T
  }

  async backup(destPath: string): Promise<void> {
    const data = this.raw.export()
    await ports.fs.writeFileAtomic(destPath, data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    openDatabases.delete(this)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const statement of this.statements.values()) statement.free()
    this.statements.clear()
    this.raw.close()
    preloaded.delete(this.name)
  }

  lastInsertRowid(): number {
    const result = this.raw.exec('SELECT last_insert_rowid() AS id')
    const value = result[0]?.values[0]?.[0]
    return typeof value === 'number' ? value : 0
  }

  releaseResultSets(): void {
    /* sql.js 的 exec 结果已即时求值，无需释放；保留钩子便于将来换实现 */
  }

  markDirty(): void {
    if (this.closed) return
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushNow().catch((error: unknown) => console.error('[sqlite] scheduled flush failed', error))
    }, FLUSH_DEBOUNCE_MS)
  }

  isDirty(): boolean {
    return this.dirty
  }

  /** 强制落盘（生命周期钩子调用） */
  async flushNow(): Promise<void> {
    while (!this.closed) {
      if (this.flushing) {
        await this.flushing
        continue
      }
      if (!this.dirty) return
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = null
      this.dirty = false
      let data: Uint8Array
      try {
        data = this.raw.export()
      } catch (error) {
        this.dirty = true
        throw error
      }
      this.flushing = ports.fs
        .writeFileAtomic(this.name, data)
        .catch((error: unknown) => {
          this.dirty = true
          console.error('[sqlite] flush failed', error)
          throw error
        })
        .finally(() => {
          this.flushing = null
        })
      await this.flushing
      // 写盘期间可能有新写入；等当前写盘完成后再刷一次。
    }
  }
}

export { Database }

/** 供 smoke 测试与迁移工具使用：把内存库导出为 bytes */
export function exportDatabase(db: Database): Uint8Array {
  return db.raw.export()
}

export function importDatabase(bytes: Uint8Array): Database {
  const SQL = requireSqlJs()
  const instance = Object.create(Database.prototype) as Database
  Reflect.set(instance, 'name', 'imported')
  Reflect.set(instance, 'raw', new SQL.Database(Buffer.from(bytes)))
  return instance
}
