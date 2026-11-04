package com.anylisten.ports.settings

import android.util.Log
import com.anylisten.ports.fs.FileSystemPort
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * 设置存储（§4.5 的 Kotlin 侧对应物）。
 *
 * 语义：**内存同步读 + 异步 debounce 落盘**。原因是上游 `Store`/`SafeFS` 是全同步 API
 * （`SafeFS.ts:30-47`），Worker 内无法同步触达原生；若每次 `set` 都跨桥落盘会拖死设置页。
 *
 * 落盘用 [FileSystemPort.writeFileAtomic]（.tmp + fsync + rename），崩溃不会留半截 JSON。
 */
class SettingsStore(
  private val fs: FileSystemPort,
  private val filePath: String,
  private val debounceMs: Long = 300,
) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val mutex = Mutex()
  private val data = LinkedHashMap<String, Any?>()
  @Volatile private var loaded = false
  @Volatile private var flushJob: Job? = null
  @Volatile private var dirty = false

  suspend fun load(): Map<String, Any?> = withContext(Dispatchers.IO) {
    mutex.withLock {
      if (loaded) return@withLock data.toMap()
      val file = File(filePath)
      if (file.isFile) {
        try {
          val json = JSONObject(file.readText(Charsets.UTF_8))
          json.keys().forEach { key -> data[key] = json.get(key).unwrap() }
        } catch (e: Exception) {
          // 配置损坏不能阻断启动：备份坏文件后从空配置开始（否则用户会卡在白屏）
          Log.e(TAG, "settings json corrupted, reset: ${e.message}")
          runCatching { file.renameTo(File("$filePath.corrupted")) }
        }
      }
      loaded = true
      data.toMap()
    }
  }

  /** 同步内存读（对应 `SettingsPort.get`） */
  fun get(key: String): Any? = data[key]

  fun getAll(): Map<String, Any?> = data.toMap()

  /**
   * 同步改内存 + 异步 flush。故意做成非 suspend：调用点来自桥的短路径，
   * 等待落盘会让设置页按钮有可感知延迟。
   */
  fun set(patch: Map<String, Any?>) {
    synchronized(data) {
      patch.forEach { (k, v) -> data[k] = v }
    }
    dirty = true
    scheduleFlush()
  }

  suspend fun flush() = withContext(Dispatchers.IO) {
    mutex.withLock {
      if (!dirty && File(filePath).isFile) return@withLock
      val json = JSONObject()
      synchronized(data) { data.forEach { (k, v) -> json.put(k, wrapForJson(v)) } }
      fs.writeFileAtomic(filePath, json.toString().toByteArray(Charsets.UTF_8))
      dirty = false
    }
  }

  private fun scheduleFlush() {
    flushJob?.cancel()
    flushJob = scope.launch {
      delay(debounceMs)
      runCatching { flush() }.onFailure { Log.e(TAG, "flush settings failed: ${it.message}") }
    }
  }

  private fun wrapForJson(value: Any?): Any? = when (value) {
    null -> JSONObject.NULL
    is Map<*, *> -> JSONObject().also { o -> value.forEach { (k, v) -> o.put(k.toString(), wrapForJson(v)) } }
    is List<*> -> org.json.JSONArray().also { a -> value.forEach { a.put(wrapForJson(it)) } }
    else -> value
  }

  private fun Any?.unwrap(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> keys().asSequence().associateWith { get(it).unwrap() }
    is org.json.JSONArray -> (0 until length()).map { get(it).unwrap() }.toList()
    else -> this
  }

  fun dispose() {
    scope.launch { runCatching { flush() } }
    scope.coroutineContext[Job]?.cancel()
  }

  private companion object {
    const val TAG = "AnyListen/Settings"
  }
}
