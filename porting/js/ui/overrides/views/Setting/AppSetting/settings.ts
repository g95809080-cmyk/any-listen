/**
 * Android 设置页只保留手机上有实际行为的项目。
 *
 * 上游设置表同时服务桌面、网页和移动端。这里以原表为基础做视图过滤，
 * 不复制整份设置定义，也不修改底层配置 key —— 已有配置仍可被读取、
 * 备份和跨端同步，只是桌面窗口、快捷键、自动更新等入口不再出现在手机上。
 */
import { settings as upstreamSettings, type SettingListSection } from '@ui-raw/views/Setting/AppSetting/settings'

export type {
  EnumItem,
  SettingListCommonItem,
  SettingListItem,
  SettingListSection,
} from '@ui-raw/views/Setting/AppSetting/settings'

const removedSections = new Set(['hotkey', 'update'])

const removedItems = new Map<string, Set<string>>([
  [
    'basic',
    new Set([
      'common.windowSizeId',
      'common.playBarProgressStyle',
      'settings.basic.font',
    ]),
  ],
  [
    'player',
    new Set([
      'player.isShowTaskProgess',
      'player.isShowTitleLyric',
      'settings.player.media_device',
    ]),
  ],
  ['other', new Set(['common.transparentWindow'])],
])

function itemKey(item: SettingListSection['list'][number]): string | null {
  if (item == null) return null
  if ('field' in item) return item.field
  return typeof item.name === 'string' ? item.name : null
}

export const settings: SettingListSection[] = upstreamSettings
  .filter((section) => !removedSections.has(section.id))
  .map((section) => {
    const removed = removedItems.get(section.id)
    if (!removed) return section
    return {
      ...section,
      list: section.list.filter((item) => {
        const key = itemKey(item)
        return key == null || !removed.has(key)
      }),
    }
  })
