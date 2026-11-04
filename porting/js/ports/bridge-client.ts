/**
 * Worker → 主线程 → AndroidBridge 的 RPC 客户端。
 *
 * ## 为什么必须有这一层
 * `@JavascriptInterface`（`AndroidBridge`）只注入到 WebView 的**主 frame**，Worker 里拿不到。
 * 因此 4 个 Worker 的所有原生调用路径固定为：
 *   worker --MessagePort--> UI 主线程 --AndroidBridge--> Kotlin(:bridge)
 * 全部异步，没有同步返回通道（唯一的同步边界在 db-worker 内的 WASM SQLite）。
 *
 * ## 帧格式
 * 见 `@porting/ports/m2c-frame`（message2call v2 数组帧）。这里只做三件事：
 * 1. 分配 `eventName`（`pathname.join('.') + '_' + rand'`），用它把响应配回请求；
 * 2. 维护「回调名 → 本地函数」表，把 `[2, callbackName, args]` 反推成函数调用；
 * 3. 超时与错误统一成 `PortError`。
 *
 * ## 为什么两端都传 JSON 字符串而不是结构化克隆的对象
 * Worker 发出的帧要**原样转发**给 Kotlin。如果 Worker 传对象，主线程就得再 `JSON.stringify` 一遍，
 * 等于编码两次、解析两次；传字符串则主线程只做一次 `JSON.parse` 看路由信息，转发时直接用原串。
 * 回调反推也走字符串，路径只有一条，两端不会出现「一边对象帧一边数组帧」的错位。
 */

import {
  CALL_TYPE,
  buildRequestFrame,
  decodeValue,
  encodeRequest,
  frameName,
  isBinaryEnvelope,
  parseFrame,
  type CallbackFn,
} from '@porting/ports/m2c-frame'
import { PortError, type PortErrorPayload } from '@porting/ports/types'

/** 默认超时。`0` 表示不超时（扫描/下载这类长任务必须显式传 0）。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** 调用方可拿到的释放句柄：用于手动注销一次性注册的回调（如 `fs.unwatch`） */
export interface CallHandle {
  release: () => void
}

export interface CallOptions {
  /** 0 = 不超时 */
  timeoutMs?: number
  /**
   * 请求结束后是否保留回调注册。
   * - `fs.listTree(onBatch)` / `http.downloadTo(onProgress)` → 不保留（默认）
   * - `fs.watch` / `lifecycle.on*` / `mediaSession.onControl` → 必须保留
   */
  keepCallbacks?: boolean
  /** 传入后由 client 回填 `release`，供调用方主动注销回调 */
  handle?: CallHandle
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
  /** 本次请求登记的回调名，响应到达后按 `keepCallbacks` 决定是否清除 */
  callbackNames: string[]
  keepCallbacks: boolean
}

/** 帧发送器：把一帧 JSON 字符串投递出去（Worker→MessagePort / 主线程→AndroidBridge） */
export type FrameSender = (frameJson: string) => void

export class BridgeClient {
  private readonly pending = new Map<string, PendingCall>()
  private readonly callbacks = new Map<string, CallbackFn>()
  private readonly send: FrameSender
  private closed = false

  constructor(send: FrameSender) {
    this.send = send
  }

  /** 当前登记的回调数量（调试 / 泄漏检查用） */
  get callbackCount(): number {
    return this.callbacks.size
  }

  /**
   * 发起一次原生调用。
   *
   * @param path   点号名（`'fs.stat'`）或路径数组（`['fs','stat']`）；Kotlin 侧按 `path[0]` 选模块、
   *               其余 join 成方法名，两种写法等价。
   * @param args   业务实参。顶层 `function` 会被自动替换成回调名并登记。
   */
  call<T = unknown>(
    path: string | readonly string[],
    args: readonly unknown[] = [],
    options: CallOptions = {}
  ): Promise<T> {
    if (this.closed) return Promise.reject(new PortError('EUNKNOWN', 'bridge client destroyed'))

    const pathname = typeof path === 'string' ? path.split('.') : [...path]
    if (!pathname.length || pathname.some((seg) => !seg)) {
      return Promise.reject(new PortError('EUNKNOWN', `invalid port path: ${String(path)}`))
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const encoded = encodeRequest(args, (name, fn) => {
      this.callbacks.set(name, fn)
    })
    const eventName = `${pathname.join('.')}_${nextSuffix()}`

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.settle(eventName, true, () => {
                reject(new PortError('ETIMEDOUT', `port call timeout: ${pathname.join('.')}`))
              })
            }, timeoutMs)
          : null

