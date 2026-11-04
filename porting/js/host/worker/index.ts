/**
 * Worker 工厂 —— 覆写 `@any-listen/app/modules/worker/utils/index.ts`。
 *
 * 上游（Node）：
 * ```ts
 * const worker = new Worker(path.join(__dirname, './db-service.worker'))
 * const subChannel = new MessageChannel()
 * worker.postMessage(subChannel.port1, [subChannel.port1])
 * subChannel.port2.on('message', ...)
 * worker.on('exit', () => msg2call.destroy())
 * ```
 *
 * Android（WebView）差异，逐条对应：
 * 1. `path.join(__dirname, ...)` → 脚本 URL 由**主线程**用
 *    `new URL('./db.worker.ts', import.meta.url)` 算好后以字符串下发。
 *    worker 内部绝不自己拼 `import.meta.url`（构建后路径基准会变），这是 team-lead 的硬约束。
 * 2. 每个 worker 需要**两条**通道：业务 message2call 通道 + 原生 Ports 通道。
 *    两条在同一次 `postMessage` 里投递，`event.ports[0]` 即 Ports 通道
 *    （见 `host/worker/expose.ts`）。只发一条首消息 → 不存在「消息早于监听器」的竞态。
 * 3. Web Worker 没有 `exit` 事件，`terminate()` 也不触发回调。
 *    用 `WorkerHandle` 模拟 `on('exit'|'error'|'messageerror')` / `removeAllListeners()` / `terminate()`，
 *    让上游 `worker.ts` 的注册表逻辑（崩溃置空、重启前解绑）零改动复用。
 */

import { createMessage2Call, createProxyCallback, type ReadObj } from 'message2call'

export declare type DBSeriveTypes = WarpPromiseRecord<AnyListen.WorkerDBSeriveListTypes>
export declare type UtilSeriveTypes = WarpPromiseRecord<AnyListen.WorkerUtilSeriveTypes>
export declare type ExtensionSeriveTypes = WarpPromiseRecord<AnyListen.WorkerExtensionSeriveTypes>

/** 让上游的 `worker.on('exit'|'error'|'messageerror')` / `terminate()` / `removeAllListeners()` 可用 */
export class WorkerHandle {
  private readonly exitHandlers = new Set<() => void>()
  private readonly errorHandlers = new Set<(err: Error) => void>()
  private readonly messageErrorHandlers = new Set<(err: unknown) => void>()
  private terminated = false

  constructor(readonly worker: Worker) {
    worker.addEventListener('error', (event: ErrorEvent) => {
      const error = event.error instanceof Error ? event.error : new Error(event.message || 'worker error')
      for (const handler of this.errorHandlers) emitSafely(handler, error, '[worker] error handler threw')
    })
    worker.addEventListener('messageerror', (event: MessageEvent) => {
      for (const handler of this.messageErrorHandlers) {
        emitSafely(handler, event.data, '[worker] messageerror handler threw')
      }
    })
  }

  on(event: 'exit', handler: () => void): this
  on(event: 'error', handler: (err: Error) => void): this
  on(event: 'messageerror', handler: (err: unknown) => void): this
  on(event: 'exit' | 'error' | 'messageerror', handler: (...args: never[]) => void): this {
    if (event === 'exit') this.exitHandlers.add(handler as unknown as () => void)
    else if (event === 'error') this.errorHandlers.add(handler as unknown as (err: Error) => void)
    else this.messageErrorHandlers.add(handler as unknown as (err: unknown) => void)
    return this
  }

  removeAllListeners(): this {
    this.exitHandlers.clear()
    this.errorHandlers.clear()
    this.messageErrorHandlers.clear()
    return this
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    this.worker.terminate()
    for (const handler of this.exitHandlers) emitSafely(handler, undefined, '[worker] exit handler threw')
    this.exitHandlers.clear()
  }
}

function emitSafely<T>(handler: (value: T) => void, value: T, where: string): void {
  try {
    handler(value)
  } catch (err) {
    console.error(where, err)
  }
}

export interface WorkerFactoryOptions {
  /** 由主线程用 `new URL('./x.worker.ts', import.meta.url).href` 算出的脚本地址 */
  scripts: { db: string; util: string; extension: string }
  /**
   * 子 worker Ports 通道的**控制通道**（core → 主线程 hub）。
   *
   * 通道本身由 `spawn()` **每次新建**：`MessagePort` 只能被转移一次，
   * 复用同一条会让「重启扩展宿主」在第二次 `spawn()` 时抛 `DataCloneError`（ERR-010）。
   */
  workerPortsControl: MessagePort
}

let factoryOptions: WorkerFactoryOptions | null = null

export function configureWorkerFactory(options: WorkerFactoryOptions): void {
  factoryOptions = options
}

function requireOptions(): WorkerFactoryOptions {
  if (!factoryOptions) {
    throw new Error('configureWorkerFactory() 尚未调用：core.worker 必须在启动业务模块前配置子 worker')
  }
  return factoryOptions
}

interface SpawnedWorker<T> {
  service: ReturnType<typeof createMessage2Call<T>>['remote']
  handle: WorkerHandle
}

function spawn<T>(script: string, control: MessagePort, exposeObj: ReadObj): SpawnedWorker<T> {
  const worker = new Worker(script, { type: 'module', name: script })
  const subChannel = new MessageChannel()
  // 每次 spawn 一对新的 Ports 通道：worker 端随首条消息转移，UI 端交给主线程 hub
  const portsChannel = new MessageChannel()
  control.postMessage({ type: 'workerPortsChannel' }, [portsChannel.port2])

  const msg2call = createMessage2Call<T>({
    exposeObj,
    isSendErrorStack: true,
    timeout: 0,
    sendMessage(message) {
      // port2 是主线程侧，写到它就是写给 worker 的 port1
      subChannel.port2.postMessage(message)
    },
  })

  subChannel.port2.addEventListener('message', (event: MessageEvent) => {
    msg2call.message(event.data as never)
  })
  subChannel.port2.start()

  // 首条消息：port1 作为 message，ports[0] 是 Ports 通道
  worker.postMessage(subChannel.port1, [portsChannel.port1, subChannel.port1])

  const handle = new WorkerHandle(worker)
  handle.on('exit', () => {
    msg2call.destroy()
  })
  return { service: msg2call.remote, handle }
}

export const createDBServiceWorker = (onInited: () => void): DBSeriveTypes => {
  const options = requireOptions()
  const { service } = spawn<DBSeriveTypes>(options.scripts.db, options.workerPortsControl, {
    inited() {
      onInited()
    },
  })
  return service
}

export const createUtilServiceWorker = (
  onInited: () => void,
  exposedFuncs: Omit<AnyListen.WorkerUtilSeriveExposedTypes, 'inited'>,
): UtilSeriveTypes => {
  const options = requireOptions()
  const { service } = spawn<UtilSeriveTypes>(options.scripts.util, options.workerPortsControl, {
    inited() {
      onInited()
    },
    ...(exposedFuncs as unknown as ReadObj),
  })
  return service
}

export const createExtensionServiceWorker = (
  onInited: () => void,
  exposedFuncs: AnyListen.IPCExtension.MainIPCActions,
): { worker: WorkerHandle; service: ExtensionSeriveTypes } => {
  const options = requireOptions()
  const { service, handle } = spawn<ExtensionSeriveTypes>(
    options.scripts.extension,
    options.workerPortsControl,
    {
      inited() {
        onInited()
      },
      ...(exposedFuncs as unknown as ReadObj),
    },
  )
  return { worker: handle, service }
}

export { createProxyCallback as proxyCallback }
