/**
 * 全局垫片安装：`Buffer` / `setImmediate` / `clearImmediate` / `process`。
 *
 * 上游源码直接使用这些**全局**（非 import），例如 `scanMusics.ts:65` 的 `setImmediate`、
 * 49 处 `Buffer.*`。所有入口（main + 4 个 worker）必须在任何业务模块之前
 * `import '@porting/shims/globals'`。
 *
 * 注意：这里**故意不用 `declare global`**。`@types/node` 已把 `process` / `setImmediate`
 * 声明成 Node 的形状（`Process`、`NodeJS.Immediate`），再声明一次必然冲突（TS2403 / TS2300）。
 * 赋值走 `globalThis` 上的宽类型别名即可，运行期效果完全一样。
 */

import { Buffer } from '@porting/shims/buffer'
import processShim from '@porting/shims/process'

type ImmediateHandle = ReturnType<typeof setTimeout>
type ImmediateFn = (handler: (...args: unknown[]) => void, ...args: unknown[]) => ImmediateHandle
type ClearImmediateFn = (handle: ImmediateHandle) => void

interface InjectedGlobals {
  Buffer?: unknown
  process?: unknown
  setImmediate?: unknown
  clearImmediate?: unknown
}

const g = globalThis as unknown as InjectedGlobals

if (g.Buffer == null) g.Buffer = Buffer
if (g.process == null) g.process = processShim

const setImmediateImpl: ImmediateFn = (handler, ...args) =>
  setTimeout(() => {
    handler(...args)
  }, 0)

const clearImmediateImpl: ClearImmediateFn = (handle) => {
  clearTimeout(handle)
}

if (g.setImmediate == null) g.setImmediate = setImmediateImpl
if (g.clearImmediate == null) g.clearImmediate = clearImmediateImpl

/**
 * `__dirname` / `__filename` 兜底 —— **只做兜底，不当作正解**。
 *
 * Web Worker 里没有这两个 Node 全局。上游有几处直接引用它们（不是 import，所以 alias 拦不到），
 * 一旦被执行就是 `ReferenceError`，而且是**致命**的：`core.worker` 启动阶段抛错会让
 * `bootstrap` 走不完，UI 永久停在 `Loading...`（真机上踩过，日志只有一行
 * `[core.worker] 启动失败 Error: __dirname is not defined`）。
 *
 * 已知使用点（`pnpm build:all` 后在产物里 grep 可复现）：
 * 1. `web-server/src/app/modules/extension/index.ts:40`
 *    `readFile(joinPath(__dirname, 'extension-preload.js'))` —— **已用
 *    `host/app/modules/extension/index.ts` 改成 `fetch` 彻底修掉**（见该文件注释）；
 * 2. `shared/app/modules/worker/dbService/db.ts:32,47`
 *    `path.join(__dirname, nativeBindingPath)` —— `nativeBinding` 是 better-sqlite3 的原生
 *    addon 路径，Android 侧走 sql.js（`ports/sqlite.ts` 的 `DatabaseOptions` 收下但**完全不使用**
 *    这个字段），所以返回 `''` 让 `join` 退化成原字符串即可，行为无影响。
 *
 * 返回 `''` 而不是抛错：抛错会把"某个无关模块里的死代码"升级成启动失败。
 * 但**必须吵**——首次访问打一条带调用栈的 warning，否则将来真的需要这个路径时无从查起。
 */
const dirnameWarned = new Set<string>()

function warnNodePathGlobal(name: '__dirname' | '__filename'): void {
  if (dirnameWarned.has(name)) return
  dirnameWarned.add(name)
  const stack = new Error().stack?.split('\n').slice(1, 4).join('\n') ?? '(no stack)'
  console.warn(
    `[shims/globals] 上游代码访问了 Node 全局 ${name}，已返回空串。` +
      '如果这处路径真的被使用，需要为对应模块写 host/ 覆写（参考 host/app/modules/extension/index.ts）。\n' +
      stack
  )
}

for (const name of ['__dirname', '__filename'] as const) {
  if (name in globalThis) continue
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: false,
    get() {
      warnNodePathGlobal(name)
      return ''
    },
  })
}

export { Buffer, processShim as process }
export { setImmediateImpl as setImmediate, clearImmediateImpl as clearImmediate }
