/**
 * main ⇄ core.worker 的首条控制消息。
 *
 * 单独拆一个 **type-only** 文件：`core.worker.ts` 与 `main.ts` 都要用到这个形状，
 * 但两边都不能把对方的实现拉进自己的 bundle（core 里有 `new Worker(...)`，
 * 主线程里没有 `PortsHub` 的替代品，互相 import 会直接造成循环 + 重复打包）。
 */

export interface BootstrapMessage {
  type: 'bootstrap'
  /** 3 个子 worker 的脚本地址（由主线程用 `new URL(...).href` 算好） */
  scripts: { db: string; util: string; extension: string }
}

export function isBootstrapMessage(data: unknown): data is BootstrapMessage {
  if (typeof data !== 'object' || data === null) return false
  const typed = data as { type?: unknown; scripts?: unknown }
  if (typed.type !== 'bootstrap') return false
  const scripts = typed.scripts as { db?: unknown; util?: unknown; extension?: unknown } | null | undefined
  if (typeof scripts !== 'object' || scripts === null) return false
  return typeof scripts.db === 'string' && typeof scripts.util === 'string' && typeof scripts.extension === 'string'
}
