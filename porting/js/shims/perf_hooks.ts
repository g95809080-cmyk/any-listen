/**
 * `node:perf_hooks` 替身 —— WebView 有同名的 `performance` 全局，直接用。
 */

export const performance = globalThis.performance

export const PerformanceObserver = globalThis.PerformanceObserver

export const now = (): number => globalThis.performance.now()

export default { performance, PerformanceObserver, now }
