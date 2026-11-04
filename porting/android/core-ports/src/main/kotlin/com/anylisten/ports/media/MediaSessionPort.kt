package com.anylisten.ports.media

/**
 * 播放状态的 Kotlin 侧快照。**单一真相源仍在 JS**（`playerState`），这里只是
 * MediaSession / 通知栏的只读投影（spec §5.1），因此不做持久化、不做二次加工。
 */
data class MediaMetadataSnapshot(
  val title: String = "",
  val artist: String = "",
  val album: String = "",
  val artworkUrl: String? = null,
)

data class PlaybackSnapshot(
  val isPlaying: Boolean = false,
  val positionMs: Long = 0,
  val durationMs: Long = 0,
  val playbackRate: Float = 1f,
  /** 通知栏被点击的按钮集合由 JS 注册的 handler 决定（§9.1 setActionHandler 语义） */
  val actions: Set<MediaAction> = DEFAULT_ACTIONS,
  /** 上下文一行为通知栏歌词（`player.isShowMediaSessionLyric`） */
  val lyricLine: String? = null,
) {
  companion object {
    val DEFAULT_ACTIONS: Set<MediaAction> = setOf(
      MediaAction.PLAY,
      MediaAction.PAUSE,
      MediaAction.PREVIOUS_TRACK,
      MediaAction.NEXT_TRACK,
      MediaAction.SEEK_TO,
      MediaAction.STOP,
    )
  }
}

enum class MediaAction(val jsName: String) {
  PLAY("play"),
  PAUSE("pause"),
  STOP("stop"),
  SEEK_BACKWARD("seekbackward"),
  SEEK_FORWARD("seekforward"),
  SEEK_TO("seekto"),
  PREVIOUS_TRACK("previoustrack"),
  NEXT_TRACK("nexttrack");

  companion object {
    fun fromJs(name: String): MediaAction? = entries.firstOrNull { it.jsName == name.lowercase() }
  }
}

/**
 * 媒体会话端口（§4.6 §9.1）。Kotlin 持有**系统** MediaSession（Media3），
 * JS 侧通过 `navigator.mediaSession` 替身把 8 个 action handler / metadata /
 * positionState 转发过来 —— `view-main` 源码零改动。
 */
interface MediaSessionPort {
  fun setMetadata(metadata: MediaMetadataSnapshot?)
  fun setPlaybackState(state: String) // 'none' | 'paused' | 'playing'
  fun setPosition(durationMs: Long, positionMs: Long, playbackRate: Float)
  fun setActions(actions: Set<MediaAction>)
  fun updateLyricLine(line: String?)
  /** 系统/耳机键/通知栏 → JS 的控制回调 */
  fun onControl(listener: (MediaAction, Double?) -> Unit)
  /** 查询当前快照（通知栏与浮层读取用） */
  fun snapshot(): PlaybackSnapshot
  /** 由 :app 的 PlaybackService 在会话建立后回填（避免 :core-ports 依赖 media3） */
  fun attachSink(sink: MediaSessionSink?)

  /** 系统侧（耳机键 / 通知按钮 / 锁屏 / 蓝牙）触发的控制 → 分发给 JS 注册的回调 */
  fun dispatchControl(action: MediaAction, value: Double? = null)
}

/** Media3 侧的适配点，实现在 :app（PlaybackService 内） */
interface MediaSessionSink {
  fun onMetadataChanged(metadata: MediaMetadataSnapshot?)
  fun onPlaybackStateChanged(state: String)
  fun onPositionChanged(durationMs: Long, positionMs: Long, playbackRate: Float)
  fun onActionsChanged(actions: Set<MediaAction>)
  fun onLyricLineChanged(line: String?)
}

/**
 * 默认实现：纯状态机 + 侦听器分发，不含任何 Android UI 依赖，
 * 因此可以在没有通知权限/没有前台服务的场景下独立工作（例如 Phase 5 的桥接单测）。
 */
class MediaSessionPortImpl : MediaSessionPort {
  private var metadata: MediaMetadataSnapshot? = null
  private var playbackState: String = "none"
  private var durationMs: Long = 0
  private var positionMs: Long = 0
  private var playbackRate: Float = 1f
  private var actions: Set<MediaAction> = PlaybackSnapshot.DEFAULT_ACTIONS
  private var lyricLine: String? = null
  private val listeners = java.util.concurrent.CopyOnWriteArrayList<(MediaAction, Double?) -> Unit>()
  @Volatile private var sink: MediaSessionSink? = null

  override fun setMetadata(metadata: MediaMetadataSnapshot?) {
    this.metadata = metadata
    sink?.onMetadataChanged(metadata)
  }

  override fun setPlaybackState(state: String) {
    val normalized = when (state.lowercase()) {
      "playing" -> "playing"
      "paused" -> "paused"
      else -> "none"
    }
    playbackState = normalized
    sink?.onPlaybackStateChanged(normalized)
  }

  override fun setPosition(durationMs: Long, positionMs: Long, playbackRate: Float) {
    this.durationMs = durationMs.coerceAtLeast(0)
    this.positionMs = positionMs.coerceAtLeast(0)
    this.playbackRate = if (playbackRate > 0) playbackRate else 1f
    sink?.onPositionChanged(this.durationMs, this.positionMs, this.playbackRate)
  }

  override fun setActions(actions: Set<MediaAction>) {
    // 上限保护：SEK_TO 必须与 duration 一起才有意义；JS 未注册就不给按钮（§9.1 语义）
    this.actions = actions
    sink?.onActionsChanged(actions)
  }

  override fun updateLyricLine(line: String?) {
    if (lyricLine == line) return
    lyricLine = line
    sink?.onLyricLineChanged(line)
  }

  override fun onControl(listener: (MediaAction, Double?) -> Unit) {
    listeners.add(listener)
  }

  override fun dispatchControl(action: MediaAction, value: Double?) {
    listeners.forEach { runCatching { it(action, value) } }
  }

  override fun snapshot(): PlaybackSnapshot = PlaybackSnapshot(
    isPlaying = playbackState == "playing",
    positionMs = positionMs,
    durationMs = durationMs,
    playbackRate = playbackRate,
    actions = actions,
    lyricLine = lyricLine,
  )

  override fun attachSink(sink: MediaSessionSink?) {
    this.sink = sink
    if (sink == null) return
    sink.onMetadataChanged(metadata)
    sink.onPlaybackStateChanged(playbackState)
    sink.onPositionChanged(durationMs, positionMs, playbackRate)
    sink.onActionsChanged(actions)
    sink.onLyricLineChanged(lyricLine)
  }

  fun metadataSnapshot(): MediaMetadataSnapshot? = metadata
}
