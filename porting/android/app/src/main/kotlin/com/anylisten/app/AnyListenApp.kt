package com.anylisten.app

import android.app.Application
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

class AnyListenApp : Application() {

  private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun onCreate() {
    super.onCreate()
    AppGraph.init(this)
    installCrashLogger()

    // 本地服务必须尽早启动：WebView 的第一个请求就是 http://127.0.0.1:17930/
    AppGraph.ensureHttpServerStarted()

    // 预热 FS 端口 env（首次访问要读 StorageManager），放后台避免拖慢冷启。
    // 顺带清空 <dataPath>/temp —— 与桌面版一致，收敛上次异常退出留下的半成品文件。
    appScope.launch {
      runCatching {
        AppGraph.registry.storage.clearTemp()
        AppGraph.registry.fs.getEnv()
      }.onFailure { Log.w(TAG, "preload fs env failed: ${it.message}") }
    }
  }

  /**
   * 未捕获异常落盘。崩溃日志只在 logcat 里用户拿不到，因此额外写一份到
   * `filesDir/logs/crash-<ts>.log`（不经过 PortRegistry，避免崩溃路径上再初始化一大坨对象）。
   */
  private fun installCrashLogger() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      runCatching {
        val dir = File(filesDir, "logs").apply { if (!exists()) mkdirs() }
        val text = buildString {
          append("thread: ${thread.name}\n")
          append("time: ${java.util.Date()}\n")
          append(Log.getStackTraceString(throwable))
        }
        File(dir, "crash-${System.currentTimeMillis()}.log").writeText(text)
      }
      previous?.uncaughtException(thread, throwable)
    }
  }

  companion object {
    private const val TAG = "AnyListen/App"
  }
}
