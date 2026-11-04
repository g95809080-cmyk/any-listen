/**
 * `@/app/app` 的 Android 版：应用状态初始化 + 设置读写 + 事件联动。
 *
 * 与 web-server 版本的差异（都是平台性差异，不放宽业务逻辑）：
 * 1. 数据目录来自 `FileSystemPort.getEnv().dataPath`（`/data/data/<pkg>/files/any-listen`），
 *    而不是 `global.anylisten.dataPath` 拼装 —— 但布局保持同构（§5.2），便于桌面数据双向搬运。
 * 2. 没有 WebSocket 会话：`socketEvent.new_socket_inited` / `clientConnected` 不参与启动流程。
 * 3. 没有自动更新（PDR-003 个人自用不分发）：`update.*` 系列全部删除。
 * 4. 系统主题由 `ThemePort.onSystemThemeChanged` 驱动（对齐 desktop 的 nativeTheme）。
 */

import { initCommon } from '@any-listen/app/common'
import { initDeviceId } from '@any-listen/app/common/deviceId'
import { DEFAULT_LANG } from '@any-listen/common/constants'
import { parseEnvParams } from '@any-listen/nodejs/env'

import { ports } from '@porting/ports'

import { appEvent } from '@/app/app/event'
import { appState } from '@/app/app/state'
import { initAppSetting, saveSetting } from '@/app/app/data'
import { i18n } from '@/app/i18n'
import { logger } from '@/shared/log4js'
import { checkAndCreateDir, removePath } from '@/shared/utils'
import { setProxyByHost } from '@any-listen/nodejs/request'

const initState = (): void => {
  const envParams = parseEnvParams<Record<string, string | number | boolean>>()
  appState.envParams = { cmdParams: envParams.cmdParams }
  appState.version.version = globalThis.__anylisten_app_version__ ?? 'android'
  appState.version.commit = 'android'
  appState.version.commitDate = 0
}

const setUserDataPath = async (): Promise<void> => {
  const env = await ports.fs.getEnv()
  appState.dataPath = `${env.dataPath}/app`
  appState.cacheDataPath = `${env.dataPath}/cache`
  appState.tempDataPath = `${env.dataPath}/temp`
  await ports.fs.mkdirp(appState.dataPath)
  await ports.fs.mkdirp(appState.cacheDataPath)
  // 与 web-server 一致：启动时清空 temp
  await removePath(appState.tempDataPath).catch(() => undefined)
  await ports.fs.mkdirp(appState.tempDataPath)
  globalThis.__anylisten_os_version__ = env.osVersion
  globalThis.__anylisten_external_root__ = env.externalRoot ?? undefined
}

const handleProxyChange = (): void => {
  if (appState.appSetting['network.proxy.enable'] && appState.appSetting['network.proxy.host']) {
    setProxyByHost(appState.appSetting['network.proxy.host'], appState.appSetting['network.proxy.port'] || '80')
    return
  }
  setProxyByHost(undefined)
}

const listenerAppEvent = (): void => {
  appEvent.on('updated_config', (keys, setting) => {
    if (keys.includes('common.langId')) {
      appEvent.locale_change(setting['common.langId'] ?? DEFAULT_LANG)
    }
    if (
      keys.includes('network.proxy.enable') ||
      (appState.appSetting['network.proxy.enable'] && keys.some((k) => k.includes('network.proxy.')))
    ) {
      handleProxyChange()
    }
  })
  appEvent.on('inited', () => {
    handleProxyChange()
  })
}

export const initAppEnv = async (): Promise<void> => {
  initState()
  await setUserDataPath()
  ;[appState.machineId, appState.appSetting] = await Promise.all([
    initDeviceId(appState.dataPath),
    initAppSetting().then((res) => res.setting),
  ])
  listenerAppEvent()
  initCommon({
    getSettings: () => appState.appSetting,
    showMessageBox: async (key, options) => {
      const msg = options.title ?? options.detail ?? key
      return ports.notification.showMessageBox(key, msg, {
        modal: options.modal === true,
        type: 'info',
      })
    },
    translate: (key, val) => i18n.t(key, val),
    logger,
  })
  checkAndCreateDir(appState.dataPath)
}

export const updateSetting = (setting: Partial<AnyListen.AppSetting>): void => {
  const { setting: newSetting, updatedSettingKeys, updatedSetting } = saveSetting(setting)
  appState.appSetting = newSetting
  if (!updatedSettingKeys.length) return
  appEvent.updated_config(updatedSettingKeys, updatedSetting)
}

export const sendInitedEvent = (): void => {
  appEvent.inited()
}

export const setSystemMode = (shouldUseDarkColors: boolean): void => {
  if (appState.shouldUseDarkColors == shouldUseDarkColors) return
  appState.shouldUseDarkColors = shouldUseDarkColors
  appEvent.system_theme_change(shouldUseDarkColors)
}

export * as appActions from '@/app/app/actions'

export { appEvent } from '@/app/app/event'
export { appState } from '@/app/app/state'

declare global {
  // eslint-disable-next-line no-var
  var __anylisten_app_version__: string | undefined
  // eslint-disable-next-line no-var
  var __anylisten_external_root__: string | undefined
}