      this.pending.set(eventName, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        callbackNames: encoded.callbackNames,
        keepCallbacks: options.keepCallbacks === true,
      })

      if (options.handle) {
        options.handle.release = () => this.releaseCallbacks(encoded.callbackNames)
      }

      try {
        this.send(JSON.stringify(buildRequestFrame(eventName, pathname, encoded)))
      } catch (err) {
        this.settle(eventName, true, () => {
          reject(err instanceof PortError ? err : new PortError('EIO', errText(err)))
        })
      }
    })
  }

  /**
   * 收到一帧（来自 MessagePort 或 Kotlin）。
   *
   * 会消费的类型：
   * - `[1, eventName, error|null, result]` → 结清对应的 Promise
   * - `[2, callbackName, args]`            → 调用登记过的本地函数（流式事件）
   *
   * `[0, ...]`（原生反向请求）与 `[3, ...]`（回调响应）本工程不使用：
   * 所有"原生 → JS 的事件"都走 `[2,...]`（Kotlin 侧 `ctx.emit`），所以收到就告警丢弃。
   */
  handleFrame(frameJson: string): void {
    const frame = parseFrame(frameJson)
    if (!frame) return

    switch (frame[0]) {
      case CALL_TYPE.RESPONSE:
        this.handleResponse(frame)
        return
      case CALL_TYPE.CALLBACK_REQUEST:
        this.handleCallbackRequest(frame)
        return
      case CALL_TYPE.REQUEST:
        console.error('[bridge] unexpected inbound request frame from native, ignored')
        return
      case CALL_TYPE.CALLBACK_RESPONSE:
        console.error('[bridge] unexpected callback response from native, ignored')
        return
      default:
        console.error(`[bridge] unknown frame type: ${String(frame[0])}`)
    }
  }

  /** 主动注销一组回调（`fs.unwatch` / 组件卸载时用） */
  releaseCallbacks(names: readonly string[]): void {
    for (const name of names) this.callbacks.delete(name)
  }

  destroy(): void {
    this.closed = true
    for (const [eventName, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new PortError('ECANCELED', `bridge client destroyed: ${eventName}`))
    }
    this.pending.clear()
    this.callbacks.clear()
  }

  /* ---------------------------------------------------------------- */

  private handleResponse(frame: readonly unknown[]): void {
    const eventName = frameName(frame)
    if (!eventName) {
      console.error('[bridge] response frame without eventName')
      return
    }
    const rawError = frame[2]
    const result = frame[3]
    const hasError = rawError != null && typeof rawError === 'object' && !isBinaryEnvelope(rawError)

    this.settle(eventName, hasError, (pending) => {
      if (hasError) pending.reject(PortError.from(rawError as PortErrorPayload))
      else pending.resolve(decodeValue(result))
    })
  }

  private handleCallbackRequest(frame: readonly unknown[]): void {
    const callbackName = frameName(frame)
    if (!callbackName) {
      console.error('[bridge] callback frame without callbackName')
      return
    }
    const handler = this.callbacks.get(callbackName)
    if (!handler) {
      // 常见原因：请求已 end 且回调被释放，Kotlin 侧仍有残留监听（如 unwatch 后的事件）
      console.warn(`[bridge] callback not registered: ${callbackName}`)
      return
    }
    const rawArgs = frame[2]
    const args = Array.isArray(rawArgs) ? rawArgs.map(decodeValue) : []
    try {
      handler(...args)
    } catch (err) {
      // 回调里的异常不能污染 RPC 通道（否则后续帧全丢），记录后继续
      console.error(`[bridge] callback threw (${callbackName})`, err)
    }
  }

  /** 结清一个请求：清 timer、按需释放回调、再执行 resolve/reject */
  private settle(eventName: string, failed: boolean, action: (pending: PendingCall) => void): void {
    const pending = this.pending.get(eventName)
    if (!pending) return
    this.pending.delete(eventName)
    if (pending.timer) clearTimeout(pending.timer)
    // 失败路径一律释放回调：出错的流式接口不会再有任何后续事件
    if (failed || !pending.keepCallbacks) {
      this.releaseCallbacks(pending.callbackNames)
    }
    action(pending)
  }
}

function nextSuffix(): string {
  // 与 m2c-frame 的 nextRand 分开计数：避免 eventName 与 callbackName 共用计数器时的偶然同日
  suffixSeed += 1
  return `${Date.now().toString(36)}${suffixSeed.toString(36)}`
}

let suffixSeed = 0

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ *
 * 主线程 ⇄ Kotlin
 * ------------------------------------------------------------------ */

/** Kotlin 的 `ping()` 返回值前缀（`AndroidBridge.ping()` = `"anylisten-bridge/1"`） */
export const BRIDGE_PING_PREFIX = 'anylisten-bridge/'

/** 本端期望的桥协议版本，与 `AndroidBridge.ping()` 的后缀对齐 */
export const BRIDGE_PROTOCOL_VERSION = 1

/** 主线程 → Kotlin。`postMessage` 是**两个参数**（token + 帧），漏了 token 会被 Kotlin 直接丢弃。 */
export function sendToNative(frameJson: string): void {
  const bridge = window.AndroidBridge
  if (!bridge) throw new PortError('EUNSUPPORTED', 'AndroidBridge 未注入：当前不在 Android 壳里')
  const token = window.__ANYLISTEN_TOKEN__ ?? ''
  if (!token) {
    // Kotlin 用 token 拒绝「非首帧注入页面」的调用；空 token 一定是装配漏了，显式报错而不是静默失败
    throw new PortError('EACCES', 'window.__ANYLISTEN_TOKEN__ 缺失，桥调用会被 Kotlin 拒绝')
  }
  bridge.postMessage(token, frameJson)
}

/**
 * 主线程安装原生桥的接收端。
 * Kotlin 通过 `evaluateJavascript("window.__anylisten_bridge_recv__(...)")` 调用 ——
 * 这个名字是**硬约定**（`MainActivity.installBridge()`），改了就收不到任何回帧。
 */
export function installBridgeReceiver(handler: (frameJson: string) => void): void {
  window.__anylisten_bridge_recv__ = handler
}

/** 探活：返回 `null` 表示不在 Android 壳里（纯浏览器调试） */
export function pingNative(): { version: number; raw: string } | null {
  const bridge = window.AndroidBridge
  if (!bridge || typeof bridge.ping !== 'function') return null
  try {
    const raw = bridge.ping()
    const version = Number(raw.slice(BRIDGE_PING_PREFIX.length))
    return { version: Number.isFinite(version) ? version : 0, raw }
  } catch (err) {
    console.error('[bridge] ping failed', err)
    return null
  }
}
