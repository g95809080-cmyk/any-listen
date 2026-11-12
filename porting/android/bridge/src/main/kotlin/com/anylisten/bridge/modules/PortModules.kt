package com.anylisten.bridge.modules

import com.anylisten.bridge.Args
import com.anylisten.bridge.BridgeContext
import com.anylisten.bridge.BridgeModule
import com.anylisten.bridge.Serialize
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.PortRegistry

import com.anylisten.ports.audio.AudioEngine
import com.anylisten.ports.audio.AudioFocusEvent
import com.anylisten.ports.http.HttpRequestOptions
import com.anylisten.ports.http.ProxySpec
import com.anylisten.ports.log.LogLevel

internal fun decodeHttpBody(value: Any?): ByteArray? = when (value) {
  null -> null
  is ByteArray -> value
  is String -> value.toByteArray(Charsets.UTF_8)
  else -> throw PortException(PortErrorCode.EUNSUPPORTED, "http request body must be text or bytes")
}

/** `http.*` —— 对应 `HttpPort`（§4.4）。 */
class HttpModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "http"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "request" -> {
      val url = args.str(0)
      val opts = args.map(1)
      val proxy = (opts["proxy"] as? Map<*, *>)?.let {
        ProxySpec(it["host"].toString(), (it["port"] as? Number)?.toInt() ?: 0)
      }
      Serialize.httpResponse(
        registry.http.request(
          url,
          HttpRequestOptions(
            method = (opts["method"] as? String) ?: "GET",
            headers = (opts["headers"] as? Map<*, *>)?.entries
              ?.associate { (k, v) -> k.toString() to v.toString() } ?: emptyMap(),
            query = (opts["query"] as? Map<*, *>)?.entries
              ?.associate { (k, v) -> k.toString() to v.toString() } ?: emptyMap(),
            body = decodeHttpBody(opts["body"]),
            bodyFilePath = opts["bodyFilePath"] as? String,
            timeoutMs = (opts["timeoutMs"] as? Number)?.toLong() ?: 30_000,
            retryNum = (opts["retryNum"] as? Number)?.toInt() ?: 0,
            maxRedirect = (opts["maxRedirect"] as? Number)?.toInt() ?: 5,
            needRaw = (opts["needRaw"] as? Boolean) ?: false,
            proxy = proxy,
            signalId = opts["signal"] as? String,
          ),
        ),
      )
    }

    // downloadTo(url, destPath, opts, onProgress)
    "downloadTo" -> {
      val url = args.str(0)
      val destPath = args.str(1)
      val opts = args.map(2)
      val onProgress = ctx.callbackArg(3) ?: ctx.callbackAt(0)
      val proxy = (opts["proxy"] as? Map<*, *>)?.let {
        ProxySpec(it["host"].toString(), (it["port"] as? Number)?.toInt() ?: 0)
      }
      Serialize.download(
        registry.http.downloadTo(
          url = url,
          destPath = destPath,
          headers = (opts["headers"] as? Map<*, *>)?.entries
            ?.associate { (k, v) -> k.toString() to v.toString() } ?: emptyMap(),
          timeoutMs = (opts["timeoutMs"] as? Number)?.toLong() ?: 60_000,
          proxy = proxy,
          signalId = opts["signal"] as? String,
          onProgress = { p ->
            ctx.emit(
              onProgress,
              mapOf("downloaded" to p.downloaded, "total" to p.total, "speed" to p.speed),
            )
          },
        ),
      )
    }

    "cancel" -> {
      registry.http.cancel(args.str(0))
      null
    }

    "setProxy" -> {
      val proxy = args.map(0)
      registry.http.setProxy(
        if (proxy["host"] == null) null
        else ProxySpec(proxy["host"].toString(), (proxy["port"] as? Number)?.toInt() ?: 0),
      )
      null
    }

    "registerProxyTarget" -> {
      registry.http.registerProxyTarget(
        args.str(0),
        args.str(1),
        args.map(2).entries.associate { (k, v) -> k to v.toString() },
        args.bool(3, false),
      )
      null
    }

    "unregisterProxyTarget" -> {
      registry.http.unregisterProxyTarget(args.str(0))
      null
    }

    "cacheProxyTarget" -> {
      val onProgress = ctx.callbackArg(1) ?: ctx.callbackAt(0)
      Serialize.proxyCacheTask(
        registry.http.cacheProxyTarget(args.str(0)) { status ->
          ctx.emit(onProgress, Serialize.proxyCacheTask(status))
        },
      )
    }

    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "http.$method is not implemented")
  }
}

