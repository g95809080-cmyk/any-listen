import type { Message } from '@any-listen/i18n'

/**
 * 设置详情页的一级分区。
 *
 * 标题 key 统一放在这里，设置首页、顶栏和 Android 返回栈都从同一份映射取值，
 * 避免新增分区时只改了一处。实际设置项仍来自 AppSetting/settings.ts。
 */
export const SETTINGS_SECTION_TITLE_KEYS = {
  basic: 'settings__basic',
  player: 'settings__player',
  playDetail: 'settings.play_detail',
  list: 'settings.list',
  extension: 'settings.extension',
  onlineResource: 'settings.online_resource',
  network: 'settings.network',
  dataSync: 'settings.dataSync',
  backup: 'settings.backup',
  other: 'settings.other',
  about: 'settings__about',
} as const satisfies Record<string, keyof Message>

export type SettingsSectionId = keyof typeof SETTINGS_SECTION_TITLE_KEYS

const sectionIds = new Set<string>(Object.keys(SETTINGS_SECTION_TITLE_KEYS))

export type SettingsRoute =
  | { kind: 'home' }
  | { kind: 'section'; section: SettingsSectionId }
  | { kind: 'extension' }
  | { kind: 'logs' }

export function isSettingsSectionId(value: string | undefined): value is SettingsSectionId {
  return value != null && sectionIds.has(value)
}

/**
 * 新地址是 `?section=…`；旧地址 `?type=app&id=…` 继续兼容。
 * 扩展设置和日志输出历史上也有 `type` 形式，一并保留。
 */
export function resolveSettingsRoute(
  query: Record<string, string | undefined>
): SettingsRoute {
  const { section, type, id } = query

  if (section === 'extension' || type === 'extension') return { kind: 'extension' }
  if (section === 'logs' || type === 'logs') return { kind: 'logs' }
  if (isSettingsSectionId(section)) return { kind: 'section', section }
  if ((type == null || type === 'app') && isSettingsSectionId(id)) {
    return { kind: 'section', section: id }
  }

  return { kind: 'home' }
}

export function settingsSectionHref(section: SettingsSectionId): string {
  return `/settings?section=${encodeURIComponent(section)}`
}

export function settingsRouteFromHash(hash: string): SettingsRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const [path, search = ''] = raw.split('?')
  if (path !== '/settings') return { kind: 'home' }

  const query: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(search)) query[key] = value
  return resolveSettingsRoute(query)
}

export function isSettingsHomeHash(hash: string): boolean {
  return settingsRouteFromHash(hash).kind === 'home'
}

export function isSettingsChildHash(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  return (raw.split('?')[0] ?? '') === '/settings' && !isSettingsHomeHash(hash)
}
