/**
 * 主线程的 Ports 集线器：把 4 个 Worker 的原生调用统一转发到 `AndroidBridge`。
 *
 * ## 路由模型（对应 message2call v2 的数组帧）
 * ```
 * Worker --(JSON 字符串)--> PortsHub --(原样转发)--> AndroidBridge.postMessage(token, json) --> Kotlin
 * Kotlin --(evaluateJavascript)--> window.__anylisten_bridge_recv__(json) --> PortsHub --(原样转发)--> Worker
 * ```
 *
 * 三条路由表：
 * | 表 | 键 | 何时写入 | 何时消费 |
 * |----|----|---------|---------|
 * | `eventRoutes`    | 请求的 `eventName` | Worker 发出请求时 | Kotlin 回 `[1,eventName,…]` 时，**消费即删** |
 * | `callbackRoutes` | 回调名 `func_<n>_<rand>` | Worker 发出请求时（按 `callbacks` 下标取实参） | Kotlin 推 `[2,cbName,args]` 时，**保留**（流式接口要持续推） |
 * | 主线程自己 | — | `PortsHub.client` 内部 | 上面两张表都没命中时兜底 |
 *
 * 关键点：**帧在整条链路上始终是同一个 JSON 字符串**，主线程只 `JSON.parse` 一次看路由信息，
 * 转发时用原串。这样 Worker 和 Kotlin 的编解码器各自只跑一遍，不会出现
 * 「一边对象帧一边数组帧」的错位，也省掉一次 stringify + 一次 parse。
 *
 * 为什么不再广播：早期版本没有双向回调，只能把原生事件广播给所有 worker 再用 subId 过滤。
 * 现在回调名是每次调用独立生成的（`func_<n>_<rand>`），按名字精确路由即可，
 * 不会被别的 worker 听到，也不需要 subId。
 */

import { CALL_TYPE, frameName, parseFrame } from '@porting/ports/m2c-frame'
import { BridgeClient, sendToNative } from '@porting/ports/bridge-client'
import { PortError } from '@porting/ports/types'

/** 回调路由表的上限；超过就扫一遍已注销的 port，防长跑进程缓慢泄漏 */
const CALLBACK_ROUTE_SOFT_LIMIT = 8192

interface RouteEntry {
  port: MessagePort
  /** 该请求登记的回调名，请求失败时一并清掉回调路由 */
  callbackNames: string[]
}

export class PortsHub {
  private readonly own: BridgeClient
  private readonly ports = new Set<MessagePort>()
  private readonly eventRoutes = new Map<string, RouteEntry>()
  private readonly callbackRoutes = new Map<string, MessagePort>()

  constructor() {
    this.own = new BridgeClient((frameJson) => sendToNative(frameJson))
  }

  /** 主线程也要能直接调原生（AudioEngineRouter / mediaSession / 生命周期） */
  get client(): BridgeClient {
    return this.own
  }

  registerPort(port: MessagePort): void {
    this.ports.add(port)
    port.addEventListener('message', (event: MessageEvent) => {
      this.handleWorkerFrame(port, event.data)
    })
    port.start()
  }

  unregisterPort(port: MessagePort): void {
    this.ports.delete(port)
    for (const [eventName, entry] of this.eventRoutes) {
      if (entry.port === port) this.eventRoutes.delete(eventName)
    }
    for (const [cbName, owner] of this.callbackRoutes) {
      if (owner === port) this.callbackRoutes.delete(cbName)
    }
  }

  /** Kotlin → JS 的入口（由 `installBridgeReceiver` 挂到 `window.__anylisten_bridge_recv__`） */
  handleNativeFrame(frameJson: string): void {
    const frame = parseFrame(frameJson)
    if (!frame) return

    switch (frame[0]) {
      case CALL_TYPE.RESPONSE: {
        const eventName = frameName(frame)
        const entry = this.eventRoutes.get(eventName)
        if (!entry) {
          // 不是 Worker 发起的 → 主线程自己的调用
          this.own.handleFrame(frameJson)
          return
        }
        this.eventRoutes.delete(eventName)
        this.postToWorker(entry.port, frameJson)
        return
      }
      case CALL_TYPE.CALLBACK_REQUEST: {
        const callbackName = frameName(frame)
        const owner = this.callbackRoutes.get(callbackName)
        if (owner) {
          this.postToWorker(owner, frameJson)
          return
        }
        this.own.handleFrame(frameJson)
        return
      }
      default:
        this.own.handleFrame(frameJson)
    }
  }

  destroy(): void {
    this.eventRoutes.clear()
    this.callbackRoutes.clear()
    this.ports.clear()
    this.own.destroy()
  }

  /* ---------------------------------------------------------------- */

  private handleWorkerFrame(port: MessagePort, data: unknown): void {
    if (typeof data !== 'string') {
      console.error('[ports-hub] worker 帧必须是 JSON 字符串，收到:', typeof data)
      return
    }
    const frame = parseFrame(data)
    if (!frame) return
    if (frame[0] !== CALL_TYPE.REQUEST) {
      console.error(`[ports-hub] worker 只允许发请求帧（0），收到 ${String(frame[0])}`)
      return
    }

    const eventName = frameName(frame)
    if (!eventName) {
      console.error('[ports-hub] worker 请求帧缺少 eventName')
      return
    }

    const args = Array.isArray(frame[3]) ? frame[3] : []
    const callbackIndexes = Array.isArray(frame[4]) ? frame[4] : []
    const callbackNames: string[] = []
    for (const index of callbackIndexes) {
      if (typeof index !== 'number') continue
      const name = args[index]
      if (typeof name !== 'string') continue
      callbackNames.push(name)
      this.callbackRoutes.set(name, port)
    }

    this.eventRoutes.set(eventName, { port, callbackNames })

    if (this.callbackRoutes.size > CALLBACK_ROUTE_SOFT_LIMIT) this.sweepDeadRoutes()

    try {
      sendToNative(data)
    } catch (err) {
      // 桥没注入 / token 缺失：立刻把错误回给发起方，不能让它挂到超时
      this.eventRoutes.delete(eventName)
      for (const name of callbackNames) this.callbackRoutes.delete(name)
      this.postToWorker(port, JSON.stringify(errorResponseFrame(eventName, err)))
    }
  }

  private postToWorker(port: MessagePort, frameJson: string): void {
    try {
      port.postMessage(frameJson)
    } catch (err) {
      // 端口已关闭（worker 被 terminate）：清掉它的路由，避免后续帧继续往里塞
      console.warn('[ports-hub] 回投 worker 失败，清理该端口的路由', err)
      this.unregisterPort(port)
    }
  }

  /** 扫掉指向「已注销 port」的回调路由（一次性回调没人主动释放，靠这里兜底） */
  private sweepDeadRoutes(): void {
    let removed = 0
    for (const [name, owner] of this.callbackRoutes) {
      if (this.ports.has(owner)) continue
      this.callbackRoutes.delete(name)
      removed += 1
    }
    if (removed > 0) console.info(`[ports-hub] swept ${removed} dead callback routes`)
  }
}

function errorResponseFrame(eventName: string, err: unknown): unknown[] {
  const payload =
    err instanceof PortError
      ? err.toPayload()
      : { code: 'EUNKNOWN' as const, message: err instanceof Error ? err.message : String(err) }
  return [CALL_TYPE.RESPONSE, eventName, payload, null]
}