/** `log.*` —— `LogPort`（§4.8）。 */
class LogModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "log"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "write" -> {
      registry.log.write(LogLevel.fromJs(args.str(0)), args.str(1), args.str(2))
      null
    }
    "readLastLines" -> registry.log.readLastLines(args.str(0), args.int(1, 200))
    "openLogFolder" -> {
      registry.log.openLogFolder()
      null
    }
    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "log.$method is not implemented")
  }
}

/** `settings.*` —— `SettingsStore`（§4.5）。 */
class SettingsModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "settings"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "load" -> registry.settings.load()
    "get" -> registry.settings.get(args.str(0))
    "getAll" -> registry.settings.getAll()
    "set" -> {
      registry.settings.set(args.map(0))
      null
    }
    "flush" -> {
      registry.settings.flush()
      null
    }
    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "settings.$method is not implemented")
  }
}

/** `power.*` —— `PowerPort`（§4.9）。 */
class PowerModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "power"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "setWakeLock" -> {
      registry.power.setWakeLock(args.bool(0, false))
      null
    }
    "getBatteryOptimizationStatus" -> registry.power.getBatteryOptimizationStatus()
    "requestIgnoreBatteryOptimization" -> {
      registry.power.requestIgnoreBatteryOptimization()
      null
    }
    "startForegroundService" -> {
      registry.power.startForegroundService(args.strOrNull(0) ?: "com.anylisten.app.action.START")
      null
    }
    "stopForegroundService" -> {
      registry.power.stopForegroundService()
      null
    }
    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "power.$method is not implemented")
  }
}

/**
 * `theme.*` / `clipboard.*` / `intent.*` / `tar.*` —— §4.9 的 UI 侧端口。
 *
 * 故意**按 TS 的 4 个 Port 各注册一个模块名**（而不是塞进一个 `ui` 模块），
 * 这样 JS 侧的 `Ports.theme.getSystemIsDark()` 与 path 一一对应，不需要额外映射表。
 */
class UiModule(
  private val registry: PortRegistry,
  override val name: String,
) : BridgeModule {

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (name) {
    "theme" -> when (method) {
      "getSystemIsDark" -> registry.theme.getSystemIsDark()
      // 订阅式：JS 侧 `theme.onSystemThemeChanged(cb)` 用 keepCallbacks 注册，回调名会一直留在表里
      "onSystemThemeChanged" -> {
        val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
        registry.theme.onSystemThemeChanged { isDark -> ctx.emit(cb, isDark) }
        null
      }
      "setSystemBarAppearance" -> {
        registry.theme.setSystemBarAppearance(args.bool(0, true))
        null
      }
      else -> unsupported(method)
    }

    "clipboard" -> when (method) {
      "getText" -> registry.clipboard.getText()
      "setText" -> {
        registry.clipboard.setText(args.str(0))
        null
      }
      else -> unsupported(method)
    }

    "intent" -> when (method) {
      "openUrl" -> {
        registry.intent.openUrl(args.str(0))
        null
      }
      "shareFile" -> {
        registry.intent.shareFile(args.str(0), args.str(1))
        null
      }
      "openDocument" -> registry.intent.openDocument(args.stringList(0).ifEmpty { listOf("*/*") })
        ?.let { mapOf("path" to it.path, "name" to it.name) }
      // saveDocument(suggestName, mime, source?)
      //   source 两种形态：`{"$b64":...}` 二进制，或 `{ filePath: "..." }`（大文件走临时文件）
      //   返回 `{ path, name, written }`：written=true 表示内容已由原生写进目标位置
      "saveDocument" -> registry.intent.saveDocument(args.str(0), args.str(1), parseSaveSource(args))
        ?.let { mapOf("path" to it.path, "name" to it.name, "written" to it.written) }
      "openAppSettings" -> {
        registry.intent.openAppSettings()
        null
      }
      else -> unsupported(method)
    }

    "tar" -> when (method) {
      "pack" -> {
        registry.tar.pack(args.str(0), args.str(1))
        null
      }
      "unpack" -> {
        registry.tar.unpack(args.str(0), args.str(1))
        null
      }
      else -> unsupported(method)
    }

    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "unknown ui module: $name")
  }

  private fun parseSaveSource(args: Args): com.anylisten.ports.ui.SaveSource? {
    // 二进制：帧里的 {"$b64":...} 已在 BridgeRouter 解码成 ByteArray
    (args.anyOrNull(2) as? ByteArray)?.let { return com.anylisten.ports.ui.SaveSource.Bytes(it) }
    val map = args.map(2)
    val filePath = map["filePath"] as? String
    if (!filePath.isNullOrEmpty()) return com.anylisten.ports.ui.SaveSource.File(filePath)
    return null
  }

  private fun unsupported(method: String): Nothing =
    throw PortException(PortErrorCode.EUNSUPPORTED, "$name.$method is not implemented")
}

