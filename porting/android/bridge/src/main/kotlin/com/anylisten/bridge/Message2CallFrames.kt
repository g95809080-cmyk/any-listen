package com.anylisten.bridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * message2call v2 的**真实帧格式**（读 `message2call@2.0.3/dist/message2call.js` 得出，
 * 不是推测）。JS 侧对应实现：`porting/js/ports/m2c-frame.ts` —— 两个文件的注释互相引用，
 * 改动必须成对。
 *
 * ```
 * CALL_TYPES = { REQUEST:0, RESPONSE:1, CALLBACK_REQUEST:2, CALLBACK_RESPONSE:3 }
 *
 * 请求  [0, eventName, pathname:[String], args:[Any], callbacks:[Int]]
 * 响应  [1, eventName, error:{code,message,detail?}|null, result?]
 * 回调请求 [2, callbackName, args:[Any]]
 * 回调响应 [3, callbackName, error|null, result?]
 * ```
 * - `eventName` = `pathname.join('.') + '_' + randomId`（JS 侧生成，Kotlin 只回填）
 * - `args` 里的函数实参在发送端已被替换成 `func_<n>_<rand>` 字符串（见 `createProxyCallback`），
 *   其下标记录在 `callbacks` 里 —— 这是**双向回调（onBatch/onProgress/onControl）的唯一通道**。
 *
 * ⚠️ 与 `{id,name,args}` 那种对象帧**不兼容**。本工程早期设计稿假设过对象帧，
 * 实测 message2call 后作废；后来一度又试过「对象帧 + subId 事件」，同样被否 ——
 * 因为 JS 侧的流式接口签名就是 `listTree(root, opts, onBatch)`，回调实参是现成的，
 * 换成 subId 等于两边都要改且多一层路由表。
 */
object Message2CallFrames {
  const val TYPE_REQUEST = 0
  const val TYPE_RESPONSE = 1
  const val TYPE_CALLBACK_REQUEST = 2
  const val TYPE_CALLBACK_RESPONSE = 3

  fun isRequest(frame: JSONArray): Boolean =
    frame.length() >= 3 && frame.optInt(0, -1) == TYPE_REQUEST

  fun eventName(frame: JSONArray): String = frame.optString(1, "")

  fun path(frame: JSONArray): List<String> {
    val pathArray = frame.optJSONArray(2) ?: return emptyList()
    return (0 until pathArray.length()).map { pathArray.optString(it) }
  }

  fun rawArgs(frame: JSONArray): JSONArray = frame.optJSONArray(3) ?: JSONArray()

  /** 被替换成字符串的 JS 回调实参下标 */
  fun callbackIndexes(frame: JSONArray): Set<Int> {
    val arr = frame.optJSONArray(4) ?: return emptySet()
    return (0 until arr.length()).map { arr.optInt(it, -1) }.filter { it >= 0 }.toSet()
  }

  fun response(eventName: String, result: Any?): JSONArray = JSONArray().apply {
    put(TYPE_RESPONSE)
    put(eventName)
    put(JSONObject.NULL)
    put(if (result == null) JSONObject.NULL else result)
  }

  fun errorResponse(eventName: String, error: JSONObject): JSONArray = JSONArray().apply {
    put(TYPE_RESPONSE)
    put(eventName)
    put(error)
    put(JSONObject.NULL)
  }

  /** Kotlin → JS 的事件推送（复用 callback 通道，JS 侧由 `createProxyCallback` 生成的回调消费） */
  fun callbackRequest(callbackName: String, args: JSONArray): JSONArray = JSONArray().apply {
    put(TYPE_CALLBACK_REQUEST)
    put(callbackName)
    put(args)
  }
}

/**
 * 二进制信封。`message2call` 本身走 `JSON.stringify`，`Uint8Array` 会被序列化成
 * `{"0":12,"1":34,...}` —— 体积膨胀 5–8 倍且类型丢失。
 * 因此本项目在帧内统一用 `{"$b64": "<base64>"}` 表达二进制，两端各实现一次
 * （JS 侧 `m2c-frame.ts` 的 `B64_KEY` / `encodeValue` / `decodeValue`）。
 *
 * 唯一跑流量的是 `fs.readFile`（返回 Uint8Array）与 `fs.writeFile` / `writeFileAtomic`
 * （传入 Uint8Array）。大文件走 `/stream/<id>`，不过桥。
 */
object JsonBinary {
  const val KEY = "\$b64"

  fun encode(value: Any?): Any? = when (value) {
    null -> JSONObject.NULL
    is ByteArray -> JSONObject().put(KEY, android.util.Base64.encodeToString(value, android.util.Base64.NO_WRAP))
    is Map<*, *> -> JSONObject().also { obj ->
      value.forEach { (k, v) -> obj.put(k.toString(), encode(v)) }
    }
    is Iterable<*> -> JSONArray().also { arr -> value.forEach { arr.put(encode(it)) } }
    is Array<*> -> JSONArray().also { arr -> value.forEach { arr.put(encode(it)) } }
    is Int, is Long, is Double, is Float, is Boolean, is String -> value
    is Number -> value.toDouble()
    else -> value.toString()
  }

  /** JSON 值 → Kotlin 值（JSONObject→Map、JSONArray→List、`{"$b64"}`→ByteArray） */
  fun decode(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> {
      val b64 = value.optString(KEY, "")
      if (b64.isNotEmpty() && value.length() == 1) {
        android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
      } else {
        val map = LinkedHashMap<String, Any?>(value.length())
        value.keys().forEach { key -> map[key] = decode(value.opt(key)) }
        map
      }
    }
    is JSONArray -> (0 until value.length()).map { decode(value.opt(it)) }
    is Int -> value
    is Long -> if (value in Int.MIN_VALUE..Int.MAX_VALUE) value.toInt() else value
    is Double -> value
    else -> value
  }
}
