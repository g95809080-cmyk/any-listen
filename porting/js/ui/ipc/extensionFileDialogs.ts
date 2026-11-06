/** 将扩展对话框参数交给现有文件浏览器；路径授权仍由扩展服务负责。 */
export async function openExtensionFileDialog(
  extName: string,
  options: AnyListen.IPCCommon.OpenDialogOptions,
  open: AnyListen.IPC.ServerIPC['showOpenDialog'],
): Promise<string[]> {
  const properties: NonNullable<AnyListen.OpenDialogOptions['properties']> = []
  if (options.canSelectFiles !== false) properties.push('openFile')
  if (options.canSelectFolders) properties.push('openDirectory')
  if (options.canSelectMany) properties.push('multiSelections')
  const result = await open({
    modalTitle: extName,
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters && Object.entries(options.filters).map(([name, extensions]) => ({ name, extensions })),
    properties,
    buttonLabel: options.openLabel,
  })
  return result.canceled ? [] : result.filePaths
}

export async function saveExtensionFileDialog(
  extName: string,
  options: AnyListen.IPCCommon.SaveDialogOptions,
  save: AnyListen.IPC.ServerIPC['showSaveDialog'],
): Promise<string> {
  const result = await save({
    modalTitle: extName,
    title: options.title,
    buttonLabel: options.saveLabel,
    defaultFileName: options.defaultFileName,
    selectFolder: options.canSelectFolder,
    filters: options.filters && Object.entries(options.filters).map(([name, extensions]) => ({ name, extensions })),
  })
  return result.canceled || !result.filePath ? '' : result.filePath
}
