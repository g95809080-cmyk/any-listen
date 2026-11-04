/**
 * `@/app/renderer/winMain/autoUpdate` 的 Android 替身。
 *
 * PDR-003（个人自用、不分发）+ §2.6 已裁决：**不做自动更新**。
 * `common.tryAutoUpdate` / `common.allowPreRelease` / `common.showChangeLog` 在「关于」页置灰。
 *
 * 保留同名导出，让 `initWinMain()` 与 `rendererEvent/app.ts` 零改动。
 */

import { appState } from '@/app/app'

const DISABLED_MESSAGE = 'auto update is disabled on Android'

export const initUpdate = (): void => {
  appState.version.status = 'idle'
}

export const checkUpdate = async (): Promise<void> => {
  throw new Error(DISABLED_MESSAGE)
}

export const downloadUpdate = async (): Promise<void> => {
  throw new Error(DISABLED_MESSAGE)
}

export const restartUpdate = async (): Promise<void> => {
  throw new Error(DISABLED_MESSAGE)
}

export const updateIgnoreVersion = (version: string): void => {
  appState.version.ignoreVersion = version
}

export const startCheckUpdateTimeout = (): void => {
  /* no-op：Android 不做更新检查 */
}
