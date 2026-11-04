package com.anylisten.ports.fs

import android.content.Context
import android.util.Log
import java.io.File

/**
 * 应用数据目录布局 —— **与桌面版（Electron `app.getPath('userData')`）同构**，
 * `porting/js` 的迁移脚本、DB 路径、插件目录都依赖这套相对位置：
 *
 * ```
 * <dataPath>/            = context.filesDir          （应用私有，卸载即删，不占外部存储权限）
 * <dataPath>/app/        = 设置 config.json / data.json、插件
 * <dataPath>/cache/      = 应用自己管理的缓存（封面、迁移中间态）
 * <dataPath>/temp/       = 临时文件，**启动时清空**
 * ```
 *
 * 两个容易走偏的点：
 * 1. `cachePath` **不用** `context.cacheDir`。系统可以在任意时刻清空 cacheDir，
 *    而上游把 cache 当「应用自己管的缓存」，被系统删了会导致封面/迁移中间态莫名丢。
 *    真正"丢了也无所谓"的临时下载用 `context.cacheDir/http`（见 HttpPortImpl）。
 * 2. `tempPath` 每次进程启动清空。上游桌面版也是启动清 temp，靠这个收敛上次崩溃的半成品文件。
 */
class StorageLayout(val context: Context) {

  val dataPath: String = context.filesDir.absolutePath
  val appDir: File = File(dataPath, "app")
  val cachePath: File = File(dataPath, "cache")
  val tempPath: File = File(dataPath, "temp")

  /** 幂等建目录。在 getEnv() 与设置存储初始化前调用 */
  fun ensureDirs(): StorageLayout {
    listOf(appDir, cachePath, tempPath).forEach { dir ->
      if (!dir.exists() && !dir.mkdirs()) {
        Log.w(TAG, "failed to create ${dir.path}")
      }
    }
    return this
  }

  /**
   * 清空 temp。只删直接子项，不跟随软链接；单个文件删失败只记日志不中断
   * （有进程还开着这个文件时 Windows/Android 都可能删不掉，下次启动再清）。
   */
  fun clearTemp() {
    val children = tempPath.listFiles() ?: return
    for (child in children) {
      val ok = runCatching { child.deleteRecursively() }.getOrDefault(false)
      if (!ok) Log.w(TAG, "failed to clear ${child.path} (will retry next launch)")
    }
  }

  private companion object {
    const val TAG = "AnyListen/Storage"
  }
}
