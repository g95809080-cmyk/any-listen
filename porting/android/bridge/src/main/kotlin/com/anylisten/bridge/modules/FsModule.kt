package com.anylisten.bridge.modules

import com.anylisten.bridge.Args
import com.anylisten.bridge.BridgeContext
import com.anylisten.bridge.BridgeModule
import com.anylisten.bridge.Serialize
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.PortRegistry
import com.anylisten.ports.fs.ListTreeOptions
import java.util.concurrent.ConcurrentHashMap

/**
 * `fs.*` —— 对应 `porting/js/ports/types.ts` 的 `FileSystemPort`。
 *
 * 两个流式接口的回调约定（JS 侧 `ports/index.ts` 的 `listTree` / `watch` 是唯一消费者）：
 * - `listTree(root, opts, onBatch)` → Kotlin 分批发 `onBatch(entries)`，最后普通返回 `{total,canceled,id}`
 * - `watch(root, opts, onEvent, onReady, onError)` → 返回订阅 id；事件与错误走回调
 *   （回调顺序必须与 TS 签名一致：onEvent=2, onReady=3, onError=4，见 [callbackAt] 的 order 语义）
 *
 * 这两处的 `onBatch` / `onEvent` 在帧里是 `func_<n>_<rand>` 字符串（`callbacks` 数组下标标记），
 * JS 侧收到 `[2, cbName, args]` 后反推成本地函数 —— 所以**回调名对 Kotlin 不透明**，不要解析。
 */
class FsModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "fs"

  private val watchCallbacks = ConcurrentHashMap<String, WatchCallbacks>()

  private data class WatchCallbacks(
    val onEvent: String?,
    val onReady: String?,
    val onError: String?,
  )

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    // 契约（与 porting/js/ports/types.ts 完全一致）：
    //   listTree(root, opts, onBatch) -> { total, canceled, id }
    //   cancelScan(id)
    "listTree" -> {
      val id = "scan-${System.nanoTime()}"
      val root = args.str(0)
      val opts = args.map(1)
      val onBatch = ctx.callbackAt(0)
      val options = ListTreeOptions(
        maxDepth = (opts["maxDepth"] as? Number)?.toInt() ?: Int.MAX_VALUE,
        fileExtFilter = (opts["fileExtFilter"] as? List<*>)?.mapNotNull { it?.toString() } ?: emptyList(),
        batchSize = (opts["batchSize"] as? Number)?.toInt() ?: 500,
      )
      val result = registry.fs.listTree(id, root, options) { entries ->
        ctx.emit(onBatch, entries.map { Serialize.entry(it) })
      }
      Serialize.listTreeResult(result)
    }

    "cancelScan" -> {
      registry.fs.cancelScan(args.str(0))
      null
    }

    "stat" -> registry.fs.stat(args.str(0))?.let { Serialize.stat(it) }
    "exists" -> registry.fs.exists(args.str(0))
    "readFile" -> {
      val range = args.map(1)
      registry.fs.readFile(
        args.str(0),
        (range["start"] as? Number)?.toLong(),
        (range["end"] as? Number)?.toLong(),
      )
    }
    "writeFile" -> {
      registry.fs.writeFile(args.str(0), args.bytes(1))
      null
    }
    "writeFileAtomic" -> {
      registry.fs.writeFileAtomic(args.str(0), args.bytes(1))
      null
    }
    "appendFile" -> {
      registry.fs.appendFile(args.str(0), args.str(1))
      null
    }
    "mkdirp" -> {
      registry.fs.mkdirp(args.str(0))
      null
    }
    "remove" -> {
      // JS 侧 `remove(path, recursive)` 的默认值就是 true（ports/index.ts: `recursive ?? true`）
      registry.fs.remove(args.str(0), args.bool(1, true))
      null
    }
    "rename" -> registry.fs.rename(args.str(0), args.str(1))
    "copy" -> {
      registry.fs.copy(args.str(0), args.str(1))
      null
    }
    "readdir" -> registry.fs.readdir(args.str(0)).map { Serialize.entry(it) }
    "realpath" -> registry.fs.realpath(args.str(0))

    // 契约：watch(root, opts, onEvent, onReady, onError) -> string(id)
    "watch" -> {
      val id = "watch-${System.nanoTime()}"
      val root = args.str(0)
      val opts = args.map(1)
      val onEvent = ctx.callbackArg(2) ?: ctx.callbackAt(0)
      val onReady = ctx.callbackArg(3) ?: ctx.callbackAt(1)
      val onError = ctx.callbackArg(4) ?: ctx.callbackAt(2)
      watchCallbacks[id] = WatchCallbacks(onEvent, onReady, onError)
      val extFilter = (opts["extFilter"] as? List<*>)?.mapNotNull { it?.toString() } ?: emptyList()
      registry.fs.watch(
        id = id,
        root = root,
        recursive = (opts["recursive"] as? Boolean) ?: false,
        extFilter = extFilter,
        onEvent = { events -> ctx.emit(onEvent, events.map { Serialize.watchEvent(it) }) },
        onReady = { ctx.emit(onReady) },
        onError = { message -> ctx.emit(onError, message) },
      )
      id
    }

    "unwatch" -> {
      val id = args.str(0)
      registry.fs.unwatch(id)
      watchCallbacks.remove(id)
      null
    }

    "toPlayableUrl" -> registry.fs.toPlayableUrl(args.str(0))
    "revokePlayableUrl" -> {
      registry.fs.revokePlayableUrl(args.str(0))
      null
    }

    "pickDirectory" -> registry.fs.pickDirectory(args.strOrNull(0))?.let {
      mapOf("path" to it.path, "displayName" to it.displayName)
    }

    "getEnv" -> Serialize.env(registry.fs.getEnv())
    "getFreeSpace" -> registry.fs.getFreeSpace(args.str(0))

    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "fs.$method is not implemented")
  }
}
