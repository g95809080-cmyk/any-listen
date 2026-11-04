package com.anylisten.app

import android.app.Application
import android.content.Context
import android.util.Log
import com.anylisten.bridge.LocalHttpServer
import com.anylisten.ports.PortRegistry
import com.anylisten.ports.notify.NotificationPort
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
