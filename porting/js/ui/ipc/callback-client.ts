import { createProxyCallback } from 'message2call'

/** The Android client talks to the worker directly, so it must perform the callback wrapping normally done by the web preload. */
export function withIpcCallbacks(remote: AnyListen.IPC.ServerIPC): AnyListen.IPC.ServerIPC {
  const wrapped: Partial<AnyListen.IPC.ServerIPC> = {
    async importData(path, selectData, getListMergeMode) {
      const select = createProxyCallback((types: AnyListen.BackupType[]) => selectData(types))
      const merge = createProxyCallback(() => getListMergeMode())
      try {
        return await remote.importData(path, select, merge)
      } finally {
        select.releaseProxy()
        merge.releaseProxy()
      }
    },
    async runSyncWebDAV(getListMergeMode, getDislikeMergeMode) {
      // The server starts a background sync and returns before it asks for a merge mode.
      const list = getListMergeMode ? createProxyCallback(() => {
        list?.releaseProxy()
        return getListMergeMode()
      }) : undefined
      const dislike = getDislikeMergeMode ? createProxyCallback(() => {
        dislike?.releaseProxy()
        return getDislikeMergeMode()
      }) : undefined
      try {
        return await remote.runSyncWebDAV(list, dislike)
      } catch (error) {
        list?.releaseProxy()
        dislike?.releaseProxy()
        throw error
      }
    },
    async addFolderMusics(listId, filePaths, onEnd) {
      const callback = createProxyCallback((errorMessage?: string | null) => {
        callback.releaseProxy()
        onEnd(errorMessage)
      })
      try {
        // The task id arrives before the scan completes, so keep the callback until onEnd.
        return await remote.addFolderMusics(listId, filePaths, callback)
      } catch (error) {
        callback.releaseProxy()
        throw error
      }
    },
  }
  return new Proxy(remote, {
    get(target, property, receiver) {
      return Object.hasOwn(wrapped, property) ? Reflect.get(wrapped, property) : Reflect.get(target, property, receiver)
    },
  })
}
