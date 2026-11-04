/**
 * `node:timers` 替身 —— WebView 只有 `setTimeout` 家族，Node 的 `Timeout` 对象额外带
 * `refresh()` / `unref()`，上游少量代码会调用，这里补上。
 */

export interface Timeout {
  refresh: () => void
  unref: () => void
  ref: () => void
  hasRef: () => boolean
  [Symbol.dispose]?: () => void
}

function wrap(handle: ReturnType<typeof setTimeout>): Timeout {
  return {
    refresh() {
      /* WebView 的 timeout 一旦建立无法重置计时，刷新语义退化为 no-op（上游仅用于心跳节流） */
    },
    unref() {
      /* 无事件循环句柄概念 */
    },
    ref() {
      /* 同上 */
    },
    hasRef() {
      return true
    },
    [Symbol.dispose]() {
      clearTimeout(handle)
    },
  }
}

export function setTimeout(callback: (...args: unknown[]) => void, ms?: number): Timeout {
  return wrap(globalThis.setTimeout(callback, ms))
}

export function clearTimeout(handle?: Timeout): void {
  handle?.[Symbol.dispose]?.()
}

export function setInterval(callback: (...args: unknown[]) => void, ms?: number): number {
  return globalThis.setInterval(callback, ms) as unknown as number
}

export function clearInterval(handle?: number): void {
  if (handle != null) globalThis.clearInterval(handle)
}

export default { setTimeout, clearTimeout, setInterval, clearInterval }
