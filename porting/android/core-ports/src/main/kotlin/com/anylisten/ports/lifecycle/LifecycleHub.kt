package com.anylisten.ports.lifecycle

import java.util.concurrent.CopyOnWriteArrayList

/**
 * 生命周期端口（§4.9）。JS 侧用它做三件事：
 * 1. `onBackground` → 强制 DB flush（sql.js 无 WAL，崩溃窗口靠这里收敛）
 * 2. `onTrimMemory` → 释放封面/卷积 IR 缓存
 * 3. `isInForeground` → 悬浮窗显隐（spec §5.4）
 *
 * 只保存状态与侦听器，不含任何 Android 依赖，便于单测。
 */
class LifecycleHub {
  @Volatile private var foreground = true

  private val backgroundListeners = CopyOnWriteArrayList<() -> Unit>()
  private val foregroundListeners = CopyOnWriteArrayList<() -> Unit>()
  private val trimListeners = CopyOnWriteArrayList<(Int) -> Unit>()
  private val terminateListeners = CopyOnWriteArrayList<() -> Unit>()

  fun isInForeground(): Boolean = foreground

  fun onBackground(listener: () -> Unit) = backgroundListeners.add(listener)
  fun onForeground(listener: () -> Unit) = foregroundListeners.add(listener)
  fun onTrimMemory(listener: (Int) -> Unit) = trimListeners.add(listener)
  fun onBeforeTerminate(listener: () -> Unit) = terminateListeners.add(listener)

  /**
   * 作废全部订阅（D-31：渲染进程被回收后重建 WebView 时调用）。
   *
   * 四个列表都是"注册即追加"，而 JS 每次页面重载都会再注册一遍 ——
   * 不清就会按重建次数线性叠加：`onBeforeTerminate` 里的 DB flush 会被调 N 次，
   * `onTrimMemory` 会向已经不存在的回调名发 N 份帧（桥接层只能 warn 丢弃）。
   */
  fun clear() {
    backgroundListeners.clear()
    foregroundListeners.clear()
    trimListeners.clear()
    terminateListeners.clear()
  }

  /** 由 :app 的 Activity 生命周期回调驱动 */
  fun dispatchForeground() {
    foreground = true
    foregroundListeners.forEach { runCatching { it() } }
  }

  fun dispatchBackground() {
    foreground = false
    backgroundListeners.forEach { runCatching { it() } }
  }

  fun dispatchTrimMemory(level: Int) {
    trimListeners.forEach { runCatching { it(level) } }
  }

  fun dispatchBeforeTerminate() {
    terminateListeners.forEach { runCatching { it() } }
  }
}
