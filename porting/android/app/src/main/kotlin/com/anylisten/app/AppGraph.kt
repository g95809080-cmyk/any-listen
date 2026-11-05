package com.anylisten.app

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.anylisten.bridge.LocalHttpServer
import com.anylisten.ports.PortRegistry
import com.anylisten.ports.notify.NotificationPort
import com.anylisten.ports.power.ForegroundServiceController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.security.SecureRandom

/**
 * 进程级装配器。为什么用 object 而不是依赖注入框架：
 * 本项目只有 1 个 Activity + 1 个 Service，DI 框架带来的间接层不划算；
 * 但所有可变引用都用 `@Volatile` 保护，避免 Service 在另一个线程读到未初始化状态。
 */
object AppGraph {

  private const val TAG = "AnyListen/Graph"

  @Volatile private var application: Application? = null
  @Volatile private var notificationPortRef: NotificationPort? = null
  @Volatile var playbackService: PlaybackService? = null
  /** 当前前台 Activity：弹 Dialog / 起 SAF 选择器用；弱引用防止泄漏 */
  @Volatile var currentActivity: java.lang.ref.WeakReference<android.app.Activity>? = null
  private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var backgroundRuntime: WebPlaybackRuntime? = null
  private var retiringRuntime: WebPlaybackRuntime? = null
  private var retirementTimeout: Runnable? = null
  private var nextRetirementId = 0L

  val foregroundServiceController = object : ForegroundServiceController {
    override fun start(action: String) = PlaybackService.start(app, action)
    override fun stop() {
      app.stopService(android.content.Intent(app, PlaybackService::class.java))
    }
  }

  val app: Application get() = application ?: error("AppGraph not initialized")

  /**
   * 桥与控制面的共享 token。每次进程启动重新生成：
   * - 注入到 SPA 首帧（`window.__ANYLISTEN_TOKEN__`）与 cookie；
   * - `AndroidBridge` / `LocalHttpServer` 双向校验。
   * 目的：即使设备上别的 App 猜到 17930 端口，没有 token 也读不到音乐库。
   */
  val token: String by lazy {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    bytes.joinToString("") { "%02x".format(it) }
  }

  val userAgent: String by lazy {
    "AnyListen-Android/${BuildConfig.VERSION_NAME} (Android ${android.os.Build.VERSION.RELEASE}; ${android.os.Build.MODEL})"
  }

  val registry: PortRegistry by lazy {
    PortRegistry(
      context = app,
      debugEnabled = BuildConfig.DEBUG,
      streamBaseUrl = { httpServer.baseUrl },
      userAgent = userAgent,
    )
  }

  val httpServer: LocalHttpServer by lazy {
    LocalHttpServer(
      context = app,
      http = registry.http,
      streamRegistry = registry.streamRegistry,
      tokenProvider = { token },
    )
  }

  val notification: NotificationPort?
    get() = notificationPortRef

  fun init(application: Application) {
    this.application = application
  }

  fun bindNotification(port: NotificationPort?) {
    notificationPortRef = port
    registry.notification = port
  }

  fun takeBackgroundRuntime(): WebPlaybackRuntime? {
    backgroundRuntime?.let {
      backgroundRuntime = null
      return it
    }
    val runtime = retiringRuntime ?: return null
    retiringRuntime = null
    retirementTimeout?.let(mainHandler::removeCallbacks)
    retirementTimeout = null
    registry.lifecycle.setTerminationAckListener(null)
    return runtime
  }

  fun keepBackgroundRuntime(runtime: WebPlaybackRuntime) {
    backgroundRuntime = runtime
    runtime.enterBackground()
  }

  fun releaseBackgroundRuntime() {
    val runtime = backgroundRuntime ?: return
    backgroundRuntime = null
    registry.mediaSession.setPlaybackState("none")
    mainScope.launch {
      runCatching { registry.power.setWakeLock(false) }
        .onFailure { Log.w(TAG, "release playback wake lock failed: ${it.message}") }
    }
    retireRuntime(runtime)
  }

  /** 保留页面，直到 core 和数据库 worker 完成落盘，或达到退出等待上限。 */
  fun retireRuntime(runtime: WebPlaybackRuntime) {
    retiringRuntime?.let { if (it !== runtime) finishRetirement(it) }
    retiringRuntime = runtime
    runtime.enterBackground()
    val id = (++nextRetirementId).toString()
    val remaining = mutableSetOf("core", "db")
    val timeout = Runnable {
      if (retiringRuntime === runtime) {
        Log.w(TAG, "termination flush timed out; missing=$remaining")
        finishRetirement(runtime)
      }
    }
    retirementTimeout = timeout
    registry.lifecycle.setTerminationAckListener { ackId, source ->
      mainHandler.post {
        if (retiringRuntime !== runtime || ackId != id) return@post
        remaining.remove(source)
        if (remaining.isEmpty()) {
          Log.i(TAG, "termination flush completed")
          finishRetirement(runtime)
        }
      }
    }
    mainHandler.postDelayed(timeout, 10_000)
    registry.lifecycle.dispatchBeforeTerminate(id)
  }

  private fun finishRetirement(runtime: WebPlaybackRuntime) {
    if (retiringRuntime !== runtime) return
    retiringRuntime = null
    retirementTimeout?.let(mainHandler::removeCallbacks)
    retirementTimeout = null
    registry.lifecycle.setTerminationAckListener(null)
    runtime.destroy()
    registry.lifecycle.clear()
    registry.mediaSession.clearControlListeners()
  }

  fun onBackgroundRendererGone(runtime: WebPlaybackRuntime) {
    if (retiringRuntime === runtime) {
      finishRetirement(runtime)
      return
    }
    if (backgroundRuntime !== runtime) return
    backgroundRuntime = null
    runtime.destroy()
    registry.lifecycle.clear()
    registry.mediaSession.clearControlListeners()
    stopWebPlayback()
  }

  /** WebView 是实际播放引擎；销毁后不能继续显示播放中或持有唤醒锁。 */
  fun stopWebPlayback() {
    releaseBackgroundRuntime()
    registry.mediaSession.setPlaybackState("none")
    mainScope.launch {
      runCatching { registry.power.setWakeLock(false) }
        .onFailure { Log.w(TAG, "release playback wake lock failed: ${it.message}") }
    }
    app.stopService(android.content.Intent(app, PlaybackService::class.java))
  }

  /** 幂等启动本地服务；失败只记录，UI 会显示错误页而不是崩溃 */
  fun ensureHttpServerStarted(): Boolean {
    if (!httpServer.start()) {
      Log.e(TAG, "LocalHttpServer failed to start: ${httpServer.lastError}")
      return false
    }
    Log.i(TAG, "LocalHttpServer ready at ${httpServer.baseUrl}")
    return true
  }
}
