/**
 * 移动端专属文案字典（N-10）。
 *
 * ## 为什么不直接改上游 i18n
 * `source/packages/shared/i18n/langs/*.json` 属于 `source/`，**不可修改**（零改上游的硬约束）。
 * 而移动端确实需要新文案，且有三个实测过的坑：
 * - `search` / `search_history` / `search_placeholder` 这几个 key **上游不存在**
 *   （`t('search')` 只出现在被注释掉的代码里），用了会直接渲染出 key 本身；
 * - `list_name__default` 的值是「试听列表」而不是「曲库」，拿来做 Tab 会显示错词。
 *
 * 所以移动端新增文案走本文件，key 统一加 `mobile__` 前缀避免与上游冲突；
 * 上游已有且语义正确的 key 继续用 `t()`（本文件再导出一个薄封装，避免各处 import 来源不一致）。
 */

import { i18n } from '@ui/plugins/i18n'
import type { Langs } from '@any-listen/i18n'

/** 移动端专属文案。缺语言时回退 `zh-cn`，与上游 i18n 的 fallback 策略一致 */
const dict = {
  mobile__tab_library: { 'zh-cn': '曲库', 'zh-tw': '曲庫', 'en-us': 'Library' },
  mobile__tab_online: { 'zh-cn': '在线', 'zh-tw': '線上', 'en-us': 'Online' },
  mobile__tab_search: { 'zh-cn': '搜索', 'zh-tw': '搜尋', 'en-us': 'Search' },
  mobile__back: { 'zh-cn': '返回', 'zh-tw': '返回', 'en-us': 'Back' },
  mobile__settings_group_playback: {
    'zh-cn': '播放',
    'zh-tw': '播放',
    'en-us': 'Playback',
  },
  mobile__settings_group_data: {
    'zh-cn': '在线与数据',
    'zh-tw': '線上與資料',
    'en-us': 'Online & data',
  },
  mobile__settings_group_extension: {
    'zh-cn': '扩展',
    'zh-tw': '擴充',
    'en-us': 'Extensions',
  },
  mobile__settings_group_other: {
    'zh-cn': '其他',
    'zh-tw': '其他',
    'en-us': 'More',
  },
  mobile__settings_extension: {
    'zh-cn': '扩展设置',
    'zh-tw': '擴充設定',
    'en-us': 'Extension settings',
  },
  mobile__open_player: { 'zh-cn': '打开播放页', 'zh-tw': '開啟播放頁', 'en-us': 'Open player' },
  mobile__search_placeholder: {
    'zh-cn': '搜索歌曲、歌手、歌单',
    'zh-tw': '搜尋歌曲、歌手、歌單',
    'en-us': 'Songs, artists, playlists',
  },
  mobile__search_history: { 'zh-cn': '搜索历史', 'zh-tw': '搜尋歷史', 'en-us': 'Recent searches' },
  mobile__multi_select: { 'zh-cn': '多选', 'zh-tw': '多選', 'en-us': 'Select' },
  mobile__selected_count: {
    'zh-cn': '已选 {num} 项',
    'zh-tw': '已選 {num} 項',
    'en-us': '{num} selected',
  },
  mobile__scan_needed: {
    'zh-cn': '本地歌曲需要重新扫描',
    'zh-tw': '本機歌曲需要重新掃描',
    'en-us': 'Local library needs rescan',
  },
  mobile__retry: { 'zh-cn': '重试', 'zh-tw': '重試', 'en-us': 'Retry' },
  mobile__music_device_mismatch: {
    'zh-cn': '该歌曲绑定的设备与当前设备不一致，请重新选择本地目录后重试',
    'zh-tw': '該歌曲綁定的裝置與目前裝置不一致，請重新選擇本機目錄後重試',
    'en-us': 'This song is bound to another device. Please re-select the local folder and retry.',
  },
  mobile__library_empty_title: { 'zh-cn': '还没有音乐', 'zh-tw': '還沒有音樂', 'en-us': 'No music yet' },
  mobile__library_empty_sub: {
    'zh-cn': '导入手机里的歌曲，建立你的第一个曲库',
    'zh-tw': '匯入本機的歌曲，建立你的第一個曲庫',
    'en-us': 'Import songs from this device to start your library',
  },
  mobile__library_empty_sub_list: {
    'zh-cn': '这个歌单还是空的',
    'zh-tw': '這個歌單還是空的',
    'en-us': 'This playlist is empty',
  },
  mobile__library_empty_import: {
    'zh-cn': '导入本地音乐',
    'zh-tw': '匯入本機音樂',
    'en-us': 'Import local music',
  },
  mobile__library_import: { 'zh-cn': '导入', 'zh-tw': '匯入', 'en-us': 'Import' },
  mobile__library_my_lists: { 'zh-cn': '我的歌单', 'zh-tw': '我的歌單', 'en-us': 'My playlists' },
  mobile__library_list_count: {
    'zh-cn': '{num} 个歌单',
    'zh-tw': '{num} 個歌單',
    'en-us': '{num} playlists',
  },
  mobile__library_list_hint: {
    'zh-cn': '收藏或导入的歌单会出现在这里',
    'zh-tw': '收藏或匯入的歌單會出現在這裡',
    'en-us': 'Playlists you save or import will appear here',
  },
  mobile__library_loading: { 'zh-cn': '正在载入曲库…', 'zh-tw': '正在載入曲庫…', 'en-us': 'Loading library…' },
  /**
   * 设置页顶栏的入口文案（D-12）。上游把扩展管理页 `#/extenstion` 的入口只挂在
   * `Aside/Nav.svelte` 与 `Header/ControlBtnsDesktop.svelte`（移动壳都不渲染）→
   * 手机上「扩展安装 / 启用 / 重启扩展宿主」完全不可达，而 PDR-002 要求必须保留该能力。
   * 文案用「扩展管理」而不是「扩展」：入口指向的是**管理页**，不是设置里的扩展面板。
   */
  mobile__extension_manage: {
    'zh-cn': '扩展管理',
    'zh-tw': '擴充管理',
    'en-us': 'Extensions',
  },
  mobile__online_source_unavailable: {
    'zh-cn': '在线音源暂时不可用，请稍后重试',
    'zh-tw': '線上音源暫時無法使用，請稍後再試',
    'en-us': 'Online source temporarily unavailable. Try again later.',
  },
  mobile__online_source_no_script: {
    'zh-cn': '当前音源扩展缺少可执行的音源脚本，请到扩展管理导入音源后重试',
    'zh-tw': '目前音源擴充缺少可執行的音源腳本，請到擴充管理匯入音源後再試',
    'en-us': 'The source extension has no runnable source script. Import a source in Extensions and try again.',
  },
  mobile__online_source_missing: {
    'zh-cn': '没有可播放的在线音源，请到扩展管理安装并启用支持播放的音源',
    'zh-tw': '沒有可播放的線上音源，請到擴充管理安裝並啟用支援播放的音源',
    'en-us': 'No playable online source is available. Install and enable a playback source in Extensions.',
  },
  mobile__online_source_cleartext: {
    'zh-cn': '该音源需要 HTTP 连接，已被系统网络安全策略拦截',
    'zh-tw': '該音源需要 HTTP 連線，已被系統網路安全策略攔截',
    'en-us': 'This source requires HTTP and was blocked by the network security policy.',
  },
  mobile__online_source_timeout: {
    'zh-cn': '在线音源响应超时，请检查网络后重试',
    'zh-tw': '線上音源回應逾時，請檢查網路後再試',
    'en-us': 'Online source timed out. Check your network and try again.',
  },
  mobile__cached: { 'zh-cn': '已缓存', 'zh-tw': '已快取', 'en-us': 'Cached' },
  mobile__cached_offline: {
    'zh-cn': '已缓存，可离线播放',
    'zh-tw': '已快取，可離線播放',
    'en-us': 'Cached for offline playback',
  },
  mobile__cache_music: {
    'zh-cn': '缓存到本地',
    'zh-tw': '快取到本機',
    'en-us': 'Cache for offline',
  },
  mobile__cache_resolving: {
    'zh-cn': '正在解析音源',
    'zh-tw': '正在解析音源',
    'en-us': 'Resolving source',
  },
  mobile__cache_queued: {
    'zh-cn': '等待缓存',
    'zh-tw': '等待快取',
    'en-us': 'Queued',
  },
  mobile__cache_downloading: {
    'zh-cn': '缓存中 {percent}%',
    'zh-tw': '快取中 {percent}%',
    'en-us': 'Caching {percent}%',
  },
  mobile__cache_downloading_unknown: {
    'zh-cn': '缓存中',
    'zh-tw': '快取中',
    'en-us': 'Caching',
  },
  mobile__cache_failed: {
    'zh-cn': '缓存失败',
    'zh-tw': '快取失敗',
    'en-us': 'Cache failed',
  },
  mobile__cache_retry: {
    'zh-cn': '重试缓存',
    'zh-tw': '重試快取',
    'en-us': 'Retry cache',
  },
  mobile__cache_playlist: {
    'zh-cn': '缓存歌单',
    'zh-tw': '快取歌單',
    'en-us': 'Cache playlist',
  },
  mobile__cache_playlist_progress: {
    'zh-cn': '已处理 {done}/{total}',
    'zh-tw': '已處理 {done}/{total}',
    'en-us': '{done}/{total} processed',
  },
  mobile__cache_playlist_done: {
    'zh-cn': '歌单已缓存 {total} 首',
    'zh-tw': '歌單已快取 {total} 首',
    'en-us': '{total} tracks cached',
  },
  mobile__cache_playlist_failed: {
    'zh-cn': '失败 {num} 首 · 点击重试',
    'zh-tw': '失敗 {num} 首 · 點擊重試',
    'en-us': '{num} failed · Tap to retry',
  },
  mobile__extension_settings_empty_title: {
    'zh-cn': '还没有可配置的扩展',
    'zh-tw': '還沒有可設定的擴充',
    'en-us': 'No extension settings yet',
  },
  mobile__extension_settings_empty_sub: {
    'zh-cn': '安装并启用扩展后，它提供的设置项会出现在这里',
    'zh-tw': '安裝並啟用擴充後，它提供的設定項目會出現在這裡',
    'en-us': 'Install and enable an extension to see the settings it provides here.',
  },
  mobile__lyric_loading: {
    'zh-cn': '歌词加载中…',
    'zh-tw': '歌詞載入中…',
    'en-us': 'Loading lyrics…',
  },
  mobile__lyric_empty: {
    'zh-cn': '暂无歌词',
    'zh-tw': '暫無歌詞',
    'en-us': 'No lyrics',
  },
} as const

export type MobileMessageKey = keyof typeof dict

/**
 * 取移动端文案：本地字典 → `zh-cn` → 上游 i18n → key 本身。
 * `{name}` 占位符按 `values` 替换（与上游 `fillMessage` 同一套占位语法）。
 */
export function tm(key: MobileMessageKey, values?: Record<string, string | number>): string {
  const entry: Record<string, string> | undefined = dict[key]
  const locale = i18n.locale as Langs
  let text = entry?.[locale] ?? entry?.['zh-cn']
  if (text == null) {
    console.error(`[ui/i18n] 缺失移动端文案: ${key}`)
    text = key
  }
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replace(`{${name}}`, String(value))
    }
  }
  return text
}

/**
 * 上游已有且语义正确的 key 用这个薄封装。
 *
 * 已核对可用的 key：`setting`（设置）、`list_name__love`（我喜欢）、`list_name__last_play`（播放历史）、
 * `select_all`（全选）、`batch_select_exit`（退出多选）、`player__play` / `player__pause` / `player__list`、
 * `btn_clear`（清空）。
 */
export const t = i18n.t.bind(i18n)
