package com.anylisten.ports.http

import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * `/p_static` 的持久媒体缓存。
 *
 * 上游 JS 会在 `proxyRequest()` 第一次读取完整响应时 tee 一份到磁盘，但 Android 的
 * `/p_static` 由 Kotlin 直接代理，不会进入那条分支。这里在原生侧补齐同样的语义：
 * - 文件名继续沿用 JS 生成的虚拟名，以便直接命中 `music_url` 表中保存的代理 URL；
 * - 完整文件写完后再原子改名，播放中的半成品不会以正式缓存名出现；
 * - 命中后直接返回文件路径和 Range 头，由 LocalHttpServer 流式输出。
 */
internal class ProxyMediaCache(private val dir: File) {

  init {
    if (!dir.exists()) dir.mkdirs()
  }

  fun find(name: String): File? {
    val file = fileFor(name) ?: return null
    return file.takeIf { it.isFile && it.length() > 0 }
  }

  fun destination(name: String): File? = fileFor(name)

  fun buildResponse(name: String, rangeHeader: String?): HttpResponseData? {
    val file = find(name) ?: return null
    val total = file.length()
    val requestedRange = parseRange(rangeHeader, total)
    if (rangeHeader != null && requestedRange == null) {
      return HttpResponseData(
        statusCode = 416,
        headers = mapOf(
          "Content-Type" to "text/plain; charset=utf-8",
          "Content-Range" to "bytes */$total",
          "Accept-Ranges" to "bytes",
        ),
        body = "",
      )
    }
    val start = requestedRange?.first ?: 0L
    val end = requestedRange?.second ?: (total - 1)
    val headers = linkedMapOf(
      "Content-Type" to contentTypeFor(name),
      "Accept-Ranges" to "bytes",
      "Content-Length" to (end - start + 1).toString(),
      "Cache-Control" to "public, max-age=31536000, immutable",
      "Last-Modified" to httpDate(file.lastModified()),
    )
    if (requestedRange != null) headers["Content-Range"] = "bytes $start-$end/$total"
    return HttpResponseData(
      statusCode = if (requestedRange != null) 206 else 200,
      headers = headers,
      filePath = file.absolutePath,
    )
  }

  fun install(name: String, source: File): Boolean {
    val dest = fileFor(name) ?: return false
    if (dest.isFile && dest.length() > 0) return true
    val tmp = tempFile(dest)
    return try {
      source.copyTo(tmp, overwrite = true)
      sync(tmp)
      promote(tmp, dest)
    } finally {
      tmp.delete()
    }
  }

  fun install(name: String, bytes: ByteArray): Boolean {
    val dest = fileFor(name) ?: return false
    if (dest.isFile && dest.length() > 0) return true
    val tmp = tempFile(dest)
    return try {
      tmp.outputStream().use { it.write(bytes) }
      sync(tmp)
      promote(tmp, dest)
    } finally {
      tmp.delete()
    }
  }

  private fun promote(tmp: File, dest: File): Boolean {
    if (!tmp.renameTo(dest)) {
      tmp.copyTo(dest, overwrite = true)
      tmp.delete()
    }
    return dest.isFile && dest.length() > 0
  }

  private fun tempFile(dest: File): File =
    File(dir, ".${dest.name}.${Thread.currentThread().id}.${System.nanoTime()}.part")

  private fun sync(file: File) {
    runCatching { RandomAccessFile(file, "rws").use { it.fd.sync() } }
  }

  private fun fileFor(name: String): File? {
    if (name.length > MAX_NAME_LENGTH || !NAME_PATTERN.matches(name)) return null
    return File(dir, name)
  }

  /** `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；非法或不可满足返回 null。 */
  private fun parseRange(header: String?, total: Long): Pair<Long, Long>? {
    if (header == null || !header.startsWith("bytes=")) return null
    val spec = header.removePrefix("bytes=").substringBefore(',').trim()
    val dash = spec.indexOf('-')
    if (dash < 0) return null
    val startText = spec.substring(0, dash).trim()
    val endText = spec.substring(dash + 1).trim()
    return try {
      if (startText.isEmpty()) {
        val suffix = endText.toLong()
        if (suffix <= 0) return null
        (total - suffix).coerceAtLeast(0) to (total - 1)
      } else {
        val start = startText.toLong()
        val end = if (endText.isEmpty()) total - 1 else endText.toLong().coerceAtMost(total - 1)
        if (start > end || start >= total) return null
        start to end
      }
    } catch (_: NumberFormatException) {
      null
    }
  }

  private fun httpDate(timeMs: Long): String {
    val format = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("GMT")
    return format.format(Date(timeMs))
  }

  private fun contentTypeFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "mp3" -> "audio/mpeg"
    "flac" -> "audio/flac"
    "m4a", "mp4" -> "audio/mp4"
    "aac" -> "audio/aac"
    "ogg", "opus" -> "audio/ogg"
    "wav" -> "audio/wav"
    "jpg", "jpeg" -> "image/jpeg"
    "png" -> "image/png"
    "webp" -> "image/webp"
    else -> "application/octet-stream"
  }

  private companion object {
    const val MAX_NAME_LENGTH = 128
    val NAME_PATTERN = Regex("^[\\w.]+$")
  }
}
