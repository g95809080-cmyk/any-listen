package com.anylisten.ports

import android.content.Context
import com.anylisten.ports.audio.AudioEngineRouter
import com.anylisten.ports.audio.AudioFocusManager
import com.anylisten.ports.audio.WebOnlyAudioEngineRouter
import com.anylisten.ports.fs.DirectoryPicker
import com.anylisten.ports.fs.FileSystemPortImpl
import com.anylisten.ports.fs.StreamRegistry
import com.anylisten.ports.http.HttpPort
import com.anylisten.ports.http.HttpPortImpl
import com.anylisten.ports.lifecycle.LifecycleHub
import com.anylisten.ports.log.LogPort
import com.anylisten.ports.log.LogPortImpl
import com.anylisten.ports.media.MediaSessionPort
import com.anylisten.ports.media.MediaSessionPortImpl
import com.anylisten.ports.notify.NotificationPort
import com.anylisten.ports.power.ForegroundServiceController
import com.anylisten.ports.power.PowerPort
import com.anylisten.ports.power.PowerPortImpl
import com.anylisten.ports.settings.SettingsStore
import com.anylisten.ports.tar.TarPort
import com.anylisten.ports.tar.TarPortImpl
import com.anylisten.ports.ui.ClipboardPort
import com.anylisten.ports.ui.ClipboardPortImpl
import com.anylisten.ports.ui.DocumentPicker
import com.anylisten.ports.ui.IntentPort
import com.anylisten.ports.ui.IntentPortImpl
import com.anylisten.ports.ui.PickedDocument
import com.anylisten.ports.ui.SaveSource
import com.anylisten.ports.ui.ThemePort
import com.anylisten.ports.ui.ThemePortImpl
import java.io.File

/**
 * Port 装配器（:core-ports 的唯一入口）。
 *
 * 依赖方向：`:app` → `:bridge` → `:core-ports`。所有需要 Activity/Service 才能实现的 Port
 * （通知、SAF 选择器、前台服务）由 :app 通过 [bindUiPorts] 与 [notification]
 * 回填 —— 这样 :core-ports 不反向依赖 :app，也不会出现循环依赖或 `Class.forName` 反射。
 *
 * 未绑定时相关 Port 仍可调用，但会以 `EUNSUPPORTED` 明确失败（而不是 NPE）。
 */
class PortRegistry(
  context: Context,
  /** :app 传入 `BuildConfig.DEBUG`：release 关闭 DEBUG 日志（用户 P0 红线） */
  debugEnabled: Boolean,
  /** `/stream` 的 base url，由 LocalHttpServer 持有（端口固定 17930） */
  streamBaseUrl: () -> String,
  /** HTTP 请求 UA：带版本号便于排查问题 */
  userAgent: String,
) {
  val appContext: Context = context.applicationContext

  val lifecycle = LifecycleHub()
  val audioFocus = AudioFocusManager(appContext)
  val mediaSession: MediaSessionPort = MediaSessionPortImpl()
  val audio: AudioEngineRouter = WebOnlyAudioEngineRouter(audioFocus)
  val streamRegistry = StreamRegistry(baseUrlProvider = streamBaseUrl, maxEntries = 8192)

  /** 由 :app 回填：只在 Activity 存在时可用的宿主能力 */
  @Volatile private var directoryPicker: DirectoryPicker? = null
  @Volatile private var documentPicker: DocumentPicker? = null
  @Volatile private var foregroundServiceController: ForegroundServiceController? = null

  /** 把"可能尚未绑定"的选择器包成 Port：未绑定时以 EUNSUPPORTED 明确失败，而不是伪装成"用户取消" */
  private val directoryPickerAdapter = object : DirectoryPicker {
    override suspend fun pickDirectory(title: String?): com.anylisten.ports.fs.DirPickResult? {
      val picker = directoryPicker
        ?: throw PortException(PortErrorCode.EUNSUPPORTED, "directory picker is not available (no Activity bound)")
      return picker.pickDirectory(title)
    }
  }

  private val documentPickerAdapter = object : DocumentPicker {
    private fun current(): DocumentPicker = documentPicker
      ?: throw PortException(PortErrorCode.EUNSUPPORTED, "document picker is not available (no Activity bound)")

    override suspend fun openDocument(mime: List<String>): PickedDocument? = current().openDocument(mime)
    override suspend fun saveDocument(suggestName: String, mime: String, source: SaveSource?): PickedDocument? =
      current().saveDocument(suggestName, mime, source)
  }

  private val foregroundServiceAdapter = object : ForegroundServiceController {
    override fun start(action: String) {
      val controller = foregroundServiceController
        ?: throw PortException(PortErrorCode.EUNSUPPORTED, "foreground service controller is not wired")
      controller.start(action)
    }

    override fun stop() {
      foregroundServiceController?.stop()
    }
  }

  /**
   * 应用数据目录布局（`<dataPath>/{app,cache,temp}`）—— 与桌面版同构，
   * 定义见 [com.anylisten.ports.fs.StorageLayout]。
   */
  val storage: com.anylisten.ports.fs.StorageLayout by lazy {
    com.anylisten.ports.fs.StorageLayout(appContext).ensureDirs()
  }

  val fs: FileSystemPortImpl by lazy {
    FileSystemPortImpl(appContext, streamRegistry, directoryPickerAdapter)
  }

  val settings: SettingsStore by lazy {
    SettingsStore(fs = fs, filePath = File(storage.appDir, "config.json").absolutePath)
  }

  val log: LogPort by lazy { LogPortImpl(appContext, debugEnabled) }

  val http: HttpPort = HttpPortImpl(
    tempDir = File(appContext.cacheDir, "http").apply { mkdirs() },
    userAgent = userAgent,
  )

  val power: PowerPort by lazy { PowerPortImpl(appContext, foregroundServiceAdapter) }
  val theme: ThemePort = ThemePortImpl(appContext)
  val clipboard: ClipboardPort = ClipboardPortImpl(appContext)
  val intent: IntentPort by lazy { IntentPortImpl(appContext, documentPickerAdapter) }
  val tar: TarPort = TarPortImpl()

  /** 由 :app 在 MediaSession / PlaybackService 就绪后回填 */
  @Volatile var notification: NotificationPort? = null

  fun bindUiPorts(
    directoryPicker: DirectoryPicker?,
    documentPicker: DocumentPicker?,
    foregroundServiceController: ForegroundServiceController?,
  ) {
    this.directoryPicker = directoryPicker
    this.documentPicker = documentPicker
    this.foregroundServiceController = foregroundServiceController
  }

  fun dispose() {
    fs.dispose()
    settings.dispose()
  }
}
