package com.anylisten.ports.notify

/**
 * 通知端口。**故意没有 `postMedia` / `updateMedia`** —— MediaStyle 通知本体
 * （标题/封面/播放暂停上一首下一首）由 :app 的 PlaybackService 从 MediaSession 状态
 * 直接渲染（`mediaSession.setMetadata/setPlaybackState/setPosition/setActions` 一变更就刷新），
 * 再给 JS 一个"投递整条通知"的入口就会有两套真相。
 *
 * 这里只补 PlaybackService 做不到的事：通知栏歌词、Toast、原生对话框。
 * JS 侧签名对应 `porting/js/ports/types.ts` 的 `NotificationPort`（同步签名 + 发出即忘）。
 */
interface NotificationPort {
  /**
   * 通知栏歌词。JS 侧是**单参数对象**：`updateLyric({ lyricLine, lyricNext, lyricEnabled })`，
   * 经 `createProxyPort` 后 args[0] 就是这个对象 —— 所以 Kotlin 侧不能按三个位置参数取。
   */
  fun updateLyric(line: String?, next: String?, enabled: Boolean)
  suspend fun showToast(message: String)
  /**
   * 原生确认框（替换 `dialog.showMessageBox`）。
   * @return 被点按钮的 index；对话框不可用（无 Activity）时返回 0（不阻塞调用方）。
   */
  suspend fun showMessageBox(key: String, message: String, type: String, modal: Boolean): Int
  suspend fun clear()
}
