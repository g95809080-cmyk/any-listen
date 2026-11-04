/**
 * `@any-listen/nodejs/request` 的 Android 实现 → `HttpPort`。
 *
 * 为什么不用 `fetch`：undici 的 `ProxyAgent` / `interceptors.retry` / `body.bytes()`
 * 在 fetch 里没有等价物，且应用级代理（`network.proxy.*` 4 项设置，R-10）必须能按请求注入 Proxy。
 * 因此请求整体落到 Kotlin 的 OkHttp（`HttpPort`），JS 只负责参数组装与响应解码。
 *
 * 与上游的语义差异（已在下游适配）：
 * - `needBody`（原 `Dispatcher.ResponseData['body']` 可流式读）→ 返回 `{ bytes(), text() }`。
 *   `strm.ts` 只用 `.bytes()`，因此行为等价；大文件由 `HttpPort` 落临时文件后读回。
 */

import { Buffer } from '@porting/shims/buffer'
import querystring from '@porting/shims/querystring'
import { ports, PortError, type HttpRequestOptions } from '@porting/ports'

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const DEFAULT_TIMEOUT = 15_000
const DEFAULT_MAX_REDIRECT = 5
const DEFAULT_RETRY_NUM = 3

const CONTENT_TYPE = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain',
  formdata: 'multipart/form-data',
  xml: 'application/xml',
  binary: 'application/octet-stream',
} as const

type ParamsData = Record<string, string | number | null | undefined | boolean>

export interface Options {
  method?:
    | 'GET'
    | 'HEAD'
    | 'POST'
    | 'PUT'
    | 'DELETE'
    | 'OPTIONS'
    | 'PATCH'
    | 'PROPFIND'
    | 'COPY'
    | 'MOVE'
    | 'MKCOL'
    | 'PROPPATCH'
    | 'QUOTA'
    | 'LOCK'
    | 'UNLOCK'
  query?: ParamsData
  headers?: Record<string, string | string[]>
  timeout?: number
  maxRedirect?: number
  signal?: AbortSignal
  json?: Record<string, unknown> | unknown[]
  form?: ParamsData
  binary?: Buffer | Uint8Array
  text?: string
  formdata?: Record<string, string | Buffer | Uint8Array>
  xml?: string
  needBody?: boolean
  needRaw?: boolean
  retryNum?: number
}

export interface NeedBodyType {
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
}

export interface Response<Res> {
  headers: Record<string, string | undefined>
  body: Res
  raw: Uint8Array
  statusCode?: number
  statusMessage?: string
  history: string[]
}

let proxyState: { host: string; port: string } | null = null

export const setProxy = (url?: string): void => {
  if (!url) {
    proxyState = null
    void ports.http.setProxy(null)
    return
  }
  const match = /^(?:https?:\/\/)?([^:/]+)(?::(\d+))?/.exec(url)
  if (!match) throw new Error(`invalid proxy url: ${url}`)
  proxyState = { host: match[1]!, port: match[2] ?? '80' }
  void ports.http.setProxy(proxyState)
}

export const setProxyByHost = (host?: string, port?: string): void => {
  setProxy(host ? `http://${host}:${port ?? '80'}` : undefined)
}

