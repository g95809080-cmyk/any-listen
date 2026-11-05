/**
 * ServerIPC 组装：把 `@any-listen/app/modules/*` 的全部能力通过 message2call 暴露给 WebView 主线程。
 *
 * 拓扑（Phase 2 §3.0）：
 *   UI 主线程 ──MessagePort──> core-worker（本文件所在线程）
 *   core-worker 侧把「UI」建模成一个虚拟 socket（`ServerSocket`），
 *   于是 `app/renderer/winMain/rendererEvent/*`（883 行 IPC 胶水，零改动复用）可以直接工作：
 *   - 入向：UI 调 `ipc.getSetting()` → msg2call → 这里 exposeObj 的 `getSetting(socket)`
 *   - 出向：`socket.remote.settingChanged(...)` → msg2call → UI 的 `clientCall.settingChanged`
 *
 * 注意：`onCallBeforeParams` 会把虚拟 socket 作为第一个参数注入，与 ws 版行为一致。
 */

import { createMessage2Call } from 'message2call'

import { randomUUID } from '@any-listen/nodejs'

import { appLog } from '@/shared/log4js'
import { socketEvent } from '@/modules/ipc/event'

import { registerSocket, removeSocket, type ServerSocket } from '@porting/host/modules/ipc/websocket'

let initialized = false
let initPromise: Promise<void> | null = null
let activePort: MessagePort | null = null
/** `new_socket` 自检监听器的反注册句柄（重连时先摘掉旧的，避免叠加） */
let offNewSocket: (() => void) | null = null

/**
 * `socketEvent` 的监听表（`@any-listen/nodejs/Event` 把 `listeners` 当公有字段，
 * 但 `EventType<E>` 把 `keyof Event` 全部 Omit 掉了，类型上取不到）。
 */
function newSocketListenerCount(): number {
  const holders = socketEvent as unknown as { listeners?: Map<string, unknown[]> }
  return holders.listeners?.get('new_socket')?.length ?? 0
}

/**
 * 初始化「IPC 服务端」。幂等，返回的 Promise 在 `rendererEvent` 注册表就绪后 resolve。
 *
 * **必须 `await` 之后再 `connectClient()`**（ERR-002）。原因有两层：
 * 1. 本函数内部是动态 `import()`，模块加载是异步的；
 * 2. `@any-listen/nodejs/Event.emit()` 用 `setImmediate` **异步派发**，
 *    所以 `connectClient()` 里的 `socketEvent.new_socket(socket)` 只是入队，
 *    派发时刻读的是**当时**的监听表 —— 若 `initWinMain()` 还没跑完，
 *    `rendererEvent` 的 `new_socket` 监听器不存在，`socket.onMessage` 就永远停在 `undefined`，
 *    UI 发出的每一帧都被 `socket.onMessage?.()` 静默吞掉（表现为 UI 卡在 Loading、日志全绿）。
 */
export function initServerIPC(): Promise<void> {
  if (initPromise) return initPromise
  initialized = true
  // 动态 import 避免循环依赖（rendererEvent → @/app/app → ports → …）
  initPromise = import('@/app/renderer/winMain').then(({ initWinMain }) => {
    initWinMain()
    // 就绪自检：没有监听器 = 后面所有入向帧都会被丢弃。宁可当场炸出明确错误，也不静默。
    if (newSocketListenerCount() < 1) {
      throw new Error(
        '[ipc] initWinMain() 已执行，但 rendererEvent 未注册 new_socket 监听：' +
          'UI→core 方向的帧将全部被丢弃（UI 会卡在 Loading）。检查 rendererEvent 的 init() 是否真的跑到了 socketEvent.on。'
      )
    }
  })
  return initPromise
}

export interface ConnectOptions {
  /** UI 主线程过来的消息通道 */
  port: MessagePort
  winType?: 'main' | 'desktopLyric'
}

