/**
 * DB worker 入口。
 *
 * 承载 `@any-listen/app/modules/worker/dbService`（全部 SQLite 操作）。
 * 这一层不需要任何 Android 特有代码 —— 平台差异已经在三处消化掉了：
 * - `better-sqlite3` → `ports/sqlite.ts`（sql.js WASM，vite alias 完成）
 * - `exposeWorker()` → `host/worker/expose.ts`（覆写 `shared/app/modules/worker/utils/worker.ts`）
 * - `init()` / `backupDB()` 的引导 → 本文件的暴露前钩子（见下）
 *
 * **必须是静态 import**：`exposeWorker()` 要在首轮同步求值里注册好 message 监听器，
 * 否则主线程抢先投递的首条消息会被丢弃。改成 `await import()` 会引入竞态。
 *
 * ---
 *
 * ## 为什么这里要包一层 `init` / `backupDB`
 *
 * `ports/sqlite.ts` 的 `Database` 是**同步**构造的（292 处同步调用点 + 41 处函数式事务，
 * 改异步等于重写 `dbService`），所以它只能从 `preloaded` 这张内存表里同步取库文件内容。
 * 而把库读进 `preloaded` 的 `preloadDatabase()` 是异步的、上游没有任何调用点：
 *
 * - **不预载的后果一**：`new Database(p, { fileMustExist: true })` 必抛 `SQLITE_CANTOPEN`，
 *   `db.ts:56` 的 catch 分支退化成建空库 → `dbFileExists = false` → `migrateData()` 被跳过 →
 *   `verifyDB()` 对空库的新表当然是 pass → `init()` 返回 `false`（当作全新安装）。
 *   用户在 `anylisten.data.db` 里的曲库读不出来，**紧接着 1.5s debounce 刷盘就把空库写回磁盘 = 真丢数据**。
 * - **不预载的后果二**：`backupDB()` 内部同样 `new Database(databasePath)`，会「备份」出一个空库，
 *   然后 `removeDB(dataPath)` 把原文件删掉。
 *
 * `initSqlite()` 同理：`requireSqlJs()` 在 sql.js 未加载时抛 `EUNSUPPORTED`
 * （真机日志那句 `sql.js is not initialized, call initSqlite() at worker startup`）。
 *
 * 这两个函数**没有合法的调用点可以加在上游** —— `dbService/index.ts` 直接
 * `void exposeWorker({ ... })`，`db.ts` 又是 DB 迁移入口不能碰（抄一份会静默跑旧版迁移）。
 * 所以在桥接层用 `setBeforeExpose()` 在暴露前把这两个函数包住。
 *
 * ## 四条契约（别改）
 *
 * 1. **`preloaded` 的 key 必须与上游逐字节相同**。`db.ts:31 / 46` 用的是
 *    `path.join(dataPath, DB_NAME)`，这里也必须用 `node:path`（→ `shims/path`）的同一个实现
 *    产出同一个串，否则 `preloaded.get()` 照样 miss，白忙。
 * 2. **`setBeforeExpose()` 在模块体里同步执行**，前面不能有 `await`（理由见 `host/worker/expose.ts`）。
 *    不要写成顶层 `await initSqlite()` —— 那会让 wasm 加载期间到达的握手消息在 `obj.init`
 *    被包之前就进来。
 * 3. **`Database` 的同步契约不动**：`new Database()` 永远同步，异步只发生在它之前。
 * 4. **`locateFile` 用默认的 `/wasm/${file}`**，不要在这里再引别的 wasm 初始化逻辑。
 *    产物里是 `sql-wasm-browser.js`（sql.js 的 exports 走 `browser` 条件），它请求
 *    `/wasm/sql-wasm-browser.wasm`；`public/wasm/` 里的文件名必须与之一致，
 *    由 `scripts/copy-wasm.mjs` 的 FILES 表保证，`pnpm smoke` 有一道通用 wasm 引用门禁兜住。
 */

import path from 'node:path'

import { DB_NAME } from '@any-listen/common/constants'

import '../shims/globals'

import { initSqlite, preloadDatabase } from '../ports/sqlite'
import { setBeforeExpose } from '../host/worker/expose'

import '@any-listen/app/modules/worker/dbService/index'

/** 上游 `db.ts` 的签名（照抄；上游改签名这里要跟着改） */
type DbInit = (
  dataPath: string,
  nativeBindingPath: string,
  machineId: string,
  backupPath?: string
) => Promise<boolean | null>
type DbBackup = (dataPath: string, nativeBindingPath: string, backupPath: string) => Promise<void>

/**
 * 上游对象是 `{ ...common, ...十几个模块 }` 拼出来的，缺函数说明上游导出结构变了 ——
 * 必须响亮失败。静默跳过等于「初始化没做但程序继续跑」，正好会踩上面那条丢数据路径。
 */
function requireFn<T>(value: unknown, name: string): T {
  if (typeof value !== 'function') {
    throw new Error(
      `[db.worker] 上游 dbService 未导出 ${name}()，SQLite 引导无法挂载（上游导出结构可能已变）`
    )
  }
  return value as T
}

setBeforeExpose(async (obj) => {
  const initFn = requireFn<DbInit>(obj.init, 'init')
  const backupFn = requireFn<DbBackup>(obj.backupDB, 'backupDB')

  const bootstrap = async (dataPath: string): Promise<void> => {
    await initSqlite()
    // 这个串必须和上游 db.ts 里 `path.join(dataPath, DB_NAME)` 完全一致
    const databasePath = path.join(dataPath, DB_NAME)
    const preloaded = await preloadDatabase(databasePath)
    // 真机排障用：preloaded=false 表示磁盘上还没有库文件（全新安装，或已被 backupDB 删掉）
    console.log(`[db.worker] sqlite ready | db=${databasePath} preloaded=${String(preloaded)}`)
  }

  obj.init = async (dataPath: string, nativeBindingPath: string, machineId: string, backupPath?: string) => {
    await bootstrap(dataPath)
    return initFn(dataPath, nativeBindingPath, machineId, backupPath)
  }

  // backupDB 内部也会 `new Database(...)`：不预载会「备份」出一个空库并把原文件删掉
  obj.backupDB = async (dataPath: string, nativeBindingPath: string, backupPath: string) => {
    await bootstrap(dataPath)
    return backupFn(dataPath, nativeBindingPath, backupPath)
  }
})