function buildQuery(query?: ParamsData): Record<string, unknown> | undefined {
  if (!query) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

interface BuiltBody {
  headers: Record<string, string>
  body?: string | Uint8Array
}

function buildBody(options: Options): BuiltBody {
  const headers: Record<string, string> = {}
  if (options.json != null) {
    headers['Content-Type'] = CONTENT_TYPE.json
    return { headers, body: JSON.stringify(options.json) }
  }
  if (options.form != null) {
    headers['Content-Type'] = CONTENT_TYPE.form
    return { headers, body: querystring.stringify(options.form) }
  }
  if (options.binary != null) {
    headers['Content-Type'] = CONTENT_TYPE.binary
    const bytes = options.binary instanceof Uint8Array ? options.binary : new Uint8Array(options.binary)
    return { headers, body: bytes }
  }
  if (options.formdata != null) {
    const boundary = `----AnyListenAndroid${Math.random().toString(16).slice(2)}`
    const chunks: Uint8Array[] = []
    for (const [key, value] of Object.entries(options.formdata)) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n`))
      chunks.push(typeof value === 'string' ? Buffer.from(value) : Buffer.from(value))
      chunks.push(Buffer.from('\r\n'))
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`))
    headers['Content-Type'] = `${CONTENT_TYPE.formdata}; boundary=${boundary}`
    return { headers, body: Buffer.concat(chunks) }
  }
  if (options.xml != null) {
    headers['Content-Type'] = CONTENT_TYPE.xml
    return { headers, body: options.xml }
  }
  if (options.text != null) {
    headers['Content-Type'] = CONTENT_TYPE.text
    return { headers, body: options.text }
  }
  return { headers }
}

function normalizeHeaders(headers?: Record<string, string | string[]>): Record<string, string> {
  const result: Record<string, string> = { 'User-Agent': DEFAULT_UA }
  if (!headers) return result
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

function parseBody(text: string, headers: Record<string, string | undefined>): unknown {
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? ''
  if (!contentType || contentType.includes(CONTENT_TYPE.json)) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

export const request = async <T = unknown>(url: string, options: Options = {}): Promise<Response<T>> => {
  const method = options.method?.toUpperCase() ?? 'GET'
  const built = buildBody(options)
  const headers = normalizeHeaders({ ...built.headers, ...(options.headers ?? {}) })

  const requestOptions: HttpRequestOptions = {
    method,
    headers,
    timeoutMs: options.timeout ?? DEFAULT_TIMEOUT,
    retryNum: options.retryNum ?? DEFAULT_RETRY_NUM,
    maxRedirect: options.maxRedirect ?? DEFAULT_MAX_REDIRECT,
  }
  const query = buildQuery(options.query)
  if (query) requestOptions.query = query
  if (built.body != null) requestOptions.body = built.body
  if (proxyState) requestOptions.proxy = proxyState

  const response = await ports.http.request(url, requestOptions)
  const responseHeaders = response.headers as Record<string, string | undefined>

  if (options.needBody) {
    const bytesProvider = async (): Promise<Uint8Array> => {
      if (response.raw) return response.raw
      if (response.filePath) return ports.fs.readFile(response.filePath)
      if (response.body != null) return Buffer.from(response.body)
      return new Uint8Array(0)
    }
    const body: NeedBodyType = {
      bytes: bytesProvider,
      text: async () => Buffer.from(await bytesProvider()).toString('utf8'),
    }
    return {
      headers: responseHeaders,
      statusCode: response.statusCode,
      body: body as unknown as T,
      history: response.history,
    } as Response<T>
  }

  if (options.needRaw) {
    const raw = response.raw ?? (response.filePath ? await ports.fs.readFile(response.filePath) : new Uint8Array(0))
    return {
      headers: responseHeaders,
      statusCode: response.statusCode,
      raw,
      history: response.history,
    } as Response<T>
  }

  const text = response.body ?? ''
  return {
    body: parseBody(text, responseHeaders) as T,
    headers: responseHeaders,
    statusCode: response.statusCode,
    history: response.history,
  } as Response<T>
}

export const verifyResource = async (url: string, opts: Options = {}): Promise<void> => {
  const resp = await request(url, {
    ...opts,
    timeout: opts.timeout ?? 5000,
    retryNum: 0,
    headers: {
      ...(opts.headers ?? {}),
      Range: 'bytes=0-1',
    },
  })
  if (!resp.statusCode || resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new PortError('EIO', `verify proxy request failed: [${url}] ${String(resp.statusCode)}`)
  }
}

export const verifyResourceBoolean = async (url: string, opts: Options = {}): Promise<boolean> =>
  verifyResource(url, opts)
    .then(() => true)
    .catch(() => false)

export default { request, setProxy, setProxyByHost, verifyResource, verifyResourceBoolean }