/**
 * 接入 WebView 客户端。
 * 必须 `await initServerIPC()` 之后才能调用（否则 rendererEvent 的监听器尚未注册）。
 */
export function connectClient({ port, winType = 'main' }: ConnectOptions): ServerSocket {
  if (!initialized) throw new Error('connectClient() 前必须先 await initServerIPC()')
  if (activePort) {
    // 只有一个 WebView 主 frame；重复接入时先断开旧的，避免双份 msg2call
    activePort.close()
    activePort = null
  }
  activePort = port

  const socket: ServerSocket = {
    aliveTime: Date.now(),
    isReady: false,
    isInited: false,
    winType,
    keyInfo: { clientId: randomUUID(), timestamp: Date.now() },
    // 下面两个属性由 rendererEvent 的 message2call 建好后赋值
    remote: null as never,
    remoteQueueTheme: null as never,
    remoteQueuePlayer: null as never,
    remoteQueueList: null as never,
    remoteQueueDislike: null as never,
    remoteQueueSync: null as never,
    remoteQueueExtension: null as never,
    remoteExtension: null as never,
    sendMessage(message: unknown) {
      port.postMessage(message)
    },
    onClose(handler) {
      port.addEventListener('close', () => {
        void handler(new Error('webview port closed'))
      })
      return () => {
        /* MessagePort 无 removeEventListener 语义的 close 回调，忽略 */
      }
    },
  }

  // 入向消息 → rendererEvent 注册的 msg2call
  //
  // 这里必须缓冲：`socket.onMessage` 的装配发生在 `socketEvent.new_socket()` 的
  // `setImmediate`（生产环境跑的是 `setTimeout(…, 0)`，宏任务）里，而 UI 早在 core 启动
  // 完成前就把 `getAppInfo` / `getSetting` / … 排进了这个 MessagePort —— `port.start()`
  // 会**立刻**派发这批已排队消息，早于上面那个定时器。不缓冲就会被 `socket.onMessage?.()`
  // 静默吞掉，表现为首屏那几帧永远没有回帧（ERR-002 的孪生问题）。
  const pending: unknown[] = []
  let flushed = false

  port.addEventListener('message', (event: MessageEvent) => {
    if (flushed) {
      socket.onMessage?.(event.data)
      return
    }
    pending.push(event.data)
  })
  // 先挂监听再 start()：`start()` 会立刻开始派发已排队的消息，监听器必须先就位。
  port.start()

  registerSocket(socket)
  // TypeScript 指向上游 ws 类型；Android 构建实际注入的是 MessagePort 虚拟 socket。
  const androidSocketEvent = socketEvent as unknown as { new_socket(value: ServerSocket): void }
  androidSocketEvent.new_socket(socket)
  // 本监听器注册在 `rendererEvent` 之后，而 `Event.emit` 按注册顺序**同步**遍历，
  // 所以跑到这里时上游那个监听器已经把 `socket.onMessage` 装配好了。
  offNewSocket?.()
  offNewSocket = socketEvent.on('new_socket', (s) => {
    if (s !== socket) return
    if (typeof socket.onMessage !== 'function') {
      appLog.error('[ipc] new_socket 已派发，但 socket.onMessage 仍未装配：UI→core 的所有帧都会被丢弃')
      return
    }
    flushed = true
    const frames = pending.splice(0)
    if (frames.length) appLog.info(`[ipc] 补投 ${frames.length} 帧（到达时间早于 onMessage 装配）`)
    for (const frame of frames) socket.onMessage(frame)
  })
  appLog.info(`[ipc] webview client connected (${winType})`)

  return socket
}

export function disconnectClient(): void {
  offNewSocket?.()
  offNewSocket = null
  if (activePort) activePort.close()
  activePort = null
}

export function isClientConnected(): boolean {
  return activePort != null
}

export { removeSocket }
export type { ServerSocket }
export { createMessage2Call }
