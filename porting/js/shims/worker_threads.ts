/**
 * `node:worker_threads` 替身 → Web Worker。
 *
 * 上游把 `node:worker_threads` 用在两个文件：
 * - `app/modules/worker/utils/index.ts`（worker 工厂：`new Worker(path.join(__dirname, ...))`）
 * - `app/modules/worker/utils/worker.ts`（`exposeWorker`：`parentPort.once('message')` + `port.on('message')`）
 *
 * 这两个文件**都已被 `porting/js/host/worker/*` 整体替换**（WebView 里不能用 `__dirname` 拼路径，
 * 必须 `new Worker(new URL('./x.worker.ts', import.meta.url), { type:'module' })`）。
 * 本 shim 保留同名接口，供其它潜在引用与测试使用。
 */

export const isMainThread: boolean = typeof window !== 'undefined' && typeof document !== 'undefined'

export const threadId = 0

/** 浏览器原生 MessagePort 即可满足 `port.on('message')` 的替代（用 addEventListener）。 */
export const MessagePort: typeof globalThis.MessagePort | undefined = globalThis.MessagePort

export interface MessagePortLike {
  postMessage(data: unknown): void
  close(): void
  on(event: 'message', handler: (data: unknown) => void): void
  once(event: 'message', handler: (data: unknown) => void): void
}

/**
 * 把浏览器 MessagePort 包成 Node 风格（`on('message', cb)`）。
 * 上游 `worker/utils/worker.ts` 用 `port instanceof MessagePort` 判断，所以包装后要保留原型链。
 */
export class NodeStyleMessagePort {
  private readonly sources = new WeakMap<globalThis.MessagePort, Set<(data: unknown) => void>>()

  constructor(private readonly port: globalThis.MessagePort) {}

  postMessage(data: unknown): void {
    this.port.postMessage(data)
  }

  close(): void {
    this.port.close()
  }

  on(event: 'message', handler: (data: unknown) => void): void {
    if (event !== 'message') throw new Error(`unsupported event: ${event}`)
    const listeners = this.port.addEventListener.bind(this.port)
    listeners('message', (e: Event) => {
      handler((e as MessageEvent).data)
    })
    let set = this.sources.get(this.port)
    if (!set) {
      set = new Set()
      this.sources.set(this.port, set)
    }
    set.add(handler)
    this.port.start?.()
  }
}

export function getParentPort(): NodeStyleMessagePort | null {
  if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
    const scope = self as unknown as { postMessage: (data: unknown) => void; close?: () => void }
    // WorkerGlobalScope 自身即可作为“父端口”使用
    return new NodeStyleMessagePort(scope as unknown as globalThis.MessagePort)
  }
  return null
}

export const parentPort = getParentPort()

export class Worker {
  constructor(scriptURL: string | URL) {
    throw new Error(
      `worker_threads.Worker is not supported on Android (received ${String(scriptURL)}). ` +
        'Use host/worker/index.ts, which creates Web Workers via new Worker(new URL(...), { type: "module" }).'
    )
  }
}

export default { Worker, MessagePort, parentPort, isMainThread, threadId }
