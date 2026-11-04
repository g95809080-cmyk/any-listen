/**
 * `process` 替身。
 *
 * 关键点：
 * - `platform` 固定 `'android'`、`arch` 固定 `'arm64'`（PDR-008：单一 ABI）。
 *   上游 `getNativeName()` 会拼出 `android_arm64_v<ver>`，`nativeBindingPath` 因此毫无意义
 *   （`db.ts` 的 `nativeBinding` 参数在我们的 sql.js 适配器里被忽略）。
 * - `process.argv` 恒为空数组 → `parseEnvParams()` 返回空 cmdParams（Android 无命令行）。
 * - `on('exit')` 注册但不触发：真正的退出时机由 `LifecyclePort.onBeforeTerminate` 驱动。
 */

export const platform = 'android' as const
export const arch = 'arm64' as const
export const pid = 1
export const argv: string[] = []
export const execArgv: string[] = []
export const versions = {
  node: '0.0.0-android-shim',
  v8: '0.0.0',
} as const
export const env: Record<string, string | undefined> = {
  NODE_ENV: 'production',
}

export const exitCode = 0

export function cwd(): string {
  return '/'
}

export function uptime(): number {
  return Math.round(performance.now() / 1000)
}

export function hrtime(previous?: [number, number]): [number, number] {
  const now = performance.now()
  const seconds = Math.floor(now / 1000)
  const nanoseconds = Math.round((now % 1000) * 1e6)
  if (!previous) return [seconds, nanoseconds]
  let ds = seconds - previous[0]
  let dn = nanoseconds - previous[1]
  if (dn < 0) {
    ds -= 1
    dn += 1e9
  }
  return [ds, dn]
}

export function memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number } {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
  const used = perf.memory?.usedJSHeapSize ?? 0
  const total = perf.memory?.totalJSHeapSize ?? 0
  return { rss: total, heapTotal: total, heapUsed: used, external: 0 }
}

type Handler = (...args: unknown[]) => void
const listeners = new Map<string, Set<Handler>>()

export function on(event: string, handler: Handler): typeof process {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(handler)
  return process
}

export function once(event: string, handler: Handler): typeof process {
  const wrapper: Handler = (...args) => {
    off(event, wrapper)
    handler(...args)
  }
  return on(event, wrapper)
}

export function off(event: string, handler: Handler): typeof process {
  listeners.get(event)?.delete(handler)
  return process
}

export function emit(event: string, ...args: unknown[]): boolean {
  const set = listeners.get(event)
  if (!set || !set.size) return false
  for (const handler of [...set]) {
    try {
      handler(...args)
    } catch (err) {
      console.error(`[process] listener for "${event}" failed`, err)
    }
  }
  return true
}

/** 由 LifecyclePort.onBeforeTerminate 调用（见 entries/db.worker.ts） */
export function emitExit(): void {
  emit('exit', 0)
}

export function nextTick(handler: Handler, ...args: unknown[]): void {
  queueMicrotask(() => {
    handler(...args)
  })
}

/**
 * 不能真的终止 Worker：上游 `db.ts` 只在 exit 时 close DB，`createDirSync` 的失败分支会调用它。
 * 这里抛错让调用方感知（而不是静默继续）。
 */
export function exit(code = 0): never {
  throw new Error(`process.exit(${code}) is not supported on Android`)
}

const processShim = {
  platform,
  arch,
  pid,
  argv,
  execArgv,
  versions,
  env,
  exitCode,
  cwd,
  uptime,
  hrtime,
  memoryUsage,
  on,
  once,
  off,
  emit,
  emitExit,
  nextTick,
  exit,
}

export default processShim
