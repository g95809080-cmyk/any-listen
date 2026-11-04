/**
 * Worker → 主线程 Ports 通道装配 + 与上游 `exposeWorker()` 的桥接。
 *
 * 本文件覆写 `@any-listen/app/modules/worker/utils/worker.ts`。上游实现是 Node 语义：
 *
 * ```ts
 * parentPort?.once('message', (port) => { ... port instanceof MessagePort ... })
 * ```
 *
 * 在 Web Worker 里：
 * 1. 没有 `parentPort`，等价物是 `self`；
 * 2. 传进来的 MessagePort 是**原生** `MessagePort`，`instanceof` 自制的 Node 版类一定为 false。
 *
 * 因此改为直接对 `self` 注册一次性监听，并同时从 `event.ports[0]` 取 Ports 通道
 * （主线程用 `postMessage(subChannelPort, [portsChannel, subChannelPort])` 一次性投递）。
 *
 * 时序要求：`exposeWorker()` 必须在 worker 入口 **静态 import 链** 上被调用，
 * 这样监听器会在 worker 首轮同步求值期间就注册好；若改成 `await import()`，
 * 主线程先 postMessage 的消息可能在监听器就绪前被丢弃。
 */

import { createMessage2Call, type ReadObj } from 'message2call'

import { BridgeClient, setBridgeClient } from '@porting/ports'

/**
 * 每个 worker 一份 `BridgeClient`，发送侧写到自己的 Ports 通道上。
 *
 * 帧在这一层就是 **JSON 字符串**（message2call v2 的数组帧），不是为了省事：
 * 主线程要把它原样转发给 Kotlin，传对象等于让主线程再 stringify 一遍。
 */
/**
 * 暴露前钩子：在上游 `exposeWorker(obj)` 拿到 `obj` 之后、`createMessage2Call()` **之前**，
 * 给 worker 入口一次同步改写 `obj` 成员的机会。
 *
 * 为什么需要这一层：上游 `dbService/index.ts` 是 `void exposeWorker({ ...common, ...模块 })`，
 * 没有注入点；而 `obj.init()` 内部第一次 `new Database()` 之前必须先跑完 `initSqlite()` 与
 * `preloadDatabase()`（否则 `requireSqlJs()` 抛 EUNSUPPORTED，且 `preloaded` 为空会让
 * `fileMustExist: true` 打开失败 → 退化成空库 → 刷盘覆盖用户数据，见 `entries/db.worker.ts`）。
 * 又不能改上游 `index.ts` / `db.ts`（`db.ts` 是 DB 迁移入口，抄一份会静默跑旧版迁移），
 * 所以在桥接层留一个钩子。
 *
 * 时序：钩子必须在 worker 入口的**模块体里同步注册**。`exposeWorker()` 在静态 import 阶段
 * 就同步发起了 `receiveChannels()`，但它 `await` 的握手消息投递发生在后续任务里；
 * 钩子变量是在握手完成后才被读取的，所以同步 `setBeforeExpose()` 一定早于调用。
 * 反过来说：**不要在 `setBeforeExpose()` 之前 await 任何东西**。
 */
type BeforeExposeHook = (obj: Record<string, unknown>) => void | Promise<void>

let beforeExposeHook: BeforeExposeHook | null = null

/** 由 worker 入口（当前只有 `entries/db.worker.ts`）在模块体里同步调用 */
export function setBeforeExpose(hook: BeforeExposeHook): void {
  beforeExposeHook = hook
}

function installWorkerBridge(portsChannel: MessagePort): void {
  portsChannel.start()
  const client = new BridgeClient((frameJson) => {
    portsChannel.postMessage(frameJson)
  })
  portsChannel.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') {
      console.error('[worker] Ports 通道只接受 JSON 字符串帧，收到:', typeof event.data)
      return
    }
    client.handleFrame(event.data)
  })
  setBridgeClient(client)
}

/** 一次性取到主线程投递的两条通道 */
function receiveChannels(): Promise<{ messagePort: MessagePort; portsChannel: MessagePort | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('worker 未在 15s 内收到主线程的初始化消息'))
    }, 15_000)

    self.addEventListener(
      'message',
      (event: MessageEvent) => {
        clearTimeout(timer)
        const messagePort = event.data as unknown
        if (!(messagePort instanceof MessagePort)) {
          reject(new Error('worker 初始化消息的第一个参数必须是 MessagePort'))
          return
        }
        resolve({
          messagePort,
          portsChannel: event.ports[0] ?? null,
        })
      },
      { once: true },
    )
  })
}

/**
 * 上游签名：`exposeWorker<T>(obj)` → `Promise<Message2Call<T>>`。
 * 额外副作用：把 Ports 通道接上（`ports.*` 在本 worker 内即可用）。
 */
export const exposeWorker = async <T extends Record<string, unknown>>(
  obj: ReadObj,
): Promise<ReturnType<typeof createMessage2Call<T>>> => {
  const { messagePort, portsChannel } = await receiveChannels()

  if (portsChannel) {
    installWorkerBridge(portsChannel)
  } else {
    // 不是致命错误，但所有原生能力都会失败 —— 必须显式告警，不能静默
    console.error('[worker] 未收到 Ports 通道，原生能力（文件/网络/数据库落盘）将不可用')
  }

  // 暴露前钩子：必须在 createMessage2Call() 之前跑完 —— 否则主线程首条远端调用
  // 可能抢在包装生效前进到 obj.init，等于没包
  if (beforeExposeHook) await beforeExposeHook(obj as unknown as Record<string, unknown>)

  const message2call = createMessage2Call<T>({
    exposeObj: obj,
    isSendErrorStack: true,
    timeout: 0,
    sendMessage(data) {
      messagePort.postMessage(data)
    },
  })

  messagePort.addEventListener('message', (event: MessageEvent) => {
    message2call.message(event.data as never)
  })
  messagePort.start()

  return message2call
}
