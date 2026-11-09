package com.anylisten.bridge

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import com.anylisten.ports.fs.StreamRegistry
import com.anylisten.ports.http.HttpPort
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedOutputStream
import java.io.File
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicInteger

/**
 * 本地 HTTP 服务（§6.3）：SPA 静态资源 + `/stream` Range 音频 + `/p_static` `/p_url` 代理。
 *
 * 为什么必须有它（而不是 `file://` 或 `WebViewAssetLoader`）：
 * 1. `view-main/src/plugins/player` 用 `AudioWorklet.addModule(url)`，`file://` 不是安全上下文会失败（§3.3）；
 * 2. `<audio>` 拖进度条必须有 **HTTP Range**；
 * 3. Worker / WASM / fetch 全部依赖同源 `http://127.0.0.1`。
 *
 * 端口**固定 17930**：端口变化会让 WebView 的 origin 变化 → localStorage/IndexedDB/OPFS 全部丢失
 * （D2 的升级路径 `@sqlite.org/sqlite-wasm` + OPFS 依赖固定 origin）。
 *
 * 安全性：只绑 `127.0.0.1`（不对外），并要求 token（cookie 或 `?t=` 或 header），
 * 防止设备上其它 App 通过 localhost 读到用户音乐库。
 */
class LocalHttpServer(
  private val context: Context,
  private val http: HttpPort,
  private val streamRegistry: StreamRegistry,
  private val tokenProvider: () -> String,
  private val port: Int = DEFAULT_PORT,
  private val assetsRoot: String = DEFAULT_ASSETS_ROOT,
) {
  private var serverSocket: ServerSocket? = null
  private var acceptJob: Job? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val connectionSeq = AtomicInteger(0)
  private val assets: AssetManager get() = context.assets

  /**
   * 静态资源访问日志（`-PhttpAccessLog=true` 构建时才有，见 `bridge/build.gradle.kts`）。
   * 默认 false：交付包不产生任何逐请求日志。
   */
  private val accessLog: Boolean = BuildConfig.HTTP_ACCESS_LOG

  val baseUrl: String get() = "http://127.0.0.1:$port"

  @Volatile var lastError: String? = null
    private set

  fun start(): Boolean {
    if (serverSocket != null) return true
    return try {
      val socket = ServerSocket(port, BACKLOG, InetAddress.getByName("127.0.0.1"))
      socket.soTimeout = 0
      serverSocket = socket
      acceptJob = scope.launch { acceptLoop(socket) }
      Log.i(TAG, "listening on $baseUrl")
      true
    } catch (e: Exception) {
      lastError = e.message
      Log.e(TAG, "start failed: ${e.message}", e)
      false
    }
  }

  fun stop() {
    acceptJob?.cancel()
    acceptJob = null
    runCatching { serverSocket?.close() }
    serverSocket = null
  }

  private suspend fun acceptLoop(socket: ServerSocket) {
    while (!socket.isClosed) {
      val client = try {
        socket.accept()
      } catch (e: SocketException) {
        break // close() 打断 accept
      } catch (e: Exception) {
        Log.w(TAG, "accept failed: ${e.message}")
        continue
      }
      val id = connectionSeq.incrementAndGet()
      scope.launch { handleConnection(client, id) }
    }
  }

  // ---------------------------------------------------------------- connection

  private suspend fun handleConnection(socket: Socket, connId: Int) = withContext(Dispatchers.IO) {
    try {
      socket.tcpNoDelay = true
      socket.soTimeout = READ_TIMEOUT_MS
      val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
      val output = BufferedOutputStream(socket.getOutputStream(), 64 * 1024)
      // keep-alive：一个连接上连续处理多个请求（WebView 会复用连接，逐个关闭会拖慢首屏）
      while (!socket.isClosed) {
        val request = readRequest(input) ?: break
        val keepAlive = request.headers["connection"]?.equals("close", true) != true
        try {
          route(request, output, connId)
        } catch (e: Exception) {
          Log.w(TAG, "route failed for ${request.path}: ${e.message}")
          runCatching { writeError(output, 500, "Internal Server Error", keepAlive) }
        }
        output.flush()
        if (!keepAlive) break
      }
    } catch (e: Exception) {
      // 客户端主动断开（切歌、页面刷新）很常见，不是错误
      if (e !is SocketException) Log.d(TAG, "connection #$connId closed: ${e.message}")
    } finally {
      runCatching { socket.close() }
    }
  }

  private data class Request(
    val method: String,
    val rawPath: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
  )

  private fun readRequest(input: java.io.BufferedReader): Request? {
    val requestLine = input.readLine() ?: return null
    if (requestLine.isBlank()) return null
    val parts = requestLine.split(' ')
    if (parts.size < 2) return null
    val method = parts[0].uppercase()
    val rawPath = parts[1]
    val headers = LinkedHashMap<String, String>()
    while (true) {
      val line = input.readLine() ?: break
      if (line.isEmpty()) break
      val idx = line.indexOf(':')
      if (idx <= 0) continue
      headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
    }
    // Content-Length>0 的请求体（本地代理只需要 GET，但把 body 读掉，避免污染 keep-alive 流）
    val contentLength = headers["content-length"]?.toLongOrNull() ?: 0
    if (contentLength > 0) {
      var remaining = contentLength
      val buf = CharArray(4096)
      while (remaining > 0) {
        val read = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
        if (read <= 0) break
        remaining -= read
      }
    }
    val queryIndex = rawPath.indexOf('?')
    val pathOnly = if (queryIndex >= 0) rawPath.substring(0, queryIndex) else rawPath
    val query = if (queryIndex >= 0) parseQuery(rawPath.substring(queryIndex + 1)) else emptyMap()
    return Request(method, rawPath, URLDecoder.decode(pathOnly, "UTF-8"), query, headers)
  }

  private fun parseQuery(raw: String): Map<String, String> = raw.split('&').mapNotNull { pair ->
    if (pair.isEmpty()) return@mapNotNull null
    val idx = pair.indexOf('=')
    if (idx < 0) URLDecoder.decode(pair, "UTF-8") to ""
    else URLDecoder.decode(pair.substring(0, idx), "UTF-8") to URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
  }.toMap()

  // ---------------------------------------------------------------- routing

  private suspend fun route(request: Request, output: OutputStream, connId: Int) {
    val path = request.path
    if (path == "/__health") {
      writeText(output, 200, "OK", "text/plain; charset=utf-8")
      return
    }
    if (!isAuthorized(request)) {
      Log.w(TAG, "unauthorized request: $path")
      writeText(output, 403, "Forbidden", "text/plain; charset=utf-8")
      return
    }

    when {
      path.startsWith("/stream/") -> handleStream(request, output, path.removePrefix("/stream/"))
      path.startsWith("/p_url/") || path.startsWith("/api/p_url/") ->
        handleProxyByUrl(request, output, path.substringAfterLast("/p_url/"))
      path.startsWith("/p_static/") || path.startsWith("/api/p_static/") ->
        handleProxyByName(request, output, path.substringAfterLast('/'))
      path == "/proxyUrlToken" || path == "/api/proxyUrlToken" -> handleProxyUrlToken(output)
      else -> handleStatic(request, output, path)
    }
  }

  private fun isAuthorized(request: Request): Boolean {
    val token = tokenProvider()
    if (token.isEmpty()) return true // 开发期未启用 token
    if (request.query["t"] == token) return true
    if (request.headers["x-anylisten-token"] == token) return true
    return request.headers["cookie"]?.split(';')?.any { part ->
      val kv = part.trim()
      kv.startsWith("$TOKEN_COOKIE=") && kv.substringAfter('=') == token
    } == true
  }

  private fun handleProxyUrlToken(output: OutputStream) {
    // 对齐 web-server：/proxyUrlToken 下发 cookie，后续 /p_url 请求带上它
    val token = tokenProvider()
    writeText(
      output,
      status = 200,
      body = "OK",
      contentType = "text/plain; charset=utf-8",
      extraHeaders = listOf(
        "Set-Cookie" to "$PROXY_URL_COOKIE=$token; Path=/; HttpOnly; SameSite=Lax",
      ),
    )
  }

  // ---------------------------------------------------------------- static spa

  private fun handleStatic(request: Request, output: OutputStream, path: String) {
    // 访问日志仅在 `-PhttpAccessLog=true` 构建时生效（BuildConfig.HTTP_ACCESS_LOG，默认 false）。
    // 关掉时只多一次布尔判断，不算耗时、不拷贝 body。
    val startedAt = if (accessLog) System.nanoTime() else 0L
    val relative = path.removePrefix("/").ifEmpty { "index.html" }
    val candidates = buildList {
      add(relative)
      if (!relative.contains('.')) {
        add("$relative/index.html")
        add("index.html") // SPA history 路由回退
      }
    }
    for (candidate in candidates) {
      val assetPath = "$assetsRoot/$candidate"
      val isIndex = candidate.endsWith("index.html")
      try {
        val stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING)
        val bytes = stream.use { it.readBytes() }
        val body = if (isIndex) injectTokenIntoHtml(bytes) else bytes
        writeBytes(
          output,
          status = 200,
          data = body,
          contentType = guessMime(candidate),
          extraHeaders = buildList {
            if (isIndex) {
              // 首次加载时把 token 写进 cookie，页面后续的 worker/wasm/fetch 请求无需带 query
              add("Set-Cookie" to "$TOKEN_COOKIE=${tokenProvider()}; Path=/; HttpOnly; SameSite=Lax")
              add("Cache-Control" to "no-store")
            } else {
              add("Cache-Control" to "public, max-age=31536000, immutable")
            }
          },
        )
        if (accessLog) {
          val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
          // 红线：只记 path（`path` 已去掉 query）。页面是 `/?t=<token>` 加载的、`/proxyUrlToken` 也是 token 路径，
          // 一旦打原始 URI / requestLine / Cookie / x-anylisten-token，token 会直接落进 logcat。
          Log.i(TAG, "200 GET $path ${body.size}B ${elapsedMs}ms")
        }
        return
      } catch (e: InjectionFailure) {
        // 注入失败必须外显：继续走下一个候选只会退化成 404，把「注释吃掉了 script」
        // 伪装成「资源没进包」，正是我们踩过两次的误诊路径。
        Log.e(TAG, "token injection failed for $candidate -- refusing to serve a page that would hang at Loading", e)
        writeText(output, 500, "Token injection failed for $candidate: ${e.message}", "text/plain; charset=utf-8")
        return
      } catch (e: Exception) {
        // 继续尝试下一个候选
      }
    }
    Log.w(TAG, "asset not found under $assetsRoot: $path")
    writeText(output, 404, "Not Found: $path", "text/plain; charset=utf-8")
  }

  /**
   * 注入失败（token snippet 无法插到注释之外）。
   *
   * 单独一个类型，是为了让 [handleStatic] 能在泛型 `catch (e: Exception)` **之前**精确捕获并直接回 500 ——
   * 否则异常会被「继续尝试下一个候选」的逻辑吞掉，最终表现成 404 `Not Found: /`，
   * 把「注入被注释吃掉」伪装成「资源没进包」。这条误诊路径我们在 2026-11 的真机验证里走了两次。
   */
  private class InjectionFailure(message: String) : IllegalStateException(message)

  /**
   * 首帧注入三个全局（§6.3）：
   * - `window.__ANYLISTEN_TOKEN__` —— 桥与 HTTP 共用的鉴权 token（旧名，保留兼容）
   * - `window.__ANYLISTEN_BRIDGE_ORIGIN__` —— 供 JS 判断"跑在壳里还是纯浏览器里"
   * - `window.__anylisten_android__` —— **JS 侧实际读的结构化对象**
   *   （`porting/js/ports/bridge-client.ts` 的 `declare global` 里已按这个形状声明：
   *   `{ version, token, origin }`，`sendToNative` 调 `AndroidBridge.postMessage(frame, token)` 时取它）
   *
   * ## 为什么不用 `html.indexOf("<head>")`（2026-11 真机白屏事故）
   *
   * 之前是 `val lower = html.lowercase(); lower.indexOf("<head>")`，一次真机验证里整个 App 卡在
   * `Loading...`，日志是 `origin=n/a` + `PortError: window.__ANYLISTEN_TOKEN__ 缺失`。
   * 从设备把服务端返回的 HTML 抓下来才看清：`porting/js/index.html` 顶部有一段**说明性 HTML 注释**，
   * 注释正文里为了描述注入机制写了字面量 `<head><script>window.__ANYLISTEN_TOKEN__=...`。
   * 于是 `indexOf("<head>")` 命中的是注释里的那个，snippet 被插进注释 → 不执行 → 三个全局全都不存在。
   * （同类脆弱点：`lowercase()` 对 `İ` 之类字符会改变长度，拿 lowercase 的下标切原文本身就会错位。）
   *
   * 现在的做法：
   *  1. **等长遮罩**：把 `<!--...-->` 区间逐字符替换成空格（保留换行以维持长度），在遮罩副本上
   *     做不区分大小写的标签查找，得到偏移后回**原文**插入 —— 注释里出现任何标签都不再干扰；
   *  2. **注入后自检**：对 `patched` 再遮罩一次，断言 `window.__ANYLISTEN_TOKEN__=` 出现在遮罩文本里。
   *     搜不到说明又被注进了注释 → `Log.e` + 抛异常，把「静默成功、实际没生效」变成显式失败；
   *  3. **兜底顺序**：`<head` → `<body` → `<html` → 前置拼接，每一级都过同一条自检。
   */
  private fun injectTokenIntoHtml(source: ByteArray): ByteArray {
    val html = String(source, Charsets.UTF_8)
    val token = tokenProvider()
    val snippet = buildString {
      append("<script>")
      append("window.__ANYLISTEN_TOKEN__=")
      append('"').append(token).append('"')
      append(";window.__ANYLISTEN_BRIDGE_ORIGIN__=\"")
      append(baseUrl).append("\";")
      append("window.__anylisten_android__={version:1,token:\"")
      append(token).append("\",origin:\"")
      append(baseUrl).append("\"};")
      append("</script>")
    }
    val tokenMarker = "window.__ANYLISTEN_TOKEN__="

    // 等长遮罩：把注释内容替换成空格 → 与原文长度严格相等，偏移量可直接复用
    fun maskComments(text: String): String {
      val chars = text.toCharArray()
      var i = 0
      while (i < chars.size) {
        val isCommentOpen = chars[i] == '<' && i + 3 < chars.size &&
          chars[i + 1] == '!' && chars[i + 2] == '-' && chars[i + 3] == '-'
        if (!isCommentOpen) {
          i++
          continue
        }
        var j = i + 4
        var end = -1
        while (j + 2 < chars.size) {
          if (chars[j] == '-' && chars[j + 1] == '-' && chars[j + 2] == '>') {
            end = j + 3
            break
          }
          j++
        }
        val stop = if (end >= 0) end else chars.size
        for (k in i until stop) {
          if (chars[k] != '\n' && chars[k] != '\r') chars[k] = ' '
        }
        i = stop
      }
      return String(chars)
    }

    // 不区分大小写查找，且**不**用 lowercase()（避免改变长度导致的错位）
    fun indexOfTag(masked: String, tag: String, from: Int = 0): Int {
      val last = masked.length - tag.length
      var i = from
      while (i <= last) {
        var k = 0
        while (k < tag.length && masked[i + k].equals(tag[k], ignoreCase = true)) k++
        if (k == tag.length) return i
        i++
      }
      return -1
    }

    fun verify(patched: String): Boolean = indexOfTag(maskComments(patched), tokenMarker) >= 0

    val masked = maskComments(html)
    for (tag in listOf("<head", "<body", "<html")) {
      val tagIndex = indexOfTag(masked, tag)
      if (tagIndex < 0) continue
      val close = html.indexOf('>', tagIndex)
      if (close < 0) continue
      val offset = close + 1
      val patched = html.substring(0, offset) + snippet + html.substring(offset)
      if (!verify(patched)) {
        Log.e(TAG, "[bridge] token injection FAILED via $tag (marker still inside a comment?)")
        continue
      }
      Log.i(TAG, "[bridge] token injected at offset $offset (via $tag)")
      return patched.toByteArray(Charsets.UTF_8)
    }

    // 都没有：退化成前置拼接，且必须过自检
    val prepended = snippet + html
    if (verify(prepended)) {
      Log.i(TAG, "[bridge] token injected at offset 0 (no <head>/<body>/<html> tag found)")
      return prepended.toByteArray(Charsets.UTF_8)
    }
    // 显式失败：宁可让 WebView 看到错误页（Log.e + 抛异常 → handleStatic 落到 404 错误页），
    // 也不要白屏。白屏时用户与 QA 都拿不到任何线索。
    Log.e(TAG, "[bridge] FATAL: token injection failed for every candidate; page would be blank")
    throw InjectionFailure("injectTokenIntoHtml: token snippet could not be placed outside HTML comments")
  }

  // ---------------------------------------------------------------- /stream

  private fun handleStream(request: Request, output: OutputStream, id: String) {
    val path = streamRegistry.resolve(id)
    if (path == null) {
      writeText(output, 404, "Not Found", "text/plain; charset=utf-8")
      return
    }
    val file = File(path)
    if (!file.isFile) {
      writeText(output, 404, "Not Found", "text/plain; charset=utf-8")
      return
    }
    val total = file.length()
    val range = parseRange(request.headers["range"], total)
    val mime = guessMime(file.name)
    if (range == null && request.headers.containsKey("range")) {
      // 不可满足的 Range → 416（RFC 7233）
      writeText(
        output,
        status = 416,
        body = "",
        contentType = "text/plain; charset=utf-8",
        extraHeaders = listOf("Content-Range" to "bytes */$total"),
      )
      return
    }
    val start = range?.first ?: 0L
    val end = range?.second ?: (total - 1)
    val length = if (total == 0L) 0L else (end - start + 1)
    val status = if (range != null) 206 else 200

    val headers = buildList {
      add("Content-Type" to mime)
      add("Accept-Ranges" to "bytes")
      add("Content-Length" to length.toString())
      add("Cache-Control" to "no-cache")
      if (range != null) add("Content-Range" to "bytes $start-$end/$total")
    }
    writeHead(output, status, headers)
    if (request.method == "HEAD" || total == 0L) return
    RandomAccessFile(file, "r").use { raf ->
      raf.seek(start)
      val buffer = ByteArray(64 * 1024)
      var remaining = length
      while (remaining > 0) {
        val read = raf.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
        if (read <= 0) break
        output.write(buffer, 0, read)
        remaining -= read
      }
    }
    output.flush()
  }

  /** `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；无法解析返回 null（=全量 200） */
  private fun parseRange(header: String?, total: Long): Pair<Long, Long>? {
    if (header == null || !header.startsWith("bytes=")) return null
    val spec = header.removePrefix("bytes=").substringBefore(',')
    val dash = spec.indexOf('-')
    if (dash < 0) return null
    val startText = spec.substring(0, dash).trim()
    val endText = spec.substring(dash + 1).trim()
    return try {
      if (startText.isEmpty()) {
        val suffix = endText.toLong()
        if (suffix <= 0) return null
        val start = (total - suffix).coerceAtLeast(0)
        start to (total - 1)
      } else {
        val start = startText.toLong()
        val end = if (endText.isEmpty()) total - 1 else endText.toLong().coerceAtMost(total - 1)
        if (start > end || start >= total) return null
        start to end
      }
    } catch (e: NumberFormatException) {
      null
    }
  }

  // ---------------------------------------------------------------- proxy

  private suspend fun handleProxyByName(request: Request, output: OutputStream, name: String) {
    val result = http.proxyRequestByName(name, request.headers)
    if (result == null) {
      writeText(output, 404, "Not Found", "text/plain; charset=utf-8")
      return
    }
    writeProxyResult(output, result, request.method)
  }

  private suspend fun handleProxyByUrl(request: Request, output: OutputStream, encodedUrl: String) {
    val url = URLDecoder.decode(encodedUrl, "UTF-8")
    val result = http.proxyRequestByUrl(url, request.headers)
    if (result == null) {
      writeText(output, 404, "Not Found", "text/plain; charset=utf-8")
      return
    }
    writeProxyResult(output, result, request.method)
  }

  private fun writeProxyResult(
    output: OutputStream,
    result: com.anylisten.ports.http.HttpResponseData,
    method: String,
  ) {
    val file = result.filePath?.let(::File)
    if (file?.isFile == true) {
      writeProxyFile(output, result, file, method)
      return
    }

    val data: ByteArray? = result.raw ?: result.body?.toByteArray(Charsets.UTF_8)
    val headers = proxyHeaders(result.headers, data?.size?.toLong() ?: 0, keepContentRange = true)
    writeHead(output, result.statusCode, headers)
    if (method != "HEAD" && data != null && data.isNotEmpty()) {
      output.write(data)
      output.flush()
    }
  }

  private fun writeProxyFile(
    output: OutputStream,
    result: com.anylisten.ports.http.HttpResponseData,
    file: File,
    method: String,
  ) {
    val range = if (result.statusCode == 206) parseContentRange(result.headers["Content-Range"] ?: result.headers["content-range"]) else null
    val fileLength = file.length()
    val start = range?.start ?: 0L
    val end = range?.end ?: (fileLength - 1)
    val fileStart = if (range != null && !result.fileContainsFullResource) 0L else start
    val available = (fileLength - fileStart).coerceAtLeast(0)
    val length = if (fileLength == 0L) 0L else minOf(end - start + 1, available)
    val status = if (range != null) 206 else 200
    val headers = proxyHeaders(
      result.headers,
      length,
      keepContentRange = false,
      extra = buildList {
        add("Accept-Ranges" to "bytes")
        if (range != null) {
          add("Content-Range" to "bytes $start-$end/${range.total?.toString() ?: "*"}")
        }
      },
    )
    writeHead(output, status, headers)
    if (method == "HEAD" || length == 0L) return

    RandomAccessFile(file, "r").use { raf ->
      raf.seek(fileStart)
      val buffer = ByteArray(64 * 1024)
      var remaining = length
      while (remaining > 0) {
        val read = raf.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
        if (read <= 0) break
        output.write(buffer, 0, read)
        remaining -= read
      }
    }
    output.flush()
  }

  private fun proxyHeaders(
    source: Map<String, String>,
    contentLength: Long,
    keepContentRange: Boolean,
    extra: List<Pair<String, String>> = emptyList(),
  ): List<Pair<String, String>> = buildList {
    source.forEach { (key, value) ->
      val lower = key.lowercase()
      if (lower == "content-length" || lower == "transfer-encoding" || lower == "connection") return@forEach
      if (!keepContentRange && lower == "content-range") return@forEach
      add(key to value)
    }
    extra.forEach { (key, value) ->
      removeAll { it.first.equals(key, ignoreCase = true) }
      add(key to value)
    }
    removeAll { it.first.equals("Content-Length", ignoreCase = true) }
    add("Content-Length" to contentLength.toString())
  }

  private fun parseContentRange(header: String?): ContentRange? {
    if (header == null) return null
    val match = CONTENT_RANGE_PATTERN.matchEntire(header.trim()) ?: return null
    val start = match.groupValues[1].toLongOrNull() ?: return null
    val end = match.groupValues[2].toLongOrNull() ?: return null
    val total = match.groupValues[3].takeUnless { it == "*" }?.toLongOrNull()
    return if (start <= end) ContentRange(start, end, total) else null
  }

  private data class ContentRange(val start: Long, val end: Long, val total: Long?)

  // ---------------------------------------------------------------- raw writers

  private fun writeHead(output: OutputStream, status: Int, headers: List<Pair<String, String>>) {
    val sb = StringBuilder()
    sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n")
    headers.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
    sb.append("Connection: keep-alive\r\n\r\n")
    output.write(sb.toString().toByteArray(Charsets.UTF_8))
  }

  private fun writeBytes(
    output: OutputStream,
    status: Int,
    data: ByteArray,
    contentType: String,
    extraHeaders: List<Pair<String, String>> = emptyList(),
  ) {
    writeHead(output, status, extraHeaders + listOf("Content-Type" to contentType, "Content-Length" to data.size.toString()))
    output.write(data)
    output.flush()
  }

  private fun writeText(
    output: OutputStream,
    status: Int,
    body: String,
    contentType: String,
    extraHeaders: List<Pair<String, String>> = emptyList(),
  ) = writeBytes(output, status, body.toByteArray(Charsets.UTF_8), contentType, extraHeaders)

  private fun writeError(output: OutputStream, status: Int, message: String, keepAlive: Boolean) {
    val body = message.toByteArray(Charsets.UTF_8)
    val sb = StringBuilder()
    sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n")
    sb.append("Content-Type: text/plain; charset=utf-8\r\n")
    sb.append("Content-Length: ").append(body.size).append("\r\n")
    sb.append("Connection: ").append(if (keepAlive) "keep-alive" else "close").append("\r\n\r\n")
    output.write(sb.toString().toByteArray(Charsets.UTF_8))
    output.write(body)
    output.flush()
  }

  private fun statusText(status: Int): String = when (status) {
    200 -> "OK"
    206 -> "Partial Content"
    403 -> "Forbidden"
    404 -> "Not Found"
    416 -> "Range Not Satisfiable"
    500 -> "Internal Server Error"
    502 -> "Bad Gateway"
    else -> "OK"
  }

  companion object {
    const val DEFAULT_PORT = 17930
    const val DEFAULT_ASSETS_ROOT = "web/spa"
    const val TOKEN_COOKIE = "altk"
    const val PROXY_URL_COOKIE = "p_urlkey"
    private const val TAG = "AnyListen/Http"
    private const val BACKLOG = 64
    private const val READ_TIMEOUT_MS = 30_000
    private val CONTENT_RANGE_PATTERN = Regex("""bytes\s+(\d+)-(\d+)/(\d+|\*)""")

    /**
     * 扩展名 → MIME。**必须覆盖 wasm**：`WebAssembly.instantiateStreaming` 要求
     * `application/wasm`，否则会回退到 arrayBuffer 加载或直接失败。
     */
    fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
      "html", "htm" -> "text/html; charset=utf-8"
      "js", "mjs" -> "text/javascript; charset=utf-8"
      "css" -> "text/css; charset=utf-8"
      "json" -> "application/json; charset=utf-8"
      "wasm" -> "application/wasm"
      "svg" -> "image/svg+xml"
      "png" -> "image/png"
      "jpg", "jpeg" -> "image/jpeg"
      "webp" -> "image/webp"
      "gif" -> "image/gif"
      "ico" -> "image/x-icon"
      "woff" -> "font/woff"
      "woff2" -> "font/woff2"
      "ttf" -> "font/ttf"
      "otf" -> "font/otf"
      "mp3" -> "audio/mpeg"
      "flac" -> "audio/flac"
      "m4a" -> "audio/mp4"
      "aac" -> "audio/aac"
      "ogg", "opus" -> "audio/ogg"
      "wav" -> "audio/wav"
      "mp4" -> "video/mp4"
      "lrc" -> "text/plain; charset=utf-8"
      "txt" -> "text/plain; charset=utf-8"
      "map" -> "application/json; charset=utf-8"
      else -> "application/octet-stream"
    }
  }
}
