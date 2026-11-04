package com.anylisten.ports.fs

import android.util.LruCache
import java.security.MessageDigest

/**
 * `/stream/<id>` 的 id ↔ 文件路径注册表。
 *
 * 为什么需要它：WebView 的 `<audio src>` 只能用 URL，`file://` 既不可用（audioWorklet 需安全上下文，
 * 见 §3.3）也没有 Range 支持。因此把本地文件暴露成 `http://127.0.0.1:17930/stream/<id>`，
 * 由 LocalHttpServer 做 Range 流式响应。
 *
 * id 用 `sha256(path + mtime + size)` 的前 32 hex + 原扩展名：
 * - 内容变了 id 就变 → 天然打破 WebView 的 media 缓存；
 * - 不泄露真实路径（避免把 `/storage/emulated/0/...` 暴露给页面）。
 */
class StreamRegistry(
  private val baseUrlProvider: () -> String,
  maxEntries: Int = 8192,
) {
  private val map = LruCache<String, String>(maxEntries)

  fun register(path: java.io.File): String {
    val id = buildId(path)
    map.put(id, path.absolutePath)
    return id
  }

  /** 反查失败返回 null → LocalHttpServer 返回 404 */
  fun resolve(id: String): String? = map.get(id)

  fun unregister(url: String) {
    val id = url.substringAfterLast('/').substringBefore('?')
    map.remove(id)
  }

  fun buildUrl(path: java.io.File): String = "${baseUrlProvider().trimEnd('/')}/stream/${register(path)}"

  private fun buildId(file: java.io.File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val seed = "${file.absolutePath}|${file.lastModified()}|${file.length()}"
    val bytes = digest.digest(seed.toByteArray(Charsets.UTF_8))
    val hex = StringBuilder(32)
    for (i in 0 until 16) {
      hex.append(String.format("%02x", bytes[i]))
    }
    val ext = file.extension
    return if (ext.isEmpty()) hex.toString() else "$hex.${ext.lowercase()}"
  }
}
