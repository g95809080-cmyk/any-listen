package com.anylisten.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import com.anylisten.ports.PortRegistry
import com.anylisten.ports.media.MediaAction
import com.anylisten.ports.media.MediaMetadataSnapshot
import com.anylisten.ports.media.MediaSessionSink
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 前台播放服务（§4.6 / R-09）：系统媒体会话 + MediaStyle 常驻通知。
 *
 * **音频本身仍在 WebView 里**（PDR-005：复用 `plugins/player` 的 Web Audio 音效链）。
 * 本服务的职责是把「JS 里的播放状态」投影成系统可见的媒体会话，并反向把
 * 通知栏按钮 / 锁屏 / 耳机键 / 蓝牙的控制回传给 JS（`navigator.mediaSession` 替身）。
 * 这也是 A-01（后台音频存活）不成立时的兜底挂点：PDR-008 的原生 ExoPlayer 会接在这里。
 *
 * 媒体栈选型说明（与任务书的差异，已在 README 记录）：
 * 用 `MediaSessionCompat` + `MediaStyle`，而不是 Media3 `MediaSessionService`。
 * 原因：Media3 的 `MediaSession` 必须绑定一个 `Player`，而 Web 引擎没有 Player 实例；
 * 用 `SimpleBasePlayer` 伪装时**播放列表只有单项 → 通知栏的上一首/下一首按钮不会出现**
 * （Media3 用 `COMMAND_SEEK_TO_PREVIOUS/NEXT` 决定按钮，依赖多 item playlist）。
 * MediaSessionCompat 能精确控制 4 个按钮，且同为 AndroidX 媒体基础设施。
 */
class PlaybackService : android.app.Service() {

  private lateinit var registry: PortRegistry
  private lateinit var mediaSession: MediaSessionCompat
  private var foregroundStarted = false

  /** `refreshNotification()` 的批次合并标记（见该方法的注释）；sink 回调可能来自 IO 线程，故 @Volatile */
  @Volatile private var refreshScheduled = false
  private val mainHandler = Handler(Looper.getMainLooper())

  /** 通知栏歌词（`player.isShowMediaSessionLyric`）与展开态第二行 */
  @Volatile private var lyricLine: String? = null
  @Volatile private var lyricNext: String? = null
  @Volatile private var lyricEnabled: Boolean = true
  @Volatile private var metadataDurationMs: Long = -1
  @Volatile private var currentMetadata: MediaMetadataSnapshot? = null
  @Volatile private var currentArtwork: Bitmap? = null
  @Volatile private var currentArtworkUrl: String? = null

  private val artworkScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var artworkJob: Job? = null

