package com.anylisten.ports.log

import android.content.Context
import android.util.Log
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class LogLevel(val priority: Int) {
  DEBUG(Log.DEBUG),
  INFO(Log.INFO),
  WARN(Log.WARN),
  ERROR(Log.ERROR);

  companion object {
    fun fromJs(value: String): LogLevel = when (value.lowercase(Locale.ROOT)) {
      "debug", "trace" -> DEBUG
      "info", "log" -> INFO
      "warn", "warning" -> WARN
      "error", "fatal" -> ERROR
      else -> INFO
    }
  }
}

/**
 * 日志端口。两路输出：
 * 1. logcat（开发期用 `adb logcat -s AnyListen*`）
 * 2. `filesDir/app/logs/app.log`（对齐上游 `modules/logs/index.ts` 的读取约定）
 *
 * 路径必须与 JS 侧一致：上游用 `joinPath(logPath, LogType.APP)` 读 `app.log`，
 * 若这里换成别的目录/文件名，UI「日志」页会永远读不到文件（真机复现，见验收报告 §11 D-30）。
 *
 * 用户 P0 红线：release 关闭 DEBUG。由 [debugEnabled] 控制（:app 传 `BuildConfig.DEBUG`）。
 */
interface LogPort {
  fun write(level: LogLevel, tag: String, message: String)
  suspend fun readLastLines(filePath: String, lines: Int): List<String>
  suspend fun openLogFolder()
  val logDir: File
}

class LogPortImpl(
  private val context: Context,
  private val debugEnabled: Boolean,
  /** 由 :app 注入（打开日志目录用 Intent，避免 child_process.exec 等价物） */
  private val openFolder: ((File) -> Unit)? = null,
) : LogPort {

  private val tagPrefix = "AnyListen"
  private val ioMutex = Mutex()
  private val timeFormat = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

  override val logDir: File by lazy {
    // 上游 UI 的读取路径是 <dataPath>/app/logs/app.log，这里必须是同一处
    File(context.filesDir, "app/logs").apply { if (!exists()) mkdirs() }
  }

  override fun write(level: LogLevel, tag: String, message: String) {
    if (level == LogLevel.DEBUG && !debugEnabled) return
    val fullTag = if (tag.isEmpty()) tagPrefix else "$tagPrefix/$tag"
    // logcat 对单条日志有 4K 限制，超长消息分片，避免被截断丢信息
    if (message.length <= 3000) {
      Log.println(level.priority, fullTag, message)
    } else {
      message.chunked(3000).forEach { Log.println(level.priority, fullTag, it) }
    }
    // 落盘是 fire-and-forget：日志写入失败不能影响业务（上游 logs.ts 同样只 catch 不抛）
    appendToFile(level, fullTag, message)
  }

  private fun appendToFile(level: LogLevel, tag: String, message: String) {
    val line = "${timeFormat.format(Date())} ${level.name.first()} $tag: $message\n"
    try {
      val file = currentLogFile()
      synchronized(this) {
        file.appendText(line)
        rotateIfNeeded(file)
      }
    } catch (e: Exception) {
      // 只有 logcat 里能看到这条 —— 落盘自身失败无法再落盘
      Log.w(tagPrefix, "log file append failed: ${e.message}")
    }
  }

  private fun currentLogFile(): File = File(logDir, "app.log")

  /** 单文件超过 8MB 就滚动，保留 7 天，避免用户磁盘被日志吃掉 */
  private fun rotateIfNeeded(file: File) {
    if (file.length() < MAX_LOG_BYTES) return
    val rotated = File(file.parentFile, "${file.nameWithoutExtension}.${System.currentTimeMillis()}.log")
    file.renameTo(rotated)
    pruneOldLogs()
  }

  private fun pruneOldLogs() {
    val cutoff = System.currentTimeMillis() - MAX_LOG_AGE_MS
    logDir.listFiles()?.forEach { f ->
      if (f.isFile && f.lastModified() < cutoff) f.delete()
    }
  }

  override suspend fun readLastLines(filePath: String, lines: Int): List<String> = withContext(Dispatchers.IO) {
    val file = File(filePath)
    // 日志文件是惰性创建的：首启/刚清空时不存在是正常状态，返回空列表而不是抛异常。
    // 抛 ENOENT 会让 UI 每次进「日志」页都产生一条未捕获 Promise 拒绝（验收报告 §11 D-30）。
    if (!file.exists()) return@withContext emptyList()
    if (lines <= 0) return@withContext emptyList()
    ioMutex.withLock {
      // 逆序按块读取，避免把上百 MB 的日志一次性读进内存
      RandomAccessFile(file, "r").use { raf ->
        var pos = raf.length()
        val buffer = StringBuilder()
        val chunk = ByteArray(16 * 1024)
        var lineCount = 0
        val result = ArrayList<String>(lines)
        var remainder = ""
        while (pos > 0 && lineCount < lines) {
          val readSize = minOf(chunk.size.toLong(), pos).toInt()
          pos -= readSize
          raf.seek(pos)
          raf.readFully(chunk, 0, readSize)
          val text = String(chunk, 0, readSize, Charsets.UTF_8) + remainder
          val parts = text.split("\n")
          remainder = parts.first()
          for (i in parts.size - 1 downTo 1) {
            if (lineCount >= lines) break
            result.add(parts[i])
            lineCount++
          }
        }
        if (lineCount < lines && remainder.isNotEmpty()) result.add(remainder)
        result.reverse()
        result
      }
    }
  }

  override suspend fun openLogFolder() {
    val handler = openFolder
      ?: throw PortException(PortErrorCode.EUNSUPPORTED, "openLogFolder is not wired in this build")
    withContext(Dispatchers.Main) { handler(logDir) }
  }

  private companion object {
    const val MAX_LOG_BYTES = 8L * 1024 * 1024
    const val MAX_LOG_AGE_MS = 7L * 24 * 3600 * 1000
  }
}
