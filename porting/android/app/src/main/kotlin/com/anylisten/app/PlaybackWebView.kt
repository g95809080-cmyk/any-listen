package com.anylisten.app

import android.content.Context
import android.os.Build
import android.view.View
import android.webkit.WebView

/**
 * 播放 WebView 在 Activity 不可见时仍需继续执行媒体事件、扩展取源与页面计时器。
 *
 * Chromium 默认把窗口隐藏的 WebView 视为不可见，并允许系统把渲染进程降为可回收、
 * 可冻结的优先级。部分 OEM（真机 Xiaomi/HyperOS 已复现）会因此在锁屏或切后台后
 * 暂停 JavaScript 任务：音频仍由媒体解码器继续播放，但 `ended`、媒体键回调、下一首
 * 取源都会等到 Activity 回到前台才恢复。
 *
 * 这里保留真实 View 的绘制/布局行为，只覆盖 WebView 内部收到的窗口可见性；同时把
 * 渲染进程绑定为 IMPORTANT，并在后台显式恢复页面计时器。WebView 已有
 * `onRenderProcessGone` 兜底，满足 Renderer Importance API 要求的终止处理前提。
 */
class PlaybackWebView(context: Context) : WebView(context) {

  init {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)
    }
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    // 窗口被隐藏时只对 WebView 内部报告 visible；真实可见时保持原行为。
    super.onWindowVisibilityChanged(View.VISIBLE)
  }

  /** 幂等操作；Activity 回到前台与播放服务进入后台时都可以安全调用。 */
  fun keepPageActive() {
    resumeTimers()
    onResume()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)
    }
  }
}
