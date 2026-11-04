package com.anylisten.ports.power

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 电源/保活端口（§4.9）。后台播放的三个必要条件之一：
 * 前台服务（见 :app PlaybackService）+ PARTIAL_WAKE_LOCK + 电池优化白名单引导。
 */
interface PowerPort {
  suspend fun setWakeLock(on: Boolean)
  suspend fun getBatteryOptimizationStatus(): String // 'ignored' | 'not_ignored'
  suspend fun requestIgnoreBatteryOptimization()
  fun startForegroundService(action: String)
  fun stopForegroundService()
}

/**
 * 前台服务的启停由 :app 的 PlaybackService 承担；:core-ports 不能反向依赖 :app，
 * 因此用这个最小接口注入（避免 `Class.forName` 这种运行时才炸的反射）。
 */
interface ForegroundServiceController {
  fun start(action: String)
  fun stop()
}

class PowerPortImpl(
  private val context: Context,
  private val foregroundService: ForegroundServiceController? = null,
) : PowerPort {

  private var wakeLock: PowerManager.WakeLock? = null

  @SuppressLint("WakelockTimeout")
  override suspend fun setWakeLock(on: Boolean) = withContext(Dispatchers.Main) {
    if (on) {
      if (wakeLock?.isHeld == true) return@withContext
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      // PARTIAL_WAKE_LOCK 只保 CPU，不亮屏；播放期间 JS 定时器/AudioWorklet 需要它
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AnyListen:playback").apply {
        setReferenceCounted(false)
        acquire(WAKE_LOCK_TIMEOUT_MS)
      }
    } else {
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
    }
  }

  override suspend fun getBatteryOptimizationStatus(): String = withContext(Dispatchers.IO) {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isIgnoringBatteryOptimizations(context.packageName)) "ignored" else "not_ignored"
  }

  @SuppressLint("BatteryLife")
  override suspend fun requestIgnoreBatteryOptimization() = withContext(Dispatchers.Main) {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isIgnoringBatteryOptimizations(context.packageName)) return@withContext
    try {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    } catch (e: Exception) {
      // 部分 ROM 不认 ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS → 退到电池优化列表页
      try {
        context.startActivity(
          Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (e2: Exception) {
        throw PortException(
          PortErrorCode.EUNSUPPORTED,
          "cannot open battery optimization settings on this device",
          Build.MANUFACTURER,
        )
      }
    }
  }

  override fun startForegroundService(action: String) {
    val controller = foregroundService
      ?: throw PortException(PortErrorCode.EUNSUPPORTED, "foreground service controller is not wired")
    controller.start(action)
  }

  override fun stopForegroundService() {
    foregroundService?.stop()
  }

  private companion object {
    /** 12 小时兜底释放：防止异常退出后一直持有唤醒锁吃电 */
    const val WAKE_LOCK_TIMEOUT_MS = 12L * 3600 * 1000
  }
}
