package com.anylisten.ports.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 音频焦点事件：与 `AudioPort.onFocusChange` 的 4 个语义一一对应 */
enum class AudioFocusEvent(val jsName: String) {
  GAIN("gain"),
  LOSS("loss"),
  LOSS_TRANSIENT("loss_transient"),
  DUCK("duck");

  companion object {
    fun fromJs(name: String): AudioFocusEvent? = entries.firstOrNull { it.jsName == name.lowercase() }
  }
}

/**
 * 音频焦点管理（§4.7）。Android 上这是"来电/其他 App 播放时必须暂停"的合规要求，
 * 不做会被系统或其他播放器打断得很脏。
 *
 * 用 `AudioFocusRequest`（API 26+，minSdk 29 可直用），`AUDIOFOCUS_GAIN` +
 * `USAGE_MEDIA`/`CONTENT_TYPE_MUSIC`，并声明 `delayedFocus` 不支持（即时请求）。
 */
class AudioFocusManager(private val context: Context) {

  private val listeners = java.util.concurrent.CopyOnWriteArrayList<(AudioFocusEvent) -> Unit>()
  private var focusRequest: AudioFocusRequest? = null
  @Volatile private var hasFocus = false

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  fun onFocusChange(listener: (AudioFocusEvent) -> Unit) {
    listeners.add(listener)
  }

  suspend fun requestFocus(): Boolean = withContext(Dispatchers.Main) {
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build()
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(attributes)
      .setWillPauseWhenDucked(false)
      .setOnAudioFocusChangeListener { change ->
        val event = when (change) {
          AudioManager.AUDIOFOCUS_GAIN -> AudioFocusEvent.GAIN
          AudioManager.AUDIOFOCUS_LOSS -> AudioFocusEvent.LOSS
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> AudioFocusEvent.LOSS_TRANSIENT
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> AudioFocusEvent.DUCK
          else -> null
        }
        if (change == AudioManager.AUDIOFOCUS_LOSS) hasFocus = false
        if (change == AudioManager.AUDIOFOCUS_GAIN) hasFocus = true
        event?.let { e -> listeners.forEach { runCatching { it(e) } } }
      }
      .build()
    focusRequest = request
    val result = audioManager.requestAudioFocus(request)
    hasFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    Log.i(TAG, "requestAudioFocus -> $result")
    hasFocus
  }

  suspend fun abandonFocus() = withContext(Dispatchers.Main) {
    val request = focusRequest
    if (request == null) {
      hasFocus = false
      return@withContext
    }
    audioManager.abandonAudioFocusRequest(request)
    focusRequest = null
    hasFocus = false
  }

  fun isFocused(): Boolean = hasFocus

  private companion object {
    const val TAG = "AnyListen/AudioFocus"
  }
}

enum class AudioEngine(val jsName: String) {
  WEB("web"),
  NATIVE("native");

  companion object {
    fun fromJs(name: String): AudioEngine? = entries.firstOrNull { it.jsName == name.lowercase() }
  }
}

/**
 * 音频能力位（§4.7）。**这是 UI 与音频引擎之间的契约**：不支持的能力必须让 UI 置灰/隐藏，
 * 而不是"看起来能用其实没生效"（spec §7-3）。
 *
 * Phase 4 的取值策略：`engine=web`，能力位标 `unverified` —— 真值需 Phase 5 在小米 13
 * 的 WebView 上实测后回填（A-01/A-02）。**故意不猜 true**，避免 UI 提前放行不可用功能。
 */
data class AudioCapabilities(
  val engine: String = "web",
  val audioWorklet: Boolean = false,
  val convolver: Boolean = false,
  val panner3d: Boolean = false,
  val equalizer: Boolean = false,
  val setSinkId: Boolean = false,
  val backgroundAudio: String = "unverified",
  val maxConvolverIrBytes: Long = 3L * 1024 * 1024,
  val supportedSampleRates: List<Int> = listOf(44100, 48000),
  val pitchShifter: Boolean = false,
  val playbackRateRange: List<Float> = listOf(0.5f, 2.0f),
  val supportsPreservesPitch: Boolean = true,
  val convolverIrLoadable: Boolean = false,
)

/**
 * 音频引擎路由（PDR-008：Phase 4 **只冻结接口**，不实现原生 ExoPlayer）。
 *
 * 调用方是 UI 主线程的 `AudioEngineRouter`（JS 侧新增文件，不改 `plugins/player/index.ts`）。
 * 任何 `native*` 方法在 Phase 4 都抛 EUNSUPPORTED —— 这样 JS 侧一旦误用会立刻暴露，
 * 而不是静默无声地"播了但没声音"。
 */
interface AudioEngineRouter {
  suspend fun setEngine(engine: AudioEngine)
  suspend fun getEngine(): AudioEngine
  suspend fun getCapabilities(): AudioCapabilities
  suspend fun requestFocus(): Boolean
  suspend fun abandonFocus()
  fun onFocusChange(listener: (AudioFocusEvent) -> Unit)

  suspend fun nativePlay(url: String, volume: Float, rate: Float, preservesPitch: Boolean)
  suspend fun nativePause()
  suspend fun nativeSeek(positionMs: Long)
  suspend fun nativeSetVolume(volume: Float)
  suspend fun nativeStop()
}

class WebOnlyAudioEngineRouter(
  private val focusManager: AudioFocusManager,
  private val capabilities: AudioCapabilities = AudioCapabilities(),
) : AudioEngineRouter {

  @Volatile private var engine: AudioEngine = AudioEngine.WEB

  override suspend fun setEngine(engine: AudioEngine) {
    if (engine == AudioEngine.NATIVE) {
      throw PortException(
        PortErrorCode.EUNSUPPORTED,
        "native audio engine is not implemented in Phase 4 (PDR-008: deferred to Phase 5 spike)",
      )
    }
    this.engine = engine
  }

  override suspend fun getEngine(): AudioEngine = engine

  override suspend fun getCapabilities(): AudioCapabilities = capabilities.copy(engine = engine.jsName)

  override suspend fun requestFocus(): Boolean = focusManager.requestFocus()

  override suspend fun abandonFocus() = focusManager.abandonFocus()

  override fun onFocusChange(listener: (AudioFocusEvent) -> Unit) = focusManager.onFocusChange(listener)

  override suspend fun nativePlay(url: String, volume: Float, rate: Float, preservesPitch: Boolean) =
    throw nativeUnsupported()

  override suspend fun nativePause() = throw nativeUnsupported()

  override suspend fun nativeSeek(positionMs: Long) = throw nativeUnsupported()

  override suspend fun nativeSetVolume(volume: Float) = throw nativeUnsupported()

  override suspend fun nativeStop() = throw nativeUnsupported()

  private fun nativeUnsupported() = PortException(
    PortErrorCode.EUNSUPPORTED,
    "native audio engine is not implemented (PDR-008); A-01 spike pending",
  )
}
