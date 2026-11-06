package com.anylisten.ports.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** 主题端口：对应 desktop 的 `nativeTheme` + `#ifdef Q_OS_ANDROID` 等价物 */
interface ThemePort {
  suspend fun getSystemIsDark(): Boolean
  /** uiMode 变化由 :app 转发进来（Activity.onConfigurationChanged） */
  fun notifySystemThemeChanged(isDark: Boolean)
  fun onSystemThemeChanged(listener: (Boolean) -> Unit)
  /** 由 Activity 回填；darkIcons=true 表示状态栏使用深色图标 */
  fun bindSystemBarAppearance(listener: ((Boolean) -> Unit)?)
  fun setSystemBarAppearance(darkIcons: Boolean)
}

class ThemePortImpl(private val context: Context) : ThemePort {
  private val listeners = java.util.concurrent.CopyOnWriteArrayList<(Boolean) -> Unit>()
  @Volatile private var systemBarAppearanceListener: ((Boolean) -> Unit)? = null

  override suspend fun getSystemIsDark(): Boolean = withContext(Dispatchers.Main) {
    val mode = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    mode == Configuration.UI_MODE_NIGHT_YES
  }

  override fun notifySystemThemeChanged(isDark: Boolean) {
    listeners.forEach { runCatching { it(isDark) } }
  }

  override fun onSystemThemeChanged(listener: (Boolean) -> Unit) {
    listeners.add(listener)
  }

  override fun bindSystemBarAppearance(listener: ((Boolean) -> Unit)?) {
    systemBarAppearanceListener = listener
  }

  override fun setSystemBarAppearance(darkIcons: Boolean) {
    systemBarAppearanceListener?.invoke(darkIcons)
  }
}

/** 剪贴板端口：`navigator.clipboard` 在 http://127.0.0.1 属安全上下文可用，但写入仍走原生更可靠 */
interface ClipboardPort {
  suspend fun getText(): String
  suspend fun setText(text: String)
}

class ClipboardPortImpl(private val context: Context) : ClipboardPort {
  override suspend fun getText(): String = withContext(Dispatchers.Main) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
  }

  override suspend fun setText(text: String) = withContext(Dispatchers.Main) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("Any Listen", text))
  }
}

/** 文档选择（SAF）需要 Activity 参与 → 由 :app 注入 */
interface DocumentPicker {
  suspend fun openDocument(mime: List<String>): PickedDocument?

  /**
   * 让用户选保存位置，并**由原生完成写入**。
   *
   * 为什么必须带 [source]：SAF 的 `ACTION_CREATE_DOCUMENT` 返回的是「待写入的 uri」，
   * 拿到的瞬间文件还是空的。如果只把 uri 交给 JS 让调用方补一次写，任何一次忘记或异常
   * 都会在用户设备上留下 0 字节文件（而且用户以为已经导出成功）。这里一次调用闭合：
   * 选位置 → 写入 → 返回成功。
   *
   * @param source 要写的内容；`null` 只用于兼容旧调用（不写内容，仅返回一个私有目录下的路径）
   * @return 用户取消返回 null；写入失败抛 PortException（`EIO` / `EACCES`）
   */
  suspend fun saveDocument(suggestName: String, mime: String, source: SaveSource?): PickedDocument?
}

/** 导出内容的来源：小文件走 bytes（帧内 `$b64`），大文件走临时文件避免内存翻倍 */
sealed interface SaveSource {
  class Bytes(val data: ByteArray) : SaveSource
  class File(val path: String) : SaveSource
}

data class PickedDocument(
  /** 真实文件路径或 `content://` uri（SAF 保存成功时是 uri，不需要再交给分享） */
  val path: String,
  val name: String,
  /** true = 内容已经写进目标位置，调用方不需要再做任何事 */
  val written: Boolean = false,
)

interface IntentPort {
  suspend fun openUrl(url: String)
  suspend fun shareFile(path: String, mime: String)
  suspend fun openDocument(mime: List<String>): PickedDocument?
  suspend fun saveDocument(suggestName: String, mime: String, source: SaveSource?): PickedDocument?
  suspend fun openAppSettings()
}

class IntentPortImpl(
  private val context: Context,
  private val documentPicker: DocumentPicker? = null,
  private val authority: String = "${context.packageName}.fileprovider",
) : IntentPort {

  override suspend fun openUrl(url: String) = withContext(Dispatchers.Main) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (e: Exception) {
      throw PortException(PortErrorCode.EUNSUPPORTED, "no activity can handle url: $url", url)
    }
  }

  override suspend fun shareFile(path: String, mime: String) = withContext(Dispatchers.Main) {
    val file = File(path)
    if (!file.exists()) {
      throw PortException(PortErrorCode.ENOENT, "ENOENT: no such file, '$path'", path)
    }
    val uri = FileProvider.getUriForFile(context, authority, file)
    val intent = Intent(Intent.ACTION_SEND).apply {
      type = mime
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  override suspend fun openDocument(mime: List<String>): PickedDocument? {
    val picker = documentPicker
      ?: throw PortException(PortErrorCode.EUNSUPPORTED, "document picker is not available (no Activity bound)")
    return picker.openDocument(mime)
  }

  override suspend fun saveDocument(suggestName: String, mime: String, source: SaveSource?): PickedDocument? {
    val picker = documentPicker
      ?: throw PortException(PortErrorCode.EUNSUPPORTED, "document picker is not available (no Activity bound)")
    return picker.saveDocument(suggestName, mime, source)
  }

  override suspend fun openAppSettings() = withContext(Dispatchers.Main) {
    context.startActivity(
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        .setData(Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

}
