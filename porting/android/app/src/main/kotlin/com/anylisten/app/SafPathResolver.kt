package com.anylisten.app

import android.net.Uri
import java.io.File

/**
 * SAF `content://com.android.externalstorage.documents/tree/primary%3AMusic` → 真实路径。
 *
 * 为什么需要：D4 的主方案是 `MANAGE_EXTERNAL_STORAGE` + 真实路径（与桌面 `meta.filePath`
 * 语义完全一致，扫描/DB/监听零改造）。但系统目录选择器只给 SAF uri，因此必须做一次映射。
 * 只处理 primary 卷；SD 卡/USB 返回 null，调用方降级为只显示 displayName（spec §7-2）。
 */
object SafPathResolver {

  private const val EXTERNAL_STORAGE_DOCUMENT = "com.android.externalstorage.documents"

  fun resolvePrimaryTreePath(uri: Uri): String? {
    if (uri.authority != EXTERNAL_STORAGE_DOCUMENT) return null
    // tree/primary:Music/sub 或 document/primary:Music
    val raw = uri.pathSegments.lastOrNull() ?: return null
    val decoded = Uri.decode(raw)
    val parts = decoded.split(':', limit = 2)
    if (parts.size != 2) return null
    val volume = parts[0]
    val relative = parts[1].trim('/')
    if (!volume.equals("primary", ignoreCase = true)) return null
    val root = android.os.Environment.getExternalStorageDirectory()?.absolutePath ?: return null
    return if (relative.isEmpty()) root else File(root, relative).absolutePath
  }

  /**
   * 卷标识：`primary` / `1A2B-3C4D`（SD 卡、U 盘）。取不到返回 null。
   * 上层用它区分「用户取消」与「选了个我们解析不了的卷」——
   * 后者必须报 `UNSUPPORTED_VOLUME` 而不是裸 null，否则会伪装成用户取消。
   */
  fun volumeId(uri: Uri): String? {
    if (uri.authority != EXTERNAL_STORAGE_DOCUMENT) return null
    val raw = uri.pathSegments.lastOrNull() ?: return null
    val decoded = Uri.decode(raw)
    val parts = decoded.split(':', limit = 2)
    return parts.getOrNull(0)?.ifEmpty { null }
  }

  /** 从文档 uri 取展示名（无论能否映射成真实路径，UI 都要能显示） */
  fun displayName(uri: Uri): String {
    val raw = uri.pathSegments.lastOrNull() ?: return "未知目录"
    val decoded = Uri.decode(raw)
    val relative = decoded.substringAfter(':', decoded)
    return relative.substringAfterLast('/').ifEmpty { "内部存储" }
  }
}
