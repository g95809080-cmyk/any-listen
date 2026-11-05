package com.anylisten.bridge.modules

import com.anylisten.bridge.Args
import com.anylisten.bridge.BridgeContext
import com.anylisten.bridge.BridgeModule
import com.anylisten.bridge.Serialize
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.PortRegistry
import com.anylisten.ports.media.MediaAction
import com.anylisten.ports.media.MediaMetadataSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * `mediaSession.*` —— §4.6 / §9.1 冻结签名。
 *
 * JS 侧 `navigator.mediaSession` 替身把 setMetadata / setPlaybackState / setPosition /
 * setActionHandler 四类调用原样转发到这里；Kotlin 持有系统 MediaSession（Media3），
 * 从而让通知栏、锁屏、耳机键、蓝牙都工作 —— WebView 自己的 `navigator.mediaSession`
 * 不会注册到 `MediaSessionManager`（§9.1）。
 */
class MediaSessionModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "mediaSession"

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "setMetadata" -> {
      val map = args.map(0)
      registry.mediaSession.setMetadata(
        if (map.isEmpty()) null
        else MediaMetadataSnapshot(
          title = map["title"]?.toString() ?: "",
          artist = map["artist"]?.toString() ?: "",
          album = map["album"]?.toString() ?: "",
          artworkUrl = map["artworkUrl"] as? String,
        ),
      )
      null
    }
    "setPlaybackState" -> {
      val state = args.str(0)
      withContext(Dispatchers.Main) {
        registry.mediaSession.setPlaybackState(state)
        if (state == "playing") {
          registry.power.startForegroundService("com.anylisten.app.action.START")
          registry.power.setWakeLock(true)
        } else {
          registry.power.setWakeLock(false)
        }
      }
      null
    }
    "setPosition" -> {
      val map = args.map(0)
      registry.mediaSession.setPosition(
        durationMs = (map["durationMs"] as? Number)?.toLong() ?: 0,
        positionMs = (map["positionMs"] as? Number)?.toLong() ?: 0,
        playbackRate = (map["playbackRate"] as? Number)?.toFloat() ?: 1f,
      )
      null
    }
    "setActions" -> {
      val actions = args.stringList(0).mapNotNull { MediaAction.fromJs(it) }.toSet()
      registry.mediaSession.setActions(actions.ifEmpty { setOf(MediaAction.PLAY, MediaAction.PAUSE) })
      null
    }
    "updateLyricLine" -> {
      registry.mediaSession.updateLyricLine(args.strOrNull(0))
      null
    }
    "snapshot" -> Serialize.snapshot(registry.mediaSession.snapshot())

    // 订阅系统控制（耳机键 / 通知栏按钮 / 锁屏）。
    // 回调签名：(action: string, value?: number)，seekto 的 value 是**毫秒**。
    // JS 侧 `ports/index.ts` 用 keepCallbacks 注册，回调名常驻，PlaybackService
    // 每次 `dispatchControl` 都会推到它。
    "onControl" -> {
      val cb = ctx.callbackArg(0) ?: ctx.callbackAt(0)
      registry.mediaSession.onControl { action, value -> ctx.emit(cb, action.jsName, value) }
      null
    }

    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "mediaSession.$method is not implemented")
  }
}

/**
 * `notification.*` —— 通知栏歌词 / Toast / 原生对话框。
 *
 * 说明：MediaStyle 通知本体由 :app 的 PlaybackService 维护（含播放/暂停/上一首/下一首），
 * 本模块只补它做不到的事：通知栏歌词（折叠态当前行 + 展开态下一行）。
 */
class NotificationModule(private val registry: PortRegistry) : BridgeModule {
  override val name: String = "notification"

  private fun port() = registry.notification
    ?: throw PortException(
      PortErrorCode.EUNSUPPORTED,
      "notification port is not bound yet (PlaybackService not started)",
    )

  override suspend fun handle(method: String, args: Args, ctx: BridgeContext): Any? = when (method) {
    "updateLyric" -> {
      val map = args.map(0)
      port().updateLyric(
        line = map["lyricLine"] as? String,
        next = map["lyricNext"] as? String,
        enabled = (map["lyricEnabled"] as? Boolean) ?: true,
      )
      null
    }
    "showToast" -> {
      port().showToast(args.str(0))
      null
    }
    "showMessageBox" -> port().showMessageBox(
      key = args.str(0),
      message = args.str(1),
      type = args.map(2)["type"]?.toString() ?: "info",
      modal = (args.map(2)["modal"] as? Boolean) ?: true,
    )
    "clear" -> {
      port().clear()
      null
    }
    else -> throw PortException(PortErrorCode.EUNSUPPORTED, "notification.$method is not implemented")
  }
}
