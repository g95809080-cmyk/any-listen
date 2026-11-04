package com.anylisten.bridge

import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import org.json.JSONArray

/** 帧参数的类型安全读取。任何缺参/类型不符都抛 `EUNKNOWN`，避免把 `null` 带进业务层。 */
class Args(private val values: List<Any?>) {
  val size: Int get() = values.size

  fun anyOrNull(index: Int): Any? = values.getOrNull(index)

  fun str(index: Int): String = values.getOrNull(index) as? String
    ?: throw PortException(PortErrorCode.EUNKNOWN, "arg[$index] expected string, got ${typeName(index)}")

  fun strOrNull(index: Int): String? = when (val v = values.getOrNull(index)) {
    null -> null
    is String -> v.ifEmpty { null }
    else -> throw PortException(PortErrorCode.EUNKNOWN, "arg[$index] expected string?, got ${typeName(index)}")
  }

  fun bool(index: Int, default: Boolean = false): Boolean = when (val v = values.getOrNull(index)) {
    null -> default
    is Boolean -> v
    is Number -> v.toInt() != 0
    else -> throw PortException(PortErrorCode.EUNKNOWN, "arg[$index] expected boolean, got ${typeName(index)}")
  }

  fun int(index: Int, default: Int): Int = when (val v = values.getOrNull(index)) {
    null -> default
    is Int -> v
    is Number -> v.toInt()
    is String -> v.toIntOrNull() ?: default
    else -> default
  }

  fun long(index: Int, default: Long): Long = when (val v = values.getOrNull(index)) {
    null -> default
    is Number -> v.toLong()
    is String -> v.toLongOrNull() ?: default
    else -> default
  }

  fun double(index: Int, default: Double): Double = when (val v = values.getOrNull(index)) {
    null -> default
    is Number -> v.toDouble()
    is String -> v.toDoubleOrNull() ?: default
    else -> default
  }

  fun bytes(index: Int): ByteArray = values.getOrNull(index) as? ByteArray
    ?: throw PortException(
      PortErrorCode.EUNKNOWN,
      "arg[$index] expected binary (use {\"\$b64\":...} envelope), got ${typeName(index)}",
    )

  fun bytesOrNull(index: Int): ByteArray? = when (val v = values.getOrNull(index)) {
    null -> null
    is ByteArray -> v
    is String -> v.toByteArray(Charsets.UTF_8)
    else -> throw PortException(PortErrorCode.EUNKNOWN, "arg[$index] expected binary?, got ${typeName(index)}")
  }

  fun map(index: Int): Map<String, Any?> = values.getOrNull(index) as? Map<String, Any?> ?: emptyMap()

  fun list(index: Int): List<Any?> = values.getOrNull(index) as? List<Any?> ?: emptyList()

  fun stringList(index: Int): List<String> = list(index).mapNotNull { it?.toString() }

  private fun typeName(index: Int): String = values.getOrNull(index)?.javaClass?.simpleName ?: "null"
}

/**
 * 一次请求的上下文。
 *
 * 回调通道：帧里 `callbacks` 给出"哪些实参是 JS 回调名"，模块用 [callbackAt]（按声明顺序）
 * 或 [callbackArg]（按下标）取出名字，之后任意时刻都能通过 [emit] 反向推送事件 ——
 * 这是 `listTree(onBatch)` / `watch(onEvent)` / `downloadTo(onProgress)` /
 * `mediaSession.onControl(cb)` / `lifecycle.onBackground(cb)` 的唯一实现方式。
 *
 * JS 侧对应：`porting/js/ports/bridge-client.ts` 的 `encodeRequest` 把函数实参换成
 * `func_<n>_<rand>` 名字并登记到本地表，收到 `[2, cbName, args]` 时再反推成函数调用。
 * 名字本身对 Kotlin 是不透明的，**不要尝试解析它**。
 */
class BridgeContext(
  val eventName: String,
  private val callbackIndexes: List<Int>,
  private val args: Args,
  private val emitter: NativeEmitter,
) {
  /** 第 order 个回调实参（0 起） */
  fun callbackAt(order: Int): String? {
    val argIndex = callbackIndexes.getOrNull(order) ?: return null
    return args.anyOrNull(argIndex) as? String
  }

  /** 按下标取回调实参（与 JS 调用签名一一对应，避免顺序歧义） */
  fun callbackArg(index: Int): String? = args.anyOrNull(index) as? String

  fun emit(callbackName: String?, vararg payload: Any?) {
    if (callbackName == null) return
    emitter.emit(callbackName, payload.toList())
  }
}

/**
 * Kotlin → JS 的帧发送器。实现由 :app 提供（`WebView.evaluateJavascript`），
 * 这里只负责序列化，便于在 JVM 单测里用假实现验证帧格式。
 */
fun interface FrameSender {
  fun send(frameJson: String)
}

class NativeEmitter(private val sender: FrameSender) {
  fun emit(callbackName: String, args: List<Any?>) {
    val arr = JSONArray()
    args.forEach { arr.put(JsonBinary.encode(it)) }
    sender.send(Message2CallFrames.callbackRequest(callbackName, arr).toString())
  }
}

/** 一个 Port 模块的 Kotlin 端实现（每个模块对应一组同名 path 前缀） */
interface BridgeModule {
  val name: String
  suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any?
}
