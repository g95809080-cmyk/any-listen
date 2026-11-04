/**
 * `node:http` / `node:https` 替身。
 *
 * 类型全部沿用 `http-types.ts`（上游只用类型，如 `IncomingHttpHeaders` / `IncomingMessage`）。
 * 任何**实际**发起监听/请求的调用都抛错：Android 侧的 HTTP 服务端由 Kotlin 的
 * `LocalHttpServer` 提供（127.0.0.1:17930，同源 loopback，用于 AudioWorklet / Range 请求），
 * 客户端请求则必须走 `HttpPort`（见 `nodejs/request.ts`）。
 */

export * from '@porting/shims/http-types'

import { PortError } from '@porting/ports/types'

const unsupported = (name: string): never => {
  throw new PortError(
    'EUNSUPPORTED',
    `http.${name}() 不可用：Android 侧 HTTP 服务端由 Kotlin LocalHttpServer(127.0.0.1:17930) 提供，客户端请求请走 HttpPort`,
  )
}

export function createServer(): never {
  return unsupported('createServer')
}

export function request(): never {
  return unsupported('request')
}

export function get(): never {
  return unsupported('get')
}

export default { createServer, request, get }
