import upstream from '@ui-raw/shared/ipc/app/remote'
import { extI18n } from '@ui/modules/extension/i18n'
import { extensionState } from '@ui/modules/extension/store/state'
import { showFileSaveModal, showFileSelectModal } from '@ui/shared/ipc/fs/fileSelectModal'
import { openExtensionFileDialog, saveExtensionFileDialog } from '../../../../ipc/extensionFileDialogs'

function getExtensionName(extId: string): string {
  const ext = extensionState.extensionList.find((item) => item.id === extId)
  return ext ? extI18n.t(extId, ext.name) : ''
}

// 继承其他扩展事件与弹窗；只替换 Android 原先缺失的文件对话框。
export default {
  ...upstream,
  async showOpenBox(_key, extId, options) {
    return openExtensionFileDialog(getExtensionName(extId), options, showFileSelectModal)
  },
  async showSaveBox(_key, extId, options) {
    return saveExtensionFileDialog(getExtensionName(extId), options, showFileSaveModal)
  },
} satisfies Partial<AnyListen.IPC.ClientIPC>