/**
 * `lifecycle.*` —— `LifecycleHub`（§4.9）。
 *
 * 4 个订阅方法都是「JS 传回调实参、Kotlin 记住回调名」的形态
 * （JS 侧 `ports/index.ts` 用 `keepCallbacks: true` 注册，回调名不会被请求结束清掉）。
 * 事件源头仍是 :app 的 `LifecycleHub`（MainActivity 分发），这里只做一层转发。
 */
class LifecycleModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "lifecycle"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "isInForeground" -> registry.lifecycle.isInForeground()

    "onBackground" -> {
      val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
      registry.lifecycle.onBackground { ctx.emit(cb) }
      null
    }
    "onForeground" -> {
      val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
      registry.lifecycle.onForeground { ctx.emit(cb) }
      null
    }
    "onTrimMemory" -> {
      val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
      registry.lifecycle.onTrimMemory { level -> ctx.emit(cb, level) }
      null
    }
    "onBeforeTerminate" -> {
      val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
      registry.lifecycle.onBeforeTerminate { id -> ctx.emit(cb, id) }
      null
    }
    "acknowledgeTermination" -> {
      registry.lifecycle.acknowledgeTermination(args.str(0), args.str(1))
      null
    }

    // 信息类：JS 侧用于 deviceId / 平台判断（替换 process.platform/arch）
    "getEnv" -> Serialize.env(registry.fs.getEnv())

    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "lifecycle.$method is not implemented")
  }
}

/** `audio.*` —— `AudioEngineRouter`（§4.7，PDR-008 冻结接口）。焦点事件走 `audio.onFocusChange` 订阅回调。 */
class AudioModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "audio"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "setEngine" -> {
      val engine = AudioEngine.fromJs(args.str(0))
        ?: throw PortException(PortErrorCode.EUNSUPPORTED, "unknown audio engine: ${args.strOrNull(0)}")
      registry.audio.setEngine(engine)
      null
    }
    "getEngine" -> registry.audio.getEngine().jsName
    "getCapabilities" -> Serialize.capabilities(registry.audio.getCapabilities())
    "requestFocus" -> registry.audio.requestFocus()
    "abandonFocus" -> {
      registry.audio.abandonFocus()
      null
    }
    "onFocusChange" -> {
      val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
      registry.audio.onFocusChange { event: AudioFocusEvent -> ctx.emit(cb, event.jsName) }
      null
    }
    "nativePlay" -> {
      val opts = args.map(1)
      registry.audio.nativePlay(
        args.str(0),
        (opts["volume"] as? Number)?.toFloat() ?: 1f,
        (opts["rate"] as? Number)?.toFloat() ?: 1f,
        (opts["preservesPitch"] as? Boolean) ?: true,
      )
      null
    }
    "nativePause" -> {
      registry.audio.nativePause()
      null
    }
    "nativeSeek" -> {
      registry.audio.nativeSeek(args.long(0, 0))
      null
    }
    "nativeSetVolume" -> {
      registry.audio.nativeSetVolume(args.double(0, 1.0).toFloat())
      null
    }
    "nativeStop" -> {
      registry.audio.nativeStop()
      null
    }
    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "audio.$method is not implemented")
  }
}
