/**
 * 设置备份的导出与恢复筛选。
 *
 * 备份文件可能来自旧版本或被手工修改，所以恢复时不能直接把 JSON 里的对象丢给
 * `updateSetting()`：
 * - 只认当前版本存在的 key，避免把已经删除的字段重新写进配置；
 * - 只接受 string / number / boolean / null，避免嵌套对象进入上游的合并逻辑；
 * - `version` 由主程序维护，不从备份覆盖；
 * - 网络代理与扩展镜像地址属于运行时连接配置，沿用 `setSetting` IPC 的忽略规则，
 *   避免一次恢复把当前设备的可用网络配置改坏。
 */

export const SETTINGS_BACKUP_VERSION = 1

const RESTORE_IGNORED_KEYS = new Set<keyof AnyListen.AppSetting>([
  'version',
  'network.proxy.enable',
  'network.proxy.host',
  'network.proxy.port',
  'extension.ghMirrorHosts',
])

const isRestorableValue = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

export const createSettingsBackupData = (setting: AnyListen.AppSetting): AnyListen.SettingsBackupData => ({
  version: SETTINGS_BACKUP_VERSION,
  data: { ...setting },
})

export const pickRestorableSettings = (
  imported: Partial<AnyListen.AppSetting> | null | undefined,
  current: AnyListen.AppSetting
): Partial<AnyListen.AppSetting> => {
  if (!imported) return {}

  const result: Partial<AnyListen.AppSetting> = {}
  for (const key of Object.keys(current) as Array<keyof AnyListen.AppSetting>) {
    if (RESTORE_IGNORED_KEYS.has(key)) continue
    const value: unknown = imported[key]
    if (!isRestorableValue(value)) continue
    // 上游 mergeSetting 只处理顶层基础类型；这里提前过滤，避免把类型错误留到保存阶段。
    ;(result as Record<string, unknown>)[key] = value
  }
  return result
}
