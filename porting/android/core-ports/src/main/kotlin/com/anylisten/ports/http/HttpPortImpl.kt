package com.anylisten.ports.http

import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.toPortException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * OkHttp 实现。线程模型：所有方法在 `Dispatchers.IO`，回调经 `suspendCancellableCoroutine`
 * 转成挂起点 —— 协程取消时自动 `call.cancel()`，不留悬挂连接。
 */
class HttpPortImpl(
  private val tempDir: File,
  private val userAgent: String,
) : HttpPort {

  private val calls = ConcurrentHashMap<String, Call>()
  private val proxyTargets = ConcurrentHashMap<String, ProxyTarget>()

  @Volatile private var appProxy: ProxySpec? = null

  private val baseClient: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .writeTimeout(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .retryOnConnectionFailure(true)
    .followRedirects(true)
    .followSslRedirects(true)
    .build()

  private data class ProxyTarget(val url: String, val headers: Map<String, String>)

  // ---------------------------------------------------------------- request

  override suspend fun request(url: String, opts: HttpRequestOptions): HttpResponseData {
    val absolute = buildUrl(url, opts.query)
      ?: throw PortException(PortErrorCode.EIO, "invalid url: $url", url)
    var lastError: Throwable? = null
    val attempts = opts.retryNum.coerceAtLeast(0) + 1
    for (attempt in 0 until attempts) {
      try {
        return execute(absolute, opts)
      } catch (e: PortException) {
        throw e
      } catch (e: Throwable) {
        lastError = e
        if (attempt == attempts - 1) break
      }
    }
    throw (lastError ?: IOException("request failed")).toPortException()
  }

  private suspend fun execute(absolute: String, opts: HttpRequestOptions): HttpResponseData {
    val request = buildRequest(absolute, opts)
    val client = clientFor(opts.proxy)
    val response = client.newCall(request).await(opts.signalId)
    response.use { resp ->
      val length = resp.body?.contentLength() ?: -1L
      val contentType = resp.header("Content-Type")
      val headers = flattenHeaders(resp)
      val history = buildHistory(resp)
      if (length > MAX_INLINE_BODY) {
        // 大文件（音频/压缩包）：落临时文件，JS 侧按 filePath 读
        val file = File(tempDir, "http-${System.nanoTime()}.bin")
        file.parentFile?.let { if (!it.exists()) it.mkdirs() }
        resp.body?.byteStream()?.use { input ->
          file.outputStream().use { output -> input.copyTo(output, BUFFER_SIZE) }
        }
        return HttpResponseData(
          statusCode = resp.code,
          headers = headers,
          filePath = file.absolutePath,
          history = history,
        )
      }
      val bytes = resp.body?.bytes()
      val text = if (opts.needRaw) null else bytes?.toString(charsetOf(contentType))
      return HttpResponseData(
        statusCode = resp.code,
        headers = headers,
        body = text,
        raw = if (opts.needRaw) bytes else null,
        filePath = null,
        history = history,
      )
    }
  }

  private fun buildRequest(absolute: String, opts: HttpRequestOptions): Request {
    val builder = Request.Builder().url(absolute)
    var hasUserAgent = false
    opts.headers.forEach { (k, v) ->
      if (k.equals("user-agent", ignoreCase = true)) hasUserAgent = true
      runCatching { builder.header(k, v) }
    }
    if (!hasUserAgent && userAgent.isNotEmpty()) builder.header("User-Agent", userAgent)

    val method = opts.method.uppercase()
    val body = when {
      opts.body != null -> opts.body.toRequestBody(null)
      opts.bodyFilePath != null -> File(opts.bodyFilePath).asRequestBody(null)
      method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody(null)
      else -> null
    }
    // GET/HEAD 不允许带 body；其余按 method 构造（OkHttp 会用 method 覆盖）
    builder.method(method, body)
    return builder.build()
  }

  private suspend fun Call.await(signalId: String?): Response = suspendCancellableCoroutine { cont ->
    if (signalId != null) calls[signalId] = this
    enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        if (signalId != null) calls.remove(signalId)
        if (cont.isCancelled) return
        cont.resumeWithException(e)
      }

      override fun onResponse(call: Call, response: Response) {
        if (signalId != null) calls.remove(signalId)
        cont.resume(response)
      }
    })
    cont.invokeOnCancellation {
      runCatching { cancel() }
      if (signalId != null) calls.remove(signalId)
    }
  }

  // ---------------------------------------------------------------- download

  override suspend fun downloadTo(
    url: String,
    destPath: String,
    headers: Map<String, String>,
    timeoutMs: Long,
    proxy: ProxySpec?,
    signalId: String?,
    onProgress: (DownloadProgress) -> Unit,
  ): DownloadResult = withContext(Dispatchers.IO) {
    val absolute = buildUrl(url, emptyMap())
      ?: throw PortException(PortErrorCode.EIO, "invalid url: $url", url)
    val request = buildRequest(
      absolute,
      HttpRequestOptions(headers = headers, timeoutMs = timeoutMs, proxy = proxy, signalId = signalId),
    )
    val client = clientFor(proxy, timeoutMs)
    val resp = client.newCall(request).await(signalId)
    resp.use { response ->
      if (!response.isSuccessful) {
        throw PortException(
          PortErrorCode.EIO,
          "download failed: HTTP ${response.code} $url",
          "status=${response.code}",
        )
      }
      val total = response.body?.contentLength() ?: -1L
      val dest = File(destPath)
      dest.parentFile?.let { if (!it.exists()) it.mkdirs() }
      val tmp = File(dest.parentFile, "${dest.name}.part")
      val digest = MessageDigest.getInstance("SHA-256")
      var downloaded = 0L
      var lastReport = 0L
      var lastBytes = 0L
      tmp.outputStream().use { output ->
        response.body?.byteStream()?.use { input ->
          val buffer = ByteArray(BUFFER_SIZE)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            output.write(buffer, 0, read)
            digest.update(buffer, 0, read)
            downloaded += read
            val now = System.currentTimeMillis()
            if (now - lastReport >= PROGRESS_INTERVAL_MS) {
              val speed = ((downloaded - lastBytes) * 1000f / (now - lastReport).toFloat()).toLong()
              onProgress(DownloadProgress(downloaded, total, speed))
              lastReport = now
              lastBytes = downloaded
            }
          }
        }
      }
      if (!tmp.renameTo(dest)) {
        tmp.copyTo(dest, overwrite = true)
        tmp.delete()
      }
      onProgress(DownloadProgress(downloaded, total, 0))
      DownloadResult(
        filePath = dest.absolutePath,
        size = downloaded,
        sha256 = digest.digest().joinToString("") { "%02x".format(it) },
      )
    }
  }

  override suspend fun cancel(id: String) {
    calls.remove(id)?.let { runCatching { it.cancel() } }
  }

  override suspend fun setProxy(proxy: ProxySpec?) {
    appProxy = proxy
  }

  // ---------------------------------------------------------------- proxy server support

  override suspend fun proxyRequestByUrl(url: String, headers: Map<String, String>): HttpResponseData? {
    val clean = filterRequestHeaders(headers)
    val opts = HttpRequestOptions(headers = clean, needRaw = true, timeoutMs = 30_000)
    return runCatching { request(url, opts) }.getOrElse { null }
  }

  override suspend fun proxyRequestByName(name: String, headers: Map<String, String>): HttpResponseData? {
    val target = proxyTargets[name] ?: return null
    val merged = filterRequestHeaders(headers) + target.headers
    val opts = HttpRequestOptions(headers = merged, needRaw = true, timeoutMs = 30_000)
    return runCatching { request(target.url, opts) }.getOrElse { null }
  }

  override fun registerProxyTarget(name: String, url: String, headers: Map<String, String>) {
    proxyTargets[name] = ProxyTarget(url, headers)
  }

  override fun unregisterProxyTarget(name: String) {
    proxyTargets.remove(name)
  }

  // ---------------------------------------------------------------- helpers

  private fun clientFor(proxy: ProxySpec?, timeoutMs: Long? = null): OkHttpClient {
    val spec = proxy ?: appProxy
    val builder = baseClient.newBuilder()
    if (spec != null) {
      builder.proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(spec.host, spec.port)))
    }
    if (timeoutMs != null && timeoutMs > 0) {
      builder.connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
      builder.readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
      builder.writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
    }
    return builder.build()
  }

  private fun buildUrl(url: String, query: Map<String, String>): String? {
    val parsed = url.toHttpUrlOrNull() ?: return null
    if (query.isEmpty()) return parsed.toString()
    val builder = parsed.newBuilder()
    query.forEach { (k, v) -> runCatching { builder.addQueryParameter(k, v) } }
    return builder.build().toString()
  }

  private fun flattenHeaders(response: Response): Map<String, String> {
    val out = LinkedHashMap<String, String>(response.headers.size)
    for (name in response.headers.names()) {
      if (name.lowercase() in EXCLUDE_RESPONSE_HEADERS) continue
      out[name] = response.headers.values(name).joinToString(", ")
    }
    return out
  }

  private fun buildHistory(response: Response): List<String> {
    val chain = ArrayList<String>()
    var current: Response? = response
    while (current != null) {
      chain.add(current.request.url.toString())
      current = current.priorResponse
    }
    chain.reverse()
    return chain
  }

  private fun filterRequestHeaders(headers: Map<String, String>): Map<String, String> =
    headers.filterKeys { it.lowercase() !in EXCLUDE_REQUEST_HEADERS }

  private fun charsetOf(contentType: String?): java.nio.charset.Charset {
    val charsetName = contentType
      ?.split(';')
      ?.map { it.trim() }
      ?.firstOrNull { it.startsWith("charset=", ignoreCase = true) }
      ?.substringAfter('=')
      ?.trim('"', ' ')
    return try {
      if (charsetName.isNullOrEmpty()) Charsets.UTF_8 else charset(charsetName)
    } catch (e: Exception) {
      Charsets.UTF_8
    }
  }

  private companion object {
    const val DEFAULT_TIMEOUT_MS = 30_000L
    const val PROGRESS_INTERVAL_MS = 200L
    const val BUFFER_SIZE = 64 * 1024
    /** 超过 4MB 不内联返回（避免 JS 侧一次性持有几十 MB 的 base64） */
    const val MAX_INLINE_BODY = 4L * 1024 * 1024

    val EXCLUDE_REQUEST_HEADERS = setOf(
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailer", "transfer-encoding", "upgrade",
      "host", "origin", "referer", "forwarded", "via",
      "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
      "cookie",
    )
    val EXCLUDE_RESPONSE_HEADERS = setOf(
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailer", "transfer-encoding", "upgrade", "set-cookie",
    )
  }
}
