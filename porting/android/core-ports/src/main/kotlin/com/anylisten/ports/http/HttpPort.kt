package com.anylisten.ports.http

data class ProxySpec(val host: String, val port: Int)

data class HttpRequestOptions(
  val method: String = "GET",
  val headers: Map<String, String> = emptyMap(),
  val query: Map<String, String> = emptyMap(),
  val body: ByteArray? = null,
  val bodyFilePath: String? = null,
  val timeoutMs: Long = 30_000,
  val retryNum: Int = 0,
  val maxRedirect: Int = 5,
  val needRaw: Boolean = false,
  val proxy: ProxySpec? = null,
  /** 取消令牌 id：JS 侧先 `cancel(id)` 可中断进行中的请求 */
  val signalId: String? = null,
)

data class HttpResponseData(
  val statusCode: Int,
  val headers: Map<String, String>,
  val body: String? = null,
  val raw: ByteArray? = null,
  val filePath: String? = null,
  val history: List<String> = emptyList(),
)

data class DownloadProgress(val downloaded: Long, val total: Long, val speed: Long)

data class DownloadResult(val filePath: String, val size: Long, val sha256: String)

/**
 * HTTP 端口（§4.4）。OkHttp 实现，理由：需要**按请求注入代理**（`network.proxy.*` 4 项设置要生效）
 * 与大文件流式落盘。
 *
 * 语义与上游 `@any-listen/nodejs/request`（undici）对齐：
 * - 小 body 直接返回字节/字符串；> [HttpPortImpl.MAX_INLINE_BODY] 落临时文件返回 `filePath`
 *   （对应 `request.ts` 的 `needBody`/`body.bytes()` 两条分支，`strm.ts` 依赖后者）
 * - `statusCode` 为 0 表示网络层失败（上游同样用 `!resp.statusCode` 判定）
 */
interface HttpPort {
  suspend fun request(url: String, opts: HttpRequestOptions): HttpResponseData
  suspend fun downloadTo(
    url: String,
    destPath: String,
    headers: Map<String, String> = emptyMap(),
    timeoutMs: Long = 60_000,
    proxy: ProxySpec? = null,
    signalId: String? = null,
    onProgress: (DownloadProgress) -> Unit,
  ): DownloadResult

  suspend fun cancel(id: String)
  suspend fun setProxy(proxy: ProxySpec?)

  /** JS 侧 `fetch` 走本地代理时的出口（`/p_url` 复用同一实现） */
  suspend fun proxyRequestByUrl(url: String, headers: Map<String, String>): HttpResponseData?
  suspend fun proxyRequestByName(name: String, headers: Map<String, String>): HttpResponseData?

  /** `/p_static` 的注册表：JS 侧 `createProxy()` 后把 name → url 同步过来 */
  fun registerProxyTarget(name: String, url: String, headers: Map<String, String>)
  fun unregisterProxyTarget(name: String)
}
