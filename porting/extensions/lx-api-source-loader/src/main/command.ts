import { command, console, app, t, request, configuration } from './shared/hostAPI'
import { addScript, getScript } from './shared/lxSourceManage'
import { importFiles, type ImportResult } from './batchImport'

const addLocalSource = async () => {
  let summary: ImportResult = { added: 0, duplicates: [], failures: [] }
  for (;;) {
    const selected = await app.showOpenDialog({
      title: t('command.addLocalSourceDialogTitle'),
      canSelectFiles: true,
      canSelectMany: true,
      filters: {
        JavaScript: ['js'],
      },
    })
    if (!selected.length) return
    summary = await importFiles(selected, (path) => app.readOpenDialogFile(path, 'utf-8'), addScript, summary)
    const lines = [t('command.importSummary', {
      added: summary.added, duplicates: summary.duplicates.length, failures: summary.failures.length,
    })]
    for (const item of summary.duplicates) lines.push(item.message)
    for (const item of summary.failures) {
      lines.push(`${item.name}: ${item.message}`)
    }
    const choice = await app.showMessage(lines.join('\n'), {
      modal: true,
      textSelect: true,
      type: summary.failures.length ? 'warning' : 'info',
      buttons: [{ text: t('command.importContinue') }, { text: t('command.importDone') }],
    })
    if (choice !== 0) return
  }
}

const addRemoteSource = async () => {
  await app
    .showInputDialog({
      title: t('command.addRemoteSourceDialogTitle'),
      placeholder: t('command.addRemoteSourceDialogPlaceholder'),
    })
    .then(async (result) => {
      if (!result || !/^https?:\/\//.test(result)) {
        void app.showMessage(t('error.invalidRemoteSource'), { type: 'error' })
        return
      }
      try {
        // console.log('Entered URL to add as remote source: ' + JSON.stringify(result))
        const data = await request<string>(result)
        if (typeof data.body !== 'string') {
          // console.error('Failed to fetch remote source, response is not a string: ', data)
          void app.showMessage(t('error.invalidRemoteSource'), { type: 'error' })
        }
        const urlParts = result.split('/')
        let fileName = urlParts[urlParts.length - 1] || 'remote_source.js'
        if (!fileName.endsWith('.js')) {
          fileName += '.js'
        }
        await addScript(fileName, data.body)
      } catch (error) {
        console.error(t('error.addRemoteSourceFailed', { message: (error as Error).message }))
        void app.showMessage(t('error.addRemoteSourceFailed', { message: (error as Error).message }), {
          type: 'error',
        })
      }
    })
}

const fileNameRxp = /[\\/:*?#"<>|]/g
const filterFileName = (name: string): string => name.replace(fileNameRxp, '')
const exportSources = async () => {
  const [storedInfos] = await configuration.getConfigs<[LXScriptInfoFull[] | null]>(['importedScriptSources'])
  const infos = storedInfos ?? []
  if (!infos.length) {
    void app.showMessage(t('command.exportSourcesNoSources'), { type: 'info' })
    return
  }
  const savePath = await app.showSaveDialog({
    title: t('command.exportSourcesDialogTitle'),
    saveLabel: t('command.exportSourcesDialogSaveLabel'),
    canSelectFolder: true,
  })
  if (!savePath) return
  for (const info of infos) {
    const script = await getScript(info.id)
    let name = filterFileName(info.name || '').trim()
    name = name ? `${name}.js` : info.fileName
    await app.writeSaveDialogFile(savePath, name, script).catch((error) => {
      console.error(t('error.exportSourcesFailed', { name: info.name || info.fileName, message: (error as Error).message }))
      void app.showMessage(
        t('error.exportSourcesFailed', { name: info.name || info.fileName, message: (error as Error).message }),
        {
          type: 'error',
        }
      )
    })
  }
}

export const initCommand = async () => {
  await Promise.all([
    command.registerCommand('addLocalSource', addLocalSource),
    command.registerCommand('addRemoteSource', addRemoteSource),
    command.registerCommand('exportSources', exportSources),
  ])
}
