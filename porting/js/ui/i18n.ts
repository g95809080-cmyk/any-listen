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
