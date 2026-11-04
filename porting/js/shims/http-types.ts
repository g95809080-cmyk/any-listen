/**
 * `node:http` 替身 —— **仅类型**。
 *
 * 上游 `modules/proxyServer/proxy.ts:2` 只 `import type { IncomingHttpHeaders }`（编译期擦除），
 * `proxy.ts:3` 的 `PassThrough` 走 `node:stream`。Android 侧不存在本地 HTTP 服务端
 * （SPA 与音频流由 **Kotlin** 的 `LocalHttpServer` 承担，见 Phase 2 §3.3），
 * 因此这里不提供 `createServer`：调用即抛错，避免误以为能起服务。
 */

export interface IncomingHttpHeaders {
  [header: string]: string | string[] | undefined
}

export interface OutgoingHttpHeaders {
  [header: string]: number | string | string[] | undefined
}

export interface RequestOptions {
  method?: string
  headers?: OutgoingHttpHeaders
  timeout?: number
}

export class Agent {
  constructor(readonly options?: Record<string, unknown>) {}
}

export class ClientRequest {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

export class IncomingMessage {
  statusCode?: number
  statusMessage?: string
  headers: IncomingHttpHeaders = {}
  complete = true
}

export function createServer(): never {
  throw new Error(
    'node:http.createServer is not available on Android: the local HTTP server lives in Kotlin (:bridge LocalHttpServer)'
  )
}

export function request(): never {
  throw new Error('node:http.request is not available on Android: use @any-listen/nodejs/request (→ HttpPort)')
}

export default { Agent, ClientRequest, IncomingMessage, createServer, request }
