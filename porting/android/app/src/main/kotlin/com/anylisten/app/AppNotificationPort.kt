package com.anylisten.app

import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import com.anylisten.ports.PortRegistry
import com.anylisten.ports.notify.NotificationPort
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * `NotificationPort` 的 :app 实现。
 *
 * 分工：
 * - 媒体通知本体（MediaStyle + 4 个控制按钮）= [PlaybackService]
 * - 通知栏歌词 = 转发给 [PlaybackService.updateLyric]
 * - Toast / 原生确认框 = 这里（必须有 Activity；Service 上下文不能弹 Dialog）
 */
class AppNotificationPort(
  private val service: PlaybackService,
  private val registry: PortRegistry,
) : NotificationPort {

  private val mainHandler = Handler(Looper.getMainLooper())

  override fun updateLyric(line: String?, next: String?, enabled: Boolean) {
    service.updateLyric(line, next, enabled)
  }

  override suspend fun showToast(message: String) {
    mainHandler.post {
      Toast.makeText(service.applicationContext, message, Toast.LENGTH_SHORT).show()
    }
  }

  override suspend fun showMessageBox(
    key: String,
    message: String,
    type: String,
    modal: Boolean,
  ): Int = suspendCancellableCoroutine { cont ->
    val activity = AppGraph.currentActivity?.get()
    if (activity == null || activity.isFinishing) {
      cont.resume(0) // 无 Activity 时按"默认按钮"返回，绝不阻塞播放链路
      return@suspendCancellableCoroutine
    }
    mainHandler.post {
      if (!cont.isActive) return@post
      val dialog = AlertDialog.Builder(activity)
        .setMessage(message)
        .setPositiveButton(android.R.string.ok) { _, _ -> cont.resume(0) }
        .setCancelable(!modal)
        .create()
      dialog.setOnCancelListener { if (cont.isActive) cont.resume(0) }
      runCatching { dialog.show() }.onFailure {
        Log.w(TAG, "showMessageBox($key,$type) failed: ${it.message}")
        if (cont.isActive) cont.resume(0)
      }
    }
  }

  override suspend fun clear() {
    service.updateLyric(null, null, false)
  }


  companion object {
    private const val TAG = "AnyListen/Notify"
  }
}
