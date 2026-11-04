package com.anylisten.bridge

import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.toPortException
import com.anylisten.ports.audio.AudioCapabilities
import com.anylisten.ports.fs.FsEntry
import com.anylisten.ports.fs.FsEnv
import com.anylisten.ports.fs.FsStat
import com.anylisten.ports.fs.FsWatchEvent
import com.anylisten.ports.fs.ListTreeResult
import com.anylisten.ports.http.DownloadResult
import com.anylisten.ports.http.HttpResponseData
import com.anylisten.ports.media.MediaMetadataSnapshot
import com.anylisten.ports.media.PlaybackSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** Kotlin 数据类 → JSON 友好结构。集中在一处，避免每个模块各写一遍。 */
object Serialize {
  fun entry(e: FsEntry): Map<String, Any?> = buildMap {
    put("path", e.path)
    put("name", e.name)
    put("isFile", e.isFile)
    put("isDirectory", e.isDirectory)
    put("size", e.size)
    put("mtimeMs", e.mtimeMs)
    // team-lead 明确要求：MANAGE_EXTERNAL_STORAGE 模式下 displayPath 与 path 同值也要下发，
    // 不能靠 JS 侧 `?? path` 兜底 —— 否则 UI 少了一个显式的"这是可展示路径"信号。
    // SAF 虚拟路径落地后这里会换成可读音（如 `内部存储/Music`），字段形状不变。
    if (e.displayPath != null) put("displayPath", e.displayPath)
  }

  fun stat(s: FsStat): Map<String, Any?> = mapOf(
    "isFile" to s.isFile,
    "isDirectory" to s.isDirectory,
    "size" to s.size,
    "ctimeMs" to s.ctimeMs,
    "mtimeMs" to s.mtimeMs,
  )

  fun watchEvent(e: FsWatchEvent): Map<String, Any?> = mapOf(
    "action" to e.action,
    "path" to e.path,
    "ctimeMs" to e.ctimeMs,
    "mtimeMs" to e.mtimeMs,
    "size" to e.size,
  )

  fun env(e: FsEnv): Map<String, Any?> = mapOf(
    "dataPath" to e.dataPath,
    "cachePath" to e.cachePath,
    "tempPath" to e.tempPath,
    "externalRoot" to e.externalRoot,
    "platform" to e.platform,
    "arch" to e.arch,
    "osVersion" to e.osVersion,
    "hasAllFilesAccess" to e.hasAllFilesAccess,
  )

  fun listTreeResult(r: ListTreeResult): Map<String, Any?> = mapOf(
    "total" to r.total,
    "canceled" to r.canceled,
    "id" to r.id,
  )

  fun httpResponse(r: HttpResponseData): Map<String, Any?> = mapOf(
    "statusCode" to r.statusCode,
    "headers" to r.headers,
    "body" to r.body,
    "raw" to r.raw,
    "filePath" to r.filePath,
    "history" to r.history,
  )

  fun download(r: DownloadResult): Map<String, Any?> = mapOf(
    "filePath" to r.filePath,
    "size" to r.size,
    "sha256" to r.sha256,
  )

  fun metadata(m: MediaMetadataSnapshot?): Map<String, Any?>? = m?.let {
    mapOf("title" to it.title, "artist" to it.artist, "album" to it.album, "artworkUrl" to it.artworkUrl)
  }

  fun snapshot(s: PlaybackSnapshot): Map<String, Any?> = mapOf(
    "isPlaying" to s.isPlaying,
    "positionMs" to s.positionMs,
    "durationMs" to s.durationMs,
    "playbackRate" to s.playbackRate,
    "actions" to s.actions.map { it.jsName },
    "lyricLine" to s.lyricLine,
  )

  fun capabilities(c: AudioCapabilities): Map<String, Any?> = mapOf(
    "engine" to c.engine,
    "audioWorklet" to c.audioWorklet,
    "convolver" to c.convolver,
    "panner3d" to c.panner3d,
    "equalizer" to c.equalizer,
    "setSinkId" to c.setSinkId,
    "backgroundAudio" to c.backgroundAudio,
    "maxConvolverIrBytes" to c.maxConvolverIrBytes,
    "supportedSampleRates" to c.supportedSampleRates,
    "pitchShifter" to c.pitchShifter,
    "playbackRateRange" to c.playbackRateRange,
    "supportsPreservesPitch" to c.supportsPreservesPitch,
    "convolverIrLoadable" to c.convolverIrLoadable,
  )
}

/**
 * 路径分发器：`[module, method]` → [BridgeModule]。
 *
 * 线程模型（§4「通用约束」第 5 条）：所有模块方法在 `Dispatchers.IO` 执行，
 * 且并发上限 8 —— 播放期间 `listTree` 与 `http.download` 可能同时跑，
 * 无上限会把 OkHttp 连接池与磁盘队列同时打满。
 */
class BridgeRouter(private val emitter: NativeEmitter) {

  private val modules = LinkedHashMap<String, BridgeModule>()
  private val ioDispatcher = Dispatchers.IO.limitedParallelism(MAX_CONCURRENCY)

  fun register(module: BridgeModule) {
    modules[module.name] = module
  }

  fun registeredModules(): List<String> = modules.keys.toList()

  suspend fun dispatch(frameJson: String): JSONArray? {
    val frame = try {
      JSONArray(frameJson)
    } catch (e: org.json.JSONException) {
      // 帧本身不合法：没有 eventName 可回，只能记日志（调用方是自家 JS，属编程错误）
      android.util.Log.w("AnyListen/Bridge", "malformed frame: ${frameJson.take(160)}", e)
      return null
    }
    if (!Message2CallFrames.isRequest(frame)) return null
    val eventName = Message2CallFrames.eventName(frame)
    if (eventName.isEmpty()) return null
    val path = Message2CallFrames.path(frame)
    val moduleName = path.getOrNull(0)
    val method = path.drop(1).joinToString(".")
    val module = moduleName?.let { modules[it] }
      ?: return Message2CallFrames.errorResponse(
        eventName,
        errorPayload(
          PortErrorCode.EUNSUPPORTED.name,
          "bridge module not found: ${path.joinToString(".")} (registered: ${modules.keys.joinToString()})",
        ),
      )
    if (method.isEmpty()) {
      return Message2CallFrames.errorResponse(
        eventName,
        errorPayload(PortErrorCode.EUNSUPPORTED.name, "bridge method missing for module $moduleName"),
      )
    }

    val args = Args(
      Message2CallFrames.rawArgs(frame).let { arr ->
        (0 until arr.length()).map { JsonBinary.decode(arr.opt(it)) }
      },
    )
    val ctx = BridgeContext(eventName, Message2CallFrames.callbackIndexes(frame).toList(), args, emitter)

    return try {
      val result = withContext(ioDispatcher) { module.handle(method, args, ctx) }
      Message2CallFrames.response(eventName, JsonBinary.encode(result))
    } catch (e: Throwable) {
      val portError = e.toPortException()
      logError("bridge call ${path.joinToString(".")} failed", portError)
      Message2CallFrames.errorResponse(
        eventName,
        errorPayload(portError.code.name, portError.message ?: "bridge call failed", portError.detail),
      )
    }
  }

  private fun errorPayload(code: String, message: String, detail: String? = null): JSONObject =
    JSONObject().apply {
      put("code", code)
      put("message", message)
      if (detail != null) put("detail", detail)
    }

  private fun logError(message: String, error: PortException) {
    android.util.Log.e("AnyListen/Bridge", message, error)
  }

  private companion object {
    const val MAX_CONCURRENCY = 8
  }
}