  private val sessionSink = object : MediaSessionSink {
    override fun onMetadataChanged(metadata: MediaMetadataSnapshot?) {
      applyMetadata(metadata)
      refreshNotification()
    }

    override fun onPlaybackStateChanged(state: String) {
      applyPlaybackState(state)
      refreshNotification()
    }

    override fun onPositionChanged(durationMs: Long, positionMs: Long, playbackRate: Float) {
      applyPosition(durationMs, positionMs, playbackRate)
    }

    /**
     * JS 侧 `BridgeMediaSession`（fullstack 的 `host/mediasession-shim.ts`）把
     * setMetadata / setPlaybackState / setActions 攒到微任务末尾，**固定按这个顺序**发一批，
     * 也就是 actions 总是最后到 —— 因此 [applyPlaybackState] 写进 `PlaybackStateCompat`
     * 的是这一批**之前**的 actions 位图。锁屏 / 蓝牙 / 车载读的是 `PlaybackState.actions`
     * 而不是通知栏（通知栏读的是本类 [buildNotification] 里的 `snapshot.actions`），
     * 所以这里必须补写一次，否则切歌后外部控制器上的上一首/下一首会停在旧状态。
     */
    override fun onActionsChanged(actions: Set<MediaAction>) {
      applyPlaybackState(if (registry.mediaSession.snapshot().isPlaying) "playing" else "paused")
      refreshNotification()
    }

    override fun onLyricLineChanged(line: String?) {
      lyricLine = line
      refreshNotification()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    registry = AppGraph.registry
    createChannel()
    mediaSession = MediaSessionCompat(this, SESSION_TAG).apply {
      setFlags(
        MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
          MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
      )
      setSessionActivity(contentIntent())
      setCallback(createSessionCallback())
      isActive = true
    }
    registry.mediaSession.attachSink(sessionSink)
    AppGraph.playbackService = this
    AppGraph.bindNotification(AppNotificationPort(this, registry))
    Log.i(TAG, "PlaybackService created")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    if (action != null && action.startsWith(ACTION_PREFIX)) {
      when (action) {
        ACTION_PLAY -> control(MediaAction.PLAY)
        ACTION_PAUSE -> control(MediaAction.PAUSE)
        ACTION_TOGGLE -> control(MediaAction.PLAY)
        ACTION_NEXT -> control(MediaAction.NEXT_TRACK)
        ACTION_PREV -> control(MediaAction.PREVIOUS_TRACK)
        ACTION_STOP -> {
          control(MediaAction.STOP)
          stopSelfSafely()
          return START_NOT_STICKY
        }
      }
    }
    // 满足 startForegroundService 的 5s 规则：先以"暂停"通知进入前台，再等 JS 推状态
    ensureForeground()
    // 音频与控制回调都属于 WebView 进程；进程被杀后单独重启服务无法恢复播放，
    // 反而会留下没有控制目标的媒体通知。等用户重新打开应用时再正常创建服务。
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    Log.i(TAG, "PlaybackService destroyed")
    foregroundStarted = false
    artworkScope.cancel()
    runCatching {
      stopForeground(STOP_FOREGROUND_REMOVE)
      getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }.onFailure { Log.w(TAG, "notification cleanup failed: ${it.message}") }
    runCatching { registry.mediaSession.attachSink(null) }
    runCatching { mediaSession.isActive = false; mediaSession.release() }
    if (AppGraph.playbackService === this) AppGraph.playbackService = null
    AppGraph.bindNotification(null)
    AppGraph.releaseBackgroundRuntime()
    super.onDestroy()
  }

  // ---------------------------------------------------------------- media session

  private fun createSessionCallback() = object : MediaSessionCompat.Callback() {
    override fun onPlay() = control(MediaAction.PLAY)
    override fun onPause() = control(MediaAction.PAUSE)
    override fun onStop() = control(MediaAction.STOP)
    override fun onSkipToNext() = control(MediaAction.NEXT_TRACK)
    override fun onSkipToPrevious() = control(MediaAction.PREVIOUS_TRACK)
    override fun onSeekTo(pos: Long) = control(MediaAction.SEEK_TO, pos.toDouble())
    override fun onRewind() = control(MediaAction.SEEK_BACKWARD)
    override fun onFastForward() = control(MediaAction.SEEK_FORWARD)
  }

  /**
   * 系统控制 → JS（§4.6 `MediaSessionPort.onControl`）。
   * JS 侧 `navigator.mediaSession` 替身在启动时已注册回调名，`dispatchControl`
   * 会把它转成 `[2, cbName, [action, value]]` 推回 WebView。
   */
  private fun control(action: MediaAction, value: Double? = null) {
    // 实际音频由 WebView 播放，Chromium 自己管理焦点；再申请一次会抢掉它的焦点。
    registry.mediaSession.dispatchControl(action, value)
    Log.d(TAG, "control -> ${action.jsName} ${value ?: ""}")
  }

  private fun applyMetadata(metadata: MediaMetadataSnapshot?) {
    currentMetadata = metadata
    val artworkUrl = metadata?.artworkUrl?.takeIf { it.isNotBlank() }
    if (artworkUrl != currentArtworkUrl) {
      currentArtworkUrl = artworkUrl
      currentArtwork = null
      loadArtwork(artworkUrl)
    }

    val durationMs = registry.mediaSession.snapshot().durationMs
    val builder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, metadata?.title ?: "")
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, metadata?.artist ?: "")
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, metadata?.album ?: "")
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
    if (artworkUrl != null) {
      builder.putString(MediaMetadataCompat.METADATA_KEY_ART_URI, artworkUrl)
      builder.putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, artworkUrl)
    }
    currentArtwork?.let {
      builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
      builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
    }
    mediaSession.setMetadata(builder.build())
    metadataDurationMs = durationMs
  }

  private fun loadArtwork(url: String?) {
    artworkJob?.cancel()
    if (url == null) return

    artworkJob = artworkScope.launch {
      val bitmap = fetchArtwork(url) ?: return@launch
      withContext(Dispatchers.Main) {
        if (currentArtworkUrl != url) return@withContext
        currentArtwork = bitmap
        applyMetadata(currentMetadata)
        refreshNotification()
      }
    }
  }

  private fun fetchArtwork(url: String): Bitmap? = runCatching {
    val localBase = URL("${AppGraph.httpServer.baseUrl}/")
    val resolved = if (url.startsWith("http://") || url.startsWith("https://")) {
      URL(url)
    } else {
      URL(localBase, url)
    }
    val connection = resolved.openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects = true
      connection.connectTimeout = 5_000
      connection.readTimeout = 8_000
      connection.setRequestProperty("User-Agent", "AnyListen-Android")
      if (resolved.host == localBase.host && resolved.port == localBase.port) {
        connection.setRequestProperty("x-anylisten-token", AppGraph.token)
      }
      connection.connect()
      if (connection.responseCode !in 200..299) return@runCatching null

      val maxBytes = 8 * 1024 * 1024
      val declaredLength = connection.contentLengthLong
      if (declaredLength > maxBytes) return@runCatching null

      val output = ByteArrayOutputStream(if (declaredLength > 0) declaredLength.toInt() else 64 * 1024)
      connection.inputStream.use { input ->
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          total += read
          if (total > maxBytes) return@runCatching null
          output.write(buffer, 0, read)
        }
      }

      val bytes = output.toByteArray()
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null

      var sampleSize = 1
      while (bounds.outWidth / sampleSize > 1024 || bounds.outHeight / sampleSize > 1024) sampleSize *= 2
      BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply {
          inSampleSize = sampleSize
          inPreferredConfig = Bitmap.Config.ARGB_8888
        },
      )
    } finally {
      connection.disconnect()
    }
  }.onFailure {
    Log.w(TAG, "load artwork failed: ${it.message}")
  }.getOrNull()

  private fun applyPlaybackState(state: String) {
    val snapshot = registry.mediaSession.snapshot()
    val stateCode = when (state) {
      "playing" -> PlaybackStateCompat.STATE_PLAYING
      "paused" -> PlaybackStateCompat.STATE_PAUSED
      else -> PlaybackStateCompat.STATE_NONE
    }
    mediaSession.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(supportedActions(snapshot.actions))
        .setState(stateCode, snapshot.positionMs, snapshot.playbackRate)
        .build(),
    )
    if (state == "playing") ensureForeground()
  }

  private fun applyPosition(durationMs: Long, positionMs: Long, playbackRate: Float) {
    if (durationMs != metadataDurationMs) {
      applyMetadata((registry.mediaSession as? com.anylisten.ports.media.MediaSessionPortImpl)?.metadataSnapshot())
    }
    val snapshot = registry.mediaSession.snapshot()
    val stateCode = if (snapshot.isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
    mediaSession.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(supportedActions(snapshot.actions))
        .setState(stateCode, positionMs, playbackRate)
        .build(),
    )
    // 通知栏进度条（MediaStyle 用 PlaybackState 的 position 渲染）
    refreshNotification()
  }

  /** `setActions` 传进来的数组决定通知栏显示哪些按钮（§9.1，不要写死） */
  private fun supportedActions(actions: Set<MediaAction>): Long {
    var result = PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP
    if (MediaAction.PLAY in actions) result = result or PlaybackStateCompat.ACTION_PLAY
    if (MediaAction.PAUSE in actions) result = result or PlaybackStateCompat.ACTION_PAUSE
    if (MediaAction.NEXT_TRACK in actions) result = result or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
    if (MediaAction.PREVIOUS_TRACK in actions) result = result or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
    if (MediaAction.SEEK_TO in actions) {
      result = result or PlaybackStateCompat.ACTION_SEEK_TO
    }
    return result
  }

  // ---------------------------------------------------------------- notification

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.notification_channel_playback),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.notification_channel_playback_desc)
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
    this,
    0,
    Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    },
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent = PendingIntent.getService(
    this,
    requestCode,
    Intent(this, PlaybackService::class.java).setAction("$ACTION_PREFIX$action"),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  private fun buildNotification(): Notification {
    val snapshot = registry.mediaSession.snapshot()
    val metadata = (registry.mediaSession as? com.anylisten.ports.media.MediaSessionPortImpl)?.metadataSnapshot()
    val trackTitle = metadata?.title?.ifBlank { null } ?: getString(R.string.app_name)
    val artist = metadata?.artist.orEmpty()

    // 通知栏歌词：折叠态用 title 显示当前行（§5.5 与浮层消费同一 lineChanged 流）
    val showLyric = lyricEnabled && !lyricLine.isNullOrBlank()
    val title = if (showLyric) lyricLine!! else trackTitle
    val text = if (showLyric) trackTitle else artist
    val subText = if (showLyric && !lyricNext.isNullOrBlank()) lyricNext else null

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent())
      .setOngoing(snapshot.isPlaying)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setSilent(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setDeleteIntent(servicePendingIntent("STOP", 4))

    currentArtwork?.let(builder::setLargeIcon)
    if (subText != null) builder.setSubText(subText)

    val actions = snapshot.actions
    val compactIndices = mutableListOf<Int>()
    if (MediaAction.PREVIOUS_TRACK in actions) {
      compactIndices.add(0)
      builder.addAction(
        android.R.drawable.ic_media_previous,
        getString(R.string.action_prev),
        servicePendingIntent("PREV", 1),
      )
    }
    val playIndex = compactIndices.size
    compactIndices.add(playIndex)
    if (snapshot.isPlaying) {
      builder.addAction(
        android.R.drawable.ic_media_pause,
        getString(R.string.action_pause),
        servicePendingIntent("PAUSE", 2),
      )
    } else {
      builder.addAction(
        android.R.drawable.ic_media_play,
        getString(R.string.action_play),
        servicePendingIntent("PLAY", 2),
      )
    }
    if (MediaAction.NEXT_TRACK in actions) {
      compactIndices.add(compactIndices.size)
      builder.addAction(
        android.R.drawable.ic_media_next,
        getString(R.string.action_next),
        servicePendingIntent("NEXT", 3),
      )
    }

    builder.setStyle(
      MediaStyle()
        .setMediaSession(mediaSession.sessionToken)
        .setShowActionsInCompactView(*compactIndices.toIntArray()),
    )
    if (snapshot.durationMs > 0) {
      builder.setProgress(snapshot.durationMs.toInt(), snapshot.positionMs.toInt(), false)
    }
    return builder.build()
  }

  /**
   * 合并同一批状态变更里的多次 notify。
   *
   * 一次切歌 JS 侧会连发 metadata / playbackState / actions 三条帧，三个 sink 回调各自调
   * 一次本方法 —— 直接 `notify()` 三次会让 MediaStyle 通知在几百微秒内重建三次
   * （部分 ROM 会看到按钮/进度条闪一下，且白白多两次 binder 往返）。
   * 这里改成「本帧内只排一次、主线程执行」，重复调用直接吞掉。
   */
  private fun refreshNotification() {
    if (!foregroundStarted) return
    if (refreshScheduled) return
    refreshScheduled = true
    mainHandler.post {
      refreshScheduled = false
      if (!foregroundStarted) return@post
      runCatching {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification())
      }.onFailure { Log.w(TAG, "notify failed: ${it.message}") }
    }
  }

  private fun ensureForeground() {
    if (foregroundStarted) return
    val notification = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      foregroundStarted = true
    } catch (e: Exception) {
      // Android 12+ 若从后台启动前台服务会抛 ForegroundServiceStartNotAllowedException；
      // 此时降级为普通 Service（通知照发，只是不享受前台优先级）
      Log.e(TAG, "startForeground failed: ${e.message}", e)
    }
  }

  private fun stopSelfSafely() {
    runCatching {
      if (foregroundStarted) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
      }
      getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
    stopSelf()
  }

  /** 供 [AppNotificationPort] 调用（通知栏歌词） */
  fun updateLyric(line: String?, next: String?, enabled: Boolean) {
    lyricLine = line
    lyricNext = next
    lyricEnabled = enabled
    refreshNotification()
  }

  companion object {
    private const val TAG = "AnyListen/Playback"
    private const val CHANNEL_ID = "anylisten.playback"
    private const val NOTIFICATION_ID = 1001
    private const val SESSION_TAG = "AnyListenSession"

    const val ACTION_PREFIX = "com.anylisten.app.action."

    /** 由 `PowerPort.startForegroundService` / JS 侧传入 */
    const val ACTION_START = "${ACTION_PREFIX}START"
    const val ACTION_PLAY = "${ACTION_PREFIX}PLAY"
    const val ACTION_PAUSE = "${ACTION_PREFIX}PAUSE"
    const val ACTION_TOGGLE = "${ACTION_PREFIX}TOGGLE"
    const val ACTION_NEXT = "${ACTION_PREFIX}NEXT"
    const val ACTION_PREV = "${ACTION_PREFIX}PREV"
    const val ACTION_STOP = "${ACTION_PREFIX}STOP"

    fun start(context: Context, action: String = ACTION_START) {
      // 服务已存在时，状态回调会更新前台通知；重复调用系统启动接口在后台会被拒绝。
      if (action == ACTION_START && AppGraph.playbackService != null) return
      val intent = Intent(context, PlaybackService::class.java).setAction(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }
  }
}
